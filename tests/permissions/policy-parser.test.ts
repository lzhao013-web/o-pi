import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadPolicy, permissionsSchema } from "../../src/permissions/policy.js";
import { tempEnv, type TempEnv } from "./helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("policy parser", () => {
	it("接受 JSONC 注释、尾逗号和字符串中的注释样文本", async () => {
		const file = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(file, '{\n// c\n"version":1,\n"files":{"roots":[{"path":"${workspace}","access":"read-write",}], "rules":{"ask":[{"paths":["//x/*", "literal ,}"],"access":["read"]}]}}\n}\n');
		await expect(loadPolicy("global", file)).resolves.toMatchObject({ status: "loaded" });
	});

	it("拒绝未知字段并保留 JSON Pointer", async () => {
		const file = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(file, '{ "version": 1, "files": { "outsideRoot": {} } }');
		const result = await loadPolicy("global", file);
		expect(result.status).toBe("invalid");
		expect(result.diagnostics[0]).toMatchObject({ pointer: "/files", message: 'Unknown property "outsideRoot".' });
	});

	it("拒绝重复规则 id", async () => {
		const file = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(file, JSON.stringify({ version: 1, files: { rules: { deny: [{ id: "a", paths: ["x"], access: ["read"] }], ask: [{ id: "a", paths: ["y"], access: ["read"] }] } } }));
		const result = await loadPolicy("global", file);
		expect(result.status).toBe("invalid");
		expect(result.diagnostics.some((item) => item.message.includes("Duplicate rule id"))).toBe(true);
	});

	it("磁盘 schema 与运行时 schema 使用同一导出", async () => {
		await mkdir(env.agentDir, { recursive: true });
		const file = path.join(env.agentDir, "permissions.schema.json");
		await writeFile(file, `${JSON.stringify(permissionsSchema, null, "\t")}\n`);
		const loaded = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"))) as unknown;
		expect(loaded).toEqual(permissionsSchema);
	});
});
