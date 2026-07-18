import type { FileToolLspHooks } from "../types.js";

export interface LspModule {
	lspFileHooks: FileToolLspHooks;
	lspManager: { reload(): Promise<void> };
}

export interface LazyLspFileHooks extends FileToolLspHooks {
	shutdown(): Promise<void>;
}

/** LSP 模块只在某个文件工具实际请求增强时加载。 */
export function createLazyLspFileHooks(load: () => Promise<LspModule>): LazyLspFileHooks {
	let pending: Promise<LspModule> | undefined;
	const getModule = (): Promise<LspModule> => {
		if (pending !== undefined) return pending;
		const created = load();
		pending = created;
		void created.catch(() => {
			if (pending === created) pending = undefined;
		});
		return created;
	};
	return {
		async enhanceRead(input) {
			return (await getModule()).lspFileHooks.enhanceRead?.(input);
		},
		async grepSymbols(input) {
			return (await getModule()).lspFileHooks.grepSymbols?.(input) ?? [];
		},
		async beforeEdit(input) {
			return (await getModule()).lspFileHooks.beforeEdit?.(input);
		},
		async afterWrite(input) {
			return (await getModule()).lspFileHooks.afterWrite?.(input);
		},
		async afterEdit(input) {
			return (await getModule()).lspFileHooks.afterEdit?.(input);
		},
		async shutdown() {
			const active = pending;
			pending = undefined;
			if (active === undefined) return;
			const loaded = await active.catch(() => undefined);
			await loaded?.lspManager.reload();
		},
	};
}
