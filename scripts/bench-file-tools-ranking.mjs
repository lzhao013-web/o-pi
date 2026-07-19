import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const root = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url);
const { compareRankedGrepRegions, fuseRankedGrepSources, mergeRankedGrepSources, selectRankedGrepCandidates } = await jiti.import(fileURLToPath(new URL("../src/file-tools/grep/fusion.ts", import.meta.url)));
const { compareRankedFindEntries, fuseRankedFindSources, mergeRankedFindSources, selectRankedFindEntries } = await jiti.import(fileURLToPath(new URL("../src/file-tools/find/fusion.ts", import.meta.url)));
const { createFindEntry } = await jiti.import(fileURLToPath(new URL("../src/file-tools/find/ranker.ts", import.meta.url)));
const { createRankingEvidence } = await jiti.import(fileURLToPath(new URL("../src/file-tools/ranking-evidence.ts", import.meta.url)));
const runs = readRuns(process.argv.slice(2));
const sizes = [1_000, 5_000, 20_000];
const rows = [];

for (const size of sizes) {
	const sources = buildSources(size);
	const merged = mergeRankedGrepSources(...sources);
	const unsorted = permute(merged);
	const limit = 32;
	const expected = selectSortedDiverse([...unsorted].sort(compareRankedGrepRegions), limit, (item) => item.path, (item) => item.id, compareRankedGrepRegions);
	const selected = selectRankedGrepCandidates(unsorted, limit);
	if (selected.length !== limit || merged.length < size) throw new Error("ranking benchmark fixture is invalid");
	if (selected.some((item, index) => item !== expected[index])) {
		throw new Error("bounded selector changed the diverse top-K result");
	}
	rows.push(row(`fusion + full sort N=${size}`, sample(runs, () => mergeRankedGrepSources(...sources))));
	rows.push(row(`fusion + exact top-32 N=${size}`, sample(runs, () => selectRankedGrepCandidates(fuseGrepSources(sources), limit))));
	rows.push(row(`full sort only N=${merged.length}`, sample(runs, () => [...unsorted].sort(compareRankedGrepRegions))));
	rows.push(row(`exact diverse top-32 N=${merged.length}`, sample(runs, () => selectRankedGrepCandidates(unsorted, limit))));

	const findSources = buildFindSources(size);
	const mergedFind = mergeRankedFindSources(...findSources);
	const unsortedFind = permute(mergedFind);
	const findLimit = 50;
	const expectedFind = selectSortedDiverse(
		[...unsortedFind].sort(compareRankedFindEntries),
		findLimit,
		(item) => topDirectory(item.entry.path),
		(item) => item.entry.path,
		compareRankedFindEntries,
	);
	const selectedFind = selectRankedFindEntries(unsortedFind, findLimit);
	if (selectedFind.some((item, index) => item !== expectedFind[index])) throw new Error("bounded find selector changed the diverse top-K result");
	rows.push(row(`find fusion + full sort N=${size}`, sample(runs, () => mergeRankedFindSources(...findSources))));
	rows.push(row(`find fusion + exact top-50 N=${size}`, sample(runs, () => selectRankedFindEntries(fuseFindSources(findSources), findLimit))));
	rows.push(row(`find full sort only N=${mergedFind.length}`, sample(runs, () => [...unsortedFind].sort(compareRankedFindEntries))));
	rows.push(row(`find exact diverse top-50 N=${mergedFind.length}`, sample(runs, () => selectRankedFindEntries(unsortedFind, findLimit))));
}

console.log(`file-tools multi-channel ranking benchmark (${runs} measured runs, 3 warmups; synthetic channels, 50% identity overlap)`);
console.table(rows);

function buildSources(size) {
	const primary = Array.from({ length: size }, (_, index) => region("native", index, index, "lexical", size));
	const channelSize = Math.max(1, Math.floor(size / 3));
	const lsp = Array.from({ length: channelSize }, (_, index) => {
		const identity = index % 2 === 0 ? index * 2 : size + index;
		return region("lsp", index, identity, "semantic", channelSize);
	});
	const repoMap = Array.from({ length: channelSize }, (_, index) => {
		const identity = index % 2 === 0 ? index * 2 : size + channelSize + index;
		return region("repo", index, identity, "structural", channelSize);
	});
	return [primary, lsp, repoMap];
}

function fuseGrepSources(sources) {
	const [primary, lsp, repoMap] = sources;
	return fuseRankedGrepSources(primary, lsp, repoMap);
}

function fuseFindSources(sources) {
	const [primary, repoMap] = sources;
	return fuseRankedFindSources(primary, repoMap);
}

function buildFindSources(size) {
	const primary = Array.from({ length: size }, (_, index) => findCandidate(index, index, "lexical", size));
	const channelSize = Math.max(1, Math.floor(size / 3));
	const repoMap = Array.from({ length: channelSize }, (_, index) => {
		const identity = index % 2 === 0 ? index * 2 : size + index;
		return findCandidate(index, identity, "structural", channelSize);
	});
	return [primary, repoMap];
}

function findCandidate(sourceIndex, identity, family, sourceSize) {
	return {
		entry: createFindEntry(`group-${identity % 64}/feature-${identity}.ts`, "file"),
		tier: identity % 8,
		evidence: createRankingEvidence(family, sourceSize <= 1 ? 1 : 1 - sourceIndex / (sourceSize - 1)),
	};
}

function region(source, sourceIndex, identity, family, sourceSize) {
	const pathIndex = identity % Math.max(64, Math.floor(sourceSize / 4));
	const startLine = identity * 3 + 1;
	return {
		id: `${source}:${identity}`,
		path: `src/group-${pathIndex % 32}/file-${pathIndex}.ts`,
		kind: "function",
		symbol: `symbol${identity}`,
		startLine,
		endLine: startLine + identity % 12,
		startByte: startLine * 10,
		endByte: startLine * 10 + 80,
		tier: identity % 8,
		evidence: createRankingEvidence(family, sourceSize <= 1 ? 1 : 1 - sourceIndex / (sourceSize - 1)),
		reasons: [source],
		matchLines: [startLine],
		callees: [],
		imports: [],
		lexicalRelevance: 0,
		pathRelevance: 0,
	};
}

function permute(values) {
	const result = [];
	for (let index = 0; index < values.length; index += 1) result.push(values[(index * 9_973) % values.length]);
	return result;
}

function selectSortedDiverse(candidates, limit, groupKey, identityKey, compare) {
	const selected = [];
	const selectedIds = new Set();
	const usedPaths = new Set();
	for (const candidate of candidates) {
		if (selected.length >= limit) break;
		const group = groupKey(candidate);
		if (usedPaths.has(group)) continue;
		selected.push(candidate);
		selectedIds.add(identityKey(candidate));
		usedPaths.add(group);
	}
	for (const candidate of candidates) {
		if (selected.length >= limit) break;
		if (selectedIds.has(identityKey(candidate))) continue;
		selected.push(candidate);
	}
	return selected.sort(compare);
}

function topDirectory(value) {
	const slash = value.indexOf("/");
	return slash === -1 ? "." : value.slice(0, slash);
}

function sample(measuredRuns, operation) {
	const samples = [];
	for (let index = 0; index < measuredRuns + 3; index += 1) {
		const started = performance.now();
		operation();
		if (index >= 3) samples.push(performance.now() - started);
	}
	return samples;
}

function row(metric, samples) {
	const sorted = [...samples].sort((left, right) => left - right);
	return {
		metric,
		"p50 ms": round(percentile(sorted, 0.5)),
		"p95 ms": round(percentile(sorted, 0.95)),
		"min ms": round(sorted[0]),
	};
}

function percentile(sorted, quantile) {
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function round(value) {
	return Math.round(value * 100) / 100;
}

function readRuns(args) {
	const flag = args.find((arg) => arg.startsWith("--runs="));
	const value = Number(flag?.slice("--runs=".length) ?? 15);
	if (!Number.isInteger(value) || value < 3) throw new Error("--runs must be an integer >= 3");
	return value;
}
