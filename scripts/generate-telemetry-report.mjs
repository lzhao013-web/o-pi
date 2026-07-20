import path from "node:path";
import { loadTypeScript } from "./benchmark/loader.mjs";

const options = parseOptions(process.argv.slice(2));
if (options.help) {
	process.stdout.write("Usage: npm run telemetry:report -- [--input DIR] [--output DIR]\n");
	process.exit(0);
}

const { generateTelemetryReport } = await loadTypeScript("src/telemetry-report/output.ts");
const result = await generateTelemetryReport({
	...(options.input === undefined ? {} : { inputDirectory: path.resolve(options.input) }),
	...(options.output === undefined ? {} : { outputDirectory: path.resolve(options.output) }),
});
process.stdout.write(`${JSON.stringify({
	output_directory: result.output_directory,
	summary: result.report.summary,
	data_quality: {
		as_of: result.report.metadata.as_of,
		complete_sessions: result.report.metadata.complete_sessions,
		open_sessions: result.report.metadata.open_sessions,
		invalid_lines: result.report.metadata.invalid_lines,
		partial_records: result.report.metadata.partial_records,
	},
}, null, 2)}\n`);

function parseOptions(args) {
	const options = { help: false, input: undefined, output: undefined };
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument === "--input") options.input = requiredValue(args, ++index, "--input");
		else if (argument.startsWith("--input=")) options.input = argument.slice("--input=".length);
		else if (argument === "--output") options.output = requiredValue(args, ++index, "--output");
		else if (argument.startsWith("--output=")) options.output = argument.slice("--output=".length);
		else throw new Error(`unknown argument: ${argument}`);
	}
	return options;
}

function requiredValue(args, index, flag) {
	const value = args[index];
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}
