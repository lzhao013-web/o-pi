import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import { tempEnv, service, prompt, type TempEnv } from "./helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("hard protections", () => {
	it("Pi auth 文件不可读且不可审批覆盖", async () => {
		await mkdir(env.agentDir, { recursive: true });
		await writeFile(path.join(env.agentDir, "auth.json"), "{\"token\":\"secret\"}\n");
		await expect(readWorkspaceFile(env.workspace, { path: path.join(env.agentDir, "auth.json") }, { permissionService: service(env), toolCallId: "r", promptContext: prompt("allow-once") })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_HARD_DENIED" } });
	});

	it("权限状态目录不可通过文件工具读取", async () => {
		const grants = path.join(env.agentDir, "permission-state", "grants.json");
		await mkdir(path.dirname(grants), { recursive: true });
		await writeFile(grants, "[]\n");
		await expect(readWorkspaceFile(env.workspace, { path: grants }, { permissionService: service(env), toolCallId: "r", promptContext: prompt("allow-once") })).resolves.toMatchObject({ status: "failed", error: { code: "PERMISSION_HARD_DENIED" } });
	});
});
