# 从 DSH Subagent 切换到 Agent Hub

Agent Hub 的插件 ID 为 `agent-hub@codex-agent-hub-tools`，工具使用 `hub_*`，自己的状态目录为 `~/.codex/agent-hub`。按 [README](../README.md) 安装和初始化后，在新聊天里选择 Agent Hub 并保存需要的后端配置。

旧版 DSH Subagent 的安装和运行记录属于 `dsh-subagent@dsh-subagent-tools` 与 `~/.codex/dsh-subagent`。旧会话在 DSH 中仍可用。Agent Hub 可以通过目标会话 ID 续接，使用目标本身的参数。确认旧版任务都已结束后，可按需通过 Codex 插件管理移除旧版。

公共 DSH 和 Codex 桥接各自独立安装。安装 Agent Hub 不需要调整 DSH profile。历史回归见 [验证记录](verification.md)。
