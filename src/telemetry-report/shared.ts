import path from "node:path";

import type { CallRecord, Resource } from "../telemetry/types.js";
import type { NumericSummary, RateSummary } from "./types.js";

export function compare(left: string, right: string): number {
	return left.localeCompare(right, "en");
}

export function frequency(values: readonly string[]): Record<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return Object.fromEntries([...counts].sort(([left], [right]) => compare(left, right)));
}

export function numericSummary(values: readonly number[]): NumericSummary {
	const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
	if (sorted.length === 0) return { samples: 0 };
	const min = sorted[0];
	const max = sorted.at(-1);
	if (min === undefined || max === undefined) return { samples: 0 };
	const p50 = percentile(sorted, 0.5);
	const p95 = percentile(sorted, 0.95);
	return {
		samples: sorted.length,
		min,
		max,
		mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
		...(p50 === undefined ? {} : { p50 }),
		...(p95 === undefined ? {} : { p95 }),
	};
}

export function rateSummary(numerator: number, samples: number): RateSummary {
	return { numerator, samples, ...(samples === 0 ? {} : { value: numerator / samples }) };
}

export function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

export function callsByRun(calls: readonly CallRecord[]): Map<string, CallRecord[]> {
	const result = new Map<string, CallRecord[]>();
	for (const call of calls) {
		const values = result.get(call.run_id);
		if (values === undefined) result.set(call.run_id, [call]);
		else values.push(call);
	}
	for (const values of result.values()) values.sort((left, right) => left.call_index - right.call_index || compare(left.at, right.at));
	return result;
}

export function sameBatch(left: CallRecord, right: CallRecord): boolean {
	return left.batch !== undefined && right.batch !== undefined && left.batch.id === right.batch.id;
}

export function withinMillis(left: CallRecord, right: CallRecord, milliseconds: number): boolean {
	return Math.abs(Date.parse(right.at) - Date.parse(left.at)) <= milliseconds;
}

export function resourceMatches(left: Resource, right: Resource, leftCwd: string, rightCwd: string): boolean {
	if (left.kind === "url" || right.kind === "url") return left.kind === right.kind && left.value === right.value;
	return normalizeResource(left.value, leftCwd) === normalizeResource(right.value, rightCwd);
}

export function resourceKey(resource: Resource, cwd: string): string {
	return resource.kind === "url" ? `url:${resource.value}` : normalizeResource(resource.value, cwd);
}

function normalizeResource(value: string, cwd: string): string {
	return path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value));
}

function percentile(sorted: readonly number[], quantile: number): number | undefined {
	if (sorted.length === 0) return undefined;
	return sorted[Math.ceil(quantile * sorted.length) - 1];
}
