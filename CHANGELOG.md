# Changelog

All notable changes to this project will be documented in this file.

## [0.2.7] - 2026-03-27

### Added
- **Conversation history support** — agents now remember context across messages
  - Session stores message history (`ChatMessage[]`)
  - History is passed to agents with each prompt for context awareness
  - `/new` command to start a fresh conversation (clears history)
- **ChatMessage type** — `{ role: 'user' | 'assistant', content: string, timestamp: Date }`
- **Session history management** in SessionManager:
  - `addMessage()` — add message to conversation history
  - `resetConversation()` — clear history, start new session
  - `getSessionWithHistory()` — retrieve session with messages

### Changed
- **AgentAdapter interface** — `sendPrompt()` now accepts optional `history?: ChatMessage[]`
- **All agent adapters** (claude-code, codex, copilot, opencode) now:
  - Accept conversation history
  - Build contextual prompts with previous messages
- **Router** — automatically saves user messages and agent responses to history
- **Help text** — updated to include `/new` command

### Fixed
- Context loss issue in channel-based conversations — agents now maintain conversation memory

## [0.2.2.0] - 2026-03-27

### Added
- **Onboarding module** (`src/core/onboarding.ts`) with friendly first-run experience
  - `checkMessengerConfig()` — detect if messengers are configured
  - `checkAgentAvailability()` — async check with session-level caching
  - `runMessengerOnboarding()` — interactive messenger setup wizard
  - `formatAgentInstallHint()` — friendly install messages for missing agents
  - `formatAgentNotAvailableError()` — chat-friendly runtime error messages
  - `formatMessengerStartError()` — actionable hints for startup failures

### Changed
- **CLI start command** now runs onboarding checks before starting messengers
  - Detects unconfigured messengers and launches interactive setup
  - Warns about missing agents with install instructions
  - Shows friendly error messages instead of stack traces
- **Router** now checks agent availability at runtime
  - Returns helpful chat message if requested agent isn't installed
  - Uses cached availability check to avoid repeated process spawns

### Fixed
- Critical bug where onboarding never triggered because `config.messengers` was auto-filled with default
- Ugly stack traces shown to users when messenger fails to start

## [0.0.1.0] - 2026-03-25

### Added
- Initial project scaffold with TypeScript + Bun
- Core types: `Message`, `ParsedMessage`, `Session`, `MessengerAdapter`, `AgentAdapter`
- Plugin registry for static imports
- Message router with command parsing (`/status`, `/help`, `/agents`, `/<agent>`)
- Session manager with file-based persistence
- WeChat adapter stub (wechaty-puppet-wechat)
- Claude Code adapter stub (stream-json mode)
- CLI commands: `start`, `config`, `agents`, `messengers`
