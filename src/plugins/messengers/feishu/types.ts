// Feishu/Lark Bot API Types
// Using official SDK: @larksuiteoapi/node-sdk

export interface FeishuConfig {
  appId: string
  appSecret: string
  verificationToken?: string  // Optional, for additional validation
}

// Note: The official SDK handles encryption and token management internally
// when using WebSocket long polling mode, so encryptKey is not needed

export interface FeishuMessage {
  message_id: string
  root_id?: string
  parent_id?: string
  chat_id: string
  message_type: string
  content: string
  create_time: string
  sender: {
    sender_id: {
      union_id?: string
      user_id?: string
      open_id?: string
    }
    sender_type: string
  }
}

export interface FeishuEvent {
  schema: string
  header: {
    event_id: string
    event_type: string
    create_time: string
    token: string
    app_id: string
    tenant_key: string
  }
  event: {
    sender: {
      sender_id: {
        union_id?: string
        user_id?: string
        open_id?: string
      }
      sender_type: string
      tenant_key: string
    }
    message: FeishuMessage
  }
}

export interface FeishuCardAction {
  tag: 'button'
  text: { tag: 'plain_text'; content: string }
  type: 'primary' | 'default' | 'danger'
  value: Record<string, string>
}

export interface FeishuCardElement {
  tag: 'div' | 'markdown' | 'note' | 'hr' | 'action' | 'code'
  text?: { tag: 'plain_text' | 'lark_md'; content: string }
  content?: string
  language?: string
  elements?: FeishuCardElement[]
  actions?: FeishuCardAction[]
}

export interface FeishuCard {
  type: 'template'
  data: {
    template_id?: string
    config?: {
      wide_screen_mode?: boolean
    }
    header?: {
      title: { tag: 'plain_text'; content: string }
      subtitle?: { tag: 'plain_text'; content: string }
      template?: string
    }
    elements: FeishuCardElement[]
  }
}

export interface CardCallbackEvent {
  schema: string
  header: {
    event_id: string
    event_type: string
    create_time: string
    token: string
    app_id: string
    tenant_key: string
  }
  event: {
    operator: {
      open_id: string
      user_id?: string
      union_id?: string
    }
    action: {
      value: Record<string, string>
    }
    context: {
      open_message_id: string
      open_chat_id: string
    }
  }
}
