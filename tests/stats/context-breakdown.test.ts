import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildContextBreakdown, estimateTokens } from "../../src/stats/context-breakdown.js";
import { SKILL_CONTEXT_MESSAGE } from "../../src/skill-context/types.js";

describe("stats context breakdown", () => {
	it("把 system、tools、project、history、tool output 和 delta 拆成估算项", async () => {
		const branchEntries: SessionEntry[] = [
			entry("1", user("older user message")),
			entry("2", assistantWithTool("read", { path: "src/a.ts" })),
			entry("3", toolResult("read", "tool output text", false)),
			entry("4", user("latest user input")),
		];

		const stats = await buildContextBreakdown({
			usage: { tokens: 1000, contextWindow: 4000, percent: 25 },
			systemPrompt: "<tool_policy>Use tools</tool_policy>\n<subagents>\n- scout: inspect\n</subagents>\nRules",
			systemPromptOptions: {
				cwd: "/repo",
				selectedTools: ["read"],
				toolSnippets: { read: "read files" },
				contextFiles: [{ path: "AGENTS.md", content: "Project rules" }],
			},
			activeTools: ["read"],
			allTools: [toolInfo("read", "Read file contents", { path: { type: "string", description: "File path to read" } })],
			branchEntries,
		});

		expect(stats.confidence).toBe("mixed");
		expect(stats.totalTokens).toBe(1000);
		expect(stats.remainingTokens).toBe(3000);
		expect(stats.items.map((item) => item.id)).toContain("tool_definitions");
		expect(stats.items.map((item) => item.id)).toContain("project_context");
		expect(stats.items.map((item) => item.id)).toContain("conversation_history");
		expect(stats.items.map((item) => item.id)).toContain("tool_outputs");
		expect(stats.items.map((item) => item.id)).toContain("current_user");
		expect(stats.items.at(-1)?.id).toBe("unknown_delta");
		expect(stats.items.every((item) => item.estimated)).toBe(true);
	});

	it("native tool definitions 使用 active ToolInfo，且不从 system prompt 扣减", async () => {
		const systemPrompt = "System prompt mentions available tools by short snippet.";
		const stats = await buildContextBreakdown({
			usage: undefined,
			systemPrompt,
			systemPromptOptions: {
				cwd: "/repo",
				selectedTools: ["read"],
				toolSnippets: { read: "read files" },
			},
			activeTools: ["read"],
			allTools: [
				toolInfo("read", "Read file contents from disk and return structured text chunks", {
					path: { type: "string", description: "Absolute or relative file path" },
					offset: { type: "number", description: "Line offset" },
					limit: { type: "number", description: "Maximum lines to read" },
				}),
			],
			branchEntries: [],
		});

		const system = stats.items.find((item) => item.id === "system");
		const tools = stats.items.find((item) => item.id === "tool_definitions");

		expect(system?.tokens).toBe(await estimateTokens(systemPrompt));
		expect(tools?.note).toBe("1 active tools");
		expect(tools?.tokens).toBeGreaterThan(await estimateTokens("read: read files"));
	});

	it("没有 context usage 时使用估算总量", async () => {
		const stats = await buildContextBreakdown({
			usage: undefined,
			systemPrompt: "system prompt text",
			activeTools: [],
			branchEntries: [entry("1", user("hello world"))],
		});

		expect(stats.confidence).toBe("estimated");
		expect(stats.totalTokens).toBeGreaterThanOrEqual(await estimateTokens("system prompt text"));
		expect(stats.contextWindow).toBeUndefined();
	});

	it("将手动 skill disclosure 单独计入 skills", async () => {
		const stats = await buildContextBreakdown({
			usage: undefined,
			systemPrompt: "system",
			activeTools: [],
			branchEntries: [skillMessage("1", "<invoked_skill root=\"skill://demo\"/>\n\ndemo body"), entry("2", user("first"))],
		});
		const skill = stats.items.find((item) => item.id === "skills");
		expect(skill?.tokens).toBeGreaterThan(0);
		expect(skill?.note).toBe("1 manual disclosures");
	});

	it("conversation history 不重复统计 skill disclosure", async () => {
		const stats = await buildContextBreakdown({
			usage: undefined,
			systemPrompt: "system",
			activeTools: [],
			branchEntries: [skillMessage("1", "skill body"), entry("2", user("hello"))],
		});
		const history = stats.items.find((item) => item.id === "conversation_history");
		expect(history).toBeUndefined();
		expect(stats.items.find((item) => item.id === "current_user")?.tokens).toBeGreaterThan(0);
	});

});

function entry(id: string, message: Message): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-07-05T00:00:00.000Z", message };
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantWithTool(name: string, args: Record<string, unknown>): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: "assistant text" }, { type: "toolCall", id: `${name}-1`, name, arguments: args }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(toolName: string, text: string, isError: boolean): Message {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-1`,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	};
}

function skillMessage(id: string, content: string): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-07-05T00:00:00.000Z",
		customType: SKILL_CONTEXT_MESSAGE,
		content,
		display: true,
	};
}

function toolInfo(name: string, description: string, properties: Record<string, unknown>): ToolInfo {
	return {
		name,
		description,
		parameters: {
			type: "object",
			properties,
			required: Object.keys(properties),
			additionalProperties: false,
		},
		sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
	};
}
