import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { LiveTelemetryReport } from "./live.js";

const WIDE_WIDTH = 92;

export function renderLiveTelemetry(value: LiveTelemetryReport, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const { report } = value;
	const summary = report.summary;
	const metadata = report.metadata;
	const lines = [
		align("Telemetry · current session", "q close  ↑↓ scroll", maxWidth),
		join([value.sessionId === undefined ? "session unavailable" : `session ${shortId(value.sessionId)}`, metadata.last_completed_turn === undefined ? "no completed turn" : `through turn ${metadata.last_completed_turn}`]),
		"",
		"Overview",
		join([
			`${summary.turns} turns`,
			`${summary.calls} calls`,
			`${summary.successes} ok`,
			`${summary.errors} failed`,
			`${percent(summary.success_rate)} success`,
		]),
		join([
			`${formatNumber(summary.execution_ms)} ms execution`,
			`${formatNumber(summary.output_tokens)} output tokens`,
			`${summary.recovered_failures}/${summary.failed_calls} failures recovered`,
		]),
		"",
		"Tools",
		...(maxWidth >= WIDE_WIDTH ? wideTools(report.tools) : compactTools(report.tools)),
		"",
		"Workflow",
		join([
			`${summary.repeated_calls} repeats`,
			`${summary.failure_retries} exact retries`,
			`${summary.near_retries} modified retries`,
			`${summary.tool_oscillations} A-B-A`,
		]),
		join([
			`${summary.candidate_conversions}/${summary.candidate_exposures} candidates used`,
			`${percent(summary.candidate_conversion_rate)} conversion`,
			`${percent(summary.failure_recovery_rate)} recovery`,
		]),
		"",
		"Collection health",
		join([
			`${metadata.in_progress_calls} in progress`,
			`${metadata.pending_writes} pending writes`,
			`${metadata.failed_writes} failed writes`,
			`${metadata.partial_records} partial records`,
			`${metadata.invalid_lines + metadata.invalid_records} invalid records/lines`,
		]),
		metadata.last_write_failure_at === undefined ? "" : `last write failure ${metadata.last_write_failure_at}`,
	];
	return lines.filter((line, index) => line.length > 0 || lines[index - 1]?.length !== 0)
		.flatMap((line) => wrap(line, maxWidth));
}

export function formatLiveTelemetrySummary(value: LiveTelemetryReport): string {
	const { summary, metadata } = value.report;
	return join([
		`Telemetry${value.sessionId === undefined ? "" : ` ${shortId(value.sessionId)}`}:`,
		`${summary.turns} turns`,
		`${summary.calls} calls`,
		`${percent(summary.success_rate)} success`,
		`${summary.errors} failed`,
		`${summary.recovered_failures}/${summary.failed_calls} recovered`,
		metadata.in_progress_calls > 0 ? `${metadata.in_progress_calls} in progress` : undefined,
		metadata.failed_writes > 0 ? `${metadata.failed_writes} writes failed` : undefined,
	]);
}

function wideTools(tools: LiveTelemetryReport["report"]["tools"]): string[] {
	return [
		`${pad("tool / cohort", 29)} ${pad("calls", 7, true)} ${pad("ok", 7, true)} ${pad("fail", 7, true)} ${pad("avg ms", 10, true)} ${pad("out/call", 10, true)} ${pad("repair", 8, true)}`,
		...tools.slice(0, 20).map((tool) => `${pad(`${tool.tool} / ${shortId(tool.cohort_id)}`, 29)} ${pad(tool.calls, 7, true)} ${pad(tool.successes, 7, true)} ${pad(tool.errors, 7, true)} ${pad(Math.round(tool.execution_ms_per_call), 10, true)} ${pad(Math.round(tool.output_tokens_per_call), 10, true)} ${pad(tool.repaired_inputs, 8, true)}`),
	];
}

function compactTools(tools: LiveTelemetryReport["report"]["tools"]): string[] {
	if (tools.length === 0) return ["no observed tools"];
	return tools.slice(0, 20).map((tool) => join([
		tool.tool,
		`${tool.calls} calls`,
		`${tool.errors} failed`,
		`${percent(tool.success_rate)} ok`,
		`${Math.round(tool.execution_ms_per_call)} ms/call`,
	]));
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

function percent(value: number): string {
	return `${Math.round(value * 10_000) / 100}%`;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function shortId(value: string): string {
	return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}
