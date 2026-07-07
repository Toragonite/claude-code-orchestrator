# Claude Code Orchestrator

[English](README.md) | [한국어](README.ko.md) | **简体中文**

![Claude Code Orchestrator — 面向 Claude Code 的多账号并行调度](media/screenshots/banner.png)

> 非官方扩展 — 与 Anthropic 无关，也未获其认可。曾用名：*Fable Orchestrator*。

把你现有的 **Claude Code** 面板变成多账号编排器。像平常一样与主会话对话；它负责设计与验证，并通过 MCP 调度工具把实现工作**并行**分发给工作账号（Opus / Sonnet — 以及计费防护之后的 Fable）。内置按账号的用量统计、配额感知的自动故障转移，以及实时仪表盘。

```
Claude Code 面板（主账号 — 编排器）                ← 照常使用
   │  MCP 工具: dispatch_tasks / dispatch_task / list_workers / orchestrator_briefing
   ▼
cco-dispatch MCP 服务器（注册在工作区 .mcp.json）
   │  以 CLAUDE_CONFIG_DIR=<worker 目录> 运行 Claude Code CLI（同一工作区）
   ├──────────────┬──────────────┐
   ▼              ▼              ▼
worker w1       worker w2      worker w3
(opus-4-8)      (sonnet-5)     (opus-4-8)
```

核心思路：**账号 = 一个 Claude Code 配置目录。** 每个 worker 拥有自己的 `~/.claude-<名称>` 目录；登录一次后，保存的登录状态会被持续复用。扩展本身从不接触令牌或凭据 — 登录与刷新完全由 Claude Code 处理。

## 截图

*编排器会话制定计划、通过 `orchestrator_briefing` 报到，并把实现工作分发给各 worker：*

![在 Claude Code 面板中调度的编排器会话](media/screenshots/panel.png)

*带分窗口用量的 worker 账号，以及实时任务流：*

![Worker Accounts 与 Dispatched Tasks 视图](media/screenshots/sidebar.png)

*仪表盘：统计卡片、活动图表、各 worker 用量，以及包含 frontier 计费防护的设置面板：*

![编排器仪表盘](media/screenshots/dashboard.png)

## 环境要求

- VS Code 1.90+
- 已安装并登录 [Claude Code](https://claude.com/claude-code) CLI（主账号）
- 一个或多个用作 worker 的额外 Claude 账号（其订阅计划需支持你分配的模型）

## 安装

- **应用市场**：搜索 “Claude Code Orchestrator”。
- **从源码**：`npm install && npm run compile`，然后按 F5（扩展开发宿主），或 `npm run package` 后安装生成的 `.vsix`。

## 快速开始

1. 打开活动栏的 **Claude Code Orchestrator** 视图 → **Add Worker Account**。输入名称（如 `w1`）并选择默认模型；随后打开的终端里，用该槽位的 Claude 账号**登录一次**。已经有 `~/.claude-*` 目录？用 **Import Existing Claude Config Directories** 批量导入。
2. 运行 **Register Dispatch MCP Server in This Workspace** — 在工作区 `.mcp.json` 写入 `cco-dispatch` 条目（服务器文件位于 `~/.claude-code-orchestrator/mcp/` 下的固定路径，扩展升级不会破坏注册）。
3. 接受向工作区 `CLAUDE.md` 添加**调度策略**的提示（也可以稍后运行 **Add Dispatch Policy to CLAUDE.md**）。
4. 重启 Claude Code 会话并批准该项目的 MCP 服务器。
5. 照常对话。交给主会话一个大任务，它会自动分发：独立的子任务并行派给各 worker，主会话专注于设计、集成与验证。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `dispatch_tasks` | **批量调度（推荐）。** 一次调用交付 N 个独立任务；服务器在各 worker 账号间真正并行执行，并汇总返回结果。 |
| `dispatch_task` | 把一个自包含任务派给一个 worker（在同一工作区运行的无头 Claude Code 会话，具备文件与 shell 访问能力）。 |
| `orchestrator_briefing` | 按 CLAUDE.md 策略，主模型每会话调用一次并传入自己的模型 ID。按工作区记录编排器模型，并返回与其层级匹配的运行简报 — 见下文*模型校准*。 |
| `list_workers` | 各 worker 的默认模型、累计用量（任务、token、费用）、可用性/冷却状态，以及 frontier 调度防护的状态。 |

值得了解的调度参数：

- **`system_prompt`** — 编排器可以为每个 worker 下发任务定制的系统提示（角色、质量标准、输出格式），叠加在内置的 worker 基础提示之上。对复杂任务的质量影响显著。
- **`ultrathink: true`** — 机制化地把该次 worker 运行的推理深度拉到最高。适用于契约关键的实现、微妙的调试和对抗性评审。
- **`model`** — 高难度推理/编码用 `claude-opus-4-8`；简单或大批量任务用 `claude-sonnet-5`；`claude-fable-5` 仅用于杠杆最高的调度（设计咨询、对抗性评审），且仅当你已开启 frontier 调度（见*计费防护*）。
- **`worker`** — 可选的显式账号；省略则按配额感知自动分配。

## 编排质量栈

扩展内置三层提示（所有面向模型的文本均为英文，且不提及任何具体模型名）：

1. **Worker 基础提示** — 自动注入每个被调度的会话：契约纪律（接口具有约束力、文件所有权边界）、自主完成、克制的范围、经证据核对的汇报。
2. **调度策略**（`CLAUDE.md` 区块，在标记注释之间幂等更新）— *主*会话的常驻指令。核心是：**编排器不写实现。** 它只亲自做设计、分解、调度、集成与验证；所有生产代码、测试和文档都由 worker 编写。还包括：批量并行、验证闭环、主动搜寻未知的未知、frontier 升级阶梯、汇报语言规则。
3. **模型校准**（由 `orchestrator_briefing` 返回）— frontier 层级的编排器模型只收到简短确认，保留最大自由度；其他层级会收到校准附录，使其在长程多智能体工作中保持同等运行水准（强制委派、外化计划、可追溯到探针的事前验尸、带否决程序的对抗性评审、文档一致性关卡、基于证据的断言）。

这套栈经过基准调优：在四轮难度递增的双编排器 A/B 构建中（以基于实际执行的探针做盲评），frontier 编排器与校准后的 Opus 编排器之间的评分差距从约 11.5 分收窄到 **3 分，且双方功能缺陷均为零**。详见 [docs/benchmarks.zh-CN.md](docs/benchmarks.zh-CN.md)。

## 配额感知调度与故障转移

- 从 CLI 结果解析各 worker 的累计用量（任务、token、费用）并记录在本地。
- 遇到配额/限流错误时，该 worker 进入可配置的**冷却期**，任务**自动转移**到其他可用 worker。只有一个 worker 时没有转移目标 — 会返回明确的错误。
- **★ 首选 worker** — 把与主会话同账号的 worker 标记为首选（右键 → *Toggle Preferred*）。只要它不比最空闲的替代者更忙，就在自动分配中胜出：受偏好，但不会被淹没。
- 后台 worker 无法回答权限询问，因此默认以 `--permission-mode acceptEdits` 运行（可配置；需要执行 shell 命令的任务要用 `bypassPermissions` — 请先理解其安全影响）。

## Frontier 计费防护

取决于订阅计划，`claude-fable-5` 可能**按用量计费**而不是消耗订阅配额。由于调度是自主发生的（策略规定的设计咨询可能在你不注意时发出），防护**在调度服务器强制执行，而非仅靠提示词**：

- 默认：**block** — 拒绝 frontier 调度，并返回引导性错误，把编排器导向 `claude-opus-4-8` + `ultrathink`（不重试、不转移）。
- `list_workers` 与工具 schema 会在任何调度尝试之前展示防护状态。
- 需要时再有意打开：`claudeCodeOrchestrator.frontierWorkerDispatch` 设置，或仪表盘中的下拉框。一个行之有效的外科式用法：打开 → 为重要构建调度一次对抗性评审 → 关闭。

## 视图与仪表盘

- **Worker Accounts** — 展开一个 worker 可见状态（可用/冷却中）、会话（5h）与每周（7d）的调度用量、历史累计和错误数。点击 *Plan quota* 行会打开该账号的终端，用 `/usage` 查看订阅计划的真实配额。树中的数字只反映本扩展发出的调度，并非该账号的全部消耗。
- **Dispatched Tasks** — 实时任务流，默认只显示当前工作区（可切换为全部工作区）。点击任务可打开其提示词/结果的 markdown。
- **编排器仪表盘**（编辑器标签页）— 统计卡片（运行中、7 天任务、成功率、token、费用）、14 天任务图表、各 worker 的 token 分布、worker/任务表格，以及带快捷操作的设置面板。每 2 秒自动刷新，自动适配主题。
- **Open Interactive Worker Session** — 在集成终端中以可见方式运行 worker（可注入初始任务），适合需要盯着并随时介入的工作。

## 命令

| 命令 | 说明 |
|---|---|
| Add Worker Account | 创建 worker（配置目录 + 一次性登录终端） |
| Import Existing Claude Config Directories | 扫描 `~/.claude*` 并批量注册 |
| Register Dispatch MCP Server in This Workspace | 向 `.mcp.json` 写入 cco-dispatch |
| Add Dispatch Policy to CLAUDE.md | 注入/刷新策略区块 |
| Open Worker Session in Terminal | 交互式 worker 会话（条目上的内联按钮） |
| Re-login Worker Account | 重新登录 worker（上下文菜单） |
| Toggle Preferred Worker | 自动分配时偏好此 worker（上下文菜单） |
| Open Orchestrator Dashboard | 编辑器标签页仪表盘 |
| Toggle Task Scope | 任务视图：当前工作区 ↔ 全部 |
| Remove Worker Account / Clear Task History | 清理 |

## 设置

| 设置 | 默认值 | 说明 |
|---|---|---|
| `claudeCodeOrchestrator.workerPermissionMode` | `acceptEdits` | 后台 worker 的 `--permission-mode`（`default` 会因等待编辑批准而卡住） |
| `claudeCodeOrchestrator.claudePath` | `claude` | Claude Code CLI 路径 |
| `claudeCodeOrchestrator.quotaCooldownMinutes` | `30` | 配额错误后该 worker 被排除出分配的分钟数 |
| `claudeCodeOrchestrator.frontierWorkerDispatch` | `block` | frontier worker 模型的计费防护（见上文） |

## 数据与隐私

一切都留在你的机器上。扩展与服务器在 `~/.claude-code-orchestrator/` 下共享状态：worker 注册表（名称、配置目录路径、默认模型 — **不含令牌、不含凭据**）、各 worker 的用量统计、任务日志，以及 markdown 格式的任务产出。除了你主动调度的 Claude Code CLI 调用之外，不向任何地方发送任何数据。卸载扩展后该目录会保留 — 彻底清除请手动删除。

## 疑难解答

- **MCP 服务器显示 “failed”** — 通常是 GUI 进程的 Node.js 路径问题。重新运行 *Register Dispatch MCP Server*；扩展会通过登录 shell 解析 `node` 的绝对路径并写入 `.mcp.json`。
- **worker 卡住直至超时** — 检查 `workerPermissionMode`；`default` 会永远等待一个无人能点击的权限批准。任务在 30 分钟后超时。
- **“Dispatch to claude-fable-5 is blocked”** — 计费防护处于开启状态（默认）。若接受费用，请有意将 `frontierWorkerDispatch` 设为 `allow`。
- **每次调度都报配额错误** — 在 `list_workers` / Worker Accounts 视图检查冷却状态；只有一个 worker 时没有故障转移。

## 限制与说明

- 各 worker 会并发修改**同一工作区**的文件。对可能重叠的任务，请在提示词中划分互不相交的文件所有权清单（按任务的 worktree 隔离在路线图上）。
- 不会动你的主账号 — 面板继续使用默认的 `~/.claude` 登录。
- 使用多个 Claude 账号需遵守 Anthropic 的服务条款与使用政策。**确保你的账号配置与使用方式合规是你自己的责任。** 被调度的工作消耗的是各 worker 账号自己的配额或按量计费。

## 许可证与商标

[MIT](LICENSE) © 2026 Toragonite。

Claude、Claude Code 与 Anthropic 是 Anthropic, PBC 的商标。本项目是独立的社区扩展，与 Anthropic 没有从属、赞助或背书关系。
