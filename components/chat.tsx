// components/chat.tsx（或你现有的聊天组件）
'use client'

import { useState, useEffect } from 'react'

export default function Chat() {
  const [sessionId, setSessionId] = useState<string>('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')

  // ① 挂载时：读或创建 session_id
  useEffect(() => {
    let id = localStorage.getItem('chat_session_id')
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem('chat_session_id', id)
    }
    setSessionId(id)
  }, [])

  // ② session_id 就绪后：从后端加载历史
  useEffect(() => {
    if (!sessionId) return
    fetch(`/api/chat/history?sessionId=${sessionId}`)
      .then((r) => r.json())
      .then((data) => setMessages(data.messages ?? []))
      .catch((err) => console.error('加载历史失败:', err))
  }, [sessionId])

  // ③ 发消息
  async function send() {
    if (!input.trim() || !sessionId) return

    const userMsg = input.trim()
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }])

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: userMsg,
        sessionId,   // 🆕 只传 sessionId，不传 history
      }),
    })

    // ... 流式读取（你现有的逻辑）
  }

  // ... 渲染
}