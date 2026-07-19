import { Ajv, type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";
import fileTools from "../../agent/extensions/file-tools.js";

interface ParameterSchema {
	description?: string;
	properties?: Record<string, ParameterSchema>;
	items?: ParameterSchema;
}

interface RegisteredTool {
	description: string;
	promptSnippet?: string;
	parameters: {
		properties?: Record<string, ParameterSchema>;
	};
	promptGuidelines?: string[];
}

function registeredTools(): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	fileTools({
		registerTool(tool: { name: string } & RegisteredTool) {
			tools.set(tool.name, tool);
		},
		on() {},
	} as never);
	return tools;
}

function validates(schema: AnySchema, value: unknown): boolean {
	const ajv = new Ajv({ strict: false });
	return ajv.compile(schema)(value) === true;
}

describe("file tool schemas", () => {
	it("为文件工具提供最小且正交的工具提示", () => {
		const tools = registeredTools();
		const ls = tools.get("ls");
		const find = tools.get("find");
		const grep = tools.get("grep");
		const read = tools.get("read");
		const write = tools.get("write");
		const edit = tools.get("edit");
		if (ls === undefined || find === undefined || grep === undefined || read === undefined || write === undefined || edit === undefined) {
			throw new Error("missing file tool");
		}

		expect(ls.description).toBe("List direct entries of one directory.");
		expect(ls.promptSnippet).toBe("list one directory");
		expect(ls.parameters.properties?.path?.description).toBe("Directory; default workspace.");
		expect(ls.promptGuidelines).toBeUndefined();

		expect(find.description).toBe("Locate files or directories by name, path, or concept. Does not search contents.");
		expect(find.promptSnippet).toBe("locate files or directories");
		expect(find.parameters.properties?.query?.description).toBe("Name, path fragment, or concept.");
		expect(find.parameters.properties?.glob?.description).toBe("Strict relative path filter for main results.");
		expect(find.promptGuidelines).toBeUndefined();

		expect(grep.description).toBe("Locate code regions by text, symbol, concept, definition, or relationship.");
		expect(grep.promptSnippet).toBe("locate relevant code");
		expect(grep.parameters.properties?.query?.description).toBe("Text, symbol, concept, definition, or relationship.");
		expect(grep.parameters.properties?.match?.description).toBe("Matching strategy. literal: case-sensitive text; regex: regular expression; default auto.");
		expect(grep.parameters.properties?.glob?.description).toBe("Strict relative file-path filter.");
		expect(grep.promptGuidelines).toBeUndefined();

		expect(read.description).toBe("Read one text or image file.");
		expect(read.promptSnippet).toBe("read one file");
		expect(read.parameters.properties?.path?.description).toBe("Text or image path.");
		expect(read.parameters.properties?.start_line?.description).toBe("1-based inclusive start line for text.");
		expect(read.promptGuidelines).toBeUndefined();

		expect(write.description).toBe("Create or overwrite one whole file.");
		expect(write.promptSnippet).toBe("write one whole file");
		expect(write.parameters.properties?.path?.description).toBe("Destination path.");
		expect(write.parameters.properties?.content?.description).toBeUndefined();
		expect(write.promptGuidelines).toBeUndefined();

		expect(edit.description).toBe("Edit one previously read file with exact replacements.");
		expect(edit.promptSnippet).toBe("edit one read file");
		expect(edit.parameters.properties?.path?.description).toBe("Previously read file.");
		expect(edit.parameters.properties?.edits?.description).toBe("Non-overlapping replacements against original content.");
		expect(edit.parameters.properties?.edits?.items?.properties?.old?.description).toBe("Exact text occurring once in original content.");
		expect(edit.parameters.properties?.edits?.items?.properties?.new?.description).toBeUndefined();
		expect(edit.promptGuidelines).toBeUndefined();
	});

	it("使用整数范围、数组长度、必填字段和未知字段限制", () => {
		const tools = registeredTools();
		const ls = tools.get("ls")?.parameters as AnySchema | undefined;
		const find = tools.get("find")?.parameters as AnySchema | undefined;
		const grep = tools.get("grep")?.parameters as AnySchema | undefined;
		const read = tools.get("read")?.parameters as AnySchema | undefined;
		const edit = tools.get("edit")?.parameters as AnySchema | undefined;
		if (ls === undefined || find === undefined || grep === undefined || read === undefined || edit === undefined) throw new Error("missing tool schema");

		expect(validates(ls, {})).toBe(true);
		expect(validates(ls, { path: "src" })).toBe(true);
		expect(validates(ls, { path: "" })).toBe(false);
		expect(validates(ls, { extra: true })).toBe(false);

		expect(validates(find, { query: "auth service" })).toBe(true);
		expect(validates(find, { query: "auth service", path: "src", glob: "**/*.ts" })).toBe(true);
		expect(validates(find, { query: "" })).toBe(false);
		expect(validates(find, { query: "x", glob: "" })).toBe(false);
		expect(validates(find, { pattern: "**/*.ts" })).toBe(false);
		expect(validates(find, { query: "x", mode: "name" })).toBe(false);
		expect(validates(find, { query: "x", limit: 20 })).toBe(false);

		expect(validates(grep, { query: "x" })).toBe(true);
		expect(validates(grep, { query: "x", path: ".", match: "auto", glob: "**/*.ts" })).toBe(true);
		expect(validates(grep, { query: "x", match: "literal" })).toBe(true);
		expect(validates(grep, { query: "x", match: "regex" })).toBe(true);
		expect(validates(grep, { query: "" })).toBe(false);
		expect(validates(grep, { query: "x", match: "content" })).toBe(false);
		expect(validates(grep, { query: "x", mode: "content" })).toBe(false);
		expect(validates(grep, { query: "x", regex: true })).toBe(false);
		expect(validates(grep, { query: "x", context: 1 })).toBe(false);
		expect(validates(grep, { query: "x", limit: 20 })).toBe(false);
		expect(validates(grep, { query: "x", ignore_case: true })).toBe(false);
		expect(validates(grep, { query: "x", extra: true })).toBe(false);

		expect(validates(read, { path: "a.ts", start_line: 1, end_line: 2 })).toBe(true);
		expect(validates(read, { path: "a.ts", start_line: 1.5 })).toBe(false);

		expect(validates(edit, { path: "a.ts", edits: [{ old: "x", new: "y" }] })).toBe(true);
		expect(validates(edit, { path: "a.ts", edits: [] })).toBe(false);
		expect(validates(edit, { path: "a.ts", edits: [{ old: "", new: "y" }] })).toBe(false);
		expect(validates(edit, { path: "a.ts", edits: [{ old: "x", new: "y", extra: true }] })).toBe(false);
	});
});
