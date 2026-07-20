import path from "node:path";

export function normalizePathTarget(value: string, cwd: string): string {
	const resolved = path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
	return resolved.replace(/\\/gu, "/").replace(/\/$/u, "") || "/";
}

export function normalizeUrlTarget(value: string): string | undefined {
	try {
		const url = new URL(value);
		url.protocol = url.protocol.toLowerCase();
		url.hostname = url.hostname.toLowerCase();
		url.hash = "";
		const entries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
			compare(leftKey, rightKey) || compare(leftValue, rightValue));
		url.search = "";
		for (const [key, item] of entries) url.searchParams.append(key, item);
		return url.toString();
	} catch {
		return undefined;
	}
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
