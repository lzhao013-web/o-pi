import path from "node:path";
import { loadTypeScript } from "./benchmark/loader.mjs";

const options = parseOptions(process.argv.slice(2));
if (options.help) {
	process.stdout.write(`Usage: npm run telemetry:report -- [options]

Input/output:
  --input DIR                 telemetry JSONL directory
  --output DIR                report output directory

Unified analysis query:
  --list-slices               print the slice inventory
  --tool NAME                 select tool (repeatable)
  --slice ID                  select strict slice (repeatable)
  --config HASH               filter effective config hash
  --latest                    select each tool's latest active slice (default)
  --all-slices                analyze every matching strict slice
  --environment ID            filter platform/arch/mode/pi/node environment
  --model PROVIDER/ID         filter model
  --thinking LEVEL            filter thinking level
  --project PATH              filter canonical project cwd
  --collector-contract ID     filter collector contract
  --toolset HASH              filter toolset hash
  --workload HASH             filter raw-prompt content hash
  --workload-shape SHAPE      filter workload size/image bucket
  --repo-map-enabled BOOL     filter repo-map activation (true/false)
  --repo-map-freshness VALUE  filter repo-map freshness
  --repo-map-id ID            filter repo-map identity
  --from ISO                  inclusive event time lower bound
  --to ISO                    inclusive event time upper bound
  --baseline SLICE_ID         comparison baseline
  --candidate SLICE_ID        comparison candidate
`);
	process.exit(0);
}

const { generateTelemetryReport } = await loadTypeScript("src/telemetry-report/output.ts");
const query = {
	...(options.tools.length === 0 ? {} : { tools: options.tools }),
	...(options.slices.length === 0 ? {} : { slice_ids: options.slices }),
	...(options.configs.length === 0 ? {} : { config_hashes: options.configs }),
	latest: options.latest,
	...(options.environments.length === 0 ? {} : { environments: options.environments }),
	...(options.models.length === 0 ? {} : { models: options.models }),
	...(options.thinking.length === 0 ? {} : { thinking_levels: options.thinking }),
	...(options.projects.length === 0 ? {} : { projects: options.projects.map((value) => path.resolve(value)) }),
	...(options.contracts.length === 0 ? {} : { collector_contracts: options.contracts }),
	...(options.toolsets.length === 0 ? {} : { toolset_hashes: options.toolsets }),
	...(options.workloads.length === 0 ? {} : { workload_hashes: options.workloads }),
	...(options.workloadShapes.length === 0 ? {} : { workload_shapes: options.workloadShapes }),
	...(options.repoMapEnabled.length === 0 ? {} : { repo_map_enabled: options.repoMapEnabled }),
	...(options.repoMapFreshness.length === 0 ? {} : { repo_map_freshnesses: options.repoMapFreshness }),
	...(options.repoMapIds.length === 0 ? {} : { repo_map_identities: options.repoMapIds }),
	...(options.from === undefined ? {} : { from: iso(options.from, "--from") }),
	...(options.to === undefined ? {} : { to: iso(options.to, "--to") }),
	...(options.baseline === undefined ? {} : { baseline_slice_id: options.baseline }),
	...(options.candidate === undefined ? {} : { candidate_slice_id: options.candidate }),
};
const result = await generateTelemetryReport({
	...(options.input === undefined ? {} : { inputDirectory: path.resolve(options.input) }),
	...(options.output === undefined ? {} : { outputDirectory: path.resolve(options.output) }),
	query,
});

if (options.listSlices) {
	process.stdout.write(`${JSON.stringify(result.report.inventory.slices, null, 2)}\n`);
} else {
	process.stdout.write(`${JSON.stringify({
		output_directory: result.output_directory,
		analysis_hash: result.report.metadata.analysis_hash,
		as_of: result.report.metadata.as_of,
		inventory: result.report.inventory.summary,
		selected_slice_ids: result.report.query.selected_slice_ids,
		collection_health: result.report.collection_health,
		...(result.report.comparison === undefined ? {} : { comparison: result.report.comparison.comparability }),
	}, null, 2)}\n`);
}

function parseOptions(args) {
	const options = {
		help: false, listSlices: false, latest: true, input: undefined, output: undefined, from: undefined, to: undefined,
		baseline: undefined, candidate: undefined, tools: [], slices: [], configs: [], environments: [], models: [], thinking: [], projects: [], contracts: [], toolsets: [], workloads: [], workloadShapes: [], repoMapEnabled: [], repoMapFreshness: [], repoMapIds: [],
	};
	const valueFlags = new Map([
		["--input", "input"], ["--output", "output"], ["--from", "from"], ["--to", "to"], ["--baseline", "baseline"], ["--candidate", "candidate"],
	]);
	const repeatFlags = new Map([
			["--tool", "tools"], ["--slice", "slices"], ["--config", "configs"], ["--environment", "environments"], ["--model", "models"], ["--thinking", "thinking"],
		["--project", "projects"], ["--collector-contract", "contracts"], ["--toolset", "toolsets"],
		["--workload", "workloads"], ["--workload-shape", "workloadShapes"],
		["--repo-map-enabled", "repoMapEnabled"], ["--repo-map-freshness", "repoMapFreshness"], ["--repo-map-id", "repoMapIds"],
	]);
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument === "--list-slices") options.listSlices = true;
		else if (argument === "--latest") options.latest = true;
		else if (argument === "--all-slices") options.latest = false;
		else {
			const equal = argument.indexOf("=");
			const flag = equal < 0 ? argument : argument.slice(0, equal);
			const inline = equal < 0 ? undefined : argument.slice(equal + 1);
			const directKey = valueFlags.get(flag);
			const repeatKey = repeatFlags.get(flag);
			if (directKey !== undefined) options[directKey] = inline ?? requiredValue(args, ++index, flag);
			else if (repeatKey !== undefined) options[repeatKey].push(inline ?? requiredValue(args, ++index, flag));
			else throw new Error(`unknown argument: ${argument}`);
		}
	}
	if ((options.baseline === undefined) !== (options.candidate === undefined)) throw new Error("--baseline and --candidate must be used together");
	if (options.baseline !== undefined) {
		options.latest = false;
		for (const id of [options.baseline, options.candidate]) if (id !== undefined && !options.slices.includes(id)) options.slices.push(id);
	}
	return options;
}

function requiredValue(args, index, flag) {
	const value = args[index];
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function iso(value, flag) {
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`${flag} requires an ISO timestamp`);
	return parsed.toISOString();
}
