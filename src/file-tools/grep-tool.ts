import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";

import { ignoreConfigFromFileTools, isBlockedPath, isIgnoredPath, loadFileToolsConfig, toolPathIdentity, type FileToolsConfig } from "./config.js";
import { fail, isFailed } from "./errors.js";
import { defaultIgnoreEngine } from "./ignore/ignore-engine.js";
import type { IgnoreSnapshot } from "./ignore/ignore-types.js";
import { decodeTextFile, logicalLines } from "./text-file.js";
import type {
	GrepFileMatches,
	GrepLineMatch,
	GrepMode,
	GrepParams,
	GrepSkippedFiles,
	GrepSuccess,
	ToolOutcome,
} from "./types.js";

interface GrepRoot {
	relativePath: string;
	absolutePath: string;
	realPath: string;
	workspacePath: string;
	kind: "file" | "directory";
}

interface NormalizedGrepParams {
	path: string;
	query: string;
	mode: GrepMode;
	regex: boolean;
	ignoreCase: boolean;
	context: number;
	limit: number;
	glob?: string;
}

interface GrepLimits {
	defaultMatchingLines: number;
	maxMatchingLines: number;
	maxModelOutputChars: number;
	maxSnippetChars: number;
	maxContextLines: number;
	maxFileBytes: number;
	maxFilesScanned: number;
}

interface SearchState {
	root: GrepRoot;
	params: NormalizedGrepParams;
	config: FileToolsConfig;
	ignoreSnapshot: IgnoreSnapshot;
	limits: GrepLimits;
	signal?: AbortSignal;
	matchesGlob?: (candidate: string) => boolean;
	files: CompleteFileMatches[];
	skipped: Required<GrepSkippedFiles>;
	scannedFiles: number;
	scanComplete: boolean;
}

interface CompleteFileMatches {
	path: string;
	totalMatchingLines: number;
	totalOccurrences: number;
	lines: CompleteLineMatch[];
	sourceLines: string[];
}

interface CompleteLineMatch {
	line: number;
	occurrences: number;
	text: string;
	firstMatchIndex: number;
	firstMatchLength: number;
}

interface OccurrenceMatcher {
	(line: string): Array<{ index: number; length: number }>;
}

/** grep 只在 workspace 内搜索 UTF-8 普通文本文件；不查路径、不读完整文件给模型、不修改文件。 */
export async function grepWorkspaceFiles(cwd: string, params: GrepParams, signal?: AbortSignal): Promise<ToolOutcome<GrepSuccess>> {
	const config = await loadFileToolsConfig();
	if (isFailed(config)) return config;
	const limits = grepLimits(config);
	const validation = validateGrepParams(params, limits);
	if (isFailed(validation)) return validation;
	const matcher = createMatcher(validation.query, validation.regex, validation.ignoreCase);
	if (isFailed(matcher)) return matcher;

	const workspaceRoot = await realpath(cwd);
	const root = await resolveGrepRoot(workspaceRoot, validation.path, config);
	if (isFailed(root)) return root;
	const globMatcher = validation.glob === undefined ? undefined : picomatch(validation.glob, { dot: true, nonegate: true });
	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot, ignoreConfigFromFileTools(config));
	const state: SearchState = {
		root,
		params: validation,
		config,
		ignoreSnapshot,
		limits,
		...(signal !== undefined ? { signal } : {}),
		...(globMatcher !== undefined ? { matchesGlob: globMatcher } : {}),
		files: [],
		skipped: { binary: 0, invalid_utf8: 0, access_denied: 0, too_large: 0 },
		scannedFiles: 0,
		scanComplete: true,
	};

	try {
		assertNotAborted(signal);
		if (root.kind === "file") {
			const searched = await searchFile(state, root.realPath, root.workspacePath, root.relativePath, matcher, true);
			if (isFailed(searched)) return searched;
		} else {
			await walkDirectory(state, root.realPath, root.workspacePath, ".", matcher);
		}
	} catch (error) {
		if (error instanceof AbortGrep) return fail("OPERATION_ABORTED", "grep was aborted.", { path: root.relativePath });
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Path cannot be searched.", { path: root.relativePath });
		return fail("PATH_NOT_FOUND", "Path does not exist.", { path: root.relativePath });
	}

	state.files.sort((left, right) => compareStableString(left.path, right.path));
	return buildGrepSuccess(state);
}

export function formatCompactGrepResult(result: GrepSuccess, maxChars = 8_000): string {
	const prefix = result.scan_complete ? "" : ">=";
	const total = `${prefix}${result.total_occurrences} occurrences / ${prefix}${result.total_matching_lines} lines / ${prefix}${result.total_files} files`;
	if (result.mode === "count") return appendNotices(total, result, maxChars);

	if (result.mode === "files") {
		const lines = [total];
		for (const file of result.files ?? []) {
			lines.push(`${file.path}  ${file.total_matching_lines} lines / ${file.total_occurrences} occurrences`);
		}
		return appendNotices(lines.join("\n"), result, maxChars);
	}

	const header = result.scan_complete
		? `${result.total_matching_lines} lines / ${result.total_occurrences} occurrences in ${result.total_files} files; showing ${result.returned_lines} lines`
		: `>=${result.total_matching_lines} matching lines in >=${result.total_files} files; scan incomplete; showing ${result.returned_lines} lines`;
	const lines = [header];
	for (const file of result.files ?? []) {
		lines.push("", `${file.path} [${file.total_matching_lines} lines, ${file.total_occurrences} occurrences]`);
		lines.push(...formatFileLines(file));
		if ((file.omitted_lines ?? 0) > 0) lines.push(`... ${file.omitted_lines} matching lines omitted`);
	}
	return appendNotices(lines.join("\n"), result, maxChars);
}

function validateGrepParams(params: GrepParams, limits: GrepLimits): ToolOutcome<NormalizedGrepParams> {
	if (typeof params.path !== "string" || params.path.length === 0) return fail("INVALID_PATH", "path must not be empty.", { path: params.path });
	if (params.path.includes("\0")) return fail("INVALID_PATH", "path must not contain NUL bytes.", { path: params.path });
	if (typeof params.query !== "string" || params.query.length === 0) return fail("INVALID_OPERATION", "query must not be empty.", { path: params.path });
	if (params.query.includes("\0")) return fail("INVALID_OPERATION", "query must not contain NUL bytes.", { path: params.path });
	const mode = params.mode ?? "content";
	if (mode !== "content" && mode !== "files" && mode !== "count") return fail("INVALID_OPERATION", "mode must be content, files, or count.", { path: params.path });
	const context = clampInteger(params.context ?? 0, 0, limits.maxContextLines);
	const limit = clampInteger(params.limit ?? limits.defaultMatchingLines, 1, limits.maxMatchingLines);
	const glob = params.glob === undefined ? undefined : normalizeGlob(params.glob);
	if (glob !== undefined) {
		if (glob.length === 0) return fail("INVALID_PATH", "glob must not be empty.", { path: params.path });
		if (glob.includes("\0")) return fail("INVALID_PATH", "glob must not contain NUL bytes.", { path: params.path });
		if (path.isAbsolute(glob) || /^[A-Za-z]:\//.test(glob)) return fail("INVALID_PATH", "glob must be relative.", { path: params.path });
		if (glob.split("/").some((part) => part === "..")) return fail("INVALID_PATH", "glob must not escape path.", { path: params.path });
	}
	return {
		path: params.path,
		query: params.query,
		mode,
		regex: params.regex === true,
		ignoreCase: params.ignore_case === true,
		context,
		limit,
		...(glob !== undefined ? { glob } : {}),
	};
}

function createMatcher(query: string, regexMode: boolean, ignoreCase: boolean): ToolOutcome<OccurrenceMatcher> {
	if (!regexMode) {
		const needle = ignoreCase ? query.toLocaleLowerCase() : query;
		return (line) => literalOccurrences(ignoreCase ? line.toLocaleLowerCase() : line, needle, query.length);
	}
	let regex: RegExp;
	try {
		regex = new RegExp(query, ignoreCase ? "giu" : "gu");
	} catch (error) {
		return fail("INVALID_REGEX", "query is not a valid regular expression.", {
			details: { error: error instanceof Error ? error.message : String(error) },
		});
	}
	return (line) => regexOccurrences(line, regex);
}

function literalOccurrences(haystack: string, needle: string, length: number): Array<{ index: number; length: number }> {
	const matches: Array<{ index: number; length: number }> = [];
	let offset = 0;
	while (offset <= haystack.length) {
		const index = haystack.indexOf(needle, offset);
		if (index < 0) break;
		matches.push({ index, length });
		offset = index + Math.max(1, needle.length);
	}
	return matches;
}

function regexOccurrences(line: string, regex: RegExp): Array<{ index: number; length: number }> {
	regex.lastIndex = 0;
	const matches: Array<{ index: number; length: number }> = [];
	let match: RegExpExecArray | null;
	while ((match = regex.exec(line)) !== null) {
		const text = match[0] ?? "";
		matches.push({ index: match.index, length: text.length });
		if (text.length === 0) regex.lastIndex += 1;
	}
	return matches;
}

async function resolveGrepRoot(workspaceRoot: string, inputPath: string, config: FileToolsConfig): Promise<ToolOutcome<GrepRoot>> {
	const absolutePath = path.resolve(workspaceRoot, inputPath);
	const workspacePath = workspaceRelative(workspaceRoot, absolutePath);
	if (workspacePath === undefined) return fail("INVALID_PATH", "path must stay inside the workspace.", { path: normalizeRelative(inputPath) });
	const relativePath = workspacePath;
	const identity = toolPathIdentity(relativePath, absolutePath, workspacePath);
	if (isBlockedPath(config, identity)) return fail("PROTECTED_PATH", "Path is blocked by file-tools config.", { path: relativePath });

	let real: string;
	try {
		real = await realpath(absolutePath);
	} catch (error) {
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Path cannot be accessed.", { path: relativePath });
		return fail("PATH_NOT_FOUND", "Path does not exist.", { path: relativePath });
	}
	if (workspaceRelative(workspaceRoot, real) === undefined) {
		return fail("PROTECTED_PATH", "Path resolves outside the workspace.", { path: relativePath });
	}
	const info = await stat(real);
	if (info.isFile()) return { relativePath, absolutePath, realPath: real, workspacePath, kind: "file" };
	if (info.isDirectory()) return { relativePath, absolutePath, realPath: real, workspacePath, kind: "directory" };
	return fail("INVALID_PATH", "Path must be a regular file or directory.", { path: relativePath });
}

async function walkDirectory(
	state: SearchState,
	absoluteDirectory: string,
	workspaceDirectory: string,
	searchRelativeDirectory: string,
	matcher: OccurrenceMatcher,
): Promise<void> {
	assertNotAborted(state.signal);
	if (!state.scanComplete) return;
	if (isBlockedPath(state.config, toolPathIdentity(workspaceDirectory, absoluteDirectory, workspaceDirectory))) return;
	if (isIgnoredPath(state.config, toolPathIdentity(workspaceDirectory, absoluteDirectory, workspaceDirectory))) return;
	if (workspaceDirectory !== ".") {
		const decision = state.ignoreSnapshot.evaluate({ path: workspaceDirectory, kind: "directory", intent: "traverse" });
		if (decision.ignored && decision.prune) return;
	}

	let entries;
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch (error) {
		if (workspaceDirectory === state.root.workspacePath) throw error;
		if (isAccessDenied(error)) state.skipped.access_denied += 1;
		return;
	}

	for (const entry of entries.sort((left, right) => compareStableString(left.name, right.name))) {
		assertNotAborted(state.signal);
		if (!state.scanComplete) return;
		const childWorkspacePath = joinWorkspacePath(workspaceDirectory, entry.name);
		const childAbsolutePath = path.join(absoluteDirectory, entry.name);
		const childSearchPath = searchRelativeDirectory === "." ? entry.name : `${searchRelativeDirectory}/${entry.name}`;
		const identity = toolPathIdentity(childWorkspacePath, childAbsolutePath, childWorkspacePath);
		if (isBlockedPath(state.config, identity)) continue;
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			const decision = state.ignoreSnapshot.evaluate({ path: childWorkspacePath, kind: "directory", intent: "traverse" });
			if (isIgnoredPath(state.config, identity) || (decision.ignored && decision.prune)) continue;
			await walkDirectory(state, childAbsolutePath, childWorkspacePath, childSearchPath, matcher);
			continue;
		}
		if (!entry.isFile()) continue;
		if (state.matchesGlob !== undefined && !state.matchesGlob(childSearchPath)) continue;
		if (isIgnoredPath(state.config, identity)) continue;
		const decision = state.ignoreSnapshot.evaluate({ path: childWorkspacePath, kind: "file", intent: "search" });
		if (decision.ignored) continue;
		await searchFile(state, childAbsolutePath, childWorkspacePath, childWorkspacePath, matcher, false);
	}
}

async function searchFile(
	state: SearchState,
	absolutePath: string,
	workspacePath: string,
	displayPath: string,
	matcher: OccurrenceMatcher,
	explicit: boolean,
): Promise<ToolOutcome<void>> {
	assertNotAborted(state.signal);
	if (state.scannedFiles >= state.limits.maxFilesScanned) {
		state.scanComplete = false;
		return;
	}
	state.scannedFiles += 1;

	if (explicit) {
		if (state.matchesGlob !== undefined && !state.matchesGlob(path.basename(workspacePath)) && !state.matchesGlob(workspacePath)) return;
		if (isIgnoredPath(state.config, toolPathIdentity(workspacePath, absolutePath, workspacePath))) {
			return fail("PROTECTED_PATH", "Path is ignored for search.", { path: displayPath });
		}
		const decision = state.ignoreSnapshot.evaluate({ path: workspacePath, kind: "file", intent: "search" });
		if (decision.ignored) return fail("PROTECTED_PATH", "Path is ignored for search.", { path: displayPath });
	}

	let info;
	try {
		info = await stat(absolutePath);
	} catch (error) {
		if (explicit) return fail(isAccessDenied(error) ? "ACCESS_DENIED" : "FILE_NOT_FOUND", "File cannot be accessed.", { path: displayPath });
		if (isAccessDenied(error)) state.skipped.access_denied += 1;
		return;
	}
	if (info.size > state.limits.maxFileBytes) {
		if (explicit) return fail("OUTPUT_LIMIT_EXCEEDED", "File is too large to search.", { path: displayPath });
		state.skipped.too_large += 1;
		return;
	}

	let bytes: Buffer;
	try {
		bytes = state.signal === undefined ? await readFile(absolutePath) : await readFile(absolutePath, { signal: state.signal });
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw new AbortGrep();
		if (explicit) return fail(isAccessDenied(error) ? "ACCESS_DENIED" : "FILE_NOT_FOUND", "File cannot be read.", { path: displayPath });
		if (isAccessDenied(error)) state.skipped.access_denied += 1;
		return;
	}

	const decoded = decodeTextFile(bytes, displayPath);
	if (isFailed(decoded)) {
		if (explicit) return decoded;
		if (decoded.error.code === "BINARY_FILE_UNSUPPORTED") state.skipped.binary += 1;
		else if (decoded.error.code === "ENCODING_UNSUPPORTED") state.skipped.invalid_utf8 += 1;
		return;
	}

	const matches: CompleteLineMatch[] = [];
	const lines = logicalLines(decoded.text).lines;
	for (let index = 0; index < lines.length; index += 1) {
		assertNotAborted(state.signal);
		const line = lines[index] ?? "";
		const occurrences = matcher(line);
		if (occurrences.length === 0) continue;
		const first = occurrences[0];
		if (first === undefined) continue;
		matches.push({
			line: index + 1,
			occurrences: occurrences.length,
			text: line,
			firstMatchIndex: first.index,
			firstMatchLength: first.length,
		});
	}

	if (matches.length > 0) {
		state.files.push({
			path: displayPath,
			totalMatchingLines: matches.length,
			totalOccurrences: matches.reduce((sum, line) => sum + line.occurrences, 0),
			lines: matches,
			sourceLines: lines,
		});
	}
}

function buildGrepSuccess(state: SearchState): GrepSuccess {
	const totalFiles = state.files.length;
	const totalMatchingLines = state.files.reduce((sum, file) => sum + file.totalMatchingLines, 0);
	const totalOccurrences = state.files.reduce((sum, file) => sum + file.totalOccurrences, 0);
	const selected = state.params.mode === "content" ? enforceContentBudget(state, selectContentFiles(state)) : selectSummaryFiles(state);
	const returnedLines = selected.reduce((sum, file) => sum + file.lines.length, 0);
	const returnedFiles = selected.length;
	const outputTruncated =
		state.params.mode === "count"
			? !state.scanComplete
			: !state.scanComplete || returnedFiles < totalFiles || (state.params.mode === "content" && returnedLines < totalMatchingLines);
	const skipped = compactSkipped(state.skipped);
	const result: GrepSuccess = {
		path: state.root.relativePath,
		query: state.params.query,
		mode: state.params.mode,
		total_files: totalFiles,
		total_matching_lines: totalMatchingLines,
		total_occurrences: totalOccurrences,
		returned_files: state.params.mode === "count" ? 0 : returnedFiles,
		returned_lines: state.params.mode === "content" ? returnedLines : 0,
		scan_complete: state.scanComplete,
		output_truncated: outputTruncated,
	};
	if (state.params.mode !== "count") result.files = selected;
	if (skipped !== undefined) result.skipped_files = skipped;
	if (!state.scanComplete || outputTruncated) result.continuation_hint = "Narrow path, glob, query, or lower context.";
	return result;
}

function selectContentFiles(state: SearchState): GrepFileMatches[] {
	const selected = new Map<string, CompleteLineMatch[]>();
	let selectedCount = 0;
	for (let offset = 0; selectedCount < state.params.limit; offset += 1) {
		let added = false;
		for (const file of state.files) {
			const line = file.lines[offset];
			if (line === undefined) continue;
			const current = selected.get(file.path) ?? [];
			current.push(line);
			selected.set(file.path, current);
			selectedCount += 1;
			added = true;
			if (selectedCount >= state.params.limit) break;
		}
		if (!added) break;
	}
	return state.files
		.filter((file) => selected.has(file.path))
		.map((file) => {
			const lines = (selected.get(file.path) ?? []).sort((left, right) => left.line - right.line);
			const converted = lines.map((line) => convertLine(line, file.sourceLines, state.params.context, state.limits.maxSnippetChars));
			const omitted = file.totalMatchingLines - converted.length;
			const result: GrepFileMatches = {
				path: file.path,
				total_matching_lines: file.totalMatchingLines,
				total_occurrences: file.totalOccurrences,
				lines: converted,
			};
			if (omitted > 0) result.omitted_lines = omitted;
			return result;
		});
}

function selectSummaryFiles(state: SearchState): GrepFileMatches[] {
	const selected: GrepFileMatches[] = [];
	for (const file of state.files) {
		const next: GrepFileMatches = {
			path: file.path,
			total_matching_lines: file.totalMatchingLines,
			total_occurrences: file.totalOccurrences,
			lines: [],
		};
		selected.push(next);
		if (formatCompactGrepResult({ ...emptyResult(state), files: selected, returned_files: selected.length }, state.limits.maxModelOutputChars).length > state.limits.maxModelOutputChars) {
			selected.pop();
			break;
		}
	}
	return selected;
}

function enforceContentBudget(state: SearchState, selected: GrepFileMatches[]): GrepFileMatches[] {
	let result = selected;
	while (result.length > 0) {
		const probe = {
			...emptyResult(state),
			mode: "content" as const,
			files: result,
			returned_files: result.length,
			returned_lines: result.reduce((sum, file) => sum + file.lines.length, 0),
		};
		if (formatCompactGrepResult(probe, state.limits.maxModelOutputChars).length <= state.limits.maxModelOutputChars) return result;
		result = dropLastReturnedLine(result);
	}
	return result;
}

function dropLastReturnedLine(files: GrepFileMatches[]): GrepFileMatches[] {
	const result = files
		.map((file) => ({
			...file,
			lines: [...file.lines],
		}))
		.filter((file) => file.lines.length > 0);
	let targetIndex = -1;
	let targetLine = -1;
	for (let index = 0; index < result.length; index += 1) {
		const file = result[index];
		const line = file?.lines.at(-1)?.line ?? -1;
		if (line > targetLine) {
			targetLine = line;
			targetIndex = index;
		}
	}
	if (targetIndex < 0) return [];
	const target = result[targetIndex];
	if (target === undefined) return [];
	target.lines.pop();
	target.omitted_lines = target.total_matching_lines - target.lines.length;
	return result.filter((file) => file.lines.length > 0);
}

function emptyResult(state: SearchState): GrepSuccess {
	return {
		path: state.root.relativePath,
		query: state.params.query,
		mode: state.params.mode,
		total_files: state.files.length,
		total_matching_lines: state.files.reduce((sum, file) => sum + file.totalMatchingLines, 0),
		total_occurrences: state.files.reduce((sum, file) => sum + file.totalOccurrences, 0),
		returned_files: 0,
		returned_lines: 0,
		scan_complete: state.scanComplete,
		output_truncated: false,
	};
}

function convertLine(line: CompleteLineMatch, sourceLines: string[], context: number, maxSnippetChars: number): GrepLineMatch {
	const snippet = cropAroundMatch(line.text, line.firstMatchIndex, line.firstMatchLength, maxSnippetChars);
	const result: GrepLineMatch = {
		line: line.line,
		occurrences: line.occurrences,
		text: snippet.text,
	};
	if (snippet.truncated) result.text_truncated = true;
	if (context > 0) {
		const before: Array<{ line: number; text: string; text_truncated?: boolean }> = [];
		const after: Array<{ line: number; text: string; text_truncated?: boolean }> = [];
		for (let candidate = line.line - context; candidate < line.line; candidate += 1) {
			const text = sourceLines[candidate - 1];
			if (text !== undefined) before.push(contextLine(candidate, text, maxSnippetChars));
		}
		for (let candidate = line.line + 1; candidate <= line.line + context; candidate += 1) {
			const text = sourceLines[candidate - 1];
			if (text !== undefined) after.push(contextLine(candidate, text, maxSnippetChars));
		}
		if (before.length > 0) result.context_before = before;
		if (after.length > 0) result.context_after = after;
	}
	return result;
}

function contextLine(line: number, text: string, maxSnippetChars: number): { line: number; text: string; text_truncated?: boolean } {
	const cropped = cropPlainLine(text, maxSnippetChars);
	return {
		line,
		text: cropped.text,
		...(cropped.truncated ? { text_truncated: true } : {}),
	};
}

function formatFileLines(file: GrepFileMatches): string[] {
	const rows = new Map<number, { text: string; marker: ">" | "|"; occurrences?: number }>();
	for (const match of file.lines) {
		for (const context of match.context_before ?? []) rows.set(context.line, { text: context.text, marker: "|" });
		rows.set(match.line, { text: match.text, marker: ">", occurrences: match.occurrences });
		for (const context of match.context_after ?? []) {
			if (!rows.has(context.line)) rows.set(context.line, { text: context.text, marker: "|" });
		}
	}
	return Array.from(rows.entries())
		.sort((left, right) => left[0] - right[0])
		.map(([line, row]) => {
			if (row.marker === "|") return `${line}| ${row.text}`;
			const suffix = row.occurrences !== undefined && row.occurrences > 1 ? `×${row.occurrences}` : "";
			return `${line}${suffix}: ${row.text}`;
		});
}

function appendNotices(text: string, result: GrepSuccess, maxChars: number): string {
	const notices: string[] = [];
	if (!result.scan_complete) notices.push("scan incomplete; counts are lower bounds");
	if (result.output_truncated) notices.push("truncated: narrow path, glob, or query");
	if (result.skipped_files !== undefined) notices.push(`skipped: ${formatSkipped(result.skipped_files)}`);
	const withNotices = notices.length > 0 ? `${text}\n\n[${notices.join("; ")}]` : text;
	return withNotices.length <= maxChars ? withNotices : `${withNotices.slice(0, Math.max(0, maxChars - 24))}\n[output truncated]`;
}

function formatSkipped(skipped: GrepSkippedFiles): string {
	const parts: string[] = [];
	if (skipped.binary !== undefined) parts.push(`${skipped.binary} binary`);
	if (skipped.invalid_utf8 !== undefined) parts.push(`${skipped.invalid_utf8} invalid_utf8`);
	if (skipped.access_denied !== undefined) parts.push(`${skipped.access_denied} access_denied`);
	if (skipped.too_large !== undefined) parts.push(`${skipped.too_large} too_large`);
	return parts.join(", ");
}

function cropAroundMatch(text: string, matchIndex: number, matchLength: number, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	const effectiveMax = Math.max(maxChars, matchLength);
	const center = matchIndex + Math.floor(matchLength / 2);
	let start = Math.max(0, center - Math.floor(effectiveMax / 2));
	let end = Math.min(text.length, start + effectiveMax);
	start = Math.max(0, end - effectiveMax);
	if (start > matchIndex) start = matchIndex;
	if (end < matchIndex + matchLength) end = matchIndex + matchLength;
	return {
		text: `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`,
		truncated: true,
	};
}

function cropPlainLine(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: `${text.slice(0, Math.max(0, maxChars - 3))}...`, truncated: true };
}

function compactSkipped(skipped: Required<GrepSkippedFiles>): GrepSkippedFiles | undefined {
	const result: GrepSkippedFiles = {};
	if (skipped.binary > 0) result.binary = skipped.binary;
	if (skipped.invalid_utf8 > 0) result.invalid_utf8 = skipped.invalid_utf8;
	if (skipped.access_denied > 0) result.access_denied = skipped.access_denied;
	if (skipped.too_large > 0) result.too_large = skipped.too_large;
	return Object.keys(result).length === 0 ? undefined : result;
}

function grepLimits(config: FileToolsConfig): GrepLimits {
	return {
		defaultMatchingLines: config.limits.grep_matching_lines,
		maxMatchingLines: config.limits.grep_max_matching_lines,
		maxModelOutputChars: config.limits.grep_model_output_chars,
		maxSnippetChars: config.limits.grep_snippet_chars,
		maxContextLines: config.limits.grep_context_lines,
		maxFileBytes: config.limits.grep_max_file_bytes,
		maxFilesScanned: config.limits.grep_max_files_scanned,
	};
}

function normalizeGlob(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function normalizeRelative(value: string): string {
	return value.replace(/\\/g, "/") || ".";
}

function workspaceRelative(workspaceRoot: string, candidate: string): string | undefined {
	const relative = path.relative(workspaceRoot, candidate);
	if (relative === "") return ".";
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return normalizeRelative(relative);
}

function joinWorkspacePath(parent: string, child: string): string {
	return parent === "." ? child : `${parent}/${child}`;
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isInteger(value)) return min;
	return Math.min(max, Math.max(min, value));
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AbortGrep();
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

class AbortGrep extends Error {}

function isAccessDenied(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}
