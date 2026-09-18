import 'server-only'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { CONFIG } from '@/lib/config/constants'
import type { HybridCandidate } from './hybrid-service'
import { withRetry } from '@/lib/utils/retry'
const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  throw new Error('GEMINI_API_KEY 未配置')
}
const genAI = new GoogleGenerativeAI(apiKey)

// 剥掉 content 里的【章节路径: ...】前缀
const stripPrefix = (content: string) =>
  content.replace(/^【章节路径: [^】]+】\n/, '')

export async function rerankChunks(
  question: string,
  candidates: HybridCandidate[],
  topK: number = CONFIG.RERANK_TOP_K
): Promise<HybridCandidate[]> {
  // 候选数本来就不够，直接返回
  if (candidates.length <= topK) return candidates

  try {
    const model = genAI.getGenerativeModel({ model: CONFIG.CHAT_MODEL })

    // 🔄 编号从 1 开始（LLM 更习惯），显示时去掉前缀
    const chunkList = candidates
      .map((c, i) => `[${i + 1}] ${stripPrefix(c.content).slice(0, 150)}`)
      .join('\n\n')

    const prompt = `你是检索结果重排器。根据用户问题，从以下文本块中选出最相关的 ${topK} 个。

只返回 JSON 数组，包含编号（从 1 开始），不要输出任何其他内容。
返回格式示例：[1, 4, 8]

用户问题：${question}

文本块：
${chunkList}`
    const result = await withRetry(
      () => model.generateContent(prompt),
      {
        retries: 1,
        timeoutMs: 8000,
        onRetry: (err, attempt) => {
          console.warn(`[reranker] 第 ${attempt} 次重试，原因:`, err)
        },
      }
    )
    const text = result.response.text().trim()

    // 🔄 解析：优先 JSON，失败则正则兜底
    let rawIndices: number[] = []
    try {
      const jsonStr = text.replace(/```json|```/g, '').trim()
      const parsed = JSON.parse(jsonStr)
      if (Array.isArray(parsed)) {
        rawIndices = parsed.map((n) => Number(n))
      }
    } catch {
      // JSON 解析失败，从文本里抽所有数字
      rawIndices = (text.match(/\d+/g) ?? []).map((s) => parseInt(s, 10))
    }

    // 🔄 1-based → 0-based，过滤越界
    const validIndices = rawIndices
      .map((n) => n - 1)
      .filter((n) => Number.isInteger(n) && n >= 0 && n < candidates.length)

    // 去重 + 取前 topK
    const seen = new Set<number>()
    const reranked: HybridCandidate[] = []
    for (const i of validIndices) {
      if (seen.has(i)) continue
      seen.add(i)
      reranked.push(candidates[i])
      if (reranked.length >= topK) break
    }

    // 🔄 数量不够，从原始候选里补齐（按原顺序）
    if (reranked.length < topK) {
      for (const c of candidates) {
        if (reranked.length >= topK) break
        if (!seen.has(candidates.indexOf(c))) {
          // 用 id 判断是否已经选过
          if (!reranked.some((r) => r.id === c.id)) {
            reranked.push(c)
          }
        }
      }
    }

    return reranked
  } catch (error) {
    console.error('重排失败，降级为原始顺序:', error)
    return candidates.slice(0, topK)
  }
}