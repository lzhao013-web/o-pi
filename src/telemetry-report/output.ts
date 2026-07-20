import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { readTelemetryDirectory } from "../telemetry/jsonl-reader.js";
import { calculateTelemetryReport } from "./statistics.js";
import type { ReportSnapshot } from "./types.js";

const CSV_TABLES = [
	["tools.csv", "tools", ["tool", "cohort_id", "sessions", "calls", "successes", "errors", "unknown_results", "success_rate", "outcome_counts", "error_code_counts", "exposure_turns", "unused_exposures", "unused_exposure_cost", "definition_tokens", "definition_tokens_per_call", "output_tokens", "output_tokens_per_call", "truncated_results", "execution_ms", "execution_ms_per_call", "accepted_inputs", "repaired_inputs", "invalid_inputs", "repair_counts", "approval_counts", "approval_wait_ms", "projection_failures", "candidates", "candidates_per_call", "candidate_group_counts", "candidate_source_counts", "success_duplicates", "failure_retries", "previous_tools", "next_tools", "metric_statistics"]],
	["tool_transitions.csv", "tool_transitions", ["from_tool", "from_cohort_id", "to_tool", "to_cohort_id", "count", "sessions", "probability", "lift", "same_turn", "cross_turn", "same_target", "from_outcome_counts", "to_outcome_counts"]],
	["repeated_calls.csv", "repeated_calls", ["session_id", "previous_call_id", "call_id", "tool", "cohort_id", "kind"]],
	["candidate_conversions.csv", "candidate_conversions", ["producer_tool", "producer_cohort_id", "source", "group", "candidates", "converted", "conversion_rate", "exposed_sessions", "converted_sessions", "top_1_candidates", "top_1_converted", "top_1_conversion_rate", "top_3_candidates", "top_3_converted", "top_3_conversion_rate", "average_converted_rank", "average_calls_to_use", "consumer_counts"]],
	["failure_recoveries.csv", "failure_recoveries", ["session_id", "failed_call_id", "failed_tool", "failure_outcome", "kind", "recovery_call_id", "recovery_tool", "calls_to_recovery", "recovery_execution_ms", "recovery_output_tokens"]],
	["near_retries.csv", "near_retries", ["session_id", "previous_call_id", "call_id", "tool", "previous_outcome", "outcome", "changed_fields"]],
	["tool_oscillations.csv", "tool_oscillations", ["session_id", "first_call_id", "middle_call_id", "last_call_id", "pattern", "same_turn", "same_target", "outcomes"]],
] as const;

export interface GenerateTelemetryReportOptions {
	inputDirectory?: string;
	outputDirectory?: string;
	generatedAt?: string;
}

export interface GenerateTelemetryReportResult {
	report: ReportSnapshot;
	output_directory: string;
}

export async function generateTelemetryReport(options: GenerateTelemetryReportOptions = {}): Promise<GenerateTelemetryReportResult> {
	const inputDirectory = path.resolve(options.inputDirectory ?? path.join(os.homedir(), ".pi", "telemetry", "sessions"));
	const outputDirectory = path.resolve(options.outputDirectory ?? path.join(os.homedir(), ".pi", "telemetry", "reports", "latest"));
	const input = await readTelemetryDirectory(inputDirectory);
	const report = calculateTelemetryReport(input.records, {
		...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
		scope: "all_sessions",
		consistency: "durable_snapshot",
		inputDirectory,
		inputFiles: input.files.map((file) => path.relative(inputDirectory, file).replace(/\\/gu, "/")),
		invalidLines: input.invalidLines,
	});
	await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
	const writes: Promise<void>[] = [];
	for (const [fileName, key, columns] of CSV_TABLES) {
		writes.push(writeSnapshotFile(outputDirectory, fileName, toCsv(report[key], columns)));
	}
	writes.push(writeSnapshotFile(outputDirectory, "summary.json", `${JSON.stringify(report.summary, null, 2)}\n`));
	writes.push(writeSnapshotFile(outputDirectory, "metadata.json", `${JSON.stringify(report.metadata, null, 2)}\n`));
	writes.push(writeSnapshotFile(outputDirectory, "tools.json", `${JSON.stringify(report.tools, null, 2)}\n`));
	writes.push(writeSnapshotFile(outputDirectory, "workflow.json", `${JSON.stringify({
		tool_transitions: report.tool_transitions,
		candidate_conversions: report.candidate_conversions,
		failure_recoveries: report.failure_recoveries,
		near_retries: report.near_retries,
		tool_oscillations: report.tool_oscillations,
	}, null, 2)}\n`));
	writes.push(writeSnapshotFile(outputDirectory, "report.html", renderReport(report)));
	await Promise.all(writes);
	// The complete single-file artifact is published last and acts as the generation commit point.
	await writeSnapshotFile(outputDirectory, "report.json", `${JSON.stringify(report, null, 2)}\n`);
	return { report, output_directory: outputDirectory };
}

export function toCsv(rows: readonly object[], columns: readonly string[]): string {
	const lines = [columns.map(csvCell).join(",")];
	for (const row of rows) lines.push(columns.map((column) => csvCell(Reflect.get(row, column))).join(","));
	return `${lines.join("\n")}\n`;
}

export function renderReport(report: ReportSnapshot): string {
	const cards = [
		["Sessions", report.summary.sessions],
		["Tools", report.summary.tools],
		["Calls", report.summary.calls],
		["Success rate", percent(report.summary.success_rate)],
		["Errors", report.summary.errors],
		["Unknown results", report.summary.unknown_results],
		["Failure retries", report.summary.failure_retries],
		["Near retries", report.summary.near_retries],
		["Failure recovery", percent(report.summary.failure_recovery_rate)],
		["Candidate conversion", percent(report.summary.candidate_conversion_rate)],
		["A-B-A oscillations", report.summary.tool_oscillations],
		["Output tokens", report.summary.output_tokens],
		["Execution ms", report.summary.execution_ms],
	];
	const comparisonColumns = ["tool", "cohort_id", "calls", "success_rate", "errors", "unknown_results", "execution_ms_per_call", "output_tokens_per_call", "repaired_inputs", "failure_retries", "candidates", "unused_exposures"] as const;
	const supportingTables = CSV_TABLES.filter(([, key]) => key !== "tools")
		.map(([fileName, key, columns]) => `<h3>${html(fileName.replace(/\.csv$/u, "").replace(/_/gu, " "))}</h3>\n${htmlTable(report[key], columns)}`).join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi tool behavior report</title>
<style>
:root{color-scheme:light dark;font:14px/1.45 system-ui,sans-serif}body{max-width:1600px;margin:auto;padding:24px;background:#101317;color:#e8edf2}h1,h2,h3{margin:.5em 0}.muted{color:#9ba8b4}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:16px 0}.card,.tool{background:#192028;border:1px solid #303b46;border-radius:8px;padding:12px}.card b{display:block;font-size:1.5em}.tool{margin:20px 0;padding:18px}.tool h2{font-family:ui-monospace,monospace}.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.table{overflow:auto;border:1px solid #303b46;border-radius:8px;margin-bottom:24px}table{border-collapse:collapse;width:100%;background:#151a20}th,td{padding:7px 9px;border-bottom:1px solid #2a333d;text-align:left;white-space:nowrap}th{position:sticky;top:0;background:#222a33}tbody tr:hover{background:#202832}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#151a20;border:1px solid #303b46;padding:12px;border-radius:8px}@media(prefers-color-scheme:light){body{background:#f6f8fa;color:#1f2328}.card,.tool,table,pre{background:#fff}.table,.card,.tool,pre{border-color:#d0d7de}th{background:#f0f3f6}th,td{border-color:#d8dee4}tbody tr:hover{background:#f5f7f9}.muted{color:#59636e}}
</style>
</head>
<body>
<h1>Pi tool behavior report</h1>
<p class="muted">Generated ${html(report.metadata.generated_at)} from ${report.metadata.input_files.length} telemetry JSONL file(s); ${report.metadata.complete_sessions} complete and ${report.metadata.open_sessions} open session(s); ${report.metadata.invalid_lines} invalid line(s), ${report.metadata.partial_records} partial record(s), ${report.metadata.unknown_events} unknown event(s).</p>
<section class="cards">${cards.map(([label, value]) => `<div class="card"><span>${html(label)}</span><b>${html(value)}</b></div>`).join("")}</section>
<h2>Tool comparison</h2>
${htmlTable(report.tools, comparisonColumns)}
<h2>Per-tool statistics</h2>
	${report.tools.map(renderTool).join("\n")}
	<h2>Session workflow analysis</h2>
	${supportingTables}
<h2>Summary</h2>
<pre>${html(JSON.stringify(report.summary, null, 2))}</pre>
<h2>Metadata</h2>
<pre>${html(JSON.stringify(report.metadata, null, 2))}</pre>
</body>
</html>
`;
}

async function writeSnapshotFile(directory: string, fileName: string, content: string): Promise<void> {
	const destination = path.join(directory, fileName);
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, destination);
}

function csvCell(value: unknown): string {
	const text = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
	return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function htmlTable(rows: readonly object[], columns: readonly string[]): string {
	const head = columns.map((column) => `<th>${html(column)}</th>`).join("");
	const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${html(Reflect.get(row, column))}</td>`).join("")}</tr>`).join("");
	return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderTool(tool: ReportSnapshot["tools"][number]): string {
	const cards = [
		["Calls", tool.calls],
		["Success rate", percent(tool.success_rate)],
		["Errors", tool.errors],
		["Unknown results", tool.unknown_results],
		["Avg execution ms", tool.execution_ms_per_call],
		["Output tokens/call", tool.output_tokens_per_call],
		["Repaired inputs", tool.repaired_inputs],
		["Failure retries", tool.failure_retries],
		["Candidates", tool.candidates],
	];
	const facts = {
		outcomes: tool.outcome_counts,
		error_codes: tool.error_code_counts,
		repairs: tool.repair_counts,
		approvals: tool.approval_counts,
		candidate_groups: tool.candidate_group_counts,
		candidate_sources: tool.candidate_source_counts,
		previous_tools: tool.previous_tools,
		next_tools: tool.next_tools,
	};
	return `<section class="tool"><h2>${html(tool.tool)} <small>${html(tool.cohort_id)}</small></h2><div class="cards">${cards.map(([label, value]) => `<div class="card"><span>${html(label)}</span><b>${html(value)}</b></div>`).join("")}</div><div class="facts"><div><h3>Breakdowns and flow</h3><pre>${html(JSON.stringify(facts, null, 2))}</pre></div><div><h3>Tool metrics</h3><pre>${html(JSON.stringify(tool.metric_statistics, null, 2))}</pre></div></div></section>`;
}

function percent(value: number): string {
	return `${Math.round(value * 10_000) / 100}%`;
}

function html(value: unknown): string {
	return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}
