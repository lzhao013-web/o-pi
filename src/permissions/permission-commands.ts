import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { defaultPermissionConfig, formatDiagnostics, loadPolicy, permissionsSchema } from "./policy.js";
import type { PermissionPromptContext, PermissionProfile } from "./permission-types.js";
import type { PermissionService } from "./permission-service.js";

export type PermissionCommandContext = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "ui" | "signal" | "sessionManager" | "isProjectTrusted">;

/** 注册 /permissions 命令；策略写入必须经过解析、校验和编译。 */
export function registerPermissionCommands(api: ExtensionAPI, getService: (ctx: PermissionCommandContext) => Promise<PermissionService>): void {
	api.registerCommand("permissions", {
		description: "Manage permissions",
		handler: async (args, ctx) => {
			const service = await getService(ctx);
			const argv = splitArgs(args);
			const command = argv[0] ?? "status";
			if (command === "status" || command === "") return report(ctx, await statusLines(service));
			if (command === "catalog") return report(ctx, catalogLines(service));
			if (command === "grants") return report(ctx, service.getSessionGrants().list().map((grant) => `${grant.id} ${grant.scope} ${grant.subjectId}`));
			if (command === "revoke" && argv[1] !== undefined) return report(ctx, [service.getSessionGrants().revoke(argv[1]) ? `revoked ${argv[1]}` : `not found ${argv[1]}`]);
			if (command === "revoke-all") {
				service.getSessionGrants().clear();
				await service.getPersistentGrants().revokeAll();
				return report(ctx, ["all grants revoked"]);
			}
			if (command === "reload" || command === "validate") return report(ctx, await validateLines(service));
			if (command === "profile" && isProfile(argv[1])) {
				service.setProfile(argv[1]);
				ctx.ui.setStatus("permissions", `PERM: ${argv[1].toUpperCase()}`);
				return report(ctx, [`session profile: ${argv[1]}`]);
			}
			if (command === "maintenance") {
				service.setMaintenance(true);
				return report(ctx, ["maintenance mode enabled"]);
			}
			if (command === "audit") return report(ctx, await service.auditTail(20));
			if (command === "edit") return await editPolicy(ctx, service, argv[1] === "project");
			if (command === "explain" && argv[1] !== undefined) {
				const pathArg = argv[2] ?? ".";
				const decision = await service.explain(argv[1], { path: pathArg });
				return report(ctx, [
					`Subject: ${argv[1]}`,
					`Decision: ${decision.finalEffect}`,
					...decision.trace.map((entry, index) => `${index + 1}. ${entry.source} ${entry.effect} -> ${entry.message}`),
				]);
			}
			return report(ctx, [
				"commands: status, catalog, explain <subject> [path], grants, revoke <id>, revoke-all, reload, validate, edit [project], profile <cautious|standard|read-only|unrestricted>, maintenance, audit",
			]);
		},
	});
}

export function promptContextFromUi(ctx: PermissionCommandContext, timeoutMs: number): PermissionPromptContext {
	return {
		hasUI: ctx.hasUI,
		timeoutMs,
		...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
		prompt: async (request, decision) => {
			const options = ctx.signal === undefined ? { timeout: timeoutMs } : { timeout: timeoutMs, signal: ctx.signal };
			const choice = await ctx.ui.select(
				`Permission ${decision.finalEffect}: ${request.subject.configKey}`,
				["Allow once", "Allow exact for session", "Allow subtree for session", "Always allow", "Deny"],
				options,
			);
			if (choice === "Allow once") return { decision: "allow-once" };
			if (choice === "Allow exact for session") return { decision: "allow-session-exact" };
			if (choice === "Allow subtree for session") return { decision: "allow-session-subtree" };
			if (choice === "Always allow") return { decision: "always-allow" };
			return { decision: "deny" };
		},
	};
}

async function statusLines(service: PermissionService): Promise<string[]> {
	const status = await service.status();
	return [
		`profile: ${status.profile}`,
		`global: ${status.globalPolicy.status} ${status.globalPolicy.path}`,
		`project: ${status.projectPolicy.status} ${status.projectPolicy.path}`,
		`projectTrusted: ${status.projectTrusted}`,
		`policyGeneration: ${status.policyGeneration}`,
		`registryGeneration: ${status.registryGeneration}`,
		`sessionGrants: ${status.sessionGrantCount}`,
		`persistentGrants: ${status.persistentGrantCount}`,
		`maintenance: ${status.maintenance}`,
		`audit: ${status.auditEnabled}`,
		...status.recentErrors.map((error) => `error: ${error}`),
	];
}

function catalogLines(service: PermissionService): string[] {
	const entries = service.getRegistry().catalog();
	return entries.length === 0
		? ["catalog empty"]
		: entries.map((entry) => `${entry.kind} ${entry.qualifiedConfigKey} ${entry.displayName} ${entry.source.type}:${entry.source.name}${entry.conflict ? " conflict" : ""}`);
}

async function validateLines(service: PermissionService): Promise<string[]> {
	const status = await service.status();
	const diagnostics = [...status.globalPolicy.diagnostics, ...status.projectPolicy.diagnostics];
	return diagnostics.length === 0 ? ["validate: ok"] : [formatDiagnostics(diagnostics)];
}

async function editPolicy(ctx: PermissionCommandContext, service: PermissionService, project: boolean): Promise<void> {
	const status = await service.status();
	const filePath = project ? status.projectPolicy.path : status.globalPolicy.path;
	let current = "";
	try {
		current = await readFile(filePath, "utf8");
	} catch {
		current = project ? "{\n\t\"version\": 1\n}\n" : `${JSON.stringify(defaultPermissionConfig(), null, "\t")}\n`;
	}
	const edited = await ctx.ui.editor(project ? "permissions project" : "permissions", current);
	if (edited === undefined) return;
	await mkdir(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.${process.pid}.edit.tmp`;
	await writeFile(temp, edited, "utf8");
	const loaded = await loadPolicy(project ? "project" : "global", temp);
	if (loaded.status === "invalid" || loaded.status === "load_failed") {
		ctx.ui.notify(formatDiagnostics(loaded.diagnostics), "error");
		return;
	}
	await rename(temp, filePath);
	await writeFile(path.join(path.dirname(status.globalPolicy.path), "permissions.schema.json"), `${JSON.stringify(permissionsSchema, null, "\t")}\n`, "utf8").catch(() => undefined);
	const lines = await validateLines(service);
	ctx.ui.notify(lines.join("\n"), lines[0] === "validate: ok" ? "info" : "error");
}

function report(ctx: PermissionCommandContext, lines: string[]): void {
	ctx.ui.notify(lines.length === 0 ? "(empty)" : lines.join("\n").slice(0, 3000), "info");
}

function splitArgs(input: string): string[] {
	return input.match(/"([^"]*)"|'([^']*)'|\S+/g)?.map((item) => item.replace(/^["']|["']$/g, "")) ?? [];
}

function isProfile(value: string | undefined): value is PermissionProfile {
	return value === "cautious" || value === "standard" || value === "read-only" || value === "unrestricted";
}
