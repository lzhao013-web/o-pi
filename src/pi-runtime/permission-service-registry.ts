import { getAgentDir } from "@earendil-works/pi-coding-agent";
import path from "node:path";

import { resolveWorkspaceRoot } from "../file-tools/path-security.js";
import { PermissionService } from "../permissions/permission-service.js";

/** Pi 事件和工具执行上下文中创建权限服务所需的最小字段。 */
export interface PermissionServiceRuntimeContext {
	cwd: string;
	isProjectTrusted(): boolean;
	sessionManager?: { getSessionFile(): string | undefined };
	ui?: {
		setStatus(key: string, text: string | undefined): void;
	};
}

/** Pi 扩展运行时共享的权限 runtime；按 workspace、session 与信任状态隔离。 */
export class PermissionServiceRegistry {
	private readonly services = new Map<string, PermissionService>();

	async serviceFor(ctx: PermissionServiceRuntimeContext): Promise<PermissionService> {
		const workspaceRoot = await resolveWorkspaceRoot(ctx.cwd);
		const agentDir = getAgentDir();
		const sessionId = ctx.sessionManager?.getSessionFile() ?? "ephemeral";
		const key = `${workspaceRoot}:${sessionId}:${ctx.isProjectTrusted() ? "trusted" : "untrusted"}`;
		const existing = this.services.get(key);
		if (existing !== undefined) return existing;
		const service = new PermissionService({
			workspaceRoot,
			agentDir,
			globalPolicyPath: path.join(agentDir, "permissions.jsonc"),
			projectPolicyPath: path.join(workspaceRoot, ".pi", "permissions.jsonc"),
			projectTrusted: ctx.isProjectTrusted(),
			auditLogPath: path.join(agentDir, "permission-state", "audit.jsonl"),
			persistentGrantPath: path.join(agentDir, "permission-state", "grants.json"),
			sessionId,
		});
		this.services.set(key, service);
		const status = await service.status();
		ctx.ui?.setStatus("permissions", `PERM: ${status.profile.toUpperCase()}`);
		return service;
	}

	clear(reason: string): void {
		void reason;
		for (const service of this.services.values()) service.cancelAll();
		this.services.clear();
	}
}

const registry = new PermissionServiceRegistry();

/** 返回当前扩展运行时的共享权限服务注册表。 */
export function getPermissionServiceRegistry(): PermissionServiceRegistry {
	return registry;
}
