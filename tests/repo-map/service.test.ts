import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { defaultFileToolsConfig } from "../../src/file-tools/config.js";
import { createIgnoreSnapshot, defaultIgnoreEngine } from "../../src/file-tools/ignore/ignore-engine.js";
import { defaultRepoMapConfig } from "../../src/repo-map/config.js";
import { RepoMapError } from "../../src/repo-map/errors.js";
import { initializeRepoMap, type RepoMapServiceDependencies } from "../../src/repo-map/service.js";
import { preserveEnv, useTempDir } from "../helpers/lifecycle.js";

const temp = useTempDir("o-pi-repo-service-");
const execFileAsync = promisify(execFile);
const gitAvailable = await hasGit();
preserveEnv(
	"PI_REPO_MAP_CACHE_DIR",
	"PI_REPO_MAP_CONFIG",
	"PI_FILE_TOOLS_CONFIG",
	"PI_FILE_TOOLS_PROJECT_CONFIG",
	"PI_FILE_TOOLS_PROJECT_ROOT",
);

function dependencies(overrides: Partial<RepoMapServiceDependencies> = {}): Partial<RepoMapServiceDependencies> {
	const root = path.join(temp.path, "repo");
	return {
		async detectRepository() {
			return { repositoryRoot: root, worktreeRoot: root, gitCommonDir: path.join(root, ".git"), headRevision: "a".repeat(40) };
		},
		async readHeadRevision() { return "a".repeat(40); },
		async loadRepoMapConfig() { return defaultRepoMapConfig(); },
		async loadFileToolsConfig() { return defaultFileToolsConfig(); },
		async createIgnoreSnapshot(scanRoot, config) {
			defaultIgnoreEngine.invalidate();
			return await createIgnoreSnapshot(scanRoot, config);
		},
		cacheRoot: () => path.join(temp.path, "cache"),
		now: () => new Date("2026-07-17T00:00:00.000Z"),
		...overrides,
	};
}

describe("Repo Map initialization service", () => {
	it.skipIf(!gitAvailable)("runs the real Git/config/ignore/storage boundaries in a temporary repository", async () => {
		const root = path.join(temp.path, "real-repo");
		await mkdir(root);
		await execFileAsync("git", ["init", "--quiet", root]);
		await writeFile(path.join(root, "tracked.ts"), "export const value = 1;\n");
		process.env["PI_REPO_MAP_CACHE_DIR"] = path.join(temp.path, "real-cache");
		process.env["PI_REPO_MAP_CONFIG"] = path.join(temp.path, "missing-repo-map.jsonc");
		process.env["PI_FILE_TOOLS_CONFIG"] = path.join(temp.path, "missing-file-tools.jsonc");
		delete process.env["PI_FILE_TOOLS_PROJECT_CONFIG"];
		delete process.env["PI_FILE_TOOLS_PROJECT_ROOT"];
		const result = await initializeRepoMap({ cwd: root });
		expect(result.identity.repositoryRoot).toBe(root);
		expect(result.metadata).toMatchObject({ fileCount: 1, indexedFileCount: 1, symbolCount: 0, edgeCount: 0 });
	});
	it("builds, persists, and reuses a file-only generation", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
		const first = await initializeRepoMap({ cwd: root }, dependencies());
		expect(first.reusedGeneration).toBe(false);
		expect(first.metadata).toMatchObject({ fileCount: 1, indexedFileCount: 1, symbolCount: 0, edgeCount: 0, freshness: "fresh" });
		const second = await initializeRepoMap({ cwd: root }, dependencies());
		expect(second.reusedGeneration).toBe(true);
		expect(second.metadata.generation).toBe(first.metadata.generation);
		expect(second.summary).toMatchObject({ reused: 1, hashed: 0, added: 0, changed: 0, removed: 0 });
	});

	it("rehashes only a changed file and rebuilds a corrupt current generation", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(path.join(root, ".git"), { recursive: true });
		await writeFile(path.join(root, "a"), "a");
		await writeFile(path.join(root, "b"), "b");
		const first = await initializeRepoMap({ cwd: root }, dependencies());
		await writeFile(path.join(root, "b"), "changed-size");
		const changed = await initializeRepoMap({ cwd: root }, dependencies());
		expect(changed.summary).toMatchObject({ reused: 1, hashed: 1, changed: 1 });
		await writeFile(
			path.join(temp.path, "cache", changed.metadata.mapId, "generations", changed.metadata.generation, "files.json"),
			"corrupt",
		);
		const rebuilt = await initializeRepoMap({ cwd: root }, dependencies());
		expect(rebuilt.metadata.generation).toBe(changed.metadata.generation);
		expect(rebuilt.reusedGeneration).toBe(false);
		expect(rebuilt.summary.hashed).toBe(2);
		expect(first.metadata.generation).not.toBe(changed.metadata.generation);
	});

	it("rejects HEAD changes without committing", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "a"), "a");
		await expect(initializeRepoMap({ cwd: root }, dependencies({
			async readHeadRevision() { return "b".repeat(40); },
		}))).rejects.toMatchObject({ code: "REPOSITORY_CHANGED_DURING_SCAN" });
	});

	it("propagates config, scan-limit, and cancellation errors", async () => {
		const root = path.join(temp.path, "repo");
		await mkdir(root, { recursive: true });
		await writeFile(path.join(root, "a"), "a");
		await expect(initializeRepoMap({ cwd: root }, dependencies({
			async loadRepoMapConfig() { throw new RepoMapError("CONFIG_ERROR", "bad config"); },
		}))).rejects.toMatchObject({ code: "CONFIG_ERROR" });
		await writeFile(path.join(root, "b"), "b");
		await expect(initializeRepoMap({ cwd: root }, dependencies({
			async loadRepoMapConfig() {
				const config = defaultRepoMapConfig();
				config.scan.max_files = 1;
				return config;
			},
		}))).rejects.toMatchObject({ code: "SCAN_LIMIT_EXCEEDED" });
		const controller = new AbortController();
		controller.abort();
		await expect(initializeRepoMap({ cwd: root, signal: controller.signal }, dependencies())).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
	});
});

async function hasGit(): Promise<boolean> {
	try {
		await execFileAsync("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}
