# im-hub 会话模型与 Agent 会话的关系

> 适用：v0.2.15 + v2 升级（A/D/B/C 已落地）
> 作用：把 im-hub 自己的 session、Claude Code 的 session、opencode 的"无 session"摆到同一张桌子上看，便于排查"为什么会话突然没了 / Claude 续不上 / opencode 像失忆"。
> 关联：[`adr/0003-session-path-safety.md`](./adr/0003-session-path-safety.md) · [`adr/0004-sticky-agent-and-split-ttl.md`](./adr/0004-sticky-agent-and-split-ttl.md) · [`im-gateway-v2-plan.md`](./im-gateway-v2-plan.md) · [`im-workspaces-guide.md`](./im-workspaces-guide.md)

---

## 一、三层 session，两个真实持久化

im-hub 在一次 IM 对话里面其实有三层"会话"，但只有前两层会真的落到磁盘：

```
   ┌─ im-hub session ───────────────────────────────────────┐
   │  ~/.im-hub/sessions/<safe-key>.json   (元数据)          │
   │  ~/.im-hub/sessions/<safe-key>.log    (消息 JSONL)      │
   │  生命周期：MESSAGES 30 min · META 7 d                    │
   └────────────────┬───────────────────────────────────────┘
                    │ 通过 claudeSessionId 字段索引
                    ▼
   ┌─ Claude Code session ──────────────────────────────────┐
   │  ~/.claude/projects/<cwd-encoded>/<uuid>.jsonl          │
   │  生命周期：Claude 自己保留，无主动清理                  │
   └────────────────────────────────────────────────────────┘

   ┌─ opencode session ─────────────────────────────────────┐
   │  不存在。`opencode run` 每次都是全新进程，没有持久化。  │
   │  上下文延续只能靠 im-hub 把 messages[] 拼回 prompt。    │
   └────────────────────────────────────────────────────────┘
```

---

## 二、im-hub session

### 2.1 Key 与文件布局

会话 key 由消息入口的三元组组成：

```
key = `${platform}:${channelId}:${threadId}`
```

落盘前先过 `sanitizeKey()`（白名单 `[A-Za-z0-9_-]`，其他字符 → SHA-256 前 8 位，详见 ADR 0003），再生成两个文件：

| 文件 | 写入时机 | 作用 |
|---|---|---|
| `<safe-key>.json` | 创建 / 任意 meta 字段更新 | 元数据（agent / model / variant / claudeSessionId / usage / subtasks） |
| `<safe-key>.log` | 每次 `addMessage` | append-only JSONL 消息历史，避免每条消息全量改写 json |

代码：`src/core/session.ts`

### 2.2 字段与生命周期

```typescript
interface Session {
  id: string                   // 内部唯一 id
  channelId, threadId, platform: string

  agent: string                // sticky agent — 决定下条无前缀消息打给谁
  model?: string               // sticky model
  variant?: string             // sticky variant

  claudeSessionId?: string     // ← 把 im-hub session 与 Claude session 粘在一起的索引
  claudeSessionPrimed?: boolean

  usage?: { ... }              // /stats 看到的累计
  subtasks?, activeSubtaskId?  // 子任务独立会话

  createdAt, lastActivity: Date
  ttl: number                  // 现在等于 META_TTL（向后兼容）
  messages: ChatMessage[]      // 内存中的消息数组，对应 .log
}
```

### 2.3 双层 TTL（v2 Phase D）

历史上是单层 30 min — 长停留必丢 sticky agent 与 `claudeSessionId`，导致漂移。现在拆成两层：

| TTL | 默认 | env 变量 | 过期时做什么 |
|---|---|---|---|
| `MESSAGES_TTL` | 30 min | `IMHUB_SESSION_MESSAGES_TTL_MS` | 清空内存 `messages[]` + 删 `.log` 文件，**保留** `.json` 与 sticky / `claudeSessionId` |
| `META_TTL` | 7 d | `IMHUB_SESSION_META_TTL_MS` | 完整删除（`.json` + `.log` + 内存 entry） |

cleanup 定时器每 5 min 跑一次，用同一对 helper 在两个层级独立判定。

### 2.4 触发会话变化的事件

| 事件 | 效果 |
|---|---|
| 任意消息进来 | `lastActivity` 推到当前时间，两个 TTL 都重置 |
| 30 min 不说话 | 仅清消息历史，sticky agent / Claude UUID 保留 |
| 7 d 不说话 | 整条 session 删除 |
| `/cc` `/oc` 等显式切换 | `switchAgent` 改 `agent` 字段并落盘；不动 `claudeSessionId` |
| `/new` | 清消息 + 删 `claudeSessionId` + 重置 approval auto-allow（强制下次 Claude 起新 UUID） |
| 进程重启 | 内存 Map 重建：来一条消息时按 key 从磁盘 `loadSession` 拉回 |

### 2.5 sticky agent 的绝对锁（v2 Phase A）

只要 `.json` 还在（即未越过 META_TTL），`classifyIntent` 在入口处就早返回 sticky，不进评分流程。意味着：

- 跨日 / 7 d 内回来 → agent 不会变
- 想换只能 `/cc` `/oc` 显式命令或 `/new` 重置
- 评分仅在"全新 thread / sticky 已过 META TTL"时跑

---

## 三、Claude Code session

### 3.1 Claude 自己的存储

Claude 用 `--session-id <uuid>`（首次）或 `--resume <uuid>`（续接），在 cwd 维度的目录里写 jsonl：

```
~/.claude/projects/<cwd-encoded>/<uuid>.jsonl
```

`<cwd-encoded>` 是 cwd 路径里 `/` 替换为 `-` 的结果。v2 升级前 IM Claude 都跑在 `/`，所以全在 `~/.claude/projects/-/`；升级后落到 `~/.claude/projects/-root-im-hub-workspaces-claude-code/`。

### 3.2 与 im-hub session 的桥梁

```
im-hub session.claudeSessionId  ──►  Claude 那个 <uuid>.jsonl
                  ▲
                  │ 由 cli.ts 在第一次给 thread 调 Claude 时分配
                  │ 后续调用按 agentSessionResume=true 走 --resume
```

关键代码 `src/core/router.ts` `callAgentWithHistory` 里的：

```ts
const effectiveHistory = ctx.agentSessionResume ? [] : history
```

当走 `--resume`，**im-hub 不再把 messages[] 拼回 prompt**，让 Claude 完全靠它自己的 jsonl 读历史，避免双倍上下文。

### 3.3 寿命对齐

Claude 那边的 jsonl 永不过期（除非手动清）。但只要 im-hub 这边的 `claudeSessionId` 字段被 META_TTL 清掉，下一条消息就走"分配新 UUID + `--session-id`"路径，旧 jsonl 还在但没人指它了。

→ **想让 Claude 跨周续接，把 META_TTL 调大；想强制起新对话，`/new`。**

---

## 四、opencode session：不存在

`opencode run --format json` 每次都是新进程，CLI 本身没有 resumable session 概念。上下文连续性的唯一来源是 im-hub 把 `messages[]` 拼进 prompt（`agent-base.ts:buildContextualPrompt`）。

后果：

| 情形 | opencode 看到的 |
|---|---|
| 30 min 内连续对话 | 全量历史（im-hub 拼回） |
| **30 min 不说话再回来** | **空** — `MESSAGES_TTL` 已清，无可拼 |
| sticky 仍在 | agent 不变，但等于换了个失忆的人继续聊 |

这是 opencode 这条腿固有的局限，im-hub 层无法独立修。能做的折中：

- 在 `~/.im-hub-workspaces/opencode/PROJECT.md` 写"长期不变的项目档案"，让 opencode 启动时读
- 把 `IMHUB_SESSION_MESSAGES_TTL_MS` 调大（例如 24 h）以延长上下文窗口
- 重要事实主动让用户复述，或建一个 prompt 前缀模板

---

## 五、子任务（subtask）会话

`/job` 创建的子任务有自己的独立会话，key 形如 `${platform}:${channelId}:${threadId}:sub:${jobId}`。父 session 的 `activeSubtaskId` 字段把当前焦点指向子任务；该字段非空时，无前缀消息打给子任务而非主会话。

子任务会话也是 im-hub session 的一种实例，TTL 规则一致。

---

## 六、运维：调 TTL 的 systemd 片段

```ini
# /etc/systemd/system/im-hub.service.d/override.conf
[Service]
Environment="IMHUB_SESSION_MESSAGES_TTL_MS=3600000"   # 1h，opencode 久聊用
Environment="IMHUB_SESSION_META_TTL_MS=2592000000"    # 30d，长 sticky
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart im-hub
```

env 钩子完整列表见 `im-workspaces-guide.md § 六`。

---

## 七、诊断手册

| 症状 | 怎么查 |
|---|---|
| Agent 又漂了 | `/audit` 看最近一条 `intent`：`sticky` = 锁正常；`topic` / `keyword` = sticky 失效（要么 META 过期要么 bug）；同时 `ls -la ~/.im-hub/sessions/<safe-key>.json` 看元数据是否还在 |
| Claude 上下文丢了 | `jq '.claudeSessionId, .lastActivity' ~/.im-hub/sessions/<safe-key>.json`；为空 = META 过期；非空但 Claude 报 "session not found" = cwd 与 jsonl 路径不一致（v2 升级冷启动一次会出现，发一条消息生成新 UUID 即可） |
| opencode 一直失忆 | 这是设计如此，没有 session。考虑调大 `MESSAGES_TTL` 或 `PROJECT.md` |
| 想看消息历史 | `cat ~/.im-hub/sessions/<safe-key>.log`（JSONL，每行一条） |
| 想看 Claude 历史 | `ls -lt ~/.claude/projects/-root-im-hub-workspaces-claude-code/*.jsonl \| head` |

---

## 八、给后来者的速查表

| 问题 | 答案 |
|---|---|
| im-hub session 在哪 | `~/.im-hub/sessions/<safe-key>.{json,log}` |
| safe-key 怎么算 | `${platform}:${channelId}:${threadId}` 过 sanitizeKey |
| 短 TTL 与长 TTL 各管什么 | 短管消息历史 / 长管 sticky agent + Claude UUID |
| Claude 续接靠什么 | session 的 `claudeSessionId` + `--resume` |
| opencode 续接靠什么 | 没有续接，只有 prompt 拼接 |
| sticky 怎么改 | `/cc` `/oc` 等显式命令或 `/new` 重置 |
| 跨平台共享 sticky 吗 | 不共享，key 含 platform |
| 重启进程会丢吗 | 不会，落盘的元数据会被 lazy 加载回来 |
