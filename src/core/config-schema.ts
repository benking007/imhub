// Config schema validation using zod

import { z } from 'zod'

const acpAgentSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  endpoint: z.string().min(1),
  auth: z.object({
    type: z.enum(['none', 'apikey', 'bearer']),
    token: z.string().optional(),
  }).optional(),
  enabled: z.boolean().optional(),
})

const telegramSchema = z.object({
  botToken: z.string().min(1),
  channelId: z.string().optional(),
})

const feishuSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  channelId: z.string().optional(),
})

export const configSchema = z.object({
  messengers: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  defaultAgent: z.string().default('claude-code'),
  telegram: telegramSchema.optional(),
  feishu: feishuSchema.optional(),
  acpAgents: z.array(acpAgentSchema).optional(),
  webPort: z.number().int().positive().optional(),
}).passthrough()

export type ValidatedConfig = z.infer<typeof configSchema>

export function validateConfig(data: unknown):
  { ok: true; config: ValidatedConfig } | { ok: false; errors: string[] }
{
  const result = configSchema.safeParse(data)
  if (result.success) {
    return { ok: true, config: result.data }
  }
  const errors = result.error.issues.map(issue => {
    const path = issue.path.join('.') || '(root)'
    return `${path}: ${issue.message}`
  })
  return { ok: false, errors }
}
