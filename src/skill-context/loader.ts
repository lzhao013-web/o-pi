import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { BuildSystemPromptOptions, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { parseSkillFile, parseSkillMetadata, type ParsedSkillMetadata } from "./frontmatter.js";
import type { LoadedSkill, SkillCandidate } from "./types.js";

const FRONTMATTER_CHUNK_BYTES = 4096;
const INDEX_CONCURRENCY = 8;
const METADATA_CACHE_LIMIT = 512;
const FRONTMATTER_OPEN = Buffer.from("---");
const FRONTMATTER_CLOSE = Buffer.from("\n---");

interface SkillMetadataCacheEntry {
	fingerprint: string;
	metadata: ParsedSkillMetadata;
}

const skillMetadataCache = new Map<string, SkillMetadataCacheEntry>();

/** 合并框架的提示词技能与斜杠命令发现结果，不扫描额外路径。 */
export function collectSkillCandidates(options: BuildSystemPromptOptions | undefined, commands: SlashCommandInfo[]): SkillCandidate[] {
	const candidates: SkillCandidate[] = [];
	for (const skill of options?.skills ?? []) {
		candidates.push({
			name: skill.name,
			path: skill.filePath,
			description: skill.description,
			scope: skill.sourceInfo.scope,
		});
	}
	for (const command of commands) {
		if (command.source !== "skill") continue;
		const candidate = candidateFromCommand(command);
		if (candidate !== undefined) candidates.push(candidate);
	}
	return firstCandidatePerName(candidates);
}

export function findSkillCandidate(name: string, candidates: SkillCandidate[]): SkillCandidate | undefined {
	return candidates.find((candidate) => candidate.name === name);
}

/** 在宿主侧读取并校验技能文件，返回的正文不含前置元数据。 */
export async function loadSkill(candidate: SkillCandidate): Promise<LoadedSkill> {
	const skillPath = await realpath(candidate.path);
	const raw = await readFile(skillPath, "utf8");
	const parsed = parseSkillFile(raw, candidate.name);
	if (parsed.name !== candidate.name) {
		throw new Error(`skill frontmatter name "${parsed.name}" does not match discovered name "${candidate.name}".`);
	}
	return {
		name: parsed.name,
		description: parsed.description,
		path: skillPath,
		root: path.dirname(skillPath),
		body: parsed.body,
		contentHash: createHash("sha256").update(raw).digest("hex"),
		disableModelInvocation: parsed.disableModelInvocation,
		scope: candidate.scope,
	};
}

/** 只读取 frontmatter 构建模型索引，并以文件身份缓存解析结果。 */
export async function loadModelInvocableSkillIndex(
	options: BuildSystemPromptOptions | undefined,
): Promise<Array<Pick<LoadedSkill, "name" | "description">>> {
	const candidates = collectSkillCandidates(options, []);
	const indexed: Array<Pick<LoadedSkill, "name" | "description"> | undefined> = new Array(candidates.length);
	let nextIndex = 0;
	async function worker(): Promise<void> {
		while (nextIndex < candidates.length) {
			const index = nextIndex++;
			const candidate = candidates[index];
			if (candidate === undefined) continue;
			try {
				const metadata = await loadSkillMetadata(candidate);
				if (!metadata.disableModelInvocation) indexed[index] = { name: metadata.name, description: metadata.description };
			} catch {
				// 单个格式错误或不可读的技能不应阻止模型启动。
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(INDEX_CONCURRENCY, candidates.length) }, worker));
	return indexed.filter((skill): skill is Pick<LoadedSkill, "name" | "description"> => skill !== undefined);
}

async function loadSkillMetadata(candidate: SkillCandidate): Promise<ParsedSkillMetadata> {
	const cacheKey = path.resolve(candidate.path);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const before = await stat(cacheKey, { bigint: true });
		const beforeFingerprint = fileFingerprint(before);
		const cached = skillMetadataCache.get(cacheKey);
		if (cached?.fingerprint === beforeFingerprint) {
			touchMetadataCache(cacheKey, cached);
			return validateCandidateMetadata(candidate, cached.metadata);
		}

		const metadata = parseSkillMetadata(await readFrontmatter(cacheKey), candidate.name);
		const afterFingerprint = fileFingerprint(await stat(cacheKey, { bigint: true }));
		if (beforeFingerprint === afterFingerprint) {
			rememberMetadata(cacheKey, { fingerprint: afterFingerprint, metadata });
			return validateCandidateMetadata(candidate, metadata);
		}
		if (attempt === 1) return validateCandidateMetadata(candidate, metadata);
	}
	throw new Error(`skill metadata could not be read: ${candidate.name}`);
}

async function readFrontmatter(filePath: string): Promise<string> {
	const handle = await open(filePath, "r");
	try {
		let content = Buffer.alloc(0);
		let position = 0;
		while (true) {
			const chunk = Buffer.allocUnsafe(FRONTMATTER_CHUNK_BYTES);
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
			if (bytesRead === 0) return content.toString("utf8");
			position += bytesRead;
			content = Buffer.concat([content, chunk.subarray(0, bytesRead)]);
			if (content.length >= FRONTMATTER_OPEN.length && !content.subarray(0, FRONTMATTER_OPEN.length).equals(FRONTMATTER_OPEN)) {
				return content.toString("utf8");
			}
			const closeIndex = content.indexOf(FRONTMATTER_CLOSE, FRONTMATTER_OPEN.length);
			if (closeIndex >= 0) return content.subarray(0, closeIndex + FRONTMATTER_CLOSE.length).toString("utf8");
		}
	} finally {
		await handle.close();
	}
}

function validateCandidateMetadata(candidate: SkillCandidate, metadata: ParsedSkillMetadata): ParsedSkillMetadata {
	if (metadata.name !== candidate.name) {
		throw new Error(`skill frontmatter name "${metadata.name}" does not match discovered name "${candidate.name}".`);
	}
	return metadata;
}

function fileFingerprint(stats: BigIntStats): string {
	return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

function touchMetadataCache(key: string, entry: SkillMetadataCacheEntry): void {
	skillMetadataCache.delete(key);
	skillMetadataCache.set(key, entry);
}

function rememberMetadata(key: string, entry: SkillMetadataCacheEntry): void {
	touchMetadataCache(key, entry);
	while (skillMetadataCache.size > METADATA_CACHE_LIMIT) {
		const oldest = skillMetadataCache.keys().next().value;
		if (oldest === undefined) break;
		skillMetadataCache.delete(oldest);
	}
}

function candidateFromCommand(command: SlashCommandInfo): SkillCandidate | undefined {
	const filePath = command.sourceInfo.path;
	const rawName = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
	if (rawName.length === 0 || filePath.length === 0) return undefined;
	return {
		name: rawName,
		path: filePath,
		...(command.description !== undefined ? { description: command.description } : {}),
		scope: command.sourceInfo.scope,
	};
}

function firstCandidatePerName(candidates: SkillCandidate[]): SkillCandidate[] {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		if (seen.has(candidate.name)) return false;
		seen.add(candidate.name);
		return true;
	});
}
