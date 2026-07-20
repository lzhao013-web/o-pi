import { bytesMetric, categoricalMetric, compactJson, countMetric, isRecord, scalar, textSummary } from "../../telemetry/projectors.js";
import type { InputProjection, MetricMap, TelemetryReference, ToolObservation } from "../../telemetry/types.js";

export function projectScalarInput(keys: readonly string[]): (value: unknown) => InputProjection {
	return (value) => {
		if (!isRecord(value)) return { value: {} };
		return projection(
			compactJson(Object.fromEntries(keys.map((key) => [key, scalar(value[key])]))),
			pathReference(string(value["path"]), number(value["start_line"]), number(value["end_line"])),
		);
	};
}

export function observation(
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

export function fileMetrics(details: Record<string, unknown>): MetricMap {
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

export function appendPathCandidates(
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

export function appendRegionCandidates(
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

export function candidate(globalRank: number, groupRank: number, kind: string, value: string, group: string, sources: string[]): TelemetryReference {
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

export function projection(value: InputProjection["value"], reference?: TelemetryReference): InputProjection {
	return { value, ...(reference === undefined ? {} : { references: [reference] }) };
}

export function pathReference(value: string | undefined, start?: number, end?: number, hash?: string): TelemetryReference | undefined {
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

export function sourceLabels(value: unknown, fallback: string): string[] {
	const raw = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	const labels = [...raw];
	if (labels.length === 0) labels.push(fallback);
	return [...new Set(labels)].sort();
}

export function contentHash(value: unknown): string | undefined {
	const summary = textSummary(value);
	return typeof summary?.["sha256"] === "string" ? summary["sha256"] : undefined;
}

export function resultFileReference(path: string, details: Record<string, unknown>): TelemetryReference | undefined {
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

export function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

export function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function pickCount(target: MetricMap, name: string, source: Record<string, unknown>, keys: readonly string[], unit: string): void {
	for (const key of keys) {
		const value = number(source[key]);
		if (value !== undefined) {
			target[name] = countMetric(value, unit);
			return;
		}
	}
}

function pickCategorical(target: MetricMap, name: string, source: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
			target[name] = categoricalMetric(value);
			return;
		}
	}
}

function pickBytes(target: MetricMap, name: string, source: Record<string, unknown>, keys: readonly string[]): void {
	for (const key of keys) {
		const value = number(source[key]);
		if (value !== undefined) {
			target[name] = bytesMetric(value);
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
