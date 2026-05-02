# im-hub v2 升级计划 · IM 网关稳态 + 长期记忆

> 目标：让 Claude Code / opencode 通过 im-hub 使用时，**Agent 不漂移、长期记忆不丢失、工作目录可独立配置、会话生命周期清晰可解释**。
> 起始日期：2026-05-02
> 当前分支：main
> 维护人：ben.wangzj@gmail.com（用户） + Claude Code（执行）

---

## 背景

用户日常通过两个 Agent 工作：**Claude Code** 和 **opencode**，入口都是 im-hub。在使用过程中暴露 4 个痛点：

1. **工作目录共用** — 两个 Agent 都继承 im-hub 的 cwd（systemd 默认 `/`），无法分别定义角色与项目记忆。
2. **Agent 漂移** — 跨日 / 长停留后，正在用 Claude Code 会被切到 opencode，违背"非显式不切换"的预期。
3. **记忆只到会话级** — 没有跨会话的项目记忆机制；只能靠会话 ID 翻旧 jsonl，做事缺乏延续性。
4. **会话保持时间过短** — 同一 IM 会话 30 分钟空闲就过期，连带把 sticky agent 和 Claude resumable id 一起冲掉。

---

## 现状摸底（2026-05-02）

| 事实 | 出处 | 影响 |
|---|---|---|
| im-hub.service cwd = `/`，`crossSpawn` 不传 cwd | `utils/cross-platform.ts:22-28` + systemd unit 无 `WorkingDirectory` | Claude / opencode 把 `/` 当项目，所有 IM 会话共用 `/root/.claude/projects/-/` 一份记忆 |
| Session key = `${platform}:${channelId}:${threadId}`，TTL 30 min | `core/session.ts:38` | 跨日 / 久不说话必过期 |
| stickyAgent 来源仅限 in-memory `existingSession?.agent` | `core/router.ts:274` | session 一过期 → stickyAgent 丢失 |
| 无 stickyAgent 时跑 `classifyIntent`，opencode `weight=1.2` 与 claude-code `1.0` 关键字大量重叠 | `core/intent.ts:16-38` | 含 "代码/code/git/test/bug" 必偏 opencode |
| `classifyIntent` 即使有 sticky 也会跑评分；多关键字可叠加超过 sticky `+3` 偏置 | `core/intent.ts:131-181` | 长消息能在 sticky 存在时反向覆盖（罕见但已发生） |
| `claudeSessionId` / `claudeSessionPrimed` 跟着 session 一起被 cleanup 删除 | `core/session.ts:303-326`、`session.ts:617-619` | im-hub 会话过期 → Claude `--resume` 也接不回去了 |

### 漂移机制

1. 停留 > 30 min，cleanup 定时器删除 session 元数据 + 消息日志
2. 下条消息进来，`getExistingSession` 返回 undefined → `stickyAgent` 丢失
3. `classifyIntent` 重跑，opencode 1.2 权重 + 含编码关键字 → 选 opencode
4. router.ts:337-339 `agentName !== stickyAgent` → `switchAgent` 真切走

---

## 路线图

按执行顺序：**A → D → B → C**。A+D 是杀漂移 + 拉长会话寿命的最小改动（已落地），B 是工作目录隔离，C 几乎是 B 的副产品。

### Phase A · 杀漂移（已完成，2026-05-02）

- [x] `core/intent.ts`：sticky 改为绝对锁。当 stickyAgent 在可用列表里时直接返回，不再跑评分流程。
- [x] `core/intent.ts`：opencode 权重 `1.2 → 1.0`，与 claude-code 持平。
- [x] 单元测试 `test/unit/intent.test.ts` 全绿（11 pass）

**预期效果**：thread 一旦被 `/cc` 或 `/oc` 选中，除非用户再次显式切换或 `/new`，否则不会改 agent。

### Phase D · 拆分会话 TTL（已完成，2026-05-02）

- [x] `core/session.ts`：常量拆为 `MESSAGES_TTL`（默认 30 min）+ `META_TTL`（默认 7 天）。
- [x] 新增环境变量 `IMHUB_SESSION_MESSAGES_TTL_MS` / `IMHUB_SESSION_META_TTL_MS`，运维可调。
- [x] `getOrCreateSession` / `getExistingSession`：双层判断 — META 没过期就保留 session（保留 agent / claudeSessionId），MESSAGES 过期就清空 in-memory `messages` + 删 `.log` 文件。
- [x] `cleanup()`：仅 messages 过期时只删 `.log` + 清空内存历史；META 过期才连 `.json` 一起删。
- [x] 兼容老格式：legacy `ttl: 60_000` session 文件仍可加载；测试 `session-real.test.ts` 全绿（5 pass）。

**新语义**：

| 操作 | 效果 |
|---|---|
| 30 min 不说话 | 仅清空消息历史 + 删 `.log`；agent / claudeSessionId / model / variant 保留 |
| 7 天不说话 | 完整清除 session（meta + log） |
| `/new` | 显式重置：清消息 + 删 claudeSessionId + 清 approval auto-allow（行为不变） |
| `/cc` `/oc` | 显式切换 agent（行为不变） |

**对 Claude Code 的特殊收益**：因为 `claudeSessionId` 7 天不丢，下次回来还能 `claude --resume <uuid>`，Claude 那边的 `~/.claude/projects/-/<uuid>.jsonl` 完整对话历史能续上。

### Phase B · per-Agent 工作目录（已完成，2026-05-02）

实际目录结构：

```
~/.im-hub-workspaces/
├── claude-code/
│   ├── CLAUDE.md         # IM 入口专属角色（区别于全局 ~/.claude/CLAUDE.md）
│   └── memory/           # Claude auto-memory（per-cwd 自然隔离，自行写入）
└── opencode/
    ├── AGENTS.md         # IM 入口专属角色
    └── memory/
```

实际改动：

- [x] **新增** `core/agent-cwd.ts`：单文件聚合 `resolveAgentCwd()` + `bootstrapAgentWorkspaces()` + 种子模板。所有 cwd 决策只此一处，方便后续做 per-userId 细分。
- [x] `core/agent-base.ts:SpawnPlan` 加 `cwd?: string`；`spawnStream` 在 `crossSpawn` options 里透传。`crossSpawn` 本身不需要改（它已经透传 options.cwd）。
- [x] `plugins/agents/claude-code/index.ts:prepareCommand`：在函数最前面一次解析 cwd，**所有 4 条返回路径**（`IMHUB_APPROVAL_DISABLED=1` / 无 sock / 无 IM 上下文 / mcp 配置写入失败 / 正常 approval-routed）都带上 cwd。漏一条就会让某些降级路径偷偷退回 `/`。
- [x] `plugins/agents/opencode/index.ts`：新增 `prepareCommand`，统一从 `resolveAgentCwd` 取 cwd。
- [x] `cli.ts:start`：`registry.loadBuiltInPlugins()` 之后调 `bootstrapAgentWorkspaces()`，幂等创建目录 + 种入 CLAUDE.md / AGENTS.md（已存在不覆盖）。
- [x] 单元测试 `core/agent-cwd.test.ts`：13 pass，覆盖 4 条决策分支 + 种子幂等性 + env override 优先级。
- [x] 既有测试无回归（`claude-code/adapter.test.ts` 8 pass）。

**新增 env 钩子**（运维可调）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `IMHUB_WORKSPACES_ROOT` | 移动整个工作区根目录 | `~/.im-hub-workspaces` |
| `IMHUB_CLAUDE_CODE_CWD` | 单独覆盖 Claude 的 cwd | 计算自上面 |
| `IMHUB_OPENCODE_CWD` | 单独覆盖 opencode 的 cwd | 计算自上面 |

**预期效果（重启 im-hub 后）**：

- IM 给 Claude 发 `pwd` → `/root/.im-hub-workspaces/claude-code`（之前是 `/`）
- IM 给 opencode 发 `pwd` → `/root/.im-hub-workspaces/opencode`
- 终端直接 `claude` 不受影响（仍按当前终端 cwd）
- web/scheduler/intent-llm 调 agent 不受影响（cwd undefined → 继承 im-hub `/`）

详细设计见 `docs/architecture/agent-cwd-and-memory.md`，决策记录见 `docs/adr/0005-agent-cwd-isolation.md`。

### Phase C · 长期项目记忆（B 的副产品）

- 复用 Claude / opencode 已有的 per-project memory（`<cwd>/CLAUDE.md`、`<cwd>/AGENTS.md`、`<cwd>/memory/`）。
- 在 B 落地的工作目录里手写 / 半自动维护项目档案。
- （可选）im-hub 提供 `/memo add <text>` 命令，append 到对应工作目录的 MEMORY.md。

**用户使用指南**：[`docs/im-workspaces-guide.md`](./im-workspaces-guide.md)
讲怎么写角色书 / 验证 sticky / 调 TTL / 故障排查。

---

## 进度追踪

| Phase | 状态 | 完成日 | PR / Commit | 备注 |
|---|---|---|---|---|
| A | ✅ done | 2026-05-02 | (待 commit) | sticky 绝对锁 + 权重平衡 |
| D | ✅ done | 2026-05-02 | (待 commit) | TTL 双层拆分 + cleanup 改造 |
| B | ✅ done | 2026-05-02 | (待 commit) | per-Agent cwd（agent-cwd.ts 新建 + adapter 注入） |
| C | ✅ enabled + verified | 2026-05-02 | (待 commit) | B 落地后 CLAUDE.md / AGENTS.md / memory/ 就绪；2026-05-02 修完 claudeSessionId 持久化 bug 后跨重启续接通了 |
| Bug-fix-1 | ✅ done | 2026-05-02 | (待 commit) | claude-code adapter `prepareCommand` mkdtemp 失败分支漏注 cwd（ADR 0005 § "all 4 fallback paths"），1 行修 + 1 条回归用例 |
| Bug-fix-2 | ✅ done | 2026-05-02 | (待 commit) | `claudeSessionId` / `claudeSessionPrimed` 三层持久化漏洞（saveSessionMeta 不写 / loadSession 不读 / switchAgent 重建丢字段），3 处修 + 2 条端到端回归用例 |
| Feat-opencode-resume | ✅ done | 2026-05-02 | (待 commit) | opencode 长期记忆原本被误判为 CLI 限制，实际 `opencode run` 支持 `--session <id>` / `--continue`。新增 `opencodeSessionId` 持久化 + `inspectEvent` 钩子从 `step_start` 抓 sessionID + 从 `step_finish.part.{cost,tokens}` 抓成本，回写到 session.usage；router 注入闭包绑定的 `onAgentSessionId` / `onUsage` 回调 |

---

## Retro · 2026-05-02 落地后即时复盘

### 触发

A/D/B 落地当天 commit 前做"继续 CR"二轮审查，针对 Phase B 的 cwd 注入与 Phase D 承诺的"`claudeSessionId` 7d 内不丢"做穿透验证。

### 发现的 bug

**Bug-1：`claude-code/index.ts:110` mkdtemp 失败分支漏 cwd**

ADR 0005 § "Why all 4 fallback paths must carry cwd" 自己点名警告过的事，落地时还是漏了一条降级路径。`prepareCommand` 共 6 个 return，其中 1 条没传 `cwd`。罕见路径触发即静默退回 `/`，直接撕开 cwd 隔离。

**Bug-2：`claudeSessionId` / `claudeSessionPrimed` 三层都没在落盘**

| 位置 | 漏洞 |
|---|---|
| `saveSessionMeta` | meta 字面量缺这两个字段 → 内存改了，磁盘不写 |
| `loadSession` | parsed 解构缺这两个字段 → 即使磁盘有也读不回 |
| `switchAgent` | 重建 Session 时只手抄 8 个字段 → `usage` / `claudeSessionId` / `claudeSessionPrimed` / `subtasks` / `activeSubtaskId` / `subtaskCounter` 一律丢 |

TS `Omit<Session, 'messages'>` 只在结构上要求字段类型，optional 字段缺失编译期不报错。

实证：升级前积累的 296 个 session.json 文件 zero 个含 `claudeSessionId`。意味着 Phase D 文档里"7d 内 `claude --resume` 能续上 jsonl"**从落地起就没真正生效**。

### 修复策略

- saveSessionMeta + loadSession：补字段（4 行）
- switchAgent：选择性 carry-over —— 保留 `usage` / `subtasks*` / `claudeSessionId` / `claudeSessionPrimed`；故意不带 `model` / `variant`（不同 CLI 模型命名空间不同）
- 加测试：`claudeSessionId` 持久化往返；`switchAgent` 跨切保留

### 验证

| 项 | 结果 |
|---|---|
| `bun test` 全套 | 599 → 601 pass（+2 新增），10 fail 与 baseline 一致 |
| `npm run typecheck` | 干净 |
| 端到端真机测试：`/cc` 两轮 + `/oc` 两轮 | session.json `claudeSessionId=4f392b46-…` 全程保留；`~/.claude/projects/-root--im-hub-workspaces-claude-code/4f392b46-….jsonl` 同 UUID 落地；`usage.turns` 跨 agent 切换从 6 → 8 → 10 正确累加 |

### 教训

1. **TS Optional 字段是结构化校验的盲区**：`Omit<T, K>` 不能保证字段被实际写入。需要单元测试盖到"字段进 → 字段出"的端到端往返，不能只靠类型。
2. **审计日志比内存断言更可信**：跨重启验证时，靠 `audit.db` 反推真实事件链 + 磁盘文件 mtime 比看在线日志靠谱。
3. **第一次假阴性来自用户行为**：用户用 `/new` 清掉了刚分配的 UUID，被我误判为"修复没生效"。教训：解读"症状一致"的数据时，先穷举可能造成同样症状的用户路径，再下结论。
4. **Phase B 的 ADR 自己警示过的坑还是踩了**：以后类似"所有 N 条降级路径都必须做 X"的约束，加一个 lint / 集中点（switch case + exhaustiveness check）比靠人记可靠。

---

## 跨会话恢复指引（给下一次的我）

如果新的 Claude Code 会话需要继续这项工作：

1. 先读本文件 `docs/im-gateway-v2-plan.md`
2. 读 `docs/adr/0004-sticky-agent-and-split-ttl.md` 了解 A+D 的决定
3. 读 `docs/architecture/agent-cwd-and-memory.md` 了解 B+C 的方案
4. 读 `docs/session-model.md` 了解三层 session 的关系
5. 看 `git log --oneline -20 src/core/intent.ts src/core/session.ts` 确认 A+D 的提交是否还在
6. 看 `systemctl status im-hub` 确认服务是否已经在用新 dist
7. 验证健康度的一行体检：
   ```bash
   jq '{agent, cId: .claudeSessionId, primed: .claudeSessionPrimed, turns: .usage.turns}' \
     ~/.im-hub/sessions/<your-thread-key>.json
   ```
   `cId` 不为 null 即说明 v2 全链路通。

---

## 参考文件

- `src/core/intent.ts` — 路由分类器（A 改）
- `src/core/session.ts` — 会话管理器（D 改）
- `src/core/router.ts` — 路由主流程（不动）
- `src/cli.ts:360-420` — Claude UUID 复用逻辑（依赖 D）
- `src/plugins/agents/claude-code/index.ts` — Claude adapter（B 待改）
- `src/plugins/agents/opencode/index.ts` — opencode adapter（B 待改）
- `src/utils/cross-platform.ts` — `crossSpawn`（B 待改）
- `src/core/agent-base.ts` — `SpawnPlan` 类型（B 待改）
- `/etc/systemd/system/im-hub.service` — 进程级 cwd
