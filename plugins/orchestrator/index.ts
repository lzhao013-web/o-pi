import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { executePlan } from "./execute.ts";
import { outputSchema, parameters } from "./schema.ts";
import type { ExecutionView } from "./progress.ts";

const tool: ToolDefinition<typeof parameters, ExecutionView> = {
	name: "orchestrate",
	label: "orchestrate",
	description: "Run read-only query workflows with result references, conditions, and bounded map. Example: find files, then read up to N matches in the same call. Returns ordered step results. read supports text only. Errors stop new calls, not running calls. Condition skips are not errors.",
	promptSnippet: "chain queries and map their results",
	parameters,
	outputSchema,
	exposure: "model-only",
	annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
	async execute(_toolCallId, plan, signal, onUpdate, ctx) {
		const { result, details } = await executePlan(plan, ctx, signal, (progress) => onUpdate?.({ content: [], details: progress }));
		return {
			content: [{ type: "text", text: JSON.stringify(result) }],
			details,
			structuredContent: result,
			isError: result.status !== "completed",
		};
	},
};

export default function orchestrator(pi: ExtensionAPI): void {
	pi.registerTool(tool);
}
