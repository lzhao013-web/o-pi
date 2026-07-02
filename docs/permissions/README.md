# 权限系统

本系统控制通过权限注册表接入的 Pi 工具调用，包括 `ls`、`read`、`edit`、`bash`，并为 MCP tool、Skill、Agent 保留同一主体模型。它不是 OS 沙箱；扩展代码和已获准启动的 shell 子进程仍拥有当前用户的系统权限。

## 功能定位

- 定义工具、MCP、Skill、Agent 的调用权限策略
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

## 审计

审计记录主体、policy/registry generation、operation、脱敏资源、策略效果、最终决策、来源、grant/lease/error。不会记录文件内容、diff 全文、环境变量值、凭据、完整 prompt 或 token。

## 下一步

- [配置文件详解](config.md) — `permissions.jsonc` 各字段含义与取值
- [命令参考](command.md) — `/permissions` 命令完整用法
