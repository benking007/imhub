# im-hub 架构总览（v0.2.13）

> 基线 commit：`18f96fb`（CR 修复批后）
> 配套文档：[`development.md`](../development.md) · [`extending.md`](../extending.md) · [`deployment.md`](../deployment.md)

---

## 一、系统形态

im-hub 是一个**进程内多面体网关**：单个 Node.js 进程同时扮演 IM 接入端、Agent 调用方、HTTP/REST/SSE/WebSocket 服务端、定时调度器和审计存储。所有组件共享同一个 `~/.im-hub/` 数据目录与同一棵 pino logger 树。

```
                         ┌─── 外部触发 ───┐
                         │ cron 30s tick │
                         │ webhook → /api/notify
                         │ REST → /api/invoke
                         │ ACP /tasks (sync/SSE)
                         └────────┬───────┘
  ┌─ IM 入口 ─────────────────────┼─────────────────────────┐
  │ WeChat iLink (1s long-poll + 60s heartbeat)             │
  │ Telegram (grammy long-poll)                              │
  │ Feishu (Lark SDK WebSocket)                              │
  │ Web Chat (browser WS, /tasks /settings 同源)             │
  └────────────────────────────────┬─────────────────────────┘
                                   │ MessageContext
                                   ▼
              ┌── Pre-route gates ─────────────────┐
              │ workspace.resolve(userId)          │
              │ rateLimiter.allow(userKey)         │
              │ traceId 生成 + pino child logger    │
              └────────────────┬───────────────────┘
                               ▼
              ┌── parseMessage + Intent ───────────┐
              │ /<cmd>          → builtin 子命令   │
              │ /<agent>        → explicit 切换    │
              │ default         → classifyIntent   │
              │   ├ topic regex (CJK + ASCII)      │
              │   ├ keyword profile               │
              │   ├ sticky session bias           │
              │   └ LLM judge (opt-in 兜底)        │
              └────────────────┬───────────────────┘
                               ▼
              ┌── Agent invocation ────────────────┐
              │ workspace whitelist + circuit       │
              │ breaker + isAvailable cache        │
              │ AgentBase.sendPrompt → spawnStream │
              │  (LineBuffer · 真流式 · abort/timeout)
              └────────────────┬───────────────────┘
                ┌──────┬───────┼────────┬─────────┐
                ▼      ▼       ▼        ▼         ▼
            opencode claude  codex   copilot  ACP remote
                       │             │
                       ▼             ▼
                 ┌─ Job Board ─┐    持久化任务（SQLite）
                 │ schedules → cron 自动 runJob
                 └─────────────┘
                       │
                       ▼
   ┌─ Cross-cutting ───────────────────────────────────┐
   │ audit-log (SQLite, 30 天保留)                     │
   │ metrics  (Prom text via /api/metrics)             │
   │ session  (~/.im-hub/sessions/, JSONL append)      │
   │ pino     (traceId 全链路, JSON in production)     │
   └───────────────────────────────────────────────────┘
```

整个进程**单实例**：没有外部 Redis/MQ 依赖。SQLite 三件套（`audit.db` / `jobs.db` / `schedules.db`）+ session 文件树就是全部的持久化。

---

（下一批：模块清单 + 调用契约）
