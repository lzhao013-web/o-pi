import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	executeSubagent,
	formatModelReference,
	registerSubagentCommands,
	renderSubagentCall,
	renderSubagentResult,
	type SubagentToolParams,
} from "../../src/subagent/index.js";
import { repairableTool } from "../../src/tool-repair/index.js";

const taskItem = Type.Object({
	agent: Type.String({ minLength: 1, description: "Agent name." }),
	task: Type.String({ minLength: 1, description: "Task text. Use {previous} to insert the preceding result and run tasks sequentially." }),
	cwd: Type.Optional(Type.String({ description: "Workspace-relative working directory; defaults to the workspace." })),
}, { additionalProperties: false });

const subagentParams = Type.Object(
	{
		tasks: Type.Array(taskItem, { minItems: 1, description: "Agent tasks." }),
	},
	{ additionalProperties: false },
);

/** 注册轻量 subagent 工具和确定性命令；核心逻辑在 src/subagent。 */
export default function subagentExtension(pi: ExtensionAPI): void {
	registerSubagentCommands(pi);
	pi.registerTool(repairableTool({
		name: "subagent",
		label: "subagent",
		description: "Delegate one or more bounded tasks to isolated agents.",
		promptSnippet: "delegate bounded isolated work",
		parameters: subagentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeSubagent(params as SubagentToolParams, {
				cwd: ctx.cwd,
				hasUI: ctx.hasUI,
				currentModel: formatModelReference(ctx.model),
				registeredTools: pi.getAllTools().map((tool) => tool.name),
				...(signal !== undefined ? { signal } : {}),
				...(ctx.hasUI ? { confirm: (title: string, message: string) => ctx.ui.confirm(title, message) } : {}),
				...(onUpdate !== undefined ? { onUpdate } : {}),
			});
		},
		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,
	}, {
		pathFields: ["tasks.*.cwd"],
	}));
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return undefined;
		const details = event.details;
		if (!isSubagentDetails(details)) return undefined;
		return details.results.some((result) => result.error !== undefined) ? { isError: true } : undefined;
	});
}

function isSubagentDetails(value: unknown): value is { results: Array<{ error?: string }> } {
	return typeof value === "object" && value !== null && Array.isArray((value as { results?: unknown }).results);
}
