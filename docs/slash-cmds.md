# Slash commands

本页只记录 `agent/extensions/` 中通过 `pi.registerCommand()` 注册的命令。命令名注册时不带 `/`，在 Pi 输入框中以 `/命令名` 调用。

## `/tools`

来源：`agent/extensions/cmd-slash-tools.ts`

用途：在 TUI 中打开工具开关列表，启用或禁用当前会话可用工具。

用法：

```text
/tools
```

行为：

- 仅支持 TUI 模式；非 TUI 模式会提示错误。
- 列出 `pi.getAllTools()` 返回的所有工具。
- 切换后立即调用 `pi.setActiveTools()` 生效。
- 当前选择会写入会话分支的 `tools-config` 自定义条目；会话开始或切换分支时按当前分支恢复。
- 恢复时会过滤已不存在的工具名。

## `/system`

来源：`agent/extensions/system-prompt.ts`

用途：在 TUI 中只读查看当前合成后的 system prompt。

用法：

```text
/system
```

行为：

- 仅支持 TUI 模式；非 TUI 模式直接返回。
- 使用 `ctx.getSystemPromptOptions()` 重新构建本项目实际发送给模型的 system prompt。
- 通过 custom UI 展示，不写入会话历史。
- 关闭：`Esc`、`q` 或 `Enter`。
- 滚动：方向键、`PageUp`、`PageDown`、`Home`、`End`。
