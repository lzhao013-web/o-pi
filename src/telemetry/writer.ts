import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";
import type { TelemetryRecord } from "./types.js";

export interface TelemetryWriter {
	append(record: TelemetryRecord): void;
	flush(): Promise<void>;
	status?(): TelemetryWriterStatus;
}

export interface TelemetryWriterStatus {
	pending: number;
	persisted: number;
	failed: number;
	last_failure_at?: string;
}

export interface JsonlTelemetryWriterOptions {
	directory?: string;
	append?: (file: string, content: string) => Promise<void>;
	acquireLock?: (file: string) => Promise<() => Promise<void>>;
}

export class JsonlTelemetryWriter implements TelemetryWriter {
	readonly #file: string;
	readonly #directory: string;
	readonly #append: (file: string, content: string) => Promise<void>;
	readonly #acquireLock: (file: string) => Promise<() => Promise<void>>;
	#queue: Promise<void> = Promise.resolve();
	#pending = 0;
	#persisted = 0;
	#failed = 0;
	#lastFailureAt: string | undefined;

	constructor(sessionId: string, options: JsonlTelemetryWriterOptions = {}) {
		this.#directory = options.directory ?? path.join(os.homedir(), ".pi", "telemetry", "sessions");
		this.#file = telemetrySessionFile(sessionId, this.#directory);
		this.#append = options.append ?? (async (file, content) => appendFile(file, content, { encoding: "utf8", mode: 0o600 }));
		this.#acquireLock = options.acquireLock ?? acquireTelemetryFileLock;
	}

	append(record: TelemetryRecord): void {
		let line: string;
		try {
			line = `${JSON.stringify(record)}\n`;
		} catch {
			this.#failed += 1;
			this.#lastFailureAt = new Date().toISOString();
			return;
		}
		this.#pending += 1;
		this.#queue = this.#queue.then(async () => {
			try {
				await mkdir(this.#directory, { recursive: true, mode: 0o700 });
				const release = await this.#acquireLock(this.#file);
				try {
					await this.#append(this.#file, line);
				} finally {
					await release();
				}
				this.#persisted += 1;
			} catch {
				this.#failed += 1;
				this.#lastFailureAt = new Date().toISOString();
			} finally {
				this.#pending -= 1;
			}
		});
	}

	async flush(): Promise<void> {
		await this.#queue.catch(() => undefined);
	}

	status(): TelemetryWriterStatus {
		return {
			pending: this.#pending,
			persisted: this.#persisted,
			failed: this.#failed,
			...(this.#lastFailureAt === undefined ? {} : { last_failure_at: this.#lastFailureAt }),
		};
	}
}

export async function acquireTelemetryFileLock(file: string): Promise<() => Promise<void>> {
	return lock(file, {
		realpath: false,
		stale: 10_000,
		retries: {
			retries: 20,
			factor: 1.5,
			minTimeout: 5,
			maxTimeout: 50,
			randomize: true,
		},
	});
}

export function telemetrySessionFile(sessionId: string, directory = path.join(os.homedir(), ".pi", "telemetry", "sessions")): string {
	return path.join(directory, `${safeFileName(sessionId)}.jsonl`);
}

function safeFileName(sessionId: string): string {
	const prefix = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "unknown";
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	return `${prefix}-${digest}`;
}
