# ADR 0005 — Per-Agent CWD Isolation for the IM Context

> Status: accepted · 2026-05-02
> Supersedes: nothing
> Related: ADR 0001 (AgentBase abstraction), ADR 0004 (sticky agent + split TTL),
> `docs/architecture/agent-cwd-and-memory.md`, `docs/im-gateway-v2-plan.md` Phase B

## Context

`im-hub.service` runs under systemd with no `WorkingDirectory` directive, so the
process cwd is `/`. `crossSpawn()` historically did not pass any explicit cwd
to its children, so Claude Code and opencode also inherit `/` as their cwd.
This is the project key both CLIs use to find their per-project memory:

- Claude: `~/.claude/projects/<cwd-encoded>/{CLAUDE.md,memory/,*.jsonl}`
- opencode: `~/.config/opencode/...` keyed off the spawn cwd

Concrete consequences:

1. Every IM thread, every direct-terminal session, and every background
   scheduler tick share the SAME global memory bucket — auto-saves from one
   pollute the other.
2. Cannot give the IM-routed Claude / opencode a distinct role (CLAUDE.md /
   AGENTS.md) without overwriting the user's terminal config.
3. A "long-term project memory" feature was unbuildable: there was no
   per-IM-context dimension to key the memory off.

## Decision

Resolve a per-agent cwd at spawn time in the IM context, default
`~/.im-hub-workspaces/<agent>/`. Non-IM calls (web UI, scheduler,
intent-llm judge) keep cwd undefined and inherit im-hub's cwd, preserving
the prior behavior exactly.

Resolution order, single source of truth in `core/agent-cwd.ts`:

1. Env override `IMHUB_<AGENT>_CWD` always wins (admin escape hatch / future
   per-tenant overrides).
2. If `opts.threadId && opts.platform`, return
   `<IMHUB_WORKSPACES_ROOT>/<agent>/`.
3. Otherwise return `undefined` (web/scheduler path, unchanged).

`SpawnPlan` gains an optional `cwd?: string`, which `spawnStream` forwards to
`crossSpawn`. `crossSpawn` already passes `options.cwd` through to
`child_process.spawn` — no change needed there.

At startup `cli.ts` calls `bootstrapAgentWorkspaces()` once. It is
idempotent: creates `~/.im-hub-workspaces/{claude-code,opencode}/` if
missing, and seeds `CLAUDE.md` / `AGENTS.md` only if they don't already
exist. Existing user edits are NEVER overwritten.

## Why a single helper module instead of inline per-adapter

Both adapters need the exact same decision logic. Putting it inline means:
- Drift between Claude and opencode behavior over time
- Harder to extend later (per-userId cwd, per-workspace cwd) — would need to
  touch every adapter

`core/agent-cwd.ts` exports `resolveAgentCwd(agentName, opts)` and a
seedable `bootstrapAgentWorkspaces()`. Future agents just call
`resolveAgentCwd(this.name, opts)` in their `prepareCommand`.

## Why all 4 fallback paths in claude-code must carry cwd

`claude-code/index.ts:prepareCommand` has 4 returns:

1. `IMHUB_APPROVAL_DISABLED=1` → `dontAsk` mode
2. Approval bus not started → fallback `dontAsk`
3. No IM context (web/scheduler) → fallback `dontAsk`
4. `mkdtemp` / `writeFile` for mcp-config failed → fallback `dontAsk`
5. Happy path → approval-routed with mcp-config

If any of paths 1-4 forgets to pass cwd, that degradation silently demotes
the call back to im-hub's `/` cwd, leaking memory across IM and terminal.
We compute cwd ONCE at the top of `prepareCommand` and pass it on every
return. `resolveAgentCwd` itself returns `undefined` for path 3 (no IM
context) so non-IM call sites still behave correctly.

## What this does NOT change

- Non-IM agent invocations (web, scheduler, intent-llm) — cwd stays
  undefined, inherits im-hub `/`, behavior identical to before.
- Direct-terminal usage (`claude` / `opencode` typed at a shell prompt) —
  not in im-hub's call path at all, completely unaffected.
- Other CLI agents (codex, copilot, ACP-imported) — they don't override
  `prepareCommand` and don't have per-cwd memory anyway. They continue to
  inherit im-hub's cwd.
- Memory format. We rely entirely on Claude / opencode's existing per-cwd
  memory mechanism — no new storage layer.

## Consequences

### Positive

- IM-routed Claude reads `~/.im-hub-workspaces/claude-code/CLAUDE.md`,
  separate from `~/.claude/CLAUDE.md`. User can give the IM persona a
  distinct role without affecting terminal sessions.
- Claude auto-memory accumulates per-IM-context in
  `~/.im-hub-workspaces/claude-code/memory/MEMORY.md`. This unlocks the
  "long-term project memory" feature (Phase C of the v2 plan) for free —
  no new code, just a directory that already exists.
- opencode gets the same isolation via `AGENTS.md`.
- Future per-userId / per-workspace cwd subdivision is a 5-line change in
  `agent-cwd.ts`; everything else stays the same.

### Negative / risks

- The IM-routed Claude no longer "sees" the user's global `~/.claude/CLAUDE.md`.
  If the user had useful global rules there, they need to copy/symlink them
  into the new workspace's CLAUDE.md. Mitigation: the bootstrap seed
  template names this explicitly so the user notices on first read.
- Existing IM-context Claude memory accumulated in
  `~/.claude/projects/-/` is NOT migrated. Mitigation: it stays where it is
  and is still readable via terminal Claude; the new workspace starts fresh.
  Users who care can manually copy `MEMORY.md` over.
- Adds ~300 LOC (helper + tests + bootstrap). Worth it for the cleaner
  decision boundary and the unlocked Phase C.

## Verification

- 13 unit tests in `core/agent-cwd.test.ts` covering all 4 decision branches
  + seed idempotency + env override priority.
- 8 existing `claude-code/adapter.test.ts` tests still pass — confirms cwd
  injection didn't break the approval-routing logic.
- Live check after restart:
  - `ls ~/.im-hub-workspaces/` shows both seeded dirs
  - IM `pwd` to Claude returns `/root/.im-hub-workspaces/claude-code`
  - IM `pwd` to opencode returns `/root/.im-hub-workspaces/opencode`
  - Web chat `pwd` to either still returns `/`
