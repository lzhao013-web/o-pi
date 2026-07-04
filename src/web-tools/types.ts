import type { Dispatcher } from "undici";

export type WebFetchMode = "readable" | "source";
export type WebFetchOutputFormat = "markdown" | "text" | "json" | "xml" | "source";
export type SnapshotStatus = "created" | "hit" | "refetched" | "not_needed";

export interface WebFetchParams {
	url: string;
	mode?: WebFetchMode;
	offset?: number;
	limit?: number;
}

export interface WebToolsConfig {
	version: 1;
	webfetch: {
		timeout_seconds: number;
		max_redirects: number;
		user_agent: string;
		network: {
			fake_ip_ranges: string[];
		};
		limits: {
			response_bytes: number;
			default_output_chars: number;
			max_output_chars: number;
		};
		cookies: {
			enabled: boolean;
			domains: string[];
			confirmation: "always" | "session" | "never";
		};
	};
}

export type WebFetchErrorCode =
	| "INVALID_ARGUMENT"
	| "CONFIG_ERROR"
	| "INVALID_URL"
	| "BLOCKED_ADDRESS"
	| "COOKIE_ERROR"
	| "AUTH_CONFIRMATION_REQUIRED"
	| "DNS_FAILED"
	| "CONNECTION_FAILED"
	| "TLS_FAILED"
	| "TIMEOUT"
	| "ABORTED"
	| "TOO_MANY_REDIRECTS"
	| "HTTP_ERROR"
	| "RESPONSE_TOO_LARGE"
	| "UNSUPPORTED_CONTENT_TYPE"
	| "DECODE_FAILED"
	| "CONVERSION_FAILED"
	| "OFFSET_OUT_OF_RANGE";

export interface WebFetchFailureDetails {
	status: "failed";
	error: {
		code: WebFetchErrorCode;
		message: string;
	};
	requested_url?: string;
	final_url?: string;
	http_status?: number;
	authenticated?: boolean;
	redirect_count?: number;
	duration_ms?: number;
	response_preview?: string;
}

export interface WebFetchSuccessDetails {
	status: "success";
	requested_url: string;
	final_url: string;
	http_status: number;
	title?: string;
	content_type?: string;
	charset?: string;
	format: WebFetchOutputFormat;
	downloaded_bytes: number;
	total_chars: number;
	range: {
		start: number;
		end: number;
		total: number;
		next_offset?: number;
	};
	authenticated: boolean;
	redirect_count: number;
	snapshot: SnapshotStatus;
	duration_ms: number;
	/** 供展开 renderer 使用的短预览，不含包装标签。 */
	preview: string;
}

export interface WebFetchProgressDetails {
	status: "progress";
	phase: "requesting" | "redirecting" | "downloading" | "converting";
	http_status?: number;
	received_bytes?: number;
	expected_bytes?: number;
	redirect_count?: number;
}

export type WebFetchDetails = WebFetchSuccessDetails | WebFetchFailureDetails | WebFetchProgressDetails;

export interface WebFetchResult {
	content: string;
	details: WebFetchSuccessDetails | WebFetchFailureDetails;
}

export interface WebFetchExecutionContext {
	toolCallId: string;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: string; details: WebFetchProgressDetails }) => void;
	hasUI: boolean;
	confirm?: (title: string, message: string) => Promise<boolean>;
}

export interface ValidatedUrl {
	url: URL;
	displayUrl: string;
}

export interface HttpFetchSuccess {
	status: "success";
	requestedUrl: string;
	finalUrl: string;
	httpStatus: number;
	statusText: string;
	headers: WebFetchHeaders;
	body: Uint8Array;
	authenticated: boolean;
	redirectCount: number;
	downloadedBytes: number;
}

export type HttpFetchResult = HttpFetchSuccess | { status: "failed"; details: WebFetchFailureDetails };

export interface ContentConversion {
	text: string;
	format: WebFetchOutputFormat;
	contentType?: string;
	charset?: string;
	title?: string;
}

export interface WebFetchHeaders {
	get(name: string): string | null;
	getSetCookie?: () => string[];
}

export interface WebFetchResponse {
	readonly status: number;
	readonly statusText: string;
	readonly headers: WebFetchHeaders;
	readonly body: WebFetchBody | null;
}

export interface WebFetchBody {
	getReader(): WebFetchBodyReader;
	cancel(): Promise<void>;
}

export interface WebFetchBodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(): Promise<void>;
}

export interface WebFetchRequestInit {
	method: "GET";
	redirect: "manual";
	dispatcher?: Dispatcher;
	signal: AbortSignal;
	headers: Record<string, string>;
}

export type WebFetchFetch = (
	input: URL,
	init: WebFetchRequestInit,
) => Promise<WebFetchResponse>;

export interface WebFetchSnapshot {
	key: string;
	createdAt: number;
	text: string;
	metadata: {
		finalUrl: string;
		httpStatus: number;
		contentType?: string;
		charset?: string;
		format: WebFetchOutputFormat;
		title?: string;
		authenticated: boolean;
		redirectCount: number;
		downloadedBytes: number;
	};
	sizeBytes: number;
}

export interface CookieAccess {
	header?: string;
	fingerprint: string;
	authenticated: boolean;
}

export interface CookieStore {
	getCookieAccess(url: URL, allowlisted: boolean): Promise<CookieAccess | WebFetchFailureDetails>;
	storeFromResponse(url: URL, setCookieHeaders: string[], allowlisted: boolean): Promise<WebFetchFailureDetails | undefined>;
}

export interface WebToolsRuntime {
	fetch(params: WebFetchParams, context: WebFetchExecutionContext): Promise<WebFetchResult>;
	close(): Promise<void>;
}

export interface WebToolsRuntimeOptions {
	dispatcher?: Dispatcher;
	fetchImpl?: WebFetchFetch;
	cookiePath?: string;
	now?: () => number;
}
