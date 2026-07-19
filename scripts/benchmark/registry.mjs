export function createSuiteRegistry(initialSuites = []) {
	const suites = new Map();
	for (const suite of initialSuites) registerSuite(suites, suite);
	return {
		register(suite) { registerSuite(suites, suite); },
		has(id) { return suites.has(id); },
		get(id) { return suites.get(id); },
		ids() { return [...suites.keys()]; },
		async run(id, context) {
			const suite = suites.get(id);
			if (suite === undefined) throw new Error(`unknown benchmark suite: ${id}`);
			return suite.execute(context);
		},
	};
}

export async function loadSuitePlugin(registry, pluginPath) {
	const module = await import(pluginPath);
	const suites = module.default ?? module.suite ?? module.suites;
	if (Array.isArray(suites)) {
		for (const suite of suites) registry.register(suite);
	} else {
		registry.register(suites);
	}
}

function registerSuite(suites, suite) {
	if (!isSuite(suite)) throw new Error("benchmark plugin must export a suite or suite array");
	if (suites.has(suite.id)) throw new Error(`benchmark suite is already registered: ${suite.id}`);
	suites.set(suite.id, suite);
}

function isSuite(value) {
	return typeof value === "object" && value !== null
		&& typeof value.id === "string" && value.id.length > 0
		&& typeof value.execute === "function";
}
