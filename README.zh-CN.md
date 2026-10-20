# Claude Code Orchestrator

[English](README.md) | [한국어](README.ko.md) | **简体中文**

[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/toragonite.claude-code-orchestrator.svg?label=VS%20Marketplace&color=0066b8)](https://marketplace.visualstudio.com/items?itemName=toragonite.claude-code-orchestrator)
[![Marketplace installs](https://vsmarketplacebadges.dev/installs-short/toragonite.claude-code-orchestrator.svg?color=0066b8)](https://marketplace.visualstudio.com/items?itemName=toragonite.claude-code-orchestrator)
[![Open VSX](https://img.shields.io/open-vsx/v/toragonite/claude-code-orchestrator?label=Open%20VSX&color=c160ef)](https://open-vsx.org/extension/toragonite/claude-code-orchestrator)
[![Open VSX downloads](https://img.shields.io/open-vsx/dt/toragonite/claude-code-orchestrator?label=downloads&color=c160ef)](https://open-vsx.org/extension/toragonite/claude-code-orchestrator)
[![GitHub release](https://img.shields.io/github/v/release/Toragonite/claude-code-orchestrator?label=release&logo=github)](https://github.com/Toragonite/claude-code-orchestrator/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/Toragonite/claude-code-orchestrator)](https://github.com/Toragonite/claude-code-orchestrator)
[![License: MIT](https://img.shields.io/github/license/Toragonite/claude-code-orchestrator?color=brightgreen)](LICENSE)

![Claude Code Orchestrator — 由一个 Claude Code 会话把工作并行分发给多个 worker 账号](media/screenshots/banner.png)

> 非官方扩展 — 与 Anthropic 无关，也未获其认可。曾用名：*Fable Orchestrator*。

Claude Code Orchestrator 让一个 **Claude Code** 会话（*编排器*）通过主会话在自己的 Bash 工具中运行的分发命令（如果你愿意，也可以通过 MCP 分发工具），把编码任务并行交给运行在你**其他账号**下的 worker 会话。主会话负责设计、集成和验证，各个 worker 用各自的套餐配额完成实现；同时提供配额感知的故障转移、按账号的实时用量、显示活动会话的“团队”视图以及仪表板。

> **2.0 — 针对 Claude Code 2.1.283 及更高版本重新对齐。**
> 会话 worker 现在是对等会话，由你自己的会话通过 `SendMessage` 直接发消息。worker 账号也可以运行在 Codex、Cursor 和 Antigravity 上。新增“团队”视图，仪表板重新设计。中继“网关”、三个 MCP 工具和两项设置已被移除，因为 Claude Code 现在自己完成这些工作。设置现在只从用户设置读取。 分发不再需要 MCP：主会话通过它的 Bash 工具运行 `~/.claude-code-orchestrator/bin/cco` 命令。MCP 仍然可以作为可选方式使用。
> → [从 1.x 升级](#从-1x-升级) · [哪些是实验性的或未经验证的](#哪些是实验性的或未经验证的) · [更新日志](CHANGELOG.md)

```
Claude Code 面板（主账号 — 编排器）                              ← 照常使用
   │  Bash 工具 → ~/.claude-code-orchestrator/bin/cco dispatch_tasks · dispatch_task · dispatch_status · list_workers · cancel · …
   ▼
分发宿主（每个 Claude Code 会话一个后台进程，运行在你的机器上；若注册了 cco-dispatch MCP 服务器，它运行的是同一份代码）
   │  以各 worker 自己的登录，在此工作区中启动它的 CLI
   ├──────────────┬──────────────┬──────────────────────┐
   ▼              ▼              ▼                      ▼
worker w1       worker w2      worker w3              worker codex1
Claude Code     Claude Code    Claude Code            Codex — 仅在分发明确要求时
(opus)          (sonnet)       (opus)                 （provider / worker）
```

核心思路：**账号就是各厂商自己的 CLI 已经持有的登录。** Claude Code worker 是一个单独的配置目录（`~/.claude-<名称>`），你只需登录一次；运行在其他厂商 CLI 上的 worker 则使用该 CLI 的登录。扩展只负责启动这些 CLI，不经手它们的凭据（见[信任与隐私](#信任与隐私)）。

## 适合谁

- 你有不止一份编码代理订阅 — 多个 Claude 套餐，或者 Claude 套餐加上 Codex、Cursor 或 Antigravity — 并希望在同一个对话中并行使用它们的配额。
- 你希望主会话始终只做设计者和验证者：确定契约，把实现分发出去，然后构建、测试并合并。
- 你希望在一个地方看到哪个账号接近上限、已登出或正在冷却，以及每个 worker 此刻在做什么。

它不是托管服务。一切都在你的机器上、用你自己建立的登录运行。

## 截图

*会话启动：编排器通过 `orchestrator_briefing` 签到，然后从 `list_workers` 读取每个账号的实时套餐用量，避开接近上限的账号：*

![编排器会话启动：简报以及 list_workers 给出的实时套餐用量](media/screenshots/panel-1.png)

*扇出：接口契约确定后，一次 `dispatch_tasks` 调用就把相互独立的子任务并行发给各个 worker 账号：*

![一次 dispatch_tasks 调用把子任务分发给多个 worker 账号](media/screenshots/panel-2.png)

*侧边栏：Worker 账号（各自运行的 CLI、登录状态和实时套餐用量）、团队、已分发的任务和 Worker 历史：*

![侧边栏视图：Worker 账号、团队、已分发的任务和 Worker 历史](media/screenshots/sidebar.png)

*“团队”视图：跨账号的活动会话，按工作中、等待中和已停驻分组，每一行都可以连接、查看日志、查看差异和停止：*

![列出跨账号活动会话的“团队”视图](media/screenshots/team.png)

*仪表板：带用量条和重置倒计时的账号卡片、三栏团队看板以及活动列表：*

![深色主题下的编排器仪表板](media/screenshots/dashboard.png)

*同一个仪表板在浅色主题下的样子 — 它跟随编辑器的主题，包括高对比度：*

![浅色主题下的编排器仪表板](media/screenshots/dashboard-light.png)

*添加 worker 时，首先选择该账号运行的 CLI：*

![添加 worker 账号时显示的提供商选择](media/screenshots/add-worker.png)

## 环境要求

- **VS Code 1.90 或更高版本**，或者从 Open VSX 安装扩展的兼容编辑器。
- **Claude Code CLI**，已安装并以你的主账号登录。2.0 版本已在 Claude Code 2.1.283 上验证。
- 登录 shell 的 `PATH` 中有 **Node.js** — 分发服务器用它运行。
- **至少一个 worker 账号：**
  - 另一个 Claude 账号，其套餐能够运行你指定的模型；和/或
  - 对于其他提供商，需要已安装并登录的该厂商 CLI：`codex`（Codex）、`cursor-agent`（Cursor）或 `agy`（Antigravity）。对这三个 CLI 的分发都已于 2026-10-14 在真实环境中验证，所用版本为 codex-cli 0.162.1、cursor-agent 2026.10.12 和 agy 1.3.4。
- **使用会话 worker（Mesh 模式，实验性）时：** 需要 **macOS 或 Linux** 上的 Claude Code **2.1.283 或更高版本**。在更旧的 CLI 或其他平台上，会话 worker 不会启动，每次分发都改为以一次性 worker 运行。
- **不使用 MCP 进行分发（默认方式）：** 需要 macOS 或 Linux，以及主会话的 Bash 工具。`~/.claude-code-orchestrator/bin/cco` 在 2.0 中不能在 Windows 上运行，Windows 上请使用 MCP 服务器。

## 安装

- **应用市场**：搜索 “Claude Code Orchestrator”。
- **从源码**：`npm install && npm run compile`，然后按 F5（扩展开发宿主），或运行 `npm run package` 后安装生成的 `.vsix`。

## 快速开始

1. 打开活动栏中的 **Claude Code Orchestrator** 视图，运行**添加 Worker 账号**。选择该账号运行的 CLI、一个名称（例如 `w1`）和默认模型，然后在扩展提供打开的终端中登录**一次**（Antigravity 通过它自己的应用登录）。已经有 `~/.claude-*` 目录？请改用**导入现有的 Claude 配置目录**。
2. 运行**更新工作区配置**（在命令面板中；仪表板的设置按钮、引导步骤和“策略已过期”标签也会打开它）。分发所需的配置仅此一步，不涉及任何 MCP 服务器。它会检查工作区，并以一份清单列出各项及其状态。它只应用你勾选的项，并逐项报告做了什么，或为何拒绝：
   - **分发策略** — 在 `CLAUDE.md` 中添加或更新分发策略块。
   - **团队转发代理** — 添加或更新 `.claude/agents/cco-worker.md`；该位置上不是我们写入的文件绝不会被覆盖。
   - **权限** — 通过向 `.claude/settings.local.json` 添加规则，让 `~/.claude-code-orchestrator/bin/cco` 无需权限提示即可运行。
   - **MCP 服务器** — 从 `.mcp.json` 中移除 `cco-dispatch` 条目。默认不勾选，且只有在策略已是最新时才会提供。

   这些规则是 `Bash(~/.claude-code-orchestrator/bin/cco *)`、使用绝对主目录路径的同一条规则（Claude Code 对这两种写法分别匹配）、让会话无需提示即可写入任务文件的 `Edit(/.cco/**)`，以及写入 `sandbox.excludedCommands` 的该命令的两种写法。它们会写入 Claude Code 读取的位置，即 git 仓库根目录下的 `.claude/settings.local.json`；不在 git 中时则写入该文件夹自身的同名文件。无法解析的设置文件绝不会被改写。如果该文件被 git 跟踪，配置过程会告诉你：规则要在信任该文件夹之后才生效，并且会影响克隆该仓库的每个人。移除 MCP 服务器之后，请重启 Claude Code 会话。 在 macOS 或 Linux 上单独添加分发策略（**Add Dispatch Policy to CLAUDE.md**、仪表板或引导中的按钮，或某个提示）时，如果该文件夹缺少权限规则，扩展会询问一次：“Let the Claude session run cco without permission prompts in this folder?”选择 **Allow cco** 会应用与上面相同的规则；选择 **Not now** 则什么也不做，下次添加策略时会再次询问。 在 Windows 上，**更新工作区配置**只提供分发策略（团队转发代理在那里无法分发），策略会告诉 Windows 会话使用名称相同的 MCP 工具。
3. 照常对话。交给主会话一个大任务，它就会分发出去：相互独立的子任务并行交给各个 worker，主会话负责设计、集成和验证。
4. 可选：开启[会话 worker](#会话-workermesh-模式实验性)；如果你使用原生代理团队，请保留[团队转发代理](#团队转发代理)。
5. 可选，也是在 Windows 上进行分发的方式：运行**在此工作区注册分发 MCP 服务器**。它会在工作区的 `.mcp.json` 中写入 `cco-dispatch` 条目；无法安全改写的 `.mcp.json`（无效的 JSON、不是对象、符号链接）会原样保留，并说明原因。不是有效 UTF-8 文本（例如以 Latin-1、EUC-KR 或 UTF-16 保存）或你无权写入的 `.mcp.json` 或 `CLAUDE.md` 也一样不会被改写，因为改写会改变或丢失字符，命令会如此说明。服务器位于 `~/.claude-code-orchestrator/mcp/` 下的固定路径，因此扩展更新不会破坏注册。接受把**分发策略**添加到工作区 `CLAUDE.md` 的提议（也可以稍后运行**将分发策略添加到 CLAUDE.md**），然后重启 Claude Code 会话，并批准项目 MCP 服务器。

## 任务运行的两种方式

每次分发都使用同样的操作（`dispatch_task` / `dispatch_tasks`）——无论是 `cco` 命令还是 MCP 工具——，超时、取消和配额感知的故障转移也完全相同。不同的是背后执行任务的 worker 类型。

| | 一次性 worker（默认） | 会话 worker（开启 Mesh 模式 — 实验性） |
|---|---|---|
| 运行的是什么 | 一次随任务结束的无头 `claude -p` 运行 | 一个常驻的 `claude --bg` 后台会话，任务结束后仍可连接 |
| 修改落在哪里 | 直接落在你的工作树中 | 在 git 工作区：落在它自己的 worktree `.claude/worktrees/cco-<taskId>`，分支为 `worktree-cco-<taskId>`。在非 git 工作区：直接落在工作树中 |
| 你拿回什么 | worker 的报告 | 报告；在 git 工作区中，还有一个已自动提交成果、**等你验证并合并的分支** |
| 任务进行中与它对话 | 不支持 | 用你自己会话的 `SendMessage`，发给结果中 `peer:` 一行给出的名称 |
| 观察它 | “已分发的任务”视图 | 在“团队”视图中连接终端、查看日志或打开分支差异 |
| 它可以运行什么 | 完整的 Claude Code 会话；无人值守时能做什么由 `workerPermissionMode` 决定 | 它负责写文件。启动时带有一份固定的预先批准工具列表（`ListAgents`、`SendMessage`、`Read`、`Write`、`Edit`、`Glob`、`Grep`），权限模式绝不是 bypass，并被告知不要运行 shell 命令；shell 调用会停在没有人回答的权限提示上。这是一项策略，而不是沙箱。构建和测试仍由编排器完成 |
| token 与成本数字 | 按任务记录 | 不报告（显示为 `n/a`，中文界面中为“无”） |
| 你的会话结束之后 | 仅在 `detach: true` 时继续运行 | 不会继续 — 所属会话结束时，它的分发服务器会请求停止自己启动的每个会话 worker（尽力而为，不保证成功） |

无论设置如何，有三种情况始终以一次性方式运行：使用 `detach: true` 分发的任务、发给[其他提供商](#其他提供商) worker 的任务，以及会话 worker 无法启动时的任何任务。

### 会话 worker（Mesh 模式，实验性）

开启 `claudeCodeOrchestrator.meshMode`（在设置中，或在仪表板的设置抽屉中）。分发服务器在每次分发时读取该开关，因此对已在运行的服务器，更改也从下一次分发起生效；关闭它不会停止已在运行的会话 worker。哪些内容在真实 CLI 上检查过、哪些只在假的 CLI 上检查过，见[哪些是实验性的或未经验证的](#哪些是实验性的或未经验证的)。

- **worktree 从你当前的 HEAD 提交创建。** worker 能看到你所在分支上的所有提交，但看不到任何未提交的更改。分发之前先提交 worker 需要的内容，或者把这些内容写进任务提示。
- **结果是一个待合并的分支。** 当分发以 worker 给出的结果收尾（完成，或 worker 报告的错误）时，扩展会暂存 worker 的 worktree 中的全部改动（`git add -A`），并用 `--no-verify --no-gpg-sign` 提交到 `worktree-cco-<taskId>`，因此仓库钩子和提交签名都会被跳过；结果中会给出分支名和简短的提交 ID。请验证该分支，合并通过的部分，然后停止 worker。超时、worker 死亡、被取消或以 worker 停驻收尾的分发**不会**被提交：worker 写下的内容仍以未提交状态留在它的 worktree 中，而清理过程绝不会移除仍含有工作成果的 worktree。
- **你用 Claude Code 自己的工具与 worker 对话。** worker 的名称在分发结果的 `peer:` 一行以及 `mesh_status` 中。你的会话用 `SendMessage` 给它发消息；消息会在 worker 的下一个工具回合送达，回复则作为普通的跨会话消息返回。worker 不会主动汇报进度 — 想了解状态就问它。提交结果之后，worker 会回答问题，但除非消息中写明 `RESUME`，否则不会再修改任何文件；此后所做的工作不会自动提交。给运行在与你不同账号下的 worker 发消息，依赖于你的账号中有它的会话条目副本，这条路径尚未经过实际验证。
- **未报告就结束回合的 worker 视为分发失败。** 如果 worker 停下来提问或等待，而没有写出结果，这次分发会被记录为失败，并附带一条连接命令，方便你查看它在等什么。该 worker 会继续保持运行。唯一的例外：当其账号的套餐用量显示某个窗口已耗尽时，worker 会被停止，任务故障转移到另一个账号。
- **上限只统计仍在进行中的分发。** 超过 `claudeCodeOrchestrator.meshMaxLiveWorkers`（默认 `8`）的分发会以 `worker_cap` 错误被拒绝，而不是排队。已停驻的 worker（已结束、仍可连接）不计入。
- **会话 worker 绝不会以 bypass-permissions 模式运行。** 如果 `workerPermissionMode` 是 `bypassPermissions`，会话 worker 会改用 `acceptEdits` 启动，因为 Claude Code 会扣留 bypass 会话与需要询问的会话之间的消息。
- **worker 会一直存在，直到有东西停止它。** 可以是你（“团队”视图、仪表板或 `mesh_stop_worker`）、所属会话的结束，或者 Claude Code 回收空闲已久的会话。扩展本身没有空闲自动停止。所属会话结束时，它的分发服务器会请求停止自己启动的每个会话 worker（包括已停驻的），即使此时无法读取注册表，或该 worker 的账号在此期间被移除，也是如此。该请求是在服务器退出时发出的，因此只是尽力而为：停止请求没有送达的 worker 会继续运行，直到被手动停止。停止时，只有干净的 worktree 才会被移除。
- **所属会话已消失的 worker 会被停止。** 扩展激活时，会停止那些分发服务器已经结束的会话 worker（涵盖所有有会话 worker 记录的工作区）；分发服务器在启动 Mesh 模式时，也会对自己的工作区做同样的事。先用 `claude stop` 请求停止，只有失败时才会强制结束，而且要先确认该进程确实是这个 worker。仍含有工作成果的 worktree 会保留。无法确定状态的 worker 会继续运行，并由 `mesh_status` 列出。启动时的清理刚结束，分发服务器就会结算它所处理的那些 worker 的任务，因此服务器崩溃后，任务不会再最多 10 分钟一直显示为 `running`。`mesh_status` 无法查看的 worker — 例如其账号已不再是已配置的 Claude Code 账号（绝不会向这样的目录发出任何命令）— 显示为 `unknown` 而不是 `dead`，并附上需要在该账号下手动运行的 `claude stop <job id>` 命令，因为它可能仍在运行。这类记录在其时限结束 24 小时后才会从账本中移除，只要它的 worktree 还在磁盘上或其所属进程仍然存活就不会移除，而且只在成功读取注册表之后才会移除。

无法使用会话 worker 时，分发不会失败 — 它会以一次性方式运行，下面两种情况会在结果的第一行说明：

```
⚠ mesh unavailable — ran as a one-shot worker (not attachable): <reason>
⚠ ran as a one-shot worker (not attachable): <account> has not trusted this workspace for background sessions — <what to run>
```

第一行出现在 CLI 版本低于 2.1.283、平台不受支持，或另一个窗口已拥有此工作区的会话 worker 时。第二行出现在某个任务所用的账号尚未接受 Claude Code 的工作区信任提示时。对于拥有独立配置目录的 worker 账号，扩展会在启动第一个会话 worker 之前自行记录该信任；它绝不会写入你主目录下的 `~/.claude.json`，因此以你的默认登录运行的 worker 需要你先在 CLI 中信任过该工作区一次。使用 `detach: true` 分发的任务，或发给其他提供商 worker 的任务，同样以一次性方式运行，但其结果不会带有这类提示行。

## 其他提供商

worker 账号可以运行在 **Codex**（`codex`）、**Cursor**（`cursor-agent`）或 **Antigravity**（`agy`）上，而不是 Claude Code。编排器仍然是你的 Claude Code 会话；分发服务器通过随扩展一起提供的 `@toragonite/agent-mesh` 适配器启动其他厂商的 CLI。

**选择加入规则。** 既不指定 `worker` 也不指定 `provider` 的分发只会在 Claude Code worker 上运行。只有分发明确要求时，任务才会交给其他厂商：

- `provider: "codex"`、`"cursor"` 或 `"gemini"`（Antigravity）允许该厂商的任意账号承接任务；
- `worker: "<名称>"` 指定某一个账号。

冷却、登录过期处理和故障转移只在同一厂商的账号之间进行。任务绝不会从一个厂商转移到另一个厂商。

**把限制说清楚。**

- 它们始终以**一次性**方式运行，即使开启了 Mesh 模式。无法连接、发消息或引导它们。`detach: true` 对它们与对任何一次性 worker 一样有效。
- 它们**直接在工作树中修改文件** — 没有 worktree，没有分支，也没有需要合并的东西。请为同时运行的任务指定互不重叠的文件归属列表。
- `model` 使用**该厂商自己的模型 ID**。ID 只做格式检查；厂商不存在的 ID 会让该次分发以普通错误失败，具体措辞取决于适配器。省略 `model` 时使用 worker 的默认模型；没有默认模型时使用 CLI 自身的默认值。对这类账号执行**设置默认模型**时，如果 CLI 能给出列表（Cursor 和 Antigravity；Codex 使用内置列表），会向 CLI 询问当前的模型列表，并先显示该厂商自己的模型。CLI 转售的其他厂商模型排在分隔线之后，每个都标明通过本提供商的账号计费，而不是通过那家厂商自己的账号。如果 CLI 无法列出，则显示内置建议并附一条说明；添加这类账号时 CLI 尚未启动，所以显示的也是内置建议。**让 CLI 自行选择**和**输入其他模型 ID…**始终可用。
- 前沿防护和超额防护只覆盖 Claude Code worker。某个厂商转售的另一厂商模型，消耗的是后者的配额。
- **Codex 需要 git 仓库。** 在仓库之外，Codex CLI 会拒绝运行，分发会带着它的消息失败。
- **Codex 和 Cursor 账号会显示套餐用量。** Codex 显示 5 小时和每周窗口（"Primary limit" / "Secondary limit\"）；Cursor 显示计费周期的 "Total usage"、"Auto + Composer" 和 "API usage"，各自附带周期结束时间。读数都是从本机发往该厂商用量服务的请求，使用的是该厂商自己的 CLI 保存的登录：Codex 用该账号 `auth.json` 中的令牌；Cursor 在 macOS 上通过 `/usr/bin/security` 读取 `cursor-agent` CLI 的钥匙串条目 `cursor-access-token`，仅用于向 Cursor 查询该账号自己的用量（其他平台则用 CLI 的登录文件）。如果 macOS 询问访问权限而你拒绝，6 小时内不会再次询问。分发服务器在 `list_workers` 运行时于自己的进程内发出请求，扩展则通过辅助进程发出。**Antigravity 账号不显示用量读数**：它的 CLI 把登录保存在钥匙串中，读取它的功能尚未实现。“无用量读数”并不表示“没有用量”。关闭 `claudeCodeOrchestrator.providerUsagePolling` 可以彻底停止这些请求。
- **Anthropic 凭据绝不会传给其他厂商的 CLI。** 名称以 `ANTHROPIC_` 或 `CLAUDE_` 开头的所有环境变量（包括 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN` 和 `CLAUDE_CONFIG_DIR`）以及 `CLAUDECODE`，都会从每个这类进程的环境中移除，扩展为它们打开的登录终端中也是如此。

| 提供商 | CLI | `provider` 的值 | 账号 | 权限 / 沙箱模式 |
|---|---|---|---|---|
| Codex | `codex` | `codex` | 本机已有的登录，或位于独立主目录（`CODEX_HOME`）中的单独登录。会显示套餐用量 | `workspace-write`（默认）、`read-only`、`danger-full-access` |
| Cursor | `cursor-agent` | `cursor` | 每台机器只有一个登录，因此只能有一个 worker。已于 2026-10-14 在真实环境中验证过分发。会显示套餐用量（需要本机上有该 CLI 自己的登录） | `enabled`、`disabled`；未设置时使用 CLI 的默认值 |
| Antigravity | `agy` | `gemini` | 本机已有的登录。可以指定单独的主目录（`AGY_HOME`），但**未经验证**它能否提供第二个登录。无套餐用量读数 | `accept-edits`（默认）、`plan` |

这类 worker 的权限模式按账号设置（**设置权限模式**），并作为该 CLI 自己的沙箱/模式选项传给它。除你选定的模式外，扩展自己不会添加任何权限或沙箱参数；唯一的例外是捆绑的 Cursor 适配器会在每次 Cursor 运行时传入 `--trust`，以免 `cursor-agent` 停在工作区信任提示上。选择会关闭厂商沙箱的模式时，会先要求确认。

## 视图与仪表板

- **Worker 账号** — 只显示账号。每一行显示该账号运行的 CLI、默认模型，以及它是否为优先、正在冷却或已登出。展开 Claude Code 账号可以看到实时套餐用量（每个窗口带重置时间）和本扩展自己的分发统计；展开其他 CLI 上的账号可以看到登录状态、权限模式，以及有读数时的用量。每个账号下都有一行**默认模型**。套餐用量也涵盖你的主账号，并在激活时、每 5 分钟以及执行**刷新账号用量**时刷新。如果某次读数暂时为空，会保留上一次读数并标记为非最新，最长 30 分钟。本版本无法使用的 `registry.json` 条目会连同原因一起列为不受支持的条目，其所在行上有**移除注册表条目…**；无法读取的注册表文件会在此视图和仪表板中报告，并附带**打开文件**操作。只有在登录被确认为已登出之后（相隔几秒的两次检查，或一次因登录失败的分发），账号才会显示为已登出；无法运行的检查会如实显示并重试，**立即检查登录**（右键单击 Claude Code 账号，或在其仪表板卡片上）会立即检查 — `cco list_workers --check` 对所有账号也是如此。
- **团队** — 在此工作区中工作的所有活动 Claude Code 会话（跨账号）：你分发的会话 worker、原生 Claude Code 代理团队的队友，以及你各账号的其他会话。各行按**工作中**、**等待中**和**已停驻**分组。已分发的 worker 提供**连接**（连到该会话的终端）、**日志**、**差异**（其结果分支与你的 HEAD 比较）、**复制名称**（`SendMessage` 使用的地址）和**停止**。队友和其他会话会列出来供你查看；只有可以对该会话进行操作时才提供相应操作。已停止的 worker 在其 worktree 仍然存在期间会继续列出，以免遗忘未合并的工作。
- **已分发的任务** — 任务列表，默认只显示当前工作区。点击任务可打开其输出。该视图列出最新的 300 个任务，末尾有一行可打开仪表板查看更早的任务。运行中的行带有**取消已分发的任务**。**取消所有正在运行的分发**会先询问，并且它取消的是本机所有工作区中正在运行的全部分发，而不只是这里列出的。无法读取的任务日志会如实显示为无法读取，而不是空列表。日志中日期比现在晚超过 5 分钟的任务被视为没有可用的时间：它排在有时间的任务之后，不计入任何 5 小时、7 天或按日的统计，悬停提示中显示开始时间未知。
- **Worker 历史** — 已结束的会话 worker 分发，按从新到旧排列，数量受 `claudeCodeOrchestrator.meshHistoryLimit` 限制；分支尚未合并的条目会被标记出来。
- **编排器仪表板**（编辑器标签页）— 几秒钟就能读完并据此操作的页面：
  - 页眉显示工作区、编排器的模型、“此工作区 / 所有工作区”切换，以及仅在需要关注时才出现的健康提示（登录过期、账号达到套餐上限或正在冷却、CLI 版本过旧而无法使用会话 worker、任务日志无法读取、缺少某个配置步骤）；
  - **账号卡片**：用量条和重置倒计时、冷却与额外用量标记，以及最近 5 小时、7 天和全部时间的分发统计；登录过期时，**重新登录**排在最前面；
  - 三栏**团队看板** — 工作中 · 等你处理 · 已停驻 — 每张卡片都可以连接、查看日志、查看差异和停止；
  - **活动**列表区分五种结果 — 运行中、已完成、失败、已取消、已孤立 — 支持按状态、CLI 和文本筛选，并附带 14 天的任务条与成功率；
  - **设置抽屉**（分发 · 计费防护 · 会话 worker · 其他提供商 · 配置 · 危险区域），其中每个控件都依据编辑器实际返回的结果显示已保存或失败。

  该页面在严格的内容安全策略（CSP）下提供：没有内联样式或事件处理器，没有远程内容，也绝不会用数据拼接 HTML。资源管理器页面也在同类策略下提供。重置主会话签到和停止会话在页面上都只需点击一次，随后由编辑器弹出对话框再次确认；需要确认的设置会显示“正在等待你在对话框中作答…”，而不会超时。该页面是用记录的数据在无头 Chrome 中检查的；它在真实编辑器窗口中的表现见[哪些是实验性的或未经验证的](#哪些是实验性的或未经验证的)。

如何停止分发取决于它是怎样启动的。使用 `cco` 命令时，结束或中断该命令（Esc、超时）只会结束等待：工作仍在继续，可用 `dispatch_status` 读取。要停止工作，请运行 `~/.claude-code-orchestrator/bin/cco cancel <id>`，或在“已分发的任务”视图中使用**取消已分发的任务**。使用 MCP 工具时，取消会结束 MCP 请求，并终止 worker 的整个进程树（一次 `dispatch_tasks` 批量调用是一个请求，因此取消它会停止其中的每个任务）。对于会话 worker，取消会停止它的后台会话；它已经写下的内容仍留在磁盘上。结束编排器会话会结束它启动的一次性 worker（使用 `detach: true` 分发的任务除外），并要求它的会话 worker 停止；仍然存活的 worker 会由 `mesh_status` 报告。分发宿主会随它的会话一起结束。

## 团队转发代理

在 Claude Code 的原生代理团队中，队友总是以负责人自己的账号运行。**在此工作区安装团队转发代理**会把一个小型子代理定义 `cco-worker` 写入 `.claude/agents/cco-worker.md`，让团队可以包含一个运行在**另一个账号**上的 worker。

- 转发代理自己不做任务。它只发起一次 `dispatch_task` 调用，**原样**传入任务文本，并回复一个指针：完成或失败、所用 worker 与模型、任务 ID 以及保存完整报告的文件；结果中如有 `peer:`、`worktree:` 和 `conversation:` 行，也会一并带回。
- 转发代理使用 `~/.claude-code-orchestrator/bin/cco` 命令进行分发，只用到它的 Bash 和 Write 工具：把任务写入 `.cco/`，在前台运行该命令，每次调用最多等待 9 分钟，只要退出码是 23，就继续用 `~/.claude-code-orchestrator/bin/cco dispatch_status --wait 540 <task id>` 等待。不需要 MCP 服务器。
- 负责人可以在任务文本之前加上可选的头部行：`MODEL:`、`WORKER:`、`PROVIDER:`、`TITLE:`、`TIMEOUT_MINUTES:` 和 `ULTRATHINK: true`。
- 负责人直接用 `peer:` 一行给出的名称引导会话 worker，而不经过转发代理。
- 该命令绝不会覆盖该路径上已有的其他代理；如果那里的文件是此定义的旧版本或被编辑过的副本，替换前会先询问。**更新工作区配置**也会安装和更新同一个文件。由于转发代理使用 `cco`，它在 Windows 上无法分发。

原生代理团队是 Claude Code 的实验性功能。本版本没有在真实的团队中运行过转发代理 — 见[未经验证的内容](#哪些是实验性的或未经验证的)。

## 队友模式（实验性）

队友模式由你自己的 Claude Code 会话带领，在不同厂商和账号之间运行一支**实时编码智能体团队**，包括 Claude Code、Codex、Cursor 和 Antigravity。它**默认关闭**，并且是实验性功能。使用前请阅读[相关限制](#哪些是实验性的或未经验证的)。

- **每个成员都有自己的 worktree 和分支。** 成员在仓库之外 `~/.claude-code-orchestrator/worktrees/` 下的 git worktree 中，通过自己的 `cco/<team>/<member>` 分支进行工作。分支以你当前的 HEAD，或团队文件指定的 `base` 为起点。
- **每一轮都是无头运行厂商的 CLI**，并在成员自己的对话中继续。每轮结束后，扩展会在成员的分支上创建一个检查点提交。
- **成员通过团队工具交流**：使用 `team_send`、`team_inbox`、`team_board` 和任务更新。无法使用这些工具的厂商，其成员会以**仅轮次模式**运行：消息会在它的下一轮送达，最终答复就是它的报告。
- **所有更改都不会自动合并。** 你需要审查每个成员的分支并自行合并。

### 开启队友模式

在命令面板或“团队”视图中运行**开启队友模式（实验性）**。系统会显示警告；确认后会在你的用户设置中设置 `claudeCodeOrchestrator.teamMode`；**关闭队友模式**会将其关闭。你也可以在设置页中设置该项。团队运行期间关闭此模式不会停止团队：只会拒绝创建团队和添加成员。其他团队设置（成员数量上限、轮次限制、Cursor 和 Antigravity 权限开关）见[设置](#设置)表。

### 启动团队

你的 Claude Code 会话通过 Bash 工具运行 `cco team_*` 命令来带领团队。与任务文件相同，会话会将描述团队的 JSON 文件写入 `.cco/`。较长的文本应放在单独文件中，以相对于 JSON 文件的 `goal_file`、`brief_file`、`body_file` 或 `text_file` 命名。一个最简团队文件如下：

```json
{
  "name": "login-fix",
  "goal": "验证登录表单中的字段并为其添加测试。",
  "members": [
    { "name": "builder", "role": "实现更改", "brief": "修复 src/login 中的表单；不要修改 src/api。", "paths": ["src/login/"] },
    { "name": "tester", "role": "编写测试", "brief": "覆盖验证规则。", "provider": "codex" }
  ],
  "tasks": [
    { "title": "验证邮箱字段", "assignee": "builder" }
  ]
}
```

```
~/.claude-code-orchestrator/bin/cco team_create .cco/team.json
~/.claude-code-orchestrator/bin/cco team_wait        # 在后台运行
```

如果成员需要彼此的文件，或需要已安装的依赖项，请在编写简报前阅读[关于独立分支和全新检出的限制](#哪些是实验性的或未经验证的)。

任何内容发送前都会检查这些键。未知键会被拒绝，退出码为 21，并提示最接近的允许键。团队文件支持 `name`、`title`、`goal`（或 `goal_file`）、`base`、`members`、`tasks` 和 `worktree`。成员支持 `name`、`role`、`brief`（或 `brief_file`）、`provider`、`worker`、`model`、`paths` 和 `start`。`"start": false` 会让成员的第一个轮次等待其第一条消息；团队文件中分配给它的看板任务也算作这条消息，因此这样的成员会立即开始。看板任务支持 `title`、`body`（或 `body_file`）、`assignee`、`paths` 和 `allow_overlap`。团队名称由小写字母、数字和连字符组成（最多 32 个字符，必须以字母开头）；成员名称规则相同，最多 24 个字符。`team_create` 会立即返回，worktree 在后台创建。团队文件最大为 16 MiB；目标、正文或消息文本文件最大为 64 KiB；简报文件最大为 256 KiB。

### 负责人的命令

以下命令的完整形式均为 `~/.claude-code-orchestrator/bin/cco <command>`；运行 `cco help` 可查看准确的标志。

| 命令 | 功能 |
|---|---|
| `team_create <team file>` | 根据团队文件（目标、成员和看板任务）创建团队。 |
| `team_add <members file>` | 从 `{"members": [...], "tasks": [...]}` 文件添加成员和看板任务。 |
| `team_send <message file>` | 向一位队友或所有队友发送一条消息（`to`、`text` 或 `text_file`、`kind`、`urgent`、`reply_to`、`task`）。 |
| `team_inbox [--all]` | 按时间从早到晚打印未读团队消息，并将显示的消息标为已读。`--all` 打印最近 50 条，不标记为已读。 |
| `team_wait [--wait <s>] [--settle <s>]` | 团队工作期间，通过 Bash 工具的后台选项运行。队友需要你时，此命令会打印消息并立即退出。`--settle <s>`（0 到 300，默认 20）会合并首条消息之后到达的消息。 |
| `team_status [--all \| --member <name> \| --task <id> \| --message <id>]` | 打印团队成员、看板和警告；也可查看某位成员、某项任务或某条消息的完整内容；使用 `--all` 时显示此仓库中的所有团队。 |
| `team_task <task-op file>` | 根据 `{"op": "add" \| "assign" \| "unassign" \| "update" \| "cancel" \| "reopen", …}` 文件修改看板。 |
| `team_member <name> (--stop \| --restart \| --pause \| --unpause \| --interrupt \| --switch) [--now] [--provider <p>] [--worker <w>] [--model <m>]` | 控制一位队友。只能指定一项操作；`--now` 只能与 `--stop` 或 `--pause` 一起使用；`--provider`、`--worker` 和 `--model` 只能与 `--switch` 一起使用。 |
| `team_attach <name>` | 打印可在终端中接管 Claude 队友对话的命令行；此命令不会更改任何内容。 |
| `team_end [--now]` | 结束团队：让正在运行的轮次完成（`--now` 会停止它们），提交 worktree，并列出每个分支及审查和合并命令。 |
| `team_resume [--team <id or name>]` | 在此仓库中恢复因负责人会话结束而暂停的团队。 |

退出码与 [`cco` 命令](#退出码)相同：`0` 已打印答复（请阅读）；`20` 主机返回错误且没有启动任何内容；`21` 命令行或文件有误；`22` `cco` 无法在此处运行；`23` `team_wait --wait` 超时（团队会继续运行）；`24` 等待被中断。如果团队有未读消息，每个 `cco` 答复的最后一行都会提示。队友的 shell 中拒绝执行 `cco` 命令。

### “团队”视图

“团队”视图会在原有实时会话旁显示团队成员、看板、活动和消息。右键点击成员、任务或团队，可以发送消息（给一位成员或所有成员）、中断、暂停、恢复、停止或重启成员、查看活动或更改、复制分支名称或合并命令、在新窗口中打开 worktree、在终端接管成员、释放成员、添加、分配、完成、返工、取消或重新打开看板任务，以及结束团队。相关命令位于[命令](#命令)表中名称带有 `Team` 的项目下。

### 审查与合并

扩展绝不会合并、变基或推送成员的分支。`team_status` 和视图会提供相应命令：通过**显示更改**或 `git diff <base>...cco/<team>/<member>` 审查分支，然后使用**复制合并命令**将命令复制到剪贴板，再自行合并。成员报告为 `review` 的任务会等待你将其标记为完成或退回返工。

### 结束与恢复

`team_end`（或**结束团队…**）会让正在运行的轮次完成，提交每个 worktree，并列出所有分支及审查和合并命令。它不会删除分支，也不会删除仍有工作的 worktree。负责人会话结束后，团队会暂停；在此仓库的新会话中运行 `team_resume` 即可继续。

## 分发操作

主会话用两种方式之一进行分发，操作、参数、限制和结果都相同。默认情况下，它通过自己的 Bash 工具以 `~/.claude-code-orchestrator/bin/cco <operation>` 命令运行这些操作，这种方式不需要 MCP 服务器（macOS 和 Linux）。也可以选择把它们作为 `cco-dispatch` 服务器的 MCP 工具来调用，这同时也是在 Windows 上分发的方式。下表按 MCP 工具名列出各个操作，这些名字同时也是 `cco` 的操作名。`cco` 还有两个 MCP 服务器没有的操作：`cancel <id>…` 用于停止任务，`recent [--limit n]` 列出此工作区最近的任务，用于找回丢失的 ID。`~/.claude-code-orchestrator/bin/cco help` 会列出全部操作，其余内容由分发策略教给主会话，你不需要手动学习。

<!-- BEGIN GENERATED:tools (tool and argument names from src/mcp/server.ts + src/mesh/contract.ts — do not edit by hand) -->
| 工具 | 参数 | 用途 |
|---|---|---|
| `dispatch_tasks` | `tasks[]` (必填) — 每个任务接受下面的分发参数 | **批量分发（推荐）。** 一次调用交出多个相互独立的任务（1–100 个）。它们在各 worker 账号上并行运行，但同时运行的数量以服务器的并发上限为限（默认 8），其余的按顺序等待。只要有一个任务格式不正确，整个调用就会被拒绝，任何任务都不会运行。调用会返回全部结果。 |
| `dispatch_task` | `title` (必填), `prompt` (必填), `model`, `worker`, `provider`, `system_prompt`, `ultrathink`, `timeout_minutes`, `detach` | 把一个自包含的任务分发给一个 worker。遇到配额错误时会故障转移到另一个可用的 worker。 |
| `dispatch_status` | `id`, `ids[]` | 只读：按 ID 查询已分发任务的最新状态（running、done 或 error）— 可传一个 `id`，或最多 100 个 `ids` — 任务结束后还会返回其结果（不超过 1 MiB 时为完整结果），包括会话被中断的 `detach` 任务。没有记录的 ID 返回 `not_found`；如果无法读取任务日志，调用会失败，并说明状态未知（UNKNOWN）。 |
| `orchestrator_briefing` | `model` (必填) | 由主模型在每个会话中调用一次，并传入自己的模型 ID。它会记录此工作区的编排器模型，并返回与其层级相应的运行简报；开启会话 worker 或注册了其他厂商的 worker 时，简报还会包含相应规则。 |
| `list_workers` | `check`, `diagnostics` | 列出每个 worker 的默认模型、累计分发用量、冷却状态和实时套餐用量（含重置时间与超额计费状态），以及前沿防护的状态和正在等待空闲名额的分发数量。注册了其他厂商 CLI 上的 worker 时，每一行还会标明所用的 CLI，这类 worker 还会显示登录状态和建议的模型 ID。本版本无法使用的注册表条目会如实列出；如果无法读取注册表，则报告该问题，而不是给出列表。 |
| `mesh_status` | 无 | 仅用于会话 worker。显示进行中的分发数量与上限、已停驻的 worker 数量，以及每个 worker 的任务、账号、模型、权限模式、状态、作业 ID、发消息时使用的名称、worktree 和连接命令。还会报告所属会话已消失的 worker。 |
| `mesh_stop_worker` | `job_id`, `name`, `force` | 按 `job_id`（推荐）或名称停止一个会话 worker。只有干净的 worktree 才会被移除；仍含有未提交或未推送工作的 worktree 会保留。 |
<!-- END GENERATED:tools -->

`dispatch_task` 以及 `dispatch_tasks` 中每一项接受的分发参数：

<!-- BEGIN GENERATED:params (argument names from TASK_PROPERTIES in src/mcp/server.ts — do not edit by hand) -->
| 参数 | 类型 | 含义 |
|---|---|---|
| `title` (必填) | 字符串 | 显示在任务列表中的简短标题。单行，超过 200 个字符会被截断。 |
| `prompt` (必填) | 字符串 | 完整且自包含的任务说明。worker 看不到你对话中的其他内容。不能为空，不能含 NUL 字符，最大 1 MiB。 |
| `model` | 字符串 | 层级别名（`opus`、`sonnet`、`fable`、`haiku`）或完整的模型 ID。省略时使用 worker 的默认模型。两者都不是的值会被拒绝，而不会被替换。对于其他厂商 CLI 上的 worker，请传入该厂商自己的模型 ID。 |
| `worker` | 字符串 | 指定某个 worker 账号。省略时在 Claude Code worker 之间按配额情况自动分配。 |
| `provider` | 字符串 | 明确选择其他厂商的 CLI：`codex`、`cursor` 或 `gemini`（Antigravity）。省略时任务只会在 Claude Code worker 上运行。 |
| `system_prompt` | 字符串 | 针对该任务的系统提示（角色、质量标准、输出格式），叠加在内置的 worker 基础提示之上。不能含 NUL 字符，最大 256 KiB。 |
| `ultrathink` | 布尔值 | 把该 worker 提升到最大推理深度。用于契约关键的实现、棘手的调试和对抗式评审。只接受 `true` 或 `false`，其他值会被拒绝。 |
| `timeout_minutes` | 数字 | 仅针对这一次分发的运行时长上限，1–480 分钟；超出范围的值会被调整到该范围内。优先于 `workerTimeoutMinutes` 设置。 |
| `detach` | 布尔值 | 由后台监督进程接管任务，即使你的会话结束，它也会继续运行并记录结果。始终以一次性 worker 运行。只接受 `true` 或 `false`，其他值会被拒绝。 |
<!-- END GENERATED:params -->

### cco 命令

Claude Code 会话的第一条 `~/.claude-code-orchestrator/bin/cco` 命令会为该会话启动一个**分发宿主**：一个运行同一份分发服务器代码的后台 Node 进程。之后的命令通过 `~/.claude-code-orchestrator/run/` 中的私有套接字与它通信。该 Claude Code 会话结束时，宿主会自行结束，并像 MCP 服务器一样停止该会话的 worker；它的日志是 `~/.claude-code-orchestrator/run/s<pid>.log`。扩展会把启动器安装到 `~/.claude-code-orchestrator/bin/cco`（macOS 和 Linux），并在每次激活时在服务器副本旁保持其为最新；它运行扩展找到的 Node.js，否则运行 `PATH` 中的 `node`。安装之后，即使关闭编辑器，它在终端里的 Claude Code 会话中也能继续工作。

任务以文件形式交接，因此提示文本绝不会出现在命令行上。会话用它的 Write 工具把文件写入工作区根目录的 `.cco/`：每个任务一个小的 JSON 文件，提示文本放在单独的文件里。给 `dispatch_tasks` 用的批量文件形如 `{"tasks": [ … ]}`，每个任务对应一个这样的条目。

| 任务文件字段 | 含义 |
|---|---|
| `title` | 任务列表中显示的简短标签。 |
| `prompt_file` | 存放提示文本的文件，由会话写在 JSON 文件旁边。 |
| `system_prompt_file` | 可选：存放任务专用系统提示的文件。 |
| `model`, `worker`, `provider`, `ultrathink`, `timeout_minutes`, `detach` | 可选；与上面的分发参数相同，规则也相同。 |

然后它运行一条简短的命令，例如：

```
~/.claude-code-orchestrator/bin/cco dispatch_tasks .cco/batch.json
~/.claude-code-orchestrator/bin/cco dispatch_status --wait 540 <id>
~/.claude-code-orchestrator/bin/cco cancel <id>
~/.claude-code-orchestrator/bin/cco recent --limit 5
```

- **等待。** 分发会一直等到所有任务结束，然后打印结果。`--wait <seconds>` 最多等待这么久，`--no-wait` 在任务被接受后立即返回。任务 ID 会立刻打印（`cco: accepted <id> — <title>`），每个任务结束时也会随即打印（`cco: settled <id> done` 或 `error`）。
- **结束命令不等于取消。** 结束或中断命令只会结束等待：工作仍在继续，可用 `dispatch_status` 读取。用 `cancel` 停止任务，用 `recent` 找回丢失的 ID。
- **较长的结果。** 超过 28,000 个字符的结果会在行尾处截断，完整内容保存在 `.cco/out/` 中，并列出每个任务的报告路径。
- **临时文件。** `.cco/` 在首次使用时会得到一个内容为 `*` 的 `.gitignore`，因此 git 会忽略它。本产品绝不会删除其中的任何内容。策略会告诉会话在 `.cco/` 中为每个任务使用新的文件名。
- **被分发的 worker 不能再分发。** 每个 worker 都带有标记，`cco` 在其中拒绝运行，MCP 服务器的 `dispatch_task`、`dispatch_tasks`、`mesh_stop_worker` 和 `orchestrator_briefing` 在那里也会返回错误；`list_workers`、`dispatch_status` 和 `mesh_status` 仍会应答。这是防止意外的保护措施。

### 退出码

`cco` 命令会以下列退出码之一结束。

| 退出码 | 含义 |
|---|---|
| `0` | 已打印答案。任务失败的批量调用也是 0，请阅读结果。 |
| `20` | 该操作返回了错误。 |
| `21` | 命令或任务文件有误；没有启动任何任务。 |
| `22` | `cco` 无法在此运行；原因见消息（参见[故障排查](#故障排查)）。 |
| `23` | `--wait` 超时；工作仍在继续。 |
| `24` | 等待被中断；工作仍在继续。 |

### 参数规则与限制

所有参数都会在任何操作开始之前检查。无效的调用会被拒绝，并给出指明字段的消息；这样的调用不会启动或记录任何内容。

- **批量调用。** `dispatch_tasks` 接受 1 到 100 个任务。先检查全部任务：只要有一个任务格式不正确，整个调用就会被拒绝，其中的任何任务都不会运行。
- **取值。** 类型错误、空的 `prompt`、`prompt` 或 `system_prompt` 中含有 NUL 字符、超过 1 MiB 的 `prompt`、超过 256 KiB 的 `system_prompt` 都会被拒绝。`ultrathink` 和 `detach` 只接受 `true` 或 `false`：字符串 `"true"` 或数字 `1` 会被拒绝，而不是当作真值。`title` 会被压成一行并在 200 个字符处截断；`model`、`worker` 和 `provider` 必须是不超过 200 个字符的单行文本；超出 1–480 的 `timeout_minutes` 会被调整到该范围内。
- **并发。** 一个分发服务器同一时刻最多运行 `maxConcurrentDispatches` 个一次性、其他厂商和 detach 分发 — 除非你在注册表文件中修改（[见下文](#worker-注册表)），否则为 8 — 其余的按顺序等待；等待的数量由 `list_workers` 显示。因此超过该上限的 `dispatch_tasks` 批量调用并不会“全部同时”运行。会话 worker 不计入其中：它们由 `meshMaxLiveWorkers` 限制，超过上限的分发会被拒绝，而不是排队。
- **状态查询。** `dispatch_status` 接受一个 `id` 或最多 100 个 `ids`，超过则被拒绝。服务器没有记录的 ID 返回 `not_found`。如果任务日志本身无法读取，调用会失败并说明状态未知（UNKNOWN），因为这些任务很可能是存在的。
- **结果。** 不超过 1 MiB 的结果会完整返回。更长的结果会在该处被截断，并以一行结尾，指明 `~/.claude-code-orchestrator/tasks/` 下保存完整内容的任务报告文件。输出超过 8 MiB 的一次性 worker 会被结束，该次分发与其他失败的分发一样以失败告终。
- **结果令牌。** detach 任务和会话 worker 的结果文件都必须带有每个任务各自的随机令牌。令牌从不出现在命令行或任务日志中（日志只保存它的 SHA-256）；对于会话 worker，它是该任务专属目录（模式 `0700`）中任务文件的第一行。这能阻止为其他任务写下的结果、其他用户的进程写下的结果，以及根据任务日志伪造的结果；但挡不住以你自己的用户身份运行、并读取该任务文件或服务器内存的进程 — 磁盘上的任何东西都做不到这一点。

### 模型

`model` 是层级别名 — `opus`、`sonnet`、`fable`、`haiku` — 由 Claude Code 解析为该系列的最新模型；想要固定某个模型时，可以使用完整的模型 ID。worker 的默认模型以别名保存，因此不会过时。既不是别名、也不是格式正确的模型 ID 的值，会在任何东西启动之前被**拒绝**，绝不会被悄悄替换成 worker 的默认模型。

**查看实际运行的模型。** 运行结束后，CLI 会报告它所用的模型 ID，产品会显示出来。结果的第一行形如 `[worker: wa, model: haiku → claude-haiku-4-5-20251001]`；只有当 CLI 报告的模型与所请求的文本不同时才会出现箭头，否则这一行和以前一样。任务报告文件会记录 `model ran`（有报告时）和 `model source`：由分发指定、worker 默认值，或 CLI 默认值（没有保存默认值，由 CLI 自行选择）。`list_workers` 为每个 worker 显示 `default model haiku (last ran as …)`，`dispatch_status` 返回 `modelSource`，任务结束后还返回 `modelUsed`；仪表板在账号卡片上显示 "default haiku · last ran …"，在任务行中显示 `opus → …`，来源见其提示和详情。

**别名代表哪个模型，取决于该账号所安装的 CLI 版本**，而不是本扩展。例如，2026-10-14 在同一台机器上测得：Claude Code 2.1.283 把 `haiku` 运行为 `claude-haiku-4-5-20251001`、`sonnet` 运行为 `claude-sonnet-5`，而 2.1.296 把 `haiku` 运行为 `claude-haiku-5-5`、`sonnet` 运行为 `claude-sonnet-5-5`（`opus` 只在 2.1.283 上测过：`claude-opus-5-5`）。所以在这个例子里，更新的 CLI 把相同的别名解析为更新的模型；这只是测量结果，不是承诺。要用上它，请更新该账号的 Claude Code CLI，"last ran" 文本会显示结果。对于 Claude Code 账号，**设置默认模型**提供四个别名（已知时附带 "last ran as …"）以及**输入模型 ID…**。**设置默认模型**列出该账号的 CLI 自己提供的内容：别名及其在该 CLI 上的含义（"opus — Opus 5.5"），然后是它仍提供的旧模型；对于 Codex，则是标出默认值及各模型所支持推理强度的 CLI 当前列表。`list_workers` 为每个账号显示其别名在该 CLI 上的含义。登录到同一个 claude.ai 账号的两个配置文件夹（包括编辑器会话自己的）共用一份套餐额度，所以会在仪表板、“Worker 账号”视图和 `list_workers` 中如此标明；分发不受此影响，并且只保留地址的哈希用于比较。"Last ran as" 是任务自身的模型：任务启动其他模型的子代理时，它不是运行中最贵的模型，无法判断时则什么都不显示。1.x 中表示层级的三个 ID（`claude-opus-4-8`、`claude-sonnet-5`、`claude-fable-5`）无论从列表选择还是手动输入，都可以像其他完整 ID 一样被精确固定，别名则跟随其系列的最新模型。在分发参数中，这三个 ID 仍表示对应的层级。旧版本的扩展在任何地方都把它们读作层级。

## 编排质量栈

扩展附带三层提示。所有面向模型的文本均为英文。

1. **Worker 基础提示** — 添加在每个被分发的任务之前：契约纪律（有约束力的接口、文件归属范围）、自主完成、范围克制、以证据为依据的报告。
2. **分发策略**（`CLAUDE.md` 中的一个块，在标记注释之间插入或更新）— 给*主*会话的常设指令。核心是：**编排器不做实现。** 它负责设计、分解、分发、集成和验证；生产代码、测试和文档由 worker 编写。此外还有批量并行、验证循环、寻找未知的未知，以及针对前沿层级的升级阶梯。策略用别名称呼模型，并要求会话默认省略 `model`，让任务在其 worker 的默认模型上运行；文档编写和简单转换则指定 `sonnet`。如果工作区的 `CLAUDE.md` 中是其他版本的策略块或你修改过的块，仪表板的配置区会提供**更新分发策略**，而**将分发策略添加到 CLAUDE.md** 在替换前会先询问。只替换策略标记之间的文本，标记之外的文本绝不会被改动。已是最新的块会保持原样，并告知它已是最新。标记只有独占一行且位于代码块之外时才算数，所以在正文或代码示例中引用标记不会被当作策略块。添加或更新之后，文件中恰好只有一个策略块（重复的块和失去配对的标记会被移除），并采用文件自己的换行符，被 Markdown 格式化工具调整过间距的块仍算作最新。**在此工作区注册分发 MCP 服务器**之后的提议，遇到不是本版本的块时也会像命令一样先询问。 **更新工作区配置**会把它作为清单的第一项来保持最新，已安装的策略会教主会话使用 `cco` 命令进行分发，操作与 MCP 工具相同。在 macOS 或 Linux 上单独添加策略且文件夹缺少权限规则时，扩展还会询问一次是否让会话无需权限提示即可运行 `cco`（**Allow cco**）。
3. **模型校准**（由 `orchestrator_briefing` 返回）— 前沿层级的编排器只会收到简短确认；其他层级会收到一份校准补充，使其在长时间的多代理工作中保持同样的运行标准。开启会话 worker 或注册了其他厂商的 worker 时，简报还会包含相应规则。

这套提示栈经过基准测试调优：在四次难度递增、由两种编排器对照的 A/B 构建中，使用基于执行的探针进行盲评，前沿编排器与校准后的 Opus 编排器之间的评分差距从约 11.5 分缩小到 **3 分，且双方功能缺陷均为零**。详见 [docs/benchmarks.zh-CN.md](docs/benchmarks.zh-CN.md)。

## 配额感知的调度与计费防护

- **冷却与故障转移。** 遇到配额或速率限制错误时，worker 会进入可配置的冷却期，任务故障转移到另一个可用的 worker。只有一个 worker 时无处可转，你会收到明确的错误。
- **什么算配额错误。** 作为状态明确写出的状态码（`status 429`、`HTTP 529`、`"code": 429`），或表示账号额度已达到、已超出或已用尽的消息（“out of extra usage”“limit has been reached”）。堆栈跟踪、路径、URL、带引号的标识符和测试运行器的结果行会被忽略，`context limit exceeded` 不属于账号额度，进程启动失败、超时和输出溢出也绝不算配额失败。这些规则是用书面写出的错误文本测试的，而不是用各个 CLI 到达上限时的真实输出。
- **无法工作的账号会被跳过。** 实时套餐用量显示某个窗口已耗尽、或登录已过期的账号，会被自动分配跳过；指名使用时会被拒绝。重新登录完成后，下一次分发就会检测到。其他厂商 CLI 上的账号如果某次运行因登录问题而失败，也会被自动分配跳过最长 30 分钟，直到某次运行成功或你在扩展中重新登录，因为该 CLI 自己的状态命令仍可能报告已登录。
- **★ 优先 worker。** 把与主账号共用同一账号的 worker 标记为优先（**切换优先 Worker**）；只要它不比最空闲的其他 worker 更忙，自动分配就会先选它。
- **超额防护。** 套餐窗口用完之后，启用了额外用量的账号会开始产生实际费用。`claudeCodeOrchestrator.overageWorkerDispatch` 默认为 `block`：即使开启了额外用量，分发服务器也绝不向配额耗尽的 worker 分配任务。`allow` 允许把它作为最后手段。
- **前沿防护。** 前沿层级（`fable`）视套餐而定，可能按使用量计费，或消耗单独的配额。`claudeCodeOrchestrator.frontierWorkerDispatch` 默认为 `block`：这类分发是在分发服务器中被拒绝的 — 而不仅仅是在提示中劝阻 — 并返回一条引导编排器改用开启 `ultrathink` 的 `opus` 的错误。`list_workers` 会在尝试任何分发之前显示防护状态。当防护阻止 `fable` 时，默认模型为 `fable` 的账号会被未指定模型的分发跳过，任务在下一个账号上运行；指定该账号或指定 `fable` 的分发则被拒绝。`list_workers`、模型选择器和该账号的默认模型行都会说明这一点。

两项防护都由分发服务器强制执行，并由本机上的所有编辑器共享；两者都只覆盖 Claude Code worker。

## 资源包与资源管理器

**资源包**是一个遵循 `.claude/` 布局 — `skills/`、`agents/`、`commands/`、`output-styles/`、`hooks/` — 的普通目录，`pack.json` 可选。有两类资源包：随扩展附带的**捆绑包**，以及你在 `claudeCodeOrchestrator.assetPacks` 中列出的**用户包**（例如某个私有仓库的克隆）。

资源按工作区逐个启用；启用后会安装到该工作区的 `.claude/` 目录，所做的选择记录在 `.claude/cco-assets.json` 中 — 同步功能靠这份归属账本得知自己写过哪些文件。如果无法读取该文件（已损坏、不是 JSON、不是普通文件、超过 8 MiB），同步和资源管理器不会改动任何内容，并会说明这一点，同时提供打开该文件的操作；文件原样保留。

**同步**会保持已启用的资源处于已安装且最新的状态，但绝不会覆盖你手动编辑过的文件 — 这类文件会被标记为“已自定义”。禁用某个资源时，只会移除同步自己写入的文件。**重置**是一个明确的出口，用资源包中的版本覆盖某个文件或整个资源。安装路径上若是符号链接、目录、管道或超过 16 MiB 的文件，同步既不会把它当作内容读取，也不会写入，**重置**同样如此：同步会把该文件列为“未同步”并给出原因，然后继续处理其余文件。文件是通过替换名称写入的，因此该名称上放着什么，都既不会让同步卡住，也不会让它改道。

这一切都在**资源管理器面板**（**打开资源管理器**）中管理：添加或移除包目录、按工作区切换资源，并查看每个资源的状态标记：

| 标记 | 含义 |
|---|---|
| 已同步 | 已安装，且与资源包一致 |
| 有可用更新 | 资源包比已安装的版本更新 |
| 已自定义 | 你编辑过已安装的文件 — 同步不会动它 |
| 冲突 | 两个已启用的资源要求同一个安装路径 |
| 未安装 | 已启用但尚未同步 |

在面板中还可以对不同步的文件查看差异或重置、清理失效的安装，并通过**新建资源…**创建新的技能、代理、命令、输出样式或钩子（写入可写的资源包 — 捆绑包在此为只读）。

**钩子是脚本，不是 markdown。** 安装 `hook` 资源会把脚本写入磁盘，但不会注册它 — 你仍需自己把它加入 `.claude/settings.json` 的 `hooks` 块；脚手架中的注释给出了确切的条目。

扩展自带的捆绑 `assets/` 中的任何内容，在扩展发布的那一刻就会公开。请把个人或团队私有的资源放在单独的包目录中，并通过 `assetPacks` 注册。

## 命令

<!-- BEGIN GENERATED:commands (from package.json + package.nls — do not edit by hand) -->
| 命令 | 命令 ID | 出现位置 |
|---|---|---|
| 添加 Worker 账号 | `claudeCodeOrchestrator.addWorker` | 命令面板 · “Worker 账号”视图工具栏 |
| 导入现有的 Claude 配置目录 | `claudeCodeOrchestrator.importWorkers` | 命令面板 · “Worker 账号”视图工具栏 |
| 移除 Worker 账号 | `claudeCodeOrchestrator.removeWorker` | 命令面板 · “Worker 账号”视图中的行 |
| 移除注册表条目… | `claudeCodeOrchestrator.removeUnsupportedEntry` | “Worker 账号”视图中的行 |
| 重命名 Worker 账号 | `claudeCodeOrchestrator.renameWorker` | 命令面板 · “Worker 账号”视图中的行 |
| 设置默认模型 | `claudeCodeOrchestrator.setWorkerModel` | 命令面板 · “Worker 账号”视图中的行 |
| 设置权限模式 | `claudeCodeOrchestrator.setWorkerPermissionMode` | 命令面板 · “Worker 账号”视图中的行 |
| 登录 Worker 账号（在终端中打开其 CLI，由 CLI 提示登录） | `claudeCodeOrchestrator.loginWorker` | 命令面板 · “Worker 账号”视图中的行 |
| 重新登录账号（在终端中运行该 CLI 的登录命令） | `claudeCodeOrchestrator.reloginWorker` | 命令面板 · “Worker 账号”视图中的行 |
| 立即检查登录 | `claudeCodeOrchestrator.checkLoginNow` | 命令面板 · “Worker 账号”视图中的行 |
| 显示登录诊断 | `claudeCodeOrchestrator.showLoginDiagnostics` | 命令面板 |
| 在终端中打开 Worker 会话（观察并引导此账号） | `claudeCodeOrchestrator.openWorkerSession` | 命令面板 · “Worker 账号”视图中的行 |
| 切换优先 Worker（与主会话相同的账号——空闲时优先选择） | `claudeCodeOrchestrator.togglePreferred` | 命令面板 · “Worker 账号”视图中的行 |
| 账号操作… | `claudeCodeOrchestrator.accountAction` | 不显示 — 供仪表板和视图内部使用 |
| 在此工作区注册分发 MCP 服务器 | `claudeCodeOrchestrator.installMcp` | 命令面板 · “Worker 账号”视图工具栏 |
| 将分发策略添加到 CLAUDE.md | `claudeCodeOrchestrator.addDispatchPolicy` | 命令面板 |
| 在此工作区安装团队转发代理 | `claudeCodeOrchestrator.installTeamAgent` | 命令面板 · “团队”视图工具栏 |
| 更新工作区配置 | `claudeCodeOrchestrator.updateWorkspaceSetup` | 命令面板 |
| 显示任务输出 | `claudeCodeOrchestrator.showTaskOutput` | 不显示 — 供仪表板和视图内部使用 |
| 打开任务输出 | `claudeCodeOrchestrator.openTaskOutput` | 不显示 — 供仪表板和视图内部使用 |
| 清除任务历史 | `claudeCodeOrchestrator.clearTasks` | 命令面板 · “已分发的任务”视图工具栏 |
| 取消已分发的任务 | `claudeCodeOrchestrator.cancelTask` | 命令面板 · “已分发的任务”视图中的行 |
| 取消所有正在运行的分发 | `claudeCodeOrchestrator.cancelAllTasks` | 命令面板 · “已分发的任务”视图工具栏 |
| 切换任务范围（此工作区 / 全部） | `claudeCodeOrchestrator.toggleTaskScope` | 命令面板 · “已分发的任务”视图工具栏 |
| 打开编排器仪表板 | `claudeCodeOrchestrator.openDashboard` | 命令面板 · “Worker 账号”视图工具栏 · “团队”视图工具栏 · “已分发的任务”视图工具栏 |
| 打开扩展设置 | `claudeCodeOrchestrator.openSettings` | 命令面板 · “团队”视图工具栏 |
| 刷新账号用量 | `claudeCodeOrchestrator.refreshUsage` | 命令面板 · “Worker 账号”视图工具栏 |
| 重置此工作区的主会话签到 | `claudeCodeOrchestrator.resetCheckin` | 命令面板 |
| 清理残留会话文件 | `claudeCodeOrchestrator.cleanSessionLitter` | 命令面板 · “Worker 账号”视图工具栏 · “团队”视图工具栏 |
| 打开资源管理器（工作区技能、代理、命令） | `claudeCodeOrchestrator.openAssetManager` | 命令面板 · “Worker 账号”视图工具栏 |
| 管理工作区资源（快速选择） | `claudeCodeOrchestrator.manageAssets` | 命令面板 |
| 立即同步工作区资源 | `claudeCodeOrchestrator.syncAssets` | 命令面板 |
| 将已自定义的资源重置为资源包版本 | `claudeCodeOrchestrator.resetAsset` | 命令面板 |
| 会话操作… | `claudeCodeOrchestrator.sessionAction` | 不显示 — 供仪表板和视图内部使用 |
| 在终端中连接会话 | `claudeCodeOrchestrator.attachSession` | “团队”视图中的行 |
| 显示会话日志 | `claudeCodeOrchestrator.sessionLogs` | “团队”视图中的行 |
| 停止会话 | `claudeCodeOrchestrator.stopSession` | “团队”视图中的行 |
| 打开结果分支差异 | `claudeCodeOrchestrator.openSessionDiff` | “团队”视图中的行 |
| 复制会话名称（用于 SendMessage） | `claudeCodeOrchestrator.copySessionName` | “团队”视图中的行 |
| 刷新团队 | `claudeCodeOrchestrator.refreshTeam` | 命令面板 · “团队”视图工具栏 |
| 清除已停止的 Worker | `claudeCodeOrchestrator.clearStoppedWorkers` | 命令面板 · “Worker 历史”视图工具栏 |
| 发送消息… | `claudeCodeOrchestrator.teamSendMessage` | “团队”视图中的行 |
| 发送给所有成员… | `claudeCodeOrchestrator.teamSendToAll` | “团队”视图中的行 |
| 中断 | `claudeCodeOrchestrator.teamInterrupt` | “团队”视图中的行 |
| 在终端中接管 | `claudeCodeOrchestrator.teamTakeOver` | “团队”视图中的行 |
| 释放 | `claudeCodeOrchestrator.teamRelease` | “团队”视图中的行 |
| 停止 | `claudeCodeOrchestrator.teamStopMember` | “团队”视图中的行 |
| 重新启动 | `claudeCodeOrchestrator.teamRestartMember` | “团队”视图中的行 |
| 暂停 | `claudeCodeOrchestrator.teamPauseMember` | “团队”视图中的行 |
| 取消暂停 | `claudeCodeOrchestrator.teamUnpauseMember` | “团队”视图中的行 |
| 显示活动 | `claudeCodeOrchestrator.teamShowActivity` | “团队”视图中的行 |
| 显示更改 | `claudeCodeOrchestrator.teamShowChanges` | “团队”视图中的行 |
| 复制分支 | `claudeCodeOrchestrator.teamCopyBranch` | “团队”视图中的行 |
| 复制合并命令 | `claudeCodeOrchestrator.teamCopyMergeCommand` | “团队”视图中的行 |
| 在新窗口中打开 Worktree | `claudeCodeOrchestrator.teamOpenWorktree` | “团队”视图中的行 |
| 结束团队… | `claudeCodeOrchestrator.teamEnd` | “团队”视图中的行 |
| 添加任务… | `claudeCodeOrchestrator.teamAddTask` | “团队”视图中的行 |
| 分配… | `claudeCodeOrchestrator.teamAssignTask` | “团队”视图中的行 |
| 完成 | `claudeCodeOrchestrator.teamTaskDone` | “团队”视图中的行 |
| 返工 | `claudeCodeOrchestrator.teamTaskRework` | “团队”视图中的行 |
| 取消 | `claudeCodeOrchestrator.teamTaskCancel` | “团队”视图中的行 |
| 重新打开 | `claudeCodeOrchestrator.teamTaskReopen` | “团队”视图中的行 |
| 开启队友模式（实验性） | `claudeCodeOrchestrator.teamModeTurnOn` | 命令面板 · “团队”视图工具栏 |
| 关闭队友模式 | `claudeCodeOrchestrator.teamModeTurnOff` | 命令面板 |
<!-- END GENERATED:commands -->

## 设置

除两项资源设置外，其余设置都可以在仪表板的设置抽屉中修改。

**设置只从用户设置（User settings）读取。** 所有设置都是机器范围的。工作区或文件夹的 `.vscode/settings.json`，或 `.code-workspace` 文件中的值会被忽略，扩展会在激活时报告一次，列出键名及其所在位置。工作区可能是你刚克隆的仓库，也可能是某个 AI 代理此刻正在编辑的仓库，而这些设置决定启动哪个程序、worker 无人值守时可以做什么，以及是否可以花钱。类型错误的值按未设置处理。

`claudePath` 必须是命令名或绝对路径；其他任何值都不会被使用（改用默认的 `claude`，并给出警告）。从仪表板或命令保存 `bypassPermissions`、任一计费防护的 `allow`，或不是 `claude` 的 `claudePath` 时，会先用对话框要求确认；你自己在设置编辑器中输入的值是你本人的操作，不会询问。扩展输入到终端的命令行由同一个函数按编辑器所用的 shell（POSIX shell、PowerShell 或 cmd）加引号，无法在该 shell 中安全书写的值根本不会被输入，并会给出错误提示。

<!-- BEGIN GENERATED:settings (from package.json + package.nls — do not edit by hand) -->
| 设置 | 类型 | 默认值 | 允许的值 | 说明 |
|---|---|---|---|---|
| `claudeCodeOrchestrator.workerPermissionMode` | 字符串 | `"acceptEdits"` | `acceptEdits`, `auto`, `dontAsk`, `plan`, `default`, `bypassPermissions` | 已分发 worker 使用的 --permission-mode。已分发的 worker 无人值守运行，无法响应权限提示，因此会询问的模式（'default'）会在第一次编辑时卡住。会话 worker（Mesh 模式）绝不会以 'bypassPermissions' 运行，而是改用 'acceptEdits' 启动。仅适用于 Claude Code worker：运行在其他厂商 CLI 上的 worker 有各自的权限模式（在该 worker 上使用“设置权限模式”）。 |
| `claudeCodeOrchestrator.claudePath` | 字符串 | `"claude"` | — | 要运行的 Claude Code CLI：可以是 `claude` 这样在 PATH 中查找的命令名，也可以是绝对路径。相对路径或以 '~' 开头的路径不会被使用：将改用默认值 `claude`，并向你提示。仅从你的用户设置读取 — 工作区中的值会被忽略。 |
| `claudeCodeOrchestrator.quotaCooldownMinutes` | 数字 | `30` | `1`–`1440` | worker 账号在遇到配额/速率限制错误后，重新接收分发之前的冷却等待时间（分钟）。 |
| `claudeCodeOrchestrator.workerTimeoutMinutes` | 数字 | `45` | `1`–`480` | 已分发的 worker 在被终止之前可运行的时长（分钟）。深度任务（契约关键实现、对抗式评审）经常超过 30 分钟；在此被终止的任务会丢失尚未写入的成果。单个任务可通过分发工具的 timeout_minutes 参数覆盖此值。 |
| `claudeCodeOrchestrator.assetPacks` | 字符串列表 | `[]` | — | 额外的资源包目录（允许使用 '~'）。每个资源包都遵循 .claude/ 布局——skills/、agents/、commands/、output-styles/——其资源将在“管理工作区资源”中可用。将此指向私有资源仓库的克隆，可将个人资源与公开扩展分开。 |
| `claudeCodeOrchestrator.assetAutoSync` | 布尔值 | `true` | — | 启动时，当资源包内容发生变化时，刷新此工作区中启用的资源。你手动编辑过的文件绝不会被覆盖——资源管理器会将它们标记为“已自定义”，并显示与待应用资源包版本的差异。 |
| `claudeCodeOrchestrator.frontierWorkerDispatch` | 字符串 | `"block"` | `block`, `allow` | 针对可分发模型的计费防护：仅管控前沿层级（fable）。设为 'block'（默认）时，分发服务器会拒绝这些分发，并将编排器引导至 opus + ultrathink。此设置不会阻止其他模型的超额计费——任何模型的分发在超出套餐额度后仍可能产生实际费用，这由 overageWorkerDispatch 控制。 |
| `claudeCodeOrchestrator.overageWorkerDispatch` | 字符串 | `"block"` | `block`, `allow` | 针对超额（额外额度）分发的计费防护。'block'（默认）：即使该账号已启用额外用量，分发服务器也绝不向配额耗尽的 worker 分配任务，因此分发绝不会在套餐窗口之外花钱。'allow'：已启用额外用量且配额耗尽的 worker 可作为最后手段使用；这类分发会从该账号的每月上限中扣除实际费用。此设置独立于 frontierWorkerDispatch，后者只管控前沿层级（fable）。 |
| `claudeCodeOrchestrator.sessionKeepalive` | 布尔值 | `false` | — | 每个订阅账号每 24 小时发送一次最小的 Claude 请求（haiku 模型），以保持 OAuth 会话有效。只消耗极少的套餐用量。默认关闭；登录已过期时请使用重新登录命令恢复。 |
| `claudeCodeOrchestrator.providerUsagePolling` | 布尔值 | `true` | — | 向其他厂商的 CLI 查询套餐用量。开启时（默认），每次刷新用量——启动时、每 5 分钟一次，以及执行“刷新账号用量”时——也会向每个运行在其他厂商 CLI（Codex、Cursor、Antigravity）上的 worker 账号查询用量。如果该厂商提供用量数据，这就是从本机发往该厂商用量服务的一次请求；为发出该请求，辅助进程会读取其 CLI 已保存在本机的登录信息，本扩展不保存也不显示任何令牌。关闭此项即可停止这些请求：这些账号随后会显示“无用量读数”，登录状态仍会通过 CLI 检查，分发不受影响。Claude Code 账号不受此设置管控。 |
| `claudeCodeOrchestrator.meshMode` | 布尔值 | `false` | — | 实验性。开启会话 worker（Mesh 模式）：每个被分发的任务都作为常驻后台会话（`claude --bg`）运行，而不是一次性 worker。在 git 工作区中，worker 在基于你当前 HEAD 提交创建的独立 worktree 和分支中编辑——它能看到当前分支上的所有提交，但看不到任何未提交的更改。需要 macOS 或 Linux 上的 Claude Code 2.1.283 或更高版本。会话 worker 是与你自己的会话对等的会话：使用分发结果中 `peer:` 一行给出的名称，通过 SendMessage 引导它；也可以在“团队”视图中找到它，进行连接、查看日志或停止。分发本身保持不变——dispatch_task / dispatch_tasks 工具、结果、超时、取消与故障转移都一样。使用 detach 分发的任务仍以一次性 worker 运行；当无法使用会话 worker 时（CLI 版本较旧，或账号尚未信任此工作区），分发会回退为一次性 worker 并在结果中说明。默认关闭。 |
| `claudeCodeOrchestrator.meshMaxLiveWorkers` | 数字 | `8` | `1`–`64` | 实验性。分发仍在进行中的会话 worker 数量上限。超过上限的分发会被拒绝，而不是排队：分发将以指明该上限的 worker_cap 错误失败。已停驻（parked）的 worker——其分发已结束，只是仍可连接——不计入其中。在大规模并行分发前，先等待进行中的分发结束，或者调高此数值。仅在 Mesh 模式开启时生效。 |
| `claudeCodeOrchestrator.meshHistoryLimit` | 整数 | `50` | `1`–`1000` | 实验性。“Worker 历史”视图中保留的已结束会话 worker 分发的最大数量，超出后会丢弃最旧的条目。整数，默认 50，最小 1。仅在 Mesh 模式开启时生效。 |
| `claudeCodeOrchestrator.teamMode` | 布尔值 | `false` | — | 实验性功能。开启队友模式：你的 Claude Code 会话可以带领一支编码智能体团队 — 由 Claude Code、Codex、Cursor 或 Antigravity 的 worker 账号组成，每个成员在各自的 git worktree 和分支中工作，通过消息和共享任务看板，借助 `cco team_*` 命令协同。“团队”视图会显示此工作区的所有团队，并可向成员发送消息、暂停、停止或接管成员。仅支持 macOS 和 Linux。团队运行期间关闭此项，团队会继续运行；只有创建团队或添加成员会被拒绝。默认关闭。 |
| `claudeCodeOrchestrator.teamMaxMembers` | 数字 | `6` | `1`–`8` | 实验性功能。一个团队的成员数量上限，已停止的成员也计算在内。整数，默认 6，范围 1 到 8。仅在开启队友模式时生效。 |
| `claudeCodeOrchestrator.teamMaxRunningTurns` | 数字 | `4` | `1`–`16` | 实验性功能。在同一个 Claude Code 会话中，团队成员轮次同时运行的数量上限。轮次不占用分发名额。整数，默认 4，范围 1 到 16。仅在开启队友模式时生效。 |
| `claudeCodeOrchestrator.teamTurnTimeoutMinutes` | number,null | `null` | `5`–`240` | 实验性功能。团队成员的单个轮次在被停止前最多可运行的分钟数。整数，5 到 240。未设置（默认）时取 workerTimeoutMinutes 的值。仅在开启队友模式时生效。 |
| `claudeCodeOrchestrator.teamTurnsPerMemberPerHour` | 数字 | `20` | `1`–`240` | 实验性功能。每名团队成员每小时最多可开始的轮次数；超出后该成员需等待。整数，默认 20，范围 1 到 240。仅在开启队友模式时生效。 |
| `claudeCodeOrchestrator.teamTurnsPerDay` | 数字 | `300` | `10`–`5000` | 实验性功能。每个团队每天最多可执行的轮次数；超出后团队需等到明天。整数，默认 300，范围 10 到 5000。仅在开启队友模式时生效。 |
| `claudeCodeOrchestrator.teamCursorForce` | 布尔值 | `false` | — | 实验性功能。Cursor 队友以 `--force` 运行（命令无需批准即可执行）。默认关闭：此时 Cursor 队友可以编辑文件，但并非每个轮次都能使用团队工具。仅在开启队友模式时生效。 |
| `claudeCodeOrchestrator.teamAgySkipPermissions` | 布尔值 | `false` | — | 实验性功能。Antigravity 队友以 `--dangerously-skip-permissions` 运行 — 使用团队工具需要它；此时所有命令都无需批准即可执行。默认关闭：此时 Antigravity 队友仅以轮次模式运行（在每个轮次结束时汇报，无法使用团队工具）。仅在开启队友模式时生效。 |
<!-- END GENERATED:settings -->

### Worker 注册表

`~/.claude-code-orchestrator/registry.json` 保存 worker 账号，以及分发服务器所需设置的副本：扩展会把你的用户设置复制进去，服务器在每次分发时读取它。你可以手动编辑，规则如下：

- **账号分在两个键下。** `workers` 只保存 Claude Code 账号。其他厂商 CLI 的账号保存在第二个顶层键 `vendorWorkers` 下，每个条目带有自己的 `provider`；没有这类账号时，文件中不存在该键。共用此文件的旧版编辑器不会把厂商账号当作 Claude Code 账号，也会原样保留这个键。
- **`maxConcurrentDispatches`** 是一个分发服务器同一时刻运行的一次性、其他厂商和 detach 分发的数量：1 到 64 的整数，默认 8，其他任何值都按 8 处理。它在此文件中编辑 — 2.0 没有对应的 VS Code 设置。
- **本版本无法使用的条目** — 未知的提供商、不完整的条目、重名、没有名称 — 会原样保留在文件中，且不参与任何操作。“Worker 账号”视图和仪表板会显示它们，**移除注册表条目…**在你确认后删除其中一个。
- **无法读取的注册表绝不会被覆盖。** 包括：JSON 无效、文件不是对象、`workers` 或 `vendorWorkers` 的值不是列表、文件超过 1 MiB、不是普通文件，或读取出错。所有更改都会被拒绝，并给出指明该文件的消息；“Worker 账号”视图和仪表板会附带**打开文件**操作来报告这一点；`list_workers` 和 `dispatch_task` 会回答具体问题，而不是“没有 worker”。UTF-8 字节顺序标记可以接受，空文件按新的注册表处理。在 2.0 之前，这样的文件会被悄悄替换为空注册表。
- **重命名 worker** 会同时更新任务日志、统计和注册表，要么全部成功，要么全都不改。
- **Worker 名称**只能使用字母、数字、`_` 和 `-`，最长 64 个字符。`main` 保留给你自己的账号，所有普通对象本来就有的名称（`constructor`、`toString`、`__proto__` 等）会被拒绝。这条规则适用于所有输入名称的地方以及导入账号时；文件中已有的名称不受它判定。**导入现有的 Claude 配置目录**只会提供你主目录中名称以 `.claude` 开头、且含有 `.claude.json` 或 `.credentials.json` 文件，或 `sessions/` 或 `projects/` 目录的真实目录（符号链接不在其列），如果目录自己的名称不符合规则，会询问名称。

## 从 1.x 升级

更新之后请重启 Claude Code 会话，让它读取新的工具列表。MCP 注册本身继续有效 — 固定路径下的服务器副本会在激活时刷新。 若要不使用 MCP 进行分发，请在每个工作区中运行一次**更新工作区配置**。

**已移除的内容及其替代方式。**

| 2.0 中移除 | 改用 |
|---|---|
| 中继“网关”会话以及 `meshGatewayModel` 设置 | 无需任何配置。在 Claude Code 2.1.283 及更高版本上，IDE 面板会话本身就是消息对等方，不再需要中继 |
| `mesh_send_worker` 工具 | 你自己会话的 `SendMessage` 工具，发给分发结果中 `peer:` 一行给出的 worker 名称 |
| `mesh_receive` 工具 | 回复会作为普通的跨会话消息送达。worker 不再主动发送进度说明 — 想了解状态请直接问它 |
| `mesh_keep_worker` 工具与 keep-alive 标记 | 不再需要：已经没有任何机制会停止空闲的 worker |
| 空闲自动停止以及 `meshWorkerIdleTimeoutMin` 设置 | 已停驻的 worker 会一直运行，直到你停止它（“团队”视图、仪表板、`mesh_stop_worker`）、其所属会话结束，或 Claude Code 将其回收 |
| Worker 账号树中的 “Attachable workers” 分组 | **团队**视图 |

设置中残留的 `meshGatewayModel` 或 `meshWorkerIdleTimeoutMin` 键会被忽略。调用已移除的工具会得到标准的未知工具错误；如果你的 `CLAUDE.md` 中仍是 1.x 的策略块，请运行一次**将分发策略添加到 CLAUDE.md** 来刷新它。

**需要了解的行为变化。**

- **模型使用层级别名。** 请使用 `opus`、`sonnet`、`fable` 或 `haiku`，或完整的模型 ID。1.x 接受的三个带日期的 ID — `claude-opus-4-8`、`claude-sonnet-5`、`claude-fable-5` — 会被读作 `opus`、`sonnet` 和 `fable`，已保存的 worker 默认值也是如此。无法识别的 `model` 现在会被拒绝，而不是被替换成 worker 的默认模型。
- **会话 worker 的结果是一个待合并的分支**，并且它的 worktree 现在从你当前的 HEAD 提交创建。在 2.0 之前采用的是 Claude Code 的默认行为，worker 可能从远程默认分支开始，看不到你所在分支上的提交。
- **会话 worker 需要 Claude Code 2.1.283 或更高版本**（1.5 需要 2.1.224）。在更旧的 CLI 上分发仍然可用，只是以一次性方式运行。
- **`meshMaxLiveWorkers` 只统计仍在进行中的分发。** 已停驻的 worker 不再占用上限。
- **会话 worker 绝不会以 bypass-permissions 模式运行**；在该设置下它们以 `acceptEdits` 启动。
- **未报告就结束回合的 worker 会被记录为失败的分发**，并附带连接命令。它不再在沉默之后被催促，也不再一直挂到超时。
- **由已死亡的会话遗留为“运行中”的任务会在下次启动时结算**：有 worker 记录的结果就采用该结果，没有则标记为已孤立。
- **设置只从用户设置读取。** 工作区或文件夹设置中的值会被忽略，并在激活时报告一次。请把留在那里的设置移到用户设置中。
- **所有参数在任何操作开始之前检查。** 非布尔值的 `detach` 或 `ultrathink`、空提示、NUL 字符、超过 1 MiB 的提示、`dispatch_tasks` 批量调用中格式不正确的任务，以及超过 100 个任务，都会被拒绝；只要有一个任务格式不正确，整个批量调用都会被拒绝。
- **无法读取的注册表文件不再被空文件替换。** 在你修复该文件之前，所有更改都会被拒绝。
- **由旧版本启动、且其分发服务器随后已死亡的分发，不再被自动补全。** 它会连同一条说明被标记为错误，结果文件会保留 24 小时。

**首次运行时清理残留会话文件。** 早期版本读取各账号套餐用量的方式是：启动一个短暂的 `claude` 进程，然后将其强行终止。每次终止都会在该账号的 `sessions/` 目录中留下两个小文件，几个月下来，每个账号会积累到数万个 — 足以让 Claude Code 自己的会话列表查询耗时超过 30 秒。2.0 改为让该进程正常结束，因此不再留下任何文件，并且会清除早期版本留下的文件：在启动约 15 秒后执行，此后至多每天一次，只删除符合这类探测特征、10 分钟内无人动过、且其进程已被证实不存在的文件：进程 ID 取自文件名，必须已不存在；对于指明了消息套接字的条目，`<pid>.sock` 上也不能有任何监听者。活动会话绝不会被触碰。只有在第一次确实移除了文件时才会通知你一次；总数记录在 “Claude Code Orchestrator” 输出通道中，也可以用**清理残留会话文件**随时手动执行同样的清理。

## 哪些是实验性的或未经验证的

**实验性。** 会话 worker（Mesh 模式）、“团队”视图中对原生代理团队的列出，以及团队转发代理，都依赖没有公开 API 的 Claude Code 内部机制 — 会话注册表、后台会话命令和代理团队文件。如果这些机制发生变化，会话 worker 会回退为一次性 worker，列表也可能返回空；在分发过程中发生的变化会表现为超时或分发失败，而不是错误的结果。

**已在真实 CLI 上验证，2026-10-13**（macOS，Claude Code 2.1.283）。主账号上会话 worker 的完整流程：启动、基于 HEAD 的 worktree、结果、自动提交、`mesh_status`、从 IDE 面板会话（报告版本为 2.1.292）用 `SendMessage` 给它发消息并收到回复，以及保留未合并 worktree 的停止。发往 Antigravity 和 Codex（在 git 仓库内）的一次性分发。

**已在真实 CLI 上再次验证，2026-10-14**（macOS，Claude Code 2.1.283，以主账号作为 worker），此时结果令牌和进程身份确认已经加入。一次会话 worker 分发顺利完成，worker 从任务文件第一行复制了令牌；任何命令行中都没有出现令牌，任务日志里只有它的 SHA-256。一个 detach 一次性任务经过令牌检查被转交，`mesh_stop_worker` 停止了该会话。真实 `--bg` 会话的命令行和启动时间，与强制停止用来确认某个进程就是该 worker 的规则相符。**没有在真实环境中运行：** 强制停止、长到需要多次存活检查的任务、停驻后又被唤醒的会话、其他账号上的任何操作，以及被植入的结果文件遭到拒绝；这些只在替身上测试过。

**已在真实厂商 CLI 上验证，2026-10-14。** 发往真实 Codex（codex-cli 0.162.1）、Cursor（cursor-agent 2026.10.12）和 Antigravity（agy 1.3.4）CLI 的分发都返回了结果，且没有任何 Anthropic 或 Claude 变量传给它们。在 Claude Code 2.1.283 上，默认模型、由分发指定的模型和 detach 分发都显示了实际运行的模型。模型列表辅助程序已在这三个真实 CLI 上运行过。

**已在真实编辑器中验证。** 编译后的扩展安装在一个 VS Code 1.138 窗口中。它激活时没有错误通知，四个视图和仪表板（在其内容安全策略下）都已加载，本 README 中的截图就是在那个窗口里截取的。

**已在真实环境中验证，2026-10-15。** 用 `~` 写的权限规则匹配用 `~` 输入的命令，而不匹配绝对路径写法，反之亦然（Claude Code 2.1.299），所以两种写法都会写入。`.claude/settings.local.json` 中的 `Edit(/.cco/**)` 让会话无需提示即可写入任务文件。用真实账号通过 `cco` 运行一个真实任务（haiku），从第一条命令到拿到答案用了 3.8 秒，其中包括启动分发宿主；宿主的父进程是系统，而不是会话的 shell。

**仅在替身上验证。** 其余一切都是在假的 CLI、编辑器 API 的替身，以及（对仪表板和资源管理器页面而言）使用记录数据的无头 Chrome 上运行的。

**未经验证 — 请视为未测试。**

- **Windows 和 Linux。** 2.0 的任何内容都没有在那里运行过。在 Windows 上，不得跟随符号链接的读取会退化为打开之前的检查，会话 worker 的强制停止会被拒绝（读不到进程的身份），`0700` 和 `0600` 模式不起作用，PowerShell 和 cmd 的终端命令行只是按规则构造的，从未运行过。
- **真实编辑器窗口中的交互行为。** 命令、确认对话框、树视图悬停提示、webview 中的资源管理器页面，以及实际界面中的韩文和中文文本，都只在上述替身上运行过。
- **与编排器不在同一账号上的会话 worker**，以及由此而来的跨账号引导。按名称寻址依赖于把它的会话条目镜像到你的主账号中；这条路径只有离线测试覆盖，因为验证所用机器上的所有 worker 账号当时都处于登出状态。
- **在真实 CLI 上的会话 worker 失败路径** — worker 停驻而没有结果、超时、取消和故障转移 — 只用假的 CLI 运行过。
- **真实编辑器窗口中的新模型选择器。** 只通过编辑器 API 的替身运行过。
- **Antigravity 账号的用量读数**尚未实现，Cursor 和 Codex 的读数仅在 2026-10-14 对真实厂商服务验证过。
- 通过单独主目录实现的**第二个 Antigravity 登录。**
- **完整的 Codex 钥匙串登录流程。** 扩展的设计是检测到它（通过 `codex login status`）并正常分发，但从未走完一次完整的钥匙串登录。Linux 和 Windows 上登录的保存位置同样未核对 — 见[你的登录保存在哪里](#你的登录保存在哪里)。
- **真实原生代理团队中的团队转发代理。**
- **在同一台机器上与旧版编辑器混用。** 只做过推理，没有测量。已知：旧版进程可以按它自己的规则破坏 2.0 的文件锁；2.0 在释放锁时会发现这一点，并重新执行写入或报告。
- **2.1.283 以外的 Claude Code 版本。**

**队友模式 — 实验性功能，存在以下限制。**

- **隔离旨在防止意外和成员模型误用工具，并不是针对同一操作系统用户进程的安全边界。** 能运行 shell 命令的成员（启用 `bypassPermissions` 的 Claude Code，以及使用各自沙箱的 Codex、Cursor 和 Antigravity）可以读取你用户的文件，并使用分发宿主的套接字协议。请勿在内容不可信的仓库中运行团队。
- **Linux 尚未验证。** macOS 是经过测试的平台。
- **接管功能仅适用于 Claude Code，且仍属实验性。** 只有 Claude Code 成员支持以交互方式连接其对话。
- **Antigravity。** 每个 Antigravity 账号都使用 CLI 的默认登录，因为 `agy` 会忽略 `AGY_HOME`。处于 `plan` 模式的 Antigravity 账号会被拒绝加入团队。除非开启 `teamAgySkipPermissions` 或 `teamCursorForce`，否则 Antigravity 和 Cursor 成员的团队工具默认关闭，因此它们默认仅以轮次模式运行。
- **成员各自在自己的分支上工作，因此工作期间无法看到彼此的更改。** 如果某位成员需要另一位成员的文件，只有在对方的轮次结束并创建检查点提交后，才能从 git 中读取该文件（`git show cco/<team>/<member>:<path>`）。请在有依赖关系的成员简报中说明这一点。
- **成员的 worktree 是全新检出。** 其中不含 `node_modules` 或构建输出等被忽略的文件。如果成员需要构建或运行测试，请在简报中写明如何安装或链接所需内容。
- **成员的隐藏推理并非在所有厂商上都会延续到下一轮次。** Cursor 会在轮次之间保留可见的对话（消息、回答、工具结果），但不保留模型的私有推理，因此成员必须记住的内容应写在回答或文件中。
- **部分引擎计数器会在分发宿主重启后重置**：发送速率计数，以及超出日志窗口的重复检测。
- **本版本不包含：** 跨厂商故障转移（只支持故障转移到同一厂商的其他账号）、文件邮箱、自动重新连接，以及在独立的 Gilde 应用中编辑团队。
- 所有更改都不会自动合并。

**已知限制。**

- `cco` 在 2.0 中不能在 Windows 上运行，Windows 上请使用 MCP 服务器。团队转发代理在 Windows 上同样无法分发。
- 如果 Claude Code 的沙箱已开启，必须把 `cco` 从沙箱中排除。**更新工作区配置**会在该文件夹的本地设置中完成这一点；如果沙箱由组织统一管理，则必须写入你的用户设置。否则 `cco` 会以退出码 22 应答，并指出该设置。当 `cco` 本身在沙箱内被拒绝时，消息会告诉你请用户运行**更新工作区配置**并勾选 “Allow cco without a prompt”。
- 在另一个 Claude Code 会话的分发宿主中排队的任务，在开始之前读取为 `not_found`。
- 扩展更新之后，会话中正在运行的分发宿主会一直保持旧构建，直到新的 Claude Code 会话开始；`cco` 会打印一行警告。
- 同一工作区中的两个 Claude Code 会话，表现与两个 MCP 服务器相同：第二个会话的会话 worker 分发会以一次性方式运行，并附有提示。
- 作为符号链接的 `registry.json` 会沿链接读取，但第一次写入会把该链接替换为普通文件。
- 改写 `.mcp.json` 会重新序列化它：缩进和换行符变为两个空格加 LF，超过 2^53 的整数会丢失精度。作为符号链接的 `.mcp.json` 不会被写入。
- 需要被卡住进程所持有的锁的写入，最多等待 15 秒（在编辑器的 UI 线程上也是如此），然后报告持有者。锁的期限按墙上时钟计算。
- 在用于放宽取值的确认对话框（跳过权限检查、允许计费、运行另一个 `claude` 程序）中，按 Enter 会激活确认按钮。
- 对于 Codex、Cursor 和 Antigravity，只有当分发没有指定模型、且 CLI 自己给出了模型时（撰写本文时是 Codex），才会显示实际运行的模型。指定了模型时，内置适配器返回的是所请求的名称，这并不能证明实际运行了什么，所以不显示任何内容。
- 会话 worker（`--bg`）会记录它运行的模型，取自它自己的会话记录；服务器死亡后才恢复结果的任务，只有在恰好一个 worker 会话与之匹配时才会记录模型。
- Cursor 用量需要本机上 `cursor-agent` CLI 自己的登录（macOS 上在钥匙串中）。“同一个 claude.ai 账号”的判断需要 CLI 给出已登录的地址，扩展只比较哈希，所以无法说出是哪个地址。Windows 和 Linux 仍未验证。
- 被强行杀死（SIGKILL）的模型列表辅助程序无法停止它所启动的 CLI。
- 更新 `CLAUDE.md` 是按名称替换文件：指向它的硬链接会断开，扩展属性不会保留。
- "Last ran as" 按账号名称和 CLI 判断：在同一 CLI 上移除账号后用同名重新添加，会显示旧账号运行过的模型。
- 一个一次性 worker（`claude -p` 或其他厂商的 CLI）只会被派发它的进程在时限到达时停止：普通分发由分发服务器负责，detach 分发由 detach 监督进程负责。如果在 worker 运行期间该进程被强行杀死（而不是有序关闭），worker 会在没有时限的情况下继续运行；其任务在 worker 存活期间一直显示为 `running`，worker 退出后被标记为已孤立。可以在“已分发的任务”视图中停止它，或按任务日志里记录的 pid 停止。没有其他任何机制强制执行该时限。
- 视图和仪表板所用的任务索引会随日志增长就地延伸。对于第一个 256 字节以及读取位置之前 64 字节之外、被就地改写的字节，它要等到下一次从日志开头重建时才会发现：重建发生在你运行刷新任务视图的命令时（例如**切换任务范围**、**清除任务历史**、**取消已分发的任务**、**刷新账号用量**或**刷新团队**），或在距上一次完整读取超过 10 分钟后日志再次变化时。本项目中没有任何部分会以这种方式写日志。
- 发布前的最后一轮修复经过了其作者的测试、把此前的对抗式探测重新跑在修复后的代码上，以及集成关卡的检查；之后没有再经过独立的核查。
- 非常大的批次（约 100 个标题很长的任务）产生的输出仍可能超过 Claude Code 内联显示的量；这时会话会读取保存下来的输出文件。

## 信任与隐私

**什么在哪里运行。** 一切都在你的机器上运行：扩展运行在编辑器的扩展宿主中；分发服务器是一个 Node 进程 — 即你的 Claude Code 会话中的第一条 `cco` 命令从 `~/.claude-code-orchestrator/mcp/` 启动的分发宿主，或你改为注册时的 MCP 服务器；每个 worker 是该服务器的子进程 — 即厂商自己的 CLI，使用该 worker 的登录，在你的工作区中运行。

**没有我们的服务器。** 我们不代理、不中继、也不收集任何内容，也没有遥测。离开你机器的只有各厂商 CLI 在工作时发给各自厂商的内容，以及套餐用量读数。对于 Claude Code 账号，扩展通过运行 Claude Code CLI 读取用量。对于 Codex 账号，当 `claudeCodeOrchestrator.providerUsagePolling` 开启时，捆绑的 Codex 适配器会读取该账号的 `auth.json` 令牌，并从本机调用 Codex 的用量服务 — 分发服务器在 `list_workers` 运行时于自己的进程内调用，扩展在刷新时通过辅助进程调用。对于 Cursor 账号，同一设置还管控向 Cursor 用量服务发出的一次请求，使用的是 `cursor-agent` CLI 自己的登录。这些用量请求是本项目自己的代码发出的唯一网络请求。

**关闭厂商用量读数。** 关闭 `claudeCodeOrchestrator.providerUsagePolling` 后，这些请求就会停止。相关账号会显示“无用量读数”，登录状态仍通过 CLI 检查，分发不受影响。

**Anthropic 凭据不会传给其他厂商的 CLI。** 名称以 `ANTHROPIC_` 或 `CLAUDE_` 开头的所有环境变量（包括 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN` 和 `CLAUDE_CONFIG_DIR`）以及 `CLAUDECODE`，都会从扩展启动的每个 Codex、Cursor 和 Antigravity 进程（包括登录终端）的环境中移除。Claude Code worker 既不会继承标识你自己会话的变量，也不会继承属于其他账号的 OAuth 令牌。有一类变量会被有意传给 Claude Code worker：`ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN` 用来为整台机器指定密钥，所以如果你在运行 Claude Code 会话或编辑器的环境中导出其中任何一个，所有 Claude Code worker 都会使用该密钥运行。其他厂商的 CLI 绝不会收到这两个变量。

**写入了什么，写在哪里。**

- `~/.claude-code-orchestrator/` — `registry.json`（worker 名称、目录路径、默认模型、各自运行的 CLI，以及分发服务器所需的设置 — **没有令牌，没有凭据**）、`stats.json`（分发统计）、`tasks.jsonl`（任务日志，含每个提示的预览）、`tasks/`（每个任务的报告和完整提示，以及每个任务的结果文件）、`usage.json`（缓存的套餐用量读数，其中包含 CLI 为每个 Claude Code 账号报告的邮箱地址和套餐）、`orchestrators.json`、`mesh/`（会话 worker 账本）`mcp/`（分发服务器的固定副本，另有 `cco` 客户端 `cli.js`）、`bin/`（`cco` 启动器，即 `~/.claude-code-orchestrator/bin/cco`）和 `run/`（分发宿主的套接字、锁和日志）。该目录以 `0700` 创建 — 旧版本创建的目录会在此版本第一次写入时对其他用户关闭 — 其中的状态文件、任务报告和提示为 `0600`；这两种模式在 Windows 上都不起作用。激活时还会写入一个单行转发文件 `~/.fable-orchestrator/mcp/server.js`，让更名之前建立的注册继续有效。卸载扩展后这一切仍会保留；删除这两个目录即可清除本项目在那里写入的全部文件。
- 你的工作区 — `CLAUDE.md` 中的策略块；`.cco/`（主会话写入的任务文件，其中有内容为 `*` 的 `.cco/.gitignore`，以及存放较长结果的 `.cco/out/`；本产品绝不会删除其中的内容）；应用**更新工作区配置**的相应项之后，`.claude/settings.local.json` 中的规则（位于 git 仓库根目录）；注册了 MCP 服务器时 `.mcp.json` 中的 `cco-dispatch` 条目；安装后才有的 `.claude/agents/cco-worker.md`、`.claude/` 下已启用的资源，以及 `.claude/worktrees/` 下的会话 worker worktree。只有当 `.mcp.json` 能解析为 JSON 对象时才会修改它（接受字节顺序标记，空文件视为新文件）；否则不改动任何内容，并说明原因。无法读取的 `CLAUDE.md` 不会被改写，资源同步也不会通过 `.claude` 下的符号链接写入或删除。
- Claude Code 配置目录 — 共三处。对于拥有独立目录的 worker 账号，在它的第一个会话 worker 启动之前，会在该账号的 `.claude.json` 中把工作区记录为已信任，并把工作区中尚未决定的 MCP 服务器对它标记为禁用。为了让其他账号的会话 worker 可以按名称寻址，它的会话条目会被复制到你主账号的 `sessions/` 目录中，并标记为副本；之后只有带有该标记的文件才会被移除。此外，[从 1.x 升级](#从-1x-升级)中介绍的残留文件清理会删除那里遗留的探测文件。你主目录下的 `~/.claude.json` 绝不会被写入。

### 你的登录保存在哪里

登录由各厂商自己的 CLI 在扩展打开的终端中完成。扩展从不保存凭据，也绝不会把凭据发送给签发它的厂商以外的任何地方。登录保存在哪里由该 CLI 决定：

| CLI | 登录保存位置 |
|---|---|
| Claude Code | 在 macOS 上是系统钥匙串：默认账号保存在 `Claude Code-credentials` 条目下，其他每个配置目录保存在各自的 `Claude Code-credentials-<8 hex>` 条目下（由目录路径派生）。在 macOS 上，配置目录中没有令牌文件。在 Linux 和 Windows 上则取决于平台：CLI 使用该平台的机制，或配置目录中的 `.credentials.json` 文件。 |
| Cursor | 系统钥匙串。 |
| Antigravity | 它自己的应用存储，用保存在系统钥匙串中的密钥加密。 |
| Codex | 默认是一个令牌**文件** `<CODEX_HOME>/auth.json`，权限仅限所有者。 |

**Codex 也可以把登录保存在操作系统的钥匙串中。** 在 `<CODEX_HOME>/config.toml` 中加入 `cli_auth_credentials_store = "keyring"`，然后重新登录。代价是：扩展的设计是检测到该登录（它会询问 `codex login status`，其结果与登录保存在哪里无关）并正常分发，但从未走完一次完整的钥匙串登录，因此这一点未经验证；而且它无法显示该 Codex 账号的套餐用量数字，因为适配器是用那个文件中的令牌读取用量的。以单独的登录添加 Codex worker 时，扩展只会针对它新建的或发现为空的文件夹提供这一选择，并以独占方式创建这一行 `config.toml`；已有的 Codex 配置、已经保存了登录的文件夹，以及通过符号链接到达的文件夹，都绝不会被修改。

除了用量读数中说明的 Cursor 登录（在 macOS 上仅为向 Cursor 查询该账号的用量而从钥匙串读取）之外，这个文件是随本扩展发布的代码唯一会读取已保存登录的地方。捆绑的 Codex 适配器会读取 `auth.json` 来判断账号是否已登录；读取用量时，还会用其中的令牌向 Codex 自己的用量服务发出一次请求。关闭 `claudeCodeOrchestrator.providerUsagePolling` 可以停止该请求，但为了判断登录状态仍会读取该文件。当适配器没有报告已登录时，扩展会改为询问 `codex login status`，并以其答案为准。

这些位置是在 macOS 上仅凭钥匙串条目名称和文件是否存在核对的 — 没有读取任何机密。未经验证：完整的 Codex 钥匙串登录流程（需要在浏览器中登录），以及 Linux 和 Windows 上的保存位置。

**你的责任。** 使用多个账号须遵守各厂商的服务条款和使用政策。**确保你的账号配置和使用方式合规，是你自己的责任。** 被分发的工作会消耗各 worker 账号自己的配额或按量计费额度。

## 故障排查

- **`cco` 以退出码 22 结束。** 原因见消息。此 shell 没有 Claude Code 会话：请在 Claude Code 会话的 Bash 工具中运行该命令。在 Windows 上：它不能运行，请使用 MCP 服务器。Claude Code 的沙箱已开启：消息会指出要添加的设置，即 `sandbox.excludedCommands` 中的 `~/.claude-code-orchestrator/bin/cco *`；**更新工作区配置**会在该文件夹的本地设置中完成这一点，由组织统一管理的沙箱则需要写入你的用户设置，并且命令必须是不含管道、重定向或 `cd` 的单条简单命令。或者此 shell 属于被分发的 worker：被分发的 worker 不能再分发。
- **`cco: command not found`，或退出码 127。** 启动器尚未安装。请重新打开 VS Code，或运行**更新工作区配置**。
- **`cco: Node.js was not found`。** 完整消息为 “cco: Node.js was not found (the extension recorded <path>, and no node is on this PATH). Reopen VS Code so it can find Node.js again, or install Node.js 18 or later.” 请照做：重新打开 VS Code 让它重新找到 Node.js，或安装 Node.js 18 或更高版本。
- **`cco` 调用提示分发宿主已结束，或分发卡住了。** 消息会指出宿主的日志 `~/.claude-code-orchestrator/run/s<pid>.log`；请先阅读它，再用 `dispatch_status` 查看结果。
- **`cco: ⚠ this session's dispatch host runs an earlier build`。** 会话运行期间扩展被更新了。请开始一个新的 Claude Code 会话以使用新构建；在此期间分发仍可正常工作。
- **MCP 服务器显示 “failed”。** 通常是从图形界面启动的进程中 Node.js 路径有问题。请再次运行**在此工作区注册分发 MCP 服务器**；扩展会通过你的登录 shell 解析 `node` 的绝对路径并写入 `.mcp.json`。
- **从 1.x 更新后主账号显示为已登出。** 这是 1.x 的缺陷，已在 2.0 中修复；运行一次**刷新账号用量**即可。
- **开启了 Mesh 模式，分发却以一次性方式运行。** 如果结果以 ⚠ 行开头，该行会说明原因 — CLI 版本较旧、另一个窗口拥有会话 worker，或账号尚未信任该工作区。如果没有这样的行，那么该任务是用 `detach: true` 分发的，或发给了其他提供商的 worker，这两类任务始终以一次性方式运行。
- **worker 卡住并超时。** 请检查 `workerPermissionMode`：`default` 会等待一个没人能给出的批准。任务在 `claudeCodeOrchestrator.workerTimeoutMinutes`（默认 45，范围 1–480）之后超时；单次分发可以用 `timeout_minutes` 覆盖。
- **请求 `fable` 的分发被拒绝。** 前沿防护默认开启。如果你接受相应成本，请有意识地把 `frontierWorkerDispatch` 设为 `allow`。
- **`invalid model …`。** 该值既不是别名，也不是格式正确的模型 ID。对于其他厂商 CLI 上的 worker，请传入该厂商的模型 ID。
- **Codex 分发以 "Not inside a trusted directory" 失败。** Codex 需要 git 仓库；请在仓库中分发。
- **每次分发都出现配额错误。** 请在 `list_workers`、“Worker 账号”视图或仪表板中查看冷却情况；只有一个 worker 时没有故障转移。
- **出现提示说无法读取 `registry.json`。** 见 [Worker 注册表](#worker-注册表)：没有任何改动。请在“Worker 账号”视图或仪表板中打开该文件，修正 JSON 或删除该文件，然后重试。删除它会丢失你的 worker 列表，所以请先保留一份副本。
- **注册 MCP 服务器时提示没有改动任何内容。** 你的 `.mcp.json` 不是 JSON 对象（带注释或结尾逗号都会使其无效）、是符号链接，或超过 1 MiB。请修正后重新注册。
- **`mesh_status` 把某个 worker 显示为 `unknown`。** 这表示对它什么都没能检查：它的账号已从注册表中移除，或无法读取它的会话注册表。它可能仍在运行，并且仍占着名额。请在该账号下运行 `mesh_status` 给出的 `claude stop <job id>` 命令。从视图中取消这样的分发只会取消任务；需要手动停止的 job ID 会列在消息中。

## 限制与说明

- 一次性 worker 以及其他提供商的所有 worker 会同时修改**同一个工作树**中的文件。请为可能重叠的任务指定互不重叠的文件归属列表。git 工作区中的会话 worker 则各自隔离在自己的 worktree 中，由你来合并分支。
- 会话 worker 在一次失败的尝试之后重试时会复用同一个任务 worktree，因此一个分支可能同时包含两次尝试的修改。合并之前请验证完整的差异。
- 如果会话在干净的 worktree 被移除之前就结束了，`cco-…` worktree 可能会在 `.claude/worktrees/` 下堆积；干净的 worktree 可以用 `git worktree remove` 安全移除。
- 会话 worker 不会在本扩展的统计中留下 token 或成本数字。各账号的实时套餐用量不受影响 — 它是直接从账号读取的。
- 你的主账号不会被重新配置：面板继续使用它自己的 Claude Code 登录。

## 许可证与商标

[MIT](LICENSE) © 2026 Toragonite.

Claude、Claude Code 和 Anthropic 是 Anthropic, PBC 的商标。Codex、Cursor 和 Antigravity 是其各自所有者的商标。本项目是独立的社区扩展，与上述任何一方均无隶属、赞助或认可关系。
