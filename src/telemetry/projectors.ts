import { createHash } from "node:crypto";

import type { JsonObject, JsonValue, MetricAggregation, MetricValue, TelemetryMetric } from "./types.js";

export function textSummary(value: unknown): JsonObject | undefined {
	if (typeof value !== "string") return undefined;
	return {
		chars: value.length,
		lines: value.length === 0 ? 0 : value.split("\n").length,
		sha256: createHash("sha256").update(value).digest("hex"),
	};
}

export function compactJson(values: Record<string, JsonValue | undefined>): JsonObject {
	const result: JsonObject = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

export function scalar(value: unknown): string | number | boolean | null | undefined {
	return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
		? value
		: undefined;
}

export function categoricalMetric(value: MetricValue): TelemetryMetric {
	if (typeof value === "number") finite(value);
	return { kind: "categorical", aggregation: "count_by_value", value };
}

export function countMetric(value: number, unit: string): TelemetryMetric {
	if (!Number.isInteger(value) || value < 0) throw new Error("Count metric must be a non-negative integer");
	return { kind: "count", aggregation: "sum", value, unit };
}

export function distributionMetric(value: number, unit: string): TelemetryMetric {
	finite(value);
	return { kind: "distribution", aggregation: "distribution", value, unit };
}

export function durationMetric(value: number, unit: "ms" | "s" = "ms"): TelemetryMetric {
	nonNegative(value, "Duration");
	return { kind: "duration", aggregation: "distribution", value, unit };
}

export function bytesMetric(value: number, aggregation: Extract<MetricAggregation, "sum" | "distribution"> = "sum"): TelemetryMetric {
	nonNegative(value, "Bytes");
	return { kind: "bytes", aggregation, value, unit: "byte" };
}

export function ratioMetric(value: number): TelemetryMetric {
	if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Ratio metric must be between 0 and 1");
	return { kind: "ratio", aggregation: "mean", value, unit: "ratio" };
}

function finite(value: number): void {
	if (!Number.isFinite(value)) throw new Error("Metric must be finite");
}

function nonNegative(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} metric must be non-negative`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
