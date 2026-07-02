import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { ApprovalCoordinator } from "./approval.js";
import { AuditLogger, sanitizeResource } from "./audit.js";
import { builtinFileToolDescriptors, genericToolDescriptor } from "./file-tool-descriptors.js";
import { FileResolver } from "./file-resolver.js";
import { evaluateHardProtections } from "./hard-protections.js";
import { LeaseStore, PersistentGrantStore, resourcesUnchanged, SessionGrantStore } from "./grants.js";
import { evaluatePolicy, PolicyStore } from "./policy.js";
import { PermissionSubjectRegistry } from "./subject-registry.js";
import type {
	AuthorizationRequest,
	AuthorizationResult,
	CompiledDecision,
	PermissionErrorCode,
	PermissionPromptContext,
	PermissionResource,
	PermissionServiceStatus,
	PermissionSubjectDescriptor,
	PolicySnapshot,
} from "./permission-types.js";

export interface PermissionServiceOptions {
	workspaceRoot: string;
	agentDir: string;
	projectTrusted: boolean;
	globalPolicyPath?: string;
	projectPolicyPath?: string;
	auditLogPath?: string;
	persistentGrantPath?: string;
	sessionId?: string;
}

export interface AuthorizeInput {
	toolCallId: string;
	toolName: string;
	normalizedToolInput: unknown;
	promptContext: PermissionPromptContext;
	consumeLease?: boolean;
}

/** 单一授权入口：策略、hard protection、grant、UI、lease 和审计都在这里完成。 */
export class PermissionService {
	private readonly registry = new PermissionSubjectRegistry();
	private readonly policies: PolicyStore;
	private readonly leases = new LeaseStore();
	private readonly sessionGrants = new SessionGrantStore();
	private readonly persistentGrants: PersistentGrantStore;
	private readonly approval = new ApprovalCoordinator();
	private readonly audit: AuditLogger;
	private readonly recentErrors: string[] = [];
	private profileOverride: PolicySnapshot["profile"] | undefined;
	private maintenance = false;

	constructor(private readonly options: PermissionServiceOptions) {
		for (const descriptor of builtinFileToolDescriptors()) this.registry.register(descriptor);
		this.policies = new PolicyStore(options);
		this.persistentGrants = new PersistentGrantStore(options.persistentGrantPath ?? path.join(options.agentDir, "permission-state", "grants.json"));
		this.audit = new AuditLogger({
			path: options.auditLogPath ?? path.join(options.agentDir, "permission-state", "audit.jsonl"),
			enabled: true,
		});
	}

	get fileResolver(): FileResolver {
		return new FileResolver({ workspaceRoot: this.options.workspaceRoot, agentDir: this.options.agentDir });
	}

	registerSubject(descriptor: PermissionSubjectDescriptor): void {
		this.registry.register(descriptor);
	}

	getRegistry(): PermissionSubjectRegistry {
		return this.registry;
	}

	getSessionGrants(): SessionGrantStore {
		return this.sessionGrants;
	}

	getPersistentGrants(): PersistentGrantStore {
		return this.persistentGrants;
	}

	async status(): Promise<PermissionServiceStatus> {
		const snapshot = await this.snapshot();
		await this.persistentGrants.load();
		return {
			profile: snapshot.profile,
			globalPolicy: snapshot.global,
			projectPolicy: snapshot.project,
			projectTrusted: this.options.projectTrusted,
			policyGeneration: snapshot.generation,
			registryGeneration: this.registry.generation,
			sessionGrantCount: this.sessionGrants.count(),
			persistentGrantCount: this.persistentGrants.count(),
			maintenance: this.maintenance,
			auditEnabled: this.audit.isEnabled(),
			recentErrors: [...this.recentErrors],
		};
	}

	setProfile(profile: PolicySnapshot["profile"]): void {
		this.profileOverride = profile;
	}

	setMaintenance(enabled: boolean): void {
		this.maintenance = enabled;
	}

	async authorizeToolCall(input: AuthorizeInput): Promise<AuthorizationResult> {
		return await this.authorize(input);
	}

	async authorize(input: AuthorizeInput): Promise<AuthorizationResult> {
		const snapshot = await this.snapshot();
		const subject = this.registry.resolve("tool", input.toolName) ?? genericToolDescriptor(input.toolName);
		if (this.registry.getById(subject.id) === undefined) this.registry.register(subject);
		let request: AuthorizationRequest | undefined;
		try {
			const analysisContext = {
				workspaceRoot: this.options.workspaceRoot,
				agentDir: this.options.agentDir,
				...(input.promptContext.signal !== undefined ? { signal: input.promptContext.signal } : {}),
			};
			const intent = await subject.analyze(input.normalizedToolInput, analysisContext);
			request = {
				requestId: `perm_${randomUUID()}`,
				toolCallId: input.toolCallId,
				subject,
				inputFingerprint: stableFingerprint({ toolName: input.toolName, input: input.normalizedToolInput, policyGeneration: snapshot.generation, resources: intent.resources }),
				operations: intent.operations,
				resources: intent.resources,
				summary: intent.summary,
				policyGeneration: snapshot.generation,
			};
			if (intent.details !== undefined) request.details = intent.details;
		} catch (error) {
			await this.auditFailureForUnknown(input, snapshot, "PERMISSION_ANALYSIS_FAILED");
			return this.denied("PERMISSION_ANALYSIS_FAILED", error instanceof Error ? error.message : String(error));
		}
		if (request === undefined) return this.denied("PERMISSION_INTERNAL_ERROR", "Permission request was not created.");

		const existingLease = this.leases.find(request);
		if (existingLease !== undefined) {
			if (input.consumeLease) this.leases.consume(existingLease);
			const decision = allowDecision("session-grant", "Matched authorization lease.", [existingLease.id]);
			await this.auditDecision(request, decision, "allowed", existingLease.id);
			return { allowed: true, lease: existingLease, decision, request };
		}

		const hard = evaluateHardProtections(request.resources, {
			workspaceRoot: this.options.workspaceRoot,
			agentDir: this.options.agentDir,
			homeDir: os.homedir(),
		});
		if (hard.denied) {
			const decision = denyDecision("hard-protection", hard.reason ?? "Resource is protected.", hard.ruleId);
			await this.auditDecision(request, decision, "denied", undefined, "PERMISSION_HARD_DENIED");
			return this.denied("PERMISSION_HARD_DENIED", `Permission denied for ${input.toolName}: ${hard.reason ?? "protected resource"}.`, request, decision);
		}

		let decision = evaluatePolicy({ snapshot, subject, resources: request.resources, operations: request.operations });
		if (decision.finalEffect === "deny") {
			await this.auditDecision(request, decision, "denied", undefined, decision.effect === "policy-error" ? "PERMISSION_POLICY_INVALID" : "PERMISSION_DENIED");
			return this.denied(decision.effect === "policy-error" ? "PERMISSION_POLICY_INVALID" : "PERMISSION_DENIED", decision.trace.at(-1)?.message ?? "Permission denied.", request, decision);
		}

		await this.persistentGrants.load();
		if (decision.finalEffect === "ask") {
			const persistent = this.persistentGrants.find(request);
			if (persistent.length > 0) decision = allowDecision("persistent-grant", "Matched persistent grant.", persistent.map((grant) => grant.id));
		}
		if (decision.finalEffect === "ask") {
			const session = this.sessionGrants.find(request);
			if (session.length > 0) decision = allowDecision("session-grant", "Matched session grant.", session.map((grant) => grant.id));
		}
		if (decision.finalEffect === "allow") {
			const lease = this.leases.add(request);
			if (input.consumeLease) this.leases.consume(lease);
			await this.auditDecision(request, decision, "allowed", lease.id);
			return { allowed: true, lease, decision, request };
		}
		if (!input.promptContext.hasUI) {
			const noUi = denyDecision("no-ui", "Permission prompt is unavailable; ask defaults to deny.");
			await this.auditDecision(request, noUi, "denied", undefined, "PERMISSION_PROMPT_UNAVAILABLE");
			return this.denied("PERMISSION_PROMPT_UNAVAILABLE", "Permission prompt is unavailable; ask defaults to deny.", request, noUi);
		}
		const approval = await this.approval.request(request, decision, input.promptContext);
		if (!approval.ok) {
			const code = approval.reason === "timeout" ? "PERMISSION_PROMPT_TIMEOUT" : approval.reason === "cancelled" ? "PERMISSION_PROMPT_CANCELLED" : "PERMISSION_INTERNAL_ERROR";
			const denied = denyDecision(approval.reason === "timeout" ? "no-ui" : "user", `Permission prompt ${approval.reason}.`);
			await this.auditDecision(request, denied, "denied", undefined, code);
			return this.denied(code, `Permission prompt ${approval.reason}.`, request, denied);
		}
		if (approval.decision.decision === "deny") {
			const denied = denyDecision("user", "User denied this operation.");
			await this.auditDecision(request, denied, "denied", undefined, "PERMISSION_DENIED");
			return this.denied("PERMISSION_DENIED", "The user denied this operation. Do not retry the identical request.", request, denied);
		}
		if (approval.decision.decision === "allow-session-exact") this.sessionGrants.add(request, "exact");
		if (approval.decision.decision === "allow-session-subtree") this.sessionGrants.add(request, "subtree");
		if (approval.decision.decision === "always-allow") await this.persistentGrants.add(request, "subtree");
		const lease = this.leases.add(request);
		if (input.consumeLease) this.leases.consume(lease);
		const userDecision = allowDecision("user", `User decision: ${approval.decision.decision}.`, [lease.id]);
		await this.auditDecision(request, userDecision, "allowed", lease.id);
		return { allowed: true, lease, decision: userDecision, request };
	}

	async verifyRequestUnchanged(original: AuthorizationRequest, input: { toolName: string; normalizedToolInput: unknown }): Promise<boolean> {
		const subject = this.registry.resolve("tool", input.toolName);
		if (subject === undefined) return false;
		const intent = await subject.analyze(input.normalizedToolInput, { workspaceRoot: this.options.workspaceRoot, agentDir: this.options.agentDir });
		return resourcesUnchanged(original.resources, intent.resources);
	}

	async explain(toolName: string, normalizedToolInput: unknown): Promise<CompiledDecision> {
		const snapshot = await this.snapshot();
		const subject = this.registry.resolve("tool", toolName) ?? genericToolDescriptor(toolName);
		const intent = await subject.analyze(normalizedToolInput, { workspaceRoot: this.options.workspaceRoot, agentDir: this.options.agentDir });
		return evaluatePolicy({ snapshot, subject, resources: intent.resources, operations: intent.operations });
	}

	cancelAll(): void {
		this.approval.cancelAll();
		this.leases.clear();
		this.sessionGrants.clear();
	}

	async auditTail(limit: number): Promise<string[]> {
		return await this.audit.tail(limit);
	}

	private async snapshot(): Promise<PolicySnapshot> {
		const snapshot = await this.policies.snapshot();
		if (this.profileOverride !== undefined) snapshot.profile = this.profileOverride;
		this.audit.setEnabled(snapshot.auditEnabled);
		return snapshot;
	}

	private denied(code: PermissionErrorCode, message: string, request?: AuthorizationRequest, decision?: CompiledDecision): AuthorizationResult {
		this.noteError(`${code}: ${message}`);
		return {
			allowed: false,
			error: { code, message, retry: code === "PERMISSION_DENIED" ? "after-policy-change" : "never" },
			...(request !== undefined ? { request } : {}),
			...(decision !== undefined ? { decision } : {}),
		};
	}

	private noteError(message: string): void {
		this.recentErrors.push(message);
		while (this.recentErrors.length > 5) this.recentErrors.shift();
	}

	private async auditDecision(
		request: AuthorizationRequest,
		decision: CompiledDecision,
		finalDecision: "allowed" | "denied",
		leaseId?: string,
		errorCode?: PermissionErrorCode,
	): Promise<void> {
		await this.audit.record({
			timestamp: new Date().toISOString(),
			requestId: request.requestId,
			subject: {
				id: request.subject.id,
				configKey: request.subject.configKey,
				kind: request.subject.kind,
				source: `${request.subject.source.type}:${request.subject.source.name}`,
				...(request.subject.source.identity !== undefined ? { identity: request.subject.source.identity } : {}),
			},
			inputFingerprint: request.inputFingerprint,
			policyGeneration: request.policyGeneration,
			registryGeneration: this.registry.generation,
			operations: request.operations,
			resources: request.resources.map(sanitizeResource),
			policyEffect: decision.effect === "no-opinion" ? "ask" : decision.effect,
			finalDecision,
			decisionSource: auditSource(decision),
			...(this.options.sessionId !== undefined ? { sessionId: this.options.sessionId } : {}),
			...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
			...(decision.ruleId !== undefined ? { ruleId: decision.ruleId } : {}),
			...(decision.grantIds !== undefined ? { grantIds: decision.grantIds } : {}),
			...(leaseId !== undefined ? { leaseId } : {}),
			...(errorCode !== undefined ? { errorCode } : {}),
		});
		const auditError = this.audit.getLastError();
		if (auditError !== undefined) this.noteError(`audit: ${auditError}`);
	}

	private async auditFailureForUnknown(input: AuthorizeInput, snapshot: PolicySnapshot, errorCode: PermissionErrorCode): Promise<void> {
		const subject = genericToolDescriptor(input.toolName);
		const request: AuthorizationRequest = {
			requestId: `perm_${randomUUID()}`,
			toolCallId: input.toolCallId,
			subject,
			inputFingerprint: stableFingerprint({ toolName: input.toolName, input: input.normalizedToolInput, policyGeneration: snapshot.generation }),
			operations: [],
			resources: [],
			summary: `Analyze ${input.toolName}`,
			policyGeneration: snapshot.generation,
		};
		await this.auditDecision(request, denyDecision("policy-error", "Analysis failed."), "denied", undefined, errorCode);
	}
}

function allowDecision(source: CompiledDecision["source"], message: string, grantIds?: string[]): CompiledDecision {
	return {
		effect: "allow",
		finalEffect: "allow",
		source,
		trace: [{ source, effect: "allow", message }],
		...(grantIds !== undefined ? { grantIds } : {}),
	};
}

function denyDecision(source: CompiledDecision["source"], message: string, ruleId?: string): CompiledDecision {
	const trace = ruleId === undefined ? [{ source, effect: "deny" as const, message }] : [{ source, effect: "deny" as const, message, ruleId }];
	return {
		effect: source === "hard-protection" ? "hard-deny" : source === "policy-error" ? "policy-error" : "deny",
		finalEffect: "deny",
		source,
		trace,
		...(ruleId !== undefined ? { ruleId } : {}),
	};
}

function auditSource(decision: CompiledDecision): import("./permission-types.js").PermissionAuditEntry["decisionSource"] {
	if (decision.source === "hard-protection") return "hard-protection";
	if (decision.source === "policy-error") return "policy-error";
	if (decision.source === "global-policy") return "global-policy";
	if (decision.source === "project-policy") return "project-policy";
	if (decision.source === "persistent-grant") return "persistent-grant";
	if (decision.source === "session-grant") return "session-grant";
	if (decision.source === "no-ui") return "no-ui";
	if (decision.source === "user") return "user";
	return "profile";
}

function stableFingerprint(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
