import { generateEmbedding } from './embedding-service'
import { searchSimilarChunks } from './vector-service'
import { searchByKeywords, type KeywordHit } from './keyword-search'
import { CONFIG } from '@/lib/config/constants'

// ===== 统一候选块结构（两个通道的输出合并成同一种形状）=====
export interface HybridCandidate {
  id: string
  content: string
  document_title: string
  similarity: number | null  // 向量通道的相似度（关键词通道来的块为 null）
  hit_count: number | null   // 关键词通道命中数（向量通道来的块为 null）
}

// ===== RRF 融合公式 =====
// 原理：不看分数只看排名。某块在通道 A 排第 x 名、通道 B 排第 y 名，
// 则 rrf = 1/(60+x) + 1/(60+y)。两个通道都上榜的块分数天然更高 → 交叉验证
function rrf(ranks: number[], k: number = CONFIG.RRF_K): number {
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0)
}

// ===== 混合检索主入口 =====
export async function hybridSearch(
  question: string,
  keywords: string[]
): Promise<HybridCandidate[]> {
  // ① 向量通道：问题 → embedding → 粗召回 CANDIDATE_POOL 个
  const embedding = await generateEmbedding(question)
  const vectorResults = await searchSimilarChunks(embedding, CONFIG.CANDIDATE_POOL)

  // ② 关键词通道：ILIKE 匹配 → 同样取 CANDIDATE_POOL 个
  const keywordResults = keywords.length ? await searchByKeywords(keywords) : []

  // ③ RRF 融合：用 Map 按块 id 聚合，记录每块在哪些通道拿了什么名次
  // Map 的 key 是块 id，value 是块信息 + 名次数组
  const pool = new Map<string, HybridCandidate & { ranks: number[] }>()

  vectorResults.forEach((r: any, i: number) => {
    const key = r.id
    if (!pool.has(key)) {
      pool.set(key, {
        id: r.id, content: r.content, document_title: r.document_title,
        similarity: r.similarity, hit_count: null, ranks: [],
      })
    }
    pool.get(key)!.ranks.push(i + 1)  // 记录向量通道名次（从 1 开始）
  })

  keywordResults.forEach((r: KeywordHit, i: number) => {
    const key = r.id
    if (!pool.has(key)) {
      pool.set(key, {
        id: r.id, content: r.content, document_title: r.document_title,
        similarity: null, hit_count: r.hit_count, ranks: [],
      })
    }
    pool.get(key)!.hit_count = r.hit_count
    pool.get(key)!.ranks.push(i + 1)  // 记录关键词通道名次
  })

  // ④ 算 RRF 分数 → 排序 → 取前 CANDIDATE_POOL
  const fused = [...pool.values()]
    .map((c) => ({ ...c, rrf_score: rrf(c.ranks) }))
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, CONFIG.CANDIDATE_POOL)

  // ⑤ 去掉内部用的 ranks 字段，只留对外有用的
  return fused.map(({ ranks, ...rest }) => rest)
}
