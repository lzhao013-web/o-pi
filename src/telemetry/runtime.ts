import type { TelemetryRuntimeEvent } from "./channel.js";
import type { InputProjection, ToolRuntimeTelemetry } from "./types.js";

interface MutableCallState {
	toolCallId: string;
	toolName: string;
	requested: InputProjection;
	projectionFailed: boolean;
	cohortId?: string;
	preparation?: ToolRuntimeTelemetry["preparation"];
	executed?: InputProjection;
	approval?: ToolRuntimeTelemetry["approval"];
	execute?: ToolRuntimeTelemetry["execute"];
	observation?: ToolRuntimeTelemetry["observation"];
}

/** Session-scoped state owned exclusively by the telemetry extension realm. */
export class TelemetryCallStore {
	readonly #calls = new Map<string, MutableCallState>();

	start(toolCallId: string, toolName: string): void {
		this.#calls.set(toolCallId, {
			toolCallId,
			toolName,
			requested: { value: {} },
			projectionFailed: false,
		});
	}

	apply(event: TelemetryRuntimeEvent): void {
		const call = this.#calls.get(event.tool_call_id);
		if (call === undefined) return;
		if (event.tool_name !== call.toolName) return;
		switch (event.kind) {
			case "cohort":
				call.cohortId = event.cohort_id;
				break;
			case "preparation":
				call.requested = event.requested;
				call.preparation = { status: event.status, operations: event.operations };
				call.projectionFailed ||= event.projection_failed === true;
				break;
			case "execute_start":
				call.executed = event.executed;
				call.projectionFailed ||= event.projection_failed === true;
				break;
			case "execute_end":
				call.execute = event.execute;
				call.observation = event.observation;
				call.projectionFailed ||= event.projection_failed === true;
				break;
			case "approval":
				call.approval = event.approval;
				break;
		}
	}

	take(toolCallId: string, toolName: string): ToolRuntimeTelemetry | undefined {
		const call = this.#calls.get(toolCallId);
		if (call === undefined) return undefined;
		this.#calls.delete(toolCallId);
		if (call.toolName !== toolName) return undefined;
		return {
			tool_call_id: call.toolCallId,
			tool_name: call.toolName,
			...(call.cohortId === undefined ? {} : { cohort_id: call.cohortId }),
			input: {
				requested: call.requested,
				...(call.executed === undefined ? {} : { executed: call.executed }),
			},
			...(call.preparation === undefined ? {} : { preparation: call.preparation }),
			...(call.approval === undefined ? {} : { approval: call.approval }),
			...(call.execute === undefined ? {} : { execute: call.execute }),
			...(call.observation === undefined ? {} : { observation: call.observation }),
			...(call.projectionFailed ? { projection_failed: true } : {}),
		};
	}

	reset(): void {
		this.#calls.clear();
	}

	get size(): number {
		return this.#calls.size;
	}
}
