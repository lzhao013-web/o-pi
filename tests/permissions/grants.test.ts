import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readWorkspaceFile } from "../../src/file-tools/read-tool.js";
import { tempEnv, service, prompt, noUi, type TempEnv } from "./helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("grants", () => {
	it("allow once 只产生 lease，不进入 session grant", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const svc = service(env);
		await expect(readWorkspaceFile(env.workspace, { path: file }, { permissionService: svc, toolCallId: "r1", promptContext: prompt("allow-once") })).resolves.toMatchObject({ content: "a\n" });
		expect(svc.getSessionGrants().count()).toBe(0);
		await expect(readWorkspaceFile(env.workspace, { path: file }, { permissionService: svc, toolCallId: "r2", promptContext: noUi() })).resolves.toMatchObject({ status: "failed" });
	});

	it("session subtree grant 覆盖 child 但不覆盖 sibling root", async () => {
		const dir = path.join(env.outside, "dir");
		await import("node:fs/promises").then((fs) => fs.mkdir(dir));
		await writeFile(path.join(dir, "a.txt"), "a\n");
		await writeFile(path.join(env.outside, "b.txt"), "b\n");
		const svc = service(env);
		await readWorkspaceFile(env.workspace, { path: path.join(dir, "a.txt") }, { permissionService: svc, toolCallId: "r1", promptContext: prompt("allow-session-subtree") });
		await expect(readWorkspaceFile(env.workspace, { path: path.join(dir, "a.txt") }, { permissionService: svc, toolCallId: "r2", promptContext: noUi() })).resolves.toMatchObject({ content: "a\n" });
		await expect(readWorkspaceFile(env.workspace, { path: path.join(env.outside, "b.txt") }, { permissionService: svc, toolCallId: "r3", promptContext: noUi() })).resolves.toMatchObject({ status: "failed" });
	});
});
