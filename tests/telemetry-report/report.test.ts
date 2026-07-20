import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { registerTelemetryCommand } from "../../src/telemetry-report/command.js";
import { ingestTelemetryRecords } from "../../src/telemetry-report/ingest.js";
import { calculateLiveReport } from "../../src/telemetry-report/live.js";
import { generateTelemetryReport } from "../../src/telemetry-report/output.js";
import { renderLiveTelemetry } from "../../src/telemetry-report/render-tui.js";
import { calculateTelemetryReport } from "../../src/telemetry-report/statistics.js";
import type { TelemetryCollectorSnapshot } from "../../src/telemetry/collector.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-telemetry-report-");

describe("telemetry report", () => {
	it("uses executed input, reads raw call facts, and skips malformed records", () => {
		const records = prefixRecords([
			call("valid", "custom-reader", { path: "requested.ts" }, {
				executed: { path: "executed.ts" },
				duration: 25,
				metrics: { returned: 3 },
			}),
			{ event: "tool_call", session_id: "s1", tool_call_id: "missing-fields" },
		]);
		const dataset = ingestTelemetryRecords(records, { defaultCwd: "/fallback" });
		expect(dataset.calls).toHaveLength(1);
		expect(dataset.calls[0]).toMatchObject({
			tool_name: "custom-reader",
			input: { path: "executed.ts" },
			duration_ms: 25,
			metrics: { returned: { value: 3 } },
		});
	});

	it("aggregates every tool independently, including tool-specific metrics", () => {
		const records = prefixRecords([
			call("find-fail", "find", { query: "service", path: "src" }, {
				outcome: "tool_error",
				errorCode: "NO_MATCH",
				duration: 20,
				outputTokens: 5,
				metrics: { scanned: 100, cached: false, provider: "local" },
			}),
			call("find-retry", "find", { query: "service", path: "src" }, {
				duration: 30,
				outputTokens: 7,
				metrics: { scanned: 50, cached: true, provider: "local" },
				candidates: [candidate(1, "src/a.ts", ["lexical"]), candidate(2, "src/b.ts", ["repo-map"], "related")],
				preparation: { status: "repaired", operations: ["strip_path_prefix"] },
				approval: { outcome: "policy_allow", wait_ms: 5 },
			}),
			call("read", "read", { path: "src/a.ts" }, { duration: 10, metrics: { returned_lines: 20 } }),
			call("custom", "future-tool", { value: 1 }, { metrics: { custom_score: 9 } }),
		]);
		const report = calculateTelemetryReport(records);
		const find = report.tools.find((row) => row.tool === "find");
		expect(find).toMatchObject({
			calls: 2,
			successes: 1,
			errors: 1,
			success_rate: 0.5,
			execution_ms: 50,
			execution_ms_per_call: 25,
			output_tokens: 12,
			repaired_inputs: 1,
			failure_retries: 1,
			candidates: 2,
			definition_tokens_per_call: 10,
		});
		expect(find?.outcome_counts).toEqual({ success: 1, tool_error: 1 });
		expect(find?.candidate_group_counts).toEqual({ primary: 1, related: 1 });
		expect(find?.candidate_source_counts).toEqual({ lexical: 1, "repo-map": 1 });
		expect(find?.metric_statistics).toMatchObject({
			"scanned[value]": { numeric: { samples: 2, total: 150, min: 50, max: 100, average: 75 } },
			cached: { boolean: { true: 1, false: 1 } },
			provider: { values: { local: 2 } },
		});
		expect(report.tools.find((row) => row.tool === "future-tool")?.metric_statistics).toHaveProperty("custom_score[value]");
		expect(report.tools.find((row) => row.tool === "ls")).toMatchObject({ calls: 0, unused_exposures: 1, unused_exposure_cost: 10 });
	});

	it("keeps different cohorts of the same tool in separate statistics", () => {
		const report = calculateTelemetryReport(prefixRecords([
			call("first", "find", { query: "same" }, { cohortId: "cohort-a" }),
			call("second", "find", { query: "same" }, { cohortId: "cohort-b" }),
		]));
		const find = report.tools.filter((row) => row.tool === "find");
		expect(find.map((row) => [row.cohort_id, row.calls])).toEqual([["cohort-a", 1], ["cohort-b", 1]]);
		expect(report.repeated_calls).toEqual([]);
		expect(report.tool_transitions).toEqual([
			expect.objectContaining({ from_cohort_id: "cohort-a", to_cohort_id: "cohort-b", count: 1 }),
		]);
	});

	it("falls back generically for unknown tools, reference kinds, and future events", () => {
		const partial = { ...call("future", "future-tool", { value: 1 }, {
			metrics: { custom_score: 9 },
			candidates: [{ target: { kind: "symbol", value: "Service" }, sources: [] }],
		}), context: {} };
		const report = calculateTelemetryReport(prefixRecords([
			partial,
			partial,
			base("future_event", "s1", { data: { arbitrary: true } }),
		]));

		expect(report.tools.find((row) => row.tool === "future-tool")).toMatchObject({
			calls: 1,
			candidates: 1,
			candidate_group_counts: { unknown: 1 },
			metric_statistics: { "custom_score[value]": { numeric: { samples: 1, total: 9 } } },
		});
		expect(report.metadata).toMatchObject({ partial_records: 1, duplicate_records: 1, unknown_events: 1 });
	});

	it("derives only tool-level retries and transitions", () => {
		const report = calculateTelemetryReport(prefixRecords([
			call("read-1", "read", { path: "src/a.ts" }),
			call("read-2", "read", { path: "src/a.ts" }),
			call("grep-fail", "grep", { query: "missing" }, { outcome: "tool_error" }),
			call("grep-retry", "grep", { query: "missing" }),
			call("bash", "bash", { command: "npm test" }),
		]));
		expect(report.repeated_calls).toEqual(expect.arrayContaining([
			expect.objectContaining({ previous_call_id: "read-1", call_id: "read-2", tool: "read", kind: "success_duplicate" }),
			expect.objectContaining({ previous_call_id: "grep-fail", call_id: "grep-retry", tool: "grep", kind: "failure_retry" }),
		]));
		expect(report.tool_transitions).toEqual(expect.arrayContaining([
			expect.objectContaining({ from_tool: "read", to_tool: "read", count: 1, sessions: 1 }),
			expect.objectContaining({ from_tool: "grep", to_tool: "bash", count: 1, sessions: 1 }),
		]));
		expect(report.tools.find((row) => row.tool === "grep")?.next_tools).toEqual({ bash: 1, grep: 1 });
	});

	it("derives contextual transitions and candidate conversion from later tool inputs", () => {
		const records = prefixRecords([
			call("find", "find", { query: "service" }, {
				candidates: [candidate(1, "src/a.ts", ["lexical"]), candidate(2, "src/b.ts", ["lexical"])],
			}),
			call("read", "read", { path: "src/a.ts" }),
			call("edit", "edit", { path: "src/a.ts" }, { turnId: "t2" }),
		]);
		records.splice(2, 0, turnStart("s1", "t2"));
		const report = calculateTelemetryReport(records);

		expect(report.tool_transitions).toEqual(expect.arrayContaining([
			expect.objectContaining({
				from_tool: "find",
				to_tool: "read",
				probability: 1,
				lift: 2,
				same_turn: 1,
				cross_turn: 0,
				same_target: 0,
				from_outcome_counts: { success: 1 },
				to_outcome_counts: { success: 1 },
			}),
			expect.objectContaining({ from_tool: "read", to_tool: "edit", same_turn: 0, cross_turn: 1, same_target: 1 }),
		]));
		expect(report.candidate_conversions).toEqual([
			expect.objectContaining({
				producer_tool: "find",
				source: "lexical",
				group: "primary",
				candidates: 2,
				converted: 1,
				conversion_rate: 0.5,
				top_1_conversion_rate: 1,
				top_3_conversion_rate: 0.5,
				average_converted_rank: 1,
				average_calls_to_use: 1,
				consumer_counts: { read: 1 },
			}),
		]);
		expect(report.summary).toMatchObject({ candidate_exposures: 2, candidate_conversions: 1, candidate_conversion_rate: 0.5 });
	});

	it("never links transitions or candidate consumers across session boundaries", () => {
		const records = [
			...prefixRecords([
				call("find", "find", { query: "service" }, { candidates: [candidate(1, "src/a.ts", ["lexical"])] }),
			]),
			base("session_start", "s2", { data: { reason: "startup" } }),
			turnStart("s2", "t1"),
			call("read", "read", { path: "src/a.ts" }, { sessionId: "s2" }),
		];
		const report = calculateTelemetryReport(records);
		expect(report.tool_transitions).toEqual([]);
		expect(report.candidate_conversions[0]).toMatchObject({ candidates: 1, converted: 0, conversion_rate: 0 });
		expect(report.summary).toMatchObject({ sessions: 2, candidate_exposures: 1, candidate_conversions: 0 });
	});

	it("classifies bounded failure recovery, modified retries, and A-B-A oscillations", () => {
		const report = calculateTelemetryReport(prefixRecords([
			call("grep-fail", "grep", { query: "old", path: "src" }, { outcome: "tool_error", duration: 5, outputTokens: 2 }),
			call("grep-retry", "grep", { query: "new", path: "src" }, { duration: 7, outputTokens: 3 }),
			call("bash-fail", "bash", { command: "bad" }, { outcome: "tool_error" }),
			call("read-fail", "read", { path: "src/a.ts" }, { outcome: "tool_error", duration: 11, outputTokens: 4 }),
			call("edit-success", "edit", { path: "src/a.ts" }, { duration: 13, outputTokens: 5 }),
			call("read-success", "read", { path: "src/a.ts" }),
			call("web-fail", "websearch", { query: "missing" }, { outcome: "tool_error" }),
		]));

		expect(report.failure_recoveries).toEqual(expect.arrayContaining([
			expect.objectContaining({ failed_call_id: "grep-fail", kind: "modified_retry", recovery_call_id: "grep-retry", calls_to_recovery: 1 }),
			expect.objectContaining({ failed_call_id: "bash-fail", kind: "fallback", recovery_call_id: "edit-success", calls_to_recovery: 2, recovery_execution_ms: 24, recovery_output_tokens: 9 }),
			expect.objectContaining({ failed_call_id: "web-fail", kind: "unrecovered" }),
		]));
		expect(report.near_retries).toEqual([
			expect.objectContaining({ previous_call_id: "grep-fail", call_id: "grep-retry", tool: "grep", changed_fields: ["query"] }),
		]);
		expect(report.tool_oscillations).toEqual(expect.arrayContaining([
			expect.objectContaining({ pattern: "read -> edit -> read", same_turn: true, same_target: true }),
		]));
		expect(report.summary).toMatchObject({
			failed_calls: 4,
			recovered_failures: 3,
			failure_recovery_rate: 0.75,
			modified_recoveries: 1,
			fallback_recoveries: 2,
			unrecovered_failures: 1,
			near_retries: 1,
			tool_oscillations: 1,
		});
	});

	it("writes tool-first CSV, JSON, and self-contained HTML", async () => {
		const input = path.join(temp.path, "sessions");
		const output = path.join(temp.path, "reports");
		await mkdir(input, { recursive: true });
		const records = prefixRecords([call("find", "find", { query: "a" }, { metrics: { scanned: 10 } })]);
		await writeFile(path.join(input, "one.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\nnot-json\n`, "utf8");
		const result = await generateTelemetryReport({ inputDirectory: input, outputDirectory: output, generatedAt: "2026-01-01T00:00:00.000Z" });
		expect(result.report.metadata).toMatchObject({
			parsed_lines: records.length,
			decoded_records: records.length,
			invalid_lines: 1,
			input_files: ["one.jsonl"],
			scope: "all_sessions",
			consistency: "durable_snapshot",
			complete_sessions: 0,
			open_sessions: 1,
		});
		expect((await readdir(output)).sort()).toEqual([
			"candidate_conversions.csv", "failure_recoveries.csv", "metadata.json", "near_retries.csv", "repeated_calls.csv", "report.html", "report.json",
			"summary.json", "tool_oscillations.csv", "tool_transitions.csv", "tools.csv", "tools.json", "workflow.json",
		]);
		expect(await readFile(path.join(output, "tools.csv"), "utf8")).toContain("find");
		expect(JSON.parse(await readFile(path.join(output, "tools.json"), "utf8"))).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "find", calls: 1 })]));
		expect(JSON.parse(await readFile(path.join(output, "workflow.json"), "utf8"))).toHaveProperty("candidate_conversions");
		expect(JSON.parse(await readFile(path.join(output, "report.json"), "utf8"))).toMatchObject({ summary: { calls: 1 }, metadata: { consistency: "durable_snapshot" } });
		const html = await readFile(path.join(output, "report.html"), "utf8");
		expect(html).toContain("Per-tool statistics");
		expect(html).toContain("<h2>find <small>cohort-a</small></h2>");
		expect(html).toContain("Tool metrics");
		expect(html).toContain("Session workflow analysis");
		expect(html).not.toMatch(/<script\b/iu);
	});

	it("tracks the latest session lifecycle state for completeness metadata", () => {
		const resumed = prefixRecords([]);
		resumed.push(base("session_end", "s1", { data: { reason: "quit" } }));
		const closed = calculateTelemetryReport(resumed, { generatedAt: "2026-01-01T00:00:00.000Z" });
		expect(closed.metadata).toMatchObject({ complete_sessions: 1, open_sessions: 0 });

		resumed.push(base("session_start", "s1", { data: { reason: "resume" } }));
		const reopened = calculateTelemetryReport(resumed, { generatedAt: "2026-01-01T00:00:00.000Z" });
		expect(reopened.metadata).toMatchObject({ complete_sessions: 0, open_sessions: 1 });
	});

	it("uses the same analysis for live session reports and renders bounded TUI lines", () => {
		const records = prefixRecords([
			call("find", "find", { query: "service" }, { duration: 20, outputTokens: 5 }),
			call("read", "read", { path: "src/a.ts" }, { duration: 10, outputTokens: 3 }),
		]);
		const snapshot: TelemetryCollectorSnapshot = {
			sessionId: "session-1234567890",
			records,
			revision: records.length,
			invalidLines: 1,
			lastCompletedTurn: 0,
			inProgressCalls: 1,
			writer: { pending: 2, persisted: 3, failed: 1, health_persisted: 1, health_failed: 0, last_failure_at: "2026-01-01T00:00:00.000Z" },
		};
		const live = { report: calculateLiveReport(snapshot, "2026-01-02T00:00:00.000Z"), sessionId: "session-1234567890" };
		const batch = calculateTelemetryReport(records, { generatedAt: "2026-01-02T00:00:00.000Z" });
		expect(live.report.summary).toEqual(batch.summary);
		expect(live.report.metadata).toMatchObject({
			scope: "current_session",
			consistency: "live_committed",
			last_completed_turn: 0,
			in_progress_calls: 1,
			pending_writes: 2,
			failed_writes: 1,
		});
		for (const width of [48, 110]) {
			const lines = renderLiveTelemetry(live, width);
			expect(lines.some((line) => line.includes("Collection health"))).toBe(true);
			expect(lines.every((line) => line.length <= width)).toBe(true);
		}
	});

	it("registers /telemetry and provides a compact non-TUI report", async () => {
		type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
		let command: CommandOptions | undefined;
		const notifications: Array<[string, string | undefined]> = [];
		registerTelemetryCommand({
			registerCommand(name, options) {
				expect(name).toBe("telemetry");
				command = options;
			},
		}, {
			snapshot: () => ({
				sessionId: "s1",
				records: prefixRecords([call("read", "read", { path: "src/a.ts" })]),
				revision: 1,
				invalidLines: 0,
				lastCompletedTurn: 0,
				inProgressCalls: 0,
				writer: { pending: 0, persisted: 1, failed: 0, health_persisted: 0, health_failed: 0 },
			}),
		});
		const registered = command;
		if (registered === undefined) throw new Error("telemetry command was not registered");
		await registered.handler("", {
			mode: "print",
			ui: {
				notify(message: string, type?: string) {
					notifications.push([message, type]);
				},
			},
		} as unknown as ExtensionCommandContext);
		expect(notifications).toEqual([[expect.stringContaining("1 calls"), "info"]]);
	});
});

function prefixRecords(calls: readonly object[]): object[] {
	return [
		base("session_start", "s1", { data: { reason: "startup" } }),
		{
			...base("turn_start", "s1"),
			turn_id: "t1",
			data: {
				turn_index: 0,
				tools: [
					{ name: "find", definition_tokens: { value: 20, method: "test" } },
					{ name: "grep", definition_tokens: { value: 12, method: "test" } },
					{ name: "ls", definition_tokens: { value: 10, method: "test" } },
					{ name: "read", definition_tokens: { value: 0, method: "test" } },
					{ name: "bash", definition_tokens: { value: 0, method: "test" } },
					{ name: "future-tool", definition_tokens: { value: 0, method: "test" } },
				],
				repo_map: { enabled: false },
			},
		},
		...calls,
	];
}

interface TestCandidate {
	rank?: number;
	target: { kind: string; value: string; start_line?: number; end_line?: number };
	group?: string;
	sources: string[];
}

interface CallOptions {
	cohortId?: string;
	executed?: Record<string, unknown>;
	candidates?: TestCandidate[];
	metrics?: Record<string, unknown>;
	outcome?: string;
	errorCode?: string;
	outputTokens?: number;
	duration?: number;
	truncated?: boolean;
	preparation?: { status: string; operations: string[] };
	approval?: { outcome: string; wait_ms: number };
	turnId?: string;
	sessionId?: string;
}

function call(id: string, tool: string, requested: Record<string, unknown>, options: CallOptions = {}): object {
	return {
		...base("tool_call_end", options.sessionId ?? "s1"),
		turn_id: options.turnId ?? "t1",
		tool_call_id: id,
		data: {
			turn_index: 0,
			tool: { name: tool, identity: { behavior_hash: options.cohortId ?? "cohort-a" } },
			input: {
				requested: projection(requested),
				...(options.executed === undefined ? {} : { executed: projection(options.executed) }),
			},
			annotations: {
				...(options.preparation === undefined ? {} : { preparation: options.preparation }),
				...(options.approval === undefined ? {} : { approval: options.approval }),
				execution: { duration_ms: options.duration ?? 0 },
			},
			result: {
				ok: (options.outcome ?? "success") === "success",
				outcome: options.outcome ?? "success",
				...(options.errorCode === undefined ? {} : { error: { source: "tool", code: options.errorCode } }),
				output: {
					text_chars: 0,
					estimated_tokens: { value: options.outputTokens ?? 4, method: "test" },
					truncated: options.truncated ?? false,
				},
				metrics: Object.fromEntries(Object.entries(options.metrics ?? {}).map(([name, value]) => [name, typeof value === "number"
					? { kind: "distribution", aggregation: "distribution", unit: "value", value }
					: { kind: "categorical", aggregation: "count_by_value", value }])),
				references: (options.candidates ?? []).map((item) => ({
					relation: "candidate",
					global_rank: item.rank,
					kind: item.target.kind,
					value: item.target.value,
					group: item.group,
					sources: item.sources.map((id) => ({ id })),
					resource: { start_line: item.target.start_line, end_line: item.target.end_line },
				})),
			},
		},
	};
}

function turnStart(sessionId: string, turnId: string): object {
	return {
		...base("turn_start", sessionId),
		turn_id: turnId,
		data: {
			turn_index: 0,
			tools: ["find", "read", "edit"].map((name) => ({ name, definition_tokens: { value: 0, method: "test" } })),
			repo_map: { enabled: false },
		},
	};
}

function candidate(rank: number, candidatePath: string, sources: string[], group = "primary"): TestCandidate {
	return { rank, target: { kind: "file", value: candidatePath }, group, sources };
}

let recordSequence = 0;

function base(event: string, sessionId: string, extra: Record<string, unknown> = {}): object {
	const sequence = recordSequence++;
	return {
		event,
		id: `record-${sequence}`,
		timestamp: "2026-01-01T00:00:00.000Z",
		session_id: sessionId,
		sequence,
		context: { cwd: "/workspace" },
		...extra,
	};
}

function projection(value: Record<string, unknown>): object {
	const references = [];
	if (typeof value["path"] === "string") references.push({ relation: "target", kind: "path", value: value["path"] });
	if (typeof value["url"] === "string") references.push({ relation: "target", kind: "url", value: value["url"] });
	return { value, references };
}
