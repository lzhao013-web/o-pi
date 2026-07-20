import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { LiveTelemetryReport } from "./live.js";

const WIDE_WIDTH = 92;

export function renderLiveTelemetry(value: LiveTelemetryReport, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const { report } = value;
	const summary = report.inventory.summary;
	const health = report.collection_health;
	const lines = [
		align("Telemetry · current session", "q close  ↑↓ scroll", maxWidth),
		join([value.sessionId === undefined ? "session unavailable" : `session ${shortId(value.sessionId)}`, report.metadata.as_of === undefined ? "no timestamp" : `as of ${report.metadata.as_of}`]),
		"",
		"Inventory",
		join([`${summary.turns} turns`, `${summary.calls} calls`, `${summary.tools} tools`, `${summary.slices} strict slices`]),
		join([`${report.query.selected_slice_ids.length} current slices`, `analysis ${shortId(report.metadata.analysis_hash)}`]),
		"",
		"Current strict slices",
		...(maxWidth >= WIDE_WIDTH ? wideSlices(report.current_slices) : compactSlices(report.current_slices)),
		"",
		"Workflow (heuristic)",
		join([
			`${report.workflow.transitions.length} transitions`,
			`${report.workflow.repeated_calls.length} repeats`,
			`${report.workflow.near_retries.length} near retries`,
			`${report.workflow.tool_oscillations.length} oscillations`,
		]),
		"",
		`Collection health · ${health.status}`,
		join([
			`${health.counts.sequence_gaps} gaps`,
			`${health.counts.missing_starts} missing starts`,
			`${health.counts.missing_ends} missing ends`,
			`${health.counts.unfinished_turns} unfinished turns`,
			`${health.counts.writer_failures} writer failures`,
		]),
		health.warnings.join(" · "),
	];
	return lines.filter((line, index) => line.length > 0 || lines[index - 1]?.length !== 0).flatMap((line) => wrap(line, maxWidth));
}

export function formatLiveTelemetrySummary(value: LiveTelemetryReport): string {
	const report = value.report;
	return join([
		`Telemetry${value.sessionId === undefined ? "" : ` ${shortId(value.sessionId)}`}:`,
		`${report.inventory.summary.calls} calls`,
		`${report.inventory.summary.slices} slices`,
		`${report.query.selected_slice_ids.length} current`,
		`health ${report.collection_health.status}`,
	]);
}

function wideSlices(slices: LiveTelemetryReport["report"]["current_slices"]): string[] {
	return [
		`${pad("tool / slice", 32)} ${pad("calls", 7, true)} ${pad("success", 10, true)} ${pad("n", 7, true)} ${pad("p50 ms", 10, true)} ${pad("missing", 10, true)}`,
		...slices.slice(0, 20).map((slice) => `${pad(`${slice.tool_name} / ${shortId(slice.slice_id)}`, 32)} ${pad(slice.calls, 7, true)} ${pad(slice.success_rate.value === undefined ? "n/a" : percent(slice.success_rate.value), 10, true)} ${pad(slice.success_rate.samples, 7, true)} ${pad(slice.duration_ms.p50, 10, true)} ${pad(percent(slice.duration_ms.missing_rate), 10, true)}`),
	];
}

function compactSlices(slices: LiveTelemetryReport["report"]["current_slices"]): string[] {
	if (slices.length === 0) return ["no observed slices"];
	return slices.slice(0, 20).map((slice) => join([
		slice.tool_name,
		shortId(slice.slice_id),
		`${slice.calls} calls`,
		`${slice.success_rate.samples} outcome samples`,
		slice.success_rate.value === undefined ? "success n/a" : `${percent(slice.success_rate.value)} success`,
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

function shortId(value: string): string {
	return value.length <= 16 ? value : `${value.slice(0, 12)}…`;
}
