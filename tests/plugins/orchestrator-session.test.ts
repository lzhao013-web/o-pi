import {
	SessionManager, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
	type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import fileTools from "../../src/harness/extensions/file-tools.ts";
import type { Plan } from "../../plugins/orchestrator/schema.ts";
import { startModelServer, type ModelResponse } from "../cli/model-server.ts";
import { preserveEnv, setTestHome, useTempDir } from "../helpers/lifecycle.ts";

const temp = useTempDir("opi-orchestrator-");
preserveEnv("HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_OFFLINE");
let runtime: AgentSessionRuntime | undefined;
let server: Awaited<ReturnType<typeof startModelServer>>;
let reply: ModelResponse;
let cwd: string;
let agentDir: string;
const nested: Array<{ tool: string; parent: string | undefined }> = [];
const progress: unknown[] = [];

beforeEach(async () => {
	setTestHome(temp.path);
	cwd = path.join(temp.path, "workspace");
	agentDir = path.join(temp.path, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	nested.length = 0;
	progress.length = 0;
	reply = { text: "done" };
	server = await startModelServer((request) => request.messages.some((message) => message.role === "tool") ? { text: "done" } : reply);
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(path.join(cwd, "a.txt"), "orchestrator fixture\n");
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
		defaultProvider: "fixture", defaultModel: "test", defaultThinkingLevel: "off",
		defaultTools: ["find", "grep", "ls", "read", "orchestrate"],
		compaction: { enabled: false }, retry: { enabled: false },
	}));
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
		baseUrl: server.url, api: "openai-completions", apiKey: "fixture",
		models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
});

afterEach(async () => {
	try { await runtime?.dispose(); }
	finally { runtime = undefined; await server.close(); }
});

async function run(plan: Plan, activeTools?: string[]) {
	reply = { tool: "orchestrate", args: plan };
	runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
			additionalExtensionPaths: [path.resolve("plugins/orchestrator/index.ts")],
			extensionFactories: [
				{ name: "file-tools", factory: fileTools },
				{ name: "test-policy", factory(pi) {
					pi.on("tool_call", (event) => {
						if (event.parentToolCallId === undefined) return;
						nested.push({ tool: event.toolName, parent: event.parentToolCallId });
						if (event.toolName === "read" && event.input.path === "blocked.txt") return { block: true, reason: "Blocked by test policy" };
					});
				} },
			],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		} });
		return {
			...await createAgentSessionFromServices({ services, sessionManager, ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }) }),
			services, diagnostics: services.diagnostics,
		};
	}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
	expect(runtime.diagnostics).toEqual([]);
	await runtime.session.bindExtensions({ mode: "print", onError: ({ error }) => { throw new Error(error); } });
	if (activeTools !== undefined) runtime.session.setActiveToolsByName(activeTools);
	const unsubscribe = runtime.session.subscribe((event) => {
		if (event.type === "tool_execution_update" && event.toolName === "orchestrate") progress.push(structuredClone(event.partialResult));
	});
	try { await runtime.session.prompt("Execute the query plan"); }
	finally { unsubscribe(); }
	const result = runtime.session.messages.findLast((message) => message.role === "toolResult");
	if (result?.role !== "toolResult") throw new Error("缺少编排器结果");
	return result;
}

it("外部插件经真实 SDK 完成搜索、条件读取和并发查询，保留嵌套记录", async () => {
	const result = await run({ stages: [
		{ mode: "serial", calls: [{ id: "files", tool: "find", args: { query: "a.txt" } }] },
		{ mode: "parallel", calls: [
			{ id: "body", tool: "read", args: { path: { $ref: "files.data.matches.0.path" } }, when: { op: "nonempty", ref: "files.data.matches" } },
			{ id: "hits", tool: "grep", args: { query: "orchestrator", path: ["."] } },
			{ id: "listing", tool: "ls", args: {} },
		] },
	] });
	expect(result.isError).toBe(false);
	expect(JSON.stringify(result.content)).not.toContain("invocation");
	expect(result.details).toMatchObject({ status: "completed", steps: [
		{ id: "files", status: "ok", data: { matches: [{ path: "a.txt" }] } },
		{ id: "body", status: "ok", data: expect.stringContaining("orchestrator fixture") },
		{ id: "hits", status: "ok", data: { truncated: false } },
		{ id: "listing", status: "ok", data: expect.stringContaining("a.txt") },
	] });
	expect(result.nestedCalls?.calls.map((entry) => entry.name)).toEqual(["find", "read", "grep", "ls"]);
	expect(nested).toHaveLength(4);
	expect(progress).toEqual(expect.arrayContaining([
		expect.objectContaining({ content: [], details: expect.objectContaining({ status: "running", steps: expect.arrayContaining([
			expect.objectContaining({ id: "body", status: "running", args: { path: "a.txt" } }),
		]) }) }),
	]));
	expect(result.details).toMatchObject({ steps: expect.arrayContaining([
		expect.objectContaining({ id: "body", invocation: { args: { path: "a.txt" }, durationMs: expect.any(Number) } }),
	]) });
	expect(nested.every((entry) => entry.parent === result.toolCallId)).toBe(true);
	expect(server.requests).toHaveLength(2);
	const description = server.requests[0]?.tools?.find((entry) => entry.function.name === "orchestrate")?.function.description;
	expect(description).toContain("find files, then read up to N matches in the same call");
	expect(description).toContain("Condition skips are not errors");
	expect(JSON.stringify(server.requests[1]?.messages)).toContain("orchestrator fixture");
});

it("空搜索是成功，条件为 false 时不读取不存在的文件", async () => {
	const result = await run({ stages: [{ mode: "serial", calls: [
		{ id: "files", tool: "find", args: { query: "no-such-file-xyz" } },
		{ id: "body", tool: "read", args: { path: { $ref: "files.data.matches.0.path" } }, when: { op: "nonempty", ref: "files.data.matches" } },
	] }] });
	expect(result.details).toMatchObject({ status: "completed", steps: [
		{ status: "ok", data: { matches: [], total_matches: 0 } }, { status: "skipped", reason: "condition_false" },
	] });
	expect(result.isError).toBe(false);
	expect(JSON.stringify(result.content)).not.toContain("invocation");
	expect(nested.map((entry) => entry.tool)).toEqual(["find"]);
});

it.each([1, "1"])("真实 SDK 保持 eq 标量类型：%j", async (value) => {
	const result = await run({ stages: [{ mode: "serial", calls: [
		{ id: "files", tool: "find", args: { query: "a.txt" } },
		{ id: "listing", tool: "ls", args: {}, when: { op: "eq", ref: "files.data.total_matches", value } },
	] }] });
	expect(result.details).toMatchObject({ status: "completed", steps: [
		{ status: "ok" }, { status: value === 1 ? "ok" : "skipped" },
	] });
	expect(nested).toHaveLength(value === 1 ? 2 : 1);
});

it("嵌套调用仍受权限钩子控制，拒绝后停止后续查询", async () => {
	const result = await run({ stages: [{ mode: "serial", calls: [
		{ id: "blocked", tool: "read", args: { path: "blocked.txt" } },
		{ id: "later", tool: "ls", args: {} },
	] }] });
	expect(result.isError).toBe(true);
	expect(result.details).toMatchObject({ status: "failed", steps: [
		{ status: "error", error: { code: "tool_error", message: expect.stringContaining("Blocked by test policy") } },
		{ status: "skipped", reason: "previous_error" },
	] });
	expect(result.nestedCalls?.calls).toMatchObject([{ name: "read", status: "error" }]);
	expect(nested.map((entry) => entry.tool)).toEqual(["read"]);
});

it("子调用参数由 SDK 校验，错误不会作为普通数据继续传递", async () => {
	const result = await run({ stages: [{ mode: "serial", calls: [
		{ id: "bad", tool: "find", args: {} }, { id: "later", tool: "ls", args: {} },
	] }] });
	expect(result.details).toMatchObject({ status: "failed", steps: [
		{ status: "error", error: { code: "tool_error", message: expect.stringContaining("query") } },
		{ status: "skipped", reason: "previous_error" },
	] });
	expect(nested).toEqual([]);
});

it("真实 SDK 在一次编排中搜索后限量读取，保留逐项进度和聚合结果", async () => {
	await writeFile(path.join(cwd, "b.txt"), "second fixture\n");
	await writeFile(path.join(cwd, "c.txt"), "not selected\n");
	const result = await run({ concurrency: 2, stages: [
		{ mode: "serial", calls: [{ id: "files", tool: "find", args: { query: ".txt", glob: "*.txt" } }] },
		{ mode: "parallel", calls: [{ id: "bodies", tool: "read", map: { from: "files.data.matches", limit: 2 }, args: { path: { $ref: "$item.path" } } }] },
	] });
	expect(result.isError).toBe(false);
	expect(result.details).toMatchObject({ status: "completed", steps: [
		{ status: "ok" }, { id: "bodies", status: "ok", map: { total: 3, truncated: true }, data: [
			{ id: "bodies/0", status: "ok", data: expect.stringContaining("orchestrator fixture") },
			{ id: "bodies/1", status: "ok", data: expect.stringContaining("second fixture") },
		] },
	] });
	expect(progress).toEqual(expect.arrayContaining([expect.objectContaining({ details: expect.objectContaining({ steps: expect.arrayContaining([
		expect.objectContaining({ id: "bodies", status: "running", data: expect.arrayContaining([
			expect.objectContaining({ id: "bodies/0", status: "running", args: { path: "a.txt" } }),
		]) }),
	]) }) })]));
	expect(result.nestedCalls?.calls.map((call) => call.name)).toEqual(["find", "read", "read"]);
	expect(server.requests).toHaveLength(2);
	const modelResult = JSON.stringify(server.requests[1]?.messages.filter((message) => message.role === "tool"));
	expect(modelResult).toContain("second fixture");
	expect(modelResult).not.toContain("not selected");
	expect(modelResult).not.toContain("invocation");
});

it("映射项同样经过权限钩子，拒绝项保留错误，成功项不丢失", async () => {
	await writeFile(path.join(cwd, "blocked.txt"), "blocked content\n");
	const result = await run({ concurrency: 2, stages: [
		{ mode: "serial", calls: [{ id: "files", tool: "find", args: { query: ".txt", glob: "*.txt" } }] },
		{ mode: "parallel", calls: [{ id: "bodies", tool: "read", map: { from: "files.data.matches", limit: 2 }, args: { path: { $ref: "$item.path" } } }] },
	] });
	expect(result.isError).toBe(true);
	expect(result.details).toMatchObject({ status: "failed", steps: [
		{ status: "ok" }, { status: "error", error: { code: "map_failed" }, data: [
			{ status: "ok", data: expect.stringContaining("orchestrator fixture") },
			{ status: "error", error: { code: "tool_error", message: expect.stringContaining("Blocked by test policy") } },
		] },
	] });
	expect(nested.map((call) => call.tool)).toEqual(["find", "read", "read"]);
});

it("插件不启用已被用户关闭的查询工具", async () => {
	const result = await run({ stages: [{ mode: "serial", calls: [
		{ id: "first", tool: "find", args: { query: "a.txt" } }, { id: "body", tool: "read", args: { path: "a.txt" } },
	] }] }, ["orchestrate", "find"]);
	expect(result.details).toMatchObject({ status: "invalid", steps: [], error: { code: "unavailable_tool" } });
	expect(result.nestedCalls).toBeUndefined();
	expect(nested).toEqual([]);
});
