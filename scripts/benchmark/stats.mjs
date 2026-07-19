export function round(value, digits = 1) {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

export function percentile(sorted, quantile) {
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export function summarize(values, digits = 1) {
	if (values.length === 0) return { samples: [], min: 0, p50: 0, p95: 0, max: 0 };
	const sorted = [...values].sort((left, right) => left - right);
	return {
		samples: values.map((value) => round(value, digits)),
		min: round(sorted[0], digits),
		p50: round(percentile(sorted, 0.5), digits),
		p95: round(percentile(sorted, 0.95), digits),
		max: round(sorted.at(-1), digits),
	};
}

export function row(metric, values, digits = 1) {
	const summary = summarize(values, digits);
	return {
		metric,
		"p50 ms": summary.p50,
		"p95 ms": summary.p95,
		"min ms": summary.min,
	};
}

export function numericMetricRows(samples, digits = 1) {
	const first = samples[0];
	if (first === undefined) return [];
	return Object.keys(first).map((metric) => {
		const summary = summarize(samples.map((sample) => sample[metric]), digits);
		return { metric, unit: metric.endsWith("Mb") ? "MB" : "ms", p50: summary.p50, p95: summary.p95, min: summary.min, max: summary.max };
	});
}

export function aggregateObjectSamples(samples, digits = 1) {
	const first = samples[0];
	if (first === undefined) return {};
	return Object.fromEntries(Object.keys(first).map((metric) => [metric, summarize(samples.map((sample) => sample[metric]), digits)]));
}

export function samplesToObject(samples, digits = 1) {
	return Object.fromEntries([...samples].map(([id, values]) => [id, summarize(values, digits)]));
}
