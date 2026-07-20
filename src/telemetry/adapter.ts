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
		const rank = finiteNumber(item["rank"]);
		const group = string(item["group"]);
		const start = finiteNumber(item["start_line"]);
		const end = finiteNumber(item["end_line"]);
		const sources = stringArray(item["sources"]);
		return [{
			relation,
			kind,
			value: referenceValue,
			...(rank === undefined ? {} : { rank }),
			...(group === undefined ? {} : { group }),
			...(sources === undefined ? {} : { sources }),
			...(start === undefined ? {} : { start_line: start }),
			...(end === undefined ? {} : { end_line: end }),
		}];
	});
}

function parseMetricMap(value: unknown): MetricMap | undefined {
	if (!isRecord(value)) return undefined;
	const result: MetricMap = {};
	for (const [key, child] of Object.entries(value)) {
		if (!isRecord(child)) continue;
		const metricValue = child["value"];
		if (typeof metricValue !== "string" && typeof metricValue !== "boolean"
			&& !(typeof metricValue === "number" && Number.isFinite(metricValue))) continue;
		const unit = string(child["unit"]);
		result[key] = { value: metricValue, ...(unit === undefined ? {} : { unit }) };
	}
	return result;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string");
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
