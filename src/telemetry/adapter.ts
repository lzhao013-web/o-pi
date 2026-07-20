import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import type {
	InputProjection,
	JsonObject,
	MetricMap,
	TelemetryReference,
	ToolObservation,
} from "./types.js";

export interface ToolTelemetryAdapter<TParams, TDetails> {
	/** Optional explicit allowlist for raw model input. Omission persists an empty projection. */
	projectRequested?(value: unknown): InputProjection;
	/** Typed projection of the arguments that actually enter execute. */
	projectExecuted(params: TParams): InputProjection;
	/** Convert typed execution details into payload-free result facts. */
	observeResult(params: TParams, result: AgentToolResult<TDetails>): ToolObservation;
}

export function defineToolTelemetry<TParams, TDetails>(
	adapter: ToolTelemetryAdapter<TParams, TDetails>,
): ToolTelemetryAdapter<TParams, TDetails> {
	return adapter;
}

export function minimalTelemetry<TParams, TDetails>(): ToolTelemetryAdapter<TParams, TDetails> {
	return {
		projectExecuted: () => ({ value: {} }),
		observeResult: () => ({}),
	};
}

export function safeProjectRequested<TParams, TDetails>(
	adapter: ToolTelemetryAdapter<TParams, TDetails>,
	value: unknown,
): { value: InputProjection; failed: boolean } {
	if (adapter.projectRequested === undefined) return { value: { value: {} }, failed: false };
	try {
		return { value: sanitizeProjection(adapter.projectRequested(value)), failed: false };
	} catch {
		return { value: { value: {} }, failed: true };
	}
}

export function safeProjectExecuted<TParams, TDetails>(
	adapter: ToolTelemetryAdapter<TParams, TDetails>,
	params: TParams,
): { value: InputProjection; failed: boolean } {
	try {
		return { value: sanitizeProjection(adapter.projectExecuted(params)), failed: false };
	} catch {
		return { value: { value: {} }, failed: true };
	}
}

export function safeObserve<TParams, TDetails>(
	adapter: ToolTelemetryAdapter<TParams, TDetails>,
	params: TParams,
	result: AgentToolResult<TDetails>,
): { value: ToolObservation; failed: boolean } {
	try {
		return { value: sanitizeObservation(adapter.observeResult(params, result)), failed: false };
	} catch {
		return { value: {}, failed: true };
	}
}

function sanitizeProjection(value: InputProjection): InputProjection {
	const projection = cloneTelemetryPayload(value);
	if (!isRecord(projection)) throw new Error("Telemetry input projection must be an object");
	const references = parseReferences(projection["references"]);
	return {
		value: decodeTelemetryJsonObject(projection["value"]),
		...(references === undefined ? {} : { references }),
	};
}

function sanitizeObservation(value: ToolObservation): ToolObservation {
	return decodeToolObservation(cloneTelemetryPayload(value));
}

export function decodeToolObservation(observation: unknown): ToolObservation {
	if (!isRecord(observation)) throw new Error("Tool observation must be an object");
	const metrics = parseMetricMap(observation["metrics"]);
	const references = parseReferences(observation["references"]);
	return {
		...(metrics === undefined ? {} : { metrics }),
		...(references === undefined ? {} : { references }),
		...(typeof observation["truncated"] === "boolean" ? { truncated: observation["truncated"] } : {}),
		...(typeof observation["status"] === "string" ? { status: observation["status"] } : {}),
		...(typeof observation["error_code"] === "string" ? { error_code: observation["error_code"] } : {}),
	};
}

export function cloneTelemetryPayload(value: unknown): unknown {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Telemetry projection is not JSON-serializable");
	const decoded: unknown = JSON.parse(encoded);
	return decoded;
}

export function decodeTelemetryJsonObject(value: unknown): JsonObject {
	if (!isRecord(value)) throw new Error("Telemetry input must be an object");
	const result: JsonObject = {};
	for (const [key, child] of Object.entries(value)) {
		const parsed = parseJsonValue(child);
		if (parsed !== undefined) result[key] = parsed;
	}
	return result;
}

function parseJsonValue(value: unknown): JsonObject[string] | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const result: JsonObject[string][] = [];
		for (const child of value) {
			const parsed = parseJsonValue(child);
			if (parsed !== undefined) result.push(parsed);
		}
		return result;
	}
	return isRecord(value) ? decodeTelemetryJsonObject(value) : undefined;
}

function parseReferences(value: unknown): TelemetryReference[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((item) => {
		if (!isRecord(item)) return [];
		const relation = string(item["relation"]);
		const kind = string(item["kind"]);
		const referenceValue = string(item["value"]);
		if (relation === undefined || kind === undefined || referenceValue === undefined) return [];
		const globalRank = positiveInteger(item["global_rank"]);
		const groupRank = positiveInteger(item["group_rank"]);
		const group = string(item["group"]);
		const sources = referenceSources(item["sources"]);
		const resource = resourceState(item["resource"]);
		return [{
			relation,
			kind,
			value: referenceValue,
			...(group === undefined ? {} : { group }),
			...(globalRank === undefined ? {} : { global_rank: globalRank }),
			...(groupRank === undefined ? {} : { group_rank: groupRank }),
			...(sources === undefined ? {} : { sources }),
			...(resource === undefined ? {} : { resource }),
		}];
	});
}

function parseMetricMap(value: unknown): MetricMap | undefined {
	if (!isRecord(value)) return undefined;
	const result: MetricMap = {};
	for (const [key, child] of Object.entries(value)) {
		if (!isRecord(child)) continue;
		const metric = parseMetric(child);
		if (metric !== undefined) result[key] = metric;
	}
	return result;
}

function parseMetric(value: Record<string, unknown>): MetricMap[string] | undefined {
	const numeric = finiteNumber(value["value"]);
	const unit = string(value["unit"]);
	switch (value["kind"]) {
		case "categorical": {
			const category = value["value"];
			if (value["aggregation"] !== "count_by_value" || unit !== undefined) return undefined;
			if (typeof category === "string" || typeof category === "boolean") {
				return { kind: "categorical", aggregation: "count_by_value", value: category };
			}
			return numeric === undefined ? undefined : { kind: "categorical", aggregation: "count_by_value", value: numeric };
		}
		case "count":
			return value["aggregation"] === "sum" && numeric !== undefined && Number.isInteger(numeric) && numeric >= 0 && unit !== undefined
				? { kind: "count", aggregation: "sum", value: numeric, unit }
				: undefined;
		case "distribution":
			return value["aggregation"] === "distribution" && numeric !== undefined && unit !== undefined
				? { kind: "distribution", aggregation: "distribution", value: numeric, unit }
				: undefined;
		case "duration":
			return value["aggregation"] === "distribution" && numeric !== undefined && numeric >= 0 && (unit === "ms" || unit === "s")
				? { kind: "duration", aggregation: "distribution", value: numeric, unit }
				: undefined;
		case "bytes":
			return (value["aggregation"] === "sum" || value["aggregation"] === "distribution") && numeric !== undefined && numeric >= 0 && unit === "byte"
				? { kind: "bytes", aggregation: value["aggregation"], value: numeric, unit: "byte" }
				: undefined;
		case "ratio":
			return value["aggregation"] === "mean" && numeric !== undefined && numeric >= 0 && numeric <= 1 && unit === "ratio"
				? { kind: "ratio", aggregation: "mean", value: numeric, unit: "ratio" }
				: undefined;
		default:
			return undefined;
	}
}

function referenceSources(value: unknown): TelemetryReference["sources"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value.flatMap((item) => {
		if (!isRecord(item)) return [];
		const id = string(item["id"]);
		if (id === undefined) return [];
		const family = string(item["family"]);
		const sourceRank = positiveInteger(item["source_rank"]);
		return [{ id, ...(family === undefined ? {} : { family }), ...(sourceRank === undefined ? {} : { source_rank: sourceRank }) }];
	});
	return result.length === 0 ? undefined : result;
}

function resourceState(value: unknown): TelemetryReference["resource"] | undefined {
	if (!isRecord(value)) return undefined;
	const snapshot = string(value["snapshot"]);
	const revision = string(value["revision"]);
	const startLine = positiveInteger(value["start_line"]);
	const endLine = positiveInteger(value["end_line"]);
	const rawHash = value["content_hash"];
	const contentHash = isRecord(rawHash) && rawHash["algorithm"] === "sha256" && typeof rawHash["value"] === "string"
		&& /^[a-f0-9]{64}$/iu.test(rawHash["value"])
		? { algorithm: "sha256" as const, value: rawHash["value"] }
		: undefined;
	if (snapshot === undefined && revision === undefined && startLine === undefined && endLine === undefined && contentHash === undefined) return undefined;
	return {
		...(contentHash === undefined ? {} : { content_hash: contentHash }),
		...(snapshot === undefined ? {} : { snapshot }),
		...(revision === undefined ? {} : { revision }),
		...(startLine === undefined ? {} : { start_line: startLine }),
		...(endLine === undefined ? {} : { end_line: endLine }),
	};
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
