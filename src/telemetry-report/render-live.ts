import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { CandidateRankingCoreStatistics, ToolStatistics } from "./types.js";
import type { LiveTelemetryReport } from "./live.js";

const WIDE_WIDTH = 92;

/** 渲染紧凑的当前会话遥测报告，供 TUI 浮层和通知使用。 */
export function renderLiveTelemetry(value: LiveTelemetryReport, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const report = value.report;
	const lines = [
		align("遥测 · 当前会话", "q 关闭  ↑↓ 滚动", maxWidth),
		join([
			value.session_id === undefined ? "会话不可用" : `会话 ${shortId(value.session_id)}`,
			value.run_id === undefined ? undefined : `运行 ${shortId(value.run_id)}`,
			value.enabled ? "采集已启用" : "采集已禁用",
			value.pending_calls === 0 ? undefined : `${value.pending_calls} 个调用进行中`,
		]),
		join([`${report.inventory.calls} 次已完成调用`, `${report.inventory.tools} 个工具`, `生成于 ${report.metadata.generated_at}`]),
		"",
		"工具",
		...toolLines(report.tools, maxWidth),
		"",
		"编辑 · 单文件与多文件",
		join([
			`${report.edit.calls} 次调用`,
			`${report.edit.failed_calls} 次失败`,
			`${report.edit.no_change_calls} 次无变化`,
		]),
		join([
			`${report.edit.batches.batches} 个并行批次`,
			`${report.edit.batches.multi_file_batches} 个多文件批次`,
			`${report.edit.batches.partial_failure_batches} 个部分失败批次`,
			`可能减少 ${report.edit.batches.potential_call_reduction} 次调用`,
		]),
		"",
		"候选项排序 · 启发式",
		candidateLine("总体", report.candidate_ranking),
		conversionLine(report.candidate_ranking),
		consumerLine(report.candidate_ranking),
		"",
		"候选来源类别",
		...(["repo-map", "lsp"] as const).flatMap((source) => {
			const statistics = report.candidate_ranking.by_source_family[source];
			return statistics === undefined
				? [`${source} · 无候选项`]
				: [candidateLine(source, statistics), conversionLine(statistics), consumerLine(statistics)];
		}),
		"",
		"候选来源明细",
		...sourceLines(report.candidate_ranking.by_source),
	];
	return lines.filter((line, index) => line.length > 0 || lines[index - 1]?.length !== 0)
		.flatMap((line) => wrap(line, maxWidth));
}

export function formatLiveTelemetrySummary(value: LiveTelemetryReport): string {
	const report = value.report;
	return join([
		"当前会话遥测：",
		`${report.inventory.calls} 次已完成调用`,
		`${report.inventory.tools} 个工具`,
		`编辑多文件批次 ${report.edit.batches.multi_file_batches}/${report.edit.batches.batches}`,
		`候选项已使用 ${report.candidate_ranking.converted_candidates}/${report.candidate_ranking.candidates}`,
		value.pending_calls === 0 ? undefined : `${value.pending_calls} 个调用进行中`,
		value.enabled ? undefined : "采集已禁用",
	]);
}

function toolLines(tools: readonly ToolStatistics[], width: number): string[] {
	if (tools.length === 0) return ["没有已完成的工具调用"];
	if (width < WIDE_WIDTH) return tools.map((tool) => join([
		tool.tool,
		`${tool.calls} 次调用`,
		`成功率 ${percent(tool.success_rate.value)}`,
		`${tool.error_rate.numerator} 个错误`,
		`P50 ${number(tool.duration_ms.p50)} 毫秒`,
		`${tool.repair.repaired_rate.numerator} 次修复`,
	]));
	return [
		`${pad("工具", 20)} ${pad("调用", 7, true)} ${pad("成功率", 10, true)} ${pad("错误", 8, true)} ${pad("P50(毫秒)", 10, true)} ${pad("修复", 10, true)} ${pad("截断", 7, true)}`,
		...tools.map((tool) => `${pad(tool.tool, 20)} ${pad(tool.calls, 7, true)} ${pad(percent(tool.success_rate.value), 10, true)} ${pad(tool.error_rate.numerator, 8, true)} ${pad(number(tool.duration_ms.p50), 10, true)} ${pad(tool.repair.repaired_rate.numerator, 10, true)} ${pad(tool.truncation_rate.numerator, 7, true)}`),
	];
}

function sourceLines(sources: Readonly<Record<string, CandidateRankingCoreStatistics>>): string[] {
	const values = Object.entries(sources);
	return values.length === 0 ? ["没有候选来源"] : values.map(([source, statistics]) => candidateLine(source, statistics));
}

function candidateLine(label: string, statistics: CandidateRankingCoreStatistics): string {
	return join([
		label,
		`${statistics.producer_calls} 个生成调用`,
		`${statistics.candidates} 个候选项`,
		`${statistics.converted_candidates} 个已使用候选项 (${percent(statistics.candidate_conversion_rate)})`,
		`MRR(平均倒数排名) ${decimal(statistics.mrr.value)}`,
	]);
}

function conversionLine(statistics: CandidateRankingCoreStatistics): string {
	return `  前 K 项命中 · ${statistics.conversion_at_k.map((item) => `前${item.k}项 ${item.converted_lists}/${item.lists} (${percent(item.rate)})`).join(" · ")}`;
}

function consumerLine(statistics: CandidateRankingCoreStatistics): string {
	const consumers = Object.entries(statistics.downstream_consumers).map(([tool, count]) => `${tool} ${count}`).join(", ");
	return `  下游使用 · ${consumers || "无"}`;
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
	const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
	return start ? `${padding}${text}` : `${text}${padding}`;
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
