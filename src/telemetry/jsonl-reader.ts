import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { acquireTelemetryFileLock } from "./writer.js";

export interface TelemetryJsonlSnapshot {
	records: unknown[];
	invalidLines: number;
}

export interface TelemetryDirectorySnapshot extends TelemetryJsonlSnapshot {
	files: string[];
}

/** Read a durable file cut while excluding a concurrent single-line append. */
export async function readTelemetryJsonlFile(file: string): Promise<TelemetryJsonlSnapshot> {
	try {
		if (!(await stat(file)).isFile()) return { records: [], invalidLines: 0 };
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { records: [], invalidLines: 0 };
		throw error;
	}
	const release = await acquireTelemetryFileLock(file);
	try {
		return parseJsonl(await readFile(file, "utf8"));
	} finally {
		await release();
	}
}

/** Capture the sorted input manifest first, then read every file under its append lock. */
export async function readTelemetryDirectory(directory: string): Promise<TelemetryDirectorySnapshot> {
	let files: string[];
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => path.join(directory, entry.name))
			.sort(compare);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { records: [], invalidLines: 0, files: [] };
		throw error;
	}
	const records: unknown[] = [];
	let invalidLines = 0;
	for (const file of files) {
		const snapshot = await readTelemetryJsonlFile(file);
		records.push(...snapshot.records);
		invalidLines += snapshot.invalidLines;
	}
	return { records, invalidLines, files };
}

function parseJsonl(content: string): TelemetryJsonlSnapshot {
	const records: unknown[] = [];
	let invalidLines = 0;
	for (const line of content.split(/\r?\n/u)) {
		if (line.trim().length === 0) continue;
		try {
			records.push(JSON.parse(line) as unknown);
		} catch {
			invalidLines += 1;
		}
	}
	return { records, invalidLines };
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error;
}
