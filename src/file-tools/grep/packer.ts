import { countTextTokensSync } from "../../token-counter.js";
import { byteRangeForLines, extractByteRange } from "../../code-index/parser.js";
import type { RankedGrepRegion } from "./ranker.js";
import type { GrepMatchMode, GrepRegion, GrepSkippedFiles, GrepSuccess } from "../types.js";

export interface GrepPackInput {
	query: string;
	path: string;
	match: GrepMatchMode;
	strategy: string[];
	totalCandidates: number;
	regions: RankedGrepRegion[];
	sourceText: Map<string, string>;
	tokenBudget: number;
	resultLimit: number;
	skipped?: GrepSkippedFiles;
	scanComplete: boolean;
	nearSymbols: string[];
}

interface PackState {
	budgetTokens: number;
	bodyCount: number;
	usedTokens: number;
	regions: GrepRegion[];
	usedFiles: Set<string>;
}

/** 在预算内选择正文、片段和签名；不会对已选 UTF-8 文本做任意字节截断。 */
export function packGrepResults(input: GrepPackInput): GrepSuccess {
	const selected = selectGrepCandidatesForPacking(input.regions, input.resultLimit);
	const state: PackState = {
		budgetTokens: input.tokenBudget,
		bodyCount: 0,
		usedTokens: tokenCount(headerText(input, false)),
		regions: [],
		usedFiles: new Set(),
	};

	for (const candidate of selected) {
		const region = packRegion(candidate, input.sourceText.get(candidate.path), state);
		const projected = projectedTokens(input, state, region);
		if (state.regions.length > 0 && projected > state.budgetTokens) {
			const signature = signatureRegion(candidate);
			const signatureCost = projectedTokens(input, state, signature);
			if (signatureCost > state.budgetTokens) break;
			addRegion(input, state, signature);
			continue;
		}
		addRegion(input, state, region);
	}

	const totalFiles = new Set(input.regions.map((region) => region.path)).size;
	const returnedFiles = state.usedFiles.size;
	const truncated = !input.scanComplete || state.regions.length < input.regions.length;
	const approxTokens = tokenCount(renderPackedBody(input, state.regions, returnedFiles, truncated));
	const success: GrepSuccess = {
		status: "success",
		query: input.query,
		path: input.path,
		match: input.match,
		strategy: input.strategy,
		total_candidates: input.totalCandidates,
		returned_regions: state.regions.length,
		returned_files: returnedFiles,
		approx_tokens: approxTokens,
		truncated,
		regions: state.regions,
	};
	if (input.skipped !== undefined && Object.keys(input.skipped).length > 0) success.skipped_files = input.skipped;
	if (input.nearSymbols.length > 0) success.near_symbols = input.nearSymbols;
	void totalFiles;
	return success;
}

export function renderGrepSuccess(result: GrepSuccess): string {
	const lines = [grepOpenTag(result)];
	if (result.regions.length === 0) {
		lines.push(result.near_symbols !== undefined && result.near_symbols.length > 0 ? `near symbols: ${result.near_symbols.join(", ")}` : "no regions");
		lines.push("</grep>");
		return lines.join("\n");
	}
	for (const region of result.regions) {
		lines.push("", renderRegion(region));
	}
	const omitted = result.total_candidates - result.returned_regions;
	if (omitted > 0) lines.push("", `... ${omitted} lower-ranked regions omitted`);
	if (result.skipped_files !== undefined) lines.push("", `skipped: ${formatSkipped(result.skipped_files)}`);
	lines.push("</grep>");
	return lines.join("\n");
}

function renderPackedBody(input: GrepPackInput, regions: GrepRegion[], returnedFiles: number, truncated: boolean): string {
	return renderGrepSuccess({
		status: "success",
		query: input.query,
		path: input.path,
		match: input.match,
		strategy: input.strategy,
		total_candidates: input.totalCandidates,
		returned_regions: regions.length,
		returned_files: returnedFiles,
		approx_tokens: 0,
		truncated,
		regions,
	});
}

function packRegion(candidate: RankedGrepRegion, text: string | undefined, state: PackState): GrepRegion {
	if (text === undefined) return signatureRegion(candidate);
	if (candidate.kind === "text") return snippetRegion(candidate, text);
	const full = extractByteRange(text, candidate.startByte, candidate.endByte);
	const fullCost = tokenCount(full) + 40;
	if (state.bodyCount < 2 && full.length > 0 && fullCost < state.budgetTokens * 0.45 && state.usedTokens + fullCost <= state.budgetTokens) {
		state.bodyCount += 1;
		return baseRegion(candidate, "body", full);
	}
	if (state.bodyCount < 2 && candidate.matchLines.length > 0) return snippetRegion(candidate, text);
	return signatureRegion(candidate);
}

function snippetRegion(candidate: RankedGrepRegion, text: string): GrepRegion {
	const startLine = candidate.matchLines.length > 0 ? Math.max(candidate.startLine, Math.min(...candidate.matchLines) - 4) : candidate.startLine;
	const endLine = candidate.matchLines.length > 0 ? Math.min(candidate.endLine, Math.max(...candidate.matchLines) + 4) : candidate.endLine;
	const range = byteRangeForLines(text, startLine, endLine);
	const snippet = extractByteRange(text, range.startByte, range.endByte);
	return {
		...baseRegion(candidate, "snippet", `${startLine > candidate.startLine ? "[...]\n" : ""}${snippet}${endLine < candidate.endLine ? "\n[...]" : ""}`),
		start_line: startLine,
		end_line: endLine,
	};
}

function signatureRegion(candidate: RankedGrepRegion): GrepRegion {
	return baseRegion(candidate, "signature", undefined);
}

function baseRegion(candidate: RankedGrepRegion, detail: GrepRegion["detail"], content: string | undefined): GrepRegion {
	const region: GrepRegion = {
		path: candidate.path,
		start_line: candidate.startLine,
		end_line: candidate.endLine,
		kind: candidate.kind,
		detail,
		reasons: candidate.reasons,
	};
	if (candidate.symbol !== undefined) region.symbol = candidate.symbol;
	if (candidate.signature !== undefined) region.signature = candidate.signature;
	if (candidate.matchLines.length > 0) region.match_lines = candidate.matchLines.sort((left, right) => left - right);
	if (content !== undefined && content.length > 0 && detail !== "signature") region.content = content;
	if (detail === "signature" && candidate.callees.length > 0) region.callees = candidate.callees.slice(0, 6);
	if (detail === "signature" && candidate.imports.length > 0) region.imports = candidate.imports.slice(0, 4);
	return region;
}

function renderRegion(region: GrepRegion): string {
	const headerSymbol = region.symbol ?? region.signature;
	const header = `${region.path}:${region.start_line}${region.end_line === region.start_line ? "" : `-${region.end_line}`}`;
	const label = headerSymbol === undefined ? `${region.kind} [${region.reasons.join(" · ")}]` : `${headerSymbol} [${region.reasons.join(" · ")}]`;
	const lines = [`${header}`, label];
	if (region.callees !== undefined) lines.push(`calls: ${region.callees.join(", ")}`);
	if (region.imports !== undefined) lines.push(`imports: ${region.imports.join(", ")}`);
	if (region.content !== undefined) lines.push("", region.content);
	return lines.join("\n");
}

function addRegion(input: GrepPackInput, state: PackState, region: GrepRegion): void {
	state.regions.push(region);
	state.usedFiles.add(region.path);
	state.usedTokens = tokenCount(renderPackedBody(input, state.regions, state.usedFiles.size, false));
}

export function selectGrepCandidatesForPacking(regions: RankedGrepRegion[], limit: number): RankedGrepRegion[] {
	const selected: RankedGrepRegion[] = [];
	const used = new Set<string>();
	const categoryCounts = new Map<string, number>();
	const categoryCap = Math.max(1, Math.ceil(limit / 2));
	for (const region of regions) {
		if (selected.length >= limit) break;
		if (used.has(region.path)) continue;
		const category = relationCategory(region);
		if ((categoryCounts.get(category) ?? 0) >= categoryCap && hasUnrepresentedCategory(regions, selected, categoryCounts, categoryCap)) continue;
		selected.push(region);
		used.add(region.path);
		categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
	}
	for (const region of regions) {
		if (selected.length >= limit) break;
		if (selected.some((item) => item.id === region.id)) continue;
		selected.push(region);
	}
	return selected.sort((left, right) => regions.indexOf(left) - regions.indexOf(right));
}

function relationCategory(region: RankedGrepRegion): string {
	if (region.reasons.some((reason) => reason === "exact literal" || reason === "regex" || reason === "exact symbol" || reason === "exact qualified symbol")) return "direct";
	if (region.reasons.includes("definition") || region.reasons.includes("export")) return "definition";
	if (region.reasons.includes("caller")) return "caller";
	if (region.reasons.includes("callee")) return "callee";
	if (region.reasons.includes("reference")) return "reference";
	if (region.reasons.includes("import")) return "import";
	return "related";
}

function hasUnrepresentedCategory(
	regions: RankedGrepRegion[],
	selected: RankedGrepRegion[],
	counts: ReadonlyMap<string, number>,
	cap: number,
): boolean {
	const selectedIds = new Set(selected.map((region) => region.id));
	return regions.some((region) => !selectedIds.has(region.id) && (counts.get(relationCategory(region)) ?? 0) < cap);
}

function headerText(input: GrepPackInput, truncated: boolean): string {
	return grepOpenTag({
		strategy: input.strategy,
		truncated,
	});
}

function projectedTokens(input: GrepPackInput, state: PackState, region: GrepRegion): number {
	const files = new Set(state.usedFiles);
	files.add(region.path);
	return tokenCount(renderPackedBody(input, [...state.regions, region], files.size, false));
}

function tokenCount(text: string): number {
	return countTextTokensSync(text).tokens;
}

function formatSkipped(skipped: GrepSkippedFiles): string {
	const parts: string[] = [];
	if (skipped.binary !== undefined) parts.push(`${skipped.binary} binary`);
	if (skipped.invalid_utf8 !== undefined) parts.push(`${skipped.invalid_utf8} invalid_utf8`);
	if (skipped.access_denied !== undefined) parts.push(`${skipped.access_denied} access_denied`);
	if (skipped.too_large !== undefined) parts.push(`${skipped.too_large} too_large`);
	return parts.join(", ");
}

function grepOpenTag(result: Pick<GrepSuccess, "strategy" | "truncated">): string {
	const attrs: string[] = [];
	if (result.strategy.includes("repo-map")) attrs.push('repo_map="true"');
	if (result.truncated) attrs.push(`truncated="true"`);
	return attrs.length === 0 ? "<grep>" : `<grep ${attrs.join(" ")}>`;
}
