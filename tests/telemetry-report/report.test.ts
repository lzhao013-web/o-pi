import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ingestTelemetryRecords } from "../../src/telemetry-report/ingest.js";
import { calculateLiveReport } from "../../src/telemetry-report/live.js";
import { generateTelemetryReport, renderReport } from "../../src/telemetry-report/output.js";
import { renderLiveTelemetry } from "../../src/telemetry-report/render-tui.js";
import { calculateTelemetryReport } from "../../src/telemetry-report/statistics.js";
import type { AnalysisQuery } from "../../src/telemetry-report/types.js";
import type { TelemetryCollectorSnapshot } from "../../src/telemetry/collector.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-telemetry-report-");

describe("telemetry analysis", () => {
	it("keeps behavior and instrumentation as strict slices and defaults to the latest active slice", () => {
		const records = scenario([
			...call("old", "find", { behavior: "b1", instrumentation: "i1", at: 1 }),
			...call("new-mouth", "find", { behavior: "b2", instrumentation: "i1", at: 2 }),
			...call("new-measure", "find", { behavior: "b2", instrumentation: "i2", at: 3 }),
		]);
		const report = calculateTelemetryReport(records);
		expect(report.inventory.slices).toHaveLength(3);
		expect(report.current_slices).toHaveLength(1);
		expect(report.current_slices[0]).toMatchObject({ behavior_hash: "b2", instrumentation_hash: "i2", calls: 1 });
		expect(report.inventory.summary).not.toHaveProperty("success_rate");
	});

	it("compares explicit behavior slices and marks instrumentation and environment shifts", () => {
		const records = scenario([
			...call("base", "find", { behavior: "b1", instrumentation: "i1", environment: "linux", at: 1 }),
			...call("candidate", "find", { behavior: "b2", instrumentation: "i2", environment: "darwin", at: 2 }),
		]);
		const inventory = calculateTelemetryReport(records, { query: { latest: false } }).inventory.slices;
		const baselineId = inventory.find((slice) => slice.behavior_hash === "b1")?.slice_id;
		const candidateId = inventory.find((slice) => slice.behavior_hash === "b2")?.slice_id;
		if (baselineId === undefined || candidateId === undefined) throw new Error("missing comparison slice");
		const query: AnalysisQuery = {
			latest: false,
			slice_ids: inventory.map((slice) => slice.slice_id),
			baseline_slice_id: baselineId,
			candidate_slice_id: candidateId,
		};
		const report = calculateTelemetryReport(records, { query });
		expect(report.comparison?.comparability).toMatchObject({ comparable: false, reasons: ["different_instrumentation", "material_environment_shift"] });
		expect(report.comparison?.comparability.metric_flags.duration_ms).toMatchObject({ comparable: false });
	});

	it("filters environment through the unified query without changing slice identity", () => {
		const records = scenario([
			...call("linux", "read", { behavior: "b1", instrumentation: "i1", environment: "linux", project: "/alpha", at: 1 }),
			...call("darwin", "read", { behavior: "b1", instrumentation: "i1", environment: "darwin", project: "/beta", at: 2 }),
		]);
		const all = calculateTelemetryReport(records, { query: { latest: false } });
		const linux = Object.keys(all.inventory.dimensions.environments).find((value) => value.startsWith("linux/"));
		if (linux === undefined) throw new Error("missing linux environment");
		const filtered = calculateTelemetryReport(records, { query: { environments: [linux], latest: false } });
		expect(filtered.inventory.summary.calls).toBe(1);
		expect(filtered.facts.calls[0]?.context.project).toBe("/alpha");
		expect(filtered.inventory.slices[0]?.slice_id).toBe(all.inventory.slices[0]?.slice_id);
	});

	it("preserves canonical context, ranks, source metadata and resource revisions", () => {
		const records = scenario(call("find", "find", {
			behavior: "b1", instrumentation: "i1", interaction: "interaction-7", batch: "batch-2", branch: "lineage-a", at: 1,
			candidates: [reference("candidate", "region", "/workspace/a.ts", { start: 10, end: 20, revision: "r1", globalRank: 3, groupRank: 1 })],
		}));
		const dataset = ingestTelemetryRecords(records);
		expect(dataset.calls[0]).toMatchObject({
			context: {
				collector_contract: "collector-v1",
				model: { provider: "openai", id: "gpt-test" },
				thinking: "high",
				toolset: { hash: "tools-v1" },
				project: "/workspace",
				interaction: "interaction-7",
				branch: { lineage_hash: "lineage-a" },
				tool_batch: { id: "batch-2" },
			},
			candidates: [{
				global_rank: 3,
				group_rank: 1,
				sources: [{ id: "ranker", family: "search", rank: 2 }],
				resource: { revision: "r1", start_line: 10, end_line: 20 },
			}],
		});
	});

	it("does not create causal transitions between a parallel batch or across branches", () => {
		const parallel = scenario([
			...call("a", "find", { behavior: "b1", instrumentation: "i1", batch: "parallel", batchIndex: 0, executeFrom: 10, executeTo: 30, at: 1 }),
			...call("b", "read", { behavior: "b1", instrumentation: "i1", batch: "parallel", batchIndex: 1, executeFrom: 12, executeTo: 25, at: 2 }),
		]);
		expect(calculateTelemetryReport(parallel).workflow.transitions).toEqual([]);
		expect(calculateTelemetryReport(parallel).workflow.excluded).toMatchObject({ same_parallel_batch: 1 });

		const branches = scenario([
			...call("left", "find", { behavior: "b1", instrumentation: "i1", branch: "left", at: 1 }),
			...call("right", "read", { behavior: "b1", instrumentation: "i1", branch: "right", at: 2 }),
		]);
		expect(calculateTelemetryReport(branches).workflow.transitions).toEqual([]);
	});

	it("matches candidate regions by overlap and treats whole-file access as weak conversion", () => {
		const records = scenario([
			...call("producer", "find", {
				behavior: "b1", instrumentation: "i1", at: 1,
				candidates: [
					reference("candidate", "region", "/workspace/a.ts", { start: 10, end: 20, globalRank: 1 }),
					reference("candidate", "region", "/workspace/b.ts", { start: 30, end: 40, globalRank: 2 }),
				],
			}),
			...call("overlap", "read", { behavior: "r1", instrumentation: "ri", at: 2, inputs: [reference("target", "region", "/workspace/a.ts", { start: 15, end: 25 })] }),
			...call("whole", "read", { behavior: "r1", instrumentation: "ri", at: 3, inputs: [reference("target", "file", "/workspace/b.ts")] }),
		]);
		const conversion = calculateTelemetryReport(records).workflow.candidate_conversions[0];
		expect(conversion).toMatchObject({ candidates: 2, strong_conversions: 1, weak_conversions: 1, strong_conversion_rate: 0.5, weak_conversion_rate: 0.5 });
	});

	it("does not classify a repeated call after an observed target modification or revision change", () => {
		const targetR1 = reference("target", "file", "/workspace/a.ts", { revision: "r1" });
		const targetR2 = reference("target", "file", "/workspace/a.ts", { revision: "r2" });
		const records = scenario([
			...call("read-1", "read", { behavior: "b1", instrumentation: "i1", at: 1, inputs: [targetR1] }),
			...call("edit", "edit", { behavior: "e1", instrumentation: "i1", at: 2, inputs: [targetR1] }),
			...call("read-2", "read", { behavior: "b1", instrumentation: "i1", at: 3, inputs: [targetR2] }),
		]);
		const workflow = calculateTelemetryReport(records).workflow;
		expect(workflow.repeated_calls).toEqual([]);
		expect(workflow.excluded.repeat_after_resource_change).toBe(1);
	});

	it("aggregates metrics from declared semantics and reports sample and missing rates", () => {
		const records = scenario([
			...call("one", "bash", { behavior: "b1", instrumentation: "i1", at: 1, metrics: {
				exit_code: { kind: "categorical", aggregation: "count_by_value", value: 0 },
				bytes: { kind: "bytes", aggregation: "sum", unit: "byte", value: 10 },
			} }),
			...call("two", "bash", { behavior: "b1", instrumentation: "i1", at: 2, metrics: {
				exit_code: { kind: "categorical", aggregation: "count_by_value", value: 1 },
				bytes: { kind: "bytes", aggregation: "sum", unit: "byte", value: 30 },
			} }),
			...call("three", "bash", { behavior: "b1", instrumentation: "i1", at: 3 }),
		]);
		const metrics = calculateTelemetryReport(records).current_slices[0]?.metrics;
		expect(metrics?.exit_code).toMatchObject({ samples: 2, missing: 1, missing_rate: 0.333333, frequencies: { "0": 1, "1": 1 } });
		expect(metrics?.bytes).toMatchObject({ samples: 2, missing: 1, numeric: { total: 40, mean: 20, p50: 10, p95: 30 } });
	});

	it("derives as_of from data and exposes sequence, lifecycle, projection and writer failures", () => {
		const records = scenario(call("end-only", "read", { behavior: "b1", instrumentation: "i1", at: 4, projectionFailed: true }), false);
		records.push(event("collection_health", "s1", 20, { data: { issue: "writer_failure" } }));
		const report = calculateTelemetryReport(records, { generatedAt: "2030-01-01T00:00:00.000Z" });
		expect(report.metadata.as_of).toBe(timestamp(20));
		expect(report.metadata.generated_at).toBe("2030-01-01T00:00:00.000Z");
		expect(report.collection_health.status).toBe("critical");
		expect(report.collection_health.counts).toMatchObject({ sequence_gaps: expect.any(Number), missing_starts: 1, projection_failures: 1, writer_failures: 1 });
	});

	it("writes one complete JSON source, an interactive self-contained HTML, and two flat exports", async () => {
		const input = path.join(temp.path, "sessions");
		const output = path.join(temp.path, "reports");
		await mkdir(input, { recursive: true });
		await mkdir(output, { recursive: true });
		await writeFile(path.join(output, "tools.csv"), "stale\n", "utf8");
		const records = scenario(call("find", "find", { behavior: "b1", instrumentation: "i1", at: 1 }));
		await writeFile(path.join(input, "one.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
		const result = await generateTelemetryReport({ inputDirectory: input, outputDirectory: output });
		expect((await readdir(output)).sort()).toEqual(["calls.csv", "report.html", "report.json", "slices.csv"]);
		expect(JSON.parse(await readFile(path.join(output, "report.json"), "utf8"))).toMatchObject({ metadata: { schema_version: 1, analysis_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
		const html = await readFile(path.join(output, "report.html"), "utf8");
		expect(html).toContain("Data inventory");
		expect(html).toContain("Current slices");
		expect(html).toContain("Slice comparison");
		expect(html).toContain("Collection health");
		expect(html).toContain('id="report-data"');
		expect(renderReport(result.report)).toContain("Workflow");
	});

	it("uses the same kernel for live reports and bounds TUI lines", () => {
		const records = scenario(call("read", "read", { behavior: "b1", instrumentation: "i1", at: 1 }));
		const snapshot: TelemetryCollectorSnapshot = {
			sessionId: "session-1234567890", records, revision: records.length, invalidLines: 0, lastCompletedTurn: 0, inProgressCalls: 1,
			writer: { pending: 2, persisted: records.length, failed: 0, health_persisted: 0, health_failed: 0 },
		};
		const live = { report: calculateLiveReport(snapshot, "2030-01-01T00:00:00.000Z"), sessionId: "session-1234567890" };
		expect(live.report.inventory.summary).toEqual(calculateTelemetryReport(records).inventory.summary);
		for (const width of [48, 110]) expect(renderLiveTelemetry(live, width).every((line) => line.length <= width)).toBe(true);
	});
});

interface ReferenceOptions { start?: number; end?: number; revision?: string; globalRank?: number; groupRank?: number }
interface CallOptions {
	behavior: string;
	instrumentation: string;
	at: number;
	environment?: string;
	project?: string;
	interaction?: string;
	branch?: string;
	batch?: string;
	batchIndex?: number;
	executeFrom?: number;
	executeTo?: number;
	inputs?: object[];
	candidates?: object[];
	metrics?: Record<string, object>;
	projectionFailed?: boolean;
}

let serial = 0;

function scenario(callEvents: readonly object[], includeStarts = true): object[] {
	const first = event("session_start", "s1", 0, { data: { reason: "startup" } });
	const turn = event("turn_start", "s1", 1, {
		turn_id: "t1", interaction_id: "interaction-1",
		data: { turn_index: 0, tools: [], repo_map: { enabled: false } },
	});
	return [first, turn, ...(includeStarts ? callEvents : callEvents.filter((record) => (record as { event?: string }).event !== "tool_call_start"))];
}

function call(id: string, tool: string, options: CallOptions): object[] {
	const startSequence = 2 + serial * 2;
	serial += 1;
	const context = {
		cwd: options.project ?? "/workspace",
		model: { provider: "openai", id: "gpt-test" },
		thinking_level: "high",
		toolset: { active: [tool], hash: "tools-v1" },
		host: { pi_version: "1.0.0", mode: "tui", platform: options.environment ?? "linux", arch: "x64", node_version: "v24" },
		branch: { leaf_id: `${options.branch ?? "lineage-a"}-leaf`, lineage_hash: options.branch ?? "lineage-a", depth: 1 },
	};
	const dimensions = {
		interaction_id: options.interaction ?? "interaction-1",
		...(options.batch === undefined ? {} : { tool_batch_id: options.batch, batch_size: 2, batch_index: options.batchIndex ?? 0 }),
	};
	const identity = { behavior_hash: options.behavior, telemetry_hash: options.instrumentation, definition_hash: "d1", config_hash: "c1" };
	const start = event("tool_call_start", "s1", startSequence, { turn_id: "t1", tool_call_id: id, context, ...dimensions, data: { turn_index: 0, tool: { name: tool, identity } } });
	const end = event("tool_call_end", "s1", startSequence + 1, {
		turn_id: "t1", tool_call_id: id, context, ...dimensions, timestamp: timestamp(options.at),
		data: {
			turn_index: 0,
			tool: { name: tool, identity },
			timing: {
				call_started_at: timestamp(options.at),
				execution_started_at: timestamp(options.executeFrom ?? options.at),
				execution_ended_at: timestamp(options.executeTo ?? options.at + 0.1),
				execution_duration_ms: 10,
				call_duration_ms: 12,
			},
			input: { requested: { value: { path: "/workspace/a.ts" }, references: options.inputs ?? [reference("target", "file", "/workspace/a.ts")] } },
			annotations: { execution: { duration_ms: 10 }, ...(options.projectionFailed ? { projection_failed: true } : {}) },
			result: {
				ok: true, outcome: "success",
				output: { text_chars: 4, estimated_tokens: { value: 1, method: "test" }, truncated: false },
				metrics: options.metrics ?? {}, references: options.candidates ?? [],
			},
		},
	});
	return [start, end];
}

function reference(relation: string, kind: string, value: string, options: ReferenceOptions = {}): object {
	return {
		relation, kind, value,
		...(relation === "candidate" ? { group: "primary", global_rank: options.globalRank ?? 1 } : {}),
		...(options.groupRank === undefined ? {} : { group_rank: options.groupRank }),
		sources: relation === "candidate" ? [{ id: "ranker", family: "search", source_rank: 2 }] : [],
		resource: {
			...(options.start === undefined ? {} : { start_line: options.start }),
			...(options.end === undefined ? {} : { end_line: options.end }),
			...(options.revision === undefined ? {} : { revision: options.revision }),
		},
	};
}

function event(name: string, sessionId: string, sequence: number, extra: Record<string, unknown>): object {
	return {
		event: name,
		id: `${name}-${sequence}-${serial++}`,
		timestamp: timestamp(sequence),
		session_id: sessionId,
		sequence,
		collector_contract: "collector-v1",
		context: { cwd: "/workspace", host: { platform: "linux", arch: "x64" } },
		...extra,
	};
}

function timestamp(second: number): string {
	return new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
}
