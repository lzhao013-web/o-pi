import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";

import { acquireTelemetryFileLock, safeTelemetryFileName } from "./writer.js";

const MAX_JSONL_LINE_CHARS = 1_000_000;

export interface TelemetryJsonlSnapshot {
	records: unknown[];
	invalidLines: number;
	omittedRecords?: number;
	metricSchemas?: Array<{ key: string; schema: string; timestamp: string }>;
}

export interface TelemetryDirectorySnapshot extends TelemetryJsonlSnapshot {
	files: string[];
}

/** Read a durable file cut while excluding a concurrent single-line append. */
export async function readTelemetryJsonlFile(
	file: string,
	options: { maxRecords?: number; onRecord?: (record: unknown) => void } = {},
): Promise<TelemetryJsonlSnapshot> {
	try {
		if (!(await stat(file)).isFile()) return { records: [], invalidLines: 0 };
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { records: [], invalidLines: 0 };
		throw error;
	}
	const release = await acquireTelemetryFileLock(file);
	try {
		return await parseJsonlFile(file, options);
	} finally {
		await release();
	}
}

async function parseJsonlFile(
	file: string,
	options: { maxRecords?: number; onRecord?: (record: unknown) => void },
): Promise<TelemetryJsonlSnapshot> {
	const records: unknown[] = [];
	let invalidLines = 0;
	let totalRecords = 0;
	const input = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			const parsed = parseJsonlLine(line);
			if (parsed.valid) {
				options.onRecord?.(parsed.value);
				records.push(parsed.value);
				totalRecords += 1;
				if (options.maxRecords !== undefined && records.length > Math.max(1, options.maxRecords * 2)) retainLatest(records, options.maxRecords);
			}
			else if (!parsed.empty) invalidLines += 1;
		}
	} finally {
		lines.close();
		input.destroy();
	}
	if (options.maxRecords !== undefined) retainLatest(records, options.maxRecords);
	const omittedRecords = totalRecords - records.length;
	return { records, invalidLines, ...(omittedRecords === 0 ? {} : { omittedRecords }) };
}

/** Capture the sorted input manifest first, then read every file under its append lock. */
export async function readTelemetryDirectory(directory = path.join(os.homedir(), ".pi", "telemetry", "sessions")): Promise<TelemetryDirectorySnapshot> {
	return readDirectory(directory);
}

/** Read only the ledgers whose filenames belong to one session. */
export async function readTelemetrySessionDirectory(
	sessionId: string,
	options: { directory?: string; maxRecords?: number; onRecord?: (record: unknown) => void } = {},
): Promise<TelemetryDirectorySnapshot> {
	return readDirectory(options.directory ?? path.join(os.homedir(), ".pi", "telemetry", "sessions"),
		`${safeTelemetryFileName(sessionId)}.`, options.maxRecords, options.onRecord);
}

async function readDirectory(
	directory: string,
	filePrefix?: string,
	maxRecords?: number,
	onRecord?: (record: unknown) => void,
): Promise<TelemetryDirectorySnapshot> {
	let files: string[];
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && (filePrefix === undefined || entry.name.startsWith(filePrefix)))
			.map((entry) => path.join(directory, entry.name))
			.sort(compare);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { records: [], invalidLines: 0, files: [] };
		throw error;
	}
	const records: unknown[] = [];
	let invalidLines = 0;
	let totalRecords = 0;
	for (const file of files) {
		const snapshot = await readTelemetryJsonlFile(file, { ...(maxRecords === undefined ? {} : { maxRecords }),
			...(onRecord === undefined ? {} : { onRecord }) });
		records.push(...snapshot.records);
		totalRecords += snapshot.records.length + (snapshot.omittedRecords ?? 0);
		invalidLines += snapshot.invalidLines;
		if (maxRecords !== undefined && records.length > maxRecords) {
			records.sort(compareRecordTime);
			records.splice(0, records.length - maxRecords);
		}
	}
	const omittedRecords = totalRecords - records.length;
	return { records, invalidLines, files, ...(omittedRecords === 0 ? {} : { omittedRecords }) };
}

function retainLatest(records: unknown[], maxRecords: number): void {
	const limit = Math.max(0, maxRecords);
	if (records.length <= limit) return;
	records.sort(compareRecordTime);
	records.splice(0, records.length - limit);
}

function compareRecordTime(left: unknown, right: unknown): number {
	const leftTime = recordTimestamp(left);
	const rightTime = recordTimestamp(right);
	return leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0;
}

function recordTimestamp(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
	const timestamp = Reflect.get(value, "timestamp");
	return typeof timestamp === "string" ? timestamp : "";
}

function parseJsonlLine(line: string): { valid: true; value: unknown; empty: false } | { valid: false; empty: boolean } {
	if (line.trim().length === 0) return { valid: false, empty: true };
	if (line.length > MAX_JSONL_LINE_CHARS) return { valid: false, empty: false };
	try {
		return { valid: true, value: JSON.parse(line) as unknown, empty: false };
	} catch {
		return { valid: false, empty: false };
	}
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error;
}
