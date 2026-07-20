import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { repairableTool } from "../tool-repair/repair.js";
import type { RepairObservation, RepairSpecHints } from "../tool-repair/types.js";
import { defaultToolTelemetry, safeObserve, safeProjectExecuted, type DefinedToolTelemetry } from "./adapter.js";
import { emitTelemetryRuntime } from "./channel.js";
import { registerToolIdentity, type ToolIdentityOptions } from "./identity.js";
import type { ExecuteTelemetry } from "./types.js";

type ExecutedParams<TParams extends TSchema, TDetails, TState> = Parameters<ToolDefinition<TParams, TDetails, TState>["execute"]>[1];
type ObservedPi = Pick<ExtensionAPI, "events" | "getActiveTools" | "getAllTools" | "getThinkingLevel" | "on" | "registerTool">;

export interface ObservedToolOptions<TParams extends TSchema, TDetails, TState> extends ToolIdentityOptions {
	tool: ToolDefinition<TParams, TDetails, TState>;
	telemetry?: DefinedToolTelemetry<ExecutedParams<TParams, TDetails, TState>, TDetails>;
	repair?: RepairSpecHints;
}

interface PendingStart {
	toolCallId: string;
	toolName: string;
	rawArgs: unknown;
}

interface PendingExecution {
	toolName: string;
	completion?: ExecuteTelemetry;
	observe(result: AgentToolResult<unknown>): ReturnType<typeof safeObserve>;
}

const coordinators = new WeakMap<object, ToolTelemetryCoordinator>();

/** The only repository-level registration path for model-callable tools. */
export function registerObservedTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
	pi: ObservedPi,
	options: ObservedToolOptions<TParams, TDetails, TState>,
): void {
	const telemetry = options.telemetry ?? defaultToolTelemetry<ExecutedParams<TParams, TDetails, TState>, TDetails>();
	const { tool } = options;
	registerToolIdentity(tool, telemetry, {
		source: options.source,
		...(options.config === undefined ? {} : { config: options.config }),
	}, options.repair);
	const coordinator = coordinatorFor(pi);
	const preparedTool = repairableTool(tool, options.repair, {
		onPreparation(observation) {
			const toolCallId = coordinator.claimStart(tool.name, observation);
			if (toolCallId === undefined) return;
			emitTelemetryRuntime(pi.events, {
				kind: "preparation",
				tool_call_id: toolCallId,
				tool_name: tool.name,
				status: observation.status,
				operations: [...new Set(observation.operations)],
			});
		},
	});
	const execute: ToolDefinition<TParams, TDetails, TState>["execute"] = async (toolCallId, params, signal, onUpdate, ctx) => {
		const projected = safeProjectExecuted(telemetry, params);
		emitTelemetryRuntime(pi.events, {
			kind: "execute_start",
			tool_call_id: toolCallId,
			tool_name: tool.name,
			executed: projected.value,
			...(projected.failed ? { projection_failed: true } : {}),
			...(projected.limited ? { projection_limited: true } : {}),
		});
		const execution = coordinator.beginExecution(toolCallId, tool.name, params, telemetry);
		const startedAt = performance.now();
		try {
			const result = await preparedTool.execute(toolCallId, params, signal, onUpdate, ctx);
			execution.completion = {
				duration_ms: Math.max(0, performance.now() - startedAt),
				state: "returned",
				signal_aborted: signal?.aborted === true,
			};
			return result;
		} catch (error) {
			execution.completion = {
				duration_ms: Math.max(0, performance.now() - startedAt),
				state: "threw",
				signal_aborted: signal?.aborted === true,
				...(error instanceof Error && error.name.length > 0 ? { error_name: error.name } : {}),
			};
			throw error;
		}
	};
	pi.registerTool({ ...preparedTool, execute });
}

class ToolTelemetryCoordinator {
	readonly #pending: PendingStart[] = [];
	readonly #executions = new Map<string, PendingExecution>();

	constructor(private readonly pi: ObservedPi) {
		pi.on("tool_execution_start", (event) => {
			this.#pending.push({ toolCallId: event.toolCallId, toolName: event.toolName, rawArgs: event.args });
		});
		pi.on("tool_execution_end", (event) => {
			this.clearStart(event.toolCallId, event.toolName);
			const execution = this.#executions.get(event.toolCallId);
			if (execution?.toolName !== event.toolName || execution.completion === undefined) return;
			this.#executions.delete(event.toolCallId);
			const observation = execution.observe(event.result);
			emitTelemetryRuntime(this.pi.events, {
				kind: "execute_end",
				tool_call_id: event.toolCallId,
				tool_name: event.toolName,
				execute: execution.completion,
				observation: observation.value,
				...(observation.failed ? { projection_failed: true } : {}),
				...(observation.limited ? { projection_limited: true } : {}),
			});
		});
		pi.on("session_start", () => {
			this.#pending.splice(0);
			this.#executions.clear();
		});
	}

	claimStart(toolName: string, observation: RepairObservation): string | undefined {
		const index = this.#pending.findIndex((item) => item.toolName === toolName && item.rawArgs === observation.rawArgs);
		return index < 0 ? undefined : this.#pending.splice(index, 1)[0]?.toolCallId;
	}

	beginExecution<TParams, TDetails>(
		toolCallId: string,
		toolName: string,
		params: TParams,
		telemetry: DefinedToolTelemetry<TParams, TDetails>,
	): PendingExecution {
		const execution: PendingExecution = {
			toolName,
			observe: (result) => safeObserve(telemetry, params, result as AgentToolResult<TDetails>),
		};
		this.#executions.set(toolCallId, execution);
		return execution;
	}

	private clearStart(toolCallId: string, toolName: string): void {
		const index = this.#pending.findIndex((item) => item.toolCallId === toolCallId && item.toolName === toolName);
		if (index >= 0) this.#pending.splice(index, 1);
	}
}

function coordinatorFor(pi: ObservedPi): ToolTelemetryCoordinator {
	const existing = coordinators.get(pi);
	if (existing !== undefined) return existing;
	const coordinator = new ToolTelemetryCoordinator(pi);
	coordinators.set(pi, coordinator);
	return coordinator;
}
