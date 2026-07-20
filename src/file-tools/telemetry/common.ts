import { fields, isRecord, scalar, textFields } from "../../telemetry/projection.js";
import type { Candidate, Fields, Resource, TelemetryFacts } from "../../telemetry/types.js";

/** Project explicit scalar inputs; query-like strings are retained only as size and hash. */
export function projectFileInput(keys: readonly string[], targetKind: string): (value: unknown) => TelemetryFacts {
	return (value) => {
		if (!isRecord(value)) return {};
		const projected: Fields = {};
		for (const key of keys) {
			if (key === "path") continue;
			const raw = value[key];
			if (typeof raw === "string" && ["query", "glob", "match"].includes(key)) {
				Object.assign(projected, textFields(`input_${key}`, raw));
			} else {
				const item = scalar(raw);
				if (item !== undefined) projected[`input_${key}`] = item;
			}
		}
		const path = string(value["path"]);
		return {
			...(Object.keys(projected).length === 0 ? {} : { fields: projected }),
			...(path === undefined ? {} : { targets: [pathTarget(path, targetKind, number(value["start_line"]), number(value["end_line"]))] }),
		};
	};
}

export function fileResultFields(details: Record<string, unknown>): Fields {
	const repoMap = record(details["repo_map"]);
	return fields({
		status: string(details["status"]),
		error_code: errorCode(details),
		truncated: truncated(details),
		strategy: stringList(details["strategy"]) ?? string(details["strategy"]),
		total_candidate_count: firstNumber(details, ["total_candidates", "totalMatches"]),
		returned_match_count: firstNumber(details, ["returnedMatches", "returned_regions"]),
		returned_file_count: number(details["returned_files"]),
		returned_entry_count: number(details["returned_entries"]),
		scanned_file_count: number(details["scanned_files"]),
		replacement_count: number(details["replacements"]),
		size_bytes: firstNumber(details, ["size_bytes", "bytes"]),
		before_size_bytes: firstNumber(details, ["before_size_bytes", "old_size_bytes"]),
		after_size_bytes: firstNumber(details, ["after_size_bytes", "new_size_bytes"]),
		repo_map_used: isRecord(details["repo_map"])
			? true
			: Array.isArray(details["related"])
				? details["related"].length > 0
				: undefined,
		repo_map_status: string(repoMap["status"]),
	});
}

export function appendPathCandidates(
	result: Candidate[],
	value: unknown,
	group: string,
	sources: (path: string) => string[],
	forcedKind?: string,
): void {
	if (!Array.isArray(value)) return;
	for (const item of value.filter(isRecord)) {
		const path = string(item["path"]);
		if (path === undefined) continue;
		result.push({
			kind: forcedKind ?? (item["kind"] === "directory" ? "directory" : item["kind"] === "file" ? "file" : "path"),
			value: path,
			rank: result.length + 1,
			group,
			sources: [...new Set(sources(path))].sort(),
			...lineRange(item),
		});
	}
}

export function appendRegionCandidates(
	result: Candidate[],
	value: unknown,
	group: string,
	sources: (item: Record<string, unknown>) => string[],
): void {
	if (!Array.isArray(value)) return;
	for (const item of value.filter(isRecord)) {
		const path = string(item["path"]);
		if (path === undefined) continue;
		result.push({
			kind: "region",
			value: path,
			rank: result.length + 1,
			group,
			sources: [...new Set(sources(item))].sort(),
			...lineRange(item),
		});
	}
}

export function pathTarget(value: string, kind = "path", startLine?: number, endLine?: number): Resource {
	return {
		kind: startLine === undefined && endLine === undefined ? kind : "region",
		value,
		...(startLine === undefined ? {} : { start_line: startLine }),
		...(endLine === undefined ? {} : { end_line: endLine }),
	};
}

export function sourceLabels(value: unknown, fallback: string): string[] {
	const values = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	return [...new Set(values.length === 0 ? [fallback] : values)].sort();
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

function errorCode(details: Record<string, unknown>): string | undefined {
	return string(record(details["error"])["code"]) ?? string(details["error_code"]);
}

function truncated(details: Record<string, unknown>): boolean | undefined {
	if (["truncated", "outputTruncated", "resultLimited", "scanTruncated"].some((key) => details[key] === true)) return true;
	return undefined;
}

function firstNumber(details: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = number(details[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
	return value;
}

function lineRange(value: Record<string, unknown>): Pick<Resource, "start_line" | "end_line"> {
	const startLine = number(value["start_line"]);
	const endLine = number(value["end_line"]);
	return {
		...(startLine === undefined ? {} : { start_line: startLine }),
		...(endLine === undefined ? {} : { end_line: endLine }),
	};
}
