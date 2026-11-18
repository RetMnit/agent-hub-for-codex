# Agent Hub for Codex

- 本仓库维护 Codex 端 MCP、配置、看板和本地记录。实际执行使用独立安装的公共 dsh-bridge 和 codex-bridge 的客户端。按安装回执加载，调用方固定为 codex-agent-hub。
- 安装包在 plugins/agent-hub，marketplace 只安装该目录。MCP 与 supervisor 在状态目录运行，资源路径按 import.meta.url / ROOT 定位。Windows 回归覆盖真实 MCP/supervisor 存活时刷新同版本缓存。
- 只有用户明确选择相应后端并授权任务才能派发。两种后端按当前父聊天分别保存配置。续接沿用目标会话的参数；任务重试用原请求快照。普通 Codex 子代理走 Codex 原生机制。
- 状态保存在 ~/.codex/agent-hub，可用 CODEX_AGENT_HUB_STATE_DIR 覆盖。看板按当前父聊天隔离，按后端和子会话分组。任务记录保留 30 天，每个聊天至多 100 条已结束记录。清理仅操作本插件生成的记录。
- 被动监视使用 start:false。保持共享 Host 和桥接服务所有权，测试只用假桥接，无模型请求。安装及发布见 README。
- 发布前审查文件、更新版本并运行 npm.cmd test。发布使用 annotated tag，推送 main 和新标签，核对分支及标签解引用 SHA。既有标签不移动，不 force push。
