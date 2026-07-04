import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { WebFetchDetails, WebFetchFailureDetails, WebFetchProgressDetails, WebFetchSuccessDetails } from "./types.js";
import { compactUrl, formatBytes, formatChars, shortUrlForCall, truncateMiddle } from "./url-utils.js";

export function renderWebFetchCall(args: unknown, theme: Pick<Theme, "fg" | "bold">, context: { lastComponent?: unknown }): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(formatWebFetchCall(args, theme));
	return text;
}

export function renderWebFetchResult(
	result: { details?: unknown },
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	context: { lastComponent?: unknown; args?: unknown },
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	text.setText(formatWebFetchResult(result.details, options, theme, context.args));
	return text;
}

export function formatWebFetchCall(args: unknown, theme: Pick<Theme, "fg" | "bold">): string {
	const parts = [theme.fg("toolTitle", theme.bold("webfetch")), theme.fg("accent", shortUrlForCall(args))];
	if (isRecord(args) && args["mode"] === "source") parts.push(theme.fg("muted", "source"));
	const offset = isRecord(args) && typeof args["offset"] === "number" ? args["offset"] : undefined;
	const limit = isRecord(args) && typeof args["limit"] === "number" ? args["limit"] : undefined;
	if (offset !== undefined && offset > 0) {
		const end = limit !== undefined ? offset + limit : undefined;
		parts.push(theme.fg("muted", end !== undefined ? `${formatChars(offset)}-${formatChars(end)}` : `${formatChars(offset)}+`));
	}
	return parts.join("  ");
}

export function formatWebFetchResult(
	details: unknown,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: Pick<Theme, "fg" | "bold">,
	_args?: unknown,
): string {
	if (options.isPartial || isProgressDetails(details)) return theme.fg("warning", formatProgress(details));
	if (isSuccessDetails(details)) return formatSuccess(details, options.expanded === true, theme);
	if (isFailureDetails(details)) return formatFailure(details, options.expanded === true, theme);
	return theme.fg("muted", "webfetch");
}

export function isWebFetchDetails(value: unknown): value is WebFetchDetails {
	return isSuccessDetails(value) || isFailureDetails(value) || isProgressDetails(value);
}

function formatProgress(details: unknown): string {
	if (!isProgressDetails(details)) return "requesting...";
	if (details.phase === "redirecting") return "redirecting...";
	if (details.phase === "converting") return "converting HTML -> Markdown...";
	if (details.phase === "downloading") {
		return details.received_bytes !== undefined ? `downloading ${formatBytes(details.received_bytes)}...` : "downloading...";
	}
	return "requesting...";
}

function formatSuccess(details: WebFetchSuccessDetails, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const format = labelFormat(details.format);
	const range = details.range.next_offset !== undefined
		? `chars ${formatChars(details.range.start)}-${formatChars(details.range.end)} of ${formatChars(details.range.total)}`
		: `${formatChars(details.total_chars)} chars`;
	const summaryParts = [
		details.title ? `"${truncateMiddle(details.title, 48)}"` : undefined,
		`${details.http_status}`,
		format,
		range,
		details.authenticated ? "auth" : undefined,
		details.range.next_offset !== undefined ? "more" : undefined,
		details.snapshot === "hit" ? "snapshot" : undefined,
		`${details.duration_ms}ms`,
	].filter((item): item is string => item !== undefined);
	const summary = theme.fg("success", summaryParts.join(" · "));
	if (!expanded) return summary;
	return [
		summary,
		`  Status          ${details.http_status}`,
		`  Final URL       ${details.final_url}`,
		`  Content         ${details.content_type ?? "unknown"} -> ${details.format}`,
		details.charset ? `  Encoding        ${details.charset}` : undefined,
		`  Downloaded      ${formatBytes(details.downloaded_bytes)}`,
		`  Returned        chars ${details.range.start}-${details.range.end} of ${details.range.total}`,
		details.authenticated ? "  Authentication  cookie" : undefined,
		`  Snapshot        ${details.snapshot}`,
		details.redirect_count > 0 ? `  Redirects       ${details.redirect_count}` : undefined,
		`  Duration        ${details.duration_ms} ms`,
		details.preview ? `\n  Preview\n${indent(details.preview)}` : undefined,
	]
		.filter((item): item is string => item !== undefined)
		.join("\n");
}

function formatFailure(details: WebFetchFailureDetails, expanded: boolean, theme: Pick<Theme, "fg" | "bold">): string {
	const status = details.http_status !== undefined ? `${details.http_status} ` : "";
	const summary = theme.fg("error", `${status}${labelError(details)} · ${details.error.message}`);
	if (!expanded) return summary;
	return [
		summary,
		`  Error           ${details.error.code}`,
		details.http_status !== undefined ? `  Status          ${details.http_status}` : undefined,
		details.final_url ? `  Final URL       ${details.final_url}` : undefined,
		details.authenticated ? "  Authentication  cookie" : undefined,
		details.redirect_count !== undefined && details.redirect_count > 0 ? `  Redirects       ${details.redirect_count}` : undefined,
		details.duration_ms !== undefined ? `  Duration        ${details.duration_ms} ms` : undefined,
		details.response_preview ? `\n  Response\n${indent(details.response_preview)}` : undefined,
	]
		.filter((item): item is string => item !== undefined)
		.join("\n");
}

function labelFormat(format: string): string {
	if (format === "markdown") return "Markdown";
	if (format === "json") return "JSON";
	if (format === "xml") return "XML";
	if (format === "source") return "Source";
	return "Text";
}

function labelError(details: WebFetchFailureDetails): string {
	switch (details.error.code) {
		case "BLOCKED_ADDRESS":
			return "blocked";
		case "TIMEOUT":
			return "timeout";
		case "RESPONSE_TOO_LARGE":
			return "too large";
		case "UNSUPPORTED_CONTENT_TYPE":
			return "unsupported";
		default:
			return details.error.code;
	}
}

function indent(value: string): string {
	return value.split("\n").slice(0, 12).map((line) => `  ${line}`).join("\n");
}

function isSuccessDetails(value: unknown): value is WebFetchSuccessDetails {
	return isRecord(value) && value["status"] === "success" && typeof value["http_status"] === "number" && isRecord(value["range"]);
}

function isFailureDetails(value: unknown): value is WebFetchFailureDetails {
	return isRecord(value) && value["status"] === "failed" && isRecord(value["error"]) && typeof value["error"]["code"] === "string";
}

function isProgressDetails(value: unknown): value is WebFetchProgressDetails {
	return isRecord(value) && value["status"] === "progress" && typeof value["phase"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
