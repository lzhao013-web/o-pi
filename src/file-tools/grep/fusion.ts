import { compareRankingEvidence, mergeRankingEvidence } from "../ranking-evidence.js";
import { selectDiverseTopK } from "../ranking-selection.js";
import type { RankedGrepRegion } from "./ranker.js";

/** 需要完整顺序时执行一次融合排序；工具主链使用 fuse + 有界选择。 */
export function mergeRankedGrepSources(primary: RankedGrepRegion[], ...additionalSources: RankedGrepRegion[][]): RankedGrepRegion[] {
	const fused = fuseRankedGrepSources(primary, ...additionalSources);
	if (fused === primary) return primary;
	return fused.sort(compareRankedGrepRegions);
}

export function fuseRankedGrepSources(primary: RankedGrepRegion[], ...additionalSources: RankedGrepRegion[][]): RankedGrepRegion[] {
	if (additionalSources.every((source) => source.length === 0)) return primary;
	const byId = new Map<string, RankedGrepRegion>();
	const owned = new Set<string>();
	for (const region of primary) mergeRegion(byId, owned, region);
	for (const source of additionalSources) {
		for (const region of source) mergeRegion(byId, owned, region);
	}
	return [...byId.values()];
}

export function selectRankedGrepCandidates(candidates: readonly RankedGrepRegion[], limit: number): RankedGrepRegion[] {
	return selectDiverseTopK(candidates, limit, compareRankedGrepRegions, (candidate) => candidate.path, (candidate) => candidate.id);
}

export function compareRankedGrepRegions(left: RankedGrepRegion, right: RankedGrepRegion): number {
	return left.tier - right.tier
		|| compareRankingEvidence(left.evidence, right.evidence)
		|| (left.endLine - left.startLine) - (right.endLine - right.startLine)
		|| compareStableString(left.path, right.path)
		|| left.startLine - right.startLine
		|| left.endLine - right.endLine;
}

function mergeRegion(byId: Map<string, RankedGrepRegion>, owned: Set<string>, region: RankedGrepRegion): void {
	const key = regionIdentity(region);
	const existing = byId.get(key);
	if (existing === undefined) {
		byId.set(key, region);
		return;
	}
	const alreadyOwned = owned.has(key);
	const target = alreadyOwned ? existing : cloneRegion(existing);
	if (!alreadyOwned) {
		byId.set(key, target);
		owned.add(key);
	}
	target.tier = Math.min(target.tier, region.tier);
	target.evidence = mergeRankingEvidence(target.evidence, region.evidence);
	target.lexicalRelevance = Math.max(target.lexicalRelevance, region.lexicalRelevance);
	target.pathRelevance = Math.max(target.pathRelevance, region.pathRelevance);
	if (region.repoMap === true) target.repoMap = true;
	mergeUnique(target.reasons, region.reasons);
	mergeUnique(target.matchLines, region.matchLines);
	mergeUnique(target.callees, region.callees);
	mergeUnique(target.imports, region.imports);
}

function cloneRegion(region: RankedGrepRegion): RankedGrepRegion {
	return {
		...region,
		reasons: [...region.reasons],
		matchLines: [...region.matchLines],
		callees: [...region.callees],
		imports: [...region.imports],
	};
}

function mergeUnique<T>(target: T[], source: readonly T[]): void {
	for (const item of source) if (!target.includes(item)) target.push(item);
}

function regionIdentity(region: RankedGrepRegion): string {
	const symbol = region.symbol?.toLowerCase();
	return symbol === undefined ? region.id : `${region.path}\0${region.startLine}\0${symbol}`;
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
