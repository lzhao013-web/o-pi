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
  --latest                    select each tool's latest active slice (default)
  --all-slices                analyze every matching strict slice
  --environment ID            filter platform/arch/mode/pi/node environment
  --model PROVIDER/ID         filter model
  --thinking LEVEL            filter thinking level
  --project PATH              filter canonical project cwd
  --collector-contract ID     filter collector contract
  --toolset HASH              filter toolset hash
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
	latest: options.latest,
	...(options.environments.length === 0 ? {} : { environments: options.environments }),
	...(options.models.length === 0 ? {} : { models: options.models }),
	...(options.thinking.length === 0 ? {} : { thinking_levels: options.thinking }),
	...(options.projects.length === 0 ? {} : { projects: options.projects.map((value) => path.resolve(value)) }),
	...(options.contracts.length === 0 ? {} : { collector_contracts: options.contracts }),
	...(options.toolsets.length === 0 ? {} : { toolset_hashes: options.toolsets }),
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
		baseline: undefined, candidate: undefined, tools: [], slices: [], environments: [], models: [], thinking: [], projects: [], contracts: [], toolsets: [],
	};
	const valueFlags = new Map([
		["--input", "input"], ["--output", "output"], ["--from", "from"], ["--to", "to"], ["--baseline", "baseline"], ["--candidate", "candidate"],
	]);
	const repeatFlags = new Map([
		["--tool", "tools"], ["--slice", "slices"], ["--environment", "environments"], ["--model", "models"], ["--thinking", "thinking"],
		["--project", "projects"], ["--collector-contract", "contracts"], ["--toolset", "toolsets"],
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
