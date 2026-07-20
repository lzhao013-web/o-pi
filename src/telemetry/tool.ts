import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

import { repairableTool } from "../tool-repair/repair.js";
import type { RepairObservation, RepairSpecHints } from "../tool-repair/types.js";
import type { ToolTelemetryAdapter } from "./adapter.js";
import { safeObserve, safeProjectExecuted, safeProjectRequested } from "./adapter.js";
import { emitTelemetryRuntime } from "./channel.js";
import { computeToolCohortId, computeToolImplementationHash, type ToolCohortSpec } from "./cohort.js";
import type { ExecuteTelemetry } from "./types.js";

type ExecutedParams<TParams extends TSchema, TDetails, TState> = Parameters<ToolDefinition<TParams, TDetails, TState>["execute"]>[1];

export interface ObservedToolOptions<TParams extends TSchema, TDetails, TState> {
	tool: ToolDefinition<TParams, TDetails, TState>;
	telemetry: ToolTelemetryAdapter<ExecutedParams<TParams, TDetails, TState>, TDetails>;
	cohort: ToolCohortSpec;
	repair?: RepairSpecHints;
}

interface PendingStart {
	toolCallId: string;
	rawArgs: unknown;
}

interface PendingExecution<TParams> {
	params: TParams;
	completion?: ExecuteTelemetry;
}

/** The only repository-level registration path for model-callable tools. */
export function registerObservedTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
	pi: Pick<ExtensionAPI, "events" | "getActiveTools" | "getAllTools" | "getThinkingLevel" | "on" | "registerTool">,
	options: ObservedToolOptions<TParams, TDetails, TState>,
): void {
	const pending: PendingStart[] = [];
	const executions = new Map<string, PendingExecution<ExecutedParams<TParams, TDetails, TState>>>();
	const { tool, telemetry } = options;
	const implementationHash = computeToolImplementationHash(tool, telemetry, options.cohort.implementationEntrypoints, options.repair);
	pi.on("tool_execution_start", async (event, ctx) => {
		captureStart(event, tool.name, pending);
		if (event.toolName !== tool.name) return;
		const cohortId = await computeToolCohortId(pi, ctx, implementationHash, options.cohort.config).catch(() => "unavailable");
		emitCohort(pi.events, event.toolCallId, tool.name, cohortId);
	});
	pi.on("tool_execution_end", (event) => {
		clearStart(event, tool.name, pending);
		if (event.toolName !== tool.name) return;
		const execution = executions.get(event.toolCallId);
		if (execution?.completion === undefined) return;
		executions.delete(event.toolCallId);
		const observation = safeObserve(telemetry, execution.params, event.result);
		emitTelemetryRuntime(pi.events, {
			kind: "execute_end",
			tool_call_id: event.toolCallId,
			tool_name: tool.name,
			execute: execution.completion,
			observation: observation.value,
			...(observation.failed ? { projection_failed: true } : {}),
		});
	});
	pi.on("session_start", () => {
		pending.splice(0);
		executions.clear();
	});

	const preparedTool = repairableTool(tool, options.repair, {
		onPreparation(observation) {
			const start = claimStart(observation, pending);
			if (start === undefined) return;
			const requested = safeProjectRequested(telemetry, observation.rawArgs);
			emitTelemetryRuntime(pi.events, {
				kind: "preparation",
				tool_call_id: start.toolCallId,
				tool_name: tool.name,
				requested: requested.value,
				status: observation.status,
				operations: [...new Set(observation.operations)],
				...(requested.failed ? { projection_failed: true } : {}),
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
		});
		const startedAt = Date.now();
		const execution: PendingExecution<ExecutedParams<TParams, TDetails, TState>> = { params };
		executions.set(toolCallId, execution);
		try {
			const result = await preparedTool.execute(toolCallId, params, signal, onUpdate, ctx);
			execution.completion = {
				duration_ms: Math.max(0, Date.now() - startedAt),
				state: "returned",
				signal_aborted: signal?.aborted === true,
			};
			return result;
		} catch (error) {
			execution.completion = {
				duration_ms: Math.max(0, Date.now() - startedAt),
				state: "threw",
				signal_aborted: signal?.aborted === true,
				...(error instanceof Error && error.name.length > 0 ? { error_name: error.name } : {}),
			};
			throw error;
		}
	};
	pi.registerTool({ ...preparedTool, execute });
}

function emitCohort(events: ExtensionAPI["events"], toolCallId: string, toolName: string, cohortId: string): void {
	emitTelemetryRuntime(events, {
		kind: "cohort",
		tool_call_id: toolCallId,
		tool_name: toolName,
		cohort_id: cohortId,
	});
}

function captureStart(event: { toolCallId: string; toolName: string; args: unknown }, toolName: string, pending: PendingStart[]): void {
	if (event.toolName === toolName) pending.push({ toolCallId: event.toolCallId, rawArgs: event.args });
}

function clearStart(event: { toolCallId: string; toolName: string }, toolName: string, pending: PendingStart[]): void {
	if (event.toolName !== toolName) return;
	const index = pending.findIndex((item) => item.toolCallId === event.toolCallId);
	if (index >= 0) pending.splice(index, 1);
}

function claimStart(observation: RepairObservation, pending: PendingStart[]): PendingStart | undefined {
	const index = pending.findIndex((item) => item.rawArgs === observation.rawArgs);
	return index < 0 ? undefined : pending.splice(index, 1)[0];
}
