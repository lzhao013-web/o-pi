import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readTelemetryDirectory } from "../telemetry/jsonl-reader.js";
import { calculateTelemetryReport } from "./statistics.js";
import type { AnalysisQuery, ReportSnapshot } from "./types.js";

const LEGACY_REPORT_FILES = [
	"candidate_conversions.csv", "failure_recoveries.csv", "metadata.json", "near_retries.csv", "repeated_calls.csv",
	"summary.json", "tool_oscillations.csv", "tool_transitions.csv", "tools.csv", "tools.json", "workflow.json",
] as const;

export interface GenerateTelemetryReportOptions {
	inputDirectory?: string;
	outputDirectory?: string;
	generatedAt?: string;
	query?: AnalysisQuery;
}

export interface GenerateTelemetryReportResult {
	report: ReportSnapshot;
	output_directory: string;
}

export async function generateTelemetryReport(options: GenerateTelemetryReportOptions = {}): Promise<GenerateTelemetryReportResult> {
	const inputDirectory = path.resolve(options.inputDirectory ?? path.join(os.homedir(), ".pi", "telemetry", "sessions"));
	const outputDirectory = path.resolve(options.outputDirectory ?? path.join(os.homedir(), ".pi", "telemetry", "reports", "latest"));
	const input = await readTelemetryDirectory(inputDirectory);
	const report = calculateTelemetryReport(input.records, {
		...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
		...(options.query === undefined ? {} : { query: options.query }),
		scope: "all_sessions",
		consistency: "durable_snapshot",
		inputDirectory,
		inputFiles: input.files.map((file) => path.relative(inputDirectory, file).replace(/\\/gu, "/")),
		invalidLines: input.invalidLines,
	});
	await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
	await Promise.all(LEGACY_REPORT_FILES.map((file) => rm(path.join(outputDirectory, file), { force: true })));
	await Promise.all([
		writeSnapshotFile(outputDirectory, "slices.csv", toCsv(report.inventory.slices, [
			"slice_id", "tool_name", "behavior_hash", "instrumentation_hash", "first_seen", "last_seen", "sessions", "calls", "latest_for_tool", "dimensions",
		])),
		writeSnapshotFile(outputDirectory, "calls.csv", toCsv(report.facts.calls, [
			"session_id", "turn_id", "tool_call_id", "tool_name", "slice_id", "sequence", "outcome", "ok", "duration_ms", "output_tokens", "context", "timing", "metrics",
		])),
		writeSnapshotFile(outputDirectory, "report.html", renderReport(report)),
	]);
	// report.json is the only complete artifact and is published last as the generation commit point.
	await writeSnapshotFile(outputDirectory, "report.json", `${JSON.stringify(report, null, 2)}\n`);
	return { report, output_directory: outputDirectory };
}

export function toCsv(rows: readonly object[], columns: readonly string[]): string {
	const lines = [columns.map(csvCell).join(",")];
	for (const row of rows) lines.push(columns.map((column) => csvCell(Reflect.get(row, column))).join(","));
	return `${lines.join("\n")}\n`;
}

export function renderReport(report: ReportSnapshot): string {
	const payload = JSON.stringify(report).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi telemetry analysis</title>
<style>
:root{color-scheme:light dark;font:14px/1.45 system-ui,sans-serif}body{max-width:1600px;margin:auto;padding:22px;background:#101419;color:#e9eef3}h1,h2{margin:.4em 0}.warn{padding:12px;border:1px solid #d88a2d;background:#402c12;border-radius:8px}.critical{border-color:#ef5b5b;background:#431d1d}.filters,.tabs,.cards{display:flex;gap:9px;flex-wrap:wrap;margin:14px 0}.filters label{display:grid;gap:3px}.filters select,.filters input,button{padding:7px;background:#18212a;color:inherit;border:1px solid #3a4652;border-radius:6px}.cards>div{min-width:120px;background:#192129;border:1px solid #303c47;padding:10px;border-radius:8px}.cards b{font-size:1.4em;display:block}.view{display:none}.view.active{display:block}.table{overflow:auto;border:1px solid #303c47;border-radius:8px}table{border-collapse:collapse;width:100%}th,td{padding:7px 9px;border-bottom:1px solid #29343e;text-align:left;white-space:nowrap}th{background:#202a34;position:sticky;top:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#151b21;padding:12px;border:1px solid #303c47;border-radius:8px}.muted{color:#9dacba}@media(prefers-color-scheme:light){body{background:#f7f9fb;color:#1d2630}.filters select,.filters input,button,.cards>div,pre{background:#fff;border-color:#ccd5dd}.warn{background:#fff6df}.critical{background:#ffe8e8}th{background:#eef2f5}th,td{border-color:#dbe2e8}}
</style></head><body>
<h1>Pi telemetry analysis</h1>
<p class="muted">As of <span id="asof"></span> · analysis <span id="hash"></span></p>
<div id="warning"></div>
<div class="filters" id="filters"></div>
<div class="tabs"><button data-view="inventory">Data inventory</button><button data-view="current">Current slices</button><button data-view="comparison">Slice comparison</button><button data-view="workflow">Workflow</button><button data-view="health">Collection health</button></div>
<section id="inventory" class="view active"><h2>Data inventory</h2><div id="inventory-cards" class="cards"></div><div id="inventory-table"></div></section>
<section id="current" class="view"><h2>Current slices</h2><div id="current-table"></div><h2>Filtered calls</h2><div id="calls-table"></div></section>
<section id="comparison" class="view"><h2>Slice comparison</h2><div class="filters"><label>Baseline<select id="baseline"></select></label><label>Candidate<select id="candidate"></select></label></div><pre id="comparison-data"></pre></section>
<section id="workflow" class="view"><h2>Workflow <small>(heuristic)</small></h2><pre id="workflow-data"></pre></section>
<section id="health" class="view"><h2>Collection health</h2><pre id="health-data"></pre></section>
<script id="report-data" type="application/json">${payload}</script>
<script>
const report=JSON.parse(document.getElementById('report-data').textContent);const calls=report.facts.calls;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const model=c=>c.context.model?c.context.model.provider+'/'+c.context.model.id:'unknown';const env=c=>{const e=c.context.environment;return [e.platform,e.arch,e.mode,e.pi_version,e.node_version].map(v=>v||'unknown').join('/')};
const fields=[['tool','Tool',c=>c.tool_name],['behavior','Behavior',c=>c.identity.behavior_hash],['instrumentation','Instrumentation',c=>c.identity.instrumentation_hash],['model','Model',model],['thinking','Thinking',c=>c.context.thinking||'unknown'],['project','Project',c=>c.context.project],['environment','Environment',env]];
const state={};const filters=document.getElementById('filters');for(const [id,label,get] of fields){const values=[...new Set(calls.map(get))].sort();filters.insertAdjacentHTML('beforeend','<label>'+esc(label)+'<select id="f-'+id+'"><option value="">all</option>'+values.map(v=>'<option>'+esc(v)+'</option>').join('')+'</select></label>');state[id]='';document.getElementById('f-'+id).onchange=e=>{state[id]=e.target.value;render()}}
filters.insertAdjacentHTML('beforeend','<label>From<input id="f-from" type="datetime-local"></label><label>To<input id="f-to" type="datetime-local"></label>');for(const id of ['from','to'])document.getElementById('f-'+id).onchange=e=>{state[id]=e.target.value?new Date(e.target.value).toISOString():'';render()};
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.getElementById(b.dataset.view).classList.add('active')});
const table=(rows,cols)=>'<div class="table"><table><thead><tr>'+cols.map(c=>'<th>'+esc(c[0])+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+cols.map(c=>'<td>'+esc(typeof c[1]==='function'?c[1](r):r[c[1]])+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
const grouped=xs=>{const m=new Map();for(const c of xs){const a=m.get(c.slice_id)||[];a.push(c);m.set(c.slice_id,a)}return m};const freq=xs=>xs.reduce((m,x)=>(m[x]=(m[x]||0)+1,m),{});const basic=(slice,xs)=>{const ok=xs.filter(c=>c.ok!==undefined),dur=xs.flatMap(c=>typeof c.duration_ms==='number'?[c.duration_ms]:[]).sort((a,b)=>a-b),times=xs.flatMap(c=>c.timing.event_at?[c.timing.event_at]:[]).sort();return {...slice,calls:xs.length,sessions:new Set(xs.map(c=>c.session_id)).size,first_seen:times[0],last_seen:times.at(-1),success_samples:ok.length,success_rate:ok.length?ok.filter(c=>c.ok).length/ok.length:null,duration_p50:dur.length?dur[Math.ceil(dur.length*.5)-1]:null,duration_missing:xs.length?(xs.length-dur.length)/xs.length:0,environments:freq(xs.map(env))}};const distance=(a,b)=>{const ak=Object.keys(a),bk=Object.keys(b),at=Object.values(a).reduce((x,y)=>x+y,0),bt=Object.values(b).reduce((x,y)=>x+y,0);return [...new Set([...ak,...bk])].reduce((s,k)=>s+Math.abs((a[k]||0)/(at||1)-(b[k]||0)/(bt||1)),0)/2};
function render(){const filtered=calls.filter(c=>fields.every(([id,,get])=>!state[id]||get(c)===state[id])&&(!state.from||c.timing.event_at>=state.from)&&(!state.to||c.timing.event_at<=state.to));const groups=grouped(filtered),ids=new Set(groups.keys());const slices=report.inventory.slices.filter(s=>ids.has(s.slice_id)).map(s=>basic(s,groups.get(s.slice_id)));document.getElementById('inventory-cards').innerHTML=[['Calls',filtered.length],['Sessions',new Set(filtered.map(c=>c.session_id)).size],['Tools',new Set(filtered.map(c=>c.tool_name)).size],['Slices',ids.size]].map(x=>'<div>'+x[0]+'<b>'+x[1]+'</b></div>').join('');document.getElementById('inventory-table').innerHTML=table(slices,[['tool','tool_name'],['slice','slice_id'],['behavior','behavior_hash'],['instrumentation','instrumentation_hash'],['from','first_seen'],['to','last_seen'],['sessions','sessions'],['calls','calls'],['latest','latest_for_tool']]);const current=slices.filter(s=>report.query.selected_slice_ids.includes(s.slice_id));document.getElementById('current-table').innerHTML=table(current,[['tool','tool_name'],['slice','slice_id'],['calls','calls'],['sessions','sessions'],['success samples','success_samples'],['success rate','success_rate'],['duration p50','duration_p50'],['duration missing','duration_missing']]);document.getElementById('calls-table').innerHTML=table(filtered.slice(0,1000),[['time',c=>c.timing.event_at],['tool','tool_name'],['slice','slice_id'],['outcome','outcome'],['project',c=>c.context.project],['model',model]])}
const choices=report.inventory.slices.map(s=>'<option value="'+esc(s.slice_id)+'">'+esc(s.tool_name+' / '+s.behavior_hash.slice(0,8)+' / '+s.instrumentation_hash.slice(0,8))+'</option>').join('');for(const id of ['baseline','candidate'])document.getElementById(id).innerHTML=choices;const initial=report.comparison;if(initial){document.getElementById('baseline').value=initial.baseline.slice_id;document.getElementById('candidate').value=initial.candidate.slice_id}else if(report.inventory.slices.length>1)document.getElementById('candidate').selectedIndex=1;function compareSlices(){const b=report.inventory.slices.find(s=>s.slice_id===document.getElementById('baseline').value),c=report.inventory.slices.find(s=>s.slice_id===document.getElementById('candidate').value);if(!b||!c)return;const bs=basic(b,calls.filter(x=>x.slice_id===b.slice_id)),cs=basic(c,calls.filter(x=>x.slice_id===c.slice_id)),reasons=[],environment_distance=distance(bs.environments,cs.environments);if(b.tool_name!==c.tool_name)reasons.push('different_tools');if(b.instrumentation_hash!==c.instrumentation_hash)reasons.push('different_instrumentation');if(environment_distance>.25)reasons.push('material_environment_shift');document.getElementById('comparison-data').textContent=JSON.stringify({baseline:bs,candidate:cs,comparability:{comparable:reasons.length===0,reasons,environment_distance,metric_flags:Object.fromEntries(['success_rate','duration_ms','output_tokens'].map(name=>[name,{comparable:reasons.length===0,reasons}]))},authoritative_cli_comparison:initial?.comparability},null,2)}for(const id of ['baseline','candidate'])document.getElementById(id).onchange=compareSlices;
document.getElementById('asof').textContent=report.metadata.as_of||'no timestamp';document.getElementById('hash').textContent=report.metadata.analysis_hash.slice(0,16);const h=report.collection_health;if(h.status!=='healthy')document.getElementById('warning').innerHTML='<div class="warn '+(h.status==='critical'?'critical':'')+'"><b>Data quality '+esc(h.status)+'</b><br>'+esc(h.warnings.join(' · '))+'</div>';document.getElementById('workflow-data').textContent=JSON.stringify(report.workflow,null,2);document.getElementById('health-data').textContent=JSON.stringify(report.collection_health,null,2);compareSlices();render();
</script></body></html>\n`;
}

async function writeSnapshotFile(directory: string, fileName: string, content: string): Promise<void> {
	const destination = path.join(directory, fileName);
	const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, destination);
}

function csvCell(value: unknown): string {
	const text = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
	return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}
