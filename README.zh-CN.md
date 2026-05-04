# im-hub

[English](README.md)

**IM 到 AI Agent 的万能桥梁** — 将微信 / 飞书 / Telegram / **Discord** 接入 Claude Code / Codex / Copilot / OpenCode，**或通过 ACP 接入任意自定义 Agent**。单 Node.js 进程，无需 Docker / Redis；自带浏览器仪表盘、持久化任务、多租户工作区，IM 端真正的"工具调用人审"。

<p align="center">
  <img src="assets/banner.jpg" alt="im-hub banner" width="800">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/im-hub"><img src="https://img.shields.io/npm/dw/im-hub?style=for-the-badge&logo=npm&color=green"></a>
  <a href="https://github.com/ceociocto/im-hub/actions/workflows/release.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/ceociocto/im-hub/release.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/im-hub"><img src="https://img.shields.io/npm/v/im-hub?style=for-the-badge" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://discord.gg/R83CXYz5"><img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  &nbsp;
  <a href="https://x.com/lijieisme"><img src="https://img.shields.io/badge/X-000000?style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
</p>

<p align="center">
  <img src="assets/screenshot-telegram.png" alt="Telegram" width="400">
  &nbsp;&nbsp;
  <img src="assets/screenshot-wechat.png" alt="WeChat" width="400">
</p>

<p align="center">
  <b>Telegram</b> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <b>微信</b>
</p>

```
npm install -g im-hub
im-hub config wechat   # 扫码登录微信
im-hub start           # 启动桥接 + Web UI（:3000）
```

## 0.2.13 → 0.2.15 主要升级

- **Discord 适配器**（基于 `discord.js` 的 Gateway WebSocket）
- **工具调用人审（HITL）** — Claude 调工具时自动暂停，IM 同一会话回复 `y`/`n` 即可
- **任务仪表盘** `/tasks`，新增 **Background**（Claude/opencode bgjobs）与 **Subtasks** 两个标签
- **多租户 Workspace** — 每个工作区独立的 Agent 白名单 + 限流
- **ACP Server 模式** — im-hub 自身作为 ACP 兼容 Agent（`POST /tasks`，sync + SSE）
- **持久化 Job Board** + Cron 调度器（SQLite 落地，重启不丢）
- **智能路由**：意图分类（中英文）、断路器、Sticky 会话
- **结构化日志**（`pino`）+ 全链路 `traceId` + 审计日志 + Prometheus `/api/metrics`

完整变更见 [CHANGELOG.md](CHANGELOG.md)。

## Web 对话与任务仪表盘

```
im-hub start           # 启动后访问 http://localhost:3000
                       #   /          对话
                       #   /tasks     jobs · 调度 · bgjobs · subtasks
                       #   /settings  Agent · 通道 · ACP
```

- WebSocket 实时流式响应
- Agent 切换与对话历史
- 中英双语界面，自动检测浏览器语言
- `/tasks` 同时展示持久化任务、cron 调度、**`~/.claude/bgjobs`** + **`~/.config/opencode/bgjobs`** 的后台任务（可用 `IMHUB_BGJOB_ROOTS` 覆盖）以及所有会话中的 subtask 平铺列表

## 核心特性

- **多路复用** — 一个实例同时对接多个 IM 与多个 Agent
- **自定义 Agent 接入** — 通过 [ACP 协议](https://agentcommunicationprotocol.dev) 接入任何 HTTP 端点；支持 `/.well-known/acp` 自动发现
- **内置 IM 通道** — 微信（iLink）、飞书（WebSocket 长连接）、Telegram（grammy）、**Discord**（discord.js）
- **内置 Agent** — Claude Code、Codex、Copilot、OpenCode（统一 `AgentBase` 适配）
- **插件架构** — 轻松扩展新 IM / Agent
- **原生 TypeScript** — 无需 Go / Docker / Redis
- **JSONL 流式输出** — 真实流式 + 多字节 UTF-8 安全

## 安装

```bash
npm install -g im-hub
```

需要 **Node.js ≥ 18**（生产推荐 ≥ 22 LTS，详见 [`docs/deployment.md`](docs/deployment.md)）。

## 快速开始

```bash
# 1. 配置至少一个 IM
im-hub config wechat        # 扫码登录
im-hub config feishu        # 飞书 App ID + Secret，无需 webhook
im-hub config telegram      # @BotFather 拿 Token
im-hub config discord       # Bot Token，详见 docs/discord-setup.md

# 2. （可选）配置 Agent CLI，多数能自动检测
im-hub config claude

# 3. （可选）通过 ACP 接入远端自定义 Agent
im-hub config agent

# 4. 启动
im-hub start
```

### 飞书（WebSocket 长连接）

- ✅ 无需 webhook
- ✅ 无需公网 IP / 域名
- ✅ 无需 ngrok 内网穿透
- ✅ 直接从本地启动

### Discord

完整流程（创建 Bot、Intents、OAuth 邀请）见 [`docs/discord-setup.md`](docs/discord-setup.md)。

### 接入你自己的 Agent

im-hub 支持 **ACP（Agent Communication Protocol）**，只要你的 Agent 暴露一个标准 HTTP 端点就能接入——业务机器人、内部工具、云服务，皆可。

```bash
im-hub config agent
# 交互式：名称、端点、认证（无 / Bearer / API Key），自动验证连接 + /.well-known/acp 自动发现
```

接入后用法和内置 Agent 一致：

```
/myagent 分析一下一季度的销售报告
```

### 把 im-hub 当作 Agent 用

im-hub 同时暴露 ACP 服务端，任何 ACP 客户端都可以以 `POST http://localhost:3000/tasks`（同步）或加 `?mode=stream`（SSE）调用，鉴权同 Web Token：`Authorization: Bearer <token>`。

## CLI 命令

```
im-hub                 # 等同 start
im-hub start           # 启动桥接 + Web UI
im-hub config wechat   # 配置微信
im-hub config feishu   # 配置飞书
im-hub config telegram # 配置 Telegram
im-hub config discord  # 配置 Discord
im-hub config claude   # 配置 Claude Code
im-hub config agent    # 接入自定义 ACP Agent
im-hub agents          # 列出可用 Agent
im-hub messengers      # 列出可用 IM
im-hub help
```

## 聊天命令

直接在 IM 里发，回包流式回到同一 thread。

| 命令 | 含义 |
|---|---|
| 任意文本 | 路由到 Agent（Sticky 会话 + 意图分类） |
| `/<agent> <内容>` | 切换 Agent 并发送（如 `/cc 解释这段代码`、`/oc`、`/cx`、`/co`） |
| `/help` | 帮助 |
| `/agents` | 列出可用 Agent |
| `/status` | 连接状态 |
| `/new` | 开新会话（清空历史） |
| `/router status\|policy\|explain\|reset` | 查看路由策略 / 预测某条消息会去哪 |
| `/audit [n]` | 最近的调用审计 |
| `/job ...` | 查看 / 取消持久化任务 |
| `/schedule ...` | 列出 / 添加 / 删除 cron 调度 |
| `/sessions` | 列出本 thread 最近的会话 |
| `/model [provider/model]` | 查看或切换会话模型 |
| `/models` | 列出当前 Agent 可用模型 |
| `/think on\|off\|...` | 切换"深度思考"模式 |
| `/stats` | Agent 调用 / 延迟 / 错误统计 |
| `y` / `n` / `批准` / `拒绝` | 同意 / 拒绝 Claude 工具调用（HITL） |

## 工具调用人审（Human-in-the-loop）

当你从 IM 启动的 Claude 任务尝试调用工具时，im-hub 会暂停它，并在同一 IM 会话发送审批卡片：

```
🔐 工具调用审批请求
工具：Bash
入参：{"command":"rm -rf node_modules"}
回复 y 批准 / n 拒绝（5 分钟内未操作将自动拒绝）
req: a3f1c0d2
```

回复 `y` / `n` / `批准` / `拒绝`，决策通过 MCP sidecar 回到 Claude，对应继续或中止执行。同一审批链路在微信 / Telegram / 飞书 / Discord 上零差异工作。可用 `IMHUB_APPROVAL_DISABLED=1` 关闭。

## 架构

```
                       ┌─── 外部触发 ────┐
                       │ cron 30s tick    │
                       │ webhook → /api/notify
                       │ REST   → /api/invoke
                       │ ACP    → /tasks (sync/SSE)
                       └────────────┬─────┘
┌─ IM 入口 ────────────────────────┼─────────────────────┐
│ 微信 iLink     （长轮询 + 心跳）                       │
│ Telegram       （grammy）                              │
│ 飞书           （Lark SDK WebSocket）                  │
│ Discord        （discord.js Gateway）                  │
│ Web Chat       （浏览器 WebSocket）                    │
└────────────────────────────────┬──────────────────────┘
                                 │ MessageContext
                                 ▼
            ┌── 路由前置 gates ─────────────────┐
            │ workspace.resolve(userId)          │
            │ rateLimiter.allow(userKey)         │
            │ traceId + pino 子 logger           │
            └────────────────┬───────────────────┘
                             ▼
            ┌── parseMessage + 意图分类 ───────┐
            │ /<cmd>     → 内置子命令            │
            │ /<agent>   → 显式切换              │
            │ default    → classifyIntent       │
            │   ├ 主题正则（中英）               │
            │   ├ 关键词画像                    │
            │   ├ Sticky 会话偏置                │
            │   └ LLM 兜底（按需）               │
            └────────────────┬───────────────────┘
                             ▼
            ┌── Agent 调用 ─────────────────────┐
            │ workspace 白名单 + 断路器          │
            │ + 可用性 TTL 缓存                 │
            │ AgentBase.sendPrompt → spawnStream│
            │  (LineBuffer · 真流式 ·           │
            │   abort/timeout · UTF-8 安全)      │
            └────────────────┬───────────────────┘
              ┌──────┬───────┼────────┬─────────┐
              ▼      ▼       ▼        ▼         ▼
          opencode claude  codex   copilot   ACP 远端
                     │
                     ▼ （工具需要审批时）
              MCP sidecar ─ unix socket ─ approvalBus
                                            └─ approvalRouter → IM 会话

┌─ Cross-cutting ───────────────────────────────────────┐
│ audit-log    (SQLite，30 天保留)                       │
│ job-board    (SQLite 持久化 + AbortController)        │
│ scheduler    (30s tick → cron → 入队)                  │
│ workspaces   (按租户隔离 Agent 白名单 / 限流)          │
│ metrics      (Prometheus 文本，/api/metrics)           │
│ session      (~/.im-hub/sessions/，append-only JSONL) │
│ pino         (traceId 全链路，生产 JSON)               │
└───────────────────────────────────────────────────────┘
```

单进程、单实例：SQLite 三件套（`audit.db` / `jobs.db` / `schedules.db`）+ 会话文件树就是全部持久化层，不依赖 Redis / MQ。

更深入的架构剖析见 [`docs/architecture/current.md`](docs/architecture/current.md)。

## 项目结构

```
im-hub/
├── src/
│   ├── core/
│   │   ├── types.ts              # 插件接口
│   │   ├── registry.ts           # 插件注册
│   │   ├── router.ts             # 消息路由
│   │   ├── session.ts            # 会话管理（append-only JSONL）
│   │   ├── workspace.ts          # 多租户工作区
│   │   ├── intent.ts             # 意图分类
│   │   ├── intent-llm.ts         # LLM 兜底（LRU 缓存）
│   │   ├── circuit-breaker.ts    # 单 Agent 断路器
│   │   ├── rate-limiter.ts       # Token bucket 限流
│   │   ├── job-board.ts          # 持久化任务 + 取消
│   │   ├── schedule.ts           # cron tick → 入队
│   │   ├── audit-log.ts          # SQLite 审计
│   │   ├── metrics.ts            # Prometheus 分位
│   │   ├── acp-server.ts         # /tasks ACP 服务端
│   │   ├── approval-bus.ts       # 工具审批 pub/sub
│   │   ├── approval-router.ts    # 审批 ↔ IM 桥
│   │   ├── bgjob-reader.ts       # ~/.claude + ~/.config/opencode bgjobs
│   │   ├── agent-base.ts         # CLI Agent 共享 spawn/stream
│   │   ├── config-schema.ts      # zod schema
│   │   ├── logger.ts             # pino + traceId
│   │   ├── sqlite-helper.ts      # 共享 prepare / PRAGMA 缓存
│   │   └── commands/             # /audit /router /job /schedule /model …
│   ├── plugins/
│   │   ├── messengers/
│   │   │   ├── wechat/           # iLink 长轮询
│   │   │   ├── feishu/           # Lark SDK WebSocket
│   │   │   ├── telegram/         # grammy
│   │   │   └── discord/          # discord.js
│   │   └── agents/
│   │       ├── claude-code/      # 含 MCP 审批 sidecar
│   │       ├── codex/
│   │       ├── copilot/
│   │       ├── opencode/
│   │       └── acp/              # ACP 客户端 + /.well-known 发现
│   ├── index.ts
│   ├── cli.ts
│   └── web/
│       ├── server.ts             # HTTP + WS + REST + ACP server
│       └── public/
│           ├── index.html         # 对话界面
│           ├── tasks.html         # 任务仪表盘
│           └── settings.html      # 设置界面
├── docs/
│   ├── architecture/{current,target}.md
│   ├── adr/{0001,0002,0003}-*.md
│   ├── deployment.md
│   ├── discord-setup.md
│   └── upgrade-plan.md
├── package.json
├── tsconfig.json
└── README.md
```

## 配置

配置文件：`~/.im-hub/config.json`

```json
{
  "messengers": ["wechat", "discord"],
  "agents": ["claude-code", "opencode"],
  "defaultAgent": "claude-code",
  "discord": {
    "botToken": "***",
    "allowedGuilds": [],
    "allowedChannels": []
  },
  "acpAgents": [
    {
      "name": "my-agent",
      "aliases": ["ma"],
      "endpoint": "https://api.example.com",
      "auth": { "type": "bearer", "token": "***" },
      "enabled": true
    }
  ],
  "workspaces": [
    {
      "id": "team-data",
      "name": "数据团队",
      "agents": ["opencode", "my-agent"],
      "members": ["user-123"],
      "rateLimit": { "rate": 30, "intervalSec": 60, "burst": 60 }
    }
  ]
}
```

由 `zod` 在启动时与每次 PUT `/api/config` 时校验，配置错误会立即报错而不是带病运行。

## 环境要求

- **Node.js 18+**（生产建议 22 LTS+）
- **至少一个 Agent CLI**（或 ACP 远端）：
  - `npm i -g @anthropic-ai/claude-code`
  - `npm i -g @openai/codex`
  - `npm i -g @github/copilot`
  - `npm i -g opencode-ai`

## 开发

```bash
git clone https://github.com/benking007/imhub.git
cd im-hub
npm install
npm run build      # tsc + 拷贝 public/
npm run dev        # tsc --watch
npm test           # bun test
npm run typecheck  # tsc --noEmit（src + 测试）
npm start
```

## 路线图

### v0.1.x（MVP）
- [x] 微信扫码登录
- [x] Claude Code、Codex、Copilot、OpenCode Agent
- [x] 基础命令路由

### v0.2.0 — 多 IM
- [x] 飞书适配器
- [x] Telegram 适配器
- [x] 会话持久化与对话历史
- [x] ACP 自定义 Agent 接入

### v0.2.x — Web & UI
- [x] Web 对话界面（流式）
- [x] 设置页面
- [x] 双语界面（EN / 中文）

### v0.2.13 — 基础设施
- [x] 结构化日志（pino）+ traceId
- [x] zod 配置 schema 校验
- [x] AgentBase 抽象 + 可用性缓存
- [x] 审计日志（SQLite）+ `/audit`
- [x] 意图分类 + 断路器 + 限流
- [x] ACP server 模式（`POST /tasks`，sync + SSE）
- [x] `/.well-known/acp` 自动发现
- [x] 多租户 Workspace + Agent 白名单
- [x] 持久化 Job Board + cron 调度
- [x] Web `/tasks` 面板 + REST API
- [x] Prometheus 指标

### v0.2.14 — 工具审批
- [x] IM 端的工具调用人审（HITL）
- [x] MCP 审批 sidecar（claude-code adapter）

### v0.2.15 — Discord & 仪表盘
- [x] Discord IM 适配器
- [x] 任务面板接入 Claude / opencode bgjobs
- [x] Subtask 平铺列表

### v0.3.0
- [ ] 钉钉适配器
- [ ] Slack 适配器
- [ ] 飞书 / Discord 卡片按钮版审批（替代纯文本）

## 社区 <a name="wechat-group"></a>

有问题？欢迎在 [X](https://x.com/lijieisme) 或 Discord 上交流。

<p align="center">
  <a href="https://discord.gg/R83CXYz5">
    <img src="https://img.shields.io/badge/加入_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord">
  </a>
  &nbsp;
  <a href="https://x.com/lijieisme">
    <img src="https://img.shields.io/badge/关注_X-000000?style=for-the-badge&logo=x&logoColor=white" alt="X">
  </a>
</p>

<p align="center">
  <img src="assets/wechat-group" alt="原作者微信" width="180"><br>
  <sub><i>原作者联系方式</i></sub>
</p>

## 许可证

MIT
