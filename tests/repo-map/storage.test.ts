import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createFileIdentity } from "../../src/code-index/identity.js";
import { createRepoMapId } from "../../src/repo-map/identity.js";
import { calculateGeneration, commitGeneration, readCurrentGeneration, readGeneration } from "../../src/repo-map/storage.js";
import type { RepoMapFileRecord, RepoMapMetadata } from "../../src/repo-map/types.js";
import { useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-storage-");
const root = "/canonical/repo";
const gitCommonDir = "/canonical/repo/.git";
const mapId = createRepoMapId({ worktreeRoot: root, gitCommonDir });

describe("Repo Map generation storage", () => {
	it("writes a complete generation, switches CURRENT, and reuses immutable content", async () => {
		const files = [indexed("z.ts", "b"), indexed("a.ts", "a")].sort((a, b) => a.path.localeCompare(b.path));
		const metadata = makeMetadata(files);
		const first = await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, diagnostics: [] });
		expect(first.reused).toBe(false);
		expect((await readFile(path.join(temp.path, mapId, "CURRENT"), "utf8")).trim()).toBe(metadata.generation);
		expect(await readCurrentGeneration(temp.path, mapId, root)).toEqual(first.generation);
		const second = await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata: { ...metadata, updatedAt: "2030-01-01T00:00:00.000Z" }, files, diagnostics: [] });
		expect(second.reused).toBe(true);
		expect(second.generation.metadata.updatedAt).toBe(metadata.updatedAt);
		const persisted = JSON.parse(await readFile(path.join(temp.path, mapId, "generations", metadata.generation, "files.json"), "utf8")) as Array<{ path: string }>;
		expect(persisted.map((file) => file.path)).toEqual(["a.ts", "z.ts"]);
	});

	it.each(["../escape", "/absolute", "not-a-hash"])("rejects unsafe CURRENT value %s", async (current) => {
		await mkdir(path.join(temp.path, mapId), { recursive: true });
		await writeFile(path.join(temp.path, mapId, "CURRENT"), current);
		expect(await readCurrentGeneration(temp.path, mapId, root)).toBeUndefined();
	});

	it("rejects corrupt metadata, files, schema, map, and generation mismatches", async () => {
		const files = [indexed("a.ts", "a")];
		const metadata = makeMetadata(files);
		await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, diagnostics: [] });
		const directory = path.join(temp.path, mapId, "generations", metadata.generation);
		await writeFile(path.join(directory, "metadata.json"), JSON.stringify({ ...metadata, schemaVersion: 2 }));
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toBeUndefined();
		await writeFile(path.join(directory, "metadata.json"), JSON.stringify(metadata));
		await writeFile(path.join(directory, "files.json"), JSON.stringify([{ ...files[0], path: "../escape" }]));
		expect(await readGeneration(temp.path, mapId, metadata.generation, root)).toBeUndefined();
		expect(await readGeneration(temp.path, "b".repeat(64), metadata.generation, root)).toBeUndefined();
		expect(await readGeneration(temp.path, mapId, "c".repeat(64), root)).toBeUndefined();
	});

	it("preserves CURRENT on cancellation or invalid input", async () => {
		const files = [indexed("a", "a")];
		const metadata = makeMetadata(files);
		await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, diagnostics: [] });
		const controller = new AbortController();
		controller.abort();
		await expect(commitGeneration({
			cacheRoot: temp.path,
			maxGenerations: 2,
			metadata: { ...metadata, generation: "b".repeat(64) },
			files,
			diagnostics: [],
			signal: controller.signal,
		})).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
		expect((await readFile(path.join(temp.path, mapId, "CURRENT"), "utf8")).trim()).toBe(metadata.generation);
	});

	it("rejects a symlinked map cache directory", async () => {
		const cacheRoot = path.join(temp.path, "cache");
		const outside = path.join(temp.path, "outside");
		await mkdir(cacheRoot);
		await mkdir(outside);
		try {
			await symlink(outside, path.join(cacheRoot, mapId));
		} catch {
			return;
		}
		const files = [indexed("a", "a")];
		await expect(commitGeneration({ cacheRoot, maxGenerations: 2, metadata: makeMetadata(files), files, diagnostics: [] }))
			.rejects.toMatchObject({ code: "CACHE_ERROR" });
		expect(await readdir(outside)).toEqual([]);
	});

	it("keeps the current generation while cleaning old generations", async () => {
		for (const [index, name] of ["one", "two", "three"].entries()) {
			const files = [indexed(name, String(index))];
			const metadata = makeMetadata(files, `2026-01-0${index + 1}T00:00:00.000Z`);
			await commitGeneration({ cacheRoot: temp.path, maxGenerations: 2, metadata, files, diagnostics: [] });
		}
		const current = (await readFile(path.join(temp.path, mapId, "CURRENT"), "utf8")).trim();
		const generations = (await readdir(path.join(temp.path, mapId, "generations"))).filter((name) => /^[0-9a-f]{64}$/u.test(name));
		expect(generations).toHaveLength(2);
		expect(generations).toContain(current);
	});
});

function indexed(filePath: string, content: string): RepoMapFileRecord {
	return { ...createFileIdentity(filePath), size: content.length, mtimeMs: 1, status: "indexed", contentHash: hashFor(content) };
}

function makeMetadata(files: RepoMapFileRecord[], now = "2026-01-01T00:00:00.000Z"): RepoMapMetadata {
	const generation = calculateGeneration({
		mapId,
		configFingerprint: "c".repeat(64),
		ignoreFingerprint: "ignore",
		parserFingerprint: "format",
		headRevision: "d".repeat(40),
		files,
	});
	return {
		schemaVersion: 1,
		mapId,
		repositoryRoot: root,
		worktreeRoot: root,
		gitCommonDir,
		generation,
		createdAt: now,
		updatedAt: now,
		freshness: "fresh",
		fileCount: files.length,
		indexedFileCount: files.length,
		symbolCount: 0,
		edgeCount: 0,
		tooLargeFileCount: 0,
		diagnosticCount: 0,
		gitRevision: "d".repeat(40),
		configFingerprint: "c".repeat(64),
		ignoreFingerprint: "ignore",
		parserFingerprint: "format",
	};
}

function hashFor(value: string): string {
	return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}
