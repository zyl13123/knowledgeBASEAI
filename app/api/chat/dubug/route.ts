// app/api/chat/debug/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { rewriteQuery } from '@/lib/services/query-rewriter'
import { isComplexQuery } from '@/lib/services/router'
import { hybridSearchDebug } from '@/lib/services/hybrid-service'
import { multiHopSearch } from '@/lib/services/planner'
import { rerankChunks } from '@/lib/services/reranker'
import type { HybridCandidate } from '@/lib/services/hybrid-service'

function stripPrefix(content: string): string {
  return content.replace(/^【章节路径: [^】]+】\n/, '')
}

export async function POST(req: NextRequest) {
  // 🔒 生产环境必须带 token
  if (process.env.NODE_ENV === 'production') {
    const token = req.headers.get('x-debug-token')
    if (!token || token !== process.env.DEBUG_TOKEN) {
      return NextResponse.json({ error: 'Not Found' }, { status: 404 })
    }
  }

  // 解析 body
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { question, history = [], debug = {} } = body
  if (!question || typeof question !== 'string') {
    return NextResponse.json({ error: 'question 必填' }, { status: 400 })
  }

  const timings: Record<string, number> = {}
  const topK: number = debug.topK ?? 3

  try {
    // ① 改写
    const t0 = Date.now()
    const { standalone_question, keywords } = await rewriteQuery(question, history)
    timings.rewrite = Date.now() - t0

    // ② 判断复杂度（可通过 debug.forceMultiHop 强制）
    const isComplex = debug.forceMultiHop ?? isComplexQuery(standalone_question)

    // ③ 检索
    const t1 = Date.now()
    let candidates: HybridCandidate[]
    let searchDebug: any = { mode: isComplex ? 'multiHop' : 'hybrid' }

    if (isComplex) {
      candidates = await multiHopSearch(standalone_question, keywords)
      searchDebug.candidates_count = candidates.length
      searchDebug.note = '多跳检索不暴露分通道中间结果'
    } else {
      const debugResult = await hybridSearchDebug(standalone_question, keywords)
      candidates = debugResult.candidates
      searchDebug = {
        mode: 'hybrid',
        vector_results: debugResult.vector_results,
        keyword_results: debugResult.keyword_results,
        rrf_results: debugResult.rrf_results,
        candidates_count: candidates.length,
      }
    }
    timings.search = Date.now() - t1

    // ④ 重排
    const t2 = Date.now()
    const reranked = debug.skipRerank
      ? candidates.slice(0, topK)
      : await rerankChunks(standalone_question, candidates, topK)
    timings.rerank = Date.now() - t2

    // ⑤ 返回完整调试信息
    return NextResponse.json({
      question,
      standalone_question,
      keywords,
      is_complex: isComplex,
      search: searchDebug,
      rerank_top: reranked.map((c) => ({
        chunk_id: c.id,
        document_title: c.document_title,
        preview: stripPrefix(c.content).slice(0, 200),
        similarity: c.similarity,
        hit_count: c.hit_count,
      })),
      timings_ms: timings,
    })
  } catch (error) {
    console.error('调试接口失败:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '调试失败' },
      { status: 500 }
    )
  }
}
/**
 * 
 * {
  "question": "那它需要哪些材料？",
  "history": [
    { "role": "user", "content": "什么是报销流程？" },
    { "role": "assistant", "content": "报销流程是..." }
  ],
  "debug": {
    "topK": 5,
    "skipRerank": false,
    "forceMultiHop": false
  }
}
 */

/** 
 * curl.exe -X POST http://localhost:3000/api/chat/debug `
  -H "Content-Type: application/json" `
  -d '{\"question\":\"报销流程是什么\"}'*/