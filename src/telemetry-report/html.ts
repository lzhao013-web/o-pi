import type { TelemetryReport } from "./types.js";

export function renderTelemetryHtml(report: TelemetryReport): string {
	const rows = report.tools.map((tool) => `<tr>${[
		tool.tool,
		tool.calls,
		percentage(tool.success_rate.value),
		value(tool.duration_ms.p50),
		value(tool.output_chars.mean),
		tool.repair.repaired_rate.numerator,
	].map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join("")}</tr>`).join("");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi telemetry report</title><style>
:root{color-scheme:light dark;font:14px/1.45 system-ui,sans-serif}body{max-width:1200px;margin:auto;padding:22px}table{border-collapse:collapse;width:100%}th,td{padding:7px 9px;border-bottom:1px solid #777;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;border:1px solid #777;border-radius:8px}
</style></head><body><h1>Pi telemetry report</h1>
<p>${report.inventory.runs} runs · ${report.inventory.calls} calls · ${report.inventory.tools} tools</p>
<h2>Tools</h2><table><thead><tr><th>Tool</th><th>Calls</th><th>Success</th><th>p50 ms</th><th>Mean output chars</th><th>Repaired</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Edit: single vs multi-file</h2><pre>${escapeHtml(JSON.stringify(report.edit, null, 2))}</pre>
<h2>Candidate ranking <small>(heuristic)</small></h2><pre>${escapeHtml(JSON.stringify(report.candidate_ranking, null, 2))}</pre>
</body></html>\n`;
}

export function formatTelemetrySummary(report: TelemetryReport): string {
	return `Telemetry: ${report.inventory.calls} calls · edit multi-file batches ${report.edit.batches.multi_file_batches}/${report.edit.batches.batches}`
		+ ` · candidates ${report.candidate_ranking.converted_candidates}/${report.candidate_ranking.candidates}`;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/gu, (character) => ({
		"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
	})[character] ?? character);
}

function percentage(value: number | undefined): string {
	return value === undefined ? "n/a" : `${Math.round(value * 10_000) / 100}%`;
}

function value(input: number | undefined): string | number {
	return input ?? "n/a";
}
