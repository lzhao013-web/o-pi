import { defineToolTelemetry } from "../telemetry/adapter.js";
import { bytesMetric, categoricalMetric, compactJson, countMetric, isRecord, scalar, textSummary } from "../telemetry/projectors.js";
import type { InputProjection, MetricMap, TelemetryReference, ToolObservation } from "../telemetry/types.js";
import type {
	EditParams,
	EditSuccess,
	FailedResult,
	FindDetails,
	FindParams,
	GrepParams,
	GrepSuccess,
	LsParams,
	LsSuccess,
	ReadFileSuccess,
	ReadParams,
	ToolOutcome,
	WriteParams,
	WriteSuccess,
} from "./types.js";

export const lsTelemetry = defineToolTelemetry<LsParams, ToolOutcome<LsSuccess>>({
	projectRequested: projectScalarInput(["path"]),
	projectExecuted: (params) => projection(compactJson({ path: params.path }), pathReference(params.path)),
	observeResult(_params, result) {
		const details = record(result.details);
		return observation(details, fileMetrics(details), lsCandidates(details));
	},
});

export const findTelemetry = defineToolTelemetry<FindParams, FindDetails | FailedResult>({
	projectRequested: projectScalarInput(["query", "path", "glob"]),
	projectExecuted: (params) => projection(compactJson({ query: params.query, path: params.path, glob: params.glob }), pathReference(params.path)),
	observeResult(_params, result) {
		const details = record(result.details);
		return observation(details, fileMetrics(details), findCandidates(details));
	},
});

export const grepTelemetry = defineToolTelemetry<GrepParams, ToolOutcome<GrepSuccess>>({
	projectRequested: projectScalarInput(["query", "path", "match", "glob"]),
	projectExecuted: (params) => projection(compactJson({ query: params.query, path: params.path, match: params.match, glob: params.glob }), pathReference(params.path)),
	observeResult(_params, result) {
		const details = record(result.details);
		return observation(details, fileMetrics(details), grepCandidates(details));
	},
});

export const readTelemetry = defineToolTelemetry<ReadParams, ToolOutcome<ReadFileSuccess>>({
	projectRequested: projectScalarInput(["path", "start_line", "end_line"]),
	projectExecuted: (params) => projection(
		compactJson({ path: params.path, start_line: params.start_line, end_line: params.end_line }),
		pathReference(params.path, params.start_line, params.end_line),
	),
	observeResult(params, result) {
		const details = record(result.details);
		const reference = resultFileReference(params.path, details);
		return observation(details, fileMetrics(details), reference === undefined ? [] : [reference]);
	},
});

export const writeTelemetry = defineToolTelemetry<WriteParams, ToolOutcome<WriteSuccess>>({
	projectRequested(value) {
		if (!isRecord(value)) return { value: {} };
		const projected = compactJson({ path: scalar(value["path"]), content: textSummary(value["content"]) });
		return projection(projected, pathReference(string(value["path"]), undefined, undefined, contentHash(value["content"])));
	},
	projectExecuted: (params) => projection(
		compactJson({ path: params.path, content: textSummary(params.content) }),
		pathReference(params.path, undefined, undefined, contentHash(params.content)),
	),
	observeResult(params, result) {
		const details = record(result.details);
		const reference = resultFileReference(params.path, details);
		return observation(details, fileMetrics(details), reference === undefined ? [] : [reference]);
	},
});

export const editTelemetry = defineToolTelemetry<EditParams, ToolOutcome<EditSuccess>>({
	projectRequested(value) {
		if (!isRecord(value)) return { value: {} };
		const edits = Array.isArray(value["edits"])
			? value["edits"].filter(isRecord).map((edit) => compactJson({ old: textSummary(edit["old"]), new: textSummary(edit["new"]) }))
			: undefined;
		return projection(compactJson({ path: scalar(value["path"]), edits }), pathReference(string(value["path"])));
	},
	projectExecuted: (params) => projection(
		compactJson({
			path: params.path,
			edits: params.edits.map((edit) => compactJson({ old: textSummary(edit.old), new: textSummary(edit.new) })),
		}),
		pathReference(params.path),
	),
	observeResult(_params, result) {
		const details = record(result.details);
		return observation(details, fileMetrics(details), []);
	},
});

function projectScalarInput(keys: readonly string[]): (value: unknown) => InputProjection {
	return (value) => {
		if (!isRecord(value)) return { value: {} };
		return projection(
			compactJson(Object.fromEntries(keys.map((key) => [key, scalar(value[key])]))),
			pathReference(string(value["path"]), number(value["start_line"]), number(value["end_line"])),
		);
	};
}

function observation(
	details: Record<string, unknown>,
	metrics: MetricMap,
	references: TelemetryReference[],
): ToolObservation {
	const status = string(details["status"]);
	const code = errorCode(details);
	return {
		metrics,
		references,
		truncated: isTruncated(details),
		...(status === undefined ? {} : { status }),
		...(code === undefined ? {} : { error_code: code }),
	};
}

function fileMetrics(details: Record<string, unknown>): MetricMap {
	const metrics: MetricMap = { truncated: categoricalMetric(isTruncated(details)) };
	pickCount(metrics, "scanned", details, ["scanned_files", "scannedEntries"], "item");
	pickCount(metrics, "candidates", details, ["total_candidates", "totalMatches", "total_entries"], "candidate");
	pickCount(metrics, "returned", details, ["returned_regions", "returnedMatches", "returned_entries"], "item");
	pickCount(metrics, "returned_files", details, ["returned_files"], "file");
	pickCount(metrics, "total_lines", details, ["total_lines"], "line");
	pickCategorical(metrics, "start_line", details, ["start_line"]);
	pickCategorical(metrics, "end_line", details, ["end_line"]);
	pickBytes(metrics, "size_bytes", details, ["size_bytes", "bytes"]);
	pickCount(metrics, "replacements", details, ["replacements"], "replacement");
	const startLine = number(details["start_line"]);
	const endLine = number(details["end_line"]);
	if (startLine !== undefined && endLine !== undefined) metrics["returned_lines"] = countMetric(Math.max(0, endLine - startLine + 1), "line");
	const code = errorCode(details);
	if (code !== undefined) metrics["error_code"] = categoricalMetric(code);
	const lsp = record(details["lsp"]);
	const diagnostics = record(lsp["diagnostics"]);
	for (const key of ["file_errors", "file_warnings", "new_errors", "new_warnings", "resolved_errors", "resolved_warnings"] as const) {
		const value = number(diagnostics[key]);
		if (value !== undefined) metrics[`lsp_${key}`] = countMetric(value, "diagnostic");
	}
	if (isRecord(details["repo_map"])) metrics["repo_map_used"] = categoricalMetric(true);
	else if (Array.isArray(details["related"])) metrics["repo_map_used"] = categoricalMetric(details["related"].length > 0);
	return metrics;
}

function lsCandidates(details: Record<string, unknown>): TelemetryReference[] {
	const entries = Array.isArray(details["entries"]) ? details["entries"].filter(isRecord) : [];
	return entries.flatMap((entry, index) => {
		const path = string(entry["path"]);
		if (path === undefined) return [];
		const kind = entry["type"] === "directory" ? "directory" : entry["type"] === "file" ? "file" : "path";
		return [candidate(index + 1, index + 1, kind, path, "primary", ["filesystem"])];
	});
}

function findCandidates(details: Record<string, unknown>): TelemetryReference[] {
	const result: TelemetryReference[] = [];
	const sourceMap = record(details["candidateSources"]);
	const strategy = details["strategy"] === "fuzzy" ? "fuzzy" : "lexical";
	appendPathCandidates(result, details["displayedMatches"] ?? details["matches"], "primary", (path) => {
		const labels = sourceLabels(sourceMap[path], strategy);
		return strategy === "fuzzy" ? [...new Set([...labels, "fuzzy"])].sort() : labels;
	});
	appendPathCandidates(result, details["displayedCollapsedGroups"] ?? details["collapsedGroups"], "collapsed", () => ["collapsed"], "group");
	appendPathCandidates(result, details["nearby"], "nearby", () => ["fuzzy"]);
	appendPathCandidates(result, details["related"], "related", () => ["repo-map"]);
	return result;
}

function grepCandidates(details: Record<string, unknown>): TelemetryReference[] {
	const result: TelemetryReference[] = [];
	appendRegionCandidates(result, details["regions"], "primary", (item) => sourceLabels(item["sources"], "lexical"));
	appendRegionCandidates(result, details["nearby"], "nearby", () => ["fuzzy"]);
	appendRegionCandidates(result, details["related"], "related", () => ["repo-map"]);
	return result;
}

function appendPathCandidates(
	result: TelemetryReference[],
	value: unknown,
	group: string,
	sources: (path: string) => string[],
	forcedKind?: string,
): void {
	if (!Array.isArray(value)) return;
	for (const [index, item] of value.filter(isRecord).entries()) {
		const path = string(item["path"]);
		if (path === undefined) continue;
		const kind = forcedKind ?? (item["kind"] === "directory" ? "directory" : item["kind"] === "file" ? "file" : "path");
		result.push(candidate(result.length + 1, index + 1, kind, path, group, sources(path)));
	}
}

function appendRegionCandidates(
	result: TelemetryReference[],
	value: unknown,
	group: string,
	sources: (item: Record<string, unknown>) => string[],
): void {
	if (!Array.isArray(value)) return;
	for (const [index, item] of value.filter(isRecord).entries()) {
		const path = string(item["path"]);
		if (path === undefined) continue;
		const start = number(item["start_line"]);
		const end = number(item["end_line"]);
		result.push({
			...candidate(result.length + 1, index + 1, "region", path, group, sources(item)),
			...(start === undefined && end === undefined ? {} : { resource: {
				...(start === undefined ? {} : { start_line: start }),
				...(end === undefined ? {} : { end_line: end }),
			} }),
		});
	}
}

function candidate(globalRank: number, groupRank: number, kind: string, value: string, group: string, sources: string[]): TelemetryReference {
	return {
		relation: "candidate",
		global_rank: globalRank,
		group_rank: groupRank,
		kind,
		value,
		group,
		sources: sources.map((id) => {
			const family = sourceFamily(id);
			return { id, ...(family === undefined ? {} : { family }) };
		}),
	};
}

function projection(value: InputProjection["value"], reference?: TelemetryReference): InputProjection {
	return { value, ...(reference === undefined ? {} : { references: [reference] }) };
}

function pathReference(value: string | undefined, start?: number, end?: number, hash?: string): TelemetryReference | undefined {
	if (value === undefined) return undefined;
	return {
		relation: "target",
		kind: start === undefined && end === undefined ? "path" : "region",
		value,
		...(start === undefined && end === undefined && hash === undefined ? {} : { resource: {
			...(hash === undefined ? {} : { content_hash: { algorithm: "sha256", value: hash } }),
			...(start === undefined ? {} : { start_line: start }),
			...(end === undefined ? {} : { end_line: end }),
		} }),
	};
}

function sourceLabels(value: unknown, fallback: string): string[] {
	const raw = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	const labels = [...raw];
	if (labels.length === 0) labels.push(fallback);
	return [...new Set(labels)].sort();
}

function isTruncated(details: Record<string, unknown>): boolean {
	return details["truncated"] === true
		|| details["outputTruncated"] === true
		|| details["resultLimited"] === true
		|| details["scanTruncated"] === true
		|| details["output_state"] === "truncated"
		|| details["output_state"] === "capture_truncated";
}

function errorCode(details: Record<string, unknown>): string | undefined {
	const error = record(details["error"]);
	return string(error["code"]) ?? string(details["error_code"]);
}

function pickCount(targetMetrics: MetricMap, name: string, source: Record<string, unknown>, keys: readonly string[], unit: string): void {
	for (const key of keys) {
		const value = number(source[key]);
		if (value !== undefined) {
			targetMetrics[name] = countMetric(value, unit);
			return;
		}
	}
}

function pickCategorical(targetMetrics: MetricMap, name: string, source: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
			targetMetrics[name] = categoricalMetric(value);
			return;
		}
	}
}

function pickBytes(targetMetrics: MetricMap, name: string, source: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) {
		const value = number(source[key]);
		if (value !== undefined) {
			targetMetrics[name] = bytesMetric(value);
			return;
		}
	}
}

function sourceFamily(source: string): string | undefined {
	if (source.startsWith("lsp-")) return "lsp";
	if (source.startsWith("repo-map-") || source === "repo-map") return "repo-map";
	if (source === "path" || source === "text" || source === "bm25" || source === "lexical" || source === "fuzzy") return "lexical";
	if (source.startsWith("ast-")) return "ast";
	if (source === "filesystem") return "filesystem";
	return undefined;
}

function contentHash(value: unknown): string | undefined {
	const summary = textSummary(value);
	return typeof summary?.["sha256"] === "string" ? summary["sha256"] : undefined;
}

function resultFileReference(path: string, details: Record<string, unknown>): TelemetryReference | undefined {
	const revision = string(details["new_version"]) ?? string(details["version"]);
	const hash = contentHash(details["content"]);
	const start = number(details["start_line"]);
	const end = number(details["end_line"]);
	if (revision === undefined && hash === undefined && start === undefined && end === undefined) return undefined;
	return {
		relation: "result",
		kind: start === undefined && end === undefined ? "file" : "region",
		value: path,
		resource: {
			...(hash === undefined ? {} : { content_hash: { algorithm: "sha256", value: hash } }),
			...(revision === undefined ? {} : { revision }),
			...(start === undefined ? {} : { start_line: start }),
			...(end === undefined ? {} : { end_line: end }),
		},
	};
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
