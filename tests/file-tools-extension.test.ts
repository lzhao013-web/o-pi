import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import fileTools from "../agent/extensions/file-tools.js";

interface ThemeStub {
	fg(name: string, text: string): string;
	bold(text: string): string;
}

const theme: ThemeStub = {
	fg(_name: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

interface Renderable {
	render(width: number): string[];
}

type ToolResultHandler = (event: { toolName: string; details: unknown }) => unknown;
type RenderResult = (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: ThemeStub, context: unknown) => Renderable;

describe("file-tools extension", () => {
	it("文件工具失败结果标记为错误，并按失败分支渲染", () => {
		const registered: Array<{ name: string; renderResult?: RenderResult }> = [];
		const handlers = new Map<string, ToolResultHandler>();
		fileTools({
			registerTool(tool: { name: string; renderResult?: RenderResult }) {
				registered.push(tool);
			},
			on(name: string, handler: ToolResultHandler) {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI);

		const failure = {
			status: "failed" as const,
			error: { code: "INVALID_PATH", message: "path must be workspace-relative.", path: "C:/Users/orion/.pi" },
		};
		expect(handlers.get("tool_result")?.({ toolName: "find", details: failure })).toEqual({ isError: true });
		expect(handlers.get("tool_result")?.({ toolName: "find", details: { total: 0 } })).toBeUndefined();

		for (const toolName of ["ls", "find", "grep", "read"]) {
			const output = renderToolResult(registered, toolName, failure);
			expect(output).toContain("INVALID_PATH: path must be workspace-relative.");
			expect(output).not.toContain('"status": "failed"');
		}
	});
});

function renderToolResult(registered: Array<{ name: string; renderResult?: RenderResult }>, toolName: string, details: unknown): string {
	const tool = registered.find((item) => item.name === toolName);
	const component = tool?.renderResult?.(
		{ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details },
		{ expanded: false, isPartial: false },
		theme,
		{ cwd: "C:/Users/orion/.pi" },
	);
	return component?.render(120).join("\n") ?? "";
}
