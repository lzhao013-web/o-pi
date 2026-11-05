# 查询编排器

独立 Pi 扩展，注册 `orchestrate` 工具，不改变现有工具选择。仅调用当前可调用的 `ls`、`find`、`grep`、`read`，其中 `read` 仅接受文本结果。

## 加载

在仓库根目录执行：

```bash
opi -e ./plugins/orchestrator/index.ts
```

如果配置中显式指定了工具集合，需要加入 `orchestrate` 和计划使用的查询工具。例如：

```bash
opi -e ./plugins/orchestrator/index.ts --tools orchestrate,find,grep,ls,read
```

也可把本目录复制到 `~/.pi/agent/extensions/orchestrator/`，或通过 settings 的 `extensions` 指定 `index.ts` 路径。插件只依赖宿主提供的 Pi SDK 和 TypeBox。

## 参数

```json
{
  "stages": [
    {
      "mode": "serial",
      "calls": [
        { "id": "files", "tool": "find", "args": { "query": "AGENTS.md" } }
      ]
    },
    {
      "mode": "parallel",
      "calls": [
        {
          "id": "instructions",
          "tool": "read",
          "map": { "from": "files.data.matches", "limit": 6 },
          "args": { "path": { "$ref": "$item.path" } },
          "when": { "op": "nonempty", "ref": "files.data.matches" }
        },
        { "id": "listing", "tool": "ls", "args": {} }
      ]
    }
  ],
  "concurrency": 3
}
```

- 阶段依次执行。`serial` 阶段逐个调用，`parallel` 阶段限并发调用，阶段完成后才进入下一阶段。
- 每个计划最多预留 32 次查询，普通调用计 1 次，映射按 `limit` 计数。执行前按此上界检查，不按实际执行次数放宽限制。并发上限为 1–4，默认 4。
- `id` 全局唯一，以 ASCII 字母开头，后接字母、数字、`_` 或 `-`，最多 32 个字符。
- `args` 沿用原工具参数。`{"$ref":"id.data.field.0.field"}` 复制前序结果中的值，数字表示数组下标。引用对象只能有 `$ref` 一个字段，不支持字符串插值。
- 串行调用可引用前面的调用。并发调用只能引用前面阶段的结果，不能引用同阶段的调用。
- 引用路径从 `id.data` 开始，只读取自有字段，不支持点号出现在字段名中的情况。

### 有界映射

`map` 将一次查询模板应用于前序结果数组的前 N 项：

- `from` 是结果数组路径，例如 `files.data.matches`。来源只能引用已完成步骤，不能引用当前项或同阶段的并发调用。
- `limit` 必填，范围为 1–32。选取来源数组开头至多 `limit` 项，不排序或去重。
- `args` 中的 `{"$ref":"$item.path"}` 复制当前项字段，`{"$ref":"$item"}` 复制整项。当前项仅在映射参数中可用，也可同时引用其他前序结果。
- `when` 在读取来源数组前判断一次，控制整个映射，不逐项判断。
- 映射项遵循阶段模式。串行阶段逐项执行，并发阶段中所有映射项与普通调用共享 `concurrency`，不会为每个映射单独创建并发额度。
- 空数组成功返回零项，不发起查询。来源不是数组或项字段缺失时明确报错，不转换为空数组。

### 条件

`when` 控制单次调用。条件不满足时跳过，不解析该调用的参数引用。

| `op` | 参数 | 语义 |
| --- | --- | --- |
| `exists` | `ref` | 字段存在，包括值为 `null`。字段缺失时为 false |
| `nonempty` | `ref` | 字符串或数组长度大于 0 |
| `eq` | `ref`、`value` | 字符串、数字、布尔值或 `null` 严格相等，不转换类型 |

`nonempty` 和 `eq` 遇到缺失字段或不支持的类型时报错。引用被跳过步骤的 `data` 也属于字段缺失。

## 结果

模型可见文本和 `structuredContent` 返回同一个 JSON 对象。`steps` 始终按计划顺序排列，不受并发完成顺序影响。

| 整体 `status` | 语义 |
| --- | --- |
| `completed` | 流程完成，允许条件跳过 |
| `failed` | 查询、条件或参数引用失败 |
| `cancelled` | 外部取消，已完成结果保留 |
| `invalid` | 执行前发现计划非法，没有执行任何查询，返回 `error` 和空 `steps` |

参数不符合工具 schema 时由 SDK 直接拒绝，不进入计划执行。`invalid` 用于重复 ID、调用总量超限、不可调用工具、格式错误的引用，以及引用自身、后续调用或同阶段并发调用。

普通步骤结果为以下三种之一：

```jsonl
{"id":"files","tool":"find","status":"ok","data":{"matches":[],"total_matches":0,"truncated":false}}
{"id":"body","tool":"read","status":"error","error":{"code":"tool_error","message":"File not found"}}
{"id":"later","tool":"ls","status":"skipped","reason":"previous_error"}
```

- `ok.data` 优先使用原工具的结构化结果，否则使用原文本。保留截断标记和部分范围错误信息。空查询结果仍是成功。
- `error` 提供 `code` 和 `message`。错误码包括 `tool_error`、`missing_reference`、`invalid_arguments`、`condition_type` 和 `unsupported_result`。
- `skipped.reason` 为 `condition_false`、`previous_error` 或 `cancelled`。跳过不是执行失败。
- 发现错误后不再启动新调用。已启动的并发调用等待结束并保留结果。剩余调用标记为 `previous_error`。
- 取消传递给正在运行的调用，未启动的调用标记为 `cancelled`。已经运行的调用仍按实际结果记录为 `ok` 或 `error`。整体 `cancelled` 优先于 `failed`。
- 图片和 PDF 读取结果标记为 `unsupported_result`，不将 Base64 媒体数据放入编排器结果。

### 映射结果

映射返回 `map.total` 和 `map.truncated`，分别表示收到的源数组长度、是否因 `limit` 只处理了前缀。`data` 按源数组顺序保存逐项结果，不随完成顺序变化：

```json
{
  "id": "instructions",
  "tool": "read",
  "status": "ok",
  "map": { "total": 3, "truncated": true },
  "data": [
    { "id": "instructions/0", "tool": "read", "status": "ok", "data": "first file content" },
    { "id": "instructions/1", "tool": "read", "status": "ok", "data": "second file content" }
  ]
}
```

子项 ID 为 `<映射 ID>/<从 0 开始的下标>`。后续步骤通过 `instructions.data.0.data` 引用首项结果，不能将子项 ID 当成独立步骤引用。

全部成功或源数组为空时，映射为 `ok`。任一项失败时映射为 `error`，错误码为 `map_failed`。没有失败项但因前序失败或取消而未全部执行时，映射为 `skipped`。这些聚合结果都保留逐项 `data`，包括已完成、失败和未执行的项。条件为 false 或来源解析失败时不展开子项，沿用普通步骤的跳过或错误格式。来源类型错误使用 `map_source_type`。

嵌套调用经 SDK 的参数校验、权限检查和结果钩子，保存在父调用的 `nestedCalls` 中。编排器只提供单层、有数量上限的映射，不执行任意脚本、嵌套映射、其他循环或自动重试，不提供回滚。

## Web/Desktop 执行视图

聊天中的 `orchestrate` 调用显示为阶段式流程。串行操作纵向连接，并发操作在同一组内并列，窄容器自动换行，手机视口使用单列。

节点展示步骤 ID、工具、目标、状态、条件和跳过原因。映射组展示源数组、选取数量和逐项状态，未展开来源前只显示计划上限，不推测子项。点击节点查看调用参数、结果或错误。失败节点默认展开，手动折叠选择优先。历史记录可恢复流程和已保存的耗时。

执行器通过 `onUpdate` 报告完整步骤快照，包括等待、运行、成功、失败和跳过。界面不根据嵌套调用顺序推测步骤状态。没有终态的步骤显示为未知，不补造成功或跳过。

`details` 保存界面使用的进度和 `invocation` 元数据。调用参数是结果引用解析后交给 SDK 的入参，SDK 仍执行原工具的参数准备、校验和权限检查。`durationMs` 包含等待、校验和执行耗时。模型可见文本与 `structuredContent` 不包含 `invocation`，继续使用上面的结果格式。

插件修改后可通过 `/reload` 重载。执行视图属于 GUI 程序，修改后需要重新构建并重启 Web/Desktop，单独重载插件不会更新已打包界面。

## 验证

```bash
bunx vitest run tests/plugins/orchestrator.test.ts tests/plugins/orchestrator-map.test.ts tests/plugins/orchestrator-session.test.ts tests/gui/frontend/features/chat/tools/orchestrator-ui.test.ts
bun run typecheck
bun scripts/build.mjs web
bunx playwright test --config playwright.gui.config.ts tests/gui/frontend/features/chat/tools/orchestrator.e2e.ts
```
