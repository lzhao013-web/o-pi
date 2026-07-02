import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PermissionPromptContext, UserPermissionDecision } from "../../src/permissions/permission-types.js";
import { PermissionService } from "../../src/permissions/permission-service.js";

export interface TempEnv {
	workspace: string;
	outside: string;
	agentDir: string;
	cleanup(): Promise<void>;
}

export async function tempEnv(): Promise<TempEnv> {
	const workspace = await mkdtemp(path.join(os.tmpdir(), "o-pi-perm-workspace-"));
	const outside = await mkdtemp(path.join(os.tmpdir(), "o-pi-perm-outside-"));
	const agentDir = await mkdtemp(path.join(os.tmpdir(), "o-pi-perm-agent-"));
	return {
		workspace,
		outside,
		agentDir,
		async cleanup() {
			await rm(workspace, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
			await rm(agentDir, { recursive: true, force: true });
		},
	};
}

export function service(env: TempEnv, extra: Partial<ConstructorParameters<typeof PermissionService>[0]> = {}): PermissionService {
	return new PermissionService({ workspaceRoot: env.workspace, agentDir: env.agentDir, projectTrusted: false, ...extra });
}

export function prompt(decision: UserPermissionDecision["decision"], calls: string[] = []): PermissionPromptContext {
	return {
		hasUI: true,
		timeoutMs: 120000,
		prompt: async (request) => {
			calls.push(request.inputFingerprint);
			return { decision };
		},
	};
}

export function noUi(): PermissionPromptContext {
	return { hasUI: false, timeoutMs: 120000, prompt: async () => ({ decision: "deny" }) };
}
