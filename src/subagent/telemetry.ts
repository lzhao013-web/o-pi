import { defineToolTelemetry } from "../telemetry/adapter.js";
import { compactJson, isRecord, scalar, telemetryMetric, textSummary } from "../telemetry/projectors.js";
import type { InputProjection, MetricMap, TelemetryReference } from "../telemetry/types.js";
import type { SubagentDetails, SubagentToolParams } from "./types.js";

export const subagentTelemetry = defineToolTelemetry<SubagentToolParams, SubagentDetails>({
	projectRequested: projectInput,
	projectExecuted(params) {
		return {
			value: {
				tasks: params.tasks.map((task) => compactJson({
					agent: task.agent,
					cwd: task.cwd,
					task: textSummary(task.task),
				})),
			},
			references: params.tasks.flatMap((task): TelemetryReference[] => task.cwd === undefined
				? []
				: [{ relation: "target", kind: "directory", value: task.cwd }]),
		};
	},
	observeResult(_params, result) {
		const details = result.details;
		const metrics: MetricMap = {
			mode: telemetryMetric(details.mode),
			tasks: telemetryMetric(details.tasks.length, "task"),
			failed: telemetryMetric(details.results.filter((item) => item.error !== undefined || item.exitCode !== 0).length, "task"),
			attempts: telemetryMetric(sum(details.results.map((item) => item.attempts)), "attempt"),
		};
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "contextTokens", "turns", "cost"] as const) {
			const total = sum(details.results.map((item) => item.usage[key] ?? 0));
			if (total !== 0) metrics[`usage_${key}`] = telemetryMetric(total);
		}
		return { metrics };
	},
});

function projectInput(value: unknown): InputProjection {
	if (!isRecord(value)) return { value: {} };
	const tasks = Array.isArray(value["tasks"])
		? value["tasks"].filter(isRecord).map((task) => compactJson({
			agent: scalar(task["agent"]),
			cwd: scalar(task["cwd"]),
			task: textSummary(task["task"]),
		}))
		: undefined;
	const references = Array.isArray(value["tasks"])
		? value["tasks"].filter(isRecord).flatMap((task): TelemetryReference[] => typeof task["cwd"] === "string"
			? [{ relation: "target", kind: "directory", value: task["cwd"] }]
			: [])
		: [];
	return { value: compactJson({ tasks }), references };
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}
