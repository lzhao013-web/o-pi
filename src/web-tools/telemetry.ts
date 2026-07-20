import { defineToolTelemetry } from "../telemetry/adapter.js";
import { compactJson, isRecord, scalar, selectedMetrics, telemetryMetric } from "../telemetry/projectors.js";
import type { MetricMap, TelemetryReference } from "../telemetry/types.js";
import type { WebFetchDetails, WebFetchParams, WebSearchDetails, WebSearchParams } from "./types.js";

export const webSearchTelemetry = defineToolTelemetry<WebSearchParams, WebSearchDetails>({
	projectRequested(value) {
		if (!isRecord(value)) return { value: {} };
		return { value: compactJson({ query: scalar(value["query"]), limit: scalar(value["limit"]) }) };
	},
	projectExecuted(params) {
		return { value: compactJson({ query: params.query, limit: params.limit }) };
	},
	observeResult(_params, result) {
		const details = record(result.details);
		const status = string(details["status"]);
		const code = errorCode(details);
		return {
			metrics: webMetrics(details),
			references: webCandidates(details),
			...(status === undefined ? {} : { status }),
			...(code === undefined ? {} : { error_code: code }),
		};
	},
});

export const webFetchTelemetry = defineToolTelemetry<WebFetchParams, WebFetchDetails>({
	projectRequested(value) {
		if (!isRecord(value)) return { value: {} };
		const url = string(value["url"]);
		return {
			value: compactJson({
				url: scalar(value["url"]),
				mode: scalar(value["mode"]),
				offset: scalar(value["offset"]),
				limit: scalar(value["limit"]),
			}),
			...(url === undefined ? {} : { references: [{ relation: "target", kind: "url", value: url }] }),
		};
	},
	projectExecuted(params) {
		return {
			value: compactJson({ url: params.url, mode: params.mode, offset: params.offset, limit: params.limit }),
			references: [{ relation: "target", kind: "url", value: params.url }],
		};
	},
	observeResult(_params, result) {
		const details = record(result.details);
		const range = record(details["range"]);
		const status = string(details["status"]);
		const code = errorCode(details);
		return {
			metrics: webMetrics(details),
			truncated: range["has_more"] === true,
			...(status === undefined ? {} : { status }),
			...(code === undefined ? {} : { error_code: code }),
		};
	},
});

function webMetrics(details: Record<string, unknown>): MetricMap {
	const metrics = selectedMetrics(details, ["provider", "cached", "http_status", "downloaded_bytes", "snapshot", "redirect_count"]);
	const attempts = details["attempts"];
	if (Array.isArray(attempts)) {
		metrics["attempts"] = telemetryMetric(attempts.length, "attempt");
		metrics["fallback"] = telemetryMetric(attempts.length > 1);
	}
	const range = record(details["range"]);
	for (const key of ["start", "end", "total", "has_more", "next_offset"] as const) {
		const value = range[key];
		if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
			metrics[`page_${key}`] = telemetryMetric(value);
		}
	}
	return metrics;
}

function webCandidates(details: Record<string, unknown>): TelemetryReference[] {
	const provider = string(details["provider"]) ?? "provider";
	const results = Array.isArray(details["results"]) ? details["results"].filter(isRecord) : [];
	return results.flatMap((item, index) => {
		const url = string(item["url"]);
		return url === undefined ? [] : [{ relation: "candidate", rank: index + 1, kind: "url", value: url, group: "primary", sources: [provider] }];
	});
}

function errorCode(details: Record<string, unknown>): string | undefined {
	return string(record(details["error"])["code"]);
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
