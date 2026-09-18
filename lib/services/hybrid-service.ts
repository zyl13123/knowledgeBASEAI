// lib/services/hybrid-service.ts
import 'server-only'
import { generateEmbedding } from './embedding-service'
import { searchSimilarChunks } from './vector-service'
import { searchByKeywords, type KeywordHit } from './keyword-search'
import { CONFIG } from '@/lib/config/constants'

export interface HybridCandidate {
  id: string
  content: string
  document_title: string
  similarity: number | null
  hit_count: number | null
}

// ===== RRF 融合公式 =====
function rrf(ranks: number[], k: number = CONFIG.RRF_K): number {
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0)
}

// 剥掉【章节路径: ...】前缀，用于调试预览
function stripPrefix(content: string): string {
  return content.replace(/^【章节路径: [^】]+】\n/, '')
}

// ============================================================
// 内部核心：执行检索 + RRF 融合，返回所有中间数据
// 生产函数和调试函数都调它
// ============================================================
async function runHybridSearch(question: string, keywords: string[]) {
  // ① 向量通道
  const embedding = await generateEmbedding(question)
  const vectorResults = await searchSimilarChunks(embedding, CONFIG.CANDIDATE_POOL)

  // ② 关键词通道
  const keywordResults: KeywordHit[] = keywords.length
    ? await searchByKeywords(keywords)
    : []

  // ③ RRF 融合
  const pool = new Map<string, HybridCandidate & { ranks: number[] }>()

  vectorResults.forEach((r: any, i: number) => {
    const key = r.id
    if (!pool.has(key)) {
      pool.set(key, {
        id: r.id,
        content: r.content,
        document_title: r.document_title,
        similarity: r.similarity,
        hit_count: null,
        ranks: [],
      })
    }
    pool.get(key)!.ranks.push(i + 1)
  })

  keywordResults.forEach((r, i) => {
    const key = r.id
    if (!pool.has(key)) {
      pool.set(key, {
        id: r.id,
        content: r.content,
        document_title: r.document_title,
        similarity: null,
        hit_count: r.hit_count,
        ranks: [],
      })
    }
    pool.get(key)!.hit_count = r.hit_count
    pool.get(key)!.ranks.push(i + 1)
  })

  const fused = [...pool.values()]
    .map((c) => ({ ...c, rrf_score: rrf(c.ranks) }))
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, CONFIG.CANDIDATE_POOL)

  return { vectorResults, keywordResults, fused }
}

// ============================================================
// 生产用：只返回最终候选
// ============================================================
export async function hybridSearch(
  question: string,
  keywords: string[]
): Promise<HybridCandidate[]> {
  const { fused } = await runHybridSearch(question, keywords)
  return fused.map(({ ranks, ...rest }) => rest)
}

// ============================================================
// 调试用：暴露完整中间过程 + 最终候选
// ============================================================
export interface HybridSearchDebugResult {
  vector_results: Array<{
    id: string
    similarity: number
    document_title: string
    preview: string
  }>
  keyword_results: Array<{
    id: string
    hit_count: number
    document_title: string
    preview: string
  }>
  rrf_results: Array<{
    id: string
    rrf_score: number
    similarity: number | null
    hit_count: number | null
    document_title: string
    preview: string
  }>
  candidates: HybridCandidate[]  // 完整候选，供 debug 路由继续跑 rerank
}

export async function hybridSearchDebug(
  question: string,
  keywords: string[]
): Promise<HybridSearchDebugResult> {
  const { vectorResults, keywordResults, fused } = await runHybridSearch(question, keywords)

  const preview = (c: string) => stripPrefix(c).slice(0, 100)

  return {
    vector_results: vectorResults.slice(0, 20).map((r: any) => ({
      id: r.id,
      similarity: r.similarity,
      document_title: r.document_title,
      preview: preview(r.content),
    })),
    keyword_results: keywordResults.slice(0, 20).map((r) => ({
      id: r.id,
      hit_count: r.hit_count,
      document_title: r.document_title,
      preview: preview(r.content),
    })),
    rrf_results: fused.slice(0, 20).map((c) => ({
      id: c.id,
      rrf_score: c.rrf_score,
      similarity: c.similarity,
      hit_count: c.hit_count,
      document_title: c.document_title,
      preview: preview(c.content),
    })),
    candidates: fused.map(({ ranks, ...rest }) => rest),
  }
}