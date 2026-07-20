import { fields, isRecord, scalar, textFields } from "../telemetry/projection.js";
import { defineToolTelemetry } from "../telemetry/tool.js";
import type { Resource, TelemetryFacts } from "../telemetry/types.js";
import type { SubagentDetails, SubagentToolParams } from "./types.js";

export const subagentTelemetry = defineToolTelemetry<SubagentToolParams, SubagentDetails>({
	input: projectInput,
	result(_params, result) {
		const details = result.details;
		return {
			fields: fields({
				mode: details.mode,
				task_count: details.tasks.length,
				failed_task_count: details.results.filter((item) => item.error !== undefined || item.exitCode !== 0).length,
				attempt_count: sum(details.results.map((item) => item.attempts)),
				duration_ms: sum(details.results.map((item) => item.durationMs)),
				input_tokens: sum(details.results.map((item) => item.usage.input)),
				output_tokens: sum(details.results.map((item) => item.usage.output)),
			}),
		};
	},
});

function projectInput(value: unknown): TelemetryFacts {
	if (!isRecord(value) || !Array.isArray(value["tasks"])) return {};
	const tasks = value["tasks"].filter(isRecord);
	let chars = 0;
	let lines = 0;
	const agents: string[] = [];
	const targets: Resource[] = [];
	for (const task of tasks) {
		const agent = scalar(task["agent"]);
		if (typeof agent === "string") agents.push(agent);
		const cwd = scalar(task["cwd"]);
		if (typeof cwd === "string") targets.push({ kind: "directory", value: cwd });
		const summary = textFields("task", task["task"]);
		chars += typeof summary["task_chars"] === "number" ? summary["task_chars"] : 0;
		lines += typeof summary["task_lines"] === "number" ? summary["task_lines"] : 0;
	}
	return {
		fields: { input_task_count: tasks.length, input_agents: agents, input_task_chars: chars, input_task_lines: lines },
		...(targets.length === 0 ? {} : { targets }),
	};
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}
