import type { JsonValue } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";
import { describe, expect, it, vi } from "vitest";
import { executePlan, type QueryContext } from "../../plugins/orchestrator/execute.ts";
import { outputSchema, parameters, type Call, type Condition, type Plan } from "../../plugins/orchestrator/schema.ts";
import type { ExecutionProgress } from "../../plugins/orchestrator/progress.ts";

type Outcome = Awaited<ReturnType<QueryContext["executeTool"]>>;

function success(data: JsonValue, args: Record<string, JsonValue> = {}): Outcome {
	return {
		toolCall: { type: "toolCall", id: "nested", name: "query", arguments: args },
		result: { content: [{ type: "text", text: "native text" }], details: {}, structuredContent: data },
		isError: false,
	};
}

function failure(message: string): Outcome {
	return { ...success(null), isError: true, result: { content: [{ type: "text", text: message }], details: {} } };
}

function context(execute: QueryContext["executeTool"]) {
	return { tools: ["ls", "find", "grep", "read"].map((name) => ({ name })), executeTool: vi.fn(execute) };
}

function call(id: string, tool: Call["tool"] = "find", args: Call["args"] = {}): Call {
	return { id, tool, args };
}

const serial = (...calls: Call[]): Plan => ({ stages: [{ mode: "serial", calls }] });
const runPlan = async (...args: Parameters<typeof executePlan>) => (await executePlan(...args)).result;

describe("只读查询编排", () => {
	it("串行传递结构化结果，保留截断和范围错误", async () => {
		const data = { matches: [{ path: "a.ts" }], truncated: true, scope_errors: [{ path: "missing", code: "not_found" }] };
		const ctx = context(async (name, args) => {
			if (name === "find") return success(data);
			expect(args).toEqual({ path: "a.ts" });
			return success("file content");
		});
		const run = await runPlan(serial(call("files"), call("body", "read", {
			path: { $ref: "files.data.matches.0.path" },
		})), ctx);
		expect(run).toEqual({ status: "completed", steps: [
			{ id: "files", tool: "find", status: "ok", data },
			{ id: "body", tool: "read", status: "ok", data: "file content" },
		] });
		expect(compile(outputSchema).check(run)).toBe(true);
	});

	it("并发达到上限后排队，完成顺序不影响返回顺序，阶段之间等待", async () => {
		const a = Promise.withResolvers<void>();
		const b = Promise.withResolvers<void>();
		const c = Promise.withResolvers<void>();
		const twoStarted = Promise.withResolvers<void>();
		const threeStarted = Promise.withResolvers<void>();
		let active = 0;
		let maximum = 0;
		const started: string[] = [];
		const ctx = context(async (_name, args) => {
			const id = String(Reflect.get(Object(args), "path"));
			started.push(id);
			maximum = Math.max(maximum, ++active);
			if (started.length === 2) twoStarted.resolve();
			if (started.length === 3) threeStarted.resolve();
			if (id === "a") await a.promise;
			if (id === "b") await b.promise;
			if (id === "c") await c.promise;
			active--;
			return success(id);
		});
		const pending = runPlan({ concurrency: 2, stages: [
			{ mode: "parallel", calls: ["a", "b", "c"].map((id) => call(id, "read", { path: id })) },
			{ mode: "serial", calls: [call("last", "read", { path: { $ref: "a.data" } })] },
		] }, ctx);
		try {
			await twoStarted.promise;
			expect(started).toEqual(["a", "b"]);
			a.resolve();
			await threeStarted.promise;
			expect(started).toEqual(["a", "b", "c"]);
			c.resolve();
		} finally { a.resolve(); b.resolve(); c.resolve(); }
		const run = await pending;
		expect(maximum).toBe(2);
		expect(run.status).toBe("completed");
		expect(run.steps.map((step) => step.id)).toEqual(["a", "b", "c", "last"]);
	});

	it.each<{ data: JsonValue; when: Condition; expected: string }>([
		{ data: { matches: [] }, when: { op: "nonempty", ref: "first.data.matches" }, expected: "skipped" },
		{ data: { matches: [1] }, when: { op: "nonempty", ref: "first.data.matches" }, expected: "ok" },
		{ data: "", when: { op: "nonempty", ref: "first.data" }, expected: "skipped" },
		{ data: null, when: { op: "exists", ref: "first.data" }, expected: "ok" },
		{ data: {}, when: { op: "exists", ref: "first.data.missing" }, expected: "skipped" },
		{ data: {}, when: { op: "exists", ref: "first.data.toString" }, expected: "skipped" },
		{ data: 1, when: { op: "eq", ref: "first.data", value: "1" }, expected: "skipped" },
		{ data: false, when: { op: "eq", ref: "first.data", value: false }, expected: "ok" },
		{ data: {}, when: { op: "nonempty", ref: "first.data.missing" }, expected: "error" },
		{ data: 0, when: { op: "nonempty", ref: "first.data" }, expected: "error" },
		{ data: [], when: { op: "eq", ref: "first.data", value: null }, expected: "error" },
	])("条件 $when 对 $data 返回 $expected", async ({ data, when, expected }) => {
		const ctx = context(async () => success(data));
		const run = await runPlan(serial(call("first"), { ...call("next", "ls"), when }), ctx);
		expect(run.status).toBe(expected === "error" ? "failed" : "completed");
		expect(run.steps[1]).toMatchObject({ status: expected });
		expect(ctx.executeTool).toHaveBeenCalledTimes(expected === "ok" ? 2 : 1);
	});

	it.each<{ plan: Plan; code: string }>([
		{ plan: serial(call("same"), call("same")), code: "duplicate_id" },
		{ plan: serial(call("first", "read", { path: { $ref: "later.data" } }), call("later")), code: "invalid_reference" },
		{ plan: serial(call("self", "read", { path: { $ref: "self.data" } })), code: "invalid_reference" },
		{ plan: { stages: [{ mode: "parallel", calls: [call("first"), call("next", "read", { path: { $ref: "first.data" } })] }] }, code: "invalid_reference" },
		{ plan: serial(call("first"), call("next", "read", { path: { $ref: "first.data", other: 1 } })), code: "invalid_reference" },
		{ plan: serial(call("first"), call("next", "read", { path: { $ref: "first.data." } })), code: "invalid_reference" },
		{ plan: { stages: [
			{ mode: "serial", calls: Array.from({ length: 32 }, (_, i) => call(`s${i}`)) },
			{ mode: "serial", calls: [call("overflow")] },
		] }, code: "call_limit" },
	])("执行前拒绝非法计划：$code", async ({ plan, code }) => {
		const ctx = context(async () => success("unused"));
		expect(await runPlan(plan, ctx)).toMatchObject({ status: "invalid", steps: [], error: { code } });
		expect(ctx.executeTool).not.toHaveBeenCalled();
	});

	it("不可调用的工具使整个计划无效，不执行前置查询", async () => {
		const ctx = context(async () => success("unused"));
		ctx.tools = [{ name: "find" }];
		expect(await runPlan(serial(call("first"), call("body", "read")), ctx)).toMatchObject({
			status: "invalid", error: { code: "unavailable_tool" },
		});
		expect(ctx.executeTool).not.toHaveBeenCalled();
	});

	it("并发失败保留已启动查询的结果，不再启动排队查询和后续阶段", async () => {
		const busy = Promise.withResolvers<void>();
		const bothStarted = Promise.withResolvers<void>();
		const ctx = context(async (_name, args) => {
			if (Reflect.get(Object(args), "path") === "bad") return failure("Permission denied");
			bothStarted.resolve();
			await busy.promise;
			return success("finished");
		});
		const pending = runPlan({ concurrency: 2, stages: [
			{ mode: "parallel", calls: [call("bad", "read", { path: "bad" }), call("busy", "read", { path: "busy" }), call("queued")] },
			{ mode: "serial", calls: [call("later")] },
		] }, ctx);
		await bothStarted.promise;
		busy.resolve();
		expect(await pending).toMatchObject({ status: "failed", steps: [
			{ id: "bad", status: "error", error: { code: "tool_error", message: "Permission denied" } },
			{ id: "busy", status: "ok", data: "finished" },
			{ id: "queued", status: "skipped", reason: "previous_error" },
			{ id: "later", status: "skipped", reason: "previous_error" },
		] });
		expect(ctx.executeTool).toHaveBeenCalledTimes(2);
	});

	it("引用被跳过步骤的数据时报错，不伪造空结果", async () => {
		const ctx = context(async () => success({}));
		const run = await runPlan(serial(call("first"), {
			...call("skipped"), when: { op: "exists", ref: "first.data.missing" },
		}, call("last", "read", { path: { $ref: "skipped.data" } })), ctx);
		expect(run).toMatchObject({ status: "failed", steps: [
			{ status: "ok" }, { status: "skipped", reason: "condition_false" },
			{ status: "error", error: { code: "missing_reference" } },
		] });
		expect(ctx.executeTool).toHaveBeenCalledTimes(1);
	});

	it("向运行中查询传播取消，停止调度剩余调用", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const ctx = context(async (_name, _args, options) => {
			expect(options?.signal).toBeDefined();
			await new Promise<void>((resolve) => {
				options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				started.resolve();
			});
			return failure("Cancelled");
		});
		const pending = runPlan(serial(call("first"), call("next")), ctx, controller.signal);
		await started.promise;
		controller.abort();
		expect(await pending).toMatchObject({ status: "cancelled", steps: [
			{ status: "error", error: { message: "Cancelled" } }, { status: "skipped", reason: "cancelled" },
		] });
		expect(ctx.executeTool).toHaveBeenCalledTimes(1);
	});

	it("取消发生在执行前时，不启动查询", async () => {
		const ctx = context(async () => success("unused"));
		expect(await runPlan(serial(call("first")), ctx, AbortSignal.abort())).toMatchObject({
			status: "cancelled", steps: [{ status: "skipped", reason: "cancelled" }],
		});
		expect(ctx.executeTool).not.toHaveBeenCalled();
	});

	it("无结构化结果时保留原文本，拒绝将图片或 PDF 数据塞入结果 JSON", async () => {
		const text = success(null);
		delete text.result.structuredContent;
		const ctx = context(async () => text);
		expect(await runPlan(serial(call("listing", "ls")), ctx)).toMatchObject({ steps: [{ data: "native text" }] });
		ctx.executeTool.mockResolvedValue(success({ type: "pdf", content: [{ type: "image", data: "secret-base64", mimeType: "image/png" }] }));
		const run = await runPlan(serial(call("pdf", "read")), ctx);
		expect(run).toMatchObject({ status: "failed", steps: [{ status: "error", error: { code: "unsupported_result" } }] });
		expect(JSON.stringify(run)).not.toContain("secret-base64");
	});

	it("进度按步骤 ID 报告运行、结果与跳过，快照不被后续更新改写", async () => {
		const body = Promise.withResolvers<void>();
		const observed = Promise.withResolvers<void>();
		const updates: ExecutionProgress[] = [];
		const ctx = context(async (name) => {
			if (name === "find") return success({ matches: [{ path: "a.txt" }] }, { query: "a.txt" });
			await body.promise;
			return success("file content", { path: "a.txt" });
		});
		const pending = executePlan({ stages: [
			{ mode: "serial", calls: [call("files", "find", { query: "a.txt" })] },
			{ mode: "parallel", calls: [
				{ ...call("body", "read", { path: { $ref: "files.data.matches.0.path" } }), when: { op: "nonempty", ref: "files.data.matches" } },
				{ ...call("skipped", "ls"), when: { op: "exists", ref: "files.data.missing" } },
			] },
		] }, ctx, undefined, (progress) => {
			updates.push(progress);
			if (progress.steps[1]?.status === "running" && progress.steps[2]?.status === "skipped") observed.resolve();
		});
		try {
			await observed.promise;
			expect(updates[0]?.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending"]);
			expect(updates.at(-1)?.steps).toMatchObject([
				{ id: "files", status: "ok", invocation: { args: { query: "a.txt" }, durationMs: expect.any(Number) } },
				{ id: "body", status: "running", args: { path: "a.txt" } },
				{ id: "skipped", status: "skipped", reason: "condition_false" },
			]);
		} finally { body.resolve(); }
		const { result, details } = await pending;
		expect(details.steps[1]).toMatchObject({ status: "ok", invocation: { args: { path: "a.txt" }, durationMs: expect.any(Number) } });
		expect(JSON.stringify(result)).not.toContain("invocation");
		expect(compile(outputSchema).check(result)).toBe(true);
	});

	it("进度观察者异常时取消在途查询，释放后传播错误，不启动排队调用", async () => {
		const error = new Error("observer failed");
		const cancelled = vi.fn();
		const ctx = context(async (_name, args, options) => {
			if (Reflect.get(Object(args), "path") === "a") return success("a");
			await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true }));
			return failure("Cancelled");
		});
		await expect(executePlan({ concurrency: 2, stages: [{ mode: "parallel", calls: [
			call("a", "read", { path: "a" }), call("b", "read", { path: "b" }), call("queued", "read", { path: "queued" }),
		] }] }, ctx, undefined, (progress) => {
			if (progress.steps.some((step) => step.status === "ok")) throw error;
		})).rejects.toBe(error);
		expect(cancelled).toHaveBeenCalledTimes(1);
		expect(ctx.executeTool).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ stages: [{ mode: "serial", calls: [{ id: "bad", tool: "bash", args: {} }] }] },
		{ stages: [{ mode: "serial", calls: [call("first")] }], concurrency: 5 },
		{ stages: [{ mode: "parallel", calls: [] }] },
		{ stages: [{ mode: "serial", calls: [{ ...call("first"), when: { op: "eval", ref: "first.data" } }] }] },
	])("参数 schema 排除范围外的工具和表达式：%j", (plan) => {
		expect(compile(parameters).check(plan)).toBe(false);
	});
});
