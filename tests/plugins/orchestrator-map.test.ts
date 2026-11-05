import type { JsonValue } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";
import { expect, it, vi } from "vitest";
import { executePlan, type QueryContext } from "../../plugins/orchestrator/execute.ts";
import type { ExecutionProgress } from "../../plugins/orchestrator/progress.ts";
import { outputSchema, parameters, type Call, type Plan } from "../../plugins/orchestrator/schema.ts";

type Outcome = Awaited<ReturnType<QueryContext["executeTool"]>>;
function success(data: JsonValue): Outcome {
	return { toolCall: { type: "toolCall", id: "nested", name: "query", arguments: {} },
		result: { content: [{ type: "text", text: "query result" }], structuredContent: data, details: {} }, isError: false };
}
function failure(message: string): Outcome {
	return { ...success(null), isError: true, result: { content: [{ type: "text", text: message }], details: {} } };
}
const files = ["a.txt", "b.txt", "c.txt"].map((path) => ({ path, kind: "file" }));
function context(handler?: QueryContext["executeTool"]) {
	return { tools: ["find", "read", "grep", "ls"].map((name) => ({ name })), executeTool: vi.fn<QueryContext["executeTool"]>(handler ?? (async (name, args) => {
		if (name === "find") return success({ matches: files, total_matches: files.length, truncated: false });
		if (name === "ls") return success("directory entries");
		return success(String(Reflect.get(Object(args), "path")));
	})) };
}
function mapped(limit = 2): Call {
	return { id: "bodies", tool: "read", map: { from: "files.data.matches", limit }, args: { path: { $ref: "$item.path" } } };
}
function plan(call: Call = mapped(), mode: "serial" | "parallel" = "parallel"): Plan {
	return { concurrency: 2, stages: [
		{ mode: "serial", calls: [{ id: "files", tool: "find", args: { query: ".txt" } }] },
		{ mode, calls: [call] },
	] };
}

it("搜索后限量读取，按源顺序聚合结果，后续步骤可引用映射数组", async () => {
	const ctx = context();
	const input = plan();
	input.stages.push({ mode: "serial", calls: [{ id: "after", tool: "ls", args: {}, when: { op: "nonempty", ref: "bodies.data" } }] });
	const { result, details } = await executePlan(input, ctx);
	expect(result).toMatchObject({ status: "completed", steps: [
		{ id: "files", status: "ok" },
		{ id: "bodies", status: "ok", map: { total: 3, truncated: true }, data: [
			{ id: "bodies/0", tool: "read", status: "ok", data: "a.txt" },
			{ id: "bodies/1", tool: "read", status: "ok", data: "b.txt" },
		] },
		{ id: "after", status: "ok" },
	] });
	expect(ctx.executeTool.mock.calls.map(([name, args]) => [name, args])).toEqual([
		["find", { query: ".txt" }], ["read", { path: "a.txt" }], ["read", { path: "b.txt" }], ["ls", {}],
	]);
	expect(compile(outputSchema).check(result)).toBe(true);
	expect(JSON.stringify(result)).not.toContain("invocation");
	expect(details.steps[1]).toMatchObject({ data: [{ invocation: { durationMs: expect.any(Number) } }, { invocation: { durationMs: expect.any(Number) } }] });
});

it("两个映射与普通查询共享并发上限，而不是各自创建并发池", async () => {
	const release = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let active = 0;
	let peak = 0;
	const ctx = context(async (name) => {
		if (name === "find") return success({ matches: files });
		peak = Math.max(peak, ++active);
		if (active === 2) started.resolve();
		await release.promise;
		active--;
		return success("done");
	});
	const input = plan(mapped(3));
	const stage = input.stages[1];
	if (stage === undefined) throw new Error("缺少测试阶段");
	stage.calls.push({ id: "listing", tool: "ls", args: {} }, { ...mapped(2), id: "second" });
	const pending = executePlan(input, ctx);
	try {
		await started.promise;
		expect(ctx.executeTool).toHaveBeenCalledTimes(3);
		expect(peak).toBe(2);
	} finally { release.resolve(); }
	expect((await pending).result.status).toBe("completed");
	expect(peak).toBe(2);
	expect(ctx.executeTool).toHaveBeenCalledTimes(7);
});

it("映射项倒序完成时，进度与最终结果仍按来源下标排列", async () => {
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const secondDone = Promise.withResolvers<void>();
	let reads = 0;
	const ctx = context(async (name, args) => {
		if (name === "find") return success({ matches: files });
		const path = Reflect.get(Object(args), "path");
		if (++reads === 2) started.resolve();
		await (path === "a.txt" ? first.promise : second.promise);
		return success(String(path));
	});
	const pending = executePlan(plan(), ctx, undefined, (progress) => {
		const group = progress.steps[1];
		if (group && "map" in group && group.data[0]?.status === "running" && group.data[1]?.status === "ok") secondDone.resolve();
	});
	try { await started.promise; second.resolve(); await secondDone.promise; }
	finally { first.resolve(); second.resolve(); }
	expect((await pending).result.steps[1]).toMatchObject({ data: [{ id: "bodies/0", data: "a.txt" }, { id: "bodies/1", data: "b.txt" }] });
});

it("已完成首项后取消，映射标记为部分跳过而不是成功", async () => {
	const controller = new AbortController();
	const ctx = context();
	const { result } = await executePlan(plan(mapped(), "serial"), ctx, controller.signal, (progress) => {
		const group = progress.steps[1];
		if (group && "map" in group && group.data[0]?.status === "ok") controller.abort();
	});
	expect(result).toMatchObject({ status: "cancelled", steps: [{ status: "ok" }, { status: "skipped", reason: "cancelled", data: [
		{ status: "ok", data: "a.txt" }, { status: "skipped", reason: "cancelled" },
	] }] });
	expect(compile(outputSchema).check(result)).toBe(true);
	expect(ctx.executeTool).toHaveBeenCalledTimes(2);
});

it("映射项遵循串行阶段，不提前启动后续项", async () => {
	const release = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const ctx = context(async (name) => {
		if (name === "find") return success({ matches: files });
		started.resolve();
		await release.promise;
		return success("done");
	});
	const pending = executePlan(plan(mapped(), "serial"), ctx);
	try { await started.promise; expect(ctx.executeTool).toHaveBeenCalledTimes(2); }
	finally { release.resolve(); }
	expect((await pending).result.status).toBe("completed");
	expect(ctx.executeTool).toHaveBeenCalledTimes(3);
});

it("映射失败保留在途成功结果，排队项和后续查询明确跳过，快照不变", async () => {
	const release = Promise.withResolvers<void>();
	const observed = Promise.withResolvers<void>();
	const updates: ExecutionProgress[] = [];
	let busySignal: AbortSignal | undefined;
	const ctx = context(async (name, args, options) => {
		if (name === "find") return success({ matches: files });
		if (Reflect.get(Object(args), "path") === "a.txt") return failure("Permission denied");
		busySignal = options?.signal;
		await release.promise;
		return success("b.txt content");
	});
	const input = plan(mapped(3));
	const stage = input.stages[1];
	if (stage === undefined) throw new Error("缺少测试阶段");
	stage.calls.push({ id: "listing", tool: "ls", args: {} });
	const pending = executePlan(input, ctx, undefined, (progress) => {
		updates.push(progress);
		const group = progress.steps[1];
		if (group && "map" in group && group.data[0]?.status === "error" && group.data[1]?.status === "running") observed.resolve();
	});
	try {
		await observed.promise;
		expect(busySignal?.aborted).toBe(false);
		expect(updates[0]?.steps[1]).toEqual({ id: "bodies", tool: "read", status: "pending" });
	} finally { release.resolve(); }
	const { result } = await pending;
	expect(result).toMatchObject({ status: "failed", steps: [
		{ status: "ok" }, { status: "error", error: { code: "map_failed" }, data: [
			{ status: "error", error: { code: "tool_error", message: "Permission denied" } },
			{ status: "ok", data: "b.txt content" }, { status: "skipped", reason: "previous_error" },
		] }, { status: "skipped", reason: "previous_error" },
	] });
	expect(compile(outputSchema).check(result)).toBe(true);
	expect(ctx.executeTool).toHaveBeenCalledTimes(3);
});

it("映射取消传播给全部在途调用，未启动项保留取消原因", async () => {
	const controller = new AbortController();
	const started = Promise.withResolvers<void>();
	let count = 0;
	const ctx = context(async (name, _args, options) => {
		if (name === "find") return success({ matches: files });
		await new Promise<void>((resolve) => {
			options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			if (++count === 2) started.resolve();
		});
		return failure("Cancelled");
	});
	const pending = executePlan(plan(mapped(3)), ctx, controller.signal);
	await started.promise;
	controller.abort();
	const { result } = await pending;
	expect(result).toMatchObject({ status: "cancelled", steps: [{ status: "ok" }, { data: [
		{ status: "error", error: { message: "Cancelled" } }, { status: "error", error: { message: "Cancelled" } },
		{ status: "skipped", reason: "cancelled" },
	] }] });
	expect(compile(outputSchema).check(result)).toBe(true);
	expect(ctx.executeTool).toHaveBeenCalledTimes(3);
});

it("空数组成功返回空映射，条件为 false 时不解析映射来源", async () => {
	const ctx = context(async () => success({ matches: [] }));
	const empty = await executePlan(plan(), ctx);
	expect(empty.result).toMatchObject({ status: "completed", steps: [{ status: "ok" }, { status: "ok", map: { total: 0, truncated: false }, data: [] }] });
	expect(ctx.executeTool).toHaveBeenCalledTimes(1);
	const conditional = mapped();
	conditional.map = { from: "files.data.missing", limit: 2 };
	conditional.when = { op: "nonempty", ref: "files.data.matches" };
	expect((await executePlan(plan(conditional), ctx)).result).toMatchObject({ status: "completed", steps: [
		{ status: "ok" }, { status: "skipped", reason: "condition_false" },
	] });
	expect(ctx.executeTool).toHaveBeenCalledTimes(2);
});

it.each<{ data: JsonValue; args: Call; code: string }>([
	{ data: { matches: "not an array" }, args: mapped(), code: "map_source_type" },
	{ data: {}, args: mapped(), code: "missing_reference" },
	{ data: { matches: [{ other: true }, { path: "b.txt" }] }, args: mapped(), code: "missing_reference" },
])("错误来源或项字段明确失败，不转换成空数组：$code", async ({ data, args, code }) => {
	const ctx = context(async () => success(data));
	const { result } = await executePlan(plan(args, "serial"), ctx);
	expect(result.status).toBe("failed");
	expect(JSON.stringify(result)).toContain(code);
	expect(ctx.executeTool).toHaveBeenCalledTimes(1);
	expect(compile(outputSchema).check(result)).toBe(true);
});

it("当前项支持整项复制，SDK 修改调用入参不会改写来源结果", async () => {
	const source = { matches: [{ path: "a.txt" }, { path: "b.txt" }] };
	const ctx = context(async (name, args) => {
		if (name === "find") return success(source);
		expect(args).toEqual(expect.objectContaining({ path: expect.stringMatching(/^[ab]\.txt$/) }));
		Reflect.set(Object(args), "path", "normalized.txt");
		return success("content");
	});
	const { result } = await executePlan(plan({ ...mapped(), args: { $ref: "$item" } }), ctx);
	expect(result.status).toBe("completed");
	expect(source.matches).toEqual([{ path: "a.txt" }, { path: "b.txt" }]);
});

it.each<Call>([
	{ id: "outside", tool: "read", args: { path: { $ref: "$item.path" } } },
	{ ...mapped(), map: { from: "$item", limit: 2 } },
	{ ...mapped(), when: { op: "exists", ref: "$item.path" } },
	{ ...mapped(), args: { path: { $ref: "$item." } } },
	{ ...mapped(), map: { from: "bodies.data", limit: 2 } },
	mapped(32),
])("执行前拒绝非法作用域或超额预算：%j", async (call) => {
	const ctx = context();
	const { result } = await executePlan(plan(call), ctx);
	expect(result.status).toBe("invalid");
	expect(ctx.executeTool).not.toHaveBeenCalled();
});

it.each([
	{ from: "files.data.matches" }, { from: "files.data.matches", limit: 0 },
	{ from: "files.data.matches", limit: 33 }, { from: "files.data.matches", limit: 2, map: {} },
])("schema 要求显式上限且不允许嵌套映射：%j", (mapping) => {
	expect(compile(parameters).check({ stages: [{ mode: "parallel", calls: [{ id: "bodies", tool: "read", args: {}, map: mapping }] }] })).toBe(false);
});
