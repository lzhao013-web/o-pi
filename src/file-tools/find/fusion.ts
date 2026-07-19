import { compareRankingEvidence, mergeRankingEvidence } from "../ranking-evidence.js";
import { selectDiverseTopK } from "../ranking-selection.js";
import type { RankedFindEntry } from "./ranker.js";

/** 路径与 Repo Map 候选按 path 合并；只有发生碰撞时才复制输入候选。 */
export function mergeRankedFindSources(primary: RankedFindEntry[], repoMap: RankedFindEntry[]): RankedFindEntry[] {
	const fused = fuseRankedFindSources(primary, repoMap);
	if (fused === primary) return primary;
	return fused.sort(compareRankedFindEntries);
}

export function fuseRankedFindSources(primary: RankedFindEntry[], repoMap: RankedFindEntry[]): RankedFindEntry[] {
	if (repoMap.length === 0) return primary;
	const byPath = new Map<string, RankedFindEntry>();
	const owned = new Set<string>();
	for (const candidate of primary) mergeCandidate(byPath, owned, candidate);
	for (const candidate of repoMap) mergeCandidate(byPath, owned, candidate);
	return [...byPath.values()];
}

export function selectRankedFindEntries(candidates: readonly RankedFindEntry[], limit: number): RankedFindEntry[] {
	return selectDiverseTopK(candidates, limit, compareRankedFindEntries, (candidate) => topDirectory(candidate.entry.path), (candidate) => candidate.entry.path);
}

export function compareRankedFindEntries(left: RankedFindEntry, right: RankedFindEntry): number {
	return left.tier - right.tier
		|| compareRankingEvidence(left.evidence, right.evidence)
		|| left.entry.path.length - right.entry.path.length
		|| left.entry.depth - right.entry.depth
		|| compareStableString(left.entry.path, right.entry.path);
}

function mergeCandidate(byPath: Map<string, RankedFindEntry>, owned: Set<string>, candidate: RankedFindEntry): void {
	const key = candidate.entry.path;
	const existing = byPath.get(key);
	if (existing === undefined) {
		byPath.set(key, candidate);
		return;
	}
	const alreadyOwned = owned.has(key);
	const target = alreadyOwned ? existing : { ...existing };
	if (!alreadyOwned) {
		byPath.set(key, target);
		owned.add(key);
	}
	target.tier = Math.min(target.tier, candidate.tier);
	target.evidence = mergeRankingEvidence(target.evidence, candidate.evidence);
}

function compareStableString(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function topDirectory(value: string): string {
	const slash = value.indexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}
