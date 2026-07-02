import { fail } from "./errors.js";
import os from "node:os";
import path from "node:path";
import type { FailedResult, FileToolErrorCode } from "./types.js";
import type { PermissionPromptContext } from "../permissions/permission-types.js";
import { PermissionService } from "../permissions/permission-service.js";
import { FileResolveError } from "../permissions/file-resolver.js";

export interface FileToolPermissionRuntime {
	permissionService?: PermissionService;
	toolCallId?: string;
	promptContext?: PermissionPromptContext;
}

export function defaultPermissionService(workspaceRoot: string): PermissionService {
	return new PermissionService({ workspaceRoot, agentDir: path.join(os.tmpdir(), "o-pi-agent"), projectTrusted: false });
}

export function defaultPromptContext(): PermissionPromptContext {
	return {
		hasUI: false,
		timeoutMs: 120000,
		prompt: async () => ({ decision: "deny" }),
	};
}

export function permissionFailure(result: {
	code: FileToolErrorCode | string;
	message: string;
	resources: Array<{ action: string; path: string }>;
}): FailedResult {
	const code = result.code === "PERMISSION_ANALYSIS_FAILED" ? "INVALID_PATH" : result.code;
	return fail(code as FileToolErrorCode, result.message, {
		details: {
			resources: result.resources,
			retry: "Do not retry the identical request unless the user changes policy or selects another path.",
		},
	});
}

export function pathResolveFailure(error: unknown): FailedResult | undefined {
	if (error instanceof FileResolveError) {
		return fail(error.code === "PATH_NOT_FOUND" ? "PATH_NOT_FOUND" : "INVALID_PATH", error.message, { path: error.inputPath });
	}
	if (typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM")) {
		return fail("PERMISSION_DENIED", "Path cannot be accessed.");
	}
	return undefined;
}
