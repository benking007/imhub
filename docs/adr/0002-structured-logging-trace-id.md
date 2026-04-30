# ADR-0002: Structured Logging & Trace ID

- **日期**：2026-04-30
- **状态**：接受（Phase 1 本批次落地）

---

## Context

im-hub 当前使用 `console.log()` / `console.error()` 输出日志，存在以下问题：

1. **无结构化字段**：无法按 `platform` / `agent` / `userId` 过滤或聚合
2. **无 trace**：无法将一条消息的完整处理链路（messenger → router → agent → reply）串联
3. **无等级控制**：debug 信息和生产日志混在一起
4. **敏感字段泄露风险**：bot_token、appSecret 可能随错误信息输出到日志

对"智能网关"而言，以上是基本要求。

## Decision

**引入 pino 作为结构化日志库，并在整个请求链路中传递 traceId。**

### 技术选型

| 选项 | 依赖数 | 性能 | 生态 | 决定 |
|------|--------|------|------|------|
| pino | 1 | 最高 | 成熟 | ✅ 选 |
| 自写 JSON Logger | 0 | 中 | — | ❌ 仅 fallback |
| winston | 重 | 中 | 成熟 | ❌ |

### 日志字段规范

```json
{
  "ts": "2026-04-30T09:14:21.123Z",
  "level": 30 (info),
  "traceId": "tr_abc123",
  "spanId": "sp_def456",
  "component": "router | messenger.wechat | agent.opencode",
  "event": "message.received | agent.invoke.start | agent.invoke.end",
  "platform": "wechat",
  "threadId": "user:xxx",
  "userId": "yyy",
  "agent": "opencode",
  "durationMs": 1234,
  "cost": 0.0012,
  "error": null
}
```

### 实现细节

1. **Logger 工厂** (`core/logger.ts`)：
   - `createLogger()` → pino 根实例，目标 stdout，格式由 `LOG_FORMAT` env 控制（`pretty` / `json`），默认自动检测 TTY
   - `generateTraceId()` → 时间戳前缀 + 随机短码（如 `tr_abc123`），UUID v4 去 `-` 取前 12 位
   - `childLogger(parent, bindings)` → 创建带 `traceId` 的子 logger

2. **MessageContext 扩展**：在 `core/types.ts` 的 `MessageContext` 接口中加 `traceId` 字段（必填），在命令行中 `--trace-id` 参数可选用于外部注入

3. **注入点**：在 `src/cli.ts` 和 `src/web/server.ts` 的消息入口处生成，通过 `ctx.traceId` 传入 `src/core/router.ts`，再通过 `opts.traceId` 传入 agent adapter

4. **记录点**：
   - Messenger → `message.received` (info)
   - Router → `route.matched` (debug)
   - Agent → `agent.invoke.start` (info) / `agent.invoke.end` (info, 含 duration/cost) / `agent.invoke.error` (error)
   - Messenger reply → `message.sent` (debug)
   - 异常 → `error` level + error.stack

5. **敏感字段保护**：`createLogger()` 注册 `serializers`，自动将 `bot_token`、`appSecret`、`token` 等字段从日志对象中脱敏（替换为 `[REDACTED]`）

6. **颜色区分**：按照 shell 约定，DEBUG 用灰色、INFO 用白色、WARN 用黄色、ERROR 用红色，由 pino-pretty 处理

7. **生产环境**（`LOG_FORMAT=json`）：单行 JSON，可直接接入 log 采集或通过 jq 解析

### 渐进式迁移

- 第一批（本次）：核心路径（messenger → router → opencode agent）+ 所有 `console.log` → `logger.info`
- 第二批（Phase 1 后续）：其他 agent（claude-code / codex / copilot / ACP）
- 第三批（Phase 2）：metrics 从日志中提取聚合

## Consequences

- **正面**：可追溯每条消息的全链路（traceId 查询），可按维度聚合（jq/filter），日志可读性大幅提升
- **负面**：pino 增加一个依赖（~15KB gzipped），API 与 console.log 不一致需适配
- **风险**：如果 pino stream 阻塞（极罕见），可能影响消息处理 —— 默认 pipe 到 stdout，不涉及磁盘 IO 阻塞
