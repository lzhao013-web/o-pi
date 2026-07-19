import { describe, expect, it } from "vitest";

import { compareRankingEvidence, createRankingEvidence, mergeRankingEvidence, rankPercentile, type RankingEvidence } from "../../src/file-tools/ranking-evidence.js";

function evidence(family: "lexical" | "semantic" | "structural" = "lexical", percentile = 1): RankingEvidence {
	return createRankingEvidence(family, percentile);
}

describe("ranking evidence", () => {
	it("把来源内顺序归一化到稳定端点", () => {
		expect(rankPercentile(0, 1)).toBe(1);
		expect(rankPercentile(0, 3)).toBe(1);
		expect(rankPercentile(1, 3)).toBe(0.5);
		expect(rankPercentile(2, 3)).toBe(0);
	});

	it("独立证据家族共识优先于单一来源的高百分位", () => {
		const consensus = mergeRankingEvidence(evidence("lexical", 0.4), evidence("semantic", 0.4));
		const singleSource = evidence("lexical", 1);
		expect(compareRankingEvidence(consensus, singleSource)).toBeLessThan(0);
	});

	it("同一家族增加较弱来源不会降低已有证据", () => {
		const original = evidence("lexical", 0.8);
		const withWeakCorrelatedSource = mergeRankingEvidence(original, evidence("lexical", 0.1));
		expect(compareRankingEvidence(withWeakCorrelatedSource, original)).toBe(0);
	});
});
