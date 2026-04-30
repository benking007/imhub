# 当前架构（v0.2.12）

> 来自 code-review-2026-04-30.md 图 1

```
┌──── IM 端（事件驱动） ──────────────┐
│ WeChat iLink (poll 1s)             │
│ Telegram (grammy long-poll)        │
│ Feishu (Lark SDK WS)               │
│ Web Chat (WS)                      │
└──────────────┬─────────────────────┘
               │ MessengerAdapter.onMessage(ctx)
               ▼
         ┌──────────────────────────┐
         │  cli.ts handleMessage     │   ← 150 行混合逻辑
         │  → parseMessage (regex)   │
         │  → routeMessage           │
         └──────────────┬────────────┘
                        ▼
       ┌────── router.ts 1087 行 ─────────┐
       │ parseMessage  ──┐                 │
       │ tryInterpretADP │ (正则硬码 NLP) │
       │ handleBuiltIn   │                 │
       │ handleAgentCmd  │                 │
       │ subtask switch  │                 │
       │ /model /models  │                 │
       │ /stats usage    │                 │
       │ /ok /no /exec   │                 │
       └─────────┬───────────────────────┘
                 ▼
      registry.findAgent(alias)     ← 静态 alias 查表，无智能
                 ▼
     ┌───────────┼──────────────────┐
     ▼           ▼                  ▼
  opencode    claude-code    ACP remote
  (spawn)     (spawn)        (HTTP SSE)
  ↕ 30min     ↕ 无 timeout   ↕ 5min
  硬超时      无 abort       有 abort
  streaming   buffered       streaming
  session id  无             sessionId 未用
```

### 关键流程

1. **消息接入**：各 Messenger plugin 以各自协议接收消息（WeChat iLink HTTP poll、Telegram grammy long-poll、Feishu Lark SDK WS、Web Chat WS），统一转换为 `MessageContext { message, platform, channelId }`，调用 `onMessage` 注册的回调。

2. **命令解析**：`parseMessage()` 按 `/` 前缀分词，匹配内置命令（status/help/new/sessions/approve/ok/no/exec/list/model/models/think/stats/task/tasks/check/cancel/switch/collect）→ Agent 别名 → agent 内置命令 → 错误。无 `/` 前缀的走 default 路径。

3. **路由决策**：
   - `command` 类型 → 内置命令处理
   - `agent` 类型 → 切换会话 agent + 调用 agent
   - `agentCommand` 类型 → 当前 agent 执行 `/test /review /commit push diff shell bug explain`
   - `default` 类型 → ADP 意图检测（有 pending 时）→ subtask 已激活时路由到子会话 → 否则用当前/默认 agent

4. **Agent 调用**：`callAgentWithHistory()` 构造上下文 prompt，调用 `agent.sendPrompt()`（async generator），收集文本 → 存储到 session → 返回流给 messenger。

### 当前缺失

- ❌ Observability（logs / metrics / trace / audit）
- ❌ Auth & RBAC & multi-tenant
- ❌ Rate limit / quota / budget
- ❌ Circuit breaker / health / fallback cascade
- ❌ Intent routing（目前全靠用户 /alias）
- ❌ Outgoing gateway（别的系统 → im-hub → IM）
