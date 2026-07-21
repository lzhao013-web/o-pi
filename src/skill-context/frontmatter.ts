import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface ParsedSkillMetadata {
	name: string;
	description: string;
	disableModelInvocation: boolean;
}

export interface ParsedSkillFile extends ParsedSkillMetadata {
	body: string;
}

export class SkillFrontmatterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillFrontmatterError";
	}
}

export function parseSkillFile(raw: string, fallbackName: string): ParsedSkillFile {
	const { frontmatter, body } = parseSkillFrontmatter(raw);
	return { ...parseSkillMetadataFields(frontmatter, fallbackName), body };
}

export function parseSkillMetadata(raw: string, fallbackName: string): ParsedSkillMetadata {
	const { frontmatter } = parseSkillFrontmatter(raw);
	return parseSkillMetadataFields(frontmatter, fallbackName);
}

function parseSkillMetadataFields(frontmatter: Record<string, unknown>, fallbackName: string): ParsedSkillMetadata {
	const name = stringField(frontmatter, "name") ?? fallbackName;
	const description = stringField(frontmatter, "description");

	validateSkillName(name);
	if (description === undefined || description.trim().length === 0) {
		throw new SkillFrontmatterError("skill description is required.");
	}
	if (description.length > 1024) throw new SkillFrontmatterError("skill description must be 1-1024 characters.");
	return {
		name,
		description,
		// 只有显式布尔值 false 才开放模型加载，缺失或类型错误时保持禁用。
		disableModelInvocation: frontmatter["disable-model-invocation"] !== false,
	};
}

function parseSkillFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
	try {
		const parsed = parseFrontmatter(raw);
		return { frontmatter: parsed.frontmatter, body: parsed.body.trim() };
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid frontmatter";
		throw new SkillFrontmatterError(`failed to parse skill frontmatter: ${message}`);
	}
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
	const value = fields[key];
	return typeof value === "string" ? value : undefined;
}

export function isValidSkillName(name: string): boolean {
	return name.length >= 1
		&& name.length <= 64
		&& /^[a-z0-9-]+$/.test(name)
		&& !name.startsWith("-")
		&& !name.endsWith("-")
		&& !name.includes("--");
}

function validateSkillName(name: string): void {
	if (!isValidSkillName(name)) {
		throw new SkillFrontmatterError("skill name must be 1-64 lowercase alphanumeric/hyphen characters without edge or repeated hyphens.");
	}
}
