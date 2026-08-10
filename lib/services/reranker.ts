import { GoogleGenerativeAI } from '@google/generative-ai'
import { CONFIG } from '@/lib/config/constants'
import type { HybridCandidate } from './hybrid-service'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

// 重排：从候选池里挑出跟问题最相关的 topK 个块
export async function rerankChunks(
  question: string,
  candidates: HybridCandidate[],
  topK: number = CONFIG.RERANK_TOP_K
): Promise<HybridCandidate[]> {
  // 候选数本来就不够，直接返回
  if (candidates.length <= topK) return candidates

  try {
    const model = genAI.getGenerativeModel({ model: CONFIG.CHAT_MODEL })

    // 把每个块编号 [0]~[19]，截取前 150 字（够判断相关性，省 token）
    const chunkList = candidates
      .map((c, i) => `[${i}] ${c.content.slice(0, 150)}`)
      .join('\n\n')

    const prompt = `你是检索结果重排器。根据用户问题，从以下文本块中选出最相关的 ${topK} 个。
只返回编号，用逗号分隔，不要输出其他内容。

用户问题：${question}

文本块：
${chunkList}

返回格式示例：0,3,7`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()

    // 解析 "0,3,7" → [0, 3, 7]
    const indices = text
      .split(/[,，\s]+/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n >= 0 && n < candidates.length)

    // 按编号取完整块（注意去重：同一个编号可能出现两次）
    const seen = new Set<number>()
    const reranked = indices
      .filter((i) => {
        if (seen.has(i)) return false
        seen.add(i)
        return true
      })
      .slice(0, topK)
      .map((i) => candidates[i])

    // 兜底：LLM 返回了无效编号，就用原始顺序前 topK 个
    return reranked.length > 0 ? reranked : candidates.slice(0, topK)
  } catch (error) {
    console.error('重排失败，降级为原始顺序:', error)
    return candidates.slice(0, topK)
  }
}
 