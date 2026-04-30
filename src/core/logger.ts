// Structured logging with trace id support

import pino from 'pino'
import { randomUUID } from 'crypto'

const level = process.env.LOG_LEVEL || 'info'
const usePretty = process.env.LOG_FORMAT === 'pretty' || (
  process.env.LOG_FORMAT !== 'json' && process.stdout.isTTY
)

const root = pino({
  level,
  ...(usePretty ? {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  } : {}),
  serializers: {
    token: () => '[REDACTED]',
    botToken: () => '[REDACTED]',
    bot_token: () => '[REDACTED]',
    appSecret: () => '[REDACTED]',
    app_secret: () => '[REDACTED]',
    password: () => '[REDACTED]',
  },
})

export function generateTraceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

export function createLogger(bindings: Record<string, unknown> = {}): pino.Logger {
  return root.child(bindings)
}

export { root as logger }
