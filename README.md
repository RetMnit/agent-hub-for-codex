# Agent Hub for Codex

Agent Hub 在一个本地看板中管理 DSH 和独立 Codex 任务。启用插件后，普通的 Codex 子代理请求默认经 Agent Hub 派发。可在「设置 → Codex → Codex 子代理路由」中为当前聊天切换到原生 Codex，也可为单次任务明确指定路径。

## 本地安装

需要 Windows、Node.js 22+、Codex 和 Microsoft Edge。使用哪个后端，就安装哪个公共运行时。两个后端可以独立安装。

- [dsh-bridge](https://github.com/RetMnit/dsh-bridge/tree/v0.4.0) v0.4.0。在桥接检出目录运行 `node setup.mjs`，再完全退出并重新打开 DSH Desktop 加载公共 bundle。
- [codex-bridge](https://github.com/RetMnit/codex-bridge/tree/v0.4.0) v0.4.0。在桥接检出目录运行 `node setup.mjs`。任务使用已配置的本地 Codex CLI 登录。

从 GitHub 的发布标签安装。若已登记本地检出或其他标签，先运行 `codex plugin marketplace remove codex-agent-hub-tools`。CLI 可以使用 Codex Desktop 自带的 `codex.exe`。

```powershell
codex plugin marketplace add https://github.com/RetMnit/agent-hub-for-codex.git --ref v0.8.2
$installed = codex plugin add agent-hub@codex-agent-hub-tools --json | ConvertFrom-Json
node (Join-Path $installed.installedPath 'server/setup.mjs')
```

Setup 初始化 Agent Hub 自身目录和访问令牌。首次可用 `CODEX_AGENT_HUB_WORKSPACE` 指定已有默认工作目录。插件使用 `~/.codex/agent-hub`，可用 `CODEX_AGENT_HUB_STATE_DIR` 覆盖。桥接通过 `~/.dsh-bridge/install.json` 和 `~/.codex-bridge/install.json` 加载，对应环境变量是 `DSH_BRIDGE_STATE_DIR` 和 `CODEX_BRIDGE_STATE_DIR`。在新聊天中选择 Agent Hub 插件即可使用。

升级时，从新安装目录运行 Setup。旧版 Agent Hub 服务空闲时，Setup 会将其切换到新版。若提示旧服务还有连接或任务，关闭任务面板、等待调用结束后重跑 Setup。新聊天会加载新版技能和工具说明。

## 工作流程

- “打开 Agent Hub 的 DSH 设置”或“打开 Agent Hub 的 Codex 设置”。一个 Edge 应用窗口内有「任务」和「设置」。每个父聊天可以分别保存两种后端的设置。
- DSH 可选桌面／后台、登记工作区、预设、按提供方分组的模型、推理档位和权限。独立 Codex 可选项目、模型、推理档位和沙箱。工作区菜单列出已登记的目录，也可选择「自定义目录」。首次配置优先匹配当前聊天的登记目录，其次使用 Codex 当前项目或插件默认目录。列表按后端与运行方式读取。目录离线时可保留表单值，点击「读取可选项」可以连接对应后端。
- 设置页持续显示首次配置、已保存或有未保存修改。点击「放弃修改」可恢复到上次保存的设置，首次配置则恢复到预填值。
- DSH 沿用默认模型时，可以直接选该模型支持的推理档位。选中具体档位会同时选中该模型。沿用其他预设时，先明确选择模型再设置档位。任务卡片优先显示 DSH 请求实际使用的模型和档位。
- Agent Hub 按用户请求用已保存的配置新建一项或多项任务。DSH 派发须明确指定。修改配置影响后续新建。以同一 requestId 重试会重用初次派发的配置快照。
- 续接沿用目标会话原来的设置，可以直接续接。DSH 需要指定原来的桌面／后台方式。同一个子会话的多轮任务在同一卡片。
- 独立 Codex 在后台运行，可以经明确授权向运行中的回合追加消息。任务结束后可以在 Codex 打开线程。打开会持有该线程的写入锁，Agent Hub 要等桌面应用完全退出才能续接。后台执行采用 Codex Bridge 的 `approvalPolicy: "never"`。
- 手动重开看板使用 `hub_open`。关闭或最小化窗口时后台任务继续运行，恢复前台重新读取状态。状态与答案只显示在所属父聊天的看板。

## 工具与记录

- `hub_configure/configuration/catalog/sessions/doctor` 管理设置与查询。
- `hub_start/start_many/resume` 负责派发，`hub_status/wait/result/cancel/steer` 负责当前聊天的任务生命周期。`hub_list` 每个子会话返回一条摘要。
- 公共桥接调用方标识为 `codex-agent-hub`。看板以 Edge 应用模式打开。Windows 上的本地 stdio MCP Apps 面板尚待验证。
- 任务已结束的交互保留 30 天，每个父聊天最多 100 条。清理仅作用于 Agent Hub 的记录。共享桥接仍管理它自己的记录和原始会话。

## 开发验证

```powershell
$env:CODEX_TEST_CLI = (Get-Command codex).Source
npm.cmd test
node tests/panel-background-live.mjs
```

测试使用临时状态和假桥接。指定 `CODEX_TEST_CLI` 会用临时 Codex 配置验证安装及 Windows 缓存刷新。第二条测试命令会短暂显示隔离的 Edge 窗口，验证两种后端的真实表单和窗口恢复。两套测试均无需模型请求。

插件源码位于 `plugins/agent-hub/`。从本地检出安装用于开发验证时，在仓库根目录执行 `codex plugin marketplace add .` 注册源，再按安装命令添加插件。旧版 DSH Subagent 的切换说明见 [迁移说明](docs/migration.md)。
