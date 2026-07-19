import { describe, expect, it } from "vitest";

import { selectDiverseTopK } from "../../src/file-tools/ranking-selection.js";

interface Candidate {
	id: string;
	group: string;
	rank: number;
}

const compare = (left: Candidate, right: Candidate): number => left.rank - right.rank || left.id.localeCompare(right.id);

describe("ranking selection", () => {
	it("与完整排序后的两轮多样性选择逐项等价", () => {
		for (let size = 1; size <= 200; size += 7) {
			const candidates = Array.from({ length: size }, (_, index): Candidate => ({
				id: `candidate-${index}`,
				group: `group-${(index * 17 + size) % Math.max(1, Math.floor(size / 5))}`,
				rank: (index * 37 + size * 11) % 251,
			}));
			for (const limit of [1, 3, 8, 32, size + 1]) {
				const actual = selectDiverseTopK(candidates, limit, compare, (item) => item.group, (item) => item.id);
				const expected = referenceSelection(candidates, limit);
				expect(actual.map((item) => item.id)).toEqual(expected.map((item) => item.id));
			}
		}
	});

	it("空输入和非正限制返回空结果", () => {
		expect(selectDiverseTopK([], 4, compare, (item) => item.group, (item) => item.id)).toEqual([]);
		expect(selectDiverseTopK([{ id: "a", group: "g", rank: 1 }], 0, compare, (item) => item.group, (item) => item.id)).toEqual([]);
	});
});

function referenceSelection(candidates: Candidate[], limit: number): Candidate[] {
	const ranked = [...candidates].sort(compare);
	const selected: Candidate[] = [];
	const selectedIds = new Set<string>();
	const groups = new Set<string>();
	for (const candidate of ranked) {
		if (selected.length >= limit) break;
		if (groups.has(candidate.group)) continue;
		selected.push(candidate);
		selectedIds.add(candidate.id);
		groups.add(candidate.group);
	}
	for (const candidate of ranked) {
		if (selected.length >= limit) break;
		if (selectedIds.has(candidate.id)) continue;
		selected.push(candidate);
	}
	return selected.sort(compare);
}
