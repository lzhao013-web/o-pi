import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";

import type {
	InputProjection,
	JsonObject,
	JsonValue,
	MetricMap,
	TelemetryReference,
	ToolObservation,
} from "./types.js";
import type { SourceReference } from "./source-identity.js";

export interface ToolTelemetryAdapter<TParams, TDetails> {
	/** Default explicit allowlist for both requested and executed input. */
	input?(value: unknown): InputProjection;
	/** Override the requested-input projection when it differs from input. */
	requested?(value: unknown): InputProjection;
	/** Override the executed-input projection when it differs from input. */
	executed?(params: TParams): InputProjection;
	/** Convert typed execution details into payload-free result facts. */
	result?(params: TParams, result: AgentToolResult<TDetails>): ToolObservation;
}

export interface DefinedToolTelemetry<TParams, TDetails> extends ToolTelemetryAdapter<TParams, TDetails> {
	readonly sources: readonly SourceReference[];
}

export function defineToolTelemetry<TParams, TDetails>(
	source: SourceReference | readonly SourceReference[],
	adapter: ToolTelemetryAdapter<TParams, TDetails>,
): DefinedToolTelemetry<TParams, TDetails> {
	return { ...adapter, sources: Array.isArray(source) ? source : [source] };
}

const DEFAULT_TELEMETRY = defineToolTelemetry<unknown, unknown>(import.meta.url, {});

export function defaultToolTelemetry<TParams, TDetails>(): DefinedToolTelemetry<TParams, TDetails> {
	return DEFAULT_TELEMETRY;
}

export function safeProjectRequested<TParams, TDetails>(
	adapter: ToolTelemetryAdapter<TParams, TDetails>,
	value: unknown,
): { value: InputProjection; failed: boolean; limited: boolean } {
	const project = adapter.requested ?? adapter.input;
	if (project === undefined) return { value: { value: {} }, failed: false, limited: false };
	try {
		const bounded = boundedTelemetryPayload(project(value));
		return { value: decodeProjection(bounded.value), failed: false, limited: bounded.limited };
	} catch {
		return { value: { value: {} }, failed: true, limited: false };
	}
}

export function safeProjectExecuted<TParams, TDetails>(
	adapter: ToolTelemetryAdapter<TParams, TDetails>,
	params: TParams,
): { value: InputProjection; failed: boolean; limited: boolean } {
	const project = adapter.executed ?? adapter.input;
	if (project === undefined) return { value: { value: {} }, failed: false, limited: false };
	try {
		const bounded = boundedTelemetryPayload(project(params));
		return { value: decodeProjection(bounded.value), failed: false, limited: bounded.limited };
	} catch {
		return { value: { value: {} }, failed: true, limited: false };
	}
}

export function safeObserve<TParams, TDetails>(
	adapter: ToolTelemetryAdapter<TParams, TDetails>,
	params: TParams,
	result: AgentToolResult<TDetails>,
): { value: ToolObservation; failed: boolean; limited: boolean } {
	if (adapter.result === undefined) return { value: {}, failed: false, limited: false };
	try {
		const bounded = boundedTelemetryPayload(adapter.result(params, result));
		return { value: decodeToolObservation(bounded.value), failed: false, limited: bounded.limited };
	} catch {
		return { value: {}, failed: true, limited: false };
	}
}

function decodeProjection(projection: unknown): InputProjection {
	if (!isRecord(projection)) throw new Error("Telemetry input projection must be an object");
	const references = parseReferences(projection["references"]);
	return {
		value: decodeTelemetryJsonObject(projection["value"]),
		...(references === undefined ? {} : { references }),
	};
}

export function decodeToolObservation(observation: unknown): ToolObservation {
	if (!isRecord(observation)) throw new Error("Tool observation must be an object");
	const metrics = parseMetricMap(observation["metrics"]);
	const references = parseReferences(observation["references"]);
	const attributes = observation["attributes"] === undefined ? undefined : decodeTelemetryJsonObject(observation["attributes"]);
	const measurements = parseMeasurements(observation["measurements"]);
	const stages = parseStages(observation["stages"]);
	return {
		...(metrics === undefined ? {} : { metrics }),
		...(references === undefined ? {} : { references }),
		...(attributes === undefined ? {} : { attributes }),
		...(measurements === undefined ? {} : { measurements }),
		...(stages === undefined ? {} : { stages }),
		...(typeof observation["truncated"] === "boolean" ? { truncated: observation["truncated"] } : {}),
		...(typeof observation["status"] === "string" ? { status: observation["status"] } : {}),
		...(typeof observation["error_code"] === "string" ? { error_code: observation["error_code"] } : {}),
	};
}

function parseMeasurements(value: unknown): NonNullable<ToolObservation["measurements"]> | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value.flatMap((item) => {
		if (!isRecord(item)) return [];
		const name = string(item["name"]);
		const measurement = finiteNumber(item["value"]);
		const unit = string(item["unit"]);
		return name === undefined || measurement === undefined ? [] : [{ name, value: measurement, ...(unit === undefined ? {} : { unit }) }];
	});
	return result.length === 0 ? undefined : result;
}

function parseStages(value: unknown): NonNullable<ToolObservation["stages"]> | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = value.flatMap((item) => {
		if (!isRecord(item)) return [];
		const name = string(item["name"]);
		if (name === undefined) return [];
		const status = string(item["status"]);
		const duration = finiteNumber(item["duration_ms"]);
		const attributes = item["attributes"] === undefined ? undefined : decodeTelemetryJsonObject(item["attributes"]);
		const measurements = parseMeasurements(item["measurements"]);
		return [{ name, ...(status === undefined ? {} : { status }), ...(duration === undefined || duration < 0 ? {} : { duration_ms: duration }),
			...(attributes === undefined ? {} : { attributes }), ...(measurements === undefined ? {} : { measurements }) }];
	});
	return result.length === 0 ? undefined : result;
}

export function cloneTelemetryPayload(value: unknown): unknown {
	return boundedTelemetryPayload(value).value;
}

export function boundedTelemetryPayload(value: unknown): { value: unknown; limited: boolean } {
	const state = { nodes: 0, limited: false, ancestors: new WeakSet<object>() };
	const cloned = boundedJson(value, state, 0);
	if (cloned === undefined) throw new Error("Telemetry projection is not JSON-serializable");
	return { value: cloned, limited: state.limited };
}

const MAX_DEPTH = 8;
const MAX_NODES = 4096;
const MAX_STRING_CHARS = 4096;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;

function boundedJson(
	value: unknown,
	state: { nodes: number; limited: boolean; ancestors: WeakSet<object> },
	depth: number,
): JsonValue | undefined {
	state.nodes += 1;
	if (state.nodes > MAX_NODES || depth > MAX_DEPTH) {
		state.limited = true;
		return "[telemetry-limit]";
	}
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string") {
		if (value.length <= MAX_STRING_CHARS) return value;
		state.limited = true;
		const digest = createHash("sha256").update(value).digest("hex");
		return `${value.slice(0, 1024)}...[chars=${value.length};sha256=${digest}]`;
	}
	if (typeof value !== "object") return undefined;
	if (state.ancestors.has(value)) throw new Error("Telemetry projection contains a cycle");
	state.ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_ARRAY_ITEMS) state.limited = true;
			const result: JsonValue[] = [];
			for (const child of value.slice(0, MAX_ARRAY_ITEMS)) {
				const parsed = boundedJson(child, state, depth + 1);
				if (parsed !== undefined) result.push(parsed);
			}
			return result;
		}
		const entries = Object.entries(value);
		if (entries.length > MAX_OBJECT_KEYS) state.limited = true;
		const result: JsonObject = {};
		for (const [key, child] of entries.slice(0, MAX_OBJECT_KEYS)) {
			const parsed = boundedJson(child, state, depth + 1);
			if (parsed !== undefined) result[key] = parsed;
		}
		return result;
	} finally {
		state.ancestors.delete(value);
	}
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
