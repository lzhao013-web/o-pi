import { createHash } from "node:crypto";

import type { JsonObject, JsonValue, MetricMap, MetricValue, TelemetryMetric } from "./types.js";

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

export function telemetryMetric(value: MetricValue, unit?: string): TelemetryMetric {
	return { value, ...(unit === undefined ? {} : { unit }) };
}

export function selectedMetrics(source: Record<string, unknown>, keys: readonly string[]): MetricMap {
	const result: MetricMap = {};
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
			result[key] = telemetryMetric(value);
		}
	}
	return result;
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
