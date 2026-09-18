// lib/services/react-agent.ts
import 'server-only'
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import { CONFIG } from '@/lib/config/constants'
import { hybridSearch, type HybridCandidate } from './hybrid-service'
import { extractKeywords } from './query-rewriter'

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) throw new Error('GEMINI_API_KEY 未配置')
const genAI = new GoogleGenerativeAI(apiKey)

// ============================================================
// 工具定义（Gemini function calling schema）
// ============================================================
const tools = [
  {
    functionDeclarations: [
      {
        name: 'search_knowledge_base',
        description:
          '在知识库中检索与给定查询最相关的文本块。' +
          '当你需要查找事实信息、定义、流程、制度、规定等内容时，调用此工具。' +
          '如果第一次检索结果不够，可以换关键词再查一次。',
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            query: {
              type: SchemaType.STRING,
              description:
                '要检索的问题或关键词。请使用独立、完整的问题，例如"报销流程需要哪些材料"而不是"它需要什么"。',
            },
          },
          required: ['query'],
        },
      },
    ],
  },
]

// ============================================================
// 工具执行器：内部复用单跳流水线
// ============================================================
async function executeSearch(query: string): Promise<{
  formatted: string
  chunks: HybridCandidate[]
}> {
  // 抽关键词
  const keywords = extractKeywords(query, 5)

  // 复用混合检索
  const candidates = await hybridSearch(query, keywords)

  if (candidates.length === 0) {
    return { formatted: '（未找到相关内容）', chunks: [] }
  }

  // 截断到前 N 个
  const top = candidates.slice(0, CONFIG.AGENT_TOOL_TOP_K)

  // 格式化成 LLM 易读的文本
  const formatted = top
    .map((c, i) => {
      const content = c.content.replace(/^【章节路径: [^】]+】\n/, '')
      const preview = content.slice(0, CONFIG.AGENT_CHUNK_PREVIEW)
      const more = content.length > CONFIG.AGENT_CHUNK_PREVIEW ? '...' : ''
      return `[${i + 1}] 《${c.document_title}》\n${preview}${more}`
    })
    .join('\n\n')

  return { formatted, chunks: top }
}

// ============================================================
// ReAct 主函数
// ============================================================
export interface ReActResult {
  answer: string
  chunks: HybridCandidate[]
  hops: number
  queries: string[]  // 调试用：记录了 LLM 每次搜了什么
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function runReActAgent(
  question: string,
  history: ChatMessage[] = []
): Promise<ReActResult> {
  const model = genAI.getGenerativeModel({
    model: CONFIG.CHAT_MODEL,
    tools,
    systemInstruction: `你是一个知识库问答助手。请通过调用 search_knowledge_base 工具来获取信息，然后基于检索到的内容回答问题。

工作规则：
1. 收到问题后，先判断是否需要查知识库。需要的话，调用工具检索。
2. 如果问题涉及多个概念或需要多步推理，可以多次调用工具，每次针对不同方面。
3. 检索到足够信息后，直接输出最终答案（不再调用工具）。
4. 引用来源时用 [1] [2] 这样的标记。
5. 如果多次检索后仍找不到相关内容，如实说明"知识库中未找到相关内容"，不要编造。

回答格式：
- 用 Markdown，方便渲染
- 引用来源放在对应句子后面`,
  })

  const chat = model.startChat({
    history: history.map((h) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    })),
  })

  const collectedChunks: HybridCandidate[] = []
  const queries: string[] = []
  let hops = 0

  // 第 1 轮：把用户问题发给 LLM
  let result = await chat.sendMessage(question)

  // 循环：只要 LLM 要求调工具，就执行并回传
  while (hops < CONFIG.AGENT_MAX_TURNS) {
    const calls = result.response.functionCalls()

    // 没有工具调用 → LLM 想直接回答 → 结束循环
    if (!calls || calls.length === 0) {
      break
    }

    // 执行所有工具调用（可能一次返回多个）
    const responses = await Promise.all(
      calls.map(async (call) => {
        const query = (call.args as { query: string }).query
        queries.push(query)

        try {
          const { formatted, chunks } = await executeSearch(query)
          collectedChunks.push(...chunks)

          return {
            functionResponse: {
              name: call.name,
              response: { results: formatted },
            },
          }
        } catch (err) {
          console.error('ReAct 工具执行失败:', err)
          return {
            functionResponse: {
              name: call.name,
              response: {
                error: '检索失败，请尝试其他关键词或基于已有信息回答',
              },
            },
          }
        }
      })
    )

    // 把工具结果送回 LLM，进入下一轮
    result = await chat.sendMessage(responses)
    hops++
  }

  // 去重：同一 chunk 可能被多次检索到
  const seen = new Set<string>()
  const uniqueChunks = collectedChunks.filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })

  return {
    answer: result.response.text(),
    chunks: uniqueChunks,
    hops,
    queries,
  }
}