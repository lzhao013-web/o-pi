/** 精确复现“两轮多样性选择”，但只维护有界最差堆，避免全量排序。 */
export function selectDiverseTopK<T>(
	candidates: readonly T[],
	limit: number,
	compare: (left: T, right: T) => number,
	groupKey: (candidate: T) => string,
	identityKey: (candidate: T) => string,
): T[] {
	if (limit <= 0 || candidates.length === 0) return [];
	const bestByGroup = new Map<string, T>();
	for (const candidate of candidates) {
		const group = groupKey(candidate);
		const previous = bestByGroup.get(group);
		if (previous === undefined || compare(candidate, previous) < 0) bestByGroup.set(group, candidate);
	}
	const selected = boundedBest(bestByGroup.values(), limit, compare);
	if (selected.length < limit) {
		const selectedIds = new Set(selected.map(identityKey));
		const remaining = function* (): Generator<T> {
			for (const candidate of candidates) if (!selectedIds.has(identityKey(candidate))) yield candidate;
		};
		selected.push(...boundedBest(remaining(), limit - selected.length, compare));
	}
	return selected.sort(compare);
}

function boundedBest<T>(candidates: Iterable<T>, limit: number, compare: (left: T, right: T) => number): T[] {
	if (limit <= 0) return [];
	const heap: T[] = [];
	for (const candidate of candidates) {
		if (heap.length < limit) {
			heap.push(candidate);
			siftUpWorst(heap, heap.length - 1, compare);
		} else {
			const worst = heap[0];
			if (worst !== undefined && compare(candidate, worst) < 0) {
				heap[0] = candidate;
				siftDownWorst(heap, 0, compare);
			}
		}
	}
	return heap;
}

function siftUpWorst<T>(heap: T[], index: number, compare: (left: T, right: T) => number): void {
	while (index > 0) {
		const parent = Math.floor((index - 1) / 2);
		const item = heap[index];
		const parentItem = heap[parent];
		if (item === undefined || parentItem === undefined || compare(item, parentItem) <= 0) return;
		heap[index] = parentItem;
		heap[parent] = item;
		index = parent;
	}
}

function siftDownWorst<T>(heap: T[], index: number, compare: (left: T, right: T) => number): void {
	while (true) {
		const left = index * 2 + 1;
		const right = left + 1;
		let worst = index;
		const leftItem = heap[left];
		const worstItem = heap[worst];
		if (leftItem !== undefined && worstItem !== undefined && compare(leftItem, worstItem) > 0) worst = left;
		const rightItem = heap[right];
		const nextWorst = heap[worst];
		if (rightItem !== undefined && nextWorst !== undefined && compare(rightItem, nextWorst) > 0) worst = right;
		if (worst === index) return;
		const item = heap[index];
		const replacement = heap[worst];
		if (item === undefined || replacement === undefined) return;
		heap[index] = replacement;
		heap[worst] = item;
		index = worst;
	}
}
