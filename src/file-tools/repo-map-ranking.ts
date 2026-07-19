import type { RepoMapMatchReason, RepoMapQueryCandidate } from "../repo-map/query.js";

const NAVIGATION_REASONS = new Set<RepoMapMatchReason>([
	"definition",
	"alias",
	"exact qualified symbol",
	"exact symbol",
	"short symbol",
	"caller",
	"test",
	"entrypoint",
	"public api",
	"registration",
	"export",
	"callee",
	"reference",
	"import",
	"test config",
	"mock",
	"fixture",
	"component",
	"package",
	"snapshot",
]);

/** 关联通道只接收达到 Repo Map 公共可信边界、且具有可导航关系的候选。 */
export function isRepoMapNavigationCandidate(candidate: RepoMapQueryCandidate): boolean {
	return candidate.confidence >= 0.5 && candidate.reasons.some((reason) => NAVIGATION_REASONS.has(reason));
}

/** 只有查询种子的结构/语义关系是独立证据；多跳传播不与名称命中组成共识。 */
export function hasDirectRepoMapEvidence(candidate: RepoMapQueryCandidate): boolean {
	return candidate.hop === 0 && candidate.reasons.some((reason) => NAVIGATION_REASONS.has(reason));
}

export function repoMapNavigationRelation(candidate: RepoMapQueryCandidate): string | undefined {
	for (const reason of candidate.reasons) {
		if (!NAVIGATION_REASONS.has(reason)) continue;
		if (reason === "alias") {
			const alias = candidate.matchedAliases.find((match) => match.term.toLocaleLowerCase() !== match.canonical.toLocaleLowerCase());
			return alias === undefined ? "alias" : `alias ${alias.term}→${alias.canonical}`;
		}
		if (reason === "exact qualified symbol" || reason === "exact symbol" || reason === "short symbol") return "symbol";
		return reason;
	}
	return undefined;
}

/** Repo Map 主候选的语义等级；图距离只分层，不转换成固定 boost。 */
export function repoMapEvidenceTier(candidate: RepoMapQueryCandidate): number {
	if (candidate.reasons.includes("exact path")) return 0;
	if (candidate.reasons.includes("exact filename")) return 1;
	if (candidate.hop === 0 && (candidate.reasons.includes("exact qualified symbol") || candidate.reasons.includes("exact symbol"))) return 2;
	if (candidate.reasons.includes("path match")) return 3;
	if (candidate.hop === 0) return 4;
	return candidate.hop === 1 ? 6 : 7;
}
