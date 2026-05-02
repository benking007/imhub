# ADR-0004: Sticky-Agent 绝对锁 + 会话 TTL 双层拆分

- **日期**：2026-05-02
- **状态**：接受（im-hub v2 Phase A + D 落地）
- **相关计划**：`docs/im-gateway-v2-plan.md`

---

## Context

### 症状

用户报告：在 IM 中正在使用 Claude Code 与 Agent 对话，跨日 / 长停留之后，下一条消息可能被路由到 opencode，造成"Agent 漂移"。预期是"非显式不切换"。

### 根因（漂移路径）

1. `core/session.ts:38` `DEFAULT_TTL = 30 * 60 * 1000`（30 min）。
2. cleanup 定时器（5 min 间隔）发现 idle > TTL → 删除 in-memory + `~/.im-hub/sessions/<key>.{json,log}`，**包括** `claudeSessionId` / `claudeSessionPrimed`。
3. 下条消息进来，`getExistingSession` → undefined → `stickyAgent = undefined`。
4. `classifyIntent` 重跑：opencode `weight=1.2` vs claude-code `1.0`，加上"代码/code/git/test/bug"等关键字大量重叠，opencode 几乎必赢。
5. router.ts:337-339 `agentName !== stickyAgent` → `switchAgent` 真切走。

### 二级根因

即使 sticky 还在，`classifyIntent` 也会跑完整评分流程，sticky 仅得 `+3` 偏置。一条长消息匹配多个 opencode 关键字时（`+1 * 1.2 * N`），分数能反向覆盖 sticky。

---

## Decision

### A. Sticky 改为绝对锁

`core/intent.ts:classifyIntent` 在函数入口处增加早返回：当 `stickyAgent` 提供且在可用列表里，直接返回，不进入评分流程。

```typescript
if (stickyAgent && available.includes(stickyAgent)) {
  return {
    agent: stickyAgent,
    score: 0,
    reason: 'sticky lock (no classification)',
    triggeredBy: 'sticky',
  }
}
```

### A'. 平衡权重

把 opencode `weight: 1.2` 降为 `1.0`，与 claude-code 持平。这样在新 thread（无 sticky）上，路由由 topic 规则 + defaultAgent 决定，而非"opencode 通吃"。

### D. 会话 TTL 双层拆分

`core/session.ts` 拆为两个常量（默认值，可被 env 覆盖）：

```typescript
MESSAGES_TTL = 30 min   (env: IMHUB_SESSION_MESSAGES_TTL_MS)
META_TTL     = 7 days   (env: IMHUB_SESSION_META_TTL_MS)
```

| TTL | 涵盖字段 | 过期效果 |
|---|---|---|
| MESSAGES_TTL | `session.messages[]`、`<key>.log` | 清空内存数组 + 删 `.log` 文件 |
| META_TTL | `agent`、`model`、`variant`、`claudeSessionId`、`claudeSessionPrimed`、`usage`、`subtasks`、`<key>.json` | 完整删除（含内存与磁盘） |

### 实现细节

- `getOrCreateSession` / `getExistingSession`：先 `metaStale()` 判断 → 如已过 META 视为不存在；否则 `messagesStale()` → 已过则清空 messages 但保留 session 返回。
- `cleanup()` 同样的双层判断。
- `addMessage` 不动：调用时 lastActivity 自动更新；append 到刚被 unlink 的 log 时 `appendFile` 自然新建。
- `loadSession` 不动：磁盘读到老 messages 后由调用方判断是否清空。

### 兼容性

- 旧 session 文件里的 `ttl: 30 * 60 * 1000` 字段仍存在但不再用于判断逻辑；新写入的 session 把 `ttl` 设为 `META_TTL`（7d）。
- `DEFAULT_TTL` 符号保留并指向 `META_TTL`，避免外部 import 断裂。
- `test/unit/session-real.test.ts` "legacy one-file format" 用例（手工写 `ttl: 60_000` 的 json 然后立刻读）仍通过 — 60s TTL 字段被忽略，META_TTL 才是判定标准。

---

## Consequences

### 正面

- **杀漂移**：sticky 绝对锁，跨日/久不说话再回来，agent 不会被改。要切只能 `/cc`、`/oc`、`/<别名>` 显式指令。
- **保留 Claude resumable session**：`claudeSessionId` 7d 内不丢，下次回来 cli.ts:391 的 `claudeRunWillResume = !!stickySession?.claudeSessionPrimed` 判断为 true，Claude 那边的 jsonl 完整对话历史能续上。
- **路由分类器更可预测**：第一条消息（无 sticky）的路由仍由 topic 规则 + 关键字决定，opencode/claude-code 权重相同后，由 PROFILES 声明顺序兜底（opencode 优先）；这是已有的可解释行为。
- **运维可调**：META_TTL 默认 7 天对个人使用够了；多用户大流量场景可以下调为 1 天，磁盘压力可控。

### 负面

- **冷 thread 永久绑定**：用户半年前在某 thread 用过 opencode 然后忘了，半年后回来 sticky 已自然过期（>7d）才会重新分类。中间可能让人困惑。**缓解**：`/agents` 看可用，`/<agent>` 一键切，`/new` 重置。
- **磁盘上常驻 session 元数据**：`~/.im-hub/sessions/*.json` 文件数量随 thread 增长，单文件 < 2KB；7d 后 cleanup。可接受。
- **Phase D 之后，对 opencode 的"上下文连续性"无改善**：opencode 没有自己的 resumable session 概念，30 min 后 messages 被清空，下次上下文丢失 — 这是 opencode `run` 模型本身的限制，非本 ADR 范围。

### 中性

- `IMHUB_STICKY_PINNED` 这种"全局禁分类"开关本想加，但既然 sticky 已经是绝对锁，意义不大，未实现。如果以后要"第一条消息也禁止分类、永远走 defaultAgent"再加。

---

## 实现位置

- `src/core/intent.ts:16-38`（PROFILES 权重）
- `src/core/intent.ts:91-113`（sticky 早返回）
- `src/core/session.ts:38-70`（TTL 常量与 helper）
- `src/core/session.ts:88-130`（getOrCreateSession 双层判断）
- `src/core/session.ts:132-167`（getExistingSession 双层判断）
- `src/core/session.ts:625-655`（cleanup 双层判断）

## 验证

- `bun test test/unit/intent.test.ts` — 11 pass
- `bun test test/unit/session-real.test.ts` — 5 pass
- `bun test test/unit/router.test.ts` — 39 pass
- `npm run typecheck` — pass
- `npm run build` — pass
- 全套 `bun test` 595 项中 10 fail，与 baseline（git stash 撤销改动后）完全相同，属 pre-existing flake（多文件并发跑时的 registry/状态污染），与本 ADR 无关。
