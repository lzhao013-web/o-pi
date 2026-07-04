import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

import { defaultCookiePath, loadWebToolsConfig, WebToolsConfigError } from "./config.js";
import { NetscapeCookieStore } from "./cookie-store.js";
import { createSecureLookup } from "./network-policy.js";
import { SnapshotCache } from "./snapshot-cache.js";
import type { WebFetchExecutionContext, WebFetchParams, WebFetchRequestInit, WebFetchResponse, WebFetchResult, WebToolsRuntime, WebToolsRuntimeOptions } from "./types.js";
import { executeWebFetch } from "./webfetch-tool.js";

export function createWebToolsRuntime(options: WebToolsRuntimeOptions = {}): WebToolsRuntime {
	let allowedFakeIpRanges: readonly string[] = [];
	const dispatcher = options.dispatcher ?? createDefaultDispatcher(() => allowedFakeIpRanges);
	const cookieStore = new NetscapeCookieStore(options.cookiePath ?? defaultCookiePath());
	const snapshots = new SnapshotCache(options.now);
	const approvedAuthOrigins = new Set<string>();
	const now = options.now ?? (() => Date.now());
	const fetchImpl = options.fetchImpl ?? defaultFetch;

	return {
		async fetch(params: WebFetchParams, context: WebFetchExecutionContext): Promise<WebFetchResult> {
			let config;
			try {
				config = await loadWebToolsConfig();
			} catch (error) {
				const message = error instanceof WebToolsConfigError ? error.message : String(error);
				const details = {
					status: "failed" as const,
					error: { code: "CONFIG_ERROR" as const, message },
					duration_ms: 0,
				};
				return { content: JSON.stringify(details, null, 2), details };
			}
			allowedFakeIpRanges = config.webfetch.network.fake_ip_ranges;
			return executeWebFetch(params, {
				dispatcher,
				fetchImpl,
				cookieStore,
				snapshots,
				approvedAuthOrigins,
				config,
				context,
				now,
			});
		},
		async close(): Promise<void> {
			snapshots.clear();
			approvedAuthOrigins.clear();
			await dispatcher.close();
		},
	};
}

function createDefaultDispatcher(getAllowedFakeIpRanges: () => readonly string[]): Dispatcher {
	return new Agent({
		connect: { lookup: createSecureLookup(getAllowedFakeIpRanges) },
	});
}

async function defaultFetch(input: URL, init: WebFetchRequestInit): Promise<WebFetchResponse> {
	const response = await undiciFetch(input, init);
	return {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
		body: response.body,
	};
}
