export type RankingEvidenceFamily = "lexical" | "semantic" | "structural";

/** 排序热路径使用的固定宽度证据摘要；字段只由本模块构造。 */
export interface RankingEvidence {
	readonly mask: number;
	readonly lexical: number;
	readonly semantic: number;
	readonly structural: number;
	readonly familyCount: number;
	readonly medianPercentile: number;
	readonly bestPercentile: number;
}

const LEXICAL_BIT = 1;
const SEMANTIC_BIT = 2;
const STRUCTURAL_BIT = 4;

export const EMPTY_RANKING_EVIDENCE: RankingEvidence = evidenceSummary(0, 0, 0, 0);

/** 来源内排名归一化；第一名为 1，单候选来源也视为 1。 */
export function rankPercentile(index: number, total: number): number {
	if (total <= 1) return 1;
	return 1 - index / (total - 1);
}

export function createRankingEvidence(family: RankingEvidenceFamily, percentile: number): RankingEvidence {
	if (family === "lexical") return evidenceSummary(LEXICAL_BIT, percentile, 0, 0);
	if (family === "semantic") return evidenceSummary(SEMANTIC_BIT, 0, percentile, 0);
	return evidenceSummary(STRUCTURAL_BIT, 0, 0, percentile);
}

export function rescaleRankingEvidence(evidence: RankingEvidence, percentile: number): RankingEvidence {
	return evidenceSummary(
		evidence.mask,
		(evidence.mask & LEXICAL_BIT) === 0 ? 0 : percentile,
		(evidence.mask & SEMANTIC_BIT) === 0 ? 0 : percentile,
		(evidence.mask & STRUCTURAL_BIT) === 0 ? 0 : percentile,
	);
}

export function mergeRankingEvidence(left: RankingEvidence, right: RankingEvidence): RankingEvidence {
	if (left.mask === 0) return right;
	if (right.mask === 0) return left;
	const mask = left.mask | right.mask;
	const lexical = Math.max(left.lexical, right.lexical);
	const semantic = Math.max(left.semantic, right.semantic);
	const structural = Math.max(left.structural, right.structural);
	if (mask === left.mask && lexical === left.lexical && semantic === left.semantic && structural === left.structural) return left;
	if (mask === right.mask && lexical === right.lexical && semantic === right.semantic && structural === right.structural) return right;
	return evidenceSummary(mask, lexical, semantic, structural);
}

/** 证据共识的稳定比较：独立家族数、各家族最佳百分位的中位数与最佳值。 */
export function compareRankingEvidence(left: RankingEvidence, right: RankingEvidence): number {
	return right.familyCount - left.familyCount
		|| right.medianPercentile - left.medianPercentile
		|| right.bestPercentile - left.bestPercentile;
}

function evidenceSummary(mask: number, lexical: number, semantic: number, structural: number): RankingEvidence {
	const familyCount = Number((mask & LEXICAL_BIT) !== 0)
		+ Number((mask & SEMANTIC_BIT) !== 0)
		+ Number((mask & STRUCTURAL_BIT) !== 0);
	const sum = lexical + semantic + structural;
	const bestPercentile = Math.max(lexical, semantic, structural);
	const medianPercentile = familyCount === 0
		? 0
		: familyCount === 1
			? sum
			: familyCount === 2
				? sum / 2
				: sum - Math.min(lexical, semantic, structural) - bestPercentile;
	return { mask, lexical, semantic, structural, familyCount, medianPercentile, bestPercentile };
}
