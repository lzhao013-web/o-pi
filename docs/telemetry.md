# 本地遥测

o-pi 遥测保存本地、append-only 的一阶事实。采集失败不得改变 tool、turn 或 session 行为；采集层不推断工作流、不计算统计报告，也不把并行调用压成单一因果序列。

持久化权威数据位于：

```text
~/.pi/telemetry/sessions/<session>.jsonl
```

主文件写入失败时，writer 尝试把失败事实写到同目录的 `<session>.health.jsonl`。`/telemetry` 使用当前进程的内存账本；`npm run telemetry:report` 读取持久化快照。

## 采集链

```text
Pi lifecycle + observed-tool runtime facts
  -> TelemetryCallStore (tool_call_id keyed)
  -> session event ledger
  -> ordered JSONL writer
```

模块边界：

* `adapter.ts`：输入和结果的白名单投影、metric/reference 校验、投影异常隔离。
* `identity.ts`：分别计算行为、定义、遥测口径和有效配置 hash。
* `tool.ts`：组合参数修复、工具执行和 adapter 观测；不持久化事件。
* `channel.ts`：在工具扩展与 collector 间传递 preparation、approval、execute 和 observation 一阶事实。
* `runtime.ts`：按 `tool_call_id` 保存尚未完成的调用状态。
* `collector.ts`：把 Pi 生命周期转换为原始事件并维护严格递增的 `sequence`。
* `record.ts`：只组装单次调用 end 事实和 outcome，不做跨调用推断。
* `session-store.ts`：当前 session 的内存事件账本。
* `writer.ts`：串行追加主 JSONL，并独立记录 writer failure health sidecar。
* `jsonl-reader.ts`：在同一文件锁下读取稳定快照。

## 工具身份与运行 context

不存在 cohort hash。每个工具暴露和调用都保存四个互不替代的 hash：

* `behavior_hash`：工具行为源码、模型可见定义中的行为部分、execute 和 repair 配置；不包含 telemetry adapter。
* `definition_hash`：当前模型可见的 name、description、parameters 和 prompt guidelines。
* `telemetry_hash`：adapter 源码与 `projectRequested`、`projectExecuted`、`observeResult` 口径。
* `config_hash`：当前有效的行为配置；原始配置值不落盘。

修改 adapter 只改变 `telemetry_hash`，不会改变 `behavior_hash`。注册工具时必须把行为入口和遥测入口分开：

```ts
registerObservedTool(pi, {
  tool: inspectTool,
  repair: { pathFields: ["path"] },
  telemetry: inspectTelemetry,
  identity: {
    behaviorEntrypoints: ["src/inspect/index.ts"],
    telemetryEntrypoints: ["src/inspect/telemetry.ts"],
    config: () => loadInspectConfig(),
  },
});
```

非 o-pi observed tool 若无法取得实现或 adapter 源码，仍保存可靠的 `definition_hash`，其余对应字段明确写为 `unavailable`，不以 definition hash 冒充行为 hash。

以下运行维度保存在每条事件的 `context`，不参与上述身份 hash：

```jsonc
{
  "cwd": "/workspace",
  "model": { "provider": "openai", "id": "gpt-5.4" },
  "thinking_level": "high",
  "toolset": { "active": ["read", "grep"], "hash": "<sha256>" },
  "host": {
    "pi_version": "...",
    "mode": "tui",
    "platform": "linux",
    "arch": "x64",
    "node_version": "..."
  },
  "branch": { "leaf_id": "...", "lineage_hash": "<sha256>", "depth": 12 }
}
```

`branch` 只来自 Pi session tree 中可读取的 leaf 和 ancestry。不可获得的字段省略。

## 原始事件模型

每行是一个自描述 JSON 对象，公共 envelope 为：

```jsonc
{
  "event": "tool_call_start",
  "id": "<record-uuid>",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "session_id": "<session-id>",
  "sequence": 12,
  "context": {}
}
```

事件集合：

```text
session_start
turn_start
tool_call_start
tool_execution_start
tool_call_end
turn_end
collection_health
session_end
```

### turn_start

`turn_start.data.tools` 为当前 turn 的完整 exposure。每个 active tool 都包含 name、四类 hash，以及 definition token 估算的 `value` 和 `method`。因此可以确定某个具体行为实现在哪些 turn 可用但未被调用。

### tool_call_start

Pi 发出 `tool_execution_start` 后立即提交最小事实，不等待参数修复、adapter、工具执行或 `turn_end`：

```jsonc
{
  "event": "tool_call_start",
  "turn_id": "...",
  "tool_call_id": "call-1",
  "interaction_id": "...",
  "assistant_message_id": "...",
  "tool_batch_id": "...",
  "batch_size": 2,
  "batch_index": 0,
  "data": {
    "turn_index": 3,
    "tool": { "name": "read", "identity": { "behavior_hash": "..." } }
  }
}
```

进程崩溃、强制终止或永久挂起时，只有 start 而没有 end 即表示 unfinished，不会静默丢失。

### tool_execution_start

adapter 已完成 requested/executed 投影且工具真正进入 execute 时写入。它保存执行开始时间（envelope timestamp）、完整工具 identity、输入投影、preparation、已有 approval 和 `projection_failed`。验证失败或审批拒绝的调用可以没有该事件。

### tool_call_end

Pi 的最终 `tool_execution_end` 与 observed-tool runtime 事实通过 `tool_call_id` 汇合后写入，不等待 `turn_end`。内容包括：

* call start、execute start、execute end、execute duration 和 call duration；
* requested/executed input；
* preparation、approval、execution、projection failure；
* `ok`、开放字符串 `outcome`、结构化 error；
* 输出字符数、带 method 的 token 估算、截断状态；
* typed metrics 和 references。

当前 outcome 有 `success`、`tool_error`、`validation_error`、`blocked`、`timeout`、`aborted`、`exception` 和 `missing_result`。reader 必须允许未来字符串。

### 并行、interaction 与 lineage

一次 `agent_start` 生成一个 collector interaction id。一个 assistant message 中的全部 tool calls 共享 `assistant_message_id` 和 `tool_batch_id`，`batch_index` 保留 assistant source order。

采集层不声称 batch 一定并行，也不以结束顺序改写 source order。离线分析可用各调用真实的 execute 时间区间判断重叠；不同 branch 由 context 中的 lineage 标识区分。

### turn_end 与完整性

`turn_end` 保存：

* `expected_call_count`：assistant message 中声明的调用数；
* `observed_start_count`、`observed_end_count`；
* `unfinished_call_count`；
* `projection_failure_count`；
* `missing_start_ids`、`missing_end_ids`。

缺少 `turn_end` 本身表示 unfinished turn。正常 shutdown 时若仍有活动 turn，先写 `collection_health(issue=unfinished_turn)`，`session_end` 也保存 unfinished call 数。

恢复 session 时从历史最大 `sequence + 1` 继续，并检查无效 JSONL 和 sequence gap。`sequence` 是 collector 观察顺序；单 writer Promise 队列保持落盘顺序，跨 writer 通过单行文件锁串行追加。

## Metric 语义

metric 不允许只有 `value`。它是带判别字段的 union：

| kind | aggregation | value | unit |
| --- | --- | --- | --- |
| `categorical` | `count_by_value` | string/number/boolean | 无 |
| `count` | `sum` | 非负整数 | 必填 |
| `distribution` | `distribution` | number | 必填 |
| `duration` | `distribution` | 非负 number | `ms` 或 `s` |
| `bytes` | `sum` 或 `distribution` | 非负 number | `byte` |
| `ratio` | `mean` | 0..1 | `ratio` |

使用 `categoricalMetric`、`countMetric`、`distributionMetric`、`durationMetric`、`bytesMetric` 和 `ratioMetric` 构造。`exit_code`、`http_status`、start/end line 是 categorical numeric；行数是 count；耗时和字节数使用专用 kind。

collector 记录首次出现的 metric name schema；同一 session 后续若同名 metric 的 kind、aggregation 或 unit 冲突，会丢弃冲突值并写 `collection_health(issue=metric_schema_conflict)`。

## Reference 语义

reference 的最小字段为 `{ relation, kind, value }`，可选维度为：

```jsonc
{
  "relation": "candidate",
  "kind": "region",
  "value": "src/a.ts",
  "group": "primary",
  "global_rank": 3,
  "group_rank": 1,
  "sources": [
    { "id": "lsp-typescript", "family": "lsp", "source_rank": 2 },
    { "id": "repo-map-symbol", "family": "repo-map" }
  ],
  "resource": {
    "content_hash": { "algorithm": "sha256", "value": "..." },
    "snapshot": "...",
    "revision": "...",
    "start_line": 10,
    "end_line": 24
  }
}
```

raw source id 不归并；family 只是额外分层。不同 candidate group 可同时拥有独立 group rank；source rank 属于具体 source。无法可靠获得的 rank、snapshot、revision 或 hash 省略，不补默认值。

## Collection health 与 writer 失败

`collection_health` 可记录：`invalid_jsonl`、`sequence_gap`、`missing_start`、`missing_end`、`unfinished_turn`、`projection_failed`、`metric_schema_conflict` 和 `writer_failure`。

主 JSONL append 失败时，writer 把 failed event id/type/sequence 和非敏感 error name/code 写入 health sidecar。sidecar 的 envelope `sequence` 与 `data.details.health_sequence` 都指向失败的主事件序号。恢复 session 时主文件和 health sidecar 共同决定下一个 sequence，避免复用失败事件的编号。若连 sidecar 也不可写，`health_failed` 会增加；任何失败都不抛回 agent 主流程。

## 数据边界

adapter 只保存分析所需的白名单事实。路径、查询词、URL、Bash command 和小型标量可按工具需要保留。写入内容、编辑文本和 subagent 任务正文只保存 chars、lines 和 SHA-256。

不保存工具输出正文、diff、网页正文、搜索标题/摘要、诊断正文、subagent 输出或错误消息。未知可选字段允许扩展；缺失表示未采集，不伪装为 `0`、`false` 或空值。

没有历史格式兼容层：reader 只把本模型的 `tool_call_end` 当作完整调用。当前报告模块内部仍以 `cohort_id` 字段名承载由 `behavior_hash` 派生的分析分组键；这不是原始事件字段，也不会重新把 config、adapter 或运行 context 混入 hash。

## 报告

```bash
npm run telemetry:report
```

默认读取 sessions 目录并生成 CSV、JSON 和 HTML；`/telemetry` 对当前内存账本运行同一分析。报告只读原始记录，不回写推断。并行 batch 的相邻展示或 transition 仅是 source order，不表示执行依赖或因果关系。
