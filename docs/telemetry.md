# 本地遥测

遥测系统分成两个独立部分：

* 数据收集在 Pi 运行时记录一阶事实，顺序追加到本地 JSONL。
* 报告生成只在执行报告命令时读取全部 JSONL，计算统计量、调用关系和二级结论，再输出 CSV、JSON 与 HTML。

两部分都只服务于本地个人分析。收集或报告失败不得改变工具、turn 或 session 行为。JSONL 是唯一权威数据，报告可随时完整重算，不向原始记录写回推断结果。

## 数据收集

```text
tool definition + repair hints + telemetry adapter
  -> registerObservedTool
  -> Pi lifecycle + shared telemetry event channel
  -> session-scoped call store
  -> turn_end message/results assembly
  -> append-only JSONL writer
```

模块职责：

* `src/telemetry/adapter.ts`：工具输入和结果事实的投影协议，并隔离投影异常。
* `src/telemetry/tool.ts`：仓库内模型工具的统一注册入口，组合参数修复、执行和遥测观测。
* `src/telemetry/channel.ts`：跨扩展传递当前调用的一阶事实。
* `src/telemetry/runtime.ts`：collector 私有且随 session 重置的调用状态。
* `src/telemetry/collector.ts`：消费 Pi 生命周期，在 `turn_end` 汇合并写出记录。
* `src/telemetry/record.ts`：组装记录并依据最终结果分类 outcome。
* `src/telemetry/writer.ts`：按 session 顺序追加 JSONL。

一次调用按 `toolCallId` 汇合以下原始遥测事实：

```text
tool_execution_start
  -> argument preparation / repair
  -> approval decision
  -> execute start/end + adapter observation
  -> turn_end assistant message + final tool result
```

这里的“原始”指未做跨调用统计或推断的一阶事实，不表示保存敏感正文。最终记录顺序以 `turn_end.message` 中的 tool-call 顺序为准，结果按 `toolCallId` 配对。collector 不扫描 session tree，也不写自定义 session entry。

### 新工具接入

新的模型可调用工具必须使用 `registerObservedTool()` 并提供 telemetry adapter：

```ts
const inspectTelemetry = defineToolTelemetry<InspectParams, InspectDetails>({
  projectRequested(raw) {
    return {
      value: allowlistedRawInput(raw),
      references: inputReferences(raw),
    };
  },
  projectExecuted(params) {
    return {
      value: { path: params.path },
      references: [{ relation: "target", kind: "path", value: params.path }],
    };
  },
  observeResult(params, result) {
    return {
      metrics: { items: { value: result.details.items, unit: "item" } },
      references: resultReferences(result),
    };
  },
});

registerObservedTool(pi, {
  tool: inspectTool,
  repair: { pathFields: ["path"] },
  telemetry: inspectTelemetry,
  cohort: {
    implementationEntrypoints: ["src/inspect/index.ts", "src/inspect/telemetry.ts"],
    config: () => loadInspectConfig(),
  },
});
```

三个阶段的职责为：

* `projectRequested(raw)`：以 `value` 保存明确列入白名单的模型原始输入，并可提供标准化 `references`；省略时为空投影。
* `projectExecuted(params)`：保存真正进入 `execute` 的强类型参数和语义引用。
* `observeResult(params, result)`：从强类型结果提取无正文的 metrics、references、状态和结果修正事实。

adapter 必填。没有可记录数据的工具应显式使用 `minimalTelemetry()`。投影抛错或返回不可序列化数据时，调用降级为空投影并标记 `annotations.projection_failed`，工具仍继续执行。

`cohort` 也必填。实现 hash 只遍历该工具声明的入口及其相对源码依赖，不使用 Git tag、commit 或全仓库 hash。`config` 返回影响工具行为的有效配置；配置只参与 hash，原值不写入遥测。

报告不维护工具白名单。任何工具都会先进入通用 parser；只要 adapter 提供 metrics 和 references，新工具无需报告端代码即可参与通用统计、目标匹配和 candidate conversion。数值、布尔值和字符串 metric 分别汇总为数值分布、真假计数和值计数，metric 的 name/unit 组合永久确定其语义。

### 存储结构

每个 Pi session 固定追加到同一个文件；文件名包含经过清洗和 hash 的 session 身份，避免不同 session 清洗后碰撞：

```text
~/.pi/telemetry/sessions/<session>.jsonl
```

记录不包含且永远不增加日志版本字段。每行是一个自描述的独立 JSON 对象，事件类型为：

```text
session_start | turn_start | tool_call | turn_end | session_end
```

`tool_call` 保存：

```jsonc
{
  "event": "tool_call",
  "id": "<uuid>",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "session_id": "<session-id>",
  "sequence": 12,
  "turn_id": "<turn-id>",
  "tool_call_id": "<call-id>",
  "context": {
    "cwd": "/workspace",
    "model": { "provider": "openai", "id": "..." },
    "thinking_level": "high"
  },
  "data": {
    "turn_index": 3,
    "tool": { "name": "read", "cohort": "<sha256>" },
    "input": {
      "requested": { "value": {}, "references": [] },
      "executed": { "value": {}, "references": [] }
    },
    "annotations": {
      "preparation": {},
      "approval": {},
      "execution": {}
    },
    "result": {
      "ok": true,
      "outcome": "success",
      "output": {},
      "metrics": {
        "returned_lines": { "value": 20, "unit": "line" }
      },
      "references": []
    }
  }
}
```

`id` 唯一标识记录；`sequence` 表示采集器观察到的事件顺序，文件行序表示实际落盘顺序。实例内 Promise 队列串行写入，跨实例和进程通过 session 文件锁串行追加；锁只覆盖单行 append 并在 finally 中释放。每条记录重复保存解释自身所需的 context，不依赖文件名或前置事件。两条调用只有在 `data.tool.name` 与 `data.tool.cohort` 都相同时才可合并分析。cohort 是以下内容的 SHA-256：宿主 Pi 版本、该工具的 implementation hash、有效配置 hash、provider/model、thinking level 和当前工具集 hash。

`result.ok` 是稳定的通用成功事实；`outcome` 是开放字符串。当前 writer 使用 `success`、`tool_error`、`validation_error`、`blocked`、`timeout`、`aborted`、`exception` 和 `missing_result`，parser 不拒绝未来值。写入采用 best-effort 语义，序列化、建目录、append 和 flush 失败均被隔离。

### 永久兼容约束

存储格式只允许单调扩展：

* 已发布字段永不改名、改变 JSON 类型、单位或含义；writer 可以停止写，reader 永久保留读取能力。
* 新需求只增加可选字段、事件名或开放字符串值；设计错误通过新字段修正，旧字段不得复用。
* 工具名、event、outcome、reference 的 relation/kind/group/source 均为开放字符串。
* `additionalProperties` 始终允许；未知字段保留在 raw parse result 中，不导致整条记录失败。
* 缺失表示未采集，不转换为 `0`、`false` 或空值；`null` 只表示明确无值。
* 最小身份无效才拒绝记录；可选部分无效时产生 partial record，其余事实继续进入报告。

`references` 是跨工具语义协议。输入目标和结果对象统一使用 `{ relation, kind, value }`，可选附加 rank、group、sources 和行区间。parser 只对已知 path/URL 做规范化，未知 kind 原样保留并仍可按 kind/value 匹配。因此工具可以增加、删除或改名，报告端无需新增 parser。

### 数据边界

adapter 只保存统计所需的最小事实。路径、查询词、URL、Bash command 和小型标量参数可按白名单保留。写入内容、编辑前后文本和 subagent 任务正文只保存 `{ chars, lines, sha256 }`。

不保存工具输出正文、diff、网页正文、搜索标题或摘要、诊断正文、subagent 输出和错误消息。结果只保留字符数、带 method 的估算 token、截断状态、typed metrics，以及模型实际看到的语义 references。

## 报告生成

运行：

```bash
npm run telemetry:report
```

默认读取 `~/.pi/telemetry/sessions/*.jsonl`，完整统计后写入 `~/.pi/telemetry/reports/latest/`。可用 `--input DIR` 和 `--output DIR` 覆盖路径。输入目录不存在时生成空报告；无法解析的行只计入 metadata。

`src/telemetry-report/` 的职责分层：

* `reader.ts`：工具无关的容错读取；返回 known、partial、unknown_event 或 invalid，并保留 raw record。
* `ingest.ts`：单次扫描记录，建立与采集端类型解耦的 canonical dataset。
* `statistics.ts`：只在命令触发后按 `tool_name + cohort_id` 计算统计量、精确重试和工具转移。
* `output.ts`：原子写出 CSV、JSON 和自包含 HTML。

读取不检查或分派任何日志版本。必需身份字段缺失时记录为 invalid；可选字段缺失时保持未知；局部类型错误产生 partial；未知事件和开放字符串单独计数而不影响已知记录。重复 `id` 只摄入一次。metadata 分别报告 parsed line、decoded、partial、unknown event、invalid record、duplicate 和 JSON syntax error。

输出包含：

```text
tools.csv
tools.json
tool_transitions.csv
repeated_calls.csv
candidate_conversions.csv
failure_recoveries.csv
near_retries.csv
tool_oscillations.csv
workflow.json
summary.json
metadata.json
report.html
```

HTML 先按工具 cohort 提供横向比较，再为每个 cohort 单独展示调用量、成功率、outcome、错误码、执行时长、输出 token、参数修复、审批、候选来源、前后工具、重复调用和工具自有 metrics，最后展示 session 级工作流明细。所有统计均可由原始 JSONL 确定性重算。

### Session 级工作流分析

`tool_transitions.csv` 按同一 session 中相邻调用的工具 cohort 计算有向转移。除调用次数外，还记录独立 session 数、`P(to|from)`、相对目标工具 cohort 全局基线的 lift、同 turn/跨 turn 次数、输入 path/URL 相同次数，以及前后 outcome 分布。并行调用仍按 assistant message 中的稳定顺序排列；转移只表示相邻关系，不表示执行依赖或因果关系。

`candidate_conversions.csv` 将任何工具产生的 `relation=candidate` reference 与同一 session 后续调用的 input reference 匹配。已知 path/URL 会规范化，未知 kind 按 kind/value 精确匹配。每个 producer、source、group 组合统计：

* candidate 数、转化数、独立曝光/转化 session 数；
* 全部、rank 1 和 rank 1-3 candidate 的转化率；
* 已转化 candidate 的平均 rank、到首次使用的平均调用距离和 consumer 工具分布。

一个 candidate 有多个 source 时会分别归因到每个 source，因此明细行可重叠；summary 中的曝光和转化数按 candidate 本身去重。首次匹配后的重复使用不重复计数。

`failure_recoveries.csv` 对每次 `ok=false` 调用检查同一 session 的后续三次调用，取第一个 `ok=true` 调用；缺失 `ok` 的调用不猜测成功或失败：

```text
same tool + same normalized input -> exact_retry
same tool + changed input         -> modified_retry
different tool                    -> fallback
no success in next 3 calls        -> unrecovered
```

恢复成本是失败调用之后、截至恢复调用的执行时长和输出 token 合计。该统计是有界的序列启发式，不能证明后续成功调用解决了同一用户意图。

`near_retries.csv` 只记录失败后紧邻的同工具、不同输入调用，并列出变化的顶层字段。完全相同输入继续由 `repeated_calls.csv` 记录。`tool_oscillations.csv` 记录连续 `A -> B -> A`，同时标记是否同 turn、第一次和第三次调用是否指向相同 path/URL。两者用于发现试参循环和工具边界振荡，不自动判定为设计缺陷。
