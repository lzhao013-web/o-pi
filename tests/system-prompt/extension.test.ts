import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { preserveEnv } from "../helpers/lifecycle.js";

import {
	buildRuntimeSystemPrompt,
	buildSubagentSystemPrompt,
	buildSystemPrompt,
	registerSystemCommand,
} from "../../agent/extensions/system-prompt.js";

preserveEnv("PI_SUBAGENT_CHILD");

describe("system prompt extension", () => {
	it("各类 prompt 输入均可完成构建，但不把生成文案作为测试契约", async () => {
		const base: BuildSystemPromptOptions = {
			cwd: "/repo",
			selectedTools: ["read", "bash"],
			toolSnippets: { read: "read files", bash: "run commands" },
			promptGuidelines: ["Prefer direct tools."],
			contextFiles: [{ path: "AGENTS.md", content: "Project rule." }],
			appendSystemPrompt: "Append this.",
		};

		expect(buildSystemPrompt(base)).toEqual(expect.any(String));
		expect(buildSystemPrompt({ ...base, customPrompt: "Custom role." })).toEqual(expect.any(String));
		expect(buildSubagentSystemPrompt({
			...base,
			customPrompt: "---\nname: scout\ndescription: Inspect code\ntools: read, grep\n---\nReturn evidence.",
		})).toEqual(expect.any(String));
		await expect(buildRuntimeSystemPrompt(base, "/repo")).resolves.toEqual(expect.any(String));

		process.env.PI_SUBAGENT_CHILD = "1";
		await expect(buildRuntimeSystemPrompt({ ...base, customPrompt: "---\nname: scout\ndescription: Inspect code\n---\nBody." }, "/repo"))
			.resolves.toEqual(expect.any(String));
	});

	it("子进程缺少 Agent Markdown 时拒绝启动", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		await expect(buildRuntimeSystemPrompt({ cwd: "/repo" }, "/repo")).rejects.toThrow("Subagent Agent Markdown is required");
	});

	it("/system 只通过只读浮层展示，不写入消息或编辑器", async () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let commandOptions: CommandOptions | undefined;
		let customCalled = false;
		let writeCalled = false;

		registerSystemCommand({
			registerCommand(_name, options) {
				commandOptions = options;
			},
		});

		await commandOptions?.handler("", {
			mode: "tui",
			hasUI: true,
			getSystemPromptOptions: () => ({ cwd: "/repo", selectedTools: ["read"] }),
			ui: {
				select: async () => undefined,
				editor: async () => {
					writeCalled = true;
					return undefined;
				},
				setEditorText: () => {
					writeCalled = true;
				},
				custom: async (factory: (tui: never, theme: never, keybindings: never, done: (result: void) => void) => unknown) => {
					customCalled = true;
					const viewer = factory(
						{ terminal: { rows: 30 } } as never,
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
						{} as never,
						() => undefined,
					) as { render(width: number): string[]; handleInput(data: string): void };
					expect(viewer.render(80)).toEqual(expect.any(Array));
					viewer.handleInput("q");
					return undefined;
				},
			},
			sendMessage: () => {
				writeCalled = true;
			},
		} as never);

		expect(customCalled).toBe(true);
		expect(writeCalled).toBe(false);
	});
});
