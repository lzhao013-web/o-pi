import { bytesMetric, categoricalMetric, countMetric, isRecord } from "../../telemetry/projectors.js";
import type { MetricMap } from "../../telemetry/types.js";

export function webMetrics(details: Record<string, unknown>): MetricMap {
	const metrics: MetricMap = {};
	for (const key of ["provider", "cached", "http_status", "snapshot"] as const) {
		const value = details[key];
		if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
			metrics[key] = categoricalMetric(value);
		}
	}
	const downloadedBytes = number(details["downloaded_bytes"]);
	if (downloadedBytes !== undefined) metrics["downloaded_bytes"] = bytesMetric(downloadedBytes);
	const redirects = number(details["redirect_count"]);
	if (redirects !== undefined) metrics["redirect_count"] = countMetric(redirects, "redirect");
	const attempts = details["attempts"];
	if (Array.isArray(attempts)) {
		metrics["attempts"] = countMetric(attempts.length, "attempt");
		metrics["fallback"] = categoricalMetric(attempts.length > 1);
	}
	const range = record(details["range"]);
	for (const key of ["start", "end", "next_offset"] as const) {
		const value = range[key];
		if (typeof value === "number" && Number.isFinite(value)) metrics[`page_${key}`] = categoricalMetric(value);
	}
	const total = number(range["total"]);
	if (total !== undefined) metrics["page_total"] = countMetric(total, "item");
	if (typeof range["has_more"] === "boolean") metrics["page_has_more"] = categoricalMetric(range["has_more"]);
	return metrics;
}

export function errorCode(details: Record<string, unknown>): string | undefined {
	return string(record(details["error"])["code"]);
}

export function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
