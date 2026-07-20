import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
	createEventBus,
	type AgentToolResult,
	type EventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import telemetryExtension from "../../agent/extensions/telemetry.js";
import { bashTelemetry } from "../../src/bash-tool/telemetry.js";
import { editTelemetry, findTelemetry, readTelemetry, writeTelemetry } from "../../src/file-tools/telemetry.js";
import { subagentTelemetry } from "../../src/subagent/telemetry.js";
import { countTextTokensSync } from "../../src/token-counter.js";
import { defineToolTelemetry, minimalTelemetry, type ToolTelemetryAdapter } from "../../src/telemetry/adapter.js";
import { decodeTelemetryRuntimeEvent, TELEMETRY_RUNTIME_CHANNEL } from "../../src/telemetry/channel.js";
import { computeToolImplementationHash } from "../../src/telemetry/cohort.js";
import { registerTelemetry, TelemetryCollector } from "../../src/telemetry/collector.js";
import { compactJson, isRecord, scalar, telemetryMetric } from "../../src/telemetry/projectors.js";
import { TelemetryCallStore } from "../../src/telemetry/runtime.js";
import { registerObservedTool } from "../../src/telemetry/tool.js";
import type { JsonObject, MetricMap, TelemetryRecord, ToolCallRecord, TurnStartRecord } from "../../src/telemetry/types.js";
import { JsonlTelemetryWriter, type TelemetryWriter } from "../../src/telemetry/writer.js";
import { webSearchTelemetry } from "../../src/web-tools/telemetry.js";
import { useTempDir } from "../helpers/lifecycle.js";

const paramsSchema = Type.Object(
	{ path: Type.String(), count: Type.Optional(Type.Integer()) },
	{ additionalProperties: false },
);
type TestParams = Parameters<ToolDefinition<typeof paramsSchema>["execute"]>[1];

interface TestDetails {
	status?: "failed" | "timed_out" | "aborted";
	error?: { code: string };
	truncated?: boolean;
	password?: string;
}

const temp = useTempDir("o-pi-telemetry-");

describe("telemetry collection", () => {
	it("registers lifecycle listeners without appendEntry or session-tree scanning", () => {
		const lifecycleEvents: string[] = [];
		const commands: string[] = [];
		telemetryExtension({
			events: createEventBus(),
			on(event: string) {
				lifecycleEvents.push(event);
			},
			getActiveTools: () => [],
			getAllTools: () => [],
			getThinkingLevel: () => "off",
			registerCommand: (name: string) => commands.push(name),
		} as unknown as ExtensionAPI);

		expect(lifecycleEvents).toEqual([
			"session_start",
			"turn_start",
			"tool_execution_start",
			"turn_end",
			"session_shutdown",
		]);
		expect(commands).toEqual(["telemetry"]);
	});

	it.each([
		["accepted", { path: "src/a.ts" }, { path: "src/a.ts" }, []],
		["repaired", { path: "@src/a.ts", count: "2" }, { path: "src/a.ts", count: 2 }, ["numeric_string_to_number", "strip_path_prefix"]],
		["invalid", { path: 42 }, undefined, []],
	] as const)("records nested input and %s preparation", async (status, raw, executed, operations) => {
		const harness = await createHarness();
		const result = successResult();
		await harness.start("call-1", raw);
		const prepared = harness.prepare(raw);
		if (executed !== undefined) await harness.execute("call-1", prepared);
		await harness.endExecution("call-1", result, status === "invalid");
		await harness.endTurn([{ id: "call-1", arguments: raw }], [toolResult("call-1", result, status === "invalid")]);

		const record = harness.toolCalls()[0];
		expect(record).not.toHaveProperty("source");
		expect(record?.data.annotations.preparation).toMatchObject({ status, operations: expect.arrayContaining([...operations]) });
		expect(record?.data.input.requested.value).toEqual(raw);
		expect(record?.data.input.executed?.value).toEqual(executed);
		expect(record?.data.result.outcome).toBe(status === "invalid" ? "validation_error" : "success");
		expect(record?.data.tool.cohort).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("changes the implementation hash when this tool implementation changes", () => {
		const firstDefinition: ToolDefinition<typeof paramsSchema, TestDetails> = {
			name: "test",
			label: "test",
			description: "test",
			parameters: paramsSchema,
			execute: async () => successResult("one"),
		};
		const secondDefinition: ToolDefinition<typeof paramsSchema, TestDetails> = {
			...firstDefinition,
			execute: async () => successResult("two"),
		};
		const first = computeToolImplementationHash(firstDefinition, testTelemetry, ["src/telemetry/adapter.ts"], {});
		const second = computeToolImplementationHash(secondDefinition, testTelemetry, ["src/telemetry/adapter.ts"], {});
		expect(first).not.toBe(second);
	});

	it("keeps requested input separate from repaired executed input", async () => {
		const harness = await createHarness();
		const raw = { path: "@src/a.ts", count: "2" };
		await harness.start("repair-1", raw);
		const prepared = harness.prepare(raw);
		await harness.execute("repair-1", prepared);
		await harness.endExecution("repair-1", successResult(), false);
		await harness.endTurn([{ id: "repair-1", arguments: raw }], [toolResult("repair-1", successResult(), false)]);

		expect(harness.toolCalls()[0]?.data).toMatchObject({
			input: {
				requested: { value: { path: "@src/a.ts", count: "2" } },
				executed: { value: { path: "src/a.ts", count: 2 } },
			},
		});
	});

	it("isolates parallel calls with structurally identical arguments and reversed results", async () => {
		const pending = new Map<string, ReturnType<typeof deferred<AgentToolResult<TestDetails>>>>();
		const harness = await createHarness((_params, id) => {
			const wait = deferred<AgentToolResult<TestDetails>>();
			pending.set(id, wait);
			return wait.promise;
		});
		const first = { path: "same.ts" };
		const second = { path: "same.ts" };
		await harness.start("first", first);
		const firstPrepared = harness.prepare(first);
		await harness.start("second", second);
		const secondPrepared = harness.prepare(second);
		const firstExecution = harness.execute("first", firstPrepared);
		const secondExecution = harness.execute("second", secondPrepared);
		pending.get("second")?.resolve(successResult("second"));
		await secondExecution;
		pending.get("first")?.resolve(successResult("first"));
		await firstExecution;
		await harness.endExecution("second", successResult("second"), false);
		await harness.endExecution("first", successResult("first"), false);
		await harness.endTurn(
			[
				{ id: "first", arguments: first },
				{ id: "second", arguments: second },
			],
			[
				toolResult("second", successResult("second"), false),
				toolResult("first", successResult("first"), false),
			],
		);

		expect(harness.toolCalls().map((record) => [record.tool_call_id, record.data.result.output.text_chars])).toEqual([
			["first", 5],
			["second", 6],
		]);
		expect(harness.toolCalls().every((record) => record.data.annotations.preparation?.status === "accepted")).toBe(true);
	});

	it("records approval denial without entering execute", async () => {
		const harness = await createHarness();
		const raw = { path: "src/a.ts" };
		await harness.start("blocked-1", raw);
		harness.prepare(raw);
		harness.events.emit(TELEMETRY_RUNTIME_CHANNEL, {
			kind: "approval",
			tool_call_id: "blocked-1",
			tool_name: "test",
			approval: { decision: "deny", outcome: "policy_deny", wait_ms: 0, rule_name: "deny-write" },
		});
		await harness.endExecution("blocked-1", successResult("blocked"), true);
		await harness.endTurn([{ id: "blocked-1", arguments: raw }], [toolResult("blocked-1", successResult("blocked"), true)]);

		const record = harness.toolCalls()[0];
		expect(record?.data).toMatchObject({
			annotations: { approval: { decision: "deny", outcome: "policy_deny", rule_name: "deny-write" } },
			result: { outcome: "blocked", error: { source: "approval" } },
		});
		expect(record?.tool_call_id).toBe("blocked-1");
		expect(record?.data.input).not.toHaveProperty("executed");
	});

	it.each([
		["tool error", successResult("error", { status: "failed", error: { code: "FILE_NOT_FOUND" } }), true, "tool_error"],
		["timeout", successResult("error", { status: "timed_out" }), true, "timeout"],
		["abort", successResult("error", { status: "aborted" }), true, "aborted"],
	] as const)("classifies %s from final result facts", async (_label, result, isError, outcome) => {
		const harness = await createHarness(() => Promise.resolve(result));
		const raw = { path: "src/a.ts" };
		await harness.start("call-1", raw);
		await harness.execute("call-1", harness.prepare(raw));
		await harness.endExecution("call-1", result, isError);
		await harness.endTurn([{ id: "call-1", arguments: raw }], [toolResult("call-1", result, isError)]);
		expect(harness.toolCalls()[0]?.data.result).toMatchObject({ outcome });
	});

	it("observes the finalized tool_execution_end result after result hooks", async () => {
		const harness = await createHarness(() => Promise.resolve(successResult("initial")));
		const raw = { path: "src/a.ts" };
		await harness.start("finalized", raw);
		await harness.execute("finalized", harness.prepare(raw));
		const finalized = successResult("final", { status: "timed_out", error: { code: "TIMEOUT" } });
		await harness.endExecution("finalized", finalized, true);
		await harness.endTurn([{ id: "finalized", arguments: raw }], [toolResult("finalized", finalized, true)]);
		expect(harness.toolCalls()[0]?.data).toMatchObject({
			result: { outcome: "timeout", error: { code: "TIMEOUT" }, output: { text_chars: 5 } },
		});
	});

	it("classifies execute throws without affecting the tool boundary", async () => {
		const harness = await createHarness(() => Promise.reject(new Error("boom")));
		const raw = { path: "src/a.ts" };
		await harness.start("throw-1", raw);
		await expect(harness.execute("throw-1", harness.prepare(raw))).rejects.toThrow("boom");
		await harness.endExecution("throw-1", successResult("error"), true);
		await harness.endTurn([{ id: "throw-1", arguments: raw }], [toolResult("throw-1", successResult("error"), true)]);
		expect(harness.toolCalls()[0]?.data.result).toMatchObject({ outcome: "exception", error: { source: "execute", code: "Error" } });
	});

	it("defaults to empty projections and contains adapter failures", async () => {
		const failingAdapter: ToolTelemetryAdapter<TestParams, TestDetails> = {
			projectRequested() {
				throw new Error("requested failed");
			},
			projectExecuted() {
				throw new Error("executed failed");
			},
			observeResult() {
				throw new Error("result failed");
			},
		};
		const failing = await createHarness(undefined, failingAdapter);
		const raw = { path: "secret.ts" };
		await failing.start("failed-projection", raw);
		await expect(failing.execute("failed-projection", failing.prepare(raw))).resolves.toEqual(successResult());
		await failing.endExecution("failed-projection", successResult(), false);
		await failing.endTurn([{ id: "failed-projection", arguments: raw }], [toolResult("failed-projection", successResult(), false)]);
		expect(failing.toolCalls()[0]?.data).toMatchObject({
			input: { requested: { value: {} }, executed: { value: {} } },
			annotations: { projection_failed: true },
			result: { outcome: "success", metrics: {}, references: [] },
		});

		const minimal = await createHarness(undefined, minimalTelemetry<TestParams, TestDetails>());
		await minimal.start("minimal", raw);
		await minimal.execute("minimal", minimal.prepare(raw));
		await minimal.endExecution("minimal", successResult(), false);
		await minimal.endTurn([{ id: "minimal", arguments: raw }], [toolResult("minimal", successResult(), false)]);
		expect(JSON.stringify(minimal.toolCalls()[0])).not.toContain("secret.ts");
	});

	it("marks non-serializable projections failed and isolates later calls", async () => {
		const cyclicInput: JsonObject = {};
		Object.defineProperty(cyclicInput, "self", { value: cyclicInput, enumerable: true });
		const cyclicMetrics: MetricMap = {};
		Object.defineProperty(cyclicMetrics, "self", { value: cyclicMetrics, enumerable: true });
		const adapter = defineToolTelemetry<TestParams, TestDetails>({
			projectRequested(value) {
				return isRecord(value) && value["path"] === "bad.ts"
					? { value: cyclicInput }
					: { value: compactJson({ path: isRecord(value) ? scalar(value["path"]) : undefined }) };
			},
			projectExecuted(params) {
				return params.path === "bad.ts"
					? { value: cyclicInput }
					: { value: { path: params.path } };
			},
			observeResult(params) {
				return params.path === "bad.ts" ? { metrics: cyclicMetrics } : { metrics: { observed: telemetryMetric(true) } };
			},
		});
		const harness = await createHarness(undefined, adapter);
		for (const [id, raw] of [["bad", { path: "bad.ts" }], ["good", { path: "good.ts" }]] as const) {
			await harness.start(id, raw);
			await harness.execute(id, harness.prepare(raw));
			await harness.endExecution(id, successResult(id), false);
		}
		await harness.endTurn(
			[
				{ id: "bad", arguments: { path: "bad.ts" } },
				{ id: "good", arguments: { path: "good.ts" } },
			],
			[
				toolResult("bad", successResult("bad"), false),
				toolResult("good", successResult("good"), false),
			],
		);
		expect(harness.toolCalls()[0]?.data).toMatchObject({
			input: { requested: { value: {} }, executed: { value: {} } },
			annotations: { projection_failed: true },
			result: { outcome: "success", metrics: {} },
		});
		expect(harness.toolCalls()[1]?.data).toMatchObject({
			input: { requested: { value: { path: "good.ts" } }, executed: { value: { path: "good.ts" } } },
			result: { outcome: "success", metrics: { observed: { value: true } } },
		});
	});

	it("deep-decodes shared channel events and rejects cyclic or unowned payloads", () => {
		const requested = { path: "src/a.ts" };
		const decoded = decodeTelemetryRuntimeEvent({
			kind: "preparation",
			tool_call_id: "call-1",
			tool_name: "test",
			requested: { value: requested },
			status: "accepted",
			operations: [],
		});
		requested.path = "mutated.ts";
		expect(decoded).toMatchObject({ kind: "preparation", requested: { value: { path: "src/a.ts" } } });

		const cyclic: Record<string, unknown> = {};
		cyclic["self"] = cyclic;
		expect(decodeTelemetryRuntimeEvent({
			kind: "execute_start",
			tool_call_id: "call-1",
			tool_name: "test",
			executed: { value: cyclic },
		})).toBeUndefined();
		expect(decodeTelemetryRuntimeEvent({
			kind: "approval",
			tool_call_id: "call-1",
			approval: { decision: "deny", outcome: "policy_deny", wait_ms: 0 },
		})).toBeUndefined();
	});

	it("keeps payload-bearing adapter fields redacted and result candidates payload-free", () => {
		const write = writeTelemetry.projectExecuted({ path: "src/a.ts", content: "secret\ncontent" });
		const edit = editTelemetry.projectExecuted({ path: "src/a.ts", edits: [{ old: "secret old", new: "secret new" }] });
		const delegated = subagentTelemetry.projectExecuted({ tasks: [{ agent: "reviewer", task: "secret task", cwd: "/workspace" }] });
		const projected = JSON.stringify({ write, edit, delegated });
		expect(projected).not.toContain("secret");
		expect(write.value["content"]).toMatchObject({ chars: 14, lines: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });

		const find = findTelemetry.observeResult(
			{ query: "service", path: "src" },
			{
				content: [{ type: "text", text: "secret result body" }],
				details: {
					query: "service",
					path: "src",
					strategy: "fuzzy",
					totalMatches: 1,
					returnedMatches: 1,
					scannedEntries: 100,
					matches: [{ path: "src/a.ts", kind: "file" }],
					collapsedGroups: [],
					displayedMatches: [{ path: "src/a.ts", kind: "file" }],
					candidateSources: { "src/a.ts": ["lsp-symbol", "path"] },
					ignoredCount: 0,
					skippedCount: 0,
					scanTruncated: true,
					resultLimited: false,
					outputTruncated: false,
				},
			},
		);
		expect(find.references).toEqual([
			{ relation: "candidate", rank: 1, kind: "file", value: "src/a.ts", group: "primary", sources: ["fuzzy", "lexical", "lsp"] },
		]);
		expect(JSON.stringify(find)).not.toContain("secret");
		expect(find.truncated).toBe(true);

		const failedRead = readTelemetry.observeResult(
			{ path: "missing.ts", start_line: 10, end_line: 20 },
			{
				content: [{ type: "text", text: "error" }],
				details: { status: "failed", error: { code: "FILE_NOT_FOUND", message: "secret error" } },
			},
		);
		expect(failedRead.error_code).toBe("FILE_NOT_FOUND");
		expect(JSON.stringify(failedRead)).not.toContain("secret error");

		const web = webSearchTelemetry.observeResult(
			{ query: "docs", limit: 1 },
			{
				content: [{ type: "text", text: "secret web body" }],
				details: {
					status: "success",
					query: "docs",
					provider: "exa_mcp",
					results: [{ rank: 1, title: "secret title", url: "https://example.com/a", snippet: "secret snippet" }],
					cached: false,
					downloaded_bytes: 100,
					duration_ms: 5,
					attempts: [],
				},
			},
		);
		expect(web.references).toEqual([
			{ relation: "candidate", rank: 1, kind: "url", value: "https://example.com/a", group: "primary", sources: ["exa_mcp"] },
		]);
		expect(JSON.stringify(web)).not.toContain("secret");

		const bash = bashTelemetry.observeResult(
			{ command: "npm run typecheck" },
			{
				content: [{ type: "text", text: "secret terminal output" }],
				details: {
					status: "exited",
					exit_code: 0,
					duration_ms: 10,
					output_state: "compacted",
					output_format: "text",
					total_lines: 100,
					returned_lines: 10,
					total_bytes: 1_000,
					returned_bytes: 100,
					full_output_path: "/private/output.log",
					capture_complete: true,
				},
			},
		);
		expect(bash.metrics).not.toHaveProperty("full_output_path");
		expect(JSON.stringify(bash)).not.toContain("secret");
	});

	it("uses turn_end payload only and records a missing result", async () => {
		const harness = await createHarness();
		const raw = { path: "new.ts" };
		await harness.start("missing", raw);
		await harness.endTurn([{ id: "missing", arguments: raw }], []);
		expect(harness.toolCalls()[0]?.data.result).toMatchObject({ outcome: "missing_result", error: { source: "runtime" } });
	});

	it("defaults to no persisted input or details for an unobserved tool", async () => {
		const records: TelemetryRecord[] = [];
		const collector = new TelemetryCollector({ writerFactory: () => memoryWriter(records), now: fixedNow });
		const contextValue = context();
		await collector.onSessionStart({ type: "session_start", reason: "startup" }, contextValue);
		collector.onToolExecutionStart({ toolCallId: "unobserved", toolName: "future-tool" });
		collector.onTurnEnd(turnEnd(
			[{ id: "unobserved", name: "future-tool", arguments: { apiKey: "private-key", body: "private-body" } }],
			[{
				...toolResult("unobserved", successResult("private output", {}), false),
				toolName: "future-tool",
				details: { password: "private-password" },
			}],
		));
		const record = records.find((item): item is ToolCallRecord => item.event === "tool_call");
		expect(record?.data).toMatchObject({ input: { requested: { value: {} } }, result: { outcome: "success" } });
		expect(JSON.stringify(record)).not.toContain("private");
	});

	it("drops runtime events after the session store is reset", () => {
		const store = new TelemetryCallStore();
		store.start("old-call", "test");
		store.reset();
		store.apply({
			kind: "execute_start",
			tool_call_id: "old-call",
			tool_name: "test",
			executed: { value: { path: "stale.ts" } },
		});
		expect(store.take("old-call", "test")).toBeUndefined();
	});

	it("clears pending preparation and runtime facts at a session boundary", async () => {
		const harness = await createHarness();
		const reusedRaw = { path: "fresh.ts" };
		await harness.start("reused-id", reusedRaw);
		harness.events.emit(TELEMETRY_RUNTIME_CHANNEL, {
			kind: "approval",
			tool_call_id: "reused-id",
			tool_name: "test",
			approval: { decision: "deny", outcome: "policy_deny", wait_ms: 10 },
		});
		await harness.restartSession();
		harness.events.emit(TELEMETRY_RUNTIME_CHANNEL, {
			kind: "execute_end",
			tool_call_id: "reused-id",
			tool_name: "test",
			execute: { duration_ms: 50, state: "threw", error_name: "OldError", signal_aborted: false },
		});
		await harness.start("reused-id", reusedRaw);
		await harness.execute("reused-id", harness.prepare(reusedRaw));
		await harness.endExecution("reused-id", successResult(), false);
		await harness.endTurn([{ id: "reused-id", arguments: reusedRaw }], [toolResult("reused-id", successResult(), false)]);
		const record = harness.toolCalls()[0];
		expect(record?.data).toMatchObject({
			annotations: { preparation: { status: "accepted" }, execution: { state: "returned" } },
			result: { outcome: "success" },
		});
		expect(record?.data.annotations).not.toHaveProperty("approval");
		expect(record?.data.annotations.execution).not.toHaveProperty("error_name");
	});

	it("keys definition-token estimates by model and toolset", async () => {
		const records: TelemetryRecord[] = [];
		const collector = new TelemetryCollector({ writerFactory: () => memoryWriter(records), now: fixedNow });
		const tool = {
			name: "test",
			description: "读取并分析遥测定义。".repeat(30),
			parameters: paramsSchema,
			promptGuidelines: ["只返回必要字段。".repeat(20)],
			sourceInfo: { path: "/test", source: "test", scope: "temporary", origin: "top-level" },
		} as ReturnType<ExtensionAPI["getAllTools"]>[number];
		const pi = toolInfoApi([tool]);
		const openAi = context({ provider: "openai", id: "gpt-5.4" });
		const deepSeek = context({ provider: "deepseek", id: "deepseek-v3" });
		await collector.onSessionStart({ type: "session_start", reason: "startup" }, openAi);
		collector.onTurnStart({ type: "turn_start", turnIndex: 0, timestamp: 1 }, openAi, pi);
		collector.onTurnStart({ type: "turn_start", turnIndex: 1, timestamp: 2 }, deepSeek, pi);
		const starts = records.filter((record): record is TurnStartRecord => record.event === "turn_start");
		const definition = JSON.stringify({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			promptGuidelines: tool.promptGuidelines,
		});
		expect(starts.map((record) => record.data.tool_definitions[0]?.estimated_tokens)).toEqual([
			countTextTokensSync(definition, { provider: "openai", modelId: "gpt-5.4" }).tokens,
			countTextTokensSync(definition, { provider: "deepseek", modelId: "deepseek-v3" }).tokens,
		]);
		expect(starts[0]?.data.tool_definitions).not.toEqual(starts[1]?.data.tool_definitions);
	});

	it("hydrates a resumed session, deduplicates records, and continues sequence numbers", async () => {
		const records: TelemetryRecord[] = [];
		const historical = {
			...baseRecord("session_start"),
			id: "historical",
			session_id: "session-1",
			sequence: 7,
		};
		const collector = new TelemetryCollector({
			writerFactory: () => memoryWriter(records),
			now: fixedNow,
			sessionLoader: async () => ({ records: [historical, historical], invalidLines: 1 }),
		});
		await collector.onSessionStart({ type: "session_start", reason: "resume" }, context());
		const snapshot = collector.snapshot();
		expect(snapshot).toMatchObject({ sessionId: "session-1", revision: 2, invalidLines: 1 });
		expect(snapshot.records).toHaveLength(2);
		expect(records[0]).toMatchObject({ event: "session_start", sequence: 8, data: { reason: "resume" } });
	});

	it("commits live records before asynchronous persistence finishes and exposes writer health", async () => {
		const appendStarted = deferred<void>();
		const releaseAppend = deferred<void>();
		const writer = new JsonlTelemetryWriter("session-1", {
			directory: temp.path,
			append: async () => {
				appendStarted.resolve();
				await releaseAppend.promise;
			},
			acquireLock: async () => async () => undefined,
		});
		const collector = new TelemetryCollector({
			writerFactory: () => writer,
			now: fixedNow,
			sessionLoader: async () => ({ records: [], invalidLines: 0 }),
		});
		await collector.onSessionStart({ type: "session_start", reason: "startup" }, context());
		await appendStarted.promise;
		expect(collector.snapshot()).toMatchObject({ revision: 1, writer: { pending: 1, persisted: 0, failed: 0 } });
		releaseAppend.resolve();
		await writer.flush();
		expect(collector.snapshot().writer).toMatchObject({ pending: 0, persisted: 1, failed: 0 });
	});

	it("does not let writer failures escape lifecycle or execute", async () => {
		const writer: TelemetryWriter = {
			append() {
				throw new Error("disk full");
			},
			async flush() {
				throw new Error("disk full");
			},
		};
		const harness = await createHarness(undefined, testTelemetry, writer);
		const raw = { path: "safe.ts" };
		await harness.start("safe", raw);
		await expect(harness.execute("safe", harness.prepare(raw))).resolves.toEqual(successResult());
		await harness.endExecution("safe", successResult(), false);
		await expect(harness.endTurn([{ id: "safe", arguments: raw }], [toolResult("safe", successResult(), false)])).resolves.toBeUndefined();
		await expect(harness.shutdown()).resolves.toBeUndefined();
	});

	it("keeps the shared bus subscription across session switches and disposes it on reload", async () => {
		const tracked = trackedEventBus();
		let shutdownHandler: LifecycleHandler | undefined;
		const pi = {
			events: tracked.events,
			on(event: string, handler: LifecycleHandler) {
				if (event === "session_shutdown") shutdownHandler = handler;
			},
			getActiveTools: () => [],
			getAllTools: () => [],
			getThinkingLevel: () => "off",
		} as unknown as ExtensionAPI;
		registerTelemetry(pi, { writerFactory: () => memoryWriter([]), now: fixedNow });
		expect(tracked.subscriptions()).toBe(1);
		const handler = shutdownHandler;
		if (handler === undefined) throw new Error("session_shutdown handler was not registered");
		await handler({ type: "session_shutdown", reason: "new" }, context());
		expect(tracked.subscriptions()).toBe(1);
		await handler({ type: "session_shutdown", reason: "reload" }, context());
		expect(tracked.subscriptions()).toBe(0);
		registerTelemetry(pi, { writerFactory: () => memoryWriter([]), now: fixedNow });
		expect(tracked.subscriptions()).toBe(1);
		const deliveries = tracked.deliveries();
		tracked.events.emit(TELEMETRY_RUNTIME_CHANNEL, { invalid: true });
		expect(tracked.deliveries()).toBe(deliveries + 1);
		const replacementHandler = shutdownHandler;
		if (replacementHandler === undefined) throw new Error("replacement session_shutdown handler was not registered");
		await replacementHandler({ type: "session_shutdown", reason: "quit" }, context());
		expect(tracked.subscriptions()).toBe(0);
	});

	it("appends one JSON object per line to a per-session file", async () => {
		const writer = new JsonlTelemetryWriter("session/id", { directory: temp.path });
		writer.append(baseRecord("session_start"));
		writer.append(baseRecord("session_end"));
		await writer.flush();
		const files = await readdir(temp.path);
		expect(files).toHaveLength(1);
		const file = files[0];
		if (file === undefined) throw new Error("telemetry file was not written");
		const lines = (await readFile(path.join(temp.path, file), "utf8")).trim().split("\n");
		expect(lines).toHaveLength(2);
		const persisted = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(persisted).toEqual([
			expect.objectContaining({ event: "session_start" }),
			expect.objectContaining({ event: "session_end" }),
		]);
	});

	it("serializes concurrent writers into the same session file", async () => {
		const first = new JsonlTelemetryWriter("concurrent/session", { directory: temp.path });
		const second = new JsonlTelemetryWriter("concurrent/session", { directory: temp.path });
		for (let index = 0; index < 10; index += 1) {
			first.append(baseRecord(index % 2 === 0 ? "session_start" : "session_end"));
			second.append(baseRecord(index % 2 === 0 ? "session_end" : "session_start"));
		}
		await Promise.all([first.flush(), second.flush()]);

		const files = await readdir(temp.path);
		const concurrentFiles = files.filter((item) => item.startsWith("concurrent_session-") && item.endsWith(".jsonl"));
		expect(concurrentFiles).toHaveLength(1);
		const file = concurrentFiles[0];
		if (file === undefined) throw new Error("shared telemetry file was not written");
		const lines = (await readFile(path.join(temp.path, file), "utf8")).trim().split("\n");
		expect(lines).toHaveLength(20);
		expect(lines.map((line) => JSON.parse(line))).toHaveLength(20);
	});
});

const testTelemetry = defineToolTelemetry<TestParams, TestDetails>({
	projectRequested(value) {
		if (!isRecord(value)) return { value: {} };
		const projectedPath = typeof value["path"] === "string" ? value["path"] : undefined;
		return {
			value: compactJson({ path: scalar(value["path"]), count: scalar(value["count"]) }),
			...(projectedPath === undefined ? {} : { references: [{ relation: "target", kind: "path", value: projectedPath }] }),
		};
	},
	projectExecuted(params) {
		return {
			value: compactJson({ path: params.path, count: params.count }),
			references: [{ relation: "target", kind: "path", value: params.path }],
		};
	},
	observeResult(_params, result) {
		return {
			metrics: { observed: telemetryMetric(true) },
			...(result.details.status === undefined ? {} : { status: result.details.status }),
			...(result.details.error?.code === undefined ? {} : { error_code: result.details.error.code }),
			truncated: result.details.truncated === true,
		};
	},
});

type ExecuteTestTool = (params: TestParams, toolCallId: string) => Promise<AgentToolResult<TestDetails>>;
type LifecycleHandler = (event: unknown, context: ExtensionContext) => unknown;

async function createHarness(
	execute: ExecuteTestTool = async () => successResult(),
	telemetry: ToolTelemetryAdapter<TestParams, TestDetails> = testTelemetry,
	providedWriter?: TelemetryWriter,
) {
	const records: TelemetryRecord[] = [];
	const events = createEventBus();
	const lifecycle = new Map<string, LifecycleHandler[]>();
	let registered: ToolDefinition<typeof paramsSchema, TestDetails> | undefined;
	const contextValue = context();
	const pi = {
		events,
		on(event: string, handler: LifecycleHandler) {
			const handlers = lifecycle.get(event);
			if (handlers === undefined) lifecycle.set(event, [handler]);
			else handlers.push(handler);
		},
		registerTool(tool: ToolDefinition<typeof paramsSchema, TestDetails>) {
			registered = tool;
		},
		getActiveTools: () => ["test"],
		getAllTools: () => [],
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI;
	const writer = providedWriter ?? memoryWriter(records);
	const collector = registerTelemetry(pi, { writerFactory: () => writer, now: fixedNow });
	registerObservedTool(pi, {
		tool: {
			name: "test",
			label: "test",
			description: "test",
			parameters: paramsSchema,
			execute: (toolCallId, params) => execute(params, toolCallId),
		},
		repair: { pathFields: ["path"] },
		telemetry,
		cohort: {
			implementationEntrypoints: ["tests/telemetry/telemetry.test.ts"],
			config: () => ({ mode: "test" }),
		},
	});
	await invoke(lifecycle, "session_start", { type: "session_start", reason: "startup" }, contextValue);
	await invoke(lifecycle, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 }, contextValue);
	const tool = registered;
	if (tool === undefined) throw new Error("observed tool was not registered");

	return {
		collector,
		context: contextValue,
		events,
		toolCalls: () => records.filter((record): record is ToolCallRecord => record.event === "tool_call"),
		async start(id: string, args: unknown) {
			await invoke(lifecycle, "tool_execution_start", {
				type: "tool_execution_start",
				toolCallId: id,
				toolName: "test",
				args,
			}, contextValue);
		},
		async restartSession() {
			await invoke(lifecycle, "session_start", { type: "session_start", reason: "new" }, contextValue);
			await invoke(lifecycle, "turn_start", { type: "turn_start", turnIndex: 0, timestamp: 2 }, contextValue);
		},
		prepare(args: unknown): TestParams {
			return tool.prepareArguments?.(args) ?? args as TestParams;
		},
		execute(id: string, params: TestParams) {
			return tool.execute(id, params, undefined, undefined, contextValue);
		},
		async endExecution(id: string, result: AgentToolResult<TestDetails>, isError: boolean) {
			await invoke(lifecycle, "tool_execution_end", {
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "test",
				result,
				isError,
			}, contextValue);
		},
		async endTurn(calls: readonly CallSpec[], results: readonly ReturnType<typeof toolResult>[]) {
			await invoke(lifecycle, "turn_end", turnEnd(calls, results), contextValue);
		},
		async shutdown() {
			await invoke(lifecycle, "session_shutdown", { type: "session_shutdown", reason: "quit" }, contextValue);
		},
	};
}

async function invoke(
	lifecycle: ReadonlyMap<string, readonly LifecycleHandler[]>,
	event: string,
	payload: unknown,
	contextValue: ExtensionContext,
): Promise<void> {
	for (const handler of lifecycle.get(event) ?? []) await handler(payload, contextValue);
}

interface CallSpec {
	id: string;
	name?: string;
	arguments: unknown;
}

function turnEnd(calls: readonly CallSpec[], results: readonly ReturnType<typeof toolResult>[]): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: {
			role: "assistant",
			content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name ?? "test", arguments: call.arguments })),
		},
		toolResults: [...results],
	} as unknown as TurnEndEvent;
}

function toolResult(id: string, result: AgentToolResult<TestDetails>, isError: boolean) {
	return {
		role: "toolResult" as const,
		toolCallId: id,
		toolName: "test",
		content: result.content,
		details: result.details,
		isError,
		timestamp: 0,
	};
}

function successResult(text = "ok", details: TestDetails = {}): AgentToolResult<TestDetails> {
	return { content: [{ type: "text", text }], details };
}

function context(model?: { provider: string; id: string }): ExtensionContext {
	return {
		cwd: "/workspace",
		model,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [],
			getEntries() {
				throw new Error("telemetry must not scan session entries");
			},
		},
	} as unknown as ExtensionContext;
}

function toolInfoApi(tools: ReturnType<ExtensionAPI["getAllTools"]>): Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getThinkingLevel"> {
	return {
		getActiveTools: () => tools.map((tool) => tool.name),
		getAllTools: () => tools,
		getThinkingLevel: () => "high",
	};
}

function memoryWriter(records: TelemetryRecord[]): TelemetryWriter {
	return { append: (record) => records.push(record), flush: async () => undefined };
}

function fixedNow(): Date {
	return new Date("2026-01-01T00:00:00.000Z");
}

function baseRecord(event: "session_start" | "session_end"): TelemetryRecord {
	const base = {
		id: `${event}-id`,
		timestamp: "2026-01-01T00:00:00.000Z",
		session_id: "session/id",
		sequence: event === "session_start" ? 0 : 1,
		context: { cwd: "/workspace" },
	};
	return event === "session_start"
		? { event, ...base, data: { reason: "startup" } }
		: { event, ...base, data: { reason: "quit" } };
}

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function trackedEventBus(): { events: EventBus; subscriptions(): number; deliveries(): number } {
	const handlers = new Map<string, Set<(value: unknown) => void>>();
	let delivered = 0;
	return {
		events: {
				emit(channel, value) {
				for (const handler of handlers.get(channel) ?? []) {
					delivered += 1;
					handler(value);
				}
			},
			on(channel, handler) {
				const channelHandlers = handlers.get(channel) ?? new Set<(value: unknown) => void>();
				channelHandlers.add(handler);
				handlers.set(channel, channelHandlers);
				return () => {
					channelHandlers.delete(handler);
					if (channelHandlers.size === 0) handlers.delete(channel);
				};
			},
		},
		subscriptions: () => [...handlers.values()].reduce((total, values) => total + values.size, 0),
		deliveries: () => delivered,
	};
}
