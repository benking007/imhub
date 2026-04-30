# ADR-0001: Agent Base Abstraction

- **日期**：2026-04-30
- **状态**：提议（Phase 1 后续批次落地）

---

## Context

im-hub 目前有 5 个 Agent 适配器（opencode、claude-code、codex、copilot、ACP），每个独立实现了 `isAvailable()`、`sendPrompt()`、超时处理、abort 支持、流式解析。这使得以下行为不一致：

- 只有 opencode 有 30min 超时，其他无超时保护
- 只有 opencode 和 ACP 支持 abort signal
- 只有 opencode 利用 CLI 的 `--session` 实现上下文保持
- copilot 和 codex 把全部历史拼成纯文本注入 prompt（token 浪费）
- 每次新增 agent 都需要重写一遍 timeout/abort/stream 逻辑

## Decision

在 **Phase 1 后续批次**中引入 `AgentBase` 抽象类，统一：

| 能力 | 当前各 adapter 自行实现 | AgentBase 统一提供 |
|------|------------------------|-------------------|
| isAvailable | 各自 spawn 子进程检测 | 基类包装 + 缓存 + TTL |
| timeout | opencode 30min，其他无 | 统一 `opts.timeoutMs` → SIGTERM/SIGKILL 阶梯 |
| abort | opencode/ACP 有，其他无 | 统一 `opts.signal` → AbortController |
| stream parsing | JSONL 各自解析 | 基类提供 `parseStream()` helper |
| session 重用 | 仅 opencode | 基类提供 `#sessionMap` + `getSessionId()/setSessionId()` |
| usage 收集 | opencode 有，其他无 | 基类统一字段 `usage: { tokens, cost, steps }` |
| health check | 无 | `healthCheck()`: 定期探活，返回 `{ ok, latencyMs }` |
| circuit breaker | 无 | 可选：`failCount > threshold → open` |

### 接口契约

```typescript
abstract class AgentBase {
  abstract name: string;
  abstract aliases: string[];

  abstract isAvailable(): Promise<boolean>;
  abstract healthCheck(): Promise<{ ok: boolean; latencyMs?: number }>;

  // 子类只需实现 buildCommand() + extractText()
  abstract buildCommand(prompt: string, opts: AgentOpts): CommandSpec;
  abstract extractText(event: unknown): string;

  // 基类统一实现（子类可按需覆盖）
  async *sendPrompt(sessionId, prompt, history, opts): AsyncGenerator<Chunk>;
  timeoutManager(opts): { signal, cleanup };
  circuitBreaker: CircuitBreaker (optional);
}
```

## Consequences

- **正面**：新增 agent 只需实现 `buildCommand() + extractText()`（~30 行），不用重复写 200 行 spawn/timeout/abort/stream
- **正面**：所有 agent 获得等同的 timeout/abort/session/usage 能力
- **正面**：便于在网关层实现 circuit breaker、health probe、agent 画像
- **负面**：需要重构现有 5 个 adapter（每次重构都有引入 bug 的风险）
- **负面**：抽象层增加复杂度，可能"过度设计"某些简单 agent 的适配器
- **迁移策略**：先写 AgentBase + 迁移 opencode 验证，再逐个迁移其他 4 个

## 替代方案

1. **不抽象，保持现状**：开发速度快，但技术债务累积，agent 行为不一致
2. **仅统一 interface (TS type)，不提供基类实现**：轻量但无法消除重复代码
3. **用 mixin 代替继承**：更灵活但调试和可读性差

选择继承式基类，因为各 agent 有大量共享的实现（spawn 进程、parse stream、timeout 管理），继承是合理的。
