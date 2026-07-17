import { countTextTokensSync } from "../token-counter.js";
import type { RepoMapReadContext } from "./file-tool-query.js";
import type { RepoMapImpactResult } from "./impact.js";

export const READ_REPO_MAP_TOKEN_BUDGET = 160;
export const REPO_IMPACT_TOKEN_BUDGET = 120;

/** Render only model-actionable read context under a hard token budget. */
export function formatRepoMapReadContext(context: RepoMapReadContext | undefined): string | undefined {
	if (context === undefined) return undefined;
	const symbolName = context.symbol.qualifiedName ?? context.symbol.name ?? "anonymous";
	const attrs = [
		`symbol="${escapeXmlAttribute(compact(`${context.symbol.kind} ${symbolName} ${context.symbol.startLine}-${context.symbol.endLine}`, 120))}"`,
	];
	if (context.publicApi) attrs.push('public-api="true"');
	if (context.package !== undefined) attrs.push(`package="${escapeXmlAttribute(compact(context.package, 64))}"`);
	if (context.component !== undefined) attrs.push(`component="${escapeXmlAttribute(compact(context.component, 64))}"`);
	if (context.relatedTests !== undefined && context.relatedTests.length > 0) {
		attrs.push(`tests="${escapeXmlAttribute(context.relatedTests.slice(0, 2).map((value) => compact(value, 80)).join(", "))}"`);
	}
	for (const [name, values] of [
		["callers", context.callers],
		["callees", context.callees],
		["references", context.references],
		["imports", context.imports],
	] as const) {
		if (values.length > 0) attrs.push(`${name}="${escapeXmlAttribute(values.slice(0, 2).map((value) => compact(value, 96)).join(", "))}"`);
	}
	if (context.entrypoints !== undefined && context.entrypoints.length > 0) {
		attrs.push(`entrypoints="${escapeXmlAttribute(context.entrypoints.slice(0, 2).map((value) => compact(value, 80)).join(", "))}"`);
	}
	return budgetedBlock("repo-map", attrs, READ_REPO_MAP_TOKEN_BUDGET);
}

/** Render mutation impact without repeating facts already present on the outer write/edit result. */
export function formatRepoMapImpact(impact: RepoMapImpactResult | undefined): string | undefined {
	if (impact === undefined) return undefined;
	const publicChanges = new Set(impact.publicApiChanges);
	const symbolChanges = [...impact.changedSymbols, ...impact.publicApiChanges.filter((value) => !impact.changedSymbols.includes(value))]
		.slice(0, 3)
		.map((value) => compact(`${publicChanges.has(value) ? "api " : ""}${value}`, 72));
	const attrs: string[] = [];
	if (symbolChanges.length > 0) attrs.push(`symbols="${escapeXmlAttribute(symbolChanges.join(", "))}"`);
	const tests = uniquePaths(impact.candidates.filter((candidate) => candidate.role === "test"), 3);
	const testPaths = new Set(tests.map((candidate) => candidate.path));
	const affected = uniquePaths(impact.candidates.filter((candidate) => candidate.role !== "changed"
		&& candidate.role !== "test"
		&& candidate.path !== impact.changedPath
		&& !testPaths.has(candidate.path)), 4);
	if (affected.length > 0) attrs.push(`affected="${escapeXmlAttribute(affected.map((candidate) => `${compact(candidate.path, 72)}:${candidate.role}`).join(", "))}"`);
	if (tests.length > 0) attrs.push(`tests="${escapeXmlAttribute(tests.map((candidate) => compact(candidate.path, 80)).join(", "))}"`);
	return budgetedBlock("repo-impact", attrs, REPO_IMPACT_TOKEN_BUDGET);
}

function uniquePaths<T extends { path: string }>(values: readonly T[], limit: number): T[] {
	const paths = new Set<string>();
	const result: T[] = [];
	for (const value of values) {
		if (paths.has(value.path)) continue;
		paths.add(value.path);
		result.push(value);
		if (result.length === limit) break;
	}
	return result;
}

function compact(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function budgetedBlock(name: string, fields: readonly string[], tokenBudget: number): string | undefined {
	const selected: string[] = [];
	for (const field of fields) {
		const candidate = renderBlock(name, [...selected, field]);
		if (countTextTokensSync(candidate).tokens <= tokenBudget) selected.push(field);
	}
	return selected.length === 0 ? undefined : renderBlock(name, selected);
}

function renderBlock(name: string, fields: readonly string[]): string {
	return `<${name}>\n${fields.join(" ")}\n</${name}>`;
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
