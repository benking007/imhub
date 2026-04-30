# 目标架构 · 智能网关

```
     外部系统 / cron / webhook / 第三方工具 ──┐
     ▼                                       ▼
┌──────── IM Front（messenger plugins）──────────────────────────┐
│ WeChat · Telegram · Feishu · Web · Teams · Slack · API ingress  │
└──────────────────────┬──────────────────────────────────────────┘
                       │ normalized IncomingEvent(userId, tenant, text, attachments, traceId)
                       ▼
      ┌──────────── AuthN/Z + Rate limit + Audit span start ────┐
      │  ACL / 用户白名单 / 单用户 QPS / Budget                  │
      └──────────────────────┬──────────────────────────────────┘
                             ▼
                ┌──────── Intent Router ─────────┐
                │ Explicit cmd  (/oc …)          │
                │ Sticky session (last agent)    │
                │ Topic classifier (小模型)      │
                │ Policy engine (rule + profile) │
                └──────────────┬─────────────────┘
                               ▼
              ┌──── Agent Invocation Layer ───┐
              │ AgentBase: abort / timeout /  │
              │  retry / stream / usage /     │
              │  circuit-breaker / health     │
              └──────────────┬────────────────┘
                             ▼
   ┌─────┬─────────┬────────┬───────────┬─────────────┐
   │ oc  │ claude  │ codex  │ copilot   │ ACP agents  │
   └─────┴─────────┴────────┴───────────┴─────────────┘
              │       │ fallback cascade
              ▼       ▼
      Long-running Job Board  (升级版 subtasks)
              │
              ▼
   ┌─ Observability ────────────────────────────────┐
   │ structured JSON log · OTEL trace · metrics     │
   │ audit log: user/intent/agent/cost/outcome      │
   └──────────────────┬─────────────────────────────┘
                      ▼
              IM 回复 + Web job 视图 + webhook callback
```

### 新增层次说明

#### 1. AuthN/Z + Rate Limit（网关前置）

- **身份识别**：从 IM 消息中提取 userId，查找 ACL 绑定，确定 role
- **权限控制**：RBAC — 角色绑定可用的 agent 列表 + 并发数 + 单用户 QPS
- **预算控制**：按用户 / 按天 / 按会话累计 tokens & cost，超额自动拒绝或降级（如切换到更便宜的 agent）
- **审计点**：拒绝原因日志（`audit.action = 'denied', reason = 'quota_exceeded'`）

#### 2. Intent Router（智能路由核心）

- **引擎**：先以规则引擎落地（命令匹配 > sticky > keyword 正则），Phase 2 升级为轻量 LLM classifier
- **输入**：消息文本 + 会话上下文（最近 N 条消息摘要）+ Agent 画像
- **输出**：目标 agent + confidence score + fallback agent list
- **可解释**：`/router explain` 回显决策理由

#### 3. Agent Base（统一调用抽象）

代替当前各 adapter 各自实现 `sendPrompt / timeout / abort` 的局面：

```typescript
interface AgentBase {
  sendPrompt(sessionId, prompt, history, opts): AsyncGenerator<Chunk>
  isAvailable(): Promise<boolean>
  healthCheck(): Promise<HealthStatus>    // periodic probe
  getUsage(sessionId): UsageStats
  // 由基类统一处理的：
  timeoutManager    // opts.timeoutMs + kill on timeout
  abortController   // opts.signal mapping
  streamParser      // uniform JSONL parser per adapter
}
```

#### 4. Job Board（升级子任务）

- 当前 subtasks 存在 session 里，6 小时过期丢失
- 升级为独立持久化的 Job 队列，支持暂停/恢复/重跑/归档
- Web UI 中的 Agent 任务列表视图

#### 5. Observability（贯穿全链路）

- **Structured JSON log**（pino）：所有组件统一格式
- **Trace ID**：从 incoming message 生成，贯穿 messenger → router → agent → reply
- **Metrics**：latency p50/p95/p99、error rate、cost per agent per user
- **Audit log**：写入 sqlite，可 SQL 查询

---

### 数据流（以一次典型请求为例）

```
1. 用户在微信发送 "帮我分析下最近 A 股行情，给 3 个候选标的"
2. WeChat iLink adapter 接收 → 生成 traceId=tr_xxx
3. AuthN/Z: 查 ACL → userId=wx_yyy → role=premium → 可全 agent、无超 quota
4. Intent Router:
   - 不是 explicit cmd
   - sticky: 上次用 opencode → preference +0.2
   - topic classifier: "A 股行情 技术分析" → tag: finance → agents: [opencode, claude-code] each +0.3
   - Final: opencode (score=0.9) vs claude-code (0.8) vs codex (0.3)
   - → route to opencode
5. Agent Invocation Layer:
   - 查 health → opencode OK
   - timeout = 5min (config: per agent default)
   - stream chunks back
6. 结果流回 WeChat iLink → 分片发送 + stop typing
7. Audit log 写入: span complete (duration=23s, cost=$0.12, agent=opencode)
```
