import path from "node:path";

import type { PermissionResource } from "./permission-types.js";
import { isPathInside, normalizeUserPath } from "./path-utils.js";

export interface HardProtectionContext {
	workspaceRoot: string;
	agentDir: string;
	homeDir: string;
}

export interface HardProtectionResult {
	denied: boolean;
	reason?: string;
	ruleId?: string;
}

/** 内建硬保护不可被 profile、策略、grant 或普通审批覆盖。 */
export function evaluateHardProtections(resources: PermissionResource[], context: HardProtectionContext): HardProtectionResult {
	const protectedPaths = hardProtectedPaths(context);
	for (const resource of resources) {
		if (resource.kind !== "file") continue;
		for (const protectedPath of protectedPaths) {
			if (
				isPathInside(protectedPath.path, resource.lexicalAbsolutePath) ||
				isPathInside(protectedPath.path, resource.canonicalPath) ||
				resource.symlinkChain.some((item) => isPathInside(protectedPath.path, item))
			) {
				return { denied: true, reason: protectedPath.reason, ruleId: protectedPath.id };
			}
		}
	}
	return { denied: false };
}

function hardProtectedPaths(context: HardProtectionContext): Array<{ id: string; path: string; reason: string }> {
	const agentDir = path.resolve(context.agentDir);
	return [
		{ id: "credentials-ssh", path: normalizeUserPath(context.workspaceRoot, "~/.ssh", context.agentDir), reason: "SSH credentials are protected." },
		{ id: "credentials-gnupg", path: normalizeUserPath(context.workspaceRoot, "~/.gnupg", context.agentDir), reason: "GnuPG credentials are protected." },
		{ id: "pi-auth", path: path.join(agentDir, "auth.json"), reason: "Pi authentication state is protected." },
		{ id: "pi-trust", path: path.join(agentDir, "trust.json"), reason: "Pi trust state is protected." },
		{ id: "permission-config", path: path.join(agentDir, "permissions.jsonc"), reason: "Permission policy must be edited through /permissions edit." },
		{ id: "permission-schema", path: path.join(agentDir, "permissions.schema.json"), reason: "Permission schema is managed by the extension." },
		{ id: "permission-state", path: path.join(agentDir, "permission-state"), reason: "Permission state and audit logs are protected." },
		{ id: "permission-code", path: path.join(agentDir, "extensions", "permissions.ts"), reason: "Permission extension code is protected." },
	];
}
