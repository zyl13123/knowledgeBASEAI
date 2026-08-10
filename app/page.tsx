'use client'
import { useEffect, useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  Sparkles,
  CheckCircle2,
  FileText,
  Library,
  Loader2,
  MessageSquare,
  Send,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'
import { UploadZone } from '@/components/document/UploadZone'

interface DocumentItem {
  id: string
  title: string
  file_type: string
  chunk_count: number
  status: string
  created_at: string
}

// 引用来源：一条回答的证据
interface SourceItem {
  document_title: string
  content: string
  similarity: number
  hit_count?: number | null
}

// 消息结构：谁说的 + 内容 + 这条消息自己的引用
interface Message {
  role: 'user' | 'assistant'
  content: string
  sources?: SourceItem[]   // AI 回答引用的来源（绑定到消息，翻旧账不丢）
}

export default function Home() {
  // ===== 聊天状态 =====
  const [messages, setMessages] = useState<Message[]>([])   // 全部聊天记录
  const [question, setQuestion] = useState('')              // 输入框
  const [asking, setAsking] = useState(false)               // 是否在等 AI
  const [expandedMsg, setExpandedMsg] = useState<number | null>(null)  // 哪条消息的引用展开着（记录消息下标）
  const bottomRef = useRef<HTMLDivElement>(null)            // 滚动到底部用
  const chatScrollRef = useRef<HTMLDivElement>(null)        // 聊天区容器

  // 文档列表
  const [documents, setDocuments] = useState<DocumentItem[]>([])
  const [loadingDocs, setLoadingDocs] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // 插入测试文本
  const [seedTitle, setSeedTitle] = useState('')
  const [seedText, setSeedText] = useState('')
  const [seeding, setSeeding] = useState(false)
  const [seedResult, setSeedResult] = useState('')
  const [showSeed, setShowSeed] = useState(false)

  // 新消息来了自动滚到底部
  useEffect(() => {
    chatScrollRef.current?.scrollTo({
      top: chatScrollRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages, asking])

  // 加载文档列表（自动轮询：有 processing 状态的文档时，每 3 秒刷新一次）
  async function loadDocuments() {
    try {
      const res = await fetch('/api/documents')
      const data = await res.json()
      if (res.ok) {
        const docs = data.documents || []
        setDocuments(docs)
        // 如果还有文档在处理中，3 秒后再查一次
        const hasProcessing = docs.some((doc: DocumentItem) => doc.status === 'processing')
        if (hasProcessing) {
          setTimeout(() => loadDocuments(), 3000)
        }
      }
    } catch (err) {
      console.error('加载文档列表失败', err)
    } finally {
      setLoadingDocs(false)
    }
  }

  useEffect(() => {
    loadDocuments()
  }, [])

  // 插入测试文本到知识库
  async function handleSeed() {
    if (!seedTitle || !seedText) return
    setSeeding(true)
    setSeedResult('')
    try {
      const res = await fetch('/api/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: seedTitle, text: seedText }),
      })
      const data = await res.json()
      if (res.ok) {
        setSeedResult('✅ 文本已插入知识库！')
        setSeedTitle('')
        setSeedText('')
        loadDocuments()
      } else {
        setSeedResult('❌ ' + data.error)
      }
    } catch (err) {
      setSeedResult('❌ ' + (err instanceof Error ? err.message : '请求失败'))
    }
    setSeeding(false)
  }

  // 删除文档
  async function handleDelete(id: string) {
    if (!confirm('确定删除这个文档吗？它的所有文本块也会被删除。')) return
    setDeletingId(id)
    try {
      const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' })
      if (res.ok) loadDocuments()
      else alert('删除失败')
    } catch (err) {
      alert('删除失败: ' + (err instanceof Error ? err.message : '网络错误'))
    } finally {
      setDeletingId(null)
    }
  }

  // ===== 流式多轮提问 =====
  async function handleAsk() {
    if (!question || asking) return
    const userMsg = question
    setQuestion('')
    setAsking(true)

    // 1. 先把用户消息加进列表
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }])
    // 2. 加一条空白的 AI 消息，等会逐字填充（打字机效果）
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }])

    try {
      // 3. 带历史一起发（messages 是发之前的，正好是"过去的对话"）
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: userMsg, history: messages }),
      })
      if (!res.ok || !res.body) throw new Error('请求失败')

      // 4. 流式读取：reader 像水龙头，一段段读
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE 事件以空行 \n\n 分隔，逐个解析
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''   // 最后一段可能不完整，留到下次

        for (const event of events) {
          if (!event.startsWith('data: ')) continue
          const payload = event.slice(6)          // 去掉 "data: " 前缀
          if (payload === '[DONE]') continue      // 结束标记

          const data = JSON.parse(payload)
          if (data.text) {
            // 5. 把新文本拼到最后一条 AI 消息上 → 打字机效果
            setMessages((prev) => {
              const copy = [...prev]
              const last = copy[copy.length - 1]
              copy[copy.length - 1] = { ...last, content: last.content + data.text }
              return copy
            })
          }
          if (data.sources) {
            // 引用来源：绑定到当前这条 AI 消息（sources 在回答结束后单独推送）
            setMessages((prev) => {
              const copy = [...prev]
              const last = copy[copy.length - 1]
              copy[copy.length - 1] = { ...last, sources: data.sources }
              return copy
            })
          }
          if (data.error) {                            // 错误信息
            setMessages((prev) => {
              const copy = [...prev]
              const last = copy[copy.length - 1]
              copy[copy.length - 1] = { ...last, content: last.content + '❌ ' + data.error }
              return copy
            })
          }
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const copy = [...prev]
        const last = copy[copy.length - 1]
        copy[copy.length - 1] = {
          ...last,
          content: '❌ ' + (err instanceof Error ? err.message : '请求失败'),
        }
        return copy
      })
    } finally {
      setAsking(false)
    }
  }

  // 文档状态徽标
  function StatusBadge({ doc }: { doc: DocumentItem }) {
    if (doc.status === 'completed') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 text-xs font-medium">
          <CheckCircle2 className="w-3 h-3" />
          完成
        </span>
      )
    }
    if (doc.status === 'processing') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 text-xs font-medium">
          <Loader2 className="w-3 h-3 animate-spin" />
          处理中
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-600 text-xs font-medium">
        <XCircle className="w-3 h-3" />
        失败
      </span>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-neutral-50 text-neutral-900">
      {/* ===== 顶栏 ===== */}
      <header className="h-14 shrink-0 border-b border-neutral-200 bg-white/80 backdrop-blur flex items-center px-6">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-neutral-900 flex items-center justify-center">
            <Library className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold leading-none">KnowledgeBase AI</h1>
            <p className="text-[11px] text-neutral-400 mt-0.5">懒大王知识库问答系统</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-neutral-100 text-neutral-500 text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            已连接
          </span>
          <span className="text-xs text-neutral-400">{documents.length} 个文档</span>
        </div>
      </header>

      {/* ===== 主体：左知识库 + 右聊天 ===== */}
      <div className="flex-1 flex overflow-hidden">
        {/* -------- 左栏：知识库 -------- */}
        <aside className="w-80 shrink-0 border-r border-neutral-200 bg-white flex flex-col overflow-hidden">
          {/* 上传区 */}
          <div className="p-4 border-b border-neutral-100">
            <div className="p-5 rounded-xl border-2 border-dashed border-neutral-200 hover:border-neutral-400 hover:bg-neutral-50 transition-colors">
              <UploadZone onUploaded={loadDocuments} />
            </div>
          </div>

          {/* 插入文本（折叠） */}
          <div className="border-b border-neutral-100">
            <button
              onClick={() => setShowSeed(!showSeed)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm text-neutral-500 hover:bg-neutral-50 transition-colors"
            >
              <span className="flex items-center gap-1.5 font-medium">
                <FileText className="w-3.5 h-3.5" />
                插入测试文本
              </span>
              <span className="text-neutral-300 text-xs">{showSeed ? '▲' : '▼'}</span>
            </button>
            {showSeed && (
              <div className="px-4 pb-4 space-y-2.5">
                <input
                  className="w-full px-3 py-2 rounded-lg border border-neutral-200 text-sm placeholder:text-neutral-400 focus:outline-none focus:border-neutral-400 transition-colors"
                  placeholder="文档标题（如：杨立昆世界模型）"
                  value={seedTitle}
                  onChange={(e) => setSeedTitle(e.target.value)}
                />
                <textarea
                  className="w-full px-3 py-2 rounded-lg border border-neutral-200 text-sm placeholder:text-neutral-400 focus:outline-none focus:border-neutral-400 transition-colors resize-none h-24"
                  placeholder="文档内容（如：世界模型架构？：1.核心算法？ 2.思想？ 3.目标？...）"
                  value={seedText}
                  onChange={(e) => setSeedText(e.target.value)}
                />
                <div className="flex items-center gap-3">
                  <button
                    className="px-4 py-2 rounded-lg bg-neutral-900 text-white text-xs font-medium hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    onClick={handleSeed}
                    disabled={seeding || !seedTitle || !seedText}
                  >
                    {seeding ? '插入中...' : '插入知识库'}
                  </button>
                  {seedResult && (
                    <span
                      className={`text-xs ${
                        seedResult.startsWith('✅') ? 'text-emerald-600' : 'text-red-600'
                      }`}
                    >
                      {seedResult.replace(/^[✅❌]\s*/, '')}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 文档列表 */}
          <div className="flex-1 overflow-y-auto p-4">
            <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              知识库文档
            </h2>
            {loadingDocs ? (
              <div className="flex items-center gap-2 py-4 text-sm text-neutral-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                加载中...
              </div>
            ) : documents.length === 0 ? (
              <p className="py-4 text-sm text-neutral-400">还没有文档，上传一个试试</p>
            ) : (
              <div className="space-y-2">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="group flex items-center gap-2.5 p-3 rounded-lg border border-neutral-100 hover:border-neutral-200 hover:bg-neutral-50 transition-colors"
                  >
                    <div className="w-8 h-8 rounded-md bg-neutral-100 flex items-center justify-center shrink-0">
                      <FileText className="w-4 h-4 text-neutral-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-neutral-700 truncate">{doc.title}</p>
                      <p className="text-xs text-neutral-400 mt-0.5">
                        {doc.chunk_count ?? 0} 块 · {doc.file_type}
                      </p>
                    </div>
                    <StatusBadge doc={doc} />
                    <button
                      onClick={() => handleDelete(doc.id)}
                      disabled={deletingId === doc.id}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-neutral-400 hover:text-red-500 hover:bg-red-50 transition-all disabled:opacity-30"
                      title="删除文档"
                    >
                      {deletingId === doc.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* -------- 右栏：聊天 -------- */}
        <main className="flex-1 flex flex-col overflow-hidden bg-white">
          {/* 聊天头部 */}
          <div className="shrink-0 px-8 py-4 border-b border-neutral-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-800 flex items-center gap-2">
              <span className="w-6 h-6 rounded-lg bg-neutral-100 flex items-center justify-center">
                <MessageSquare className="w-3.5 h-3.5 text-neutral-500" />
              </span>
              对话
            </h2>
            <span className="text-xs text-neutral-400">{documents.length} 个文档</span>
          </div>

          {/* 消息区 */}
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto">
            <div className="max-w-5xl mx-auto px-8 py-10 space-y-8">
              {messages.length === 0 && (
                <div className="text-center pt-28">
                  <div className="w-16 h-16 mx-auto rounded-2xl bg-neutral-100 flex items-center justify-center mb-6">
                    <Sparkles className="w-8 h-8 text-neutral-600" />
                  </div>
                  <h3 className="text-xl font-semibold text-neutral-900">开始你的知识库对话</h3>
                  <p className="text-[15px] text-neutral-500 mt-3 max-w-md mx-auto leading-7">
                    上传文档后，向我提问。AI 会从你的知识库中检索答案
                  </p>
                  <div className="flex flex-wrap justify-center gap-2.5 mt-8">
                    {['RAG AGENT 是什么？', '知识库有哪些内容？'].map((s) => (
                      <button
                        key={s}
                        onClick={() => setQuestion(s)}
                        className="px-5 py-2.5 rounded-full border border-neutral-200 bg-white text-sm text-neutral-600 hover:border-neutral-400 hover:text-neutral-900 transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : ''}`}>
                  {/* AI 消息：纯文本 + 头像（无边框卡片，GPT 风格） */}
                  {msg.role === 'assistant' && (
                    <div className="flex gap-4 w-full">
                      <div className="w-9 h-9 rounded-full bg-neutral-900 flex items-center justify-center shrink-0 mt-1">
                        <Sparkles className="w-4.5 h-4.5 text-white" />
                      </div>
                      <div className="flex-1 min-w-0 pt-0.5">
                        <div className="prose-md text-neutral-800 text-base leading-7">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                        {/* 这条消息自己的引用来源：摘要行 + 点击展开 */}
                        {msg.sources && msg.sources.length > 0 && (
                          <div className="mt-3">
                            <button
                              onClick={() => setExpandedMsg(expandedMsg === i ? null : i)}
                              className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-600 transition-colors"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              引用 {msg.sources.length} 篇
                              <span className="text-neutral-300">
                                {expandedMsg === i ? '▲' : '▼'}
                              </span>
                            </button>
                            {expandedMsg === i && (
                              <div className="mt-2 space-y-2">
                                {msg.sources.map((s, j) => (
                                  <div
                                    key={j}
                                    className="p-3 rounded-xl bg-neutral-50 border border-neutral-100"
                                  >
                                    <div className="flex items-center justify-between mb-1.5">
                                      <span className="text-sm font-medium text-neutral-700 truncate">
                                        <span className="text-neutral-900 font-semibold">[{j + 1}]</span>{' '}
                                        {s.document_title}
                                      </span>
                                      <span className="text-xs text-neutral-400 shrink-0 ml-2">
                                        {(s.similarity * 100).toFixed(0)}%
                                        {s.hit_count ? ` · 命中${s.hit_count}词` : ''}
                                      </span>
                                    </div>
                                    <p className="text-xs text-neutral-500 leading-5">{s.content}</p>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {/* 用户消息：唯一的实体气泡，浅灰圆角靠右 */}
                  {msg.role === 'user' && (
                    <div className="max-w-[75%] px-5 py-3 bg-neutral-100 text-neutral-900 text-base leading-7 whitespace-pre-wrap rounded-[1.4rem] rounded-br-lg">
                      {msg.content}
                    </div>
                  )}
                </div>
              ))}

              {asking && (
                <div className="flex gap-4">
                  <div className="w-9 h-9 rounded-full bg-neutral-900 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4.5 h-4.5 text-white" />
                  </div>
                  <div className="flex items-center gap-1.5 pt-3">
                    <span className="w-1.5 h-1.5 rounded-full bg-neutral-300 animate-bounce" />
                    <span className="w-1.5 h-1.5 rounded-full bg-neutral-300 animate-bounce [animation-delay:0.15s]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-neutral-300 animate-bounce [animation-delay:0.3s]" />
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* 输入区 */}
          <div className="shrink-0 px-8 py-4">
            <div className="max-w-5xl mx-auto">
              <div className="flex gap-2.5 items-end rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-2.5 focus-within:border-neutral-400 transition-colors">
                <textarea
                  className="flex-1 px-1 py-1.5 bg-transparent text-base placeholder:text-neutral-400 focus:outline-none resize-none max-h-40"
                  placeholder="输入问题，Enter 发送，Shift+Enter 换行"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleAsk()
                    }
                  }}
                  rows={1}
                />
                <button
                  onClick={handleAsk}
                  disabled={asking || !question.trim()}
                  className="px-4 py-2 rounded-xl bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 shrink-0"
                >
                  {asking ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      发送
                    </>
                  )}
                </button>
              </div>
              <p className="text-xs text-neutral-400 mt-3 text-center">
                AI 生成的回答可能不准确，请结合引用来源核实
              </p>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
