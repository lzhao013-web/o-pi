import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { createFileIdentity } from "../code-index/identity.js";
import { RepoMapError, throwIfAborted } from "./errors.js";
import { createRepoMapId, REPO_MAP_SCHEMA_VERSION } from "./identity.js";
import type { RepoMapDiagnostic, RepoMapFileRecord, RepoMapMetadata } from "./types.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export interface RepoMapGeneration {
	metadata: RepoMapMetadata;
	files: RepoMapFileRecord[];
	diagnostics: RepoMapDiagnostic[];
}

export interface CommitGenerationInput extends RepoMapGeneration {
	cacheRoot: string;
	maxGenerations: number;
	signal?: AbortSignal;
}

export interface CommitGenerationResult {
	generation: RepoMapGeneration;
	reused: boolean;
}

export function calculateGeneration(input: {
	mapId: string;
	configFingerprint: string;
	ignoreFingerprint: string;
	parserFingerprint: string;
	headRevision?: string;
	files: readonly RepoMapFileRecord[];
}): string {
	const hash = createHash("sha256");
	const values: unknown[] = [
		input.mapId,
		REPO_MAP_SCHEMA_VERSION,
		input.configFingerprint,
		input.ignoreFingerprint,
		input.parserFingerprint,
		input.headRevision ?? null,
		[...input.files]
			.sort((left, right) => compareStable(left.path, right.path))
			.map((file) => [file.id, file.path, file.size, file.mtimeMs, file.status, file.contentHash ?? null]),
	];
	for (const value of values) {
		const encoded = JSON.stringify(value);
		hash.update(`${Buffer.byteLength(encoded)}:`).update(encoded);
	}
	return hash.digest("hex");
}

export async function readCurrentGeneration(
	cacheRoot: string,
	mapId: string,
	expectedRoot?: string,
): Promise<RepoMapGeneration | undefined> {
	if (!HASH_PATTERN.test(mapId)) return undefined;
	let current: string;
	try {
		current = (await readFile(path.join(cacheRoot, mapId, "CURRENT"), "utf8")).trim();
	} catch {
		return undefined;
	}
	if (!isGenerationId(current)) return undefined;
	return await readGeneration(cacheRoot, mapId, current, expectedRoot);
}

export async function readGeneration(
	cacheRoot: string,
	mapId: string,
	generation: string,
	expectedRoot?: string,
): Promise<RepoMapGeneration | undefined> {
	if (!HASH_PATTERN.test(mapId) || !isGenerationId(generation)) return undefined;
	const directory = generationDirectory(cacheRoot, mapId, generation);
	try {
		const directoryInfo = await lstat(directory);
		if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return undefined;
		const [metadataValue, filesValue, diagnosticsValue] = await Promise.all([
			readJson(path.join(directory, "metadata.json")),
			readJson(path.join(directory, "files.json")),
			readJson(path.join(directory, "diagnostics.json")),
		]);
		const metadata = validateMetadata(metadataValue, mapId, generation, expectedRoot);
		const files = validateFiles(filesValue);
		const diagnostics = validateDiagnostics(diagnosticsValue);
		if (metadata.fileCount !== files.length) return undefined;
		if (metadata.indexedFileCount !== files.filter((file) => file.status === "indexed").length) return undefined;
		if (metadata.tooLargeFileCount !== files.filter((file) => file.status === "too_large").length) return undefined;
		if (metadata.diagnosticCount !== diagnostics.length) return undefined;
		return { metadata, files, diagnostics };
	} catch {
		return undefined;
	}
}

export async function commitGeneration(input: CommitGenerationInput): Promise<CommitGenerationResult> {
	throwIfAborted(input.signal);
	validateCommitInput(input);
	const mapDirectory = path.join(input.cacheRoot, input.metadata.mapId);
	const generationsDirectory = path.join(mapDirectory, "generations");
	await prepareCacheDirectories(input.cacheRoot, mapDirectory, generationsDirectory);
	const releaseLock = await acquireCommitLock(mapDirectory);
	let temporaryDirectory: string | undefined;
	try {
		const existing = await readGeneration(input.cacheRoot, input.metadata.mapId, input.metadata.generation, input.metadata.repositoryRoot);
		let generation = existing;
		let reused = existing !== undefined;
		if (generation === undefined) {
			temporaryDirectory = await mkdtemp(path.join(generationsDirectory, ".tmp-"));
			await bestEffortChmod(temporaryDirectory, 0o700);
			await writeJsonFile(path.join(temporaryDirectory, "metadata.json"), input.metadata);
			await writeJsonFile(path.join(temporaryDirectory, "files.json"), [...input.files].sort((a, b) => compareStable(a.path, b.path)));
			await writeJsonFile(path.join(temporaryDirectory, "diagnostics.json"), input.diagnostics);
			throwIfAborted(input.signal);
			const destination = generationDirectory(input.cacheRoot, input.metadata.mapId, input.metadata.generation);
			if (await exists(destination)) {
				const racedGeneration = await readGeneration(
					input.cacheRoot,
					input.metadata.mapId,
					input.metadata.generation,
					input.metadata.repositoryRoot,
				);
				if (racedGeneration !== undefined) {
					generation = racedGeneration;
					reused = true;
				} else {
					const corruptName = path.join(generationsDirectory, `.corrupt-${input.metadata.generation}-${randomUUID()}`);
					await rename(destination, corruptName);
				}
			}
			if (generation === undefined) {
				await rename(temporaryDirectory, destination);
				temporaryDirectory = undefined;
				generation = await readGeneration(input.cacheRoot, input.metadata.mapId, input.metadata.generation, input.metadata.repositoryRoot);
				if (generation === undefined) throw new RepoMapError("CACHE_ERROR", "Repo Map generation failed validation after saving.");
			}
		}
		throwIfAborted(input.signal);
		await replaceCurrent(mapDirectory, input.metadata.generation);
		await cleanupGenerations(input.cacheRoot, input.metadata.mapId, input.metadata.generation, input.maxGenerations);
		return { generation, reused };
	} catch (error) {
		if (error instanceof RepoMapError) throw error;
		throw new RepoMapError("CACHE_ERROR", "Repo Map cache could not be saved.", error);
	} finally {
		if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
		await releaseLock();
	}
}

function validateCommitInput(input: CommitGenerationInput): void {
	const metadata = validateMetadata(input.metadata, input.metadata.mapId, input.metadata.generation, input.metadata.repositoryRoot);
	const files = validateFiles(input.files);
	const diagnostics = validateDiagnostics(input.diagnostics);
	if (metadata.fileCount !== files.length || metadata.diagnosticCount !== diagnostics.length) {
		throw new RepoMapError("CACHE_ERROR", "Repo Map generation counts are inconsistent.");
	}
}

async function replaceCurrent(mapDirectory: string, generation: string): Promise<void> {
	const temporaryPath = path.join(mapDirectory, `.CURRENT-${process.pid}-${randomUUID()}.tmp`);
	try {
		await writeTextFile(temporaryPath, `${generation}\n`);
		await rename(temporaryPath, path.join(mapDirectory, "CURRENT"));
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

async function cleanupGenerations(cacheRoot: string, mapId: string, current: string, maxGenerations: number): Promise<void> {
	try {
		const directory = path.join(cacheRoot, mapId, "generations");
		const entries = await readdir(directory, { withFileTypes: true });
		const candidates: Array<{ id: string; mtimeMs: number }> = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || !isGenerationId(entry.name) || entry.name === current) continue;
			const info = await stat(path.join(directory, entry.name));
			candidates.push({ id: entry.name, mtimeMs: info.mtimeMs });
		}
		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || compareStable(a.id, b.id));
		const keepOther = Math.max(0, maxGenerations - 1);
		for (const candidate of candidates.slice(keepOther)) {
			await rm(generationDirectory(cacheRoot, mapId, candidate.id), { recursive: true, force: true });
		}
	} catch {
		// Cleanup cannot invalidate the generation just committed.
	}
}

function validateMetadata(value: unknown, mapId: string, generation: string, expectedRoot?: string): RepoMapMetadata {
	if (!isRecord(value)) throw new Error("invalid metadata");
	if (
		value["schemaVersion"] !== REPO_MAP_SCHEMA_VERSION
		|| value["mapId"] !== mapId
		|| value["generation"] !== generation
		|| !isNonEmptyString(value["repositoryRoot"])
		|| !isNonEmptyString(value["worktreeRoot"])
		|| !isNonEmptyString(value["gitCommonDir"])
		|| (expectedRoot !== undefined && path.resolve(value["repositoryRoot"]) !== path.resolve(expectedRoot))
		|| (expectedRoot !== undefined && path.resolve(value["worktreeRoot"]) !== path.resolve(expectedRoot))
		|| !isCanonicalAbsolutePath(value["repositoryRoot"])
		|| !isCanonicalAbsolutePath(value["worktreeRoot"])
		|| !isCanonicalAbsolutePath(value["gitCommonDir"])
		|| createRepoMapId({ worktreeRoot: value["worktreeRoot"], gitCommonDir: value["gitCommonDir"] }) !== mapId
		|| !isIsoDate(value["createdAt"])
		|| !isIsoDate(value["updatedAt"])
		|| !isFreshness(value["freshness"])
		|| !isCount(value["fileCount"])
		|| !isCount(value["indexedFileCount"])
		|| value["symbolCount"] !== 0
		|| value["edgeCount"] !== 0
		|| !isCount(value["tooLargeFileCount"])
		|| !isCount(value["diagnosticCount"])
		|| (value["gitRevision"] !== undefined && !isGitRevision(value["gitRevision"]))
		|| !isHash(value["configFingerprint"])
		|| !isNonEmptyString(value["ignoreFingerprint"])
		|| !isNonEmptyString(value["parserFingerprint"])
	) throw new Error("invalid metadata");
	return {
		schemaVersion: REPO_MAP_SCHEMA_VERSION,
		mapId,
		repositoryRoot: value["repositoryRoot"],
		worktreeRoot: value["worktreeRoot"],
		gitCommonDir: value["gitCommonDir"],
		generation,
		createdAt: value["createdAt"],
		updatedAt: value["updatedAt"],
		freshness: value["freshness"],
		fileCount: value["fileCount"],
		indexedFileCount: value["indexedFileCount"],
		symbolCount: 0,
		edgeCount: 0,
		tooLargeFileCount: value["tooLargeFileCount"],
		diagnosticCount: value["diagnosticCount"],
		...(typeof value["gitRevision"] === "string" ? { gitRevision: value["gitRevision"] } : {}),
		configFingerprint: value["configFingerprint"],
		ignoreFingerprint: value["ignoreFingerprint"],
		parserFingerprint: value["parserFingerprint"],
	};
}

function validateFiles(value: unknown): RepoMapFileRecord[] {
	if (!Array.isArray(value)) throw new Error("invalid files");
	const files: RepoMapFileRecord[] = [];
	let previousPath: string | undefined;
	for (const item of value) {
		if (!isRecord(item) || !isSafeRelativePath(item["path"]) || !isNonNegativeFinite(item["size"]) || !isNonNegativeFinite(item["mtimeMs"]) || !isFileStatus(item["status"])) {
			throw new Error("invalid file record");
		}
		const identity = createFileIdentity(item["path"]);
		if (item["id"] !== identity.id || (previousPath !== undefined && compareStable(previousPath, item["path"]) >= 0)) throw new Error("invalid file identity or order");
		if (item["status"] === "indexed" ? !isHash(item["contentHash"]) : item["contentHash"] !== undefined) throw new Error("invalid content hash");
		files.push({
			...identity,
			size: item["size"],
			mtimeMs: item["mtimeMs"],
			status: item["status"],
			...(typeof item["contentHash"] === "string" ? { contentHash: item["contentHash"] } : {}),
		});
		previousPath = item["path"];
	}
	return files;
}

function validateDiagnostics(value: unknown): RepoMapDiagnostic[] {
	if (!Array.isArray(value)) throw new Error("invalid diagnostics");
	return value.map((item) => {
		if (!isRecord(item) || !isNonEmptyString(item["code"]) || !isNonEmptyString(item["message"])) throw new Error("invalid diagnostic");
		if (item["path"] !== undefined && !isSafeDiagnosticPath(item["path"])) throw new Error("invalid diagnostic path");
		return {
			code: item["code"],
			message: item["message"],
			...(typeof item["path"] === "string" ? { path: item["path"] } : {}),
		};
	});
}

async function readJson(filePath: string): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextFile(filePath: string, value: string): Promise<void> {
	const handle = await open(filePath, "wx", 0o600);
	try {
		await handle.writeFile(value, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function bestEffortChmod(target: string, mode: number): Promise<void> {
	await chmod(target, mode).catch(() => undefined);
}

async function prepareCacheDirectories(cacheRoot: string, mapDirectory: string, generationsDirectory: string): Promise<void> {
	try {
		await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
		await ensurePrivateDirectory(mapDirectory);
		await ensurePrivateDirectory(generationsDirectory);
		await bestEffortChmod(cacheRoot, 0o700);
	} catch (error) {
		throw new RepoMapError("CACHE_ERROR", "Repo Map cache directory is not safe or cannot be created.", error);
	}
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if (!isErrorCode(error, "EEXIST")) throw error;
	}
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("cache path is not a real directory");
	await bestEffortChmod(directory, 0o700);
}

async function acquireCommitLock(mapDirectory: string): Promise<() => Promise<void>> {
	const lockPath = path.join(mapDirectory, "COMMIT_LOCK");
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(lockPath, "wx", 0o600);
	} catch (error) {
		if (!isErrorCode(error, "EEXIST") || !await removeStaleLock(lockPath)) {
			throw new RepoMapError("CACHE_ERROR", "Another Repo Map commit is already in progress.", error);
		}
		try {
			handle = await open(lockPath, "wx", 0o600);
		} catch (retryError) {
			throw new RepoMapError("CACHE_ERROR", "Another Repo Map commit is already in progress.", retryError);
		}
	}
	try {
		await handle.writeFile(`${process.pid}\n`, "utf8");
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(lockPath, { force: true }).catch(() => undefined);
		throw new RepoMapError("CACHE_ERROR", "Repo Map commit lock could not be created.", error);
	}
	return async () => {
		await handle.close().catch(() => undefined);
		await rm(lockPath, { force: true }).catch(() => undefined);
	};
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
	try {
		const info = await lstat(lockPath);
		if (!info.isFile() || Date.now() - info.mtimeMs < 10 * 60 * 1000) return false;
		await rm(lockPath, { force: true });
		return true;
	} catch {
		return false;
	}
}

async function exists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

function generationDirectory(cacheRoot: string, mapId: string, generation: string): string {
	return path.join(cacheRoot, mapId, "generations", generation);
}

function isGenerationId(value: string): boolean {
	return HASH_PATTERN.test(value) && !value.includes("..") && !path.isAbsolute(value) && !value.includes("/") && !value.includes("\\");
}

function isSafeRelativePath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
	const normalized = path.posix.normalize(value);
	return normalized === value && value !== "." && value !== ".." && !value.startsWith("../");
}

function isSafeDiagnosticPath(value: unknown): value is string {
	return value === "." || isSafeRelativePath(value) || (typeof value === "string" && value.startsWith("<") && value.endsWith(">"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isIsoDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCanonicalAbsolutePath(value: string): boolean {
	return path.isAbsolute(value) && !value.includes("\0") && path.normalize(value) === value;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && HASH_PATTERN.test(value);
}

function isGitRevision(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value);
}

function isFreshness(value: unknown): value is RepoMapMetadata["freshness"] {
	return value === "fresh" || value === "partially_stale" || value === "stale" || value === "unavailable";
}

function isFileStatus(value: unknown): value is RepoMapFileRecord["status"] {
	return value === "indexed" || value === "too_large" || value === "unreadable" || value === "unstable";
}

function compareStable(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
