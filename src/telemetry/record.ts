import type { TelemetryCallStore } from "./runtime.js";
import type { TelemetryBase, TelemetryContext, ToolCallRecord, ToolRuntimeTelemetry } from "./types.js";

export interface ActiveTurn {
	id: string;
	index: number;
	startedAt: number;
	context: TelemetryContext;
}

export interface ToolCallData {
	id: string;
	name: string;
}

export interface ToolResultData {
	content: unknown;
	details: unknown;
	isError: boolean;
}

export function assembleToolCallRecord(
	base: TelemetryBase,
	turn: ActiveTurn,
	call: ToolCallData,
	result: ToolResultData | undefined,
	store: TelemetryCallStore,
): ToolCallRecord {
	const runtime = store.take(call.id, call.name);
	const observation = runtime?.observation;
	const classification = classifyOutcome(runtime, observation?.status, observation?.error_code, result);
	const output = outputStats(result?.content, observation?.truncated === true);
	return {
		event: "tool_call",
		...base,
		turn_id: turn.id,
		tool_call_id: call.id,
		data: {
			turn_index: turn.index,
			tool: { name: call.name, cohort: runtime?.cohort_id ?? "unavailable" },
			input: runtime?.input ?? { requested: { value: {} } },
			annotations: {
				...(runtime?.preparation === undefined ? {} : { preparation: runtime.preparation }),
				...(runtime?.approval === undefined ? {} : { approval: runtime.approval }),
				...(runtime?.execute === undefined ? {} : { execution: runtime.execute }),
				...(runtime?.projection_failed === true ? { projection_failed: true } : {}),
			},
			result: {
				...(classification.ok === undefined ? {} : { ok: classification.ok }),
				outcome: classification.outcome,
				...(classification.errorSource === undefined ? {} : {
					error: {
						source: classification.errorSource,
						...(classification.errorCode === undefined ? {} : { code: classification.errorCode }),
					},
				}),
				output,
				metrics: observation?.metrics ?? {},
				references: observation?.references ?? [],
			},
		},
	};
}

function classifyOutcome(
	runtime: ToolRuntimeTelemetry | undefined,
	status: string | undefined,
	code: string | undefined,
	result: ToolResultData | undefined,
): { outcome: string; ok?: boolean; errorSource?: string; errorCode?: string } {
	if (result === undefined) return { outcome: "missing_result", errorSource: "runtime" };
	if (runtime?.preparation?.status === "invalid") return { outcome: "validation_error", ok: false, errorSource: "validation" };
	if (isDenied(runtime?.approval)) return { outcome: "blocked", ok: false, errorSource: "approval" };
	if (status === "timed_out" || code === "TIMEOUT") return withCode("timeout", "tool", code);
	if (status === "aborted" || code === "ABORTED" || code === "OPERATION_ABORTED" || runtime?.execute?.signal_aborted === true) {
		return withCode("aborted", runtime?.execute?.state === "threw" ? "execute" : "tool", code);
	}
	if (runtime?.execute?.state === "threw") {
		if (runtime.execute.error_name === "TimeoutError") return { outcome: "timeout", ok: false, errorSource: "execute", errorCode: runtime.execute.error_name };
		if (runtime.execute.error_name === "AbortError") return { outcome: "aborted", ok: false, errorSource: "execute", errorCode: runtime.execute.error_name };
		return withCode("exception", "execute", runtime.execute.error_name);
	}
	if (result.isError || status === "failed") return withCode("tool_error", "tool", code);
	return { outcome: "success", ok: true };
}

function withCode(
	outcome: string,
	errorSource: string,
	errorCode: string | undefined,
): { outcome: string; ok: false; errorSource: string; errorCode?: string } {
	return { outcome, ok: false, errorSource, ...(errorCode === undefined ? {} : { errorCode }) };
}

function isDenied(approval: ToolRuntimeTelemetry["approval"]): boolean {
	return approval?.decision === "deny"
		|| approval?.outcome === "deny"
		|| approval?.outcome === "deny_with_instruction"
		|| approval?.outcome === "dismissed";
}

function outputStats(content: unknown, truncated: boolean): ToolCallRecord["data"]["result"]["output"] {
	let chars = 0;
	if (Array.isArray(content)) {
		for (const part of content) {
			if (isRecord(part) && part["type"] === "text" && typeof part["text"] === "string") chars += part["text"].length;
		}
	}
	return {
		text_chars: chars,
		estimated_tokens: { value: Math.ceil(chars / 4), method: "text_chars_div_4" },
		truncated,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
