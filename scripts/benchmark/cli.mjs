export function readRuns(args, { defaultRuns = 7, minimum = 3 } = {}) {
	const value = Number(readStringFlag(args, "--runs") ?? defaultRuns);
	if (!Number.isInteger(value) || value < minimum) throw new Error(`--runs must be an integer >= ${minimum}`);
	return value;
}

export function readSizes(args, name = "--sizes", fallback = "100") {
	const values = (readStringFlag(args, name) ?? fallback).split(",").map(Number);
	if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value < 2 || value > 100_000)) {
		throw new Error(`${name} must be comma-separated integers between 2 and 100000`);
	}
	return [...new Set(values)];
}

export function readStringFlag(args, name) {
	const prefix = `${name}=`;
	return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function assertKnownOptions(args, knownPrefixes) {
	for (const arg of args) {
		if (knownPrefixes.some((prefix) => arg === prefix || arg.startsWith(`${prefix}=`))) continue;
		throw new Error(`unknown benchmark option: ${arg}`);
	}
}
