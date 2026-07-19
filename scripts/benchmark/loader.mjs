import path from "node:path";
import { createJiti } from "jiti/static";
import { root } from "./runtime.mjs";

const defaultLoader = createTypeScriptLoader();

export function fromRoot(relativePath) {
	return path.join(root, relativePath);
}

export function createTypeScriptLoader(options = {}) {
	const jiti = createJiti(import.meta.url, { moduleCache: options.moduleCache ?? false });
	return (relativePath, importOptions = {}) => jiti.import(
		fromRoot(relativePath),
		importOptions.defaultExport === undefined ? {} : { default: importOptions.defaultExport },
	);
}

export function loadTypeScript(relativePath, options = {}) {
	return defaultLoader(relativePath, options);
}

export function writeJson(value) {
	process.stdout.write(JSON.stringify(value));
}

export { root };
