import { GoogleGenerativeAI } from '@google/generative-ai'
import { CONFIG } from '@/lib/config/constants'
import { hybridSearch, type HybridCandidate } from './hybrid-service'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

// 拆出来的子问题结构
interface SubQuery {
  question: string
  keywords: string[]
}

// ===== 主入口 =====
export async function multiHopSearch(
  question: string,
  keywords: string[]
): Promise<HybridCandidate[]> {

  // ① 拆子问题
  const subQueries = await decomposeQuery(question)

  // 如果 LLM 说"这问题不用拆"（只返回 1 个），直接走单跳
  if (subQueries.length <= 1) {
    return hybridSearch(question, keywords)
  }

  // ② 并行检索：每个子问题独立走 hybridSearch
  const resultsPerSub = await Promise.all(
    subQueries.map((sq) => hybridSearch(sq.question, sq.keywords))
  )

  // ③ 合并去重（按块 id 去重，同一块只留一份）
  const seen = new Set<string>()
  const merged: HybridCandidate[] = []

  for (const results of resultsPerSub) {
    for (const chunk of results) {
      if (!seen.has(chunk.id)) {
        seen.add(chunk.id)
        merged.push(chunk)
      }
    }
  }

  return merged
}

// ===== 拆子问题：调 LLM =====
async function decomposeQuery(question: string): Promise<SubQuery[]> {
  try {
    const model = genAI.getGenerativeModel({ model: CONFIG.CHAT_MODEL })

    const prompt = `你是查询分解器。把用户的复杂问题拆成多个独立的子问题，每个子问题只关注一个主题。

用户问题：${question}

规则：
1. 最多拆成 ${CONFIG.PLANNER_MAX_SUBQUERIES} 个子问题
2. 如果问题本身只关注一个主题，就只返回 1 个
3. 每个子问题配 2~4 个关键词

只输出 JSON，不要其他内容：
[
  {"question": "子问题1", "keywords": ["关键词1", "关键词2"]},
  {"question": "子问题2", "keywords": ["关键词1", "关键词2"]}
]`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()
    
    // 去掉可能的 markdown 代码块
    const jsonStr = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '')
    const parsed = JSON.parse(jsonStr) as SubQuery[]
    console.log(parsed)
    return parsed.slice(0, CONFIG.PLANNER_MAX_SUBQUERIES)
  } catch (error) {
    // LLM 失败 → 不拆，返回原始问题
    console.error('查询分解失败，降级为单跳:', error)
    return [{ question, keywords: [] }]
  }
}
