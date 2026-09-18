// app/api/chat/route.ts
import { NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/db/supabase-admin'
import { rerankChunks } from '@/lib/services/reranker'
import { stripPrefix } from '@/lib/utils/text'
import { generateAnswerStream, type ChatMessage } from '@/lib/services/chat-service'
import { hybridSearch, type HybridCandidate } from '@/lib/services/hybrid-service'
import { rewriteQuery } from '@/lib/services/query-rewriter'
import { multiHopSearch } from '@/lib/services/planner'
import { isComplexQuery } from '@/lib/services/router'
import { runReActAgent } from '@/lib/services/react-agent'
import { CONFIG } from '@/lib/config/constants'

export async function POST(request: NextRequest) {
  try {
    // 1. 接收问题 + sessionId
    const { question, sessionId } = await request.json() as {
      question?: string
      sessionId?: string
    }
    if (!question) {
      return new Response('问题不能为空', { status: 400 })
    }

    // 2. 从数据库读历史
    let history: ChatMessage[] = []
    if (sessionId) {
      const { data, error } = await supabaseAdmin
        .from('chat_messages')
        .select('role, content')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .limit(20)

      if (error) {
        console.error('读取历史失败:', error)
      } else {
        history = (data ?? []) as ChatMessage[]
      }
    }

    // 3. 存用户消息
    if (sessionId) {
      const { error: insertUserErr } = await supabaseAdmin
        .from('chat_messages')
        .insert({
          session_id: sessionId,
          role: 'user',
          content: question,
        })
      if (insertUserErr) {
        console.error('存用户消息失败:', insertUserErr)
      }
    }

    // 4. 查询改写
    const { standalone_question, keywords } = await rewriteQuery(question, history)

    // 5. 复杂度判断
    const isComplex = isComplexQuery(standalone_question)

    // ============================================================
    // 6. ReAct 分支
    // ============================================================
    if (CONFIG.ENABLE_REACT && isComplex) {
      const { answer, chunks } = await runReActAgent(standalone_question)

      // 6.1 存 AI 回答
      if (sessionId && answer) {
        const { error: insertErr } = await supabaseAdmin
          .from('chat_messages')
          .insert({
            session_id: sessionId,
            role: 'assistant',
            content: answer,
          })
        if (insertErr) {
          console.error('存 AI 回答失败（ReAct）:', insertErr)
        }
      }

      return streamTextResponse(answer, chunks)
    }

    // ============================================================
    // 7. 普通路径：检索 + 重排
    // ============================================================
    const candidates: HybridCandidate[] = isComplex
      ? await multiHopSearch(standalone_question, keywords)
      : await hybridSearch(standalone_question, keywords)

    const chunks = await rerankChunks(standalone_question, candidates)

    // ============================================================
    // 8. 空结果短路
    // ============================================================
    if (!chunks || chunks.length === 0) {
      const emptyAnswer = '知识库未找到相关内容'

      // 8.1 存 AI 回答（空结果也存，用户会看到）
      if (sessionId) {
        const { error: insertErr } = await supabaseAdmin
          .from('chat_messages')
          .insert({
            session_id: sessionId,
            role: 'assistant',
            content: emptyAnswer,
          })
        if (insertErr) {
          console.error('存空结果失败:', insertErr)
        }
      }

      return new Response(
        `data: ${JSON.stringify({ text: emptyAnswer })}\n\ndata: [DONE]\n\n`,
        { headers: sseHeaders() }
      )
    }

    // ============================================================
    // 9. 流式生成
    // ============================================================
    const stream = await generateAnswerStream(standalone_question, chunks, history)
    const encoder = new TextEncoder()

    const sseStream = new ReadableStream({
      async start(controller) {
        let fullAnswer = ''

        try {
          // 9.1 逐段推送 AI 文本
          for await (const text of stream) {
            fullAnswer += text
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text })}\n\n`)
            )
          }

          // 9.2 推送引用来源
          const sources = chunks.map((c) => ({
            document_title: c.document_title,
            content: stripPrefix(c.content),
            similarity: c.similarity ?? 0,
            hit_count: c.hit_count,
          }))
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ sources })}\n\n`)
          )

          // 9.3 结束标记
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))

          // 9.4 存 AI 回答
          if (sessionId && fullAnswer) {
            const { error: insertErr } = await supabaseAdmin
              .from('chat_messages')
              .insert({
                session_id: sessionId,
                role: 'assistant',
                content: fullAnswer,
                sources_json: sources,   // 如果建了这列
              })
            if (insertErr) {
              console.error('存 AI 回答失败:', insertErr)
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : '生成回答失败'
          console.error('流式生成失败:', err)
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`)
            )
          } catch {
            // 流已关闭
          }
        } finally {
          controller.close()
        }
      },
    })

    return new Response(sseStream, { headers: sseHeaders() })
  } catch (error) {
    console.error('问答接口失败:', error)
    return new Response(
      `data: ${JSON.stringify({
        error: error instanceof Error ? error.message : '问答失败',
      })}\n\ndata: [DONE]\n\n`,
      { headers: sseHeaders() }
    )
  }
}

// ============================================================
// SSE 响应头
// ============================================================
function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  }
}

// ============================================================
// ReAct 路径的流式包装
// ============================================================
async function streamTextResponse(
  answer: string,
  chunks: HybridCandidate[]
): Promise<Response> {
  const encoder = new TextEncoder()

  const sseStream = new ReadableStream({
    async start(controller) {
      try {
        // 按标点切，保底按 30 字
        const segments = answer.split(/(?<=[。！？\n])/).filter(Boolean)
        const pieces =
          segments.length > 1
            ? segments
            : Array.from({ length: Math.ceil(answer.length / 30) }, (_, i) =>
                answer.slice(i * 30, (i + 1) * 30)
              )

        for (const text of pieces) {
          if (!text) continue
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text })}\n\n`)
          )
          await new Promise((r) => setTimeout(r, 20))
        }

        // 去重 + 截断
        const seen = new Set<string>()
        const uniqueChunks = chunks
          .filter((c) => {
            if (seen.has(c.id)) return false
            seen.add(c.id)
            return true
          })
          .slice(0, 5)

        const sources = uniqueChunks.map((c) => ({
          document_title: c.document_title,
          content: stripPrefix(c.content),
          similarity: c.similarity ?? 0,
          hit_count: c.hit_count,
        }))
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ sources })}\n\n`)
        )

        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } catch (err) {
        console.error('ReAct 流式输出失败:', err)
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: '输出失败' })}\n\n`
            )
          )
        } catch {
          // 流已关闭
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(sseStream, { headers: sseHeaders() })
}