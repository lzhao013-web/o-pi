# `/permissions` 命令参考

`/permissions` 是权限系统的控制命令，支持交互控制台和直接子命令两种使用方式。

## 交互控制台

直接执行 `/permissions`（不带参数）时，打开可退出的交互控制台，菜单包括：

- Overview — 概览
- Tools — 工具权限
- MCP — MCP 工具权限
- Skills — Skill 权限
- Agents — Agent 权限
- File roots — 文件根目录
- Grants — 授权管理
- Audit — 审计
- Diagnostics — 诊断
- Edit policy — 编辑策略
- Profile — 权限倾向
- Maintenance — 维护模式
- Close — 退出

> 无 UI 环境（非 TTY）下默认退化为 `status` 查询；需要 editor 或确认的操作会拒绝并提示显式 flag。

## 通用选项

- 所有层级支持 `help`、`--help`、`-h` 查看帮助
- `--json` 输出结构化 JSON 响应（格式见下文）

### JSON 输出格式

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "status",
  "data": {}
}
```

错误也使用稳定结构输出，不会暴露 stack trace 或秘密内容。

---

## 完整命令树

### 帮助

```
/permissions help
```

显示命令帮助信息。

### 状态查询

```
/permissions status [--json]
```

显示当前权限系统的运行状态，包括策略加载情况、profile 等。

### 目录查询

```
/permissions catalog [tools|mcp|skills|agents|filter] [--json]
```

列出已注册的权限主体分类。可指定类别筛选。

### 决策模拟

```
/permissions explain <subject> [request...] [--json]
```

使用权限引擎模拟决策，返回结构化 trace。

- `<subject>`: 主体名称（如 `read`、`bash`）
- `[request...]`: 请求参数（如文件路径、命令内容）

> `explain` **只模拟决策**，不弹审批、不创建 lease、不创建 grant、不写真实执行审计。不会实际执行任何操作。

### 设置全局规则

```
/permissions set <subject> <allow|ask|deny> --global
```

为指定主体设置全局策略规则。

- `<subject>`: 主体名称
- `<allow|ask|deny>`: 规则值
- `--global`: 写入全局策略文件

### 重置规则

```
/permissions reset <subject> --global
```

删除指定主体的显式规则。

> **`reset` 不是 `ask`**。`reset` 删除显式规则，最终结果回到 profile、默认规则、文件 root、项目限制和 grant 的合成结果。

### 文件根目录管理

```
/permissions roots [--json]
/permissions roots add <path> <read-only|read-write> --session|--global
/permissions roots remove <root-id> --session|--global
```

管理文件访问根目录。

- `add`: 添加 root，指定路径和访问级别
  - `--session`: 仅当前会话生效
  - `--global`: 写入全局策略
- `remove`: 按 ID 移除 root

> **root 决定文件资源边界**。`read-only` root 允许读，写仍会 ask 或 deny；`read-write` root 允许普通读写，但不覆盖 hard protection。

### 授权管理

```
/permissions grants [--json]
/permissions grants show <grant-id>
/permissions grants revoke <grant-id>
/permissions grants clear --session|--persistent|--suspended|--all [--yes]
```

管理用户授权记录。

- `show`: 查看指定 grant 详情
- `revoke`: 撤销指定 grant
- `clear`: 清理符合条件的 grants
  - `--session`: 仅会话级 grant
  - `--persistent`: 持久 grant
  - `--suspended`: 已挂起 grant
  - `--all`: 全部

> **grant 不是 policy rule**。grant 来自用户审批，绑定主体、输入/资源 identity 和 generation；policy 是持久配置。session grant 随会话清除，persistent grant 保存在状态文件中。

### 权限倾向管理

```
/permissions profile [--json]
/permissions profile set <cautious|standard|read-only|unrestricted> --session|--global
/permissions profile reset
```

管理权限倾向配置。

- `set`: 设置倾向级别
  - `--session`: 只影响当前 runtime（session profile）
  - `--global`: 修改全局策略文件（global profile）
- `reset`: 恢复默认倾向

> **session profile 不是 global profile**。`profile set ... --session` 只影响当前 runtime；`--global` 修改全局策略文件。

#### 倾向级别

| 级别 | 影响 |
|---|---|
| `cautious` | 保守模式，未配置时倾向询问 |
| `standard` | 标准模式，平衡效率与安全 |
| `read-only` | 只读模式 |
| `unrestricted` | 将普通 ask 变为 allow（不覆盖 hard-deny、policy-error、显式 deny、项目 deny、身份失效或路径解析错误） |

> **unrestricted 风险高**：它把普通 ask 变为 allow，但不覆盖 hard-deny、policy-error、显式 deny、项目 deny、身份失效或路径解析错误。

### 策略管理

```
/permissions policy validate [global|project|all] [--json]
/permissions policy doctor [--json]
/permissions policy reload
/permissions policy edit [global|project]
/permissions policy show [global|project|effective] [--json]
```

策略文件的验证、诊断、重载、编辑和查看。

- `validate`: 验证策略文件语法和语义
  - `global`: 仅全局策略
  - `project`: 仅项目策略
  - `all`: 全部（默认）
- `doctor`: 自动诊断并修复可修复的问题
- `reload`: 重新加载策略文件
- `edit`: 在编辑器中打开策略文件
  - `global`（默认）: 编辑全局策略
  - `project`: 编辑项目策略
- `show`: 显示策略内容
  - `global`: 全局策略
  - `project`: 项目策略
  - `effective`（默认）: 当前生效的合成策略

> 配置损坏时 runtime **fail closed**，控制台仍可打开；使用 `policy validate`、`policy doctor`、`policy edit`、`policy reload` 修复。

### 审计

```
/permissions audit [--json]
/permissions audit tail [count]
/permissions audit show <entry-id>
```

查看审计日志。

- `tail [count]`: 查看最近 N 条审计记录
- `show <entry-id>`: 查看单条审计记录详情

### 维护模式

```
/permissions maintenance
/permissions maintenance on
/permissions maintenance off
```

管理维护模式。

> **maintenance 不是 unrestricted**。maintenance 只在当前会话内临时允许注册文件工具修复权限控制面；认证凭据、trust 数据、审计日志和持久 grant 仍受保护。只能由用户 slash command 开启，不能由普通工具开启。

---

## 常见示例

```text
/permissions status
/permissions catalog tools
/permissions explain read "~/datasets/a.csv"
/permissions explain bash "git push origin main"
/permissions set edit ask --global
/permissions reset edit --global
/permissions roots add "~/datasets" read-only --session
/permissions grants clear --session --yes
/permissions profile set read-only --session
/permissions policy doctor
/permissions policy edit global
```

## 关键语义总结

| 概念 | 说明 |
|---|---|
| `reset` ≠ `ask` | `reset` 删除显式规则，回退到合成结果 |
| allow ≠ 最终 allow | 文件 root、项目策略、hard protection 等下游规则仍可拒绝 |
| grant ≠ policy rule | grant 来自用户审批（绑定 identity 和 generation）；policy 是持久配置 |
| session profile ≠ global profile | `--session` 仅影响当前 runtime；`--global` 持久化到策略文件 |
| root 决定文件边界 | `read-only` 允许读不保证写；`read-write` 不覆盖 hard protection |
| explain 只模拟 | 不弹审批、不创建 lease/grant、不写审计日志 |
| maintenance 非 unrestricted | maintenance 仅允许修复工具权限控制面，核心数据仍受保护 |
| unrestricted 有边界 | 不覆盖 hard-deny、policy-error、显式 deny、项目 deny、身份失效、路径解析错误 |
