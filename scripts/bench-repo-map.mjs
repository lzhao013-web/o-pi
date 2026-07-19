import { fileURLToPath } from "node:url";
import { readRuns, readSizes } from "./benchmark/cli.mjs";
import { measureJsonWorker, measureProcess } from "./benchmark/runtime.mjs";
import { row } from "./benchmark/stats.mjs";

const extensionWorker = fileURLToPath(new URL("./workers/bench-repo-map-extension-worker.mjs", import.meta.url));
const runtimeWorker = fileURLToPath(new URL("./workers/bench-repo-map-worker.mjs", import.meta.url));
const args = process.argv.slice(2);
const runs = readRuns(args, { defaultRuns: 3, minimum: 1 });
const sizes = readSizes(args);
const warmups = Math.min(1, runs);
const pi = process.env.PI_BIN ?? "pi";
const piArgs = [
	"--offline", "--no-extensions", "--no-skills", "--no-prompt-templates",
	"--no-themes", "--no-context-files", "--list-models", "__repo_map_benchmark_no_match__",
];

const bare = measureProcess(pi, piArgs, { warmups, runs });
const extension = measureProcess(pi, [
	...piArgs.slice(0, -2), "--extension", "agent/extensions/repo-map.ts", ...piArgs.slice(-2),
], { warmups, runs });
const extensionSamples = measureJsonWorker(extensionWorker, [], { warmups, runs });

console.log(`repo-map benchmark (${runs} measured runs, ${warmups} warmup; process-cold/filesystem-warm)`);
console.table([
	row("Pi bare load ms", bare),
	row("Pi + repo-map ms", extension),
	row("repo-map startup delta ms", extension.map((value, index) => value - bare[index])),
	...rowsForSamples(extensionSamples),
]);

for (const size of sizes) {
	const samples = measureJsonWorker(runtimeWorker, [`--size=${size}`], { warmups, runs });
	assertStableOracle(samples, size);
	console.log(`Repo Map fixture: ${size} TypeScript modules (+ package.json)`);
	console.table(rowsForSamples(samples));
	const representative = samples[0];
	console.log({ generation: representative.generation, oracleDigest: representative.oracleDigest, counts: representative.counts });
}

function rowsForSamples(samples) {
	const ignored = new Set(["size", "generation", "oracleDigest", "counts"]);
	return Object.keys(samples[0])
		.filter((key) => !ignored.has(key) && samples.every((sample) => typeof sample[key] === "number"))
		.map((metric) => row(metric, samples.map((sample) => sample[metric])));
}

function assertStableOracle(samples, size) {
	const generations = new Set(samples.map((sample) => sample.generation));
	const digests = new Set(samples.map((sample) => sample.oracleDigest));
	if (generations.size !== 1 || digests.size !== 1) {
		throw new Error(`Repo Map fixture ${size} produced non-deterministic generation or query output`);
	}
}
