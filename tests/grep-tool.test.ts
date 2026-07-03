import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatCompactGrepResult, grepWorkspaceFiles } from "../src/file-tools/grep-tool.js";
import type { GrepSuccess, ToolOutcome } from "../src/file-tools/types.js";

let workspace: string;
let outside: string;
let previousConfigPath: string | undefined;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-grep-"));
	outside = await mkdtemp(path.join(os.tmpdir(), "o-pi-grep-outside-"));
	previousConfigPath = process.env.PI_FILE_TOOLS_CONFIG;
	const configPath = path.join(outside, "file-tools.jsonc");
	await writeFile(
		configPath,
		[
			"{",
			'  "version": 1,',
			'  "blocked_path": [".git/"],',
			'  "ignored_path": [],',
			'  "ignore": { "builtin_profile": "none", "gitignore": false },',
			'  "limits": {',
			'    "grep_matching_lines": 40,',
			'    "grep_max_matching_lines": 200,',
			'    "grep_model_output_chars": 8000,',
			'    "grep_snippet_chars": 80,',
			'    "grep_context_lines": 3,',
			'    "grep_max_file_bytes": 1024,',
			'    "grep_max_files_scanned": 100000',
			"  }",
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

function expectGrepSuccess(result: ToolOutcome<GrepSuccess>): GrepSuccess {
	if ("status" in result) throw new Error(`grep failed: ${result.error.code}: ${result.error.message}`);
	return result;
}

describe("grep", () => {
	it("默认执行字面量搜索，不要求调用方转义正则字符", async () => {
		await writeFile(path.join(workspace, "a.ts"), "createSnapshot(root)\ncreateSnapshot.create\n");
		await writeFile(path.join(workspace, "b.ts"), "createSnapshot(root)\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "createSnapshot(" }));

		expect(result).toMatchObject({
			total_files: 2,
			total_matching_lines: 2,
			total_occurrences: 2,
			scan_complete: true,
			output_truncated: false,
		});
		expect(result.files?.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
		expect(formatCompactGrepResult(result)).toContain("a.ts [1 lines, 1 occurrences]");
		expect(formatCompactGrepResult(result)).toContain("1: createSnapshot(root)");
	});

	it("支持正则搜索，并把无效正则返回为明确错误", async () => {
		await writeFile(path.join(workspace, "a.ts"), "user_12\nuser_x\n");
		expect(expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "user_\\d+", regex: true })).total_occurrences).toBe(1);
		expect(await grepWorkspaceFiles(workspace, { path: ".", query: "(", regex: true })).toMatchObject({
			status: "failed",
			error: { code: "INVALID_REGEX" },
		});
	});

	it("区分大小写，并支持 ignore_case", async () => {
		await writeFile(path.join(workspace, "a.txt"), "Token\ntoken\n");
		expect(expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "token" })).total_occurrences).toBe(1);
		expect(expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "token", ignore_case: true })).total_occurrences).toBe(2);
	});

	it("支持单文件、目录递归、glob、content/files/count 三种模式", async () => {
		await mkdir(path.join(workspace, "src"));
		await writeFile(path.join(workspace, "src", "a.ts"), "needle\n");
		await writeFile(path.join(workspace, "src", "b.js"), "needle\n");
		await writeFile(path.join(workspace, "src", "c.ts"), "other\n");

		expect(expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: "src/a.ts", query: "needle" })).files?.[0]?.path).toBe("src/a.ts");
		expect(expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: "src", query: "needle" })).total_files).toBe(2);
		expect(expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: "src", query: "needle", glob: "*.ts" })).files?.map((file) => file.path)).toEqual([
			"src/a.ts",
		]);

		const files = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: "src", query: "needle", mode: "files" }));
		expect(files.files?.[0]).toMatchObject({ path: "src/a.ts", total_matching_lines: 1, lines: [] });
		expect(formatCompactGrepResult(files)).toContain("src/a.ts  1 lines / 1 occurrences");

		const count = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: "src", query: "needle", mode: "count" }));
		expect(count.files).toBeUndefined();
		expect(formatCompactGrepResult(count)).toBe("2 occurrences / 2 lines / 2 files");
	});

	it("同一行多个 occurrence 只占一条匹配行，并用乘号展示次数", async () => {
		await writeFile(path.join(workspace, "a.txt"), "needle needle needle\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "needle" }));
		expect(result).toMatchObject({ total_matching_lines: 1, total_occurrences: 3 });
		expect(result.files?.[0]?.lines[0]).toMatchObject({ line: 1, occurrences: 3 });
		expect(formatCompactGrepResult(result)).toContain("1×3: needle needle needle");
	});

	it("按文件聚合并平衡采样，避免单个高频文件占满 limit", async () => {
		await writeFile(path.join(workspace, "a.txt"), Array.from({ length: 10 }, (_, index) => `needle a${index}`).join("\n"));
		await writeFile(path.join(workspace, "b.txt"), "needle b0\nneedle b1\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "needle", limit: 3 }));
		expect(result.files?.map((file) => [file.path, file.lines.map((line) => line.line)])).toEqual([
			["a.txt", [1, 2]],
			["b.txt", [1]],
		]);
		expect(result.files?.[0]?.omitted_lines).toBe(8);
		expect(result.output_truncated).toBe(true);
	});

	it("超长行围绕匹配位置中心裁剪，且模型输出受字符硬上限约束", async () => {
		const long = `${"a".repeat(200)} needle ${"b".repeat(200)}\n`;
		await writeFile(path.join(workspace, "a.txt"), long);
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "needle" }));
		const line = result.files?.[0]?.lines[0];
		expect(line?.text).toContain("needle");
		expect(line?.text.startsWith("...")).toBe(true);
		expect(line?.text.endsWith("...")).toBe(true);

		const output = formatCompactGrepResult(result, 120);
		expect(output.length).toBeLessThanOrEqual(120);
		expect(output).toContain("[output truncated]");
	});

	it("扫描完成但输出截断时保留精确总计数", async () => {
		await writeFile(path.join(workspace, "a.txt"), "needle\nneedle\nneedle\n");
		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "needle", limit: 1 }));
		expect(result).toMatchObject({
			total_matching_lines: 3,
			returned_lines: 1,
			scan_complete: true,
			output_truncated: true,
		});
		expect(formatCompactGrepResult(result)).toContain("3 lines / 3 occurrences in 1 files; showing 1 lines");
	});

	it("扫描未完成时使用下界语义，不伪装成完整结果", async () => {
		const configPath = path.join(outside, "scan-limit.jsonc");
		await writeFile(
			configPath,
			[
				"{",
				'  "version": 1,',
				'  "ignore": { "builtin_profile": "none", "gitignore": false },',
				'  "limits": { "grep_max_files_scanned": 1 }',
				"}",
			].join("\n"),
		);
		process.env.PI_FILE_TOOLS_CONFIG = configPath;
		await writeFile(path.join(workspace, "a.txt"), "needle\n");
		await writeFile(path.join(workspace, "b.txt"), "needle\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "needle" }));
		expect(result.scan_complete).toBe(false);
		expect(formatCompactGrepResult(result)).toContain(">=1 matching lines in >=1 files; scan incomplete");
	});

	it("遵守 ignore 的 search、traverse、prune 和反向 include 语义", async () => {
		await mkdir(path.join(workspace, "ignored"));
		await mkdir(path.join(workspace, "pruned"));
		await writeFile(path.join(workspace, ".piignore"), ["ignored/*", "!ignored/keep.txt", "pruned/"].join("\n"));
		await writeFile(path.join(workspace, "ignored", "drop.txt"), "needle\n");
		await writeFile(path.join(workspace, "ignored", "keep.txt"), "needle\n");
		await writeFile(path.join(workspace, "pruned", "hidden.txt"), "needle\n");

		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "needle" }));
		expect(result.files?.map((file) => file.path)).toEqual(["ignored/keep.txt"]);
	});

	it("拒绝 protected path，并拒绝解析到 workspace 外的 symlink", async () => {
		await mkdir(path.join(workspace, ".git"));
		await writeFile(path.join(workspace, ".git", "config"), "needle\n");
		expect(await grepWorkspaceFiles(workspace, { path: ".git/config", query: "needle" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});

		await writeFile(path.join(outside, "secret.txt"), "needle\n");
		try {
			await symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));
		} catch {
			return;
		}
		expect(await grepWorkspaceFiles(workspace, { path: "link.txt", query: "needle" })).toMatchObject({
			status: "failed",
			error: { code: "PROTECTED_PATH" },
		});
	});

	it("递归搜索跳过二进制、非法 UTF-8 和超大文件；显式单文件失败返回错误", async () => {
		await writeFile(path.join(workspace, "ok.txt"), "needle\n");
		await writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2]));
		await writeFile(path.join(workspace, "bad.txt"), Buffer.from([0xc3, 0x28]));
		await writeFile(path.join(workspace, "large.txt"), `${"x".repeat(2048)}needle\n`);

		const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "needle" }));
		expect(result.skipped_files).toMatchObject({ binary: 1, invalid_utf8: 1, too_large: 1 });
		expect(result.total_files).toBe(1);
		expect(await grepWorkspaceFiles(workspace, { path: "binary.bin", query: "needle" })).toMatchObject({
			status: "failed",
			error: { code: "BINARY_FILE_UNSUPPORTED" },
		});
		expect(await grepWorkspaceFiles(workspace, { path: "large.txt", query: "needle" })).toMatchObject({
			status: "failed",
			error: { code: "OUTPUT_LIMIT_EXCEEDED" },
		});
	});

	it.skipIf(process.platform === "win32")("递归搜索跳过局部权限失败", async () => {
		await writeFile(path.join(workspace, "ok.txt"), "needle\n");
		await mkdir(path.join(workspace, "locked"));
		await writeFile(path.join(workspace, "locked", "secret.txt"), "needle\n");
		await chmod(path.join(workspace, "locked"), 0o000);
		try {
			const result = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "needle" }));
			expect(result.skipped_files).toMatchObject({ access_denied: 1 });
			expect(result.total_files).toBe(1);
		} finally {
			await chmod(path.join(workspace, "locked"), 0o700);
		}
	});

	it("context 输出合并相邻区间，并保持稳定排序", async () => {
		await writeFile(path.join(workspace, "b.txt"), "0\nneedle one\n2\nneedle two\n4\n");
		await writeFile(path.join(workspace, "a.txt"), "needle a\n");
		const first = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "needle", context: 1 }));
		const second = expectGrepSuccess(await grepWorkspaceFiles(workspace, { path: ".", query: "needle", context: 1 }));
		expect(first).toEqual(second);
		expect(first.files?.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
		const output = formatCompactGrepResult(first);
		expect(output).toContain(["1| 0", "2: needle one", "3| 2", "4: needle two", "5| 4"].join("\n"));
	});

	it("支持 AbortSignal 取消，且零匹配与搜索错误明确区分", async () => {
		await writeFile(path.join(workspace, "a.txt"), "hay\n");
		expect(await grepWorkspaceFiles(workspace, { path: ".", query: "needle" })).toMatchObject({
			total_files: 0,
			total_occurrences: 0,
			scan_complete: true,
		});
		expect(await grepWorkspaceFiles(workspace, { path: "missing", query: "needle" })).toMatchObject({
			status: "failed",
			error: { code: "PATH_NOT_FOUND" },
		});
		const controller = new AbortController();
		controller.abort();
		expect(await grepWorkspaceFiles(workspace, { path: ".", query: "needle" }, controller.signal)).toMatchObject({
			status: "failed",
			error: { code: "OPERATION_ABORTED" },
		});
	});
});
