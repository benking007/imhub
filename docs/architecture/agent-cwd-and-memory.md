# Agent CWD 与长期项目记忆设计（im-hub v2 Phase B + C）

> 状态：**已实施（2026-05-02）**
> 关联：`docs/im-gateway-v2-plan.md`、`docs/adr/0004-sticky-agent-and-split-ttl.md`、`docs/adr/0005-agent-cwd-isolation.md`
> 日期：2026-05-02
>
> **实施版本**：本文是落地后的设计 + 决策合订本。代码 = `core/agent-cwd.ts` + 两 adapter
> 的 `prepareCommand` + `cli.ts` 启动钩子。详见下方"实际落地差异"。

---

## 问题陈述

### 现状

- im-hub.service 通过 systemd 启动，无 `WorkingDirectory` 配置，进程 cwd = `/`。
- `src/utils/cross-platform.ts:crossSpawn` 不接收 cwd 参数，spawn 出来的 Claude / opencode 子进程继承 `/` 作为工作目录。
- Claude Code 用 cwd 作为 project key（`~/.claude/projects/<cwd-encoded>/`），所以**所有 IM 入口的 Claude 会话**都共享 `~/.claude/projects/-/` 这一个目录的 memory、CLAUDE.md、jsonl 历史。
- opencode 同理，所有 IM 入口共用 `~/.config/opencode/memory/` 与 `AGENTS.md`。

### 痛点

1. 无法为 Claude 与 opencode 分别定义"在 IM 入口下应该扮演什么角色"，因为它们读的是全局 `~/.claude/CLAUDE.md` 与 `~/.config/opencode/AGENTS.md`，而这两个文件还要服务于直连终端使用。
2. 无法做"per-IM-thread 项目档案" — 没有 cwd 维度的隔离。
3. Claude 的 auto-memory（`<cwd>/memory/MEMORY.md`）现在是全局共享的，IM 用户和直连终端互相污染。

---

## 设计目标

1. **IM 入口的 Claude 与 opencode 各有独立工作目录**，且与直连终端隔离。
2. **不破坏直连终端体验**：在终端里跑 Claude/opencode 的全局配置依然生效。
3. **复用 Agent 已有的 per-cwd 记忆机制**，不发明新的存储层。
4. **可按用户/线程进一步细分**（可选，先支持环境变量级别）。

---

## 方案

### 目录结构

```
~/.im-hub-workspaces/
├── claude-code/
│   ├── CLAUDE.md           # IM 入口的 Claude Code 角色定义
│   ├── AGENTS.md           # （可选）opencode 来同一目录时也能读到
│   └── memory/             # Claude 自动加载 MEMORY.md
│       └── MEMORY.md
├── opencode/
│   ├── AGENTS.md           # IM 入口的 opencode 角色定义
│   ├── PROJECT.md          # 长期项目档案
│   └── memory/
└── shared/                 # 两个 agent 都可以引用的公共片段
    └── facts.md
```

### 代码改动

#### 1. `src/utils/cross-platform.ts`

`crossSpawn` 已经透传 `options`，`SpawnOptions` 本身就有 `cwd`。**实际上无需改动**，因为调用方传 `{ cwd: ... }` 就会被 spread 进 `spawnOptions`。需要确认即可。

#### 2. `src/core/agent-base.ts`

```typescript
export interface SpawnPlan {
  args: string[]
  extraEnv?: Record<string, string>
+ cwd?: string  // optional working directory for the spawn
  cleanup?: () => void | Promise<void>
}
```

`spawnStream` 已经通过 `crossSpawn(this.commandName, plan.args, { ..., env: ... })`，把 `cwd` 加进去：

```typescript
const proc = crossSpawn(this.commandName, plan.args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: plan.extraEnv ? { ...process.env, ...plan.extraEnv } : undefined,
+ cwd: plan.cwd,
})
```

#### 3. `src/plugins/agents/claude-code/index.ts`

在 `prepareCommand` **顶部** 一次解析 cwd（实际落地用了共享 helper）：

```typescript
// 实际实现见 core/agent-cwd.ts
import { resolveAgentCwd } from '../../../core/agent-cwd'

const cwd = resolveAgentCwd('claude-code', opts)
// ...所有 4 条 return path 都 spread { cwd } 进去
```

`resolveAgentCwd` 的优先级：

```typescript
// core/agent-cwd.ts
export function resolveAgentCwd(agent: string, opts: AgentSendOpts): string | undefined {
  // 1. env override（per-agent 大写，运维 escape hatch）
  const envKey = `IMHUB_${agent.toUpperCase().replace(/-/g, '_')}_CWD`
  const explicit = process.env[envKey]
  if (explicit) return explicit
  // 2. IM 上下文 → 工作区
  if (opts.threadId && opts.platform) {
    const root = process.env.IMHUB_WORKSPACES_ROOT
      || join(homedir(), '.im-hub-workspaces')
    return join(root, agent)
  }
  // 3. 非 IM 上下文（web / scheduler / intent-llm）→ 不注入
  return undefined
}
```

#### 4. `src/plugins/agents/opencode/index.ts`

opencode 之前没有 `prepareCommand` 重写，新加一个；逻辑与 claude-code 完全一致
（都走 `resolveAgentCwd(this.name, opts)`）。

#### 5. systemd 不动

im-hub 主进程 cwd 仍为 `/`，所有 cwd 注入都在 spawn 时按 agent 决定，不影响 im-hub 本身。

---

## per-userId 细分（Phase B 可选扩展）

如果未来要让 alice 和 bob 在 IM 里聊 Claude 时进各自工作目录：

```typescript
function resolveCwd(opts: AgentSendOpts): string | undefined {
  if (process.env.IMHUB_CC_CWD) return process.env.IMHUB_CC_CWD
  if (!opts.threadId || !opts.platform) return undefined
  const userScope = opts.userId || 'shared'
  return join(homedir(), '.im-hub-workspaces', 'claude-code', userScope)
}
```

需要先 `mkdir -p` 该目录（用 `fs.mkdir({ recursive: true })`，幂等）。

---

## 长期项目记忆（Phase C）

实施完 Phase B 后，**自动获得**两条长期记忆链路：

### Claude Code

- `~/.im-hub-workspaces/claude-code/CLAUDE.md` 自动加载（Claude 的标准行为）
- `~/.im-hub-workspaces/claude-code/memory/MEMORY.md` 是 Claude auto-memory 的入口，Claude 会自己往里写
- `~/.claude/projects/-root-im-hub-workspaces-claude-code/` 落 jsonl 完整历史

### opencode

- `~/.im-hub-workspaces/opencode/AGENTS.md` 自动加载
- 项目档案手写到 `PROJECT.md`，在 `AGENTS.md` 里指引读取

### 可选增强：`/memo` 命令

在 `src/core/router.ts` 加一个 `/memo` 命令，把 `/memo add <text>` append 到对应 agent 工作区的 MEMORY.md / PROJECT.md。让用户在 IM 里就能写长期事实。

```
/memo add 用户偏好用 1 行 commit message
/memo show
/memo clear
```

实现复杂度低（一个新 command handler + 文件 append），等 B 落地后再加。

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| Claude 看到 cwd = `~/.im-hub-workspaces/claude-code/` 时尝试在该目录里搜代码 | 该目录里只有 CLAUDE.md，明确告诉 Claude "你在 IM 模式下，要查文件请去 `/root/workspace/...`" |
| 历史 IM 用户已经在 `/root/.claude/projects/-/memory/` 累积的 MEMORY.md 不会自动迁移 | 手工拷贝；或者把 `~/.im-hub-workspaces/claude-code/memory/MEMORY.md` 软链到旧路径，让记忆"两边都能看见"再分头维护 |
| opencode 的 `opencode run` 是否尊重 cwd 待验证 | Phase B 实施前先做 spike：`cd /tmp/x && opencode run "pwd"`，观察 stdout |

---

## 验收标准

Phase B 完成的标志：

1. 在 IM 中给 Claude Code 发 `pwd`，回 `~/.im-hub-workspaces/claude-code`（而非 `/`）
2. 在 `~/.im-hub-workspaces/claude-code/CLAUDE.md` 写一句"你叫小明"，IM 中问"你叫什么"，Claude 回"小明"
3. 同时在直连终端跑 `claude`，cwd 是当前终端目录，**不**读到上面的"小明"配置
4. opencode 同样验证一遍

Phase C 完成的标志：

5. IM 中跟 Claude 说"记住我喜欢极简风格"，下次新会话进来还能记得（via auto-memory）
6. （如做 `/memo`）`/memo show` 返回手工写过的所有事实

---

## 实际落地差异（vs 上文草案）

落地时与草案有两处差异：

1. **决策逻辑提取到 `core/agent-cwd.ts`**（草案里散在各 adapter）。原因：两个 adapter
   的判断分支必须 100% 一致，散落容易漂；后续做 per-userId / per-workspace 细分时
   单点修改即可。
2. **claude-code adapter 必须在所有 4 条返回路径都注入 cwd**（草案只示意了 happy
   path）。`prepareCommand` 有 4 处 `return`：approval 禁用、socket 启动失败、无 IM
   上下文、mcp 配置写入失败 — 漏一条就让该降级路径偷偷退回 `/`。详见 ADR 0005
   "Why all 4 fallback paths must carry cwd"。
3. **env 变量名比草案规范化**：`IMHUB_CC_CWD` → `IMHUB_CLAUDE_CODE_CWD`，
   `IMHUB_OC_CWD` → `IMHUB_OPENCODE_CWD`。原因：与 plugin name 一致，方便后续动态
   `IMHUB_<AGENT>_CWD`。
4. **新增** `IMHUB_WORKSPACES_ROOT`，整个工作区根目录可整体迁移。

## 落地清单

- [x] 验证 opencode 是否尊重 cwd（spike：`cd /tmp/x && opencode run "pwd"`，确认
      stdout 输出 `/tmp/x`）
- [x] `crossSpawn` cwd 透传确认（已透传，无需改）
- [x] `SpawnPlan.cwd` 字段（`core/agent-base.ts`）
- [x] `claude-code` adapter `prepareCommand` 4 路径全注入
- [x] `opencode` adapter 引入 `prepareCommand`，调 `resolveAgentCwd`
- [x] `core/agent-cwd.ts` 新建：`resolveAgentCwd()` + `bootstrapAgentWorkspaces()`
- [x] `cli.ts:start` 启动时调 `bootstrapAgentWorkspaces()`，幂等创建 + 种子模板
- [x] `~/.im-hub-workspaces/{claude-code/CLAUDE.md, opencode/AGENTS.md}` 初始模板
      已就位（已存在不覆盖）
- [x] 测试：`core/agent-cwd.test.ts` 13 pass，覆盖 4 条决策分支 + 种子幂等性 +
      env override 优先级 + `opts.threadId` 为空回退 undefined
- [x] 既有测试无回归：`claude-code/adapter.test.ts` 8 pass
- [x] 文档：本文 + ADR 0005 + `deployment.md` "IM 工作区" 一节 + 主计划的 Phase B
      段落
- [ ] （Phase C 增强）`/memo` 命令 — 设计在第六节"长期项目记忆"，未实现，按需再做
