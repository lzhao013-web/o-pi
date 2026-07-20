import { mkdir, open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { stableHash } from "./projectors.js";
import type { JsonObject, JsonValue } from "./types.js";

export type TelemetryManifestKind = "collector_contract" | "tool_behavior" | "tool_definition" | "tool_instrumentation" | "tool_config" | "analysis_contract";

export interface TelemetryManifest {
	kind: TelemetryManifestKind;
	hash: string;
	descriptor: JsonObject;
}

export interface TelemetryManifestSink {
	append(manifest: TelemetryManifest): void;
	flush(): Promise<void>;
	status(): { failed: number };
}

export function createManifest(kind: TelemetryManifestKind, descriptor: JsonObject): TelemetryManifest {
	return { kind, hash: stableHash({ kind, descriptor }), descriptor };
}

export class TelemetryManifestStore implements TelemetryManifestSink {
	readonly #root: string;
	#queue: Promise<void> = Promise.resolve();
	readonly #queued = new Set<string>();
	#failed = 0;

	constructor(root = path.join(os.homedir(), ".pi", "telemetry", "manifests")) {
		this.#root = root;
	}

	append(manifest: TelemetryManifest): void {
		const key = `${manifest.kind}\0${manifest.hash}`;
		if (this.#queued.has(key)) return;
		this.#queued.add(key);
		this.#queue = this.#queue.then(() => persistManifest(this.#root, manifest)).catch(() => {
			this.#queued.delete(key);
			this.#failed += 1;
		});
	}

	async flush(): Promise<void> {
		await this.#queue;
	}

	status(): { failed: number } {
		return { failed: this.#failed };
	}
}

async function persistManifest(root: string, manifest: TelemetryManifest): Promise<void> {
	const directory = path.join(root, manifest.kind);
	const file = path.join(directory, `${manifest.hash}.json`);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		const existing = JSON.parse(await readFile(file, "utf8")) as unknown;
		if (stableHash(existing) !== stableHash(manifest)) throw new Error(`Manifest collision: ${manifest.kind}/${manifest.hash}`);
		return;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
	let handle;
	try {
		handle = await open(file, "wx", 0o600);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
		const existing: unknown = JSON.parse(await readFile(file, "utf8"));
		if (stableHash(existing) !== stableHash(manifest)) throw new Error(`Manifest collision: ${manifest.kind}/${manifest.hash}`);
		return;
	}
	try {
		await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export function safeManifestValue(value: unknown): JsonValue {
	return sanitize(value, new WeakSet(), 0, "root");
}

/** Hash the complete value before its human-inspectable manifest projection is truncated. */
export function manifestValueFingerprint(value: unknown): string {
	return stableHash(fingerprintValue(value, new WeakMap(), "$"));
}

function fingerprintValue(value: unknown, seen: WeakMap<object, string>, pathValue: string): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value !== "object") return String(value);
	const previous = seen.get(value);
	if (previous !== undefined) return `[reference:${previous}]`;
	seen.set(value, pathValue);
	if (Array.isArray(value)) return value.map((child, index) => fingerprintValue(child, seen, `${pathValue}[${index}]`));
	const result: JsonObject = {};
	for (const key of Object.keys(value).sort()) result[key] = fingerprintValue(Reflect.get(value, key), seen, `${pathValue}.${key}`);
	return result;
}

function sanitize(value: unknown, ancestors: WeakSet<object>, depth: number, key: string): JsonValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		if (isSecretKey(key)) return { redacted: true, sha256: stableHash(value) };
		return value.length <= 2048 ? value : `${value.slice(0, 512)}...[${value.length}:${stableHash(value)}]`;
	}
	if (typeof value !== "object" || depth >= 8) return String(value);
	if (ancestors.has(value)) return "[circular]";
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitize(item, ancestors, depth + 1, key));
		const result: JsonObject = {};
		for (const [childKey, child] of Object.entries(value).slice(0, 128)) result[childKey] = sanitize(child, ancestors, depth + 1, childKey);
		return result;
	} finally {
		ancestors.delete(value);
	}
}

function isSecretKey(key: string): boolean {
	return /(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)$/iu.test(key);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error;
}
