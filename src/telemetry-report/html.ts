import type {
	CandidateRankingCoreStatistics,
	CandidateRankingReport,
	RateSummary,
	TelemetryReport,
	ToolStatistics,
} from "./types.js";

export function renderTelemetryHtml(report: TelemetryReport): string {
	const totalSuccess = report.tools.reduce((sum, tool) => sum + tool.success_rate.numerator, 0);
	const totalCalls = report.tools.reduce((sum, tool) => sum + tool.calls, 0);
	const totalErrors = report.tools.reduce((sum, tool) => sum + tool.error_rate.numerator, 0);
	const successRate = rate(totalSuccess, totalCalls);
	const successTone = successRate === undefined ? "" : successRate >= 0.9 ? "good" : successRate < 0.7 ? "bad" : "warning";
	const latestRuns = [...report.runs].reverse().slice(0, 20);
	const hiddenRuns = Math.max(0, report.runs.length - latestRuns.length);

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi telemetry report</title><style>
:root{color-scheme:light dark;--bg:#f5f7fb;--surface:#fff;--surface-muted:#f0f3f8;--text:#172033;--muted:#657085;--line:#dce2ec;--accent:#5b5bd6;--accent-soft:#ececff;--green:#16845b;--green-soft:#ddf5e9;--red:#c43d52;--red-soft:#ffeaee;--amber:#a86a00;--amber-soft:#fff1d6;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#10131b;--surface:#181d28;--surface-muted:#222938;--text:#edf1f8;--muted:#9ca8bc;--line:#30394a;--accent:#9b9bf6;--accent-soft:#303052;--green:#5bd49e;--green-soft:#173b2d;--red:#ff8497;--red-soft:#48232d;--amber:#f3bd58;--amber-soft:#44351d}}
*{box-sizing:border-box}body{max-width:1280px;margin:0 auto;padding:32px 24px 56px;background:var(--bg);color:var(--text)}h1,h2,h3{line-height:1.2;margin:0}h1{font-size:30px;letter-spacing:-.02em}h2{font-size:20px;margin-bottom:16px}h3{font-size:15px}.subtitle,.muted{color:var(--muted)}.subtitle{margin:8px 0 0}.header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:26px}.timestamp{text-align:right;color:var(--muted);font-size:12px}.timestamp strong{display:block;color:var(--text);font-size:13px;font-weight:600;margin-top:3px}.cards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:28px}.card,.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 2px 8px #1720330b}.card{padding:16px}.card-label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.card-value{font-size:25px;font-weight:700;margin-top:5px;letter-spacing:-.02em}.card-detail{color:var(--muted);font-size:12px;margin-top:2px}.section{margin-top:30px}.panel{overflow:hidden}.panel-header{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:16px}.panel-body{padding:18px}table{border-collapse:collapse;width:100%;text-align:left}th{color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}th,td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:var(--surface-muted)}td:not(:first-child),th:not(:first-child){text-align:right}.tool-name{font-weight:650}.number{font-variant-numeric:tabular-nums;white-space:nowrap}.rate{min-width:104px}.rate-text{display:flex;justify-content:flex-end;gap:7px;align-items:center}.bar{height:5px;width:76px;background:var(--surface-muted);border-radius:99px;overflow:hidden;margin-top:5px;margin-left:auto}.bar span{display:block;height:100%;background:var(--accent);border-radius:inherit}.good{color:var(--green)}.bad{color:var(--red)}.warning{color:var(--amber)}.badge{display:inline-block;padding:2px 8px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:600}.badge.good{background:var(--green-soft)}.badge.bad{background:var(--red-soft)}.grid-4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.stat{padding:15px;background:var(--surface-muted);border-radius:9px}.stat-label{color:var(--muted);font-size:12px}.stat-value{font-size:21px;font-weight:700;margin-top:3px}.stat-detail{font-size:12px;color:var(--muted)}.split{display:grid;grid-template-columns:1fr 1fr;gap:16px}.empty{padding:24px;text-align:center;color:var(--muted)}.note{padding:11px 13px;background:var(--accent-soft);border-radius:8px;color:var(--muted);font-size:13px;margin-bottom:14px}.note strong{color:var(--text)}.list-table td:first-child{font-weight:550}.runs td:first-child{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.footer{margin-top:30px;color:var(--muted);font-size:12px}.details{margin-top:12px}.details summary{cursor:pointer;color:var(--muted);font-size:12px}.details-content{margin-top:10px;display:grid;gap:5px;word-break:break-word}.details-content code{font-size:12px}.query{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.query .badge{font-weight:500;background:var(--surface-muted);color:var(--muted)}
@media(max-width:900px){.cards{grid-template-columns:repeat(3,minmax(0,1fr))}.grid-4{grid-template-columns:repeat(2,minmax(0,1fr))}.split{grid-template-columns:1fr}}
@media(max-width:600px){body{padding:22px 14px 40px}.header{display:block}.timestamp{text-align:left;margin-top:12px}.cards,.grid-3,.grid-4{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{overflow-x:auto}table{min-width:700px}.split table{min-width:0}.panel-header{min-width:0}}
</style></head><body>
<header class="header"><div><h1>Pi telemetry</h1><p class="subtitle">A readable summary of local tool activity</p>${renderQuery(report)}</div><div class="timestamp">Generated<strong>${escapeHtml(formatTimestamp(report.metadata.generated_at))}</strong></div></header>
<section class="cards">${metricCard("Runs", report.inventory.runs, `${report.inventory.sessions} sessions`)}${metricCard("Tool calls", report.inventory.calls, `${report.inventory.tools} tools`)}${metricCard("Success rate", percentage(successRate), `${totalSuccess} of ${totalCalls} calls`, successTone)}${metricCard("Failures", totalErrors, totalErrors === 0 ? "No failed calls" : "calls with an error", totalErrors === 0 ? "good" : "bad")}${metricCard("Edit calls", report.edit.calls, `${report.edit.batches.multi_file_batches} multi-file batches`)}</section>
<section class="section"><div class="panel"><div class="panel-header"><h2>Tool performance</h2><span class="muted">Latency and output are summarized per tool</span></div><div class="panel-body"><table><thead><tr><th>Tool</th><th>Calls</th><th>Success</th><th>Errors</th><th>p50 latency</th><th>p95 latency</th><th>Avg output</th><th>Truncated</th><th>Repaired</th></tr></thead><tbody>${report.tools.length === 0 ? emptyRow(9, "No tool calls in this report") : report.tools.map(renderToolRow).join("")}</tbody></table></div></div></section>
<section class="section"><h2>Edit: single vs multi-file</h2><div class="split"><div class="panel"><div class="panel-header"><h3>What happened</h3></div><div class="panel-body grid-4">${stat("Total edits", report.edit.calls)}${stat("Successful", report.edit.successful_calls, "good")}${stat("Failed", report.edit.failed_calls, report.edit.failed_calls === 0 ? "good" : "bad")}${stat("No change", report.edit.no_change_calls)}</div></div><div class="panel"><div class="panel-header"><h3>Batch opportunities</h3></div><div class="panel-body grid-4">${stat("Batches", report.edit.batches.batches)}${stat("Multi-file", report.edit.batches.multi_file_batches)}${stat("Partial failures", report.edit.batches.partial_failure_batches, report.edit.batches.partial_failure_batches === 0 ? "good" : "warning")}${stat("Calls avoidable", report.edit.batches.potential_call_reduction, report.edit.batches.potential_call_reduction > 0 ? "good" : "")}</div></div></div></section>
<section class="section"><h2>Candidate ranking <small class="muted">(heuristic)</small></h2><div class="panel"><div class="panel-body">${renderCandidateRanking(report.candidate_ranking)}</div></div></section>
<section class="section"><div class="panel"><div class="panel-header"><h2>Recent runs</h2><span class="muted">${hiddenRuns > 0 ? `Showing latest ${latestRuns.length} of ${report.runs.length}` : `${report.runs.length} total`}</span></div>${renderRuns(latestRuns)}</div></section>
<footer class="footer">Parsed ${report.metadata.parsed_records} records from ${report.metadata.input_files.length} file${report.metadata.input_files.length === 1 ? "" : "s"}. ${report.metadata.invalid_lines} invalid line${report.metadata.invalid_lines === 1 ? "" : "s"} skipped.${renderFiles(report)}</footer>
</body></html>\n`;
}

export function formatTelemetrySummary(report: TelemetryReport): string {
	return `Telemetry: ${report.inventory.calls} calls · edit multi-file batches ${report.edit.batches.multi_file_batches}/${report.edit.batches.batches}`
		+ ` · candidates ${report.candidate_ranking.converted_candidates}/${report.candidate_ranking.candidates}`;
}

function renderToolRow(tool: ToolStatistics): string {
	return `<tr><td><span class="tool-name">${escapeHtml(tool.tool)}</span></td><td class="number">${tool.calls}</td><td class="rate">${renderRate(tool.success_rate)}</td><td class="number ${tool.error_rate.numerator > 0 ? "bad" : "good"}">${formatRate(tool.error_rate)}</td><td class="number">${formatMs(tool.duration_ms.p50)}</td><td class="number">${formatMs(tool.duration_ms.p95)}</td><td class="number">${formatChars(tool.output_chars.mean)}</td><td class="number">${formatRate(tool.truncation_rate)}</td><td class="number">${formatRate(tool.repair.repaired_rate)}</td></tr>`;
}

function renderCandidateRanking(report: CandidateRankingReport): string {
	const summary = report as CandidateRankingCoreStatistics;
	return `<div class="note"><strong>How to read this:</strong> a candidate counts as converted when a later call targets it within 10 calls and 5 minutes. Parallel calls in the same batch are excluded.</div>
<div class="grid-4">${stat("Producer calls", summary.producer_calls)}${stat("Candidates", summary.candidates)}${stat("Converted", `${summary.converted_candidates} (${percentage(summary.candidate_conversion_rate)})`, summary.converted_candidates > 0 ? "good" : "")}${stat("Mean reciprocal rank", formatDecimal(summary.mrr.value), "")}</div>
<div class="split" style="margin-top:16px"><div><h3>Conversion by rank</h3><table class="list-table"><thead><tr><th>Top</th><th>Lists</th><th>Converted</th><th>Rate</th></tr></thead><tbody>${summary.conversion_at_k.length === 0 ? emptyRow(4, "No candidate lists") : summary.conversion_at_k.map((item) => `<tr><td>Top ${item.k}</td><td class="number">${item.lists}</td><td class="number">${item.converted_lists}</td><td class="number">${percentage(item.rate)}</td></tr>`).join("")}</tbody></table></div><div><h3>Next tools used</h3>${frequencyTable(summary.downstream_consumers, "No converted candidates")}</div></div>
<div class="split" style="margin-top:16px"><div><h3>Source families</h3>${coreTable(report.by_source_family, "No source family data")}</div><div><h3>Exact sources</h3>${coreTable(report.by_source, "No source data")}</div></div>`;
}

function coreTable(values: Record<string, CandidateRankingCoreStatistics>, empty: string): string {
	const entries = Object.entries(values);
	if (entries.length === 0) return `<div class="empty">${escapeHtml(empty)}</div>`;
	return `<table class="list-table"><thead><tr><th>Source</th><th>Candidates</th><th>Converted</th><th>Rate</th></tr></thead><tbody>${entries.map(([name, value]) => `<tr><td>${escapeHtml(name)}</td><td class="number">${value.candidates}</td><td class="number">${value.converted_candidates}</td><td class="number">${percentage(value.candidate_conversion_rate)}</td></tr>`).join("")}</tbody></table>`;
}

function frequencyTable(values: Record<string, number>, empty: string): string {
	const entries = Object.entries(values);
	if (entries.length === 0) return `<div class="empty">${escapeHtml(empty)}</div>`;
	return `<table class="list-table"><thead><tr><th>Tool</th><th>Uses</th></tr></thead><tbody>${entries.map(([name, count]) => `<tr><td>${escapeHtml(name)}</td><td class="number">${count}</td></tr>`).join("")}</tbody></table>`;
}

function renderRuns(runs: TelemetryReport["runs"]): string {
	if (runs.length === 0) return `<div class="empty">No runs in this report</div>`;
	return `<div class="panel-body"><table class="runs"><thead><tr><th>Run</th><th>Started</th><th>Commit</th><th>Working tree</th><th>Directory</th></tr></thead><tbody>${runs.map((run) => `<tr><td>${escapeHtml(run.run_id)}</td><td class="number">${escapeHtml(formatTimestamp(run.at))}</td><td>${escapeHtml(run.git?.commit ?? "—")}</td><td>${run.git === undefined ? `<span class="badge">unknown</span>` : run.git.dirty ? `<span class="badge warning">dirty</span>` : `<span class="badge good">clean</span>`}</td><td>${escapeHtml(run.cwd)}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderQuery(report: TelemetryReport): string {
	const query = report.query;
	const filters = [
		...(query.tools?.map((tool) => `tool: ${tool}`) ?? []),
		...(query.git_commits?.map((commit) => `commit: ${commit}`) ?? []),
		...(query.git_dirty?.map((dirty) => `git ${dirty ? "dirty" : "clean"}`) ?? []),
		...(query.from === undefined ? [] : [`from: ${query.from}`]),
		...(query.to === undefined ? [] : [`to: ${query.to}`]),
	];
	return filters.length === 0 ? "" : `<div class="query">${filters.map((filter) => `<span class="badge">${escapeHtml(filter)}</span>`).join("")}</div>`;
}

function renderFiles(report: TelemetryReport): string {
	if (report.metadata.input_files.length === 0) return "";
	return `<details class="details"><summary>Input files</summary><div class="details-content">${report.metadata.input_files.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div></details>`;
}

function metricCard(label: string, value: string | number, detail: string, tone = ""): string {
	return `<div class="card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value ${tone}">${escapeHtml(String(value))}</div><div class="card-detail">${escapeHtml(detail)}</div></div>`;
}

function stat(label: string, value: string | number, tone = ""): string {
	return `<div class="stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value ${tone}">${escapeHtml(String(value))}</div></div>`;
}

function renderRate(value: RateSummary): string {
	if (value.samples === 0 || value.value === undefined) return `<span class="muted">—</span>`;
	const tone = value.value >= 0.9 ? "good" : value.value < 0.7 ? "bad" : "warning";
	const width = Math.max(0, Math.min(100, Math.round(value.value * 100)));
	return `<div class="rate-text ${tone}"><span>${percentage(value.value)}</span></div><div class="bar"><span style="width:${width}%"></span></div>`;
}

function formatRate(value: RateSummary): string {
	return value.samples === 0 ? "—" : `${value.numerator}/${value.samples} (${percentage(value.value)})`;
}

function formatMs(value: number | undefined): string {
	return value === undefined ? "—" : `${formatDecimal(value)} ms`;
}

function formatChars(value: number | undefined): string {
	return value === undefined ? "—" : formatDecimal(value);
}

function formatDecimal(value: number | undefined): string {
	if (value === undefined) return "—";
	return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function percentage(value: number | undefined): string {
	return value === undefined ? "—" : `${Math.round(value * 10_000) / 100}%`;
}

function rate(numerator: number, samples: number): number | undefined {
	return samples === 0 ? undefined : numerator / samples;
}

function emptyRow(columns: number, message: string): string {
	return `<tr><td colspan="${columns}" class="empty">${escapeHtml(message)}</td></tr>`;
}

function formatTimestamp(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/gu, (character) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	})[character] ?? character);
}
