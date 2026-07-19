import { createPathIndex, sortedChildren, type PathIndexNode } from "./path-index.js";
import { countTextTokensSync } from "../../token-counter.js";
import type { FindCollapsedGroup, FindDetails, FindMatch, RepoMapRelatedResult } from "../types.js";

const NARROW_RESULT_LIMIT = 20;
const TOP_MATCH_LIMIT = 12;

export interface RenderFindInput {
	query: string;
	path: string;
	glob?: string;
	strategy: FindDetails["strategy"];
	totalMatches: number;
	totalFiles: number;
	totalDirectories: number;
	scannedEntries: number;
	matches: FindMatch[];
	ignoredCount: number;
	skippedCount: number;
	truncated: boolean;
	outputTokenBudget: number;
	related?: RepoMapRelatedResult[];
	suggestions?: FindMatch[];
	missingPrefix?: string;
	nearbyDirectory?: string;
}

/** 渲染 find 成功结果；预算按完整输出行控制，避免截断路径字符串。 */
export function renderFindResults(input: RenderFindInput): { content: string; details: FindDetails } {
	const tokenBudget = input.outputTokenBudget;
	const collapsedGroups = collapseMatches(input.matches);
	if (input.totalMatches === 0) {
		const rendered = appendRelated(renderNoMatches(input, tokenBudget), input.related, tokenBudget);
		return { content: rendered.content, details: buildDetails(input, collapsedGroups, rendered.related) };
	}

	const header = formatHeader(input.totalMatches, input.totalFiles, input.totalDirectories, input.glob);
	const narrowLines = [header, "", ...input.matches.map(formatMatchPath)];
	if (input.matches.length <= NARROW_RESULT_LIMIT && fitsBudget(narrowLines, tokenBudget)) {
		const main = narrowLines.filter((_line, index) => index !== 1 || input.matches.length > 0).join("\n");
		const rendered = appendRelated(main, input.related, tokenBudget);
		return { content: rendered.content, details: buildDetails(input, collapsedGroups, rendered.related) };
	}

	const selected = selectConcreteMatches(input.matches);
	const selectedPaths = new Set(selected.map((match) => match.path));
	const groups = collapseMatches(input.matches.filter((match) => !selectedPaths.has(match.path)));
	const lines = [header, "", "Top matches:", ...selected.map(formatMatchPath)];
	if (groups.length > 0) lines.push("", "Other matches:", ...groups.map(formatGroup));
	if (input.truncated) lines.push("", `Scanned ${input.scannedEntries} entries; results truncated.`);
	const content = takeBudgetedLines(lines, tokenBudget).join("\n");
	return {
		content,
		details: {
			...buildDetails(input, collapsedGroups, []),
			collapsedGroups: groups,
			truncated: input.truncated || selected.length + countCollapsed(groups) < input.matches.length,
		},
	};
}

function renderNoMatches(input: RenderFindInput, tokenBudget: number): string {
	const lines = input.ignoredCount > 0
		? ["No visible matches.", `${input.ignoredCount} matching entries were excluded by ignore rules.`]
		: [`No matches for "${input.query}"${input.glob === undefined ? "" : ` matching "${input.glob}"`}`];
	if (input.missingPrefix !== undefined) lines.push("", `Missing prefix: ${withDirectorySlash(input.missingPrefix)}`);
	if (input.nearbyDirectory !== undefined) lines.push(`Nearby directory: ${withDirectorySlash(input.nearbyDirectory)}`);
	if (input.suggestions !== undefined && input.suggestions.length > 0) {
		lines.push("", "Nearby:", ...input.suggestions.map(formatMatchPath));
	}
	return takeBudgetedLines(lines, tokenBudget).join("\n");
}

function buildDetails(input: RenderFindInput, collapsedGroups: FindCollapsedGroup[], related: RepoMapRelatedResult[]): FindDetails {
	const matches = input.matches.map(({ path, kind }) => ({ path, kind }));
	return {
		query: input.query,
		path: input.path,
		...(input.glob !== undefined ? { glob: input.glob } : {}),
		strategy: input.strategy,
		totalMatches: input.totalMatches,
		returnedMatches: matches.length,
		scannedEntries: input.scannedEntries,
		matches,
		collapsedGroups,
		ignoredCount: input.ignoredCount,
		skippedCount: input.skippedCount,
		truncated: input.truncated,
		...(related.length > 0 ? { related } : {}),
		...(input.suggestions !== undefined && input.suggestions.length > 0 ? { suggestions: input.suggestions } : {}),
		...(input.missingPrefix !== undefined ? { missingPrefix: input.missingPrefix } : {}),
		...(input.nearbyDirectory !== undefined ? { nearbyDirectory: input.nearbyDirectory } : {}),
	};
}

function appendRelated(
	content: string,
	candidates: RepoMapRelatedResult[] | undefined,
	tokenBudget: number,
): { content: string; related: RepoMapRelatedResult[] } {
	if (candidates === undefined || candidates.length === 0) return { content, related: [] };
	const header = "Related (repo-map; query match not guaranteed):";
	const related: RepoMapRelatedResult[] = [];
	let output = content;
	for (const candidate of candidates) {
		const nextRelated = [...related, candidate];
		const next = `${content}\n\n${header}\n${nextRelated.map((item) => `${item.path} [${item.relations.join(" · ")}]`).join("\n")}`;
		if (tokenCount(next) > tokenBudget) break;
		related.push(candidate);
		output = next;
	}
	if (related.length === 0) return { content, related };
	return { content: output, related };
}

function formatHeader(totalMatches: number, files: number, directories: number, glob: string | undefined): string {
	const parts = [`${totalMatches} ${totalMatches === 1 ? "match" : "matches"}`];
	if (files > 0) parts.push(`${files} ${files === 1 ? "file" : "files"}`);
	if (directories > 0) parts.push(`${directories} ${directories === 1 ? "directory" : "directories"}`);
	if (glob !== undefined) parts.push(`glob ${glob}`);
	return parts.join(" · ");
}

function selectConcreteMatches(matches: FindMatch[]): FindMatch[] {
	return matches.slice(0, TOP_MATCH_LIMIT);
}

function collapseMatches(matches: FindMatch[]): FindCollapsedGroup[] {
	if (matches.length === 0) return [];
	const index = createPathIndex(matches);
	const groups: FindCollapsedGroup[] = [];
	for (const child of sortedChildren(index)) collectGroup(child, groups);
	return groups;
}

function collectGroup(node: PathIndexNode, groups: FindCollapsedGroup[]): void {
	const compressed = compressSingleChildDirectory(node);
	if (compressed.entryKind !== undefined && compressed.children.size === 0) return;
	if (compressed.path !== "." && compressed.descendantFileCount + compressed.descendantDirectoryCount > 0) {
		groups.push({
			path: compressed.path,
			files: compressed.descendantFileCount,
			directories: compressed.descendantDirectoryCount,
		});
		return;
	}
	for (const child of sortedChildren(compressed)) collectGroup(child, groups);
}

function compressSingleChildDirectory(node: PathIndexNode): PathIndexNode {
	let current = node;
	while (current.entryKind === undefined && current.children.size === 1) {
		const only = sortedChildren(current)[0];
		if (only === undefined || only.entryKind !== undefined) break;
		current = only;
	}
	return current;
}

function countCollapsed(groups: FindCollapsedGroup[]): number {
	return groups.reduce((sum, group) => sum + group.files + group.directories, 0);
}

function formatMatchPath(match: FindMatch): string {
	return match.kind === "directory" ? withDirectorySlash(match.path) : match.path;
}

function formatGroup(group: FindCollapsedGroup): string {
	const counts = [];
	if (group.files > 0) counts.push(`${group.files} ${group.files === 1 ? "file" : "files"}`);
	if (group.directories > 0) counts.push(`${group.directories} ${group.directories === 1 ? "directory" : "directories"}`);
	return `${withDirectorySlash(group.path)}** (${counts.join(", ")})`;
}

function withDirectorySlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function fitsBudget(lines: string[], tokenBudget: number): boolean {
	return tokenCount(lines.join("\n")) <= tokenBudget;
}

function takeBudgetedLines(lines: string[], tokenBudget: number): string[] {
	const result: string[] = [];
	for (const line of lines) {
		const next = [...result, line].join("\n");
		if (tokenCount(next) > tokenBudget && result.length > 0) break;
		result.push(line);
	}
	return result;
}

function tokenCount(text: string): number {
	return countTextTokensSync(text).tokens;
}
