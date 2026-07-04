import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import webTools from "../agent/extensions/web-tools.js";
import { buildSystemPrompt } from "../agent/extensions/system-prompt.js";

describe("web-tools extension", () => {
	it("注册 webfetch 工具、schema 和简短提示", async () => {
		const registered: unknown[] = [];
		const handlers = new Map<string, Function>();
		const pi = {
			registerTool(tool: unknown) {
				registered.push(tool);
			},
			on(name: string, handler: Function) {
				handlers.set(name, handler);
			},
		};
		webTools(pi as unknown as ExtensionAPI);
		const tool = registered[0] as {
			name: string;
			parameters: { properties: Record<string, unknown> };
			promptSnippet: string;
			promptGuidelines: string[];
		};
		expect(tool.name).toBe("webfetch");
		expect(Object.keys(tool.parameters.properties)).toEqual(["url", "mode", "offset", "limit"]);
		expect(tool.promptSnippet).toContain("known HTTP(S) URL");
		expect(new Set(tool.promptGuidelines).size).toBe(tool.promptGuidelines.length);

		const eventResult = handlers.get("tool_result")?.({
			toolName: "webfetch",
			details: { status: "failed", error: { code: "INVALID_URL", message: "bad" } },
		});
		expect(eventResult).toEqual({ isError: true });
		await handlers.get("session_shutdown")?.({});
	});

	it("system prompt fallback 包含 webfetch", () => {
		const prompt = buildSystemPrompt({
			cwd: "C:\\repo",
			toolSnippets: {
				ls: "List",
				read: "Read",
				find: "Find",
				grep: "Grep",
				webfetch: "Fetch",
				bash: "Bash",
				edit: "Edit",
			},
		});
		expect(prompt).toContain("- webfetch: Fetch");
	});
});
