import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AuthorizationLease, AuthorizationRequest, PermissionResource, PermissionSubject, ResolvedFileResource } from "./permission-types.js";
import { identityEquals, isPathInside } from "./path-utils.js";

export interface Grant {
	id: string;
	subjectId: string;
	subjectIdentity?: string;
	scope: "exact" | "subtree";
	resourceFingerprints: string[];
	fileScopes: Array<{ path: string; scope: "exact" | "subtree" }>;
	inputFingerprint?: string;
	createdAt: number;
	status: "active" | "suspended";
}

export class LeaseStore {
	private readonly leases = new Map<string, AuthorizationLease>();

	add(request: AuthorizationRequest): AuthorizationLease {
		const lease: AuthorizationLease = {
			id: `lease_${randomUUID()}`,
			requestId: request.requestId,
			...(request.toolCallId !== undefined ? { toolCallId: request.toolCallId } : {}),
			subjectId: request.subject.id,
			...(request.subject.source.identity !== undefined ? { subjectIdentity: request.subject.source.identity } : {}),
			inputFingerprint: request.inputFingerprint,
			resourceFingerprints: request.resources.map(resourceFingerprint),
			policyGeneration: request.policyGeneration,
			createdAt: Date.now(),
			consumed: false,
		};
		this.leases.set(lease.id, lease);
		return lease;
	}

	find(request: AuthorizationRequest): AuthorizationLease | undefined {
		return [...this.leases.values()].find(
			(lease) =>
				!lease.consumed &&
				lease.toolCallId === request.toolCallId &&
				lease.subjectId === request.subject.id &&
				lease.inputFingerprint === request.inputFingerprint &&
				lease.policyGeneration === request.policyGeneration &&
				sameSet(lease.resourceFingerprints, request.resources.map(resourceFingerprint)),
		);
	}

	consume(lease: AuthorizationLease): void {
		const stored = this.leases.get(lease.id);
		if (stored !== undefined) stored.consumed = true;
	}

	clear(): void {
		this.leases.clear();
	}
}

export class SessionGrantStore {
	private readonly grants = new Map<string, Grant>();

	list(): Grant[] {
		return [...this.grants.values()].sort((left, right) => left.createdAt - right.createdAt);
	}

	count(): number {
		return this.grants.size;
	}

	clear(): void {
		this.grants.clear();
	}

	revoke(id: string): boolean {
		return this.grants.delete(id);
	}

	add(request: AuthorizationRequest, scope: "exact" | "subtree"): Grant {
		const grant = grantFromRequest(request, scope);
		this.grants.set(grant.id, grant);
		return grant;
	}

	find(request: AuthorizationRequest): Grant[] {
		return coveringGrants(this.list(), request);
	}
}

export class PersistentGrantStore {
	private grants: Grant[] = [];

	constructor(private readonly filePath: string) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
			this.grants = Array.isArray(parsed) ? parsed.filter(isGrant) : [];
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				this.grants = [];
				return;
			}
			throw error;
		}
	}

	list(): Grant[] {
		return [...this.grants];
	}

	count(): number {
		return this.grants.length;
	}

	async add(request: AuthorizationRequest, scope: "exact" | "subtree"): Promise<Grant> {
		const grant = grantFromRequest(request, scope);
		this.grants.push(grant);
		await this.save();
		return grant;
	}

	async revoke(id: string): Promise<boolean> {
		const before = this.grants.length;
		this.grants = this.grants.filter((grant) => grant.id !== id);
		if (this.grants.length !== before) await this.save();
		return this.grants.length !== before;
	}

	async revokeAll(): Promise<void> {
		this.grants = [];
		await this.save();
	}

	find(request: AuthorizationRequest): Grant[] {
		return coveringGrants(this.grants, request);
	}

	private async save(): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temp, `${JSON.stringify(this.grants, null, "\t")}\n`, "utf8");
		await rename(temp, this.filePath);
	}
}

export function resourceFingerprint(resource: PermissionResource): string {
	if (resource.kind === "file") {
		const identity = resource.identity ?? resource.canonicalParentIdentity;
		return [
			"file",
			resource.operation,
			resource.access,
			resource.canonicalPath,
			resource.exists,
			identity?.device ?? "",
			identity?.inode ?? "",
		].join("|");
	}
	return JSON.stringify(resource);
}

export function resourcesUnchanged(previous: PermissionResource[], current: PermissionResource[]): boolean {
	if (!sameSet(previous.map(resourceFingerprint), current.map(resourceFingerprint))) return false;
	for (const oldResource of previous) {
		if (oldResource.kind !== "file") continue;
		const currentResource = current.find((item): item is ResolvedFileResource => item.kind === "file" && item.canonicalPath === oldResource.canonicalPath);
		if (currentResource === undefined) return false;
		if (oldResource.exists !== currentResource.exists) return false;
		if (!identityEquals(oldResource.identity ?? oldResource.canonicalParentIdentity, currentResource.identity ?? currentResource.canonicalParentIdentity)) return false;
	}
	return true;
}

function grantFromRequest(request: AuthorizationRequest, scope: "exact" | "subtree"): Grant {
	const files = request.resources.filter((resource): resource is ResolvedFileResource => resource.kind === "file");
	return {
		id: `grant_${randomUUID()}`,
		subjectId: request.subject.id,
		...(request.subject.source.identity !== undefined ? { subjectIdentity: request.subject.source.identity } : {}),
		scope,
		resourceFingerprints: scope === "exact" ? request.resources.map(resourceFingerprint) : [],
		fileScopes: files.map((file) => ({ path: scope === "subtree" ? (file.targetType === "directory" ? file.canonicalPath : path.dirname(file.canonicalPath)) : file.canonicalPath, scope })),
		createdAt: Date.now(),
		status: "active",
	};
}

function coveringGrants(grants: Grant[], request: AuthorizationRequest): Grant[] {
	const active = grants.filter(
		(grant) =>
			grant.status === "active" &&
			grant.subjectId === request.subject.id &&
			(grant.subjectIdentity === undefined || grant.subjectIdentity === request.subject.source.identity),
	);
	const files = request.resources.filter((resource): resource is ResolvedFileResource => resource.kind === "file");
	if (files.length > 0) {
		const coversFiles = files.every((file) =>
			active.some((grant) =>
				grant.fileScopes.some((scope) => (scope.scope === "exact" ? scope.path === file.canonicalPath : isPathInside(scope.path, file.canonicalPath))),
			),
		);
		if (coversFiles) return active;
	}
	const requestFingerprints = request.resources.map(resourceFingerprint);
	const exact = active.filter((grant) => grant.resourceFingerprints.some((fingerprint) => requestFingerprints.includes(fingerprint)));
	return requestFingerprints.every((fingerprint) => exact.some((grant) => grant.resourceFingerprints.includes(fingerprint))) ? exact : [];
}

function sameSet(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((item) => right.includes(item));
}

function isGrant(value: unknown): value is Grant {
	return typeof value === "object" && value !== null && "id" in value && "subjectId" in value && "status" in value;
}
