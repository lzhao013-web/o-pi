import os from "node:os";
import path from "node:path";

import type { TelemetryReport, TelemetryReportQuery } from "./types.js";

export interface GenerateTelemetryReportOptions {
	inputDirectory?: string;
	outputDirectory?: string;
	generatedAt?: string;
	query?: TelemetryReportQuery;
}

export interface GenerateTelemetryReportResult {
	report: TelemetryReport;
	output_directory: string;
}

export async function generateTelemetryReport(options: GenerateTelemetryReportOptions = {}): Promise<GenerateTelemetryReportResult> {
	const inputDirectory = path.resolve(options.inputDirectory ?? path.join(os.homedir(), ".pi", "telemetry", "runs"));
	const outputDirectory = path.resolve(options.outputDirectory ?? path.join(os.homedir(), ".pi", "telemetry", "reports", "latest"));
	const [{ mkdir, writeFile }, { readTelemetryDirectory }, { aggregateTelemetry }, { renderTelemetryHtml }] = await Promise.all([
		import("node:fs/promises"),
		import("./read.js"),
		import("./aggregate.js"),
		import("./html.js"),
	]);
	const input = await readTelemetryDirectory(inputDirectory);
	const report = aggregateTelemetry(input.records, {
		...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
		...(options.query === undefined ? {} : { query: options.query }),
		inputFiles: input.files.map((file) => path.relative(inputDirectory, file).replace(/\\/gu, "/")),
		invalidLines: input.invalid_lines,
	});
	await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
	await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await writeFile(path.join(outputDirectory, "report.html"), renderTelemetryHtml(report), { encoding: "utf8", mode: 0o600 });
	return { report, output_directory: outputDirectory };
}
