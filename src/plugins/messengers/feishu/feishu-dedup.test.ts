// Tests the message_id dedup gate inside FeishuAdapter. The handler itself
// pulls in the larksuite SDK which is heavy and needs network — instead we
// poke handleFeishuMessage via the same private path. We construct minimal
// fake events and observe whether messageHandler fires.

import { describe, it, expect, beforeEach } from 'bun:test'
import { FeishuAdapter } from './feishu-adapter.js'
import type { MessageContext } from '../../../core/types.js'

interface FakeEvent {
  sender: { sender_type: string; sender_id?: { open_id?: string } }
  message: { message_id: string; chat_id: string; message_type: string; content: string; create_time: string }
}

function evt(messageId: string, text = 'hello'): FakeEvent {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'u1' } },
    message: {
      message_id: messageId,
      chat_id: 'oc_test',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: String(Date.now()),
    },
  }
}

describe('FeishuAdapter message_id dedup', () => {
  let adapter: FeishuAdapter
  let calls: MessageContext[]

  beforeEach(() => {
    adapter = new FeishuAdapter()
    calls = []
    adapter.onMessage(async (ctx) => { calls.push(ctx) })
  })

  // The handler is private — reach in for tests
  const handle = (a: FeishuAdapter, e: FakeEvent): Promise<void> => {
    // @ts-expect-error — protected access
    return a.handleFeishuMessage(e)
  }

  it('first delivery of a message_id passes through to the handler', async () => {
    await handle(adapter, evt('msg-1'))
    expect(calls.length).toBe(1)
    expect(calls[0].message.id).toBe('msg-1')
    expect(calls[0].message.text).toBe('hello')
  })

  it('replayed message_id is dropped (handler not invoked)', async () => {
    await handle(adapter, evt('msg-2', 'first'))
    await handle(adapter, evt('msg-2', 'second')) // same id, different text
    expect(calls.length).toBe(1)
    expect(calls[0].message.text).toBe('first')
  })

  it('different message_ids are independent', async () => {
    await handle(adapter, evt('msg-A'))
    await handle(adapter, evt('msg-B'))
    await handle(adapter, evt('msg-A')) // dup
    expect(calls.length).toBe(2)
    expect(calls.map((c) => c.message.id)).toEqual(['msg-A', 'msg-B'])
  })

  it('bot/app sender is filtered before dedup', async () => {
    const e = evt('msg-bot')
    e.sender.sender_type = 'app'
    await handle(adapter, e)
    // Same id is still considered "not seen" by dedup (filter ran first)
    e.sender.sender_type = 'user'
    await handle(adapter, e)
    expect(calls.length).toBe(1)
    expect(calls[0].message.id).toBe('msg-bot')
  })

  it('empty message_id does not poison dedup (every empty id is processed)', async () => {
    const e1 = evt('', 'a')
    const e2 = evt('', 'b')
    await handle(adapter, e1)
    await handle(adapter, e2)
    // Empty id is not deduped — both pass
    expect(calls.length).toBe(2)
  })
})
