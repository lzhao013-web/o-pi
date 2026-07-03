import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { ignoreConfigFromFileTools, isBlockedPath, isIgnoredPath, loadFileToolsConfig, toolPathIdentity, type FileToolsConfig } from "./config.js";
import { fail, isFailed } from "./errors.js";
import { renderFindResults } from "./find-renderer.js";
import { defaultIgnoreEngine } from "./ignore/ignore-engine.js";
import type { IgnoreSnapshot } from "./ignore/ignore-types.js";
import { resolveWorkspaceRoot } from "./path-resolver.js";
import type { FindParams, FindSuccess, ToolOutcome } from "./types.js";

interface SearchRoot {
	relativePath: string;
	absolutePath: string;
	workspacePath: string;
}

interface WalkState {
	workspaceRoot: string;
	searchRoot: SearchRoot;
	pattern: string;
	matchesGlob: (candidate: string) => boolean;
	ignoreSnapshot: IgnoreSnapshot;
	config: FileToolsConfig;
	signal?: AbortSignal;
	matches: string[];
	ignoredCount: number;
	skippedCount: number;
	maxMatchesScanned: number;
	truncated: boolean;
}

/** find 在 workspace 内按 glob 递归查找普通文件；不读取内容、不跟随目录 symlink。 */
export async function findWorkspaceFiles(cwd: string, params: FindParams, signal?: AbortSignal): Promise<ToolOutcome<FindSuccess>> {
	const validation = validateFindParams(params);
	if (isFailed(validation)) return validation;
	const config = await loadFileToolsConfig();
	if (isFailed(config)) return config;
	const workspaceRoot = await resolveWorkspaceRoot(cwd);
	const searchRoot = await resolveWorkspaceSearchRoot(workspaceRoot, validation.path, config);
	if (isFailed(searchRoot)) return searchRoot;
	const prefix = staticGlobPrefix(validation.pattern);
	if (isFailed(prefix)) return prefix;

	const ignoreSnapshot = await defaultIgnoreEngine.createSnapshot(workspaceRoot, ignoreConfigFromFileTools(config));
	const matchPattern = picomatch(validation.pattern, { dot: true, nonegate: true });
	const state: WalkState = {
		workspaceRoot,
		searchRoot,
		pattern: validation.pattern,
		matchesGlob: (candidate) => matchPattern(candidate),
		ignoreSnapshot,
		config,
		...(signal !== undefined ? { signal } : {}),
		matches: [],
		ignoredCount: 0,
		skippedCount: 0,
		maxMatchesScanned: config.limits.find_max_matches_scanned,
		truncated: false,
	};

	try {
		assertNotAborted(signal);
		const walkRoot = await childSearchRoot(searchRoot, prefix, config);
		if (isFailed(walkRoot)) return walkRoot;
		if (walkRoot === undefined) return renderFindResults([], state.ignoredCount, state.truncated, findRenderLimits(config));
		await walkDirectory(state, walkRoot.absolutePath, walkRoot.workspacePath, relativeToSearchRoot(searchRoot.workspacePath, walkRoot.workspacePath));
	} catch (error) {
		if (error instanceof AbortSearch) {
			return fail("OPERATION_ABORTED", "find was aborted.", { path: searchRoot.relativePath });
		}
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Directory cannot be searched.", { path: searchRoot.relativePath });
		return fail("PATH_NOT_FOUND", "Directory does not exist.", { path: searchRoot.relativePath });
	}

	const sorted = state.matches.sort(compareFindPaths(validation.pattern));
	const rendered = renderFindResults(sorted, state.ignoredCount, state.truncated, findRenderLimits(config));
	return {
		content: rendered.content,
		details: {
			...rendered.details,
			truncated: rendered.details.truncated || state.truncated,
		},
	};
}

function validateFindParams(params: FindParams): ToolOutcome<Required<FindParams>> {
	if (typeof params.pattern !== "string" || params.pattern.trim().length === 0) {
		return fail("INVALID_PATH", "pattern must not be empty.");
	}
	if (params.pattern.includes("\0")) return fail("INVALID_PATH", "pattern must not contain NUL bytes.", { path: params.pattern });
	const pattern = normalizeGlob(params.pattern);
	if (path.isAbsolute(pattern) || /^[A-Za-z]:\//.test(pattern)) {
		return fail("INVALID_PATH", "pattern must be relative to path.", { path: params.pattern });
	}
	if (pattern.split("/").some((part) => part === "..")) {
		return fail("INVALID_PATH", "pattern must not escape path.", { path: params.pattern });
	}
	const searchPath = params.path ?? ".";
	if (searchPath.length === 0) return fail("INVALID_PATH", "path must not be empty.", { path: searchPath });
	if (searchPath.includes("\0")) return fail("INVALID_PATH", "path must not contain NUL bytes.", { path: searchPath });
	if (path.isAbsolute(searchPath)) return fail("INVALID_PATH", "path must be workspace-relative.", { path: searchPath });
	return { pattern, path: searchPath };
}

async function resolveWorkspaceSearchRoot(
	workspaceRoot: string,
	inputPath: string,
	config: FileToolsConfig,
): Promise<ToolOutcome<SearchRoot>> {
	const absolutePath = path.resolve(workspaceRoot, inputPath);
	const workspacePath = workspaceRelative(workspaceRoot, absolutePath);
	if (workspacePath === undefined) return fail("INVALID_PATH", "path must stay inside the workspace.", { path: normalizeRelative(inputPath) });
	const relativePath = workspacePath;
	const identity = toolPathIdentity(relativePath, absolutePath, workspacePath);
	if (isBlockedPath(config, identity)) return fail("PROTECTED_PATH", "Path is blocked by file-tools config.", { path: relativePath });

	try {
		const info = await lstat(absolutePath);
		if (!info.isDirectory()) return fail("NOT_A_DIRECTORY", "Path is not a directory.", { path: relativePath });
	} catch (error) {
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Directory cannot be searched.", { path: relativePath });
		return fail("PATH_NOT_FOUND", "Directory does not exist.", { path: relativePath });
	}
	return { relativePath, absolutePath, workspacePath };
}

async function childSearchRoot(root: SearchRoot, prefix: string, config: FileToolsConfig): Promise<ToolOutcome<SearchRoot | undefined>> {
	if (prefix === ".") return root;
	let workspacePath = root.workspacePath;
	let absolutePath = root.absolutePath;
	for (const segment of prefix.split("/")) {
		workspacePath = joinWorkspacePath(workspacePath, segment);
		absolutePath = path.join(absolutePath, segment);
		if (isBlockedPath(config, toolPathIdentity(workspacePath, absolutePath, workspacePath))) return undefined;
		try {
			const info = await lstat(absolutePath);
			if (!info.isDirectory()) return undefined;
		} catch {
			return undefined;
		}
	}
	return {
		relativePath: workspacePath,
		absolutePath,
		workspacePath,
	};
}

async function walkDirectory(state: WalkState, absoluteDirectory: string, workspaceDirectory: string, searchRelativeDirectory: string): Promise<void> {
	assertNotAborted(state.signal);
	if (state.truncated) return;
	if (isBlockedPath(state.config, toolPathIdentity(workspaceDirectory, absoluteDirectory, workspaceDirectory))) return;
	if (isIgnoredPath(state.config, toolPathIdentity(workspaceDirectory, absoluteDirectory, workspaceDirectory))) {
		state.ignoredCount += 1;
		return;
	}
	if (workspaceDirectory !== ".") {
		const directoryDecision = state.ignoreSnapshot.evaluate({ path: workspaceDirectory, kind: "directory", intent: "traverse" });
		if (directoryDecision.ignored && directoryDecision.prune) {
			state.ignoredCount += 1;
			return;
		}
	}

	let entries;
	try {
		entries = await readdir(absoluteDirectory, { withFileTypes: true });
	} catch (error) {
		if (searchRelativeDirectory === ".") throw error;
		state.skippedCount += 1;
		return;
	}

	for (const entry of entries.sort((a, b) => compareStableString(a.name, b.name))) {
		assertNotAborted(state.signal);
		if (state.matches.length >= state.maxMatchesScanned) {
			state.truncated = true;
			return;
		}
		const childWorkspacePath = joinWorkspacePath(workspaceDirectory, entry.name);
		const childAbsolutePath = path.join(absoluteDirectory, entry.name);
		const childSearchPath = searchRelativeDirectory === "." ? entry.name : `${searchRelativeDirectory}/${entry.name}`;
		const identity = toolPathIdentity(childWorkspacePath, childAbsolutePath, childWorkspacePath);
		if (isBlockedPath(state.config, identity)) continue;
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			const decision = state.ignoreSnapshot.evaluate({ path: childWorkspacePath, kind: "directory", intent: "traverse" });
			if (isIgnoredPath(state.config, identity) || (decision.ignored && decision.prune)) {
				state.ignoredCount += 1;
				continue;
			}
			await walkDirectory(state, childAbsolutePath, childWorkspacePath, childSearchPath);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!state.matchesGlob(childSearchPath)) continue;
		if (isIgnoredPath(state.config, identity)) {
			state.ignoredCount += 1;
			continue;
		}
		const decision = state.ignoreSnapshot.evaluate({ path: childWorkspacePath, kind: "file", intent: "search" });
		if (decision.ignored) {
			state.ignoredCount += 1;
			continue;
		}
		state.matches.push(childWorkspacePath);
	}
}

function staticGlobPrefix(pattern: string): ToolOutcome<string> {
	const segments = pattern.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	if (segments.length === 0) return ".";
	const prefix: string[] = [];
	for (const segment of segments) {
		if (hasGlobSyntax(segment)) break;
		prefix.push(segment);
	}
	if (prefix.length === segments.length) prefix.pop();
	return prefix.length === 0 ? "." : prefix.join("/");
}

function hasGlobSyntax(segment: string): boolean {
	return /[*?[\]{}()!+@]/.test(segment);
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

function relativeToSearchRoot(searchRoot: string, candidate: string): string {
	if (candidate === searchRoot) return ".";
	return candidate.slice(searchRoot.length + 1);
}

function compareFindPaths(pattern: string): (left: string, right: string) => number {
	const literals = literalFragments(pattern);
	return (left, right) => {
		const relevance = relevanceScore(right, literals, pattern) - relevanceScore(left, literals, pattern);
		if (relevance !== 0) return relevance;
		const length = left.length - right.length;
		if (length !== 0) return length;
		const depth = pathDepth(left) - pathDepth(right);
		if (depth !== 0) return depth;
		return compareStableString(left, right);
	};
}

function relevanceScore(filePath: string, literals: string[], pattern: string): number {
	const basename = filePath.split("/").at(-1) ?? filePath;
	let score = basename === pattern ? 100 : 0;
	for (const literal of literals) {
		if (literal.length === 0) continue;
		if (basename.includes(literal)) score += 10 + literal.length;
		else if (filePath.includes(literal)) score += literal.length;
	}
	return score;
}

function literalFragments(pattern: string): string[] {
	return pattern.split(/[*?[\]{}()!+@|,\\/]+/).filter((part) => part.length > 3);
}

function pathDepth(filePath: string): number {
	return filePath.split("/").length;
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function findRenderLimits(config: FileToolsConfig): {
	outputTokenBudget: number;
	flatResultLimit: number;
	groupedResultLimit: number;
	maxExactPaths: number;
} {
	return {
		outputTokenBudget: config.limits.find_output_token_budget,
		flatResultLimit: config.limits.find_flat_result_limit,
		groupedResultLimit: config.limits.find_grouped_result_limit,
		maxExactPaths: config.limits.find_max_exact_paths,
	};
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AbortSearch();
}

class AbortSearch extends Error {}

function isAccessDenied(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}
