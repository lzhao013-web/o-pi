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
| `"allow"` | 允许调用（但仍可能被文件 root、项目策略、hard protection 等下游规则拒绝） |
| `"ask"` | 每次调用前询问用户 |
| `"deny"` | 拒绝调用 |

> 主体 `allow` 不代表最终一定 allow。文件 root、项目策略、hard protection、身份失效、策略错误仍可导致 ask、deny 或 hard-deny。

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
| `"unrestricted"` | 低限制模式，将普通 ask 变为 allow（不覆盖 hard-deny、显式 deny、策略错误等） |

## `files`

控制文件工具对文件系统资源的访问。

### `files.roots`

- **类型**: `array`
- **说明**: 定义文件根目录及其访问级别。工具在 root 内操作时按根级别执行；超出 root 的操作受 `outsideRoots` 约束。
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

命令匹配优先级：**deny > allow > ask > default**。

## `mcp`

控制 MCP 工具的调用权限。

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

控制 Skill 的调用权限。

### `skills.default`

- **类型**: `string`
- **说明**: 所有未在 `items` 中单独配置的 Skill 的默认规则。
- **可选值**: `"allow"` \| `"ask"` \| `"deny"`

### `skills.items`

- **类型**: `object`
- **说明**: 按 Skill 名配置规则。每个 Skill 取值 `"allow"` \| `"ask"` \| `"deny"`。

## `agents`

控制 Agent 的调用权限。

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
