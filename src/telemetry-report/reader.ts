import { canonicalJson, normalizePathTarget, normalizeUrlTarget } from "./normalize.js";
import type {
	CanonicalCallDraft,
	CanonicalCandidate,
	CanonicalMetric,
	CanonicalReference,
	DecodeContext,
	DecodedRecord,
	TelemetryReadResult,
} from "./model.js";

const PATH_KINDS = new Set(["file", "directory", "path", "region"]);

/** Tolerant, tool-independent decoder. Unknown fields and open string values are preserved. */
export function readTelemetryRecord(value: unknown, context: DecodeContext): TelemetryReadResult {
	if (!isRecord(value)) return { status: "invalid", raw: value, issues: ["record_not_object"] };
	const event = string(value["event"]);
	const id = string(value["id"]);
	const sessionId = string(value["session_id"]);
	if (event === undefined || id === undefined || sessionId === undefined) {
		return { status: "invalid", raw: value, issues: [
			...(event === undefined ? ["missing_event"] : []),
			...(id === undefined ? ["missing_id"] : []),
			...(sessionId === undefined ? ["missing_session_id"] : []),
		] };
	}
	const issues: string[] = [];
	let record: DecodedRecord | undefined;
	switch (event) {
		case "session_start":
			record = { event: "session_start", cwd: cwd(value, context.cwd, issues) };
			break;
		case "turn_start":
			record = decodeTurnStart(value, issues);
			break;
		case "tool_call":
			record = decodeToolCall(value, context.cwd, issues);
			break;
		case "turn_end":
			record = { event: "ignored" };
			break;
		case "session_end":
			record = { event: "session_end" };
			break;
		default:
			return { status: "unknown_event", event, raw: value };
	}
	if (record === undefined) return { status: "invalid", raw: value, issues };
	return issues.length === 0
		? { status: "known", record, raw: value, issues: [] }
		: { status: "partial", record, raw: value, issues };
}

function decodeTurnStart(record: Record<string, unknown>, issues: string[]): DecodedRecord | undefined {
	const turnId = requiredString(record["turn_id"], "missing_turn_id", issues);
	if (turnId === undefined) return undefined;
	const data = object(record["data"], "invalid_data", issues);
	return {
		event: "turn_start",
		turn_id: turnId,
		active_tools: stringArray(data["active_tools"], "invalid_active_tools", issues),
		definitions: definitionMap(data["tool_definitions"], issues),
	};
}

function decodeToolCall(record: Record<string, unknown>, fallbackCwd: string, issues: string[]): DecodedRecord | undefined {
	const turnId = requiredString(record["turn_id"], "missing_turn_id", issues);
	const callId = requiredString(record["tool_call_id"], "missing_tool_call_id", issues);
	const data = object(record["data"], "invalid_data", issues);
	const tool = object(data["tool"], "invalid_tool", issues);
	const toolName = requiredString(tool["name"], "missing_tool_name", issues);
	if (turnId === undefined || callId === undefined || toolName === undefined) return undefined;
	const callCwd = cwd(record, fallbackCwd, issues);
	const cohortId = optionalString(tool["cohort"], "invalid_tool_cohort", issues) ?? "unavailable";
	if (tool["cohort"] === undefined) issues.push("missing_tool_cohort");
	const inputEnvelope = object(data["input"], "invalid_input", issues);
	const requested = projection(inputEnvelope["requested"], "requested", callCwd, issues);
	const executed = inputEnvelope["executed"] === undefined
		? undefined
		: projection(inputEnvelope["executed"], "executed", callCwd, issues);
	const selectedInput = executed ?? requested;
	const annotations = optionalObject(data["annotations"], "invalid_annotations", issues);
	const preparation = optionalObject(annotations["preparation"], "invalid_preparation", issues);
	const approval = optionalObject(annotations["approval"], "invalid_approval", issues);
	const execution = optionalObject(annotations["execution"], "invalid_execution", issues);
	const result = object(data["result"], "invalid_result", issues);
	const output = optionalObject(result["output"], "invalid_output", issues);
	const estimatedTokens = optionalObject(output["estimated_tokens"], "invalid_estimated_tokens", issues);
	const error = optionalObject(result["error"], "invalid_error", issues);
	const resultReferences = references(result["references"], callCwd, "result", issues);
	const timestamp = optionalString(record["timestamp"], "invalid_timestamp", issues);
	const ok = optionalBoolean(result["ok"], "invalid_result_ok", issues);
	const outcome = optionalString(result["outcome"], "invalid_outcome", issues) ?? "unknown";
	if (result["outcome"] === undefined) issues.push("missing_outcome");
	const errorCode = optionalString(error["code"], "invalid_error_code", issues);
	const outputTokens = optionalNumber(estimatedTokens["value"], "invalid_output_tokens", issues);
	const outputTruncated = optionalBoolean(output["truncated"], "invalid_output_truncated", issues);
	const duration = optionalNumber(execution["duration_ms"], "invalid_duration_ms", issues);
	const preparationStatus = optionalString(preparation["status"], "invalid_preparation_status", issues);
	const approvalOutcome = optionalString(approval["outcome"], "invalid_approval_outcome", issues);
	const approvalWait = optionalNumber(approval["wait_ms"], "invalid_approval_wait_ms", issues);
	const projectionFailed = optionalBoolean(annotations["projection_failed"], "invalid_projection_failed", issues);
	const call: CanonicalCallDraft = {
		turn_id: turnId,
		...(timestamp === undefined ? {} : { timestamp }),
		tool_call_id: callId,
		tool_name: toolName,
		cohort_id: cohortId,
		input: selectedInput.value,
		input_references: selectedInput.references,
		input_key: `${toolName}\0${cohortId}\0${normalizedInput(selectedInput.value, selectedInput.references)}`,
		...(ok === undefined ? {} : { ok }),
		outcome,
		...(errorCode === undefined ? {} : { error_code: errorCode }),
		...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
		...(outputTruncated === undefined ? {} : { output_truncated: outputTruncated }),
		...(duration === undefined ? {} : { duration_ms: duration }),
		...(preparationStatus === undefined ? {} : { preparation_status: preparationStatus }),
		repair_operations: stringArray(preparation["operations"], "invalid_repair_operations", issues),
		...(approvalOutcome === undefined ? {} : { approval_outcome: approvalOutcome }),
		...(approvalWait === undefined ? {} : { approval_wait_ms: approvalWait }),
		...(projectionFailed === undefined ? {} : { projection_failed: projectionFailed }),
		candidates: resultReferences.filter((reference): reference is CanonicalCandidate =>
			reference.relation === "candidate" && reference.rank !== undefined && reference.group !== undefined),
		result_references: resultReferences,
		metrics: metricRecord(result["metrics"], issues),
		cwd: callCwd,
	};
	return { event: "tool_call", call };
}

function projection(
	value: unknown,
	name: string,
	cwdValue: string,
	issues: string[],
): { value: Record<string, unknown>; references: CanonicalReference[] } {
	const envelope = object(value, `invalid_${name}_projection`, issues);
	return {
		value: object(envelope["value"], `invalid_${name}_value`, issues),
		references: references(envelope["references"], cwdValue, name, issues),
	};
}

function references(value: unknown, cwdValue: string, scope: string, issues: string[]): CanonicalReference[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		issues.push(`invalid_${scope}_references`);
		return [];
	}
	return value.flatMap((item, index) => {
		if (!isRecord(item)) {
			issues.push(`invalid_${scope}_reference_${index}`);
			return [];
		}
		const relation = string(item["relation"]);
		const kind = string(item["kind"]);
		const rawValue = string(item["value"]);
		if (relation === undefined || kind === undefined || rawValue === undefined) {
			issues.push(`invalid_${scope}_reference_${index}`);
			return [];
		}
		const rank = optionalNumber(item["rank"], `invalid_${scope}_reference_rank_${index}`, issues);
		const group = optionalString(item["group"], `invalid_${scope}_reference_group_${index}`, issues);
		const start = optionalNumber(item["start_line"], `invalid_${scope}_reference_start_${index}`, issues);
		const end = optionalNumber(item["end_line"], `invalid_${scope}_reference_end_${index}`, issues);
		const normalized = normalizeReference(kind, rawValue, cwdValue);
		const canonicalRank = relation === "candidate" ? rank ?? index + 1 : rank;
		const canonicalGroup = relation === "candidate" ? group ?? "unknown" : group;
		return [{
			relation,
			kind,
			value: normalized,
			...(canonicalRank === undefined ? {} : { rank: canonicalRank }),
			...(canonicalGroup === undefined ? {} : { group: canonicalGroup }),
			sources: stringArray(item["sources"], `invalid_${scope}_reference_sources_${index}`, issues),
			...(start === undefined ? {} : { start_line: start }),
			...(end === undefined ? {} : { end_line: end }),
		}];
	});
}

function normalizeReference(kind: string, value: string, cwdValue: string): string {
	if (kind === "url") return normalizeUrlTarget(value) ?? value;
	return PATH_KINDS.has(kind) ? normalizePathTarget(value, cwdValue) : value;
}

function normalizedInput(input: Record<string, unknown>, inputReferences: readonly CanonicalReference[]): string {
	return canonicalJson({ input, references: inputReferences });
}

function metricRecord(value: unknown, issues: string[]): Record<string, CanonicalMetric> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		issues.push("invalid_metrics");
		return {};
	}
	const result: Record<string, CanonicalMetric> = {};
	for (const [name, rawMetric] of Object.entries(value)) {
		if (!isRecord(rawMetric)) {
			issues.push(`invalid_metric_${name}`);
			continue;
		}
		const metricValue = scalar(rawMetric["value"]);
		if (metricValue === undefined) {
			issues.push(`invalid_metric_${name}`);
			continue;
		}
		const unit = optionalString(rawMetric["unit"], `invalid_metric_unit_${name}`, issues);
		result[name] = { value: metricValue, ...(unit === undefined ? {} : { unit }) };
	}
	return result;
}

function cwd(record: Record<string, unknown>, fallback: string, issues: string[]): string {
	const context = optionalObject(record["context"], "invalid_context", issues);
	const value = optionalString(context["cwd"], "invalid_context_cwd", issues);
	if (value === undefined) issues.push("missing_context_cwd");
	return value ?? fallback;
}

function definitionMap(value: unknown, issues: string[]): Map<string, number> {
	const result = new Map<string, number>();
	if (value === undefined) return result;
	if (!Array.isArray(value)) {
		issues.push("invalid_tool_definitions");
		return result;
	}
	for (const item of value) {
		if (!isRecord(item)) continue;
		const name = string(item["name"]);
		const tokens = number(item["estimated_tokens"]);
		if (name !== undefined && tokens !== undefined) result.set(name, tokens);
	}
	return result;
}

function object(value: unknown, issue: string, issues: string[]): Record<string, unknown> {
	if (isRecord(value)) return value;
	issues.push(issue);
	return {};
}

function optionalObject(value: unknown, issue: string, issues: string[]): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	return object(value, issue, issues);
}

function requiredString(value: unknown, issue: string, issues: string[]): string | undefined {
	const parsed = string(value);
	if (parsed === undefined) issues.push(issue);
	return parsed;
}

function optionalString(value: unknown, issue: string, issues: string[]): string | undefined {
	if (value === undefined || value === null) return undefined;
	const parsed = string(value);
	if (parsed === undefined) issues.push(issue);
	return parsed;
}

function optionalNumber(value: unknown, issue: string, issues: string[]): number | undefined {
	if (value === undefined || value === null) return undefined;
	const parsed = number(value);
	if (parsed === undefined) issues.push(issue);
	return parsed;
}

function optionalBoolean(value: unknown, issue: string, issues: string[]): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") {
		issues.push(issue);
		return undefined;
	}
	return value;
}

function stringArray(value: unknown, issue: string, issues: string[]): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		issues.push(issue);
		return [];
	}
	const result = value.filter((item): item is string => typeof item === "string");
	if (result.length !== value.length) issues.push(issue);
	return result;
}

function scalar(value: unknown): string | number | boolean | undefined {
	return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
