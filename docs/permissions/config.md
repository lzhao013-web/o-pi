# 配置文件 `permissions.jsonc`

策略文件使用 JSONC（JSON with Comments）格式。写入由事务服务保证原子性和完整性。

## 文件位置

| 路径 | 说明 |
|------|------|
| `~/.pi/agent/permissions.jsonc` | **全局策略**，始终加载 |
| `<workspace>/.pi/permissions.jsonc` | **项目策略**，仅 trusted 项目加载，只能收紧全局策略 |

> 项目策略的约束见[项目策略限制](#项目策略限制)。

## 完整结构

```jsonc
{
  "$schema": "./permissions.schema.json",
  "version": 1,
  "profile": "standard",
  "files": {
    "roots": [
      { "path": "${workspace}", "access": "read-write" },
      { "path": "~/datasets", "access": "read-only" }
    ],
    "outsideRoots": {
      "read": "ask",
      "write": "ask"
    }
  },
  "tools": {
    "default": "ask",
    "items": {
      "read": "allow",
      "edit": "allow",
      "bash": {
        "default": "ask",
        "commands": {
          "allow": ["git status"],
          "ask": ["git push *"],
          "deny": ["sudo *"]
        }
      }
    }
  },
  "mcp": {
    "default": "ask",
    "servers": {}
  },
  "skills": {
    "default": "ask",
    "items": {}
  },
  "agents": {
    "default": "ask",
    "items": {}
  },
  "audit": {
    "enabled": true
  }
}
```

## `allow` / `ask` / `deny` 通用说明

| 值 | 含义 |
|---|---|
| `"allow"` | 允许调用（但仍受更严格的显式规则、项目策略和 hard protection 限制） |
| `"ask"` | 每次调用前询问用户 |
| `"deny"` | 拒绝调用 |

> 同一决策层按 `deny > ask > allow` 合成。主体 `allow` 不会覆盖文件、命令、项目策略或 hard protection 中更严格的结论。

## 顶层字段

### `$schema`

- **类型**: `string`
- **说明**: JSON Schema 文件路径，用于编辑器的验证和自动补全。

### `version`

- **类型**: `number`
- **说明**: 配置格式版本。当前仅支持 `1`。

### `profile`

- **类型**: `string`
- **说明**: 全局权限倾向，影响未显式配置的主体的默认行为。
- **可选值**:

| 值 | 含义 |
|---|---|
| `"cautious"` | 保守模式，未配置时倾向询问 |
| `"standard"` | 标准模式，平衡效率与安全 |
| `"read-only"` | 只读模式，写操作倾向拒绝 |
| `"unrestricted"` | 低限制模式，仅影响没有显式规则时的默认值 |

## `files`

控制文件工具对文件系统资源的访问。

### `files.roots`

- **类型**: `array`
- **说明**: 定义文件根目录及其访问级别。root 加载时会 canonicalize，目标必须是已存在目录；超出 root 的操作受 `outsideRoots` 约束。
- **元素结构**:

```jsonc
{
  "path": "${workspace}",
  "access": "read-write"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `path` | `string` | 路径，支持 `${workspace}` 变量 |
| `access` | `"read-only"` \| `"read-write"` | `read-only` 允许读，写操作仍会 ask 或 deny；`read-write` 允许普通读写，但不覆盖 hard protection |

重叠 root 匹配规则：

1. 匹配所有 root。
2. 选择 canonical path 最长的 root。
3. 长度相同时选择更严格的权限：`read-only` 优先于 `read-write`。

`policy doctor` 会报告重复 root、被完全覆盖的 root、权限不同的重叠 root，以及无法 canonicalize 的 root。

### `files.outsideRoots`

- **类型**: `object`
- **说明**: 在 roots 覆盖范围之外访问文件时的默认行为。

```jsonc
{
  "read": "ask",
  "write": "ask"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `read` | `"allow"` \| `"ask"` \| `"deny"` | 读取 roots 外文件时的规则 |
| `write` | `"allow"` \| `"ask"` \| `"deny"` | 写入 roots 外文件时的规则 |

## `tools`

控制内建工具（`ls`、`read`、`edit`、`bash` 等）的调用权限。

### `tools.default`

- **类型**: `string`
- **说明**: 所有未在 `items` 中单独配置的工具的默认规则。
- **可选值**: `"allow"` \| `"ask"` \| `"deny"`

### `tools.items`

- **类型**: `object`
- **说明**: 按工具名逐一配置规则。工具名为 key，值为以下之一。

#### 简单工具（如 `read`、`edit`）

直接取值 `"allow"` \| `"ask"` \| `"deny"`。

```jsonc
"read": "allow",
"edit": "allow"
```

#### `bash` 命令级控制

`bash` 支持按命令模式细粒度控制：

```jsonc
"bash": {
  "default": "ask",
  "commands": {
    "allow": ["git status"],
    "ask": ["git push *"],
    "deny": ["sudo *"]
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `default` | `"allow"` \| `"ask"` \| `"deny"` | bash 调用的默认规则 |
| `commands.allow` | `string[]` | 匹配的命令直接允许（支持 glob） |
| `commands.ask` | `string[]` | 匹配的命令需要询问用户 |
| `commands.deny` | `string[]` | 匹配的命令直接拒绝 |

命令匹配优先级：**deny > ask > allow > default**。

## 决策合成顺序

1. 不可覆盖约束：hard protection、`read-only` 写限制、项目策略限制。
2. 全局显式策略：工具规则、命令规则、文件规则、root/outsideRoots。
3. Profile 默认值：仅在前两层没有结论时使用。

同一层始终按 `deny > ask > allow` 合成。

## `mcp`

MCP 工具策略模型字段。当前尚未接入完整 MCP 注册与授权执行链，`/permissions` 不会把这些配置展示为已受控主体。

### `mcp.default`

- **类型**: `string`
- **说明**: 所有 MCP server 及其中未单独配置的工具的默认规则。
- **可选值**: `"allow"` \| `"ask"` \| `"deny"`

### `mcp.servers`

- **类型**: `object`
- **说明**: 按 MCP server 名配置。

```jsonc
{
  "some-server": {
    "default": "ask",
    "tools": {
      "tool-name": "allow"
    }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `default` | `"allow"` \| `"ask"` \| `"deny"` | 该 server 的默认规则 |
| `tools` | `object` | 按工具名配置规则，值取 `"allow"` \| `"ask"` \| `"deny"` |

## `skills`

Skill 策略模型字段。当前尚未接入完整 Skill 注册与授权执行链，`/permissions` 不会把这些配置展示为已受控主体。

### `skills.default`

- **类型**: `string`
- **说明**: 所有未在 `items` 中单独配置的 Skill 的默认规则。
- **可选值**: `"allow"` \| `"ask"` \| `"deny"`

### `skills.items`

- **类型**: `object`
- **说明**: 按 Skill 名配置规则。每个 Skill 取值 `"allow"` \| `"ask"` \| `"deny"`。

## `agents`

Agent 策略模型字段。当前尚未接入完整 Agent 注册与授权执行链，`/permissions` 不会把这些配置展示为已受控主体。

### `agents.default`

- **类型**: `string`
- **说明**: 所有未在 `items` 中单独配置的 Agent 的默认规则。
- **可选值**: `"allow"` \| `"ask"` \| `"deny"`

### `agents.items`

- **类型**: `object`
- **说明**: 按 Agent 名配置规则。每个 Agent 取值 `"allow"` \| `"ask"` \| `"deny"`。

## `audit`

审计配置。

### `audit.enabled`

- **类型**: `boolean`
- **说明**: 是否启用审计日志记录。启用时所有权限决策会被记录到审计日志文件。
- **可选值**: `true` \| `false`

## 项目策略限制

项目策略文件（`<workspace>/.pi/permissions.jsonc`）只能**收紧**权限，不能放宽：

| 允许的操作 | 拒绝的操作 |
|---|---|
| 设置 `deny` | 设置 `profile` 字段 |
| 设置 `ask` | 设置 `files.roots` 字段 |
| 工具/主体降权（allow → ask/deny, ask → deny） | 设置 `files.outsideRoots` 字段 |
| | 设置任何 `allow` |
| | 设置 `audit` 字段 |
