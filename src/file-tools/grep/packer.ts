import { countTextTokensSync } from "../../token-counter.js";
import { byteRangeForLines, extractByteRange } from "../../code-index/parser.js";
import type { RankedGrepRegion } from "./ranker.js";
import { selectRankedGrepCandidates } from "./fusion.js";
import type { GrepMatchMode, GrepRegion, GrepSkippedFiles, GrepSuccess, RepoMapRelatedResult } from "../types.js";

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
	related?: RepoMapRelatedResult[];
}

interface PackState {
	budgetTokens: number;
	bodyCount: number;
	usedTokens: number;
	regions: GrepRegion[];
	usedFiles: Set<string>;
	repoMapUsed: boolean;
	related: RepoMapRelatedResult[];
}

/** 在预算内选择正文、片段和签名；不会对已选 UTF-8 文本做任意字节截断。 */
export function packGrepResults(input: GrepPackInput): GrepSuccess {
	const selected = selectGrepCandidatesForPacking(input.regions, input.resultLimit);
	const state: PackState = {
		budgetTokens: input.tokenBudget,
		bodyCount: 0,
		usedTokens: tokenCount(headerText(effectiveInput(input, false), false)),
		regions: [],
		usedFiles: new Set(),
		repoMapUsed: false,
		related: [],
	};

	for (const candidate of selected) {
		const region = packRegion(candidate, input.sourceText.get(candidate.path), state);
		const projected = projectedTokens(input, state, region, candidate);
		if (state.regions.length > 0 && projected > state.budgetTokens) {
			const signature = signatureRegion(candidate);
			const signatureCost = projectedTokens(input, state, signature, candidate);
			if (signatureCost > state.budgetTokens) break;
			addRegion(input, state, signature, candidate);
			continue;
		}
		addRegion(input, state, region, candidate);
	}
	const mainTruncated = !input.scanComplete || state.regions.length < input.regions.length;
	for (const candidate of input.related ?? []) {
		const next = [...state.related, candidate];
		const projected = tokenCount(renderPackedBody(
			effectiveInput(input, state.repoMapUsed),
			state.regions,
			state.usedFiles.size,
			mainTruncated,
			next,
		));
		if (projected > state.budgetTokens) break;
		state.related.push(candidate);
	}

	const returnedFiles = state.usedFiles.size;
	const truncated = mainTruncated;
	const outputInput = effectiveInput(input, state.repoMapUsed);
	const strategy = outputInput.strategy;
	const approxTokens = tokenCount(renderPackedBody(outputInput, state.regions, returnedFiles, truncated, state.related));
	const success: GrepSuccess = {
		status: "success",
		query: input.query,
		path: input.path,
		match: input.match,
		strategy,
		total_candidates: input.totalCandidates,
		returned_regions: state.regions.length,
		returned_files: returnedFiles,
		approx_tokens: approxTokens,
		truncated,
		regions: state.regions,
		...(state.related.length > 0 ? { related: state.related } : {}),
	};
	if (input.skipped !== undefined && Object.keys(input.skipped).length > 0) success.skipped_files = input.skipped;
	if (input.nearSymbols.length > 0) success.near_symbols = input.nearSymbols;
	return success;
}

export function renderGrepSuccess(result: GrepSuccess): string {
	const lines = [grepOpenTag(result)];
	if (result.regions.length === 0) {
		lines.push(result.near_symbols !== undefined && result.near_symbols.length > 0 ? `near symbols: ${result.near_symbols.join(", ")}` : "no matching regions");
	} else {
		for (const region of result.regions) lines.push("", renderRegion(region, result.match));
	}
	const omitted = result.total_candidates - result.returned_regions;
	if (omitted > 0) lines.push("", `... ${omitted} lower-ranked regions omitted`);
	if (result.skipped_files !== undefined) lines.push("", `skipped: ${formatSkipped(result.skipped_files)}`);
	if (result.related !== undefined && result.related.length > 0) lines.push("", renderRelated(result.related));
	lines.push("</grep>");
	return lines.join("\n");
}

function renderPackedBody(
	input: GrepPackInput,
	regions: GrepRegion[],
	returnedFiles: number,
	truncated: boolean,
	related: RepoMapRelatedResult[] = [],
): string {
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
		...(related.length > 0 ? { related } : {}),
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

function renderRegion(region: GrepRegion, match: GrepMatchMode): string {
	const headerSymbol = region.symbol ?? region.signature;
	const header = `${region.path}:${region.start_line}${region.end_line === region.start_line ? "" : `-${region.end_line}`}`;
	const reasons = visibleReasons(region.reasons, match);
	const subject = headerSymbol ?? region.kind;
	const label = reasons.length === 0 ? subject : `${subject} [${reasons.join(" · ")}]`;
	const lines = [`${header}`, label];
	if (region.callees !== undefined) lines.push(`calls: ${region.callees.join(", ")}`);
	if (region.imports !== undefined) lines.push(`imports: ${region.imports.join(", ")}`);
	if (region.content !== undefined) lines.push("", region.content);
	return lines.join("\n");
}

function visibleReasons(reasons: string[], match: GrepMatchMode): string[] {
	return reasons.filter((reason) =>
		reason !== "hop 1"
		&& !(match === "literal" && reason === "exact literal")
		&& !(match === "regex" && reason === "regex"));
}

function renderRelated(related: RepoMapRelatedResult[]): string {
	const lines = ['<related source="repo-map" query_match="not_guaranteed">'];
	for (const result of related) {
		const range = result.start_line === undefined
			? result.path
			: `${result.path}:${result.start_line}${result.end_line === undefined || result.end_line === result.start_line ? "" : `-${result.end_line}`}`;
		lines.push(`${range} ${result.symbol ?? result.signature ?? result.kind} [${result.relations.join(" · ")}]`);
	}
	lines.push("</related>");
	return lines.join("\n");
}

function addRegion(input: GrepPackInput, state: PackState, region: GrepRegion, candidate: RankedGrepRegion): void {
	state.regions.push(region);
	state.usedFiles.add(region.path);
	if (candidate.repoMap === true) state.repoMapUsed = true;
	state.usedTokens = tokenCount(renderPackedBody(effectiveInput(input, state.repoMapUsed), state.regions, state.usedFiles.size, false));
}

export function selectGrepCandidatesForPacking(regions: RankedGrepRegion[], limit: number): RankedGrepRegion[] {
	return selectRankedGrepCandidates(regions, limit);
}

function headerText(input: GrepPackInput, truncated: boolean): string {
	return grepOpenTag({
		strategy: input.strategy,
		truncated,
	});
}

function projectedTokens(input: GrepPackInput, state: PackState, region: GrepRegion, candidate: RankedGrepRegion): number {
	const files = new Set(state.usedFiles);
	files.add(region.path);
	return tokenCount(renderPackedBody(effectiveInput(input, state.repoMapUsed || candidate.repoMap === true), [...state.regions, region], files.size, false));
}

function effectiveInput(input: GrepPackInput, repoMapUsed: boolean): GrepPackInput {
	if (repoMapUsed || !input.strategy.includes("repo-map")) return input;
	return { ...input, strategy: input.strategy.filter((item) => item !== "repo-map") };
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
