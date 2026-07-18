import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	defaultModelsCachePath,
	defaultModelsJsoncPath,
	ensure_private_config_permissions,
	loadModelsJsoncConfig,
	loadModelsDiscoveryCache,
	normalizeModelsJsoncConfig,
	refreshModelsDiscoveryCache,
	registerOpenAICompatibleProviders,
	resolveCachedModelsJsoncConfig,
	type ModelsRefreshResult,
} from "../../src/openai-compatible-provider/index.js";

const AUTO_REFRESH_IDLE_DELAY_MS = 2_000;

/** 从 ~/.pi/agent/models.jsonc 注册 OpenAI-compatible provider。 */
export default async function openAICompatibleProvider(pi: ExtensionAPI): Promise<void> {
	const configPath = defaultModelsJsoncPath();
	const cachePath = defaultModelsCachePath();
	const warning = await ensure_private_config_permissions(configPath);
	if (warning) console.warn(warning);

	const config = await loadModelsJsoncConfig(configPath);
	if (!config) return;

	let cache = await loadModelsDiscoveryCache(cachePath);
	registerOpenAICompatibleProviders(pi, normalizeModelsJsoncConfig(resolveCachedModelsJsoncConfig(config, cache), configPath));

	const lifecycle = new AbortController();
	let refreshInFlight: Promise<ModelsRefreshResult> | undefined;
	let autoRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	const refresh = (): Promise<ModelsRefreshResult> => {
		if (refreshInFlight) return refreshInFlight;
		const currentCache = cache;
		refreshInFlight = refreshModelsDiscoveryCache(config, configPath, currentCache, {
			cachePath,
			signal: lifecycle.signal,
		}).then((result) => {
			if (lifecycle.signal.aborted) return result;
			cache = result.cache;
			if (result.changed) {
				const resolved = resolveCachedModelsJsoncConfig(config, cache);
				registerOpenAICompatibleProviders(pi, normalizeModelsJsoncConfig(resolved, configPath));
			}
			return result;
		}).finally(() => {
			refreshInFlight = undefined;
		});
		return refreshInFlight;
	};
	const cancelAutoRefresh = (): void => {
		if (autoRefreshTimer === undefined) return;
		clearTimeout(autoRefreshTimer);
		autoRefreshTimer = undefined;
	};
	const scheduleAutoRefresh = (ctx: ExtensionContext): void => {
		cancelAutoRefresh();
		if (isOffline() || lifecycle.signal.aborted || !supportsAutoRefresh(ctx)) return;
		autoRefreshTimer = setTimeout(() => {
			autoRefreshTimer = undefined;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				scheduleAutoRefresh(ctx);
				return;
			}
			void runAutoRefresh(refresh, lifecycle.signal, ctx);
		}, AUTO_REFRESH_IDLE_DELAY_MS);
		autoRefreshTimer.unref();
	};

	pi.on("session_start", (_event, ctx) => {
		scheduleAutoRefresh(ctx);
	});
	pi.on("turn_start", () => {
		cancelAutoRefresh();
	});
	pi.on("turn_end", (_event, ctx) => {
		scheduleAutoRefresh(ctx);
	});
	pi.on("session_shutdown", () => {
		cancelAutoRefresh();
		lifecycle.abort();
	});
	pi.registerCommand("refresh-models", {
		description: "Refresh OpenAI-compatible model cache",
		handler: async (_args, ctx) => {
			cancelAutoRefresh();
			if (isOffline()) {
				ctx.ui.notify("Model refresh skipped in offline mode.", "info");
				return;
			}
			try {
				const result = await refresh();
				const updated = result.updatedProviderIds.length;
				const failed = result.failures.length;
				ctx.ui.notify(`Model refresh complete: ${updated} updated, ${failed} failed.`, failed > 0 ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(`Model refresh failed: ${stringifyError(error)}`, "error");
			}
		},
	});
}

async function runAutoRefresh(
	refresh: () => Promise<ModelsRefreshResult>,
	signal: AbortSignal,
	ctx: ExtensionContext,
): Promise<void> {
	try {
		const result = await refresh();
		if (signal.aborted || result.failures.length === 0) return;
		ctx.ui.notify(`Model refresh failed for: ${result.failures.map((failure) => failure.providerId).join(", ")}. Using cached models.`, "warning");
	} catch (error) {
		if (!signal.aborted) ctx.ui.notify(`Model cache update failed: ${stringifyError(error)}`, "warning");
	}
}

function supportsAutoRefresh(ctx: Pick<ExtensionContext, "mode">): boolean {
	return ctx.mode === "tui" || ctx.mode === "rpc";
}

function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
	return ["1", "true", "yes"].includes(env.PI_OFFLINE?.toLowerCase() ?? "");
}

function stringifyError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
