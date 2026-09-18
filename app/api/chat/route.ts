import { NextRequest } from 'next/server'
import { rerankChunks } from '@/lib/services/reranker'
import { stripPrefix } from '@/lib/utils/text'   // 🆕 抽出共享
import { generateAnswerStream, type ChatMessage } from '@/lib/services/chat-service'
import { HybridCandidate, hybridSearch } from '@/lib/services/hybrid-service'
import { rewriteQuery } from '@/lib/services/query-rewriter'
import { multiHopSearch } from '@/lib/services/planner'
import { isComplexQuery } from '@/lib/services/router'
import { runReActAgent } from '@/lib/services/react-agent'
import { CONFIG } from '@/lib/config/constants'

export async function POST(request: NextRequest) {
  try {
    // 1. 接收问题 + 多轮历史（前端传来）
    const { question, history = [] } = await request.json() as {
      question?: string
      history?: ChatMessage[]
    }
    if (!question) {
      return new Response('问题不能为空', { status: 400 })
    }
  
    
    const { standalone_question, keywords } = await rewriteQuery(question, history)

// 3. 判断是否是复杂问题
    const isComplex = isComplexQuery(standalone_question)

    let candidates: HybridCandidate[]
    if (CONFIG.ENABLE_REACT && isComplex) {
  // 🆕 ReAct 路径
      const { answer, chunks } = await runReActAgent(standalone_question)
      return streamTextResponse(answer, chunks)
    } else {
      // 现有路径
      candidates = isComplex? await multiHopSearch(standalone_question, keywords): await hybridSearch(standalone_question, keywords)
    }


    // 4. 重排
    const chunks = await rerankChunks(standalone_question, candidates)





    // 3. 没搜到相关内容，直接返回提示
    if (!chunks || chunks.length === 0) {
      return new Response(
        `data: ${JSON.stringify({ text: '知识库未找到相关内容' })}\n\ndata: [DONE]\n\n`,
        { headers: sseHeaders() }
      )
    }
  

    // 4. 流式生成回答
    const stream = await generateAnswerStream(question, chunks, history)
    const encoder = new TextEncoder()

    // 5. 把 Gemini 的流包装成 SSE 流，逐段推给前端
    const sseStream = new ReadableStream({
      async start(controller) {
        try {
          // 5.1 逐段推送 AI 生成的文本
          for await (const text of stream) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`))
          }
          // 5.2 推送引用来源（回答完才发）
          const sources = chunks.map((c: any) => ({
            document_title: c.document_title,
            content: c.content,
            similarity: c.similarity ?? 0,   // null 兜底为 0，前端算百分比不会 NaN
            hit_count: c.hit_count,          // 新增：关键词命中数（向量块为 null，前端可选择性展示）
          }))

          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sources })}\n\n`))
          // 5.3 结束标记
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        } catch (err) {
          const message = err instanceof Error ? err.message : '生成回答失败'
          console.error('流式生成失败:', err)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`))
        } finally {
          controller.close()
        }
      },
    })

    return new Response(sseStream, { headers: sseHeaders() })
  } catch (error) {
    console.error('问答接口失败:', error)
    return new Response(
      `data: ${JSON.stringify({ error: error instanceof Error ? error.message : '问答失败' })}\n\ndata: [DONE]\n\n`,
      { headers: sseHeaders() }
    )
  }
}

// SSE 响应头：告诉浏览器这是"服务器推送"流
function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  }
}







async function streamTextResponse(
  answer: string,
  chunks: HybridCandidate[]
): Response {
  const encoder = new TextEncoder()

  const sseStream = new ReadableStream({
    async start(controller) {   // 🆕 async
      try {
        // 按标点切（更自然），保底按 30 字
        const segments = answer.split(/(?<=[。！？\n])/).filter(Boolean)
        const pieces = segments.length > 1
          ? segments
          : Array.from({ length: Math.ceil(answer.length / 30) }, (_, i) =>
              answer.slice(i * 30, (i + 1) * 30)
            )

        for (const text of pieces) {
          if (!text) continue
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text })}\n\n`)
          )
          // 🆕 模拟流式延迟
          await new Promise((r) => setTimeout(r, 20))
        }

        // 去重 + 截断
        const seen = new Set<string>()
        const uniqueChunks = chunks.filter((c) => {
          if (seen.has(c.id)) return false
          seen.add(c.id)
          return true
        }).slice(0, 5)

        const sources = uniqueChunks.map((c) => ({
          document_title: c.document_title,
          content: stripPrefix(c.content),   // 🆕 复用工具
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
            encoder.encode(`data: ${JSON.stringify({ error: '输出失败' })}\n\n`)
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