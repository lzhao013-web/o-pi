# 权限系统

本系统控制通过权限注册表接入的 Pi 工具调用，包括 `ls`、`read`、`edit`、`bash`。MCP tool、Skill、Agent 目前只保留策略模型，尚未接入完整注册与授权执行链。它不是 OS 沙箱；扩展代码和已获准启动的 shell 子进程仍拥有当前用户的系统权限。

## 功能定位

- 定义已接入工具的调用权限策略
- 提供策略配置、审批、审计的完整生命周期
- 运行态 fail closed：配置损坏时拒绝调用，控制台仍可打开修复

## 相关文件

| 文件 | 作用 |
|------|------|
| `~/.pi/agent/permissions.jsonc` | 全局策略文件 |
| `<workspace>/.pi/permissions.jsonc` | 项目策略文件，仅 trusted 项目加载，只能收紧 |
| `~/.pi/agent/permission-state/grants.json` | 持久授权记录 |
| `~/.pi/agent/permission-state/audit.jsonl` | 审计日志 |
| `~/.pi/agent/permissions.schema.json` | 策略 JSON Schema |

> 策略使用 JSONC 格式。配置写入由 `/permissions` 的事务服务完成：局部 AST 修改、保留注释、严格验证、临时文件写入、平台允许时 fsync、原子 rename、reload。并发修改会报 `PERMISSION_POLICY_CONFLICT`，不会覆盖磁盘上的新内容。

## 不可覆盖保护（Hard Protection）

以下资源不可被配置、profile、session grant、persistent grant 或审批覆盖：

- `~/.ssh/**`
- `~/.gnupg/**`
- Pi auth/trust 文件
- 权限配置、权限 schema、权限状态、审计日志
- 权限扩展代码

服务初始化时会为这些路径构建 hard protection 快照：存在的路径同时记录 lexical path 和 canonical path；不存在的路径记录最深已存在父目录 identity 和剩余路径段。检查时会比较资源 lexical path、canonical path 和 symlink chain，避免保护路径自身为符号链接时被绕过。

## 策略合成

权限决策先应用不可覆盖约束和项目策略限制，再合成全局显式策略；只有没有显式结论时才使用 profile 默认值。同一层按 `deny > ask > allow` 取最严格结论。

## 审计

审计记录主体、policy/registry generation、operation、脱敏资源、策略效果、最终决策、来源、grant/lease/error。不会记录文件内容、diff 全文、环境变量值、凭据、完整 prompt 或 token。

## 审批

审批框展示工具名、注册来源、来源 identity、每个结构化资源的操作、read/write、input/lexical/canonical path、存在性、符号链接链、触发 ask 的策略 trace，以及 session/persistent grant 的实际作用范围。`Always allow` 只有能生成安全持久 scope 时出现。

## Grants

Grant 使用结构化 scope 持久化：文件 scope 绑定 path、operation 和 read/write access；命令使用 exact fingerprint。无法生成安全持久 scope 的请求不会显示 Always allow。

工具 grant 还绑定 Pi `getAllTools()` 返回的实际注册来源身份。身份由规范化源路径、包名、包版本、源文件内容哈希和可选 `package.json` 中 `pi.identity`/`pi.manifestIdentity` 生成；源文件内容或同一路径实现被替换后，旧 grant 不再命中。

## 下一步

- [配置文件详解](config.md) — `permissions.jsonc` 各字段含义与取值
- [命令参考](command.md) — `/permissions` 命令完整用法
