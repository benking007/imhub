# im-hub

**Universal messenger-to-agent bridge** — connect WeChat/Feishu/Telegram to Claude Code/Codex/Copilot/OpenCode.

<p align="center">
  <img src="assets/banner.jpg" alt="im-hub banner" width="800">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/im-hub"><img src="https://img.shields.io/npm/dw/im-hub?style=for-the-badge&logo=npm&color=green"></a>
  <a href="https://github.com/ceociocto/im-hub/actions/workflows/release.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/ceociocto/im-hub/release.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/im-hub"><img src="https://img.shields.io/npm/v/im-hub?style=for-the-badge" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <img src="assets/screenshot-telegram.png" alt="Telegram" width="400">
  &nbsp;&nbsp;
  <img src="assets/screenshot-wechat.png" alt="WeChat" width="400">
</p>

<p align="center">
  <b>Telegram</b> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <b>WeChat</b>
</p>

```
npm install -g im-hub
im-hub config wechat   # Scan QR to login
im-hub start           # Start the bridge
```

## Features

- **Universal multiplexer** — one instance, multiple messengers, multiple agents
- **Plugin architecture** — easy to add new messengers/agents
- **TypeScript native** — no Go/Docker required
- **JSONL streaming** — real-time agent responses

## Installation

```bash
# Install globally
npm install -g im-hub
```

## Quick Start

```bash
# 1. Configure WeChat
im-hub config wechat
# Scan the QR code with WeChat

# OR configure Feishu (WebSocket long polling - no webhook needed!)
im-hub config feishu
# Enter App ID and App Secret from Feishu Open Platform

# OR configure Telegram
im-hub config telegram
# Get bot token from @BotFather

# 2. Configure Claude Code (optional, auto-detected)
im-hub config claude

# 3. Start the bridge
im-hub start
```

### Feishu Setup (WebSocket Long Polling)

Feishu uses WebSocket long polling mode, which means:
- ✅ No webhook configuration needed
- ✅ No public IP or domain required
- ✅ No ngrok or similar tools needed
- ✅ Works directly from localhost

Just configure your App ID and App Secret, then start the bridge. The bot will automatically connect to Feishu servers via WebSocket.

## Commands

```
im-hub                 # Same as 'start'
im-hub start           # Start the bridge
im-hub config wechat   # Configure WeChat
im-hub config claude   # Configure Claude Code
im-hub agents          # List available agents
im-hub messengers      # List available messengers
im-hub help
```

## Chat Commands

Send these as messages to the bot:

```
hello                  # Send to default agent
/status                # Show connection status
/help                  # Show available commands
/agents                # List available agents
/cc explain this code  # Switch to Claude Code
/cx explain this code  # Switch to Codex
/co explain this code  # Switch to Copilot
/oc explain this code  # Switch to OpenCode
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        im-hub core                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Plugin      │  │ Message     │  │ Session Manager     │  │
│  │ Registry    │  │ Router      │  │ (per conversation)  │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
┌─────────────────┐      ┌─────────────────┐
│ Messenger Plugins│      │  Agent Plugins  │
│ • wechat         │      │ • claude-code    │
│ • feishu ✓        │      │ • codex          │
│ • telegram ✓      │      │ • copilot        │
│                  │      │ • opencode       │
└─────────────────┘      └─────────────────┘
```

## Project Structure

```
im-hub/
├── src/
│   ├── core/
│   │   ├── types.ts              # Plugin interfaces
│   │   ├── registry.ts           # Plugin registration
│   │   ├── router.ts             # Message routing
│   │   └── session.ts            # Session management
│   ├── plugins/
│   │   ├── messengers/
│   │   │   └── wechat/           # WeChat adapter
│   │   └── agents/
│   │       ├── claude-code/      # Claude Code adapter
│   │       ├── codex/            # OpenAI Codex adapter
│   │       ├── copilot/          # GitHub Copilot adapter
│   │       └── opencode/         # OpenCode adapter
│   ├── index.ts                  # Main entry
│   └── cli.ts                    # CLI commands
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration

Config file: `~/.im-hub/config.json`

```json
{
  "messengers": ["wechat"],
  "agents": ["claude-code"],
  "defaultAgent": "claude-code"
}
```

## Requirements

- **Node.js 18+**
- **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

## Development

```bash
# Clone
git clone https://github.com/ceociocto/im-hub
cd im-hub

# Install deps
npm install

# Build
npm run build

# Run in dev mode (watch)
npm run dev

# Run
npm start
```

## Roadmap

### v0.1.x (MVP)
- [x] WeChat adapter with QR login
- [x] Claude Code agent integration
- [x] Codex agent
- [x] Copilot agent
- [x] OpenCode agent
- [x] Basic command routing

### v0.2.0
- [x] Feishu adapter
- [x] Telegram adapter
- [ ] Session persistence

### v0.3.0
- [ ] DingTalk adapter
- [ ] Slack adapter

## License

MIT
