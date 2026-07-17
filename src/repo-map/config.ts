import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { agentSchemaPath, createSchemaValidator, expandHomePath, readOptionalJsoncConfigWithSchema, userAgentConfigPath } from "../config-loader.js";
import { RepoMapError } from "./errors.js";

const USER_CONFIG_ENV = "PI_REPO_MAP_CONFIG";
const CACHE_DIR_ENV = "PI_REPO_MAP_CACHE_DIR";

export interface RepoMapConfig {
	version: 1;
	scan: {
		max_files: number;
		max_file_bytes: number;
		concurrency: number;
	};
	cache: {
		max_generations: number;
	};
}

interface RawRepoMapConfig {
	version: 1;
	scan?: Partial<RepoMapConfig["scan"]>;
	cache?: Partial<RepoMapConfig["cache"]>;
}

const defaults: RepoMapConfig = {
	version: 1,
	scan: { max_files: 100_000, max_file_bytes: 1024 * 1024, concurrency: 8 },
	cache: { max_generations: 2 },
};

export async function loadRepoMapConfig(): Promise<RepoMapConfig> {
	try {
		const parsed = await readOptionalJsoncConfigWithSchema({
			path: userAgentConfigPath("repo-map.jsonc", USER_CONFIG_ENV),
			label: "repo-map",
			loadValidator,
			createError: (message, details) => new RepoMapConfigError(message, details),
		});
		if (parsed === undefined) return defaultRepoMapConfig();
		if (!isRawRepoMapConfig(parsed)) throw new RepoMapConfigError("repo-map config has an invalid shape.");
		return {
			version: 1,
			scan: { ...defaults.scan, ...parsed.scan },
			cache: { ...defaults.cache, ...parsed.cache },
		};
	} catch (error) {
		if (error instanceof RepoMapConfigError) throw new RepoMapError("CONFIG_ERROR", error.message, error.details);
		throw error;
	}
}

export function defaultRepoMapConfig(): RepoMapConfig {
	return structuredClone(defaults);
}

export function repoMapCacheRoot(): string {
	return path.resolve(expandHomePath(process.env[CACHE_DIR_ENV] ?? path.join(os.homedir(), ".pi", "cache", "repo-map")));
}

export function repoMapConfigFingerprint(config: RepoMapConfig): string {
	return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

class RepoMapConfigError extends Error {
	constructor(message: string, readonly details?: Record<string, unknown>) {
		super(message);
	}
}

const loadValidator = createSchemaValidator({
	schemaPath: agentSchemaPath("repo-map.schema.json"),
	label: "repo-map",
	createError: (message, details) => new RepoMapConfigError(message, details),
});

function isRawRepoMapConfig(value: unknown): value is RawRepoMapConfig {
	return typeof value === "object" && value !== null && "version" in value && value.version === 1;
}
