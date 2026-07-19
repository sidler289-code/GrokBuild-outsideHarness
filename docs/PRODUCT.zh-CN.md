# Cross-Harness Review · 产品文档

> 一个 **Grok 插件**：让 Grok 在写代码、做方案、跑测试、查安全之前，把 **Claude Code** 和 **OpenAI Codex** 当作**只读的"第二意见审查者"**请进来。
> Grok 始终是主驾，外部审查者只看、只说，**不动手**。

---

## 一句话定位

**「单模型可能错得很有底气。Cross-Harness Review 让 Grok 在关键节点拉一个真正独立的模型来交叉验证。」**

外部审查者跑在受锁的只读沙箱里，它的输出被当作**不可信的候选证据**，Grok 必须先本地核对再行动。

---

## 解决什么问题（Why）

| 痛点 | 本插件的应对 |
|---|---|
| 单一模型自信地给出错误方案 | 引入**不同 harness + 不同模型**做交叉审查 |
| 担心外部工具乱改文件 / 执行命令 | 只读沙箱 + 工具白名单 + 主机作用域门禁 |
| 不知道何时该问第二意见 | 提供**显式斜杠**和**自然语言自动触发**两种入口 |
| 跨平台（Windows / POSIX / WSL）难统一 | 自带 PowerShell 与 POSIX 双桥接，自动发现 CLI |

---

## 核心功能

### 1. 四类审查任务

```text
/cross-harness-review plan [plan-file]              # 方案是否站得住脚
/cross-harness-review code   [--uncommitted ...]    # 代码评审深度
/cross-harness-review tests  [同 code 范围]         # 测试策略是否有缺口
/cross-harness-review security [同 code 范围]       # 安全审查
```

> `code` / `tests` / `security` 默认作用域是 `--uncommitted`（未提交改动）。

### 2. 两种触发方式

| Skill | 触发方式 | 适用场景 |
|---|---|---|
| `cross-harness-review` | 仅斜杠 `/cross-harness-review …` | 想要**显式、用户主动**发起的评审 |
| `cross-harness-auto` | 模型自主 + 斜杠 | 想让 Grok **听懂自然语言自动跑**（"开 PR 前帮我找 Claude 对一下"） |

### 3. 桥接层（Bridge）

- `probe --json`：在 `PATH`、`%APPDATA%/npm`、`%LOCALAPPDATA%`、WSL 里**发现所有候选 `claude` / `codex`**，逐个 `--version` 探测，挑语义版本最高且可执行的那个。
- `run`：把 prompt 写到 **stdin（绝不进 argv）**，在受限子进程里启动审查者，配套**临时目录隔离 + 硬超时（默认 300s）+ 输出体积上限**。

### 4. 主机作用域门禁（Host Scope Gate）

1. 从 Git 构建**改动文件白名单**（`uncommitted` / `base:<分支>` / `commit:<sha>`）；
2. 把**硬作用域边界**下发给审查者；
3. 任何 `evidence.file` 落在白名单外的发现，会被改写成 `verification: out_of_scope`，不会被采纳。

### 5. 输出归一化

把 Claude 的 `structured_output` 和 Codex 的 envelope 统一映射到一个标准信封 `review-result.schema.json`，Grok 后续处理逻辑只需认一种格式。

---

## 工作原理（一张图）

```
 ┌───────────┐   斜杠 / 自然语言     ┌──────────────────────────┐
 │   Grok    │ ───────────────────▶ │  cross-harness-review    │
 │  (主驾)   │ ◀─────────────────── │  bridge (invoke.ps1/.sh) │
 └─────┬─────┘  归一化信封 +         └───────────┬──────────────┘
       │  仅采纳已核实的发现                    │ stdin / 受限子进程
       │                           ┌────────────▼────────────┐
       │                           │  外部 harness CLI       │
       │                           │  • Claude Code (claude) │
       │                           │  • OpenAI Codex (codex) │
       └───────────────────────────┤  只读 / 沙箱化           │
                                   └─────────────────────────┘
```

**典型流程：** Grok 解析请求 → 桥接 `probe` 选 CLI → 桥接 `run` 投递 prompt → 主机作用域门禁过滤 → 归一化信封 → **Grok 本地打开引用证据复核 → 才动手**。

---

## 安全不变式（Safety Invariants）

| 维度 | 约束 |
|---|---|
| Claude 工具集 | 方案审查：**无工具**；代码类审查：**仅 `Read,Grep,Glob`** |
| Codex 沙箱 | `read-only` + `--ephemeral` + `--ignore-user-config` + `--ignore-rules` |
| Prompt 投递 | 走 **stdin**，绝不拼进 shell 字符串 |
| 输出 | stdout / stderr **体积上限**，避免爆内存 |
| 隔离 | 每次调用**独立临时目录** |
| 禁用项 | 无 hooks、无 agents、**无活动 MCP server**、无模型覆盖、无权限/沙箱绕过标志 |
| 采纳原则 | 审查者"成功" ≠ 授权改文件；**只有用户的请求才是** |

> 完整边界与已知限制见 [`SECURITY.md`](../SECURITY.md)。

---

## 环境要求

- **Grok CLI**（需支持插件）
- 至少装并登录其一：
  - **Claude Code CLI**（`claude`）
  - **Codex CLI**（`codex`）
- `git` 在 `PATH` 上（作用域快照与门禁依赖它）
- Windows 可选：**WSL**，若想让审查者跑在 Linux 发行版里

---

## 安装

三种途径，**插件文件完全相同**。

### A. 从 npm 安装（推荐）

```bash
npm install -g @sidler289-code/cross-harness-review

grok plugin install "$(npm root -g)/@sidler289-code/cross-harness-review" --trust
grok plugin enable cross-harness-review
grok plugin list
```

### B. 从 GitHub 安装

```bash
grok plugin install https://github.com/sidler289-code/GrokBuild-outsideHarness.git --trust
grok plugin enable cross-harness-review
```

### C. 本地克隆

```bash
git clone https://github.com/sidler289-code/GrokBuild-outsideHarness.git
grok plugin install /absolute/path/to/GrokBuild-outsideHarness --trust
grok plugin enable cross-harness-review
```

### 配置启用

确保 `~/.grok/config.toml` 含：

```toml
[plugins]
enabled = ["cross-harness-review"]
```

### 自检

```bash
grok inspect    # 应列出两个 skill，且无 agents / hooks / MCP servers
```

---

## 使用

**第一步：先 probe 一下，确认桥接能看到你的审查者 CLI**

```bash
# Windows
skills/cross-harness-review/scripts/invoke.ps1 probe --json
# POSIX / Git Bash
skills/cross-harness-review/scripts/invoke.sh probe --json
```

**第二步：让 Grok 跑一次评审**

```text
/cross-harness-review code --uncommitted

# 或者自然语言：
"开 PR 前帮我用 Claude + Codex 交叉看一下未提交改动"
```

### 桥接 CLI（进阶 / 脚本化）

```text
invoke.ps1|invoke.sh probe [--json]

invoke.ps1|invoke.sh run \
  --reviewer claude|codex \
  --task plan|code|tests|security \
  --repo <绝对路径> \
  [--input-file <绝对路径>] \
  [--scope uncommitted|base:<分支>|commit:<sha>] \
  [--timeout-secs <秒>] --json
```

> ⚠️ 永远把每个值当**独立进程参数**传，**不要**拼成 shell 字符串。

---

## 配置项

| 变量 | 作用 | 默认值 |
|---|---|---|
| `CROSS_HARNESS_CLAUDE` | 指定 Claude 可执行文件路径 | 自动发现 |
| `CROSS_HARNESS_CODEX` | 指定 Codex 可执行文件路径 | 自动发现 |
| `CROSS_HARNESS_WSL_DISTRO` | 偏好的 WSL 发行版 | 默认发行版 |
| `CROSS_HARNESS_TIMEOUT_SECS` | 单次评审进程超时 | `300` |
| `CROSS_HARNESS_MAX_INPUT_BYTES` | 方案输入体积上限 | `1048576`（1 MiB） |
| `CROSS_HARNESS_MAX_DIFF_BYTES` | Diff 快照体积上限 | `204800`（200 KiB） |
| `CROSS_HARNESS_DEBUG` | `1` 时硬错误输出桥接栈 | 关 |

> **失败即关闭**：显式指定的可执行路径如果坏了，**不会**静默回退到自动发现。

---

## 当前状态

首个公开发布：**v0.1**（`v0.1` tag，npm `0.1.0`）。

| 模块 | 状态 |
|---|---|
| 插件安装 / skills / probe | ✅ 就绪 |
| PowerShell + POSIX fake-CLI 测试矩阵 | ✅ 就绪 |
| 作用域快照 + 主机作用域门禁 | ✅ 就绪 |
| 真实 Claude / Codex provider | ✅ 装好并登录 CLI 即可用 |
| 活动 MCP server | ⏸ v0.1 未随包发布（未来可选） |

### 本地自测

```powershell
grok plugin validate .
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/probe.Tests.ps1
# POSIX 可选：
# bash --login tests/probe.tests.sh
```

---

## 仓库结构速览

```
cross-harness-review/
├── plugin.json                # Grok 插件清单
├── package.json               # npm 发布清单
├── skills/
│   ├── cross-harness-review/  # 显式斜杠 skill
│   │   ├── SKILL.md           # 工作流 + 安全不变式
│   │   ├── scripts/           # invoke.ps1 / invoke.sh 桥接
│   │   └── schemas/           # 归一化信封 + Claude 输出契约
│   └── cross-harness-auto/    # 模型可调用的自动触发 skill
├── config/                    # 空 MCP 配置 + 安装指引
├── tests/                     # PowerShell + POSIX 测试矩阵
└── docs/                      # 验收清单 + 阶段验证
```

---

## 许可证

MIT — 详见 [`LICENSE`](../LICENSE)。
