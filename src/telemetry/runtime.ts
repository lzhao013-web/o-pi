import type { TelemetryRuntimeEvent } from "./channel.js";
import type {
	CallDimensions,
	InputProjection,
	ToolIdentity,
	ToolRuntimeTelemetry,
} from "./types.js";

export interface ToolResultData {
	content: unknown;
	details: unknown;
	isError: boolean;
}

export interface ToolCallState extends CallDimensions {
	toolCallId: string;
	toolName: string;
	turnId: string;
	turnIndex: number;
	identity: ToolIdentity;
	callStartedAt: number;
	executionStartedAt?: number;
	executionEndedAt?: number;
	requested: InputProjection;
	projectionFailed: boolean;
	preparation?: ToolRuntimeTelemetry["preparation"];
	executed?: InputProjection;
	approval?: ToolRuntimeTelemetry["approval"];
	execute?: ToolRuntimeTelemetry["execute"];
	observation?: ToolRuntimeTelemetry["observation"];
	result?: ToolResultData;
}

export interface StartCallInput extends CallDimensions {
	toolCallId: string;
	toolName: string;
	turnId: string;
	turnIndex: number;
	identity: ToolIdentity;
	startedAt: number;
}

/** Session-scoped raw call state. It never invents missing lifecycle facts. */
export class TelemetryCallStore {
	readonly #calls = new Map<string, ToolCallState>();

	start(input: StartCallInput): ToolCallState {
		const call: ToolCallState = {
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			turnId: input.turnId,
			turnIndex: input.turnIndex,
			identity: input.identity,
			callStartedAt: input.startedAt,
			requested: { value: {} },
			projectionFailed: false,
			...(input.interaction_id === undefined ? {} : { interaction_id: input.interaction_id }),
			...(input.assistant_message_id === undefined ? {} : { assistant_message_id: input.assistant_message_id }),
			...(input.tool_batch_id === undefined ? {} : { tool_batch_id: input.tool_batch_id }),
			...(input.batch_size === undefined ? {} : { batch_size: input.batch_size }),
			...(input.batch_index === undefined ? {} : { batch_index: input.batch_index }),
		};
		this.#calls.set(input.toolCallId, call);
		return call;
	}

	apply(event: TelemetryRuntimeEvent, observedAt: number): ToolCallState | undefined {
		const call = this.#calls.get(event.tool_call_id);
		if (call === undefined || event.tool_name !== call.toolName) return undefined;
		switch (event.kind) {
			case "preparation":
				call.requested = event.requested;
				call.preparation = { status: event.status, operations: event.operations };
				call.projectionFailed ||= event.projection_failed === true;
				break;
			case "execute_start":
				call.executed = event.executed;
				call.executionStartedAt ??= observedAt;
				call.projectionFailed ||= event.projection_failed === true;
				break;
			case "execute_end":
				call.execute = event.execute;
				call.observation = event.observation;
				call.executionEndedAt ??= observedAt;
				call.projectionFailed ||= event.projection_failed === true;
				break;
			case "approval":
				call.approval = event.approval;
				break;
		}
		return call;
	}

	finish(toolCallId: string, toolName: string, result: ToolResultData): ToolCallState | undefined {
		const call = this.#calls.get(toolCallId);
		if (call === undefined || call.toolName !== toolName) return undefined;
		call.result = result;
		return call;
	}

	get(toolCallId: string): ToolCallState | undefined {
		return this.#calls.get(toolCallId);
	}

	take(toolCallId: string): ToolCallState | undefined {
		const call = this.#calls.get(toolCallId);
		if (call !== undefined) this.#calls.delete(toolCallId);
		return call;
	}

	forTurn(turnId: string): ToolCallState[] {
		return [...this.#calls.values()].filter((call) => call.turnId === turnId);
	}

	reset(): void {
		this.#calls.clear();
	}

	get size(): number {
		return this.#calls.size;
	}
}
