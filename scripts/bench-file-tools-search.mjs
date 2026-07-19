import { fileURLToPath } from "node:url";
import { readRuns } from "./benchmark/cli.mjs";
import { measureJsonWorker } from "./benchmark/runtime.mjs";
import { row } from "./benchmark/stats.mjs";

const worker = fileURLToPath(new URL("./workers/bench-file-tools-worker.mjs", import.meta.url));
const runs = readRuns(process.argv.slice(2));
const warmups = Math.min(1, runs);
const samples = measureJsonWorker(worker, ["search"], { warmups, runs });

console.log(`file-tools search benchmark (${runs} measured runs, ${warmups} warmup; process-cold/filesystem-warm)`);
console.table(Object.keys(samples[0]).map((metric) => row(metric, samples.map((sample) => sample[metric]))));
