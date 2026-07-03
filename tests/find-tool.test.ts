import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkspaceFiles } from "../src/file-tools/find-tool.js";
import type { FindSuccess, ToolOutcome } from "../src/file-tools/types.js";

let workspace: string;
let outside: string;
let previousConfigPath: string | undefined;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-find-"));
	outside = await mkdtemp(path.join(os.tmpdir(), "o-pi-find-outside-"));
	previousConfigPath = process.env.PI_FILE_TOOLS_CONFIG;
	const configPath = path.join(outside, "file-tools.jsonc");
	await writeFile(
		configPath,
		[
			"{",
			'  "version": 1,',
			'  "blocked_path": [".git/"],',
			'  "ignored_path": [],',
			'  "ignore": { "builtin_profile": "none", "gitignore": false }',
			"}",
		].join("\n"),
	);
	process.env.PI_FILE_TOOLS_CONFIG = configPath;
});

afterEach(async () => {
	if (previousConfigPath === undefined) {
		delete process.env.PI_FILE_TOOLS_CONFIG;
	} else {
		process.env.PI_FILE_TOOLS_CONFIG = previousConfigPath;
	}
	await rm(workspace, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

function expectFindSuccess(result: ToolOutcome<FindSuccess>): FindSuccess {
	if ("status" in result) throw new Error(`find failed: ${result.error.code}`);
	return result;
}

describe("find", () => {
	it("默认从 workspace root 查找，并返回 workspace-relative / 路径", async () => {
		await mkdir(path.join(workspace, "src", "nested"), { recursive: true });
		await writeFile(path.join(workspace, "src", "nested", "a.ts"), "");
		await writeFile(path.join(workspace, "root.ts"), "");
		await writeFile(path.join(workspace, "note.txt"), "");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { pattern: "**/*.ts" }));
		expect(result.content).toBe(["2 files", "root.ts", "src/nested/a.ts"].join("\n"));
		expect(result.details).toMatchObject({
			total: 2,
			exactPaths: ["root.ts", "src/nested/a.ts"],
			collapsedGroups: [],
			truncated: false,
		});
	});

	it("支持指定搜索根、*、** 和多扩展名 glob", async () => {
		await mkdir(path.join(workspace, "src", "deep"), { recursive: true });
		await writeFile(path.join(workspace, "src", "a.ts"), "");
		await writeFile(path.join(workspace, "src", "b.tsx"), "");
		await writeFile(path.join(workspace, "src", "deep", "c.ts"), "");
		await writeFile(path.join(workspace, "src", "deep", "d.js"), "");

		expect(expectFindSuccess(await findWorkspaceFiles(workspace, { path: "src", pattern: "*.ts" })).details.exactPaths).toEqual([
			"src/a.ts",
		]);
		expect(expectFindSuccess(await findWorkspaceFiles(workspace, { path: "src", pattern: "**/*.{ts,tsx}" })).details.exactPaths).toEqual([
			"src/a.ts",
			"src/b.tsx",
			"src/deep/c.ts",
		]);
	});

	it("空结果、空 pattern 和越界路径返回稳定结果或错误", async () => {
		await writeFile(path.join(workspace, "a.txt"), "");
		expect(await findWorkspaceFiles(workspace, { pattern: "**/*.ts" })).toMatchObject({
			content: "0 files",
			details: { total: 0 },
		});
		expect(await findWorkspaceFiles(workspace, { pattern: "" })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
		expect(await findWorkspaceFiles(workspace, { path: "..", pattern: "**/*" })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
		expect(await findWorkspaceFiles(workspace, { path: path.relative(workspace, outside), pattern: "**/*" })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_PATH" },
		});
	});

	it("遵守 .piignore 的 search、traverse、反向 include 和 prune 语义", async () => {
		await mkdir(path.join(workspace, "ignored"), { recursive: true });
		await mkdir(path.join(workspace, "pruned"), { recursive: true });
		await writeFile(path.join(workspace, ".piignore"), ["ignored/*", "!ignored/keep.ts", "pruned/"].join("\n"));
		await writeFile(path.join(workspace, "ignored", "drop.ts"), "");
		await writeFile(path.join(workspace, "ignored", "keep.ts"), "");
		await writeFile(path.join(workspace, "pruned", "hidden.ts"), "");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { pattern: "**/*.ts" }));
		expect(result.details.exactPaths).toEqual(["ignored/keep.ts"]);
		expect(result.details.ignoredCount).toBeGreaterThanOrEqual(2);
	});

	it("包含普通 dotfile，但不返回 protected path", async () => {
		await mkdir(path.join(workspace, ".github"), { recursive: true });
		await mkdir(path.join(workspace, ".git"), { recursive: true });
		await writeFile(path.join(workspace, ".env.example"), "");
		await writeFile(path.join(workspace, ".github", "workflow.yml"), "");
		await writeFile(path.join(workspace, ".git", "config"), "");

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { pattern: "**/*" }));
		expect(result.details.exactPaths).toEqual([".env.example", ".github/workflow.yml"]);
		expect(await findWorkspaceFiles(workspace, { path: ".git", pattern: "**/*" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it("不返回文件 symlink，也不进入目录 symlink", async () => {
		await mkdir(path.join(workspace, "real-dir"));
		await writeFile(path.join(workspace, "real-dir", "real.ts"), "");
		await writeFile(path.join(workspace, "target.ts"), "");
		try {
			await symlink(path.join(workspace, "target.ts"), path.join(workspace, "link.ts"), "file");
			await symlink(path.join(workspace, "real-dir"), path.join(workspace, "link-dir"), "dir");
		} catch {
			return;
		}

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { pattern: "**/*.ts" }));
		expect(result.details.exactPaths).toEqual(["target.ts", "real-dir/real.ts"]);
		expect(result.details.exactPaths).not.toContain("link.ts");
		expect(result.details.exactPaths).not.toContain("link-dir/real.ts");
		expect(expectFindSuccess(await findWorkspaceFiles(workspace, { pattern: "link-dir/**/*.ts" })).details.total).toBe(0);
	});

	it("排序稳定，优先 basename 和字面量相关性，再按路径长度与字典序", async () => {
		await mkdir(path.join(workspace, "src", "nested"), { recursive: true });
		await writeFile(path.join(workspace, "src", "nested", "permission-helper.ts"), "");
		await writeFile(path.join(workspace, "src", "other-permission.ts"), "");
		await writeFile(path.join(workspace, "permission.ts"), "");

		const first = await findWorkspaceFiles(workspace, { pattern: "**/*permission*.ts" });
		const second = await findWorkspaceFiles(workspace, { pattern: "**/*permission*.ts" });
		expect(first).toEqual(second);
		expect(expectFindSuccess(first).details.exactPaths).toEqual([
			"permission.ts",
			"src/other-permission.ts",
			"src/nested/permission-helper.ts",
		]);
	});

	it("中等结果按目录分组输出，不再平铺所有路径", async () => {
		await mkdir(path.join(workspace, "agent", "extensions"), { recursive: true });
		await mkdir(path.join(workspace, "src", "file-tools", "ignore"), { recursive: true });
		await mkdir(path.join(workspace, "tests"), { recursive: true });
		for (const filePath of [
			"agent/extensions/file-tools.ts",
			"src/file-tools/config.ts",
			"src/file-tools/find-tool.ts",
			"src/file-tools/ignore/ignore-engine.ts",
			"tests/file-tools.test.ts",
			"tests/find-tool.test.ts",
		]) {
			await writeFile(path.join(workspace, ...filePath.split("/")), "");
		}

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { pattern: "**/*.ts" }));
		expect(result.content).toContain("6 files\n\n");
		expect(result.content).toContain("agent/extensions/\n  file-tools.ts");
		expect(result.content).toContain("src/file-tools/\n  config.ts\n  find-tool.ts");
		expect(result.content).toContain("src/file-tools/ignore/\n  ignore-engine.ts");
		expect(result.content).toContain("tests/\n  file-tools.test.ts\n  find-tool.test.ts");
		expect(result.content).not.toContain("6 files\nagent/extensions/file-tools.ts");
		expect(result.details).toMatchObject({ total: 6, collapsedGroups: [] });
	});

	it("大结果集按预算压缩，并保留不同顶层目录代表", async () => {
		for (const directory of ["a", "b", "c"]) {
			await mkdir(path.join(workspace, directory));
			for (let index = 0; index < 30; index += 1) {
				await writeFile(path.join(workspace, directory, `file-${String(index).padStart(2, "0")}.ts`), "");
			}
		}

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { pattern: "**/*.ts" }));
		const summarized = result.details.collapsedGroups.reduce((sum, group) => sum + group.count, 0);
		expect(result.details.total).toBe(90);
		expect(result.details.exactPaths.length + summarized).toBe(90);
		expect(result.content).toContain("90 files;");
		expect(result.content).toContain("a/");
		expect(result.content).toContain("b/");
		expect(result.content).toContain("c/");
		expect(result.details.collapsedGroups).toEqual([
			{ path: "a", count: 27 },
			{ path: "b", count: 27 },
			{ path: "c", count: 27 },
		]);
	});

	it("从 file-tools.jsonc 解析 find 预算配置", async () => {
		const configPath = path.join(outside, "find-limits.jsonc");
		await writeFile(
			configPath,
			[
				"{",
				'  "version": 1,',
				'  "ignore": { "builtin_profile": "none", "gitignore": false },',
				'  "limits": {',
				'    "find_output_token_budget": 100,',
				'    "find_flat_result_limit": 1,',
				'    "find_grouped_result_limit": 2,',
				'    "find_max_matches_scanned": 5,',
				'    "find_max_exact_paths": 2',
				"  }",
				"}",
			].join("\n"),
		);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await mkdir(path.join(workspace, "many"));
		for (let index = 0; index < 10; index += 1) {
			await writeFile(path.join(workspace, "many", `file-${String(index).padStart(2, "0")}.ts`), "");
		}

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { pattern: "**/*.ts" }));
		const summarized = result.details.collapsedGroups.reduce((sum, group) => sum + group.count, 0);
		expect(result.details.total).toBe(5);
		expect(result.details.exactPaths).toHaveLength(2);
		expect(result.details.exactPaths.length + summarized).toBe(5);
		expect(result.details.truncated).toBe(true);
	});

	it("从 file-tools.jsonc 解析 find 条数边界配置", async () => {
		const configPath = path.join(outside, "find-render-limits.jsonc");
		await writeFile(
			configPath,
			[
				"{",
				'  "version": 1,',
				'  "ignore": { "builtin_profile": "none", "gitignore": false },',
				'  "limits": {',
				'    "find_flat_result_limit": 6,',
				'    "find_grouped_result_limit": 6',
				"  }",
				"}",
			].join("\n"),
		);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await mkdir(path.join(workspace, "src"));
		for (let index = 0; index < 6; index += 1) {
			await writeFile(path.join(workspace, "src", `file-${index}.ts`), "");
		}

		const result = expectFindSuccess(await findWorkspaceFiles(workspace, { pattern: "**/*.ts" }));
		expect(result.content).toContain("6 files\nsrc/file-0.ts");
		expect(result.content).not.toContain("src/\n  file-0.ts");
	});

	it("支持取消信号", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await findWorkspaceFiles(workspace, { pattern: "**/*" }, controller.signal)).toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});
	});
});
