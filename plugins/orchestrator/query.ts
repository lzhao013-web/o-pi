import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { EvaluationError, matchesCondition, resolveArguments, type ItemScope } from "./plan.ts";
import type { SettledCall } from "./progress.ts";
import type { Call, Step } from "./schema.ts";

export interface QueryContext {
	readonly tools: readonly { name: string }[];
	executeTool: ExtensionToolContext["executeTool"];
}

export async function query(
	call: Call, results: ReadonlyMap<string, Step>, ctx: QueryContext, signal: AbortSignal,
	onStart: (args: Record<string, unknown>) => void, item?: ItemScope,
): Promise<SettledCall> {
	const base = { id: call.id, tool: call.tool };
	try {
		if (call.when !== undefined && !matchesCondition(call.when, results)) {
			return { ...base, status: "skipped", reason: "condition_false" };
		}
		const args = resolveArguments(call, results, item);
		onStart(structuredClone(args));
		const start = performance.now();
		const outcome = await ctx.executeTool(call.tool, args, { signal });
		const invocation = { args: outcome.toolCall.arguments, durationMs: Math.round(performance.now() - start) };
		const content = outcome.result.content;
		const text = content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
		if (outcome.isError) return { ...base, status: "error", error: { code: "tool_error", message: text }, invocation };
		const structured = outcome.result.structuredContent;
		if (content.some((part) => part.type === "image") || (call.tool === "read" && structured !== undefined && typeof structured !== "string")) {
			return { ...base, status: "error", error: { code: "unsupported_result", message: "Only text read results are supported." }, invocation };
		}
		const data: JsonValue = structured === undefined ? text : structured;
		return { ...base, status: "ok", data, invocation };
	} catch (error) {
		if (!(error instanceof EvaluationError)) throw error;
		return { ...base, status: "error", error: { code: error.code, message: error.message } };
	}
}
