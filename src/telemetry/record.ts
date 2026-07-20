import type { ToolCallState } from "./runtime.js";
import type { TelemetryBase, TelemetryContext, ToolCallEndRecord, ToolRuntimeTelemetry } from "./types.js";

export interface ActiveTurn {
	id: string;
	index: number;
	startedAt: number;
	context: TelemetryContext;
	interactionId?: string;
	exposures: Map<string, ToolCallState["identity"]>;
	startedCallIds: Set<string>;
	endedCallIds: Set<string>;
	projectionFailureIds: Set<string>;
}

export function assembleToolCallEndRecord(base: TelemetryBase, call: ToolCallState, endedAt: number): ToolCallEndRecord {
	const observation = call.observation;
	const classification = classifyOutcome(call, observation?.status, observation?.error_code);
	return {
		event: "tool_call_end",
		...base,
		turn_id: call.turnId,
		tool_call_id: call.toolCallId,
		...(call.interaction_id === undefined ? {} : { interaction_id: call.interaction_id }),
		...(call.assistant_message_id === undefined ? {} : { assistant_message_id: call.assistant_message_id }),
		...(call.tool_batch_id === undefined ? {} : { tool_batch_id: call.tool_batch_id }),
		...(call.batch_size === undefined ? {} : { batch_size: call.batch_size }),
		...(call.batch_index === undefined ? {} : { batch_index: call.batch_index }),
		data: {
			turn_index: call.turnIndex,
			tool: { name: call.toolName, identity: call.identity },
			timing: {
				call_started_at: new Date(call.callStartedAt).toISOString(),
				...(call.executionStartedAt === undefined ? {} : { execution_started_at: new Date(call.executionStartedAt).toISOString() }),
				...(call.executionEndedAt === undefined ? {} : { execution_ended_at: new Date(call.executionEndedAt).toISOString() }),
				...(call.execute === undefined ? {} : { execution_duration_ms: call.execute.duration_ms }),
				call_duration_ms: Math.max(0, endedAt - call.callStartedAt),
			},
			input: {
				requested: call.requested,
				...(call.executed === undefined ? {} : { executed: call.executed }),
			},
			annotations: {
				...(call.preparation === undefined ? {} : { preparation: call.preparation }),
				...(call.approval === undefined ? {} : { approval: call.approval }),
				...(call.execute === undefined ? {} : { execution: call.execute }),
				...(call.projectionFailed ? { projection_failed: true } : {}),
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
				output: outputStats(call.result?.content, observation?.truncated === true),
				metrics: observation?.metrics ?? {},
				references: observation?.references ?? [],
			},
		},
	};
}

function classifyOutcome(
	call: ToolCallState,
	status: string | undefined,
	code: string | undefined,
): { outcome: string; ok?: boolean; errorSource?: string; errorCode?: string } {
	if (call.result === undefined) return { outcome: "missing_result", errorSource: "runtime" };
	if (call.preparation?.status === "invalid") return { outcome: "validation_error", ok: false, errorSource: "validation" };
	if (isDenied(call.approval)) return { outcome: "blocked", ok: false, errorSource: "approval" };
	if (status === "timed_out" || code === "TIMEOUT") return withCode("timeout", "tool", code);
	if (status === "aborted" || code === "ABORTED" || code === "OPERATION_ABORTED" || call.execute?.signal_aborted === true) {
		return withCode("aborted", call.execute?.state === "threw" ? "execute" : "tool", code);
	}
	if (call.execute?.state === "threw") {
		if (call.execute.error_name === "TimeoutError") return { outcome: "timeout", ok: false, errorSource: "execute", errorCode: call.execute.error_name };
		if (call.execute.error_name === "AbortError") return { outcome: "aborted", ok: false, errorSource: "execute", errorCode: call.execute.error_name };
		return withCode("exception", "execute", call.execute.error_name);
	}
	if (call.result.isError || status === "failed") return withCode("tool_error", "tool", code);
	return { outcome: "success", ok: true };
}

function withCode(outcome: string, errorSource: string, errorCode: string | undefined) {
	return { outcome, ok: false as const, errorSource, ...(errorCode === undefined ? {} : { errorCode }) };
}

function isDenied(approval: ToolRuntimeTelemetry["approval"]): boolean {
	return approval?.decision === "deny"
		|| approval?.outcome === "deny"
		|| approval?.outcome === "deny_with_instruction"
		|| approval?.outcome === "dismissed";
}

function outputStats(content: unknown, truncated: boolean): ToolCallEndRecord["data"]["result"]["output"] {
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
