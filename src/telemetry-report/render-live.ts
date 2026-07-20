import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { CandidateRankingCoreStatistics, ToolStatistics } from "./types.js";
import type { LiveTelemetryReport } from "./live.js";

const WIDE_WIDTH = 92;

/** Render a compact, read-only current-session report for TUI or notifications. */
export function renderLiveTelemetry(value: LiveTelemetryReport, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const report = value.report;
	const lines = [
		align("Telemetry · current session", "q close  ↑↓ scroll", maxWidth),
		join([
			value.session_id === undefined ? "session unavailable" : `session ${shortId(value.session_id)}`,
			value.run_id === undefined ? undefined : `run ${shortId(value.run_id)}`,
			value.enabled ? "collection active" : "collection disabled",
			value.pending_calls === 0 ? undefined : `${value.pending_calls} in progress`,
		]),
		join([`${report.inventory.calls} completed calls`, `${report.inventory.tools} tools`, `generated ${report.metadata.generated_at}`]),
		"",
		"Tools",
		...toolLines(report.tools, maxWidth),
		"",
		"Edit · single vs multi-file",
		join([
			`${report.edit.calls} calls`,
			`${report.edit.failed_calls} failed`,
			`${report.edit.no_change_calls} no-change`,
		]),
		join([
			`${report.edit.batches.batches} parallel batches`,
			`${report.edit.batches.multi_file_batches} multi-file`,
			`${report.edit.batches.partial_failure_batches} partial failures`,
			`potential reduction ${report.edit.batches.potential_call_reduction}`,
		]),
		"",
		"Candidate ranking · heuristic",
		candidateLine("overall", report.candidate_ranking),
		conversionLine(report.candidate_ranking),
		consumerLine(report.candidate_ranking),
		"",
		"Source families",
		...(["repo-map", "lsp"] as const).flatMap((source) => {
			const statistics = report.candidate_ranking.by_source_family[source];
			return statistics === undefined
				? [`${source} · no candidates`]
				: [candidateLine(source, statistics), conversionLine(statistics), consumerLine(statistics)];
		}),
		"",
		"Detailed sources",
		...sourceLines(report.candidate_ranking.by_source),
	];
	return lines.filter((line, index) => line.length > 0 || lines[index - 1]?.length !== 0)
		.flatMap((line) => wrap(line, maxWidth));
}

export function formatLiveTelemetrySummary(value: LiveTelemetryReport): string {
	const report = value.report;
	return join([
		"Telemetry current session:",
		`${report.inventory.calls} completed calls`,
		`${report.inventory.tools} tools`,
		`edit multi-file ${report.edit.batches.multi_file_batches}/${report.edit.batches.batches}`,
		`candidates ${report.candidate_ranking.converted_candidates}/${report.candidate_ranking.candidates}`,
		value.pending_calls === 0 ? undefined : `${value.pending_calls} in progress`,
		value.enabled ? undefined : "collection disabled",
	]);
}

function toolLines(tools: readonly ToolStatistics[], width: number): string[] {
	if (tools.length === 0) return ["no completed tool calls"];
	if (width < WIDE_WIDTH) return tools.map((tool) => join([
		tool.tool,
		`${tool.calls} calls`,
		`ok ${percent(tool.success_rate.value)}`,
		`${tool.error_rate.numerator} errors`,
		`p50 ${number(tool.duration_ms.p50)} ms`,
		`${tool.repair.repaired_rate.numerator} repaired`,
	]));
	return [
		`${pad("tool", 20)} ${pad("calls", 7, true)} ${pad("success", 10, true)} ${pad("errors", 8, true)} ${pad("p50 ms", 10, true)} ${pad("repaired", 10, true)} ${pad("trunc", 7, true)}`,
		...tools.map((tool) => `${pad(tool.tool, 20)} ${pad(tool.calls, 7, true)} ${pad(percent(tool.success_rate.value), 10, true)} ${pad(tool.error_rate.numerator, 8, true)} ${pad(number(tool.duration_ms.p50), 10, true)} ${pad(tool.repair.repaired_rate.numerator, 10, true)} ${pad(tool.truncation_rate.numerator, 7, true)}`),
	];
}

function sourceLines(sources: Readonly<Record<string, CandidateRankingCoreStatistics>>): string[] {
	const values = Object.entries(sources);
	return values.length === 0 ? ["no candidate sources"] : values.map(([source, statistics]) => candidateLine(source, statistics));
}

function candidateLine(label: string, statistics: CandidateRankingCoreStatistics): string {
	return join([
		label,
		`${statistics.producer_calls} producers`,
		`${statistics.candidates} candidates`,
		`${statistics.converted_candidates} converted (${percent(statistics.candidate_conversion_rate)})`,
		`MRR ${decimal(statistics.mrr.value)}`,
	]);
}

function conversionLine(statistics: CandidateRankingCoreStatistics): string {
	return `  ${statistics.conversion_at_k.map((item) => `@${item.k} ${item.converted_lists}/${item.lists} (${percent(item.rate)})`).join(" · ")}`;
}

function consumerLine(statistics: CandidateRankingCoreStatistics): string {
	const consumers = Object.entries(statistics.downstream_consumers).map(([tool, count]) => `${tool} ${count}`).join(", ");
	return `  downstream · ${consumers || "none"}`;
}

function wrap(value: string, width: number): string[] {
	if (value.length === 0) return [""];
	const lines: string[] = [];
	let remaining = value;
	while (visibleWidth(remaining) > width) {
		let split = Math.min(width, remaining.length);
		while (split > 1 && visibleWidth(remaining.slice(0, split)) > width) split -= 1;
		const space = remaining.lastIndexOf(" ", split);
		if (space > 0) split = space;
		lines.push(truncateToWidth(remaining.slice(0, split), width, ""));
		remaining = remaining.slice(split).trimStart();
	}
	lines.push(remaining);
	return lines;
}

function align(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap > 1 ? `${left}${" ".repeat(gap)}${right}` : `${left} ${right}`;
}

function pad(value: string | number, width: number, start = false): string {
	const text = truncateToWidth(String(value), width, "");
	return start ? text.padStart(width) : text.padEnd(width);
}

function join(values: Array<string | undefined>): string {
	return values.filter((value): value is string => value !== undefined && value.length > 0).join(" · ");
}

function percent(value: number | undefined): string {
	return value === undefined ? "n/a" : `${Math.round(value * 10_000) / 100}%`;
}

function decimal(value: number): string {
	return value.toFixed(3);
}

function number(value: number | undefined): string | number {
	return value === undefined ? "n/a" : Math.round(value * 100) / 100;
}

function shortId(value: string): string {
	return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}
