import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	createDefaultBashOperations,
	executeBashCommand,
	loadBashToolConfig,
	type BashExecutionResult,
	type BashParams,
	type BashToolDetails,
} from "../../src/bash-tool/index.js";

const bashParameters = Type.Object({
	command: Type.String({ description: "Shell command to execute exactly as provided." }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds. Defaults to config." })),
});

/** 注册覆盖版 bash；执行后端用 Pi 本地 shell，输出管理由本项目控制。 */
export default function bashTool(pi: ExtensionAPI): void {
	const operations = createDefaultBashOperations();

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute shell commands in the current working directory. Prefer read/grep/find/edit for file work. If output is reduced, read the full log path instead of rerunning.",
		promptSnippet: "Execute shell commands with recoverable bounded output",
		promptGuidelines: [
			"Use bash for commands that require a shell; use read, grep, find, ls, and edit for file operations.",
			"When bash output is truncated or compacted, inspect full_output_path instead of rerunning the command.",
		],
		parameters: bashParameters,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const config = await loadBashToolConfig();
			const runtime = {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				toolCallId,
				operations,
				config,
				...(signal !== undefined ? { signal } : {}),
				...(onUpdate
					? {
							onUpdate: (partial: BashExecutionResult) => {
								onUpdate({ content: [{ type: "text", text: partial.content }], details: partial.details });
							},
						}
					: {}),
			};
			const result = await executeBashCommand(params as BashParams, runtime);
			return { content: [{ type: "text", text: result.content }], details: result.details };
		},
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" || !isBashDetails(event.details)) return undefined;
		if (event.details.status !== "exited" || event.details.exit_code !== 0) {
			return { isError: true };
		}
		return undefined;
	});
}

function isBashDetails(value: ToolResultEvent["details"]): value is BashToolDetails {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		"duration_ms" in value &&
		"output_state" in value &&
		"capture_complete" in value
	);
}
