import { createHash } from "node:crypto";

import { canonicalJson, normalizePathTarget, normalizeUrlTarget } from "./normalize.js";
import type {
	CanonicalCallDraft,
	CanonicalCandidate,
	CanonicalContext,
	CanonicalMetric,
	CanonicalReference,
	CanonicalResource,
	CanonicalSource,
	CanonicalToolExposure,
	DecodeContext,
	DecodedRecord,
	TelemetryReadResult,
	ToolIdentityDimensions,
} from "./model.js";

const PATH_KINDS = new Set(["file", "directory", "path", "region"]);
const UNAVAILABLE = "unavailable";

/** Tolerant decoder: recognized facts survive partial records and every loss is surfaced as an issue. */
export function readTelemetryRecord(value: unknown, fallback: DecodeContext): TelemetryReadResult {
	if (!isRecord(value)) return { status: "invalid", raw: value, issues: ["record_not_object"] };
	const event = text(value["event"]);
	const id = text(value["id"]);
	const sessionId = text(value["session_id"]);
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
			record = { event, cwd: decodeContext(value, fallback.cwd, issues).project };
			break;
		case "session_end":
			record = { event, ...optionalCount(object(value["data"], "invalid_data", issues)["unfinished_call_count"], "unfinished_call_count", issues) };
			break;
		case "turn_start":
			record = decodeTurnStart(value, fallback.cwd, issues);
			break;
		case "turn_end":
			record = decodeTurnEnd(value, issues);
			break;
		case "tool_call_start":
			record = decodeCallStart(value, issues);
			break;
		case "tool_call_end":
			record = decodeToolCall(value, fallback.cwd, issues);
			break;
		case "collection_health":
			record = decodeCollectionHealth(value, sessionId, issues);
			break;
		case "tool_execution_start":
			record = { event: "ignored" };
			break;
		default:
			return { status: "unknown_event", event, raw: value };
	}
	if (record === undefined) return { status: "invalid", raw: value, issues };
	return issues.length === 0
		? { status: "known", record, raw: value, issues: [] }
		: { status: "partial", record, raw: value, issues };
}

function decodeTurnStart(record: Record<string, unknown>, fallbackCwd: string, issues: string[]): DecodedRecord | undefined {
	const turnId = requiredText(record["turn_id"], "missing_turn_id", issues);
	if (turnId === undefined) return undefined;
	const data = object(record["data"], "invalid_data", issues);
	const context = decodeContext(record, fallbackCwd, issues);
	return {
		event: "turn_start",
		turn: {
			id: turnId,
			context,
			...(context.interaction === undefined ? {} : { interaction: context.interaction }),
			...(context.branch === undefined ? {} : { branch_lineage: context.branch.lineage_hash }),
			...optionalCount(data["turn_index"], "turn_index", issues),
			...optionalTimestamp(record["timestamp"], "started_at", issues),
			exposures: exposures(data["tools"], issues),
			missing_start_ids: [],
			missing_end_ids: [],
		},
	};
}

function decodeTurnEnd(record: Record<string, unknown>, issues: string[]): DecodedRecord | undefined {
	const turnId = requiredText(record["turn_id"], "missing_turn_id", issues);
	if (turnId === undefined) return undefined;
	const data = object(record["data"], "invalid_data", issues);
	return {
		event: "turn_end",
		turn: {
			id: turnId,
			...optionalText(record["interaction_id"], "interaction", "invalid_interaction_id", issues),
			...optionalCount(data["turn_index"], "turn_index", issues),
			...optionalTimestamp(record["timestamp"], "ended_at", issues),
			...optionalCount(data["expected_call_count"], "expected_call_count", issues),
			...optionalCount(data["observed_start_count"], "observed_start_count", issues),
			...optionalCount(data["observed_end_count"], "observed_end_count", issues),
			...optionalCount(data["unfinished_call_count"], "unfinished_call_count", issues),
			...optionalCount(data["projection_failure_count"], "projection_failure_count", issues),
			missing_start_ids: stringArray(data["missing_start_ids"], "invalid_missing_start_ids", issues),
			missing_end_ids: stringArray(data["missing_end_ids"], "invalid_missing_end_ids", issues),
		},
	};
}

function decodeCallStart(record: Record<string, unknown>, issues: string[]): DecodedRecord | undefined {
	const turnId = requiredText(record["turn_id"], "missing_turn_id", issues);
	const callId = requiredText(record["tool_call_id"], "missing_tool_call_id", issues);
	return turnId === undefined || callId === undefined ? undefined : { event: "tool_call_start", turn_id: turnId, tool_call_id: callId };
}

function decodeCollectionHealth(record: Record<string, unknown>, sessionId: string, issues: string[]): DecodedRecord | undefined {
	const data = object(record["data"], "invalid_data", issues);
	const issue = requiredText(data["issue"], "missing_health_issue", issues);
	if (issue === undefined) return undefined;
	const count = optionalFinite(data["count"], "invalid_health_count", issues);
	return { event: "collection_health", issue: {
		issue,
		count: count === undefined ? 1 : Math.max(0, Math.floor(count)),
		session_id: sessionId,
		...optionalText(record["turn_id"], "turn_id", "invalid_turn_id", issues),
		...optionalText(record["tool_call_id"], "tool_call_id", "invalid_tool_call_id", issues),
	} };
}

function decodeToolCall(record: Record<string, unknown>, fallbackCwd: string, issues: string[]): DecodedRecord | undefined {
	const turnId = requiredText(record["turn_id"], "missing_turn_id", issues);
	const callId = requiredText(record["tool_call_id"], "missing_tool_call_id", issues);
	const sequence = requiredInteger(record["sequence"], "missing_sequence", issues);
	const data = object(record["data"], "invalid_data", issues);
	const tool = object(data["tool"], "invalid_tool", issues);
	const toolName = requiredText(tool["name"], "missing_tool_name", issues);
	if (turnId === undefined || callId === undefined || toolName === undefined || sequence === undefined) return undefined;
	const identity = identityDimensions(tool["identity"], issues);
	const context = decodeContext(record, fallbackCwd, issues);
	const inputEnvelope = object(data["input"], "invalid_input", issues);
	const requested = projection(inputEnvelope["requested"], "requested", context.project, issues);
	const executed = inputEnvelope["executed"] === undefined ? undefined : projection(inputEnvelope["executed"], "executed", context.project, issues);
	const selected = executed ?? requested;
	const annotations = optionalObject(data["annotations"], "invalid_annotations", issues);
	const preparation = optionalObject(annotations["preparation"], "invalid_preparation", issues);
	const approval = optionalObject(annotations["approval"], "invalid_approval", issues);
	const execution = optionalObject(annotations["execution"], "invalid_execution", issues);
	const result = object(data["result"], "invalid_result", issues);
	const output = optionalObject(result["output"], "invalid_output", issues);
	const estimatedTokens = optionalObject(output["estimated_tokens"], "invalid_estimated_tokens", issues);
	const error = optionalObject(result["error"], "invalid_error", issues);
	const timing = optionalObject(data["timing"], "invalid_timing", issues);
	const resultReferences = references(result["references"], context.project, "result", issues);
	const ok = optionalBoolean(result["ok"], "invalid_result_ok", issues);
	const outcome = optionalValueText(result["outcome"], "invalid_outcome", issues) ?? "unknown";
	if (result["outcome"] === undefined) issues.push("missing_outcome");
	const duration = optionalFinite(timing["execution_duration_ms"], "invalid_execution_duration_ms", issues)
		?? optionalFinite(execution["duration_ms"], "invalid_duration_ms", issues);
	const call: CanonicalCallDraft = {
		turn_id: turnId,
		...optionalCount(data["turn_index"], "turn_index", issues),
		sequence,
		tool_call_id: callId,
		tool_name: toolName,
		slice_id: sliceId(toolName, identity.behavior_hash, identity.instrumentation_hash),
		identity,
		context,
		timing: {
			...optionalTimestamp(record["timestamp"], "event_at", issues),
			...timestampField(timing["call_started_at"], "call_started_at", issues),
			...timestampField(timing["execution_started_at"], "execution_started_at", issues),
			...timestampField(timing["execution_ended_at"], "execution_ended_at", issues),
			...optionalNumberField(timing["call_duration_ms"], "call_duration_ms", "invalid_call_duration_ms", issues),
			...(duration === undefined ? {} : { execution_duration_ms: duration }),
		},
		requested_input: requested.value,
		requested_references: requested.references,
		...(executed === undefined ? {} : { executed_input: executed.value, executed_references: executed.references }),
		input: selected.value,
		input_references: selected.references,
		input_key: canonicalJson({
			tool: toolName,
			behavior: identity.behavior_hash,
			instrumentation: identity.instrumentation_hash,
			input: selected.value,
			references: selected.references.map((reference) => ({
				relation: reference.relation,
				kind: reference.kind,
				value: reference.value,
				...(reference.resource?.start_line === undefined ? {} : { start_line: reference.resource.start_line }),
				...(reference.resource?.end_line === undefined ? {} : { end_line: reference.resource.end_line }),
			})),
		}),
		...(ok === undefined ? {} : { ok }),
		outcome,
		...optionalText(error["code"], "error_code", "invalid_error_code", issues),
		...optionalNumberField(estimatedTokens["value"], "output_tokens", "invalid_output_tokens", issues),
		...optionalBooleanField(output["truncated"], "output_truncated", "invalid_output_truncated", issues),
		...(duration === undefined ? {} : { duration_ms: duration }),
		...optionalText(preparation["status"], "preparation_status", "invalid_preparation_status", issues),
		repair_operations: stringArray(preparation["operations"], "invalid_repair_operations", issues),
		...optionalText(approval["outcome"], "approval_outcome", "invalid_approval_outcome", issues),
		...optionalNumberField(approval["wait_ms"], "approval_wait_ms", "invalid_approval_wait_ms", issues),
		...optionalBooleanField(annotations["projection_failed"], "projection_failed", "invalid_projection_failed", issues),
		candidates: resultReferences.filter((reference): reference is CanonicalCandidate =>
			reference.relation === "candidate" && reference.global_rank !== undefined && reference.group !== undefined),
		result_references: resultReferences,
		metrics: metricRecord(result["metrics"], issues),
	};
	return { event: "tool_call", call };
}

function decodeContext(record: Record<string, unknown>, fallbackCwd: string, issues: string[]): CanonicalContext {
	const raw = optionalObject(record["context"], "invalid_context", issues);
	const project = optionalValueText(raw["cwd"], "invalid_context_cwd", issues) ?? fallbackCwd;
	if (raw["cwd"] === undefined) issues.push("missing_context_cwd");
	const model = optionalObject(raw["model"], "invalid_context_model", issues);
	const provider = optionalValueText(model["provider"], "invalid_model_provider", issues);
	const modelId = optionalValueText(model["id"], "invalid_model_id", issues);
	const toolset = optionalObject(raw["toolset"], "invalid_context_toolset", issues);
	const toolsetHash = optionalValueText(toolset["hash"], "invalid_toolset_hash", issues);
	const host = optionalObject(raw["host"], "invalid_context_host", issues);
	const branch = optionalObject(raw["branch"], "invalid_context_branch", issues);
	const lineage = optionalValueText(branch["lineage_hash"], "invalid_branch_lineage", issues);
	const batchId = optionalValueText(record["tool_batch_id"], "invalid_tool_batch_id", issues);
	return {
		collector_contract: collectorContract(record["collector_contract"] ?? raw["collector_contract"] ?? record["schema_version"], issues),
		...(provider === undefined || modelId === undefined ? {} : { model: { provider, id: modelId } }),
		...optionalText(raw["thinking_level"], "thinking", "invalid_thinking_level", issues),
		...(toolsetHash === undefined ? {} : { toolset: { active: stringArray(toolset["active"], "invalid_toolset_active", issues), hash: toolsetHash } }),
		project,
		environment: {
			...optionalText(host["pi_version"], "pi_version", "invalid_pi_version", issues),
			...optionalText(host["mode"], "mode", "invalid_host_mode", issues),
			...optionalText(host["platform"], "platform", "invalid_host_platform", issues),
			...optionalText(host["arch"], "arch", "invalid_host_arch", issues),
			...optionalText(host["node_version"], "node_version", "invalid_node_version", issues),
		},
		...optionalText(record["interaction_id"], "interaction", "invalid_interaction_id", issues),
		...(lineage === undefined ? {} : { branch: {
			...optionalText(branch["leaf_id"], "leaf_id", "invalid_branch_leaf", issues),
			lineage_hash: lineage,
			...optionalCount(branch["depth"], "depth", issues),
		} }),
		...optionalText(record["assistant_message_id"], "assistant_message", "invalid_assistant_message_id", issues),
		...(batchId === undefined ? {} : { tool_batch: {
			id: batchId,
			...optionalCount(record["batch_size"], "size", issues),
			...optionalCount(record["batch_index"], "index", issues),
		} }),
	};
}

function collectorContract(value: unknown, issues: string[]): string {
	if (value === undefined || value === null) return "unversioned";
	if (typeof value === "string" && value.length > 0) return value;
	if (isRecord(value)) return canonicalJson(value);
	issues.push("invalid_collector_contract");
	return "unversioned";
}

function identityDimensions(value: unknown, issues: string[]): ToolIdentityDimensions {
	const raw = object(value, "invalid_tool_identity", issues);
	const behavior = optionalValueText(raw["behavior_hash"], "invalid_behavior_hash", issues) ?? UNAVAILABLE;
	const instrumentation = optionalValueText(raw["telemetry_hash"], "invalid_telemetry_hash", issues)
		?? optionalValueText(raw["instrumentation_hash"], "invalid_instrumentation_hash", issues)
		?? UNAVAILABLE;
	if (raw["behavior_hash"] === undefined) issues.push("missing_behavior_hash");
	if (raw["telemetry_hash"] === undefined && raw["instrumentation_hash"] === undefined) issues.push("missing_instrumentation_hash");
	return {
		behavior_hash: behavior,
		instrumentation_hash: instrumentation,
		definition_hash: optionalValueText(raw["definition_hash"], "invalid_definition_hash", issues) ?? UNAVAILABLE,
		config_hash: optionalValueText(raw["config_hash"], "invalid_config_hash", issues) ?? UNAVAILABLE,
	};
}

function exposures(value: unknown, issues: string[]): CanonicalToolExposure[] {
	if (!Array.isArray(value)) {
		issues.push("invalid_tools");
		return [];
	}
	return value.flatMap((item, index) => {
		if (!isRecord(item)) {
			issues.push(`invalid_tool_${index}`);
			return [];
		}
		const name = text(item["name"]);
		if (name === undefined) return [];
		const estimate = optionalObject(item["definition_tokens"], `invalid_definition_tokens_${index}`, issues);
		const identity = identityDimensions(item, issues);
		return [{ name, slice_id: sliceId(name, identity.behavior_hash, identity.instrumentation_hash), identity, definition_tokens: optionalFinite(estimate["value"], `invalid_definition_tokens_${index}`, issues) ?? 0 }];
	});
}

function projection(value: unknown, name: string, cwd: string, issues: string[]): { value: Record<string, unknown>; references: CanonicalReference[] } {
	const envelope = object(value, `invalid_${name}_projection`, issues);
	return { value: object(envelope["value"], `invalid_${name}_value`, issues), references: references(envelope["references"], cwd, name, issues) };
}

function references(value: unknown, cwd: string, scope: string, issues: string[]): CanonicalReference[] {
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
		const relation = text(item["relation"]);
		const kind = text(item["kind"]);
		const rawValue = text(item["value"]);
		if (relation === undefined || kind === undefined || rawValue === undefined) {
			issues.push(`invalid_${scope}_reference_${index}`);
			return [];
		}
		const globalRank = optionalFinite(item["global_rank"], `invalid_${scope}_global_rank_${index}`, issues);
		const groupRank = optionalFinite(item["group_rank"], `invalid_${scope}_group_rank_${index}`, issues);
		const group = optionalValueText(item["group"], `invalid_${scope}_group_${index}`, issues);
		const resource = resourceState(item["resource"], `${scope}_${index}`, issues);
		return [{
			relation,
			kind,
			value: normalizeReference(kind, rawValue, cwd),
			...(relation !== "candidate" && globalRank === undefined ? {} : { global_rank: globalRank ?? index + 1 }),
			...(groupRank === undefined ? {} : { group_rank: groupRank }),
			...(relation !== "candidate" && group === undefined ? {} : { group: group ?? "unknown" }),
			sources: sourceRecords(item["sources"], `${scope}_${index}`, issues),
			...(resource === undefined ? {} : { resource }),
		}];
	});
}

function sourceRecords(value: unknown, scope: string, issues: string[]): CanonicalSource[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		issues.push(`invalid_${scope}_sources`);
		return [];
	}
	return value.flatMap((item, index) => {
		if (!isRecord(item) || text(item["id"]) === undefined) {
			issues.push(`invalid_${scope}_source_${index}`);
			return [];
		}
		return [{ id: text(item["id"]) as string,
			...optionalText(item["family"], "family", `invalid_${scope}_source_family_${index}`, issues),
			...optionalNumberField(item["source_rank"], "rank", `invalid_${scope}_source_rank_${index}`, issues),
		}];
	});
}

function resourceState(value: unknown, scope: string, issues: string[]): CanonicalResource | undefined {
	if (value === undefined || value === null) return undefined;
	const raw = object(value, `invalid_${scope}_resource`, issues);
	const hash = optionalObject(raw["content_hash"], `invalid_${scope}_content_hash`, issues);
	const algorithm = optionalValueText(hash["algorithm"], `invalid_${scope}_hash_algorithm`, issues);
	const hashValue = optionalValueText(hash["value"], `invalid_${scope}_hash_value`, issues);
	return {
		...(algorithm === undefined || hashValue === undefined ? {} : { content_hash: { algorithm, value: hashValue } }),
		...optionalText(raw["snapshot"], "snapshot", `invalid_${scope}_snapshot`, issues),
		...optionalText(raw["revision"], "revision", `invalid_${scope}_revision`, issues),
		...optionalNumberField(raw["start_line"], "start_line", `invalid_${scope}_start_line`, issues),
		...optionalNumberField(raw["end_line"], "end_line", `invalid_${scope}_end_line`, issues),
	};
}

function metricRecord(value: unknown, issues: string[]): Record<string, CanonicalMetric> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		issues.push("invalid_metrics");
		return {};
	}
	const result: Record<string, CanonicalMetric> = {};
	for (const [name, raw] of Object.entries(value)) {
		if (!isRecord(raw)) {
			issues.push(`invalid_metric_${name}`);
			continue;
		}
		const metricValue = scalar(raw["value"]);
		const kind = optionalValueText(raw["kind"], `invalid_metric_kind_${name}`, issues);
		const aggregation = optionalValueText(raw["aggregation"], `invalid_metric_aggregation_${name}`, issues);
		if (metricValue === undefined || kind === undefined || aggregation === undefined) {
			issues.push(metricValue === undefined ? `invalid_metric_${name}` : `missing_metric_semantics_${name}`);
			continue;
		}
		result[name] = { value: metricValue, kind, aggregation, ...optionalText(raw["unit"], "unit", `invalid_metric_unit_${name}`, issues) };
	}
	return result;
}

function normalizeReference(kind: string, value: string, cwd: string): string {
	if (kind === "url") return normalizeUrlTarget(value) ?? value;
	return PATH_KINDS.has(kind) ? normalizePathTarget(value, cwd) : value;
}

export function sliceId(tool: string, behavior: string, instrumentation: string): string {
	const digest = createHash("sha256").update(canonicalJson({ tool, behavior, instrumentation })).digest("hex").slice(0, 16);
	return `${tool}:${digest}`;
}

function optionalText(value: unknown, key: string, issue: string, issues: string[]): Record<string, string> {
	const parsed = optionalValueText(value, issue, issues);
	return parsed === undefined ? {} : { [key]: parsed };
}

function optionalTimestamp(value: unknown, key: string, issues: string[]): Record<string, string> {
	return timestampField(value, key, issues);
}

function timestampField(value: unknown, key: string, issues: string[]): Record<string, string> {
	if (value === undefined || value === null) return {};
	const parsed = text(value);
	if (parsed === undefined || !Number.isFinite(Date.parse(parsed))) {
		issues.push(`invalid_${key}`);
		return {};
	}
	return { [key]: parsed };
}

function optionalCount(value: unknown, key: string, issues: string[]): Record<string, number> {
	if (value === undefined || value === null) return {};
	const parsed = optionalFinite(value, `invalid_${key}`, issues);
	return parsed === undefined ? {} : { [key]: Math.max(0, Math.floor(parsed)) };
}

function optionalNumberField(value: unknown, key: string, issue: string, issues: string[]): Record<string, number> {
	const parsed = optionalFinite(value, issue, issues);
	return parsed === undefined ? {} : { [key]: parsed };
}

function optionalBooleanField(value: unknown, key: string, issue: string, issues: string[]): Record<string, boolean> {
	const parsed = optionalBoolean(value, issue, issues);
	return parsed === undefined ? {} : { [key]: parsed };
}

function object(value: unknown, issue: string, issues: string[]): Record<string, unknown> {
	if (isRecord(value)) return value;
	issues.push(issue);
	return {};
}

function optionalObject(value: unknown, issue: string, issues: string[]): Record<string, unknown> {
	return value === undefined || value === null ? {} : object(value, issue, issues);
}

function requiredText(value: unknown, issue: string, issues: string[]): string | undefined {
	const parsed = text(value);
	if (parsed === undefined) issues.push(issue);
	return parsed;
}

function optionalValueText(value: unknown, issue: string, issues: string[]): string | undefined {
	if (value === undefined || value === null) return undefined;
	const parsed = text(value);
	if (parsed === undefined) issues.push(issue);
	return parsed;
}

function requiredInteger(value: unknown, issue: string, issues: string[]): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
	issues.push(issue);
	return undefined;
}

function optionalFinite(value: unknown, issue: string, issues: string[]): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	issues.push(issue);
	return undefined;
}

function optionalBoolean(value: unknown, issue: string, issues: string[]): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	issues.push(issue);
	return undefined;
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

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
