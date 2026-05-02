# im-hub → 智能网关 · 升级路线图

> 目标：将 im-hub 从"IM → 多 Agent 桥接器"升级为 **IM 前端 + 多 Agent 后端的智能路由层**
> 最后更新：2026-04-30
> 当前分支：feat/gateway-phase1
>
> **2026-05-02 后续**：稳态/记忆/工作目录这一轮的升级已开新文档跟踪 → 见
> [`docs/im-gateway-v2-plan.md`](./im-gateway-v2-plan.md)（A+D 已落地，B+C 待执行）。

---

## 愿景

用户通过任意 IM（微信 / Telegram / 飞书 / Web Chat）发送自然语言请求，系统自动完成：
1. 身份验证 & 权限 & 预算检查
2. 意图识别 → 选择最合适的 Agent（或回退到备选）
3. Agent 执行（带超时、重试、流式返回）
4. 结果流回用户 IM + 全链路审计记录

---

## Phase 1 · 底座加固（1-2 周）

> 目标：安全性 + 可运维性达标，为后续架构升级扫清障碍。

### 1.1 P0 安全修复

- [x] P0-1 session 文件路径消毒（防路径注入）
- [x] P0-2 Web API 鉴权（随机 token + loopback-only + header 校验）
- [x] P0-2b WebSocket 鉴权补丁（URL query token）← 2026-04-30 补丁
- [x] P0-3 Config PUT mask 回写修复
- [x] P0-3b mask 深层嵌套保护（telegram/feishu/acpAgents）← 2026-04-30 补丁
- [x] P0-4 opencode extractText 收紧（白名单 type）
- [x] P0-5 opencode timeout 可配置
- [x] P0-5b timeout 输入校验（NaN/负数/0 防护）← 2026-04-30 补丁
- [x] P0-6/7 确认 src 中无 Teams/Slack/wechaty 死代码

### 1.2 结构化日志

- [x] 引入 pino + pino-pretty
- [x] traceId 贯穿 messenger → router → agent → reply
- [x] Agent invocation span（start/end/duration/cost/outcome）
- [x] 日志级别可配（LOG_LEVEL env）
- [x] 敏感字段脱敏（token、secret 不出现在日志）

### 1.3 集成修复

- [x] Web 前端 fetch 加 token header（R4 补丁）
- [x] 恢复 agent 前缀（R5 补丁）

### 1.3 基础设施

- [x] Config schema 校验（zod）
- [x] AgentBase 抽象
- [x] Router 拆分：命令分离到 `commands/*.ts`
- [x] Agent health 定期探活（替代永久缓存）

---

## Phase 2 · 智能路由 Brain（2-4 周）

> 目标：从"用户手动选 agent" → "系统自动按意图路由"。

### 2.1 意图分类

- [x] Intent classifier（规则引擎先行）
- [x] 命令检测 / sticky session / topic matching
- [x] `/router policy` 可查看当前路由策略
- [x] `/router explain` 解释为何路由到某 agent

### 2.2 Agent 画像

- [x] Agent 能力画像表 (intent.ts PROFILES)
- [x] Circuit breaker：连续 3 次故障 → 5 分钟冷却

### 2.3 可观测性

- [x] Audit log (sqlite)：user × agent × duration × cost × outcome
- [x] `/audit [n|agent=x|days=7]` 查询命令
- [ ] Metrics（latency p50/p95/p99、error rate、cost per session）

### 2.4 预算与限流

- [x] Rate-limit token bucket（用户级 10 req/min）
- [ ] Agent 级限流（已预留 agentLimiter）
- [ ] 预算告警与拒绝

---

## Phase 3 · 网关全貌（4+ 周）

> 目标：多租户、多上下游、完整生命周期管理。

### 3.1 ACP 深化

- [x] ACP Server 模式：im-hub 本身可作为 Agent 被上游调用
- [ ] ACP Client session 保持（跨越 HTTP 无状态）
- [ ] ACP agent 发现与自动注册

### 3.2 多租户

- [x] Multi-tenant registry（按 workspace 隔离 + agent 白名单）
- [x] RBAC 基础：按 userId 解析 workspace

### 3.3 Job Board

- [x] 升级版子任务系统：SQLite 持久化
- [x] /job create/list/check/run/cancel
- [ ] Web UI 任务列表 / 调度 / 重跑 / 导出
- [ ] 定时任务（cron 触发） + webhook 回调

### 3.4 下游网关

- [ ] Outgoing webhook：外部系统 → im-hub → Agent → IM 回复
- [ ] REST API（带鉴权）供第三方系统调用

---

## 度量指标

| 指标 | 当前基线 | Phase 1 目标 | Phase 2 目标 |
|------|----------|--------------|--------------|
| Agent P95 latency | 未知 | 可度量 | < 60s |
| Agent error rate | 未知 | 可度量 | < 5% |
| 日志查询能力 | grep | JSON + jq | audit SQL |
| 安全 — 未授权 API 访问 | 可访问 | 不可访问 | RBAC |
| Hot-reload config | 否 | 否 | 是 |
| Agent fallback | 无 | 无 | 自动 |
| Multi-tenant | 否 | 否 | 是 |

---

## 变更记录

| 日期 | 变更 | 作者 |
|------|------|------|
| 2026-04-30 | 初始版本，Phase 1 开 | opencode |
