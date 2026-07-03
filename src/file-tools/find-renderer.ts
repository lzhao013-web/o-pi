import { createPathIndex, sortedChildren, type PathIndexNode } from "./path-index.js";
import type { FindDetails } from "./types.js";

const APPROX_CHARS_PER_TOKEN = 4;
const LARGE_GROUP_EXACT_LIMIT = 3;

export interface FindRenderLimits {
	outputTokenBudget: number;
	flatResultLimit: number;
	groupedResultLimit: number;
	maxExactPaths: number;
}

interface RenderState {
	exactPaths: string[];
	collapsedGroups: Array<{ path: string; count: number }>;
	budgetChars: number;
	maxExactPaths: number;
	usedChars: number;
}

/** 渲染 find 结果；模型只看到紧凑文本，完整统计留在 details。 */
export function renderFindResults(
	paths: string[],
	ignoredCount: number,
	truncated: boolean,
	limits: FindRenderLimits,
): { content: string; details: FindDetails } {
	if (paths.length === 0) {
		return {
			content: "0 files",
			details: { total: 0, exactPaths: [], collapsedGroups: [], ignoredCount, truncated },
		};
	}

	const budgetChars = limits.outputTokenBudget * APPROX_CHARS_PER_TOKEN;
	const smallOutput = renderSmall(paths);
	if (paths.length <= limits.flatResultLimit && paths.length <= limits.maxExactPaths && smallOutput.length <= budgetChars) {
		return {
			content: smallOutput,
			details: { total: paths.length, exactPaths: paths, collapsedGroups: [], ignoredCount, truncated },
		};
	}

	if (paths.length <= limits.groupedResultLimit && paths.length <= limits.maxExactPaths) {
		const groupedOutput = renderGroupedExact(paths);
		if (groupedOutput.length <= budgetChars) {
			return {
				content: groupedOutput,
				details: { total: paths.length, exactPaths: paths, collapsedGroups: [], ignoredCount, truncated },
			};
		}
	}

	const index = createPathIndex(paths);
	const state: RenderState = {
		exactPaths: [],
		collapsedGroups: [],
		budgetChars,
		maxExactPaths: limits.maxExactPaths,
		usedChars: `${paths.length} files; `.length,
	};
	for (const child of sortedChildren(index)) {
		addRepresentative(child, state, 0);
	}

	const summarized = state.collapsedGroups.reduce((sum, group) => sum + group.count, 0);
	const header = `${paths.length} files; ${state.exactPaths.length} exact, ${summarized} summarized`;
	const body = [...renderExactTree(state.exactPaths), ...renderCollapsedGroups(state.collapsedGroups)];
	const content = body.length === 0 ? header : `${header}\n\n${body.join("\n")}`;
	return {
		content,
		details: {
			total: paths.length,
			exactPaths: state.exactPaths,
			collapsedGroups: state.collapsedGroups,
			ignoredCount,
			truncated: truncated || state.exactPaths.length + summarized < paths.length,
		},
	};
}

function renderSmall(paths: string[]): string {
	return [`${paths.length} ${paths.length === 1 ? "file" : "files"}`, ...paths].join("\n");
}

function renderGroupedExact(paths: string[]): string {
	return [`${paths.length} ${paths.length === 1 ? "file" : "files"}`, "", ...renderExactTree(paths)].join("\n");
}

function addRepresentative(node: PathIndexNode, state: RenderState, depth: number): void {
	if (!hasBudgetFor(node.path, state)) {
		addCollapsed(node, state);
		return;
	}
	if (node.isFile) {
		addExact(node.path, state);
		return;
	}

	const children = sortedChildren(compressDirectory(node));
	const fileChildren = children.filter((child) => child.isFile);
	const directoryChildren = children.filter((child) => !child.isFile);
	const exactLimit = depth === 0 ? LARGE_GROUP_EXACT_LIMIT : 1;

	if (node.descendantFileCount <= exactLimit || (depth < 2 && directoryChildren.length <= 2 && fileChildren.length <= exactLimit)) {
		for (const child of children) addRepresentative(child, state, depth + 1);
		return;
	}

	let representativeAdded = 0;
	let directFileExactAdded = 0;
	for (const child of fileChildren) {
		if (representativeAdded >= exactLimit || state.exactPaths.length >= state.maxExactPaths) break;
		addExact(child.path, state);
		representativeAdded += 1;
		directFileExactAdded += 1;
	}

	for (const child of directoryChildren) {
		if (representativeAdded < exactLimit && state.exactPaths.length < state.maxExactPaths) {
			addRepresentative(child, state, depth + 1);
			representativeAdded += 1;
		} else {
			addCollapsed(child, state);
		}
	}

	const remainingDirectFiles = fileChildren.length - directFileExactAdded;
	if (remainingDirectFiles > 0) {
		addCollapsed({ ...node, descendantFileCount: remainingDirectFiles }, state);
	}
}

function compressDirectory(node: PathIndexNode): PathIndexNode {
	let current = node;
	while (!current.isFile && current.children.size === 1) {
		const only = sortedChildren(current)[0];
		if (only === undefined || only.isFile) break;
		current = only;
	}
	return current;
}

function addExact(filePath: string, state: RenderState): void {
	if (state.exactPaths.length >= state.maxExactPaths) return;
	state.exactPaths.push(filePath);
	state.usedChars += filePath.length + 1;
}

function addCollapsed(node: PathIndexNode, state: RenderState): void {
	if (node.descendantFileCount <= 0) return;
	const group = { path: node.path, count: node.descendantFileCount };
	state.collapsedGroups.push(group);
	state.usedChars += group.path.length + 12;
}

function hasBudgetFor(pathname: string, state: RenderState): boolean {
	return state.usedChars + pathname.length + 32 < state.budgetChars && state.exactPaths.length < state.maxExactPaths;
}

function renderExactTree(paths: string[]): string[] {
	const groups = new Map<string, string[]>();
	for (const filePath of paths) {
		const slash = filePath.lastIndexOf("/");
		const directory = slash === -1 ? "." : filePath.slice(0, slash);
		const name = slash === -1 ? filePath : filePath.slice(slash + 1);
		const list = groups.get(directory) ?? [];
		list.push(name);
		groups.set(directory, list);
	}

	const lines: string[] = [];
	for (const [directory, names] of Array.from(groups.entries()).sort((a, b) => compareStableString(a[0], b[0]))) {
		names.sort(compareStableString);
		if (directory === ".") {
			lines.push(...names);
			continue;
		}
		lines.push(`${directory}/`);
		for (const name of names) lines.push(`  ${name}`);
		lines.push("");
	}
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function renderCollapsedGroups(groups: Array<{ path: string; count: number }>): string[] {
	return groups
		.filter((group) => group.count > 0)
		.sort((a, b) => compareStableString(a.path, b.path))
		.map((group) => `${group.path}/** (${group.count})`);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
