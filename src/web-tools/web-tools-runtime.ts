import type { Dispatcher } from "undici";

import { createDuckDuckGoHtmlProvider } from "./search-providers/duckduckgo-html-provider.js";
import { createExaMcpProvider, DefaultExaMcpClientFactory, type ExaMcpClientFactory } from "./search-providers/exa-mcp.js";
import { SearchProviderRouter } from "./search-providers/router.js";
import type { WebSearchProvider } from "./search-providers/types.js";
import { SearchRequestGate } from "./search-request-gate.js";
import { providerSignature, SearchCache } from "./search-cache.js";
import { SnapshotCache } from "./snapshot-cache.js";
import { escapeXml } from "./url-utils.js";
import type {
	WebFetchExecutionContext,
	WebFetchParams,
	CookieStore,
	WebHttpFetch,
	WebHttpRequestInit,
	WebHttpResponse,
	WebSearchExecutionContext,
	WebSearchParams,
	WebSearchResult,
	WebFetchResult,
	WebToolsConfig,
	WebToolsRuntime,
	WebToolsRuntimeOptions,
} from "./types.js";
import { executeWebSearch } from "./websearch-tool.js";

export function createWebToolsRuntime(options: WebToolsRuntimeOptions = {}): WebToolsRuntime {
	let allowedFakeIpRanges: readonly string[] = [];
	let dispatcher = options.dispatcher;
	let dispatcherPromise: Promise<Dispatcher> | undefined;
	let cookieStorePromise: Promise<CookieStore> | undefined;
	let webFetchModulePromise: Promise<typeof import("./webfetch-tool.js")> | undefined;
	const snapshots = new SnapshotCache(options.now);
	const approvedAuthOrigins = new Set<string>();
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? defaultFetch;
	const exaFactory = options.exaMcpClientFactory ?? new DefaultExaMcpClientFactory();
	let searches = new SearchCache(now);
	let searchCacheTtlSeconds: number | undefined;
	let searchRequests = new SearchRequestGate(now);
	let searchGateSignature = "";
	let searchRouter: SearchProviderRouter | undefined;
	let searchRouterSignature = "";
	let searchRouterUpdate = Promise.resolve();
	const getDispatcher = (): Promise<Dispatcher> => {
		if (dispatcher !== undefined) return Promise.resolve(dispatcher);
		if (dispatcherPromise !== undefined) return dispatcherPromise;
		const pending = createDefaultDispatcher(() => allowedFakeIpRanges);
		dispatcherPromise = pending;
		void pending.then((created) => {
			dispatcher = created;
		}, () => {
			if (dispatcherPromise === pending) dispatcherPromise = undefined;
		});
		return pending;
	};
	const getCookieStore = (): Promise<CookieStore> => {
		if (cookieStorePromise !== undefined) return cookieStorePromise;
		const pending = createCookieStore(options.cookiePath);
		cookieStorePromise = pending;
		void pending.catch(() => {
			if (cookieStorePromise === pending) cookieStorePromise = undefined;
		});
		return pending;
	};
	const getWebFetchModule = (): Promise<typeof import("./webfetch-tool.js")> => {
		if (webFetchModulePromise !== undefined) return webFetchModulePromise;
		const pending = import("./webfetch-tool.js");
		webFetchModulePromise = pending;
		void pending.catch(() => {
			if (webFetchModulePromise === pending) webFetchModulePromise = undefined;
		});
		return pending;
	};
	const getSearchRouter = async (config: WebToolsConfig, signature: string): Promise<SearchProviderRouter> => {
		searchRouterUpdate = searchRouterUpdate.catch(() => undefined).then(async () => {
			if (searchRouter !== undefined && searchRouterSignature === signature) return;
			await searchRouter?.close();
			searchRouter = new SearchProviderRouter(
				options.searchProviders ?? createSearchProviders(config, getDispatcher, fetchImpl, searchRequests, exaFactory),
				config.websearch,
			);
			searchRouterSignature = signature;
		});
		await searchRouterUpdate;
		if (searchRouter === undefined) throw new Error("websearch router failed to initialize");
		return searchRouter;
	};
	void Promise.all([getDispatcher(), getCookieStore(), getWebFetchModule()]).catch(() => undefined);

	return {
		async fetch(params: WebFetchParams, context: WebFetchExecutionContext): Promise<WebFetchResult> {
			const resources = Promise.all([
				getWebFetchModule(),
				getDispatcher(),
				getCookieStore(),
			]);
			let config;
			try {
				config = await loadConfig();
			} catch (error) {
				void resources.catch(() => undefined);
				return configFailure("webfetch", error);
			}
			allowedFakeIpRanges = config.network.fake_ip_ranges;
			const [{ executeWebFetch }, activeDispatcher, cookieStore] = await resources;
			return executeWebFetch(params, {
				dispatcher: activeDispatcher,
				fetchImpl,
				cookieStore,
				snapshots,
				approvedAuthOrigins,
				config,
				context,
				now,
			});
		},
		async search(params: WebSearchParams, context: WebSearchExecutionContext): Promise<WebSearchResult> {
			let config;
			try {
				config = await loadConfig();
			} catch (error) {
				return configFailure("websearch", error);
			}
			allowedFakeIpRanges = config.network.fake_ip_ranges;
			if (searchCacheTtlSeconds !== config.websearch.cache_ttl_seconds) {
				searches = new SearchCache(now, config.websearch.cache_ttl_seconds * 1000);
				searchCacheTtlSeconds = config.websearch.cache_ttl_seconds;
			}
			const gateSignature = `${config.websearch.duckduckgo_html.min_interval_seconds}:${config.websearch.duckduckgo_html.blocked_cooldown_seconds}`;
			if (gateSignature !== searchGateSignature) {
				searchRequests.clear();
				searchRequests = new SearchRequestGate(
					now,
					config.websearch.duckduckgo_html.min_interval_seconds * 1000,
					config.websearch.duckduckgo_html.blocked_cooldown_seconds * 1000,
				);
				searchGateSignature = gateSignature;
			}
			const routerSignature = `${providerSignature(config.websearch)}:${gateSignature}`;
			const router = await getSearchRouter(config, routerSignature);
			return executeWebSearch(params, {
				searches,
				router,
				config,
				context,
				now,
			});
		},
		async close(): Promise<void> {
			snapshots.clear();
			searches.clear();
			searchRequests.clear();
			approvedAuthOrigins.clear();
			await searchRouterUpdate.catch(() => undefined);
			await searchRouter?.close();
			searchRouter = undefined;
			const activeDispatcher = dispatcher ?? (dispatcherPromise === undefined ? undefined : await dispatcherPromise);
			await activeDispatcher?.close();
			dispatcher = undefined;
			dispatcherPromise = undefined;
			cookieStorePromise = undefined;
			webFetchModulePromise = undefined;
		},
	};
}

function configFailure(tool: "webfetch" | "websearch", error: unknown): WebFetchResult & WebSearchResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: failureContent(tool, "CONFIG_ERROR", message),
		details: { status: "failed", error: { code: "CONFIG_ERROR", message }, duration_ms: 0 },
	};
}

function failureContent(tool: "webfetch" | "websearch", code: string, message: string): string {
	return `<error tool="${tool}" code="${escapeXml(code)}">
${escapeXml(message)}
</error>`;
}

function createSearchProviders(
	config: WebToolsConfig,
	getDispatcher: () => Promise<Dispatcher>,
	fetchImpl: WebHttpFetch,
	requestGate: SearchRequestGate,
	exaFactory: ExaMcpClientFactory,
): WebSearchProvider[] {
	return config.websearch.provider_order.map((provider) => {
		if (provider === "exa_mcp") return createExaMcpProvider(config.websearch.exa_mcp, exaFactory);
		return createDuckDuckGoHtmlProvider({
			config: config.websearch.duckduckgo_html,
			dispatcher: getDispatcher,
			fetchImpl,
			requestGate,
		});
	});
}

async function createDefaultDispatcher(getAllowedFakeIpRanges: () => readonly string[]): Promise<Dispatcher> {
	const [{ Agent }, { createSecureLookup }] = await Promise.all([
		loadUndici(),
		import("./network-policy.js"),
	]);
	return new Agent({
		connect: { lookup: createSecureLookup(getAllowedFakeIpRanges) },
	});
}

async function defaultFetch(input: URL, init: WebHttpRequestInit): Promise<WebHttpResponse> {
	const { fetch: undiciFetch } = await loadUndici();
	const response = await undiciFetch(input, init);
	return {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
		body: response.body,
	};
}

async function createCookieStore(cookiePath: string | undefined): Promise<CookieStore> {
	const [{ defaultCookiePath }, { NetscapeCookieStore }] = await Promise.all([
		import("./config.js"),
		import("./cookie-store.js"),
	]);
	return new NetscapeCookieStore(cookiePath ?? defaultCookiePath());
}

async function loadConfig(): Promise<WebToolsConfig> {
	const { loadWebToolsConfig } = await import("./config.js");
	return loadWebToolsConfig();
}

let undiciModule: Promise<typeof import("undici")> | undefined;

function loadUndici(): Promise<typeof import("undici")> {
	undiciModule ??= import("undici");
	return undiciModule;
}
