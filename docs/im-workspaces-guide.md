# IM 工作区使用指南

> 适用：v2 升级后（A/D/B 已落地，C 自然就位）
> 角色：im-hub 用户 / 接入方 / 运维
> 关联：[`im-gateway-v2-plan.md`](./im-gateway-v2-plan.md) · [`architecture/agent-cwd-and-memory.md`](./architecture/agent-cwd-and-memory.md)

本文档面向"已经在用 IM 跟 Claude Code / opencode 聊天"的用户，讲 v2 之后的新能力怎么用：

1. 给 IM 入口的 Agent 写"角色书"和"项目档案"（长期记忆）
2. 验证 sticky-agent 锁是否生效
3. 按需调整会话保持时长
4. 故障排查

---

## 一、目录速览

```
~/.im-hub-workspaces/
├── claude-code/
│   ├── CLAUDE.md          ← IM 入口的 Claude 角色定义（你直接编辑这个）
│   ├── memory/
│   │   └── MEMORY.md      ← Claude auto-memory（Claude 自动写）
│   └── （Claude 会读 cwd 下任何相对路径文件）
├── opencode/
│   ├── AGENTS.md          ← IM 入口的 opencode 角色定义
│   ├── PROJECT.md         ← （建议）你写的长期项目档案
│   └── memory/
└── codex/
    ├── AGENTS.md          ← IM 入口的 Codex 角色定义（与 opencode 同名但目录隔离）
    ├── PROJECT.md         ← （建议）你写的长期项目档案
    └── memory/            ← 手写笔记目录（codex 无 auto-memory）
```

**隔离边界（项目级隔离，用户级共享）**：

| 层级 | 行为 |
|---|---|
| 用户级（`~/.claude/CLAUDE.md` / `~/.config/opencode/AGENTS.md`） | **IM 入口与直连终端共享。** Claude / opencode 仍会按各自惯例加载用户级配置。这里写"无论从哪进来都希望生效"的全局规则。 |
| 项目级（`<cwd>/CLAUDE.md`、`<cwd>/AGENTS.md`、`<cwd>/memory/`） | **隔离。** IM 入口 cwd = `~/.im-hub-workspaces/<agent>/`，直连终端 cwd = 当前 shell 目录。两边互不读。这里写"只在 IM 入口想要的人格 / 项目档案"。 |
| Claude vs opencode vs codex | 互不可见。Claude 只读 `claude-code/`，opencode 只读 `opencode/`，codex 只读 `codex/`。三边可分别给不同人格。`AGENTS.md` 在 opencode/codex 目录里同名但因 cwd 隔离，互不读取。 |

---

## 二、给 IM 入口的 Claude 写"角色书"

直接 vim 编辑 `~/.im-hub-workspaces/claude-code/CLAUDE.md`：

```markdown
# IM 入口 Claude 角色

我在 IM（微信 / Telegram / 飞书）里被唤起。回复要简洁，不要大段代码块，除非用户
明确要求代码。

## 项目背景

主要协助 ben.wangzj@gmail.com 维护：
- im-hub（IM 网关，本目录是它的 IM 工作区）
- 其他项目按需

## 长期偏好

- 中文沟通
- 写代码：默认无注释、最小改动
- 工程决策遵循 KISS / YAGNI
```

**生效方式**：下一次 IM 消息进来时 Claude 启动会自动加载（Claude 内建行为，按 cwd
查找项目级 `CLAUDE.md`）。**用户级 `~/.claude/CLAUDE.md` 也会照常加载**，两份会一起进
入上下文 — 把"全局都该有的规则"放用户级，"只在 IM 想要的人格"放本目录。

### 用户级与项目级的关系

`~/.claude/CLAUDE.md` 是 Claude 的**用户级**配置，IM 入口与直连终端**都会自动加载**，
无需任何 include 操作。本目录下的 `CLAUDE.md` 是**项目级**，IM 入口专属，与用户级
合并到同一份上下文里。

冲突时谁优先取决于你怎么写 — Claude 不做强制覆盖，两边的规则会同时呈现给模型。
建议：

- 用户级：写"无论从哪进来都希望生效"的硬性规则（中文沟通、bgjob SOP、安全约束等）
- 项目级（本目录）：写"只在 IM 入口想要的人格 / 简洁度 / 项目档案"

如果某条用户级规则不希望在 IM 入口生效，在本目录 `CLAUDE.md` 里显式写一句覆盖即可
（例如"忽略用户级关于 X 的指引"）。

---

## 三、给 IM 入口的 opencode 写"角色书"

```bash
vim ~/.im-hub-workspaces/opencode/AGENTS.md
```

opencode 启动时会读 cwd 下的 `AGENTS.md`，行为与 Claude 类似。

---

## 三·B、给 IM 入口的 Codex 写"角色书"

```bash
vim ~/.im-hub-workspaces/codex/AGENTS.md
```

Codex 启动时同样会读 cwd 下的 `AGENTS.md`。**与 opencode 同名但目录分离**：im-hub
spawn codex 时把 cwd 钉在 `~/.im-hub-workspaces/codex/`，所以它只读这个目录下的
`AGENTS.md`，永远不会撞到 opencode 的那一份。

Codex 会话连续性的关键事实：
- im-hub 监听 `thread.started` 事件捕获 codex 自生成的 thread UUID，存到
  `Session.codexSessionId`。
- 后续每轮 spawn `codex exec resume <uuid> …`，codex 从 `~/.codex/sessions/`
  读出完整历史，**im-hub 不再把消息历史拼进 prompt**。
- `/new` 会清掉 `codexSessionId`，下一轮起新 codex thread。

记忆框架：codex 没有 Claude 那种 auto-memory，也没有 opencode 的 PROJECT.md
内建约定。本目录下的 `memory/` 目录留作手写笔记起点 —— 在 AGENTS.md 里指引
codex 启动时读取即可：

```markdown
启动时先读 ./memory/*.md 与 ./PROJECT.md 了解长期上下文。
```

---

## 四、长期项目记忆（Phase C）

v2 让两条天然的长期记忆链路就位，**不需要新工具**：

### 4.1 Claude 的 auto-memory

Claude Code 有内建的 auto-memory 机制：根据对话内容自己决定要不要写
`<cwd>/memory/MEMORY.md`。当 IM 入口 Claude 的 cwd = `~/.im-hub-workspaces/claude-code/`
时，记忆就落到 `~/.im-hub-workspaces/claude-code/memory/MEMORY.md`。

特点：
- **自动**：你不需要手工写
- **per-IM**：与终端 Claude 完全独立
- **可读可改**：是普通 Markdown，随时 vim 编辑

### 4.2 jsonl 完整对话历史

Claude Code 在 `--session-id` / `--resume` 模式下把每次对话整段存成 jsonl：

```
~/.claude/projects/-root-im-hub-workspaces-claude-code/<uuid>.jsonl
```

文件名 = im-hub 给该 thread 分配的 `claudeSessionId`。**v2 升级后该 id 在 META TTL（默
认 7d）内不丢**，所以你 IM 里短暂离开几天回来，Claude 仍能续上完整上下文。

### 4.3 opencode 的项目档案（手写）

opencode `run` 不持久化 session（每次都是新进程），所以"长期记忆"靠你手写：

```bash
cat >> ~/.im-hub-workspaces/opencode/PROJECT.md <<'EOF'
# IM 入口 opencode 项目档案

## 项目清单
- im-hub: /root/workspace/im-hub

## 用户偏好
- 中文沟通
- 不引入未确认的依赖
EOF
```

然后在 `AGENTS.md` 里指引 opencode 加载它：

```markdown
启动时先读 ./PROJECT.md 了解长期项目背景。
```

---

## 五、验证 sticky-agent 锁是否生效

v2 之后的 sticky 是**绝对锁**：选定 Claude 后，发再多带"代码/test/git"关键词的消息也
不会切到 opencode，必须显式 `/cc` `/oc` 才换。

### 5.1 IM 内验证

```
/cc                ← 显式锁到 Claude
帮我写代码         ← 带关键词试探
/audit             ← 看最近一条的 intent 字段
```

`intent` 字段含义：

| 值 | 含义 |
|---|---|
| `sticky` | ✅ 早返回，sticky 锁生效 |
| `command` | 用户发了 `/cc` `/oc` 等显式命令，行为符合预期 |
| `topic` / `keyword` | ❌ 第一条消息或 sticky 失效，重跑了分类 |
| `default` | 完全没匹配，回落到 defaultAgent |
| `llm` | 走了 LLM judge 兜底（仅在配置 `IM_HUB_LLM_JUDGE_AGENT` 时） |

### 5.2 命令行验证

```bash
# 看 session meta 是否还在
ls -la ~/.im-hub/sessions/<platform>:<channel>:<thread>.json

# 看里面的 agent 字段
jq '.agent, .lastActivity' ~/.im-hub/sessions/*.json | head
```

只要 `.json` 还在，sticky 不会丢。

---

## 六、调整会话保持时长

v2 把 TTL 拆成两层：

| TTL | 默认 | env 变量 | 影响 |
|---|---|---|---|
| 消息历史 | 30 min | `IMHUB_SESSION_MESSAGES_TTL_MS` | 仅清空 in-memory `messages[]` + 删 `.log` |
| 元数据 | 7 d | `IMHUB_SESSION_META_TTL_MS` | 完整删除 session（含 sticky agent + claudeSessionId） |

### 6.1 个人长用户：拉长 META TTL

如果你常常半个月才回到某个 thread，想让 sticky 一直锁住：

```ini
# /etc/systemd/system/im-hub.service
Environment="IMHUB_SESSION_META_TTL_MS=2592000000"   # 30 天
```

### 6.2 多用户高流量：缩短 META TTL

```ini
Environment="IMHUB_SESSION_META_TTL_MS=86400000"   # 1 天
```

### 6.3 改完重启

```bash
sudo systemctl daemon-reload
sudo systemctl restart im-hub
```

---

## 七、显式重置 / 切换

| 操作 | IM 命令 | 效果 |
|---|---|---|
| 切到 Claude | `/cc` 或 `/claude-code` | 改 sticky agent |
| 切到 opencode | `/oc` 或 `/opencode` | 改 sticky agent |
| 完全重置 | `/new` | 清消息 + 删 claudeSessionId + 重置 approval auto-allow |
| 看可用 agents | `/agents` | 列表 |
| 看路由策略 | `/router policy` | 当前规则 |
| 看决策理由 | `/router explain <text>` | 解释为什么会路由到某 agent |

---

## 八、故障排查

### 8.1 IM Claude 还是返回 `pwd` = `/`

说明工作区注入没生效。逐步检查：

```bash
systemctl status im-hub --no-pager
ls -la /root/workspace/im-hub/dist/core/agent-cwd.js
ls -la ~/.im-hub-workspaces/claude-code/CLAUDE.md
journalctl -u im-hub --since "10 min ago" | grep -E 'agent-cwd|workspace|spawn'
systemctl cat im-hub | grep IMHUB
```

最常见原因：升级后没重启服务。

### 8.2 sticky 失效，agent 自己变了

```bash
sqlite3 ~/.im-hub/audit.db \
  "select ts, intent, agent, score from spans order by ts desc limit 10"
ls -la ~/.im-hub/sessions/<key>.json
jq '.agent' ~/.im-hub/sessions/<key>.json
```

- `.json` 不存在 → 超过 META TTL（默认 7d），属于预期行为
- `.json` 存在但 agent 还是被改 → bug，跑 `bun test test/unit/intent.test.ts` 应仍 11 pass

### 8.3 项目记忆"没记住"

Claude 的 auto-memory 是 Claude 自己决定要不要写的。要明确触发：

> 在 IM 里说："请把这件事记到长期记忆里：……"

然后 Claude 会主动写到 `~/.im-hub-workspaces/claude-code/memory/MEMORY.md`。

```bash
ls -la ~/.im-hub-workspaces/claude-code/memory/
mkdir -p ~/.im-hub-workspaces/claude-code/memory/   # 不存在就建
```

### 8.4 Claude `--resume` 失败

```
[error] Could not find session <uuid> for project <path>
```

可能原因：
1. cwd 与原会话不一致（v2 升级前后路径变了：旧 jsonl 在 `~/.claude/projects/-/`，新 jsonl 在 `~/.claude/projects/-root-im-hub-workspaces-claude-code/`）
2. META TTL 已过，im-hub 把 claudeSessionId 删了，但用户手动 `/resume` 旧 id

**升级后冷启动**：第一次升级后所有 thread 的 `claudeSessionId` 仍指向旧路径 jsonl，
而 cwd 已切。最稳的做法：第一次升级后让 Claude 跑一条新对话（自然生成新 id 落到新
路径），或显式 `/new` 重置该 thread。

---

## 九、最佳实践

1. **角色书一次写好**：`CLAUDE.md` / `AGENTS.md` 写好就稳定，不要频繁改。Claude
   每次启动都会重新加载。
2. **重要事实写在角色书里**：`CLAUDE.md` 是确定性加载，`memory/MEMORY.md` 是 Claude
   自己择优写。比起 auto-memory，角色书更可靠。
3. **不要把项目代码放工作区里**：工作区只放角色书和记忆，代码本身仍在 `/root/workspace/...`。
4. **跨 IM 平台共享**：同一 thread key 在所有 IM 里 sticky 是独立的（key 含 platform）。
   想跨平台共享上下文需自己写桥接。
5. **备份**：把 `~/.im-hub-workspaces/` 加进备份脚本。

---

## 十、常用路径速查

| 需求 | 路径 |
|---|---|
| 写 IM Claude 角色书 | `~/.im-hub-workspaces/claude-code/CLAUDE.md` |
| 写 IM opencode 角色书 | `~/.im-hub-workspaces/opencode/AGENTS.md` |
| 写 IM Codex 角色书 | `~/.im-hub-workspaces/codex/AGENTS.md` |
| 看 Claude auto-memory | `~/.im-hub-workspaces/claude-code/memory/MEMORY.md` |
| 看 IM Claude jsonl 历史 | `~/.claude/projects/-root-im-hub-workspaces-claude-code/*.jsonl` |
| 看 IM Codex 会话历史 | `~/.codex/sessions/YYYY/MM/DD/*` |
| Codex bgjob 工作目录 | `~/.codex/bgjobs/`（独立 wrapper：`/root/.codex/scripts/bgjob`） |
| 看 im-hub session 状态 | `~/.im-hub/sessions/*.json` |
| 看 im-hub 审计日志 | `sqlite3 ~/.im-hub/audit.db` |
| 看 im-hub 服务日志 | `journalctl -u im-hub -f` |
