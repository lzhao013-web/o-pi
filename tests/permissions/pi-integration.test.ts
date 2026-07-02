import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

import permissions from "../../agent/extensions/permissions.js";
import { tempEnv, type TempEnv } from "./helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("pi integration", () => {
	it("tool_call handler blocks unknown outside-root ask when no UI", async () => {
		const handlers = new Map<string, Function>();
		const api: ExtensionAPI = {
			on: ((event: string, handler: Function) => {
				handlers.set(event, handler);
			}) as ExtensionAPI["on"],
			registerTool() {},
			registerCommand() {},
			registerShortcut() {},
			registerFlag() {},
			getFlag: () => undefined,
			registerMessageRenderer() {},
			sendMessage() {},
			sendUserMessage() {},
			appendEntry() {},
			setSessionName() {},
			getSessionName: () => undefined,
			setLabel() {},
			exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools() {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => "medium",
			setThinkingLevel() {},
			registerProvider() {},
			unregisterProvider() {},
			events: {} as ExtensionAPI["events"],
		};
		permissions(api);
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const handler = handlers.get("tool_call");
		if (handler === undefined) throw new Error("tool_call not registered");
		const result = (await handler(
			{ type: "tool_call", toolName: "read", toolCallId: "r", input: { path: file } },
			{
				cwd: env.workspace,
				hasUI: false,
				signal: undefined,
				isProjectTrusted: () => false,
				sessionManager: { getSessionFile: () => "s1" },
				ui: { select: async () => undefined, notify() {}, setStatus() {} },
			},
		)) as ToolCallEventResult;
		expect(result).toMatchObject({ block: true });
	});
});
