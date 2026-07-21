import { describe, expect, it } from "vitest";
import { parseSkillFile } from "../../src/skill-context/frontmatter.js";

describe("skill frontmatter", () => {
	it("解析 name、description 和去 frontmatter 后的 body", () => {
		const parsed = parseSkillFile("---\nname: demo\ndescription: 用于测试\n---\n\nbody\n", "fallback");
		expect(parsed).toEqual({ name: "demo", description: "用于测试", body: "body", disableModelInvocation: true });
	});

	it.each([
		["missing", "", true],
		["boolean true", "disable-model-invocation: true\n", true],
		["boolean false", "disable-model-invocation: false\n", false],
		["quoted false", "disable-model-invocation: 'false'\n", true],
		["number zero", "disable-model-invocation: 0\n", true],
	] as const)("disable-model-invocation 默认禁用且只有显式 false 开放: %s", (_label, field, expected) => {
		const parsed = parseSkillFile(`---\nname: demo\ndescription: desc\n${field}---\nbody\n`, "fallback");
		expect(parsed.disableModelInvocation).toBe(expected);
	});

	it("支持 CRLF", () => {
		const parsed = parseSkillFile("---\r\nname: demo\r\ndescription: desc\r\n---\r\nbody\r\nnext\r\n", "fallback");
		expect(parsed.body).toBe("body\nnext");
	});

	it("复用 Pi YAML frontmatter 解析 quoted value", () => {
		const parsed = parseSkillFile('---\nname: demo\ndescription: "use when value contains: colon"\n---\nbody\n', "fallback");
		expect(parsed.description).toBe("use when value contains: colon");
	});

	it.each([
		["非法 YAML", "---\nname: [demo\n---\nbody\n", /failed to parse skill frontmatter/],
		["缺少 description", "---\nname: demo\n---\nbody\n", /description/],
		["非法 name", "---\nname: Bad--Name\ndescription: desc\n---\nbody\n", /name/],
	] as const)("拒绝%s", (_name, source, error) => {
		expect(() => parseSkillFile(source, "fallback")).toThrow(error);
	});
});
