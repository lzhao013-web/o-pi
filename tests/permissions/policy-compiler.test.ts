import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempEnv, type TempEnv } from "./helpers.js";
import { PermissionService } from "../../src/permissions/permission-service.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("policy compiler", () => {
	it("项目策略拒绝 profile、roots、outsideRoots 和 allow", async () => {
		const projectPath = path.join(env.workspace, ".pi", "permissions.jsonc");
		await mkdir(path.dirname(projectPath), { recursive: true });
		await writeFile(projectPath, JSON.stringify({ version: 1, profile: "unrestricted", files: { roots: [], outsideRoots: { read: "allow" }, rules: { allow: [{ paths: ["x"], access: ["read"] }] } } }));
		const service = new PermissionService({ workspaceRoot: env.workspace, agentDir: env.agentDir, projectTrusted: true, projectPolicyPath: projectPath });
		const status = await service.status();
		expect(status.projectPolicy.status).toBe("invalid");
		expect(status.projectPolicy.diagnostics.map((item) => item.pointer)).toEqual(expect.arrayContaining(["/profile", "/files/roots", "/files/outsideRoots", "/files/rules/allow"]));
	});

	it("未知路径变量导致 fail closed", async () => {
		const globalPath = path.join(env.agentDir, "permissions.jsonc");
		await writeFile(globalPath, JSON.stringify({ version: 1, files: { roots: [{ path: "${bad}", access: "read-write" }] } }));
		const service = new PermissionService({ workspaceRoot: env.workspace, agentDir: env.agentDir, projectTrusted: false, globalPolicyPath: globalPath });
		const result = await service.authorizeToolCall({ toolCallId: "read", toolName: "read", normalizedToolInput: { path: "." }, promptContext: { hasUI: false, timeoutMs: 1, prompt: async () => ({ decision: "deny" }) } });
		expect(result).toMatchObject({ allowed: false, error: { code: "PERMISSION_POLICY_INVALID" } });
	});
});
