import { Ajv, type AnySchema } from "ajv";
import { describe, expect, it } from "vitest";
import subagentExtension from "../agent/extensions/subagent.js";

function subagentSchema(): AnySchema {
	let registered: unknown;
	subagentExtension({
		registerTool(tool: unknown) {
			registered = tool;
		},
		registerCommand() {},
		on() {},
	} as never);
	return (registered as { parameters: AnySchema }).parameters;
}

function validateParams(value: unknown): boolean {
	const ajv = new Ajv({ strict: false });
	return ajv.compile(subagentSchema())(value) === true;
}

describe("subagent tool schema", () => {
	it("使用 mode 判别 single、parallel 和 chain", () => {
		expect(validateParams({ mode: "single", agent: "scout", task: "inspect" })).toBe(true);
		expect(validateParams({ mode: "parallel", tasks: [{ agent: "scout", task: "inspect" }], outputMode: "file" })).toBe(true);
		expect(validateParams({ mode: "chain", tasks: [{ agent: "scout", task: "inspect" }], outputMode: "inline" })).toBe(true);
	});

	it("拒绝混合模式字段、未知字段和空任务数组", () => {
		expect(validateParams({ mode: "single", agent: "scout", task: "inspect", tasks: [{ agent: "reviewer", task: "review" }] })).toBe(false);
		expect(validateParams({ mode: "parallel", agent: "scout", task: "inspect", tasks: [{ agent: "reviewer", task: "review" }] })).toBe(false);
		expect(validateParams({ mode: "chain", tasks: [] })).toBe(false);
		expect(validateParams({ mode: "parallel", tasks: [{ agent: "scout", task: "inspect", extra: true }] })).toBe(false);
		expect(validateParams({ mode: "single", agent: "scout" })).toBe(false);
	});

	it("不暴露运行时安全、并发或重试配置", () => {
		const schemaText = JSON.stringify(subagentSchema());
		expect(schemaText).not.toContain("agentScope");
		expect(schemaText).not.toContain("allowProjectAgents");
		expect(schemaText).not.toContain("maxConcurrency");
		expect(schemaText).not.toContain("retries");
	});
});
