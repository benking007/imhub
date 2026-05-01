# Discord 适配器配置指南

## 一、创建 Discord Bot

### 1. 创建应用
访问 [Discord Developer Portal](https://discord.com/developers/applications)，点击 **New Application**，输入名称。

### 2. 创建 Bot
左侧 **Bot** 标签 → **Add Bot** → 确认。

### 3. 启用特权意图（重要）
Bot 页面下拉到 **Privileged Gateway Intents**，开启：

- **MESSAGE CONTENT INTENT**（必需，否则无法读取消息内容）

另外两个按需开启：
- SERVER MEMBERS INTENT
- PRESENCE INTENT

### 4. 获取 Token
Bot 页面 → **Reset Token** → 复制 Token（只显示一次，妥善保存）。

### 5. 邀请 Bot 入服
左侧 **OAuth2** → **URL Generator**：

| 项 | 值 |
|----|-----|
| Scopes | `bot` |
| Bot Permissions | `Send Messages`、`Read Message History`、`View Channels` |

复制生成的 URL 在浏览器打开，选择目标服务器授权。

---

## 二、配置 im-hub

### 交互式配置
```bash
im-hub config discord
```

按提示输入 Bot Token，其余可选跳过。

### 手动配置
编辑 `~/.im-hub/config.json`：

```json
{
  "messengers": ["discord"],
  "agents": ["opencode"],
  "defaultAgent": "opencode",
  "discord": {
    "botToken": "你的Bot Token",
    "channelId": "default",
    "allowedGuilds": [],
    "allowedChannels": []
  }
}
```

| 字段 | 必需 | 说明 |
|------|------|------|
| `botToken` | 是 | Discord Bot Token |
| `channelId` | 否 | 默认频道标识，不填为 `"default"` |
| `allowedGuilds` | 否 | 服务器 ID 白名单，空数组 = 全部可用 |
| `allowedChannels` | 否 | 频道 ID 白名单，空数组 = 全部可用 |

---

## 三、启动

```bash
im-hub start
```

启动后在 Discord 频道中 @Bot 或直接发送消息即可对话。

### 验证命令
```
/status    — 查看当前状态
/agents    — 列出可用 Agent
/new       — 开启新会话
/help      — 帮助
```

---

## 四、获取 Discord ID

### 开启开发者模式
Discord 客户端 → 设置 → 高级 → **开发者模式** 开启。

### 获取 ID
- **服务器 ID**：右键服务器图标 → 复制服务器 ID
- **频道 ID**：右键频道 → 复制频道 ID
- **用户 ID**：右键用户名 → 复制用户 ID

---

## 五、常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| Bot 无响应 | 未启用 MESSAGE CONTENT INTENT | Developer Portal → Bot → 开启该意图 |
| Bot 离线 | Token 错误或未启动 | 检查 Token、重跑 `im-hub start` |
| 无法发消息 | Bot 权限不足 | OAuth2 重新邀请，勾选 Send Messages 权限 |

---

## 六、消息限制

| 项目 | 限制 |
|------|------|
| 单条消息 | 2000 字符 |
| 频道速率 | 5 条 / 5 秒 |
| 全局速率 | 50 条 / 秒 |

im-hub 自动处理消息分片和速率限制。
