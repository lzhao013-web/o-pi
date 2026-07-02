import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { FileAccess, FileIdentity, FileNodeType, PermissionOperation, ResolvedFileResource } from "./permission-types.js";
import { maybeWorkspaceRelative, normalizeUserPath, validatePathText } from "./path-utils.js";

export interface FileResolverOptions {
	workspaceRoot: string;
	agentDir: string;
}

export class FileResolveError extends Error {
	constructor(
		readonly code: "INVALID_PATH" | "PATH_NOT_FOUND",
		message: string,
		readonly inputPath: string,
	) {
		super(message);
	}
}

/** 将用户路径解析为 canonical 文件资源；不存在目标固定最近存在父目录 identity。 */
export class FileResolver {
	constructor(private readonly options: FileResolverOptions) {}

	async resolve(inputPath: string, operation: PermissionOperation, access: FileAccess): Promise<ResolvedFileResource> {
		const invalid = validatePathText(inputPath);
		if (invalid !== undefined) throw new FileResolveError("INVALID_PATH", invalid, inputPath);
		const lexicalAbsolutePath = normalizeUserPath(this.options.workspaceRoot, inputPath, this.options.agentDir);
		let lexicalStat;
		try {
			lexicalStat = await lstat(lexicalAbsolutePath);
		} catch (error) {
			if (isNotFound(error)) return await this.resolveMissing(inputPath, lexicalAbsolutePath, operation, access);
			throw error;
		}

		const canonicalPath = await realpath(lexicalAbsolutePath);
		const targetStat = await stat(canonicalPath);
		const lexicalType = nodeType(lexicalStat);
		const targetType = targetNodeType(targetStat);
		const viaSymlink = path.resolve(lexicalAbsolutePath) !== path.resolve(canonicalPath) || lexicalType === "symlink";
		const displayPath = maybeWorkspaceRelative(this.options.workspaceRoot, canonicalPath, true) ?? canonicalPath;
		return {
			kind: "file",
			inputPath,
			lexicalAbsolutePath,
			canonicalPath,
			lexicalType,
			targetType,
			exists: true,
			viaSymlink,
			symlinkChain: viaSymlink ? [lexicalAbsolutePath, canonicalPath] : [],
			identity: identityFromStat(targetStat),
			displayPath,
			access,
			operation,
		};
	}

	private async resolveMissing(
		inputPath: string,
		lexicalAbsolutePath: string,
		operation: PermissionOperation,
		access: FileAccess,
	): Promise<ResolvedFileResource> {
		const parent = await nearestExistingParent(lexicalAbsolutePath, inputPath);
		const parentCanonical = await realpath(parent.existingPath);
		const parentStat = await stat(parentCanonical);
		if (!parentStat.isDirectory()) throw new FileResolveError("INVALID_PATH", "Nearest existing parent is not a directory.", inputPath);
		const canonicalPath = path.join(parentCanonical, ...parent.missingSegments);
		const displayPath = maybeWorkspaceRelative(this.options.workspaceRoot, canonicalPath, false) ?? canonicalPath;
		const viaSymlink = path.resolve(path.dirname(lexicalAbsolutePath)) !== path.resolve(path.dirname(canonicalPath));
		return {
			kind: "file",
			inputPath,
			lexicalAbsolutePath,
			canonicalPath,
			lexicalType: "other",
			targetType: "other",
			exists: false,
			viaSymlink,
			symlinkChain: viaSymlink ? [path.dirname(lexicalAbsolutePath), path.dirname(canonicalPath)] : [],
			canonicalParentPath: parentCanonical,
			canonicalParentIdentity: identityFromStat(parentStat),
			displayPath,
			access,
			operation,
		};
	}
}

export function identityFromStat(info: { dev?: number; ino?: number }): FileIdentity {
	const identity: FileIdentity = {};
	if (typeof info.dev === "number") identity.device = info.dev;
	if (typeof info.ino === "number") identity.inode = info.ino;
	return identity;
}

async function nearestExistingParent(absolutePath: string, inputPath: string): Promise<{ existingPath: string; missingSegments: string[] }> {
	const missingSegments: string[] = [];
	let current = path.resolve(absolutePath);
	for (;;) {
		try {
			await lstat(current);
			return { existingPath: current, missingSegments };
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) throw new FileResolveError("PATH_NOT_FOUND", "No existing parent directory found.", inputPath);
		missingSegments.unshift(path.basename(current));
		current = parent;
	}
}

function nodeType(info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileNodeType {
	if (info.isSymbolicLink()) return "symlink";
	if (info.isDirectory()) return "directory";
	if (info.isFile()) return "file";
	return "other";
}

function targetNodeType(info: { isFile(): boolean; isDirectory(): boolean }): Exclude<FileNodeType, "symlink"> {
	if (info.isDirectory()) return "directory";
	if (info.isFile()) return "file";
	return "other";
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
