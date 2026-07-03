import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

import { createDefaultBashOperations, executeBashCommand } from "../src/bash-tool/bash-tool.js";
import { defaultBashToolConfig } from "../src/bash-tool/config.js";

let workspace: string;
let config = defaultBashToolConfig();

beforeEach(async () => {
	workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-bash-test-"));
	config = defaultBashToolConfig();
	config.limits.success_output_bytes = 200;
	config.limits.failure_output_bytes = 300;
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

function fakeOperations(handler: BashOperations["exec"]): BashOperations {
	return { exec: handler };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		signal?.addEventListener("abort", () => resolve(), { once: true });
	});
}

describe("bash tool execution", () => {
	it("command 和 cwd 原样传递", async () => {
		let seen: { command: string; cwd: string } | undefined;
		const operations = fakeOperations(async (command, cwd) => {
			seen = { command, cwd };
			return { exitCode: 0 };
		});
		await executeBashCommand({ command: "echo $HOME && pwd" }, runtime(operations));
		expect(seen).toEqual({ command: "echo $HOME && pwd", cwd: workspace });
	});

	it("stdout/stderr 按事件顺序写入日志并保留非零退出码", async () => {
		const operations = fakeOperations(async (_command, _cwd, options) => {
			options.onData(Buffer.from("out\n"));
			options.onData(Buffer.from("err\n"));
			return { exitCode: 3 };
		});
		const result = await executeBashCommand({ command: "x" }, runtime(operations));
		expect(result.details.status).toBe("exited");
		expect(result.details.exit_code).toBe(3);
		if (!result.details.full_output_path) throw new Error("missing log path");
		expect(await readFile(result.details.full_output_path, "utf8")).toBe("out\nerr\n");
	});

	it("timeout 和用户取消用本地状态区分", async () => {
		const hanging = fakeOperations(async (_command, _cwd, options) => {
			await waitForAbort(options.signal);
			throw new Error("aborted");
		});
		const timedOut = await executeBashCommand({ command: "sleep", timeout: 0.01 }, runtime(hanging));
		expect(timedOut.details.status).toBe("timed_out");

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);
		const aborted = await executeBashCommand({ command: "sleep" }, { ...runtime(hanging), signal: controller.signal });
		expect(aborted.details.status).toBe("aborted");
	});

	it("文件流完成后才返回，完整小输出删除日志，失败保留日志", async () => {
		const small = fakeOperations(async (_command, _cwd, options) => {
			options.onData(Buffer.from("ok\n"));
			return { exitCode: 0 };
		});
		const success = await executeBashCommand({ command: "ok" }, runtime(small));
		expect(success.details.full_output_path).toBeUndefined();

		const failed = fakeOperations(async (_command, _cwd, options) => {
			options.onData(Buffer.from("bad\n"));
			return { exitCode: 1 };
		});
		const failure = await executeBashCommand({ command: "bad" }, runtime(failed));
		if (!failure.details.full_output_path) throw new Error("missing log path");
		expect(await readFile(failure.details.full_output_path, "utf8")).toBe("bad\n");
	});

	it("capture limit 后停止写文件但继续维护尾部预览", async () => {
		config.limits.max_capture_bytes = 5;
		config.limits.success_output_bytes = 80;
		const operations = fakeOperations(async (_command, _cwd, options) => {
			options.onData(Buffer.from("12345"));
			options.onData(Buffer.from("67890\nlast\n"));
			return { exitCode: 0 };
		});
		const result = await executeBashCommand({ command: "big" }, runtime(operations));
		expect(result.details.capture_complete).toBe(false);
		expect(result.details.output_state).toBe("capture_truncated");
		if (!result.details.full_output_path) throw new Error("missing log path");
		expect(await readFile(result.details.full_output_path, "utf8")).toBe("12345");
		expect(result.content).toContain("last");
	});

	it("日志文件权限尽力设为 0600", async () => {
		const operations = fakeOperations(async (_command, _cwd, options) => {
			options.onData(Buffer.from("bad\n"));
			return { exitCode: 1 };
		});
		const result = await executeBashCommand({ command: "bad" }, runtime(operations));
		if (!result.details.full_output_path) throw new Error("missing log path");
		if (process.platform !== "win32") {
			expect((await stat(result.details.full_output_path)).mode & 0o777).toBe(0o600);
		} else {
			await chmod(result.details.full_output_path, 0o600);
		}
	});

	it("onUpdate 节流，完成后不再发送 update", async () => {
		const updates: string[] = [];
		let dataAfterResolve: ((data: Buffer) => void) | undefined;
		const operations = fakeOperations(async (_command, _cwd, options) => {
			options.onData(Buffer.from("a\n"));
			options.onData(Buffer.from("b\n"));
			dataAfterResolve = options.onData;
			return { exitCode: 0 };
		});
		await executeBashCommand({ command: "updates" }, { ...runtime(operations), onUpdate: (partial) => updates.push(partial.content) });
		const countAfterReturn = updates.length;
		dataAfterResolve?.(Buffer.from("late\n"));
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(updates.length).toBe(countAfterReturn);
		expect(updates.length).toBeLessThanOrEqual(2);
	});

	it("多字节 UTF-8 跨 chunk 不损坏", async () => {
		const bytes = Buffer.from("emoji 😀\n");
		const operations = fakeOperations(async (_command, _cwd, options) => {
			options.onData(bytes.subarray(0, 8));
			options.onData(bytes.subarray(8));
			return { exitCode: 0 };
		});
		const result = await executeBashCommand({ command: "utf8" }, runtime(operations));
		expect(result.content).toContain("emoji 😀");
	});

	it("真实本地后端冒烟：合并 stdout/stderr 并返回退出码", async () => {
		const result = await executeBashCommand(
			{ command: "node -e \"process.stdout.write('out\\\\n'); process.stderr.write('err\\\\n'); process.exit(3)\"" },
			runtime(createDefaultBashOperations()),
		);
		expect(result.details.exit_code).toBe(3);
		expect(result.content).toContain("out");
		expect(result.content).toContain("err");
	});
});

function runtime(operations: BashOperations) {
	return {
		cwd: workspace,
		sessionId: "session/with unsafe chars",
		toolCallId: "tool:1",
		operations,
		config,
	};
}

