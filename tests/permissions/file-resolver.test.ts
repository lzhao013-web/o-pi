import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileResolver } from "../../src/permissions/file-resolver.js";
import { isPathInside } from "../../src/permissions/path-utils.js";
import { tempEnv, type TempEnv } from "./helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("file resolver", () => {
	it("/root/a 不匹配 /root/abc", () => {
		expect(isPathInside(path.join(env.workspace, "a"), path.join(env.workspace, "abc"))).toBe(false);
	});

	it("目录 symlink 保留 lexicalType 并将 targetType 解析为 directory", async () => {
		const target = path.join(env.outside, "target");
		await mkdir(target);
		await symlink(target, path.join(env.workspace, "link"), "dir");
		const resolved = await new FileResolver({ workspaceRoot: env.workspace, agentDir: env.agentDir }).resolve("link", "file.list", "read");
		expect(resolved).toMatchObject({ lexicalType: "symlink", targetType: "directory", viaSymlink: true, canonicalPath: target });
	});

	it("不存在目标记录 canonical parent identity", async () => {
		const resolved = await new FileResolver({ workspaceRoot: env.workspace, agentDir: env.agentDir }).resolve("new/child.txt", "file.create", "write");
		expect(resolved.exists).toBe(false);
		expect(resolved.canonicalParentPath).toBe(env.workspace);
		expect(resolved.canonicalParentIdentity).toBeDefined();
	});

	it("文件 symlink 指向 root 外不会因 lexical 在 workspace 内自动允许", async () => {
		const outsideFile = path.join(env.outside, "secret.txt");
		await writeFile(outsideFile, "x");
		await symlink(outsideFile, path.join(env.workspace, "link.txt"), "file");
		const resolved = await new FileResolver({ workspaceRoot: env.workspace, agentDir: env.agentDir }).resolve("link.txt", "file.read", "read");
		expect(resolved.canonicalPath).toBe(outsideFile);
		expect(resolved.viaSymlink).toBe(true);
	});
});
