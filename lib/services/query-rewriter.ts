import { GoogleGenerativeAI } from '@google/generative-ai'
import { CONFIG } from '@/lib/config/constants'
import type { ChatMessage } from './chat-service'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

export interface RewrittenQuery {
  standalone_question: string
  keywords: string[]
}

export async function rewriteQuery(
  question: string,
  history: ChatMessage[] = []
): Promise<RewrittenQuery> {

  // 取最近 N 轮历史，拼成文本
  const recentHistory = history.slice(-CONFIG.REWRITE_HISTORY_TURNS)
  const historyText = recentHistory
    .map((h) => `${h.role === 'user' ? '用户' : '助手'}：${h.content}`)
    .join('\n')

  // 没有历史不需要改写，直接标点切词
  if (!historyText) {
    return {
      standalone_question: question,
      keywords: extractKeywordsFallback(question),
    }
  }

  try {
    const model = genAI.getGenerativeModel({ model: CONFIG.CHAT_MODEL })

    const prompt = `你是检索查询改写器。根据对话历史，把用户最新问题改写成可独立检索的问句，并提取 2~6 个搜索关键词（中文词或短语，不要单个字）。

对话历史：
${historyText}

用户最新问题：${question}

只输出 JSON，不要输出其他内容：
{"standalone_question": "改写后的完整问句", "keywords": ["关键词1", "关键词2"]}`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()

    // LLM 可能输出 markdown 代码块，去掉它
    const jsonStr = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '')
    const parsed = JSON.parse(jsonStr)

    if (!parsed.standalone_question || !Array.isArray(parsed.keywords)) {
      throw new Error('JSON 字段缺失')
    }

    return {
      standalone_question: parsed.standalone_question,
      keywords: parsed.keywords.slice(0, 6),
    }
  } catch (error) {
    // 降级：LLM 失败 → 用原问题 + 标点切词
    console.error('查询改写失败，降级为原始问题:', error)
    return {
      standalone_question: question,
      keywords: extractKeywordsFallback(question),
    }
  }
}

// 降级用：从 route.ts 搬过来的标点切词
function extractKeywordsFallback(question: string): string[] {
  const stopwords = new Set([
    '的', '了', '吗', '呢', '什么', '怎么', '如何', '是', '在', '有',
    '我', '你', '请', '帮我', '一下', '可以', '这个', '那个', '请问',
  ])
  return question
    .split(/[\s，。！？、；：,.!?;:"'（）()《》<>【】]+/)
    .filter((w) => w.length >= 2 && !stopwords.has(w))
    .slice(0, 6)
}
