# im-hub Code Review — 2026-04-30

> 审查版本：v0.2.12 (commit `ee2d44d`)
> 审查范围：core / messengers / agents / web / cli（约 6500 行 dist）
> 审查维度：架构与可扩展性 / 可靠性 / 安全 / 性能 / bug 与代码异味 / 与"智能网关"愿景的差距

---

## 整体评价

**定位准确、底子合理，但离"智能网关"还有明显差距。**

- **✅ 亮点**：插件化核心（Registry / Router / Session / Subtasks）、ACP 协议接入、子任务独立会话 + 30s sync/async 切换、ADP 审批流、跨平台 messenger 抽象。
- **⚠️ 不足**：实现工程化程度不够 —— 大量安全漏洞、边界 bug、硬编码，几乎没有 observability、rate-limit、multi-tenant。作为个人工具合格，直接作为"智能网关"投入多人/多 agent 场景风险很高。
- **🔎 最大结构问题**：Router 未分层（命令/路由/意图识别混杂在一个 1000+ 行文件里）、每个 Agent adapter 各自重复实现 timeout/abort/stream 逻辑、NLP 意图识别用硬编码正则——缺失智能网关所需的抽象层。

---

## 分级问题清单

### P0 — 安全 / 阻塞（必须在上线/暴露前修复）

| # | 位置 | 问题 | 影响 | 修复方向 |
|---|------|------|------|----------|
| P0-1 | `core/session.ts` `saveSession()` | session key `replace(/:/g, '-')` 作文件路径，threadId/channelId 未清洗 `/` `..` `\0` | **路径注入**：构造 `../../etc/xxx` 可越权读写 | 加 `sanitizeKey()`，仅允许 `[A-Za-z0-9_-]` |
| P0-2 | `web/server.ts` `/api/config` | 任何可访问 `localhost:3000` 的进程都能读写全局 config（含 telegram/feishu token） | 本机任意进程或浏览器 XSS → 凭据泄露 | 生成随机 web-token，`/api/*` 必须带 header |
| P0-3 | `web/server.ts` PUT handler | `{...existing, ...incoming}` 浅合并，GET 返回 `mask()` 值后前端回传 `****` 会覆盖真实值 | 改一个字段会把其他 token 擦成 `****`，凭据永久丢失 | 过滤 mask 模式字段，不写回 |
| P0-4 | `plugins/agents/opencode/index.ts` `extractText()` | 提取太宽泛：`event.text` / `event.message` 无条件拼入 `fullText`，会捕获 error 事件内容 | 错误信息当正常回复发到用户 IM，可能泄露敏感栈 | 仅白名单 type 提取，error 事件走单独路径 |
| P0-5 | `plugins/agents/opencode/index.ts` | `AGENT_TIMEOUT = 30 * 60 * 1000` 硬编码，不可配置 | 所有 opencode 任务统一 30min 强杀，长任务丢上下文 | 改为 `opts.timeoutMs ?? env ?? default` |
| P0-6 | `plugins/messengers/teams/` `slack/` | 代码存在于旧 dist，但 `registry.ts` 未注册，且 `node_modules` 缺少 `botbuilder` / `@slack/bolt` | 死代码，若被人误启用会 crash；干扰维护 | 从 src 确认无残留后从仓库清理 |
| P0-7 | `plugins/messengers/wechat/index.ts` | wechaty 版 WeChatAdapter，`wechaty` 不在 `package.json` 依赖中 | 死代码干扰 | 删除，当前 iLink 是唯一 WeChat 适配器 |

### P1 — 架构 / 可扩展性（阻碍"智能网关"）

| # | 位置 | 问题 | 建议 |
|---|------|------|------|
| P1-1 | 所有 `plugins/agents/*/index.ts` | 每个 adapter 独立实现 `isAvailable / sendPrompt / timeout / abort / retry / stream parsing`；没有 `AgentBase` 基类 | 抽一层 `AgentBase`：统一生命周期、signal、stream、usage、health |
| P1-2 | `core/registry.ts` | 全局单例 `registry`，无 tenant/workspace 维度 | 改为 `RegistryFactory`，按 `workspaceId` 生成独立实例 |
| P1-3 | `cli.ts` `handleMessage()` | `messengerName = platform === 'wechat' ? 'wechat-ilink' : platform` 硬编码特例 | 在 MessengerAdapter 加 `platformId` 字段；cli 只走抽象 |
| P1-4 | `core/router.ts` `tryInterpretADP()` | 30+ 行 regex 硬编码中英文 NLP，`"不行"` 含 `"行"` 已被迫 workaround | 换成分离的 intent classifier（规则引擎或轻量 LLM） |
| P1-5 | `core/router.ts` `handle{Ok,No}Command()` | 直接 `sessionManager.sessions.get(key)` 破坏封装；若 session 仅在磁盘会返回 undefined | 全部走 `getExistingSession()` |
| P1-6 | `claude-code/codex/copilot` 适配器 | `buildContextualPrompt` 把全部 history 塞进 prompt 文本，未用各 CLI 的 session 机制 | 长对话 token 指数膨胀；copilot `--prompt-only` 根本不支持多轮 → 行为不一致 |
| P1-7 | `core/session.ts` | 所有 session 平摊到 `~/.im-hub/sessions/`，不分片 | 按 `{platform}/{channelId}/` 分目录，加 LRU 索引 |
| P1-8 | `core/router.ts` (1087 行) | 命令解析/意图识别/会话操作/usage 累计/model 查询/CLI spawn 全部混在一个文件 | 拆成 `commands/*.ts` + `intent.ts` + `agent-invocation.ts` |
| P1-9 | `plugins/agents/acp/acp-adapter.ts` | 注释明确 "sessionId is unused in v1" | v1 可接受；智能网关版需要 ACP session 保持 |

### P2 — 可靠性 / 可运维性

| # | 位置 | 问题 |
|---|------|------|
| P2-1 | `core/subtasks.ts` `runInBackground()` | `runningTasks.get(key)?.promise` race：`runAgent` 的 finally 可能先于 `runInBackground` 清除 map，丢失 result |
| P2-2 | `core/session.ts` `cleanup()` | 只清内存 Map；磁盘孤儿文件（subtask、宕机残留）不扫除 |
| P2-3 | `plugins/messengers/telegram/telegram-adapter.ts` | `bot.start()` fire-and-forget，`isRunning = true` 但实际 bot 未必 ready；polling 失败不重试不告警 |
| P2-4 | `cli.ts` `handleMessage()` | 每条消息先发 `'稍等…'`，包括 `/help` 这类 ms 级响应 |
| P2-5 | 全局 | 无 metrics、无 structured log、无 trace id —— 无法追溯"谁/何时/用什么 agent/耗时多久/花多少钱" |
| P2-6 | 全局 | 无 rate-limit（用户/agent 两侧都没）、无 circuit breaker |
| P2-7 | `core/onboarding.ts` `isAgentAvailableCached()` | 永久缓存；agent 后续装/卸 im-hub 感知不到 |
| P2-8 | `plugins/messengers/wechat/ilink-adapter.ts` | context token TTL `= CONTEXT_TOKEN_TTL * 6 = 30min`，无 sliding window；高并发下可能竞争 |
| P2-9 | `core/session.ts` `addMessage()` | 每次 `JSON.stringify(entire session) + writeFile`，高频消息下 IO 量大 |

### P3 — 代码异味

| # | 位置 | 问题 |
|---|------|------|
| P3-1 | `plugins/agents/opencode/index.ts` `buildContextualPrompt()` | `arguments[0]` 在类方法里用 `arguments`，与 `sendPrompt` 命名参数不一致且易出错 |
| P3-2 | `core/router.ts` `handleModelsCommand()` | 每次 spawn `opencode models` 子进程，应缓存 |
| P3-3 | 多个 messenger | 5 个 `splitMessage` 近重复实现，已有 `utils/message-split.ts` 但未被充分使用 |
| P3-4 | `core/types.ts` | 仅有 `export {};`，类型定义在 `.ts` 源文件中，但 dist 查看时完全丢失 |
| P3-5 | `cli.ts` `handleMessage()` | ~150 行单函数，混合 typing/解析/流式/approval/feishu 卡片/错误处理 |

---

## 与"智能网关"愿景的差距

将 im-hub 定位为 **IM 前端 + 多 Agent 后端的智能路由层** 时，以下能力仍然缺失：

| 能力 | 现状 | 目标 |
|------|------|------|
| 意图路由 | 用户手动 `/oc` `/cc` | 自动根据消息内容 + 历史上下文选择最佳 agent |
| Agent 健康感知 | 启动时一次性检测，永久缓存 | 定期 health probe，挂掉的 agent 自动从路由表剔除 |
| Fallback cascade | 无 | 主 agent 超时/故障 → 自动切换到备选 agent |
| Usage / budget 控制 | 仅后验 `/stats` | 前置预算，单用户超 quota 自动拒绝或降级 |
| Audit log | 无 | 全链路可追溯：谁/何时/什么消息/走哪个 agent/多久/$ |
| Multi-tenant isolation | 全局单例 | 按 workspace 隔离 registry、session、config、agent 列表 |
| Outgoing gateway | 仅 IM→Agent | Agent→IM（主动推送/任务完成通知） |
| Rate-limiting | 无 | 用户级 + agent 级限流，防滥用 / 防打挂 |

---

## 附录 A—— 文件清单与阅读注记

| 文件 | 行数 | 角色 | 关键注记 |
|------|------|------|----------|
| `core/router.ts` | 1087 | 命令解析 + 路由 + 意图识别 + usage + model | 应拆分 |
| `core/session.ts` | 298 | 会话持久化 + 子会话 | 路径安全 P0-1 |
| `core/subtasks.ts` | 416 | 子任务管理 + 锁 + sync/async 切换 | 设计好，但 race P2-1 |
| `core/registry.ts` | 99 | 插件注册 | 全局单例 P1-2 |
| `core/onboarding.ts` | 343 | 引导流程 + agent 可用性检查 | 缓存永久 P2-7 |
| `cli.ts` | 836 | 启动 + handleMessage + config 子命令 | 函数过长 P3-5 |
| `web/server.ts` | 324 | HTTP + WebSocket + REST API | 鉴权缺失 P0-2 |
| `plugins/agents/opencode/index.ts` | 277 | opencode spawn + stream + ADP | 超时 + extractText P0-4/5 |
| `plugins/agents/claude-code/index.ts` | 109 | claude CLI | 无 session、无 timeout |
| `plugins/agents/codex/index.ts` | 132 | codex CLI | 同上 |
| `plugins/agents/copilot/index.ts` | 230 | copilot CLI × 5 种安装方式 | 同上 |
| `plugins/agents/acp/acp-adapter.ts` | 59 | ACP HTTP 桥接 | session 未实现 P1-9 |
| `plugins/agents/acp/acp-client.ts` | 219 | ACP SSE stream 解析 | OK |
| `plugins/messengers/wechat/ilink-adapter.ts` | 447 | WeChat iLink 长轮询 | context token P2-8 |
| `plugins/messengers/wechat/ilink-client.ts` | 261 | iLink HTTP client | OK |
| `plugins/messengers/telegram/telegram-adapter.ts` | 144 | grammy Bot | 启动 race P2-3 |
| `plugins/messengers/feishu/feishu-adapter.ts` | 129 | Lark SDK WS | OK |
| `utils/message-split.ts` | 42 | 共享拆包 | 未被充分使用 P3-3 |
| `utils/cross-platform.ts` | 57 | Windows/macOS/Linux 兼容 | OK |

---

## 附录 B—— 本次 Phase 1 修复的 P0 项目

本次 `feat/gateway-phase1` 分支涵盖：

- P0-1: session 文件路径消毒
- P0-2: Web API 鉴权
- P0-3: mask 回写修复
- P0-4: opencode extractText 收紧
- P0-5: opencode timeout 可配置
- P0-6/7: 确认 src 中无死代码

其余 P1-P3 项见 `upgrade-plan.md` 后续阶段。
