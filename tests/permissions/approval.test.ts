import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tempEnv, service, noUi, type TempEnv } from "./helpers.js";

let env: TempEnv;

beforeEach(async () => {
	env = await tempEnv();
});

afterEach(async () => {
	await env.cleanup();
});

describe("approval", () => {
	it("无 UI ask 转 deny", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const result = await service(env).authorizeToolCall({ toolCallId: "r", toolName: "read", normalizedToolInput: { path: file }, promptContext: noUi() });
		expect(result).toMatchObject({ allowed: false, error: { code: "PERMISSION_PROMPT_UNAVAILABLE" } });
	});

	it("相同并发请求合并一次 prompt", async () => {
		const file = path.join(env.outside, "a.txt");
		await writeFile(file, "a\n");
		const calls: string[] = [];
		const ctx = {
			hasUI: true,
			timeoutMs: 120000,
			prompt: async () => {
				calls.push("prompt");
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { decision: "allow-once" as const };
			},
		};
		const svc = service(env);
		await Promise.all([
			svc.authorizeToolCall({ toolCallId: "r1", toolName: "read", normalizedToolInput: { path: file }, promptContext: ctx }),
			svc.authorizeToolCall({ toolCallId: "r1", toolName: "read", normalizedToolInput: { path: file }, promptContext: ctx }),
		]);
		expect(calls).toHaveLength(1);
	});
});
