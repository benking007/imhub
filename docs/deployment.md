# im-hub 部署指南

> 适用版本：v0.2.13+

本文档覆盖在 Linux 服务器上部署 im-hub 的完整流程：依赖、构建、systemd 守护、端口暴露、配置、平滑升级。Windows 与 macOS 部署路径相似（仅 systemd 部分需替换）。

---

## 一、最小依赖

| 依赖 | 版本 | 必需 |
|---|---|---|
| Node.js | ≥ 22 LTS | ✅ |
| npm | ≥ 10 | ✅（随 Node） |
| 至少一个 Agent CLI | — | ✅（详见下） |
| SQLite native build toolchain | gcc / make / python3 | ⚠️ 仅在 npm 装 better-sqlite3 时编译需要 |
| 可选：bun | ≥ 1.3 | 仅本地跑测试用，不在生产用 |

**Agent CLI**（至少装一个）：

```bash
npm i -g @anthropic-ai/claude-code   # Claude Code
npm i -g @openai/codex                # Codex
npm i -g @github/copilot              # Copilot
npm i -g opencode-ai                  # OpenCode
```

或者只对接 ACP 远端 agent，本机不装任何 CLI 也行。

---

## 二、安装

### 2.1 全局安装（推荐生产）

```bash
npm install -g im-hub
im-hub --version    # 应该输出 0.2.13 或更新
```

### 2.2 从源码部署

```bash
# 克隆 + 构建
git clone https://github.com/benking007/imhub.git /opt/im-hub
cd /opt/im-hub
npm install
npm run build

# 全局软链
npm link
```

---

## 三、首次配置

`im-hub` 把所有运行时数据放在 `~/.im-hub/`。结构如下：

```
~/.im-hub/
├── config.json              # 主配置（所有 messengers / agents / workspaces）
├── web-token                # Web/ACP API 鉴权 token（自动生成）
├── audit.db                 # 审计日志（30 天保留，可改）
├── jobs.db                  # Job Board
├── schedules.db             # 定时任务
└── sessions/                # 会话历史（每会话一个 .json + .log）
```

### 3.1 接入 IM 通道

至少配一个：

```bash
im-hub config telegram   # 输入 @BotFather 给的 bot token
im-hub config feishu     # 输入飞书 App ID / App Secret
im-hub config wechat     # 扫二维码登录
```

> Web 控制台单独跑也行，不一定要接 IM。

### 3.2 接入自定义 ACP Agent（可选）

```bash
im-hub config agent
# 交互式向导：name / endpoint / 鉴权方式
```

或在 `config.json` 里直接写：

```json
{
  "acpAgents": [
    { "name": "weather", "endpoint": "https://example.com/acp",
      "auth": { "type": "bearer", "token": "..." } }
  ],
  "acpDiscoveryUrls": [
    "https://internal.team.example.com"
  ]
}
```

`acpDiscoveryUrls` 会在启动时拉 `<url>/.well-known/acp`，自动注册其中所有 agent。

### 3.3 Workspace（多租户，可选）

```json
{
  "workspaces": [
    {
      "id": "engineering",
      "name": "Engineering",
      "agents": ["claude-code", "opencode"],
      "members": ["wx_alice", "wx_bob"],
      "rateLimit": { "rate": 30, "intervalSec": 60, "burst": 60 }
    }
  ]
}
```

不配置任何 workspace 时，默认 workspace 不限制（所有已注册 agent 都可用）。

---

## 四、启动

### 4.1 直接前台运行（用于调试）

```bash
im-hub start
```

### 4.2 systemd 服务（生产）

`/etc/systemd/system/im-hub.service`：

```ini
[Unit]
Description=im-hub — IM-to-Agent gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=imhub
Group=imhub
WorkingDirectory=/home/imhub
Environment="HOME=/home/imhub"
Environment="NODE_ENV=production"
Environment="LOG_LEVEL=info"
Environment="LOG_FORMAT=json"
# 任务并发上限（默认 3）
Environment="IM_HUB_MAX_CONCURRENT_JOBS=5"
# 审计日志保留天数（默认 30）
Environment="IM_HUB_AUDIT_RETENTION_DAYS=60"
# 可选：让 LLM 兜底参与意图路由
# Environment="IM_HUB_LLM_JUDGE_AGENT=claude-code"

ExecStart=/usr/bin/im-hub start
Restart=always
RestartSec=5

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/imhub/.im-hub
PrivateTmp=true
PrivateDevices=true

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo useradd -m -s /bin/bash imhub
sudo cp im-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now im-hub
sudo systemctl status im-hub
sudo journalctl -u im-hub -f
```

> 全局安装的 `im-hub` 路径取决于你的 npm prefix。`which im-hub` 找一下，把 `ExecStart` 改成实际路径。

### 4.3 Docker（可选）

最简 Dockerfile：

```dockerfile
FROM node:22-alpine
RUN apk add --no-cache python3 make g++ sqlite-libs
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY src/web/public ./dist/web/public
ENV HOME=/data
VOLUME /data
EXPOSE 3000 9090
CMD ["node", "dist/cli.js", "start"]
```

```bash
docker build -t im-hub .
docker run -d \
  --name im-hub \
  -v /opt/im-hub-data:/data \
  -p 3000:3000 \
  -p 9090:9090 \
  -e LOG_LEVEL=info \
  -e LOG_FORMAT=json \
  im-hub
```

---

## 五、端口与暴露

| 端口 | 服务 | 默认绑定 | 暴露建议 |
|---|---|---|---|
| 3000 | Web 控制台 + REST API | **`0.0.0.0`**（全网监听） | 公网部署时必须配防火墙 + HTTPS 反代 |
| 9090 | ACP Server | `127.0.0.1` only | 仅 ACP 上游需要时 |

> ⚠️ **Web 控制台默认对所有网络接口开放**（v0.2.13 起），方便容器/虚拟机网络环境直接访问。生产部署到公网时**必须**：
> 1. 用防火墙（云厂商安全组 / iptables / ufw）只允许已知来源 IP；
> 2. 用 nginx/Caddy 做 HTTPS 反代终端用户访问，**不要直接 HTTP 暴露**（web-token 在 header 里明文传，HTTP 等于交给中间路由）；
> 3. 定期轮换 token：`rm ~/.im-hub/web-token && systemctl restart im-hub`。
>
> 如果只在私网用，建议改回回环监听（修改 `~/.im-hub/config.json`，加 `"webHost": "127.0.0.1"`，或者直接修改源码 `src/web/server.ts:206`）。

### 5.1 nginx 反代示例

```nginx
upstream imhub_web { server 127.0.0.1:3000; }

server {
  listen 443 ssl http2;
  server_name imhub.example.com;
  ssl_certificate     /etc/letsencrypt/live/imhub.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/imhub.example.com/privkey.pem;

  # WebSocket 升级
  location / {
    proxy_pass http://imhub_web;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 600s;        # 长 agent 任务
    proxy_send_timeout 600s;
  }
}

server {
  listen 80;
  server_name imhub.example.com;
  return 301 https://$server_name$request_uri;
}
```

### 5.2 端口冲突

修改 `~/.im-hub/config.json`：

```json
{ "webPort": 3001, "acpPort": 9091 }
```

---

## 六、Web 控制台

启动后浏览器访问 `http://<host>:3000`。三个页面：

| 路径 | 功能 |
|---|---|
| `/` | Agent 对话 |
| `/tasks` | 任务面板（jobs + schedules，可创建/取消/查看结果） |
| `/settings` | 配置 agents / messengers / ACP / discovery |

所有 `/api/*` 请求都带 `X-IM-Hub-Token` 自动鉴权（token 注入到 HTML 里）。

---

## 七、监控

### 7.1 Prometheus 抓取

`/api/metrics` 输出 Prometheus text exposition 格式（需 web-token）：

```
scrape_configs:
  - job_name: im-hub
    metrics_path: /api/metrics
    bearer_token: <web-token-content>
    static_configs:
      - targets: ['imhub.example.com']
    scheme: https
```

> bearer_token 用 `cat ~/.im-hub/web-token` 取出。

关键指标：

```
im_hub_agent_invocations_total{agent,result}
im_hub_agent_latency_ms{agent,quantile=0.5|0.95|0.99}
im_hub_agent_cost_sum{agent}
im_hub_intent_total{intent}
im_hub_uptime_seconds
```

### 7.2 健康检查

```bash
curl -H "X-IM-Hub-Token: $(cat ~/.im-hub/web-token)" \
  http://127.0.0.1:3000/api/health
```

返回 `{ ok: true, agents: { ... } }`，所有 agent 都不可用时返回 503。可用作 k8s readiness probe。

### 7.3 日志

`LOG_FORMAT=json` 时输出结构化日志（pino），每条都带 `traceId`，可以串到 ELK / Loki：

```json
{"level":30,"time":...,"traceId":"a4b3c8...",
 "platform":"telegram","component":"router","msg":"router.intent",
 "agent":"opencode","intent":"topic","score":3.2}
```

`grep traceId=a4b3c8` 就能拉出某次请求从 messenger → router → agent → audit 的全链路。

---

## 八、备份

业务数据完全在 `~/.im-hub/` 下，**无外部依赖**。备份策略：

```bash
# 停服 → 备份 → 起服（推荐：业务低峰）
sudo systemctl stop im-hub
tar czf imhub-$(date +%F).tgz -C /home/imhub .im-hub
sudo systemctl start im-hub

# 或热备（SQLite WAL 模式安全）
sqlite3 /home/imhub/.im-hub/audit.db ".backup /backup/audit.db"
sqlite3 /home/imhub/.im-hub/jobs.db ".backup /backup/jobs.db"
sqlite3 /home/imhub/.im-hub/schedules.db ".backup /backup/schedules.db"
cp /home/imhub/.im-hub/config.json /backup/
cp -r /home/imhub/.im-hub/sessions /backup/
```

---

## 九、升级

```bash
# 全局安装
sudo systemctl stop im-hub
npm install -g im-hub@latest
sudo systemctl start im-hub

# 源码部署
cd /opt/im-hub
sudo systemctl stop im-hub
git pull
npm install
npm run build
sudo systemctl start im-hub
```

升级前看一下 `CHANGELOG.md`。配置文件向前兼容（新字段都是可选）。

会话格式向前兼容：旧的单文件 session JSON 会被读取并迁移到新的"metadata.json + log.jsonl"split format，不需要手工迁移。

---

## 十、常见问题

### `better-sqlite3` 装不上

需要 build toolchain：

```bash
# Debian/Ubuntu
sudo apt install build-essential python3
# CentOS/RHEL
sudo yum groupinstall "Development Tools"
sudo yum install python3
# Alpine
apk add python3 make g++ sqlite-libs
```

或装预编译 binary：

```bash
npm install -g im-hub --build-from-source=false
```

### 启动后 Web 端 401

确认请求带了 `X-IM-Hub-Token` header（值 = `~/.im-hub/web-token` 文件内容）。Web UI 是从 HTML 里自动读 `window.IMHUB_TOKEN` 注入的，所以浏览器直接打开主页一定有；用 curl/Postman 时要手动加。

### 任务跑得太多把内存吃满

调小 `IM_HUB_MAX_CONCURRENT_JOBS`（默认 3，建议跟 CPU/内存量对齐：每个 agent 进程峰值 200-500 MB）。

### 想关掉审计日志

```bash
export IM_HUB_AUDIT_RETENTION_DAYS=1   # 仍写入但只保留 1 天
```

或者直接删 `~/.im-hub/audit.db`，im-hub 会重建空表（重启后生效）。

### 飞书 / Telegram bot 有时收不到消息

检查日志的 `level=40` 行；最常见原因是 webhook/long-polling 网络中断。systemd 配 `Restart=always` 让进程重启即可恢复。

### 想把 Web/ACP 暴露到公网

**不要直接开放**。一定要：
1. 反向代理强制 HTTPS（见 §5.1）
2. 防火墙只允许已知来源
3. 审视 `~/.im-hub/web-token`，定期轮换（删文件，重启服务，会自动生成新 token）

---

## 十一、自检清单

部署完跑一遍：

```bash
# 1. 服务起来了
systemctl status im-hub
journalctl -u im-hub --since "5 min ago"

# 2. 端口监听
ss -lntp | grep -E ':(3000|9090)'

# 3. Web 健康
curl -fsS -H "X-IM-Hub-Token: $(cat ~/.im-hub/web-token)" \
  http://127.0.0.1:3000/api/health | jq

# 4. agent 可用性
curl -fsS -H "X-IM-Hub-Token: $(cat ~/.im-hub/web-token)" \
  http://127.0.0.1:3000/api/agents/status | jq

# 5. metrics 正常
curl -fsS -H "X-IM-Hub-Token: $(cat ~/.im-hub/web-token)" \
  http://127.0.0.1:3000/api/metrics | head

# 6. 跑一个回环任务
curl -fsS -X POST \
  -H "X-IM-Hub-Token: $(cat ~/.im-hub/web-token)" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"echo hello","agent":"claude-code"}' \
  http://127.0.0.1:3000/api/invoke | jq
```

每条都返回成功就 OK。

---

## 十二、环境变量速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal`/`silent` |
| `LOG_FORMAT` | `pretty` (TTY) / `json` (非 TTY) | 强制：`pretty` / `json` |
| `IM_HUB_MAX_CONCURRENT_JOBS` | `3` | 同时执行的 Job 数上限 |
| `IM_HUB_AUDIT_RETENTION_DAYS` | `30` | 审计日志保留天数 |
| `IM_HUB_LLM_JUDGE_AGENT` | （未设） | LLM 兜底路由的 judge agent 名 |
| `IM_HUB_LLM_JUDGE_THRESHOLD` | `1.0` | judge 触发的规则引擎置信度阈值 |
| `<AGENT>_TIMEOUT_MS` | `1800000` (30min) | 单 agent 超时（如 `OPENCODE_TIMEOUT_MS`） |

---

## 十三、卸载

```bash
sudo systemctl disable --now im-hub
sudo rm /etc/systemd/system/im-hub.service
sudo systemctl daemon-reload
npm uninstall -g im-hub
sudo userdel -r imhub          # 同时删 ~/.im-hub 数据
```
