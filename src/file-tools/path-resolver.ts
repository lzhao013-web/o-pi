import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { fail } from "./errors.js";
import type { FailedResult, ResolvedPath, TargetPath, ToolOutcome } from "./types.js";

/** 返回真实 workspace 根目录，后续路径判断都基于该 canonical root。 */
export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
	return await realpath(cwd);
}

/** 解析已存在目录；拒绝 workspace 外路径和指向 workspace 外的符号链接。 */
export async function resolveExistingDirectory(workspaceRoot: string, inputPath: string): Promise<ToolOutcome<ResolvedPath>> {
	const lexical = normalizeWorkspacePath(workspaceRoot, inputPath);
	if (isFailed(lexical)) return lexical;
	if (isWorkspaceMetadataPath(lexical.relativePath)) {
		return fail("PROTECTED_PATH", "Workspace metadata cannot be listed.", { path: lexical.relativePath });
	}
	const resolved = await resolveExistingWorkspacePath(workspaceRoot, inputPath, "PATH_NOT_FOUND");
	if (isFailed(resolved)) return resolved;
	const info = await stat(resolved.realPath);
	if (!info.isDirectory()) return fail("NOT_A_DIRECTORY", "Path is not a directory.", { path: resolved.relativePath });
	return resolved;
}

/** 解析已存在普通文件；拒绝 workspace 外路径和指向 workspace 外的符号链接。 */
export async function resolveExistingFile(workspaceRoot: string, inputPath: string): Promise<ToolOutcome<ResolvedPath>> {
	const lexical = normalizeWorkspacePath(workspaceRoot, inputPath);
	if (isFailed(lexical)) return lexical;
	if (isWorkspaceMetadataPath(lexical.relativePath)) {
		return fail("PROTECTED_PATH", "Workspace metadata cannot be read.", { path: lexical.relativePath });
	}
	const resolved = await resolveExistingWorkspacePath(workspaceRoot, inputPath, "FILE_NOT_FOUND");
	if (isFailed(resolved)) return resolved;
	const info = await stat(resolved.realPath);
	if (!info.isFile()) return fail("NOT_A_FILE", "Path is not a regular file.", { path: resolved.relativePath });
	return resolved;
}

/** 解析可创建或替换的目标文件；不存在目标通过最近存在父目录约束在 workspace 内。 */
export async function resolveTargetFile(workspaceRoot: string, inputPath: string): Promise<ToolOutcome<TargetPath>> {
	const lexical = normalizeWorkspacePath(workspaceRoot, inputPath);
	if (isFailed(lexical)) return lexical;
	if (lexical.relativePath === ".") return fail("INVALID_PATH", "Target must be a file path, not the workspace root.", { path: inputPath });
	if (isWorkspaceMetadataPath(lexical.relativePath)) {
		return fail("PROTECTED_PATH", "Workspace metadata cannot be modified.", { path: lexical.relativePath });
	}

	const parent = await resolveExistingParent(workspaceRoot, lexical.absolutePath);
	if (isFailed(parent)) return parent;
	const parentInfo = await stat(parent.parentRealPath);
	if (!parentInfo.isDirectory()) return fail("INVALID_PATH", "Parent path is not a directory.", { path: lexical.relativePath });

	return {
		inputPath,
		relativePath: lexical.relativePath,
		absolutePath: lexical.absolutePath,
		parentRealPath: parent.parentRealPath,
	};
}

export async function fileExists(absolutePath: string): Promise<boolean> {
	try {
		const result = await lstat(absolutePath);
		return result.isFile() || result.isSymbolicLink();
	} catch {
		return false;
	}
}

/** `.git` 是工具内部元数据边界：隐藏、拒读、拒写，但不属于授权系统。 */
export function isWorkspaceMetadataPath(relativePath: string): boolean {
	return relativePath.split("/").some((segment) => segment === ".git");
}

async function resolveExistingWorkspacePath(
	workspaceRoot: string,
	inputPath: string,
	missingCode: "FILE_NOT_FOUND" | "PATH_NOT_FOUND",
): Promise<ToolOutcome<ResolvedPath>> {
	const lexical = normalizeWorkspacePath(workspaceRoot, inputPath);
	if (isFailed(lexical)) return lexical;
	let real: string;
	try {
		real = await realpath(lexical.absolutePath);
	} catch (error) {
		if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Path cannot be accessed.", { path: lexical.relativePath });
		return fail(missingCode, missingCode === "FILE_NOT_FOUND" ? "File does not exist." : "Directory does not exist.", {
			path: lexical.relativePath,
		});
	}
	const realRelative = workspaceRelative(workspaceRoot, real);
	if (realRelative === undefined) return fail("SYMLINK_OUTSIDE_WORKSPACE", "Path resolves outside the workspace.", { path: lexical.relativePath });
	return {
		inputPath,
		relativePath: lexical.relativePath,
		absolutePath: lexical.absolutePath,
		realPath: real,
	};
}

function normalizeWorkspacePath(workspaceRoot: string, inputPath: string): ToolOutcome<{ absolutePath: string; relativePath: string }> {
	if (inputPath.length === 0) return fail("INVALID_PATH", "Path must not be empty.", { path: inputPath });
	if (inputPath.includes("\0")) return fail("INVALID_PATH", "Path must not contain NUL bytes.", { path: inputPath });
	if (/^[A-Za-z]:(?![\\/])/.test(inputPath)) return fail("INVALID_PATH", "Drive-relative paths are not supported.", { path: inputPath });
	if (/[*?[\]{}]/.test(inputPath)) return fail("INVALID_PATH", "Glob patterns are not supported.", { path: inputPath });

	const absolutePath = path.resolve(workspaceRoot, inputPath);
	const relativePath = workspaceRelative(workspaceRoot, absolutePath);
	if (relativePath === undefined) return fail("PATH_OUTSIDE_WORKSPACE", "Path must stay inside the workspace.", { path: inputPath });
	return { absolutePath, relativePath };
}

async function resolveExistingParent(
	workspaceRoot: string,
	absolutePath: string,
): Promise<ToolOutcome<{ parentRealPath: string }>> {
	let current = path.dirname(absolutePath);
	while (true) {
		const relative = workspaceRelative(workspaceRoot, current);
		if (relative === undefined) return fail("PATH_OUTSIDE_WORKSPACE", "Parent path must stay inside the workspace.");
		try {
			const info = await lstat(current);
			if (!info.isDirectory() && !info.isSymbolicLink()) return fail("INVALID_PATH", "Parent path is not a directory.", { path: relative });
			const parentRealPath = await realpath(current);
			if (workspaceRelative(workspaceRoot, parentRealPath) === undefined) {
				return fail("SYMLINK_OUTSIDE_WORKSPACE", "Parent path resolves outside the workspace.", { path: relative });
			}
			return { parentRealPath };
		} catch (error) {
			if (isAccessDenied(error)) return fail("ACCESS_DENIED", "Parent path cannot be accessed.", { path: relative });
			const next = path.dirname(current);
			if (next === current) return fail("PATH_NOT_FOUND", "Parent directory does not exist.");
			current = next;
		}
	}
}

function workspaceRelative(workspaceRoot: string, candidate: string): string | undefined {
	const relative = path.relative(workspaceRoot, candidate);
	if (relative === "") return ".";
	if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative.replace(/\\/g, "/");
}

function isFailed<T>(result: T | FailedResult): result is FailedResult {
	return typeof result === "object" && result !== null && "status" in result && result.status === "failed";
}

function isAccessDenied(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}
