# ADR-0003: Session Path Safety

- **日期**：2026-04-30
- **状态**：接受（Phase 1 P0-1 本批次落地）

---

## Context

`core/session.ts` 通过将 session key 中的 `:` 替换为 `-` 来生成文件路径：

```typescript
// session.ts:170
const filePath = join(SESSIONS_DIR, `${key.replace(/:/g, '-')}.json`);
```

Session key 的格式为：`${platform}:${channelId}:${threadId}`

其中 `threadId` 来自 messenger 接收到的消息（如微信的 `user:xxx` / `room:xxx`），可能包含 `/`、`..`、`\0` 等危险字符。当前仅替换 `:` 为 `-`，对路径穿越没有任何防护。

**PoC**：构造 `threadId = "../../../etc/malicious"` 可写入 `/etc/malicious.json`。

虽然 `SESSIONS_DIR = ~/.im-hub/sessions` 通常是深路径，实际逃逸有限，但这是原则性的安全漏洞，在"智能网关"多租户场景下不可接受。

## Decision

**对 session key 的所有组件进行 `sanitizeKey()` 消毒，仅允许 `[A-Za-z0-9_-]` 范围内的字符，其他字符用安全哈希替换。**

### 实现

```typescript
import { createHash } from 'crypto';

function sanitizeKey(raw: string): string {
  // 允许：字母、数字、下划线、连字符
  // 其他所有字符 → 用该字符的 sha256 前 8 位替换
  return raw.replace(/[^A-Za-z0-9_-]/g, (c) => {
    return createHash('sha256').update(c).digest('hex').slice(0, 8);
  });
}

// 应用到 filePath 生成
const safeKey = sanitizeKey(key); // replaces both : and any dangerous chars
const filePath = join(SESSIONS_DIR, `${safeKey}.json`);
```

### 设计理由

1. **白名单 > 黑名单**：不试图枚举所有危险字符（`/`、`..`、`\0`、`%00`、URL encode 等），直接限制字符集
2. **非破坏性**：对已存在的 session 文件不做迁移。TTL 为 6 小时，旧文件自然过期后自动清理。重启 im-hub 不会加载旧文件（key 格式变了匹配不上），最多丢失最近 6 小时内的未过期会话
3. **可反向**：用 SHA256 slice 替换非法字符而非截断，保证不同非法字符映射到不同值，避免冲突

## Consequences

- **正面**：从根本上杜绝路径穿越，无论外部传入什么 threadId 都不会写入 `SESSIONS_DIR` 以外
- **负面**：重启后旧 session 文件不会被加载（key 格式不匹配），用户可能丢失最近 6 小时内的对话历史。对生产场景影响小（6 小时 TTL 内丢失最多一次对话）
- **迁移策略**：不迁移。在 CHANGELOG 中注明 breaking change，建议在低峰时段部署
