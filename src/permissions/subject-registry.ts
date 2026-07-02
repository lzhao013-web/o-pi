import type {
	PermissionSubjectDescriptor,
	PermissionSubjectId,
	PermissionSubjectKind,
	PermissionSubject,
} from "./permission-types.js";

export interface SubjectCatalogEntry extends PermissionSubject {
	qualifiedConfigKey: string;
	conflict: boolean;
}

/** 统一权限主体注册表；所有工具、MCP、Skill、Agent 先注册后才能授权。 */
export class PermissionSubjectRegistry {
	private readonly descriptors = new Map<PermissionSubjectId, PermissionSubjectDescriptor>();
	private readonly configKeyIndex = new Map<string, PermissionSubjectId[]>();
	private generationValue = 0;

	register(descriptor: PermissionSubjectDescriptor): void {
		const existing = this.descriptors.get(descriptor.id);
		if (existing !== undefined && existing.source.identity !== descriptor.source.identity) {
			this.descriptors.delete(descriptor.id);
		}
		this.descriptors.set(descriptor.id, descriptor);
		this.rebuildIndex();
		this.generationValue += 1;
	}

	get generation(): number {
		return this.generationValue;
	}

	resolve(kind: PermissionSubjectKind, configKey: string): PermissionSubjectDescriptor | undefined {
		const ids = this.configKeyIndex.get(`${kind}:${configKey}`);
		if (ids?.length === 1) return this.descriptors.get(ids[0] ?? "");
		return undefined;
	}

	getById(id: PermissionSubjectId): PermissionSubjectDescriptor | undefined {
		return this.descriptors.get(id);
	}

	catalog(): SubjectCatalogEntry[] {
		return [...this.descriptors.values()]
			.map((descriptor) => {
				const ids = this.configKeyIndex.get(`${descriptor.kind}:${descriptor.configKey}`) ?? [];
				return {
					id: descriptor.id,
					kind: descriptor.kind,
					configKey: descriptor.configKey,
					qualifiedConfigKey: ids.length > 1 ? `${descriptor.source.type}:${descriptor.source.name}/${descriptor.configKey}` : descriptor.configKey,
					displayName: descriptor.displayName,
					source: descriptor.source,
					conflict: ids.length > 1,
				};
			})
			.sort((left, right) => `${left.kind}:${left.qualifiedConfigKey}`.localeCompare(`${right.kind}:${right.qualifiedConfigKey}`));
	}

	private rebuildIndex(): void {
		this.configKeyIndex.clear();
		for (const descriptor of this.descriptors.values()) {
			const key = `${descriptor.kind}:${descriptor.configKey}`;
			const list = this.configKeyIndex.get(key) ?? [];
			list.push(descriptor.id);
			this.configKeyIndex.set(key, list);
		}
	}
}
