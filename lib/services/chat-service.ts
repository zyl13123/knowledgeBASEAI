import { GoogleGenerativeAI } from '@google/generative-ai'
import { CONFIG } from '@/lib/config/constants'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// 流式生成回答，支持多轮对话上下文
// 返回异步生成器：调用方用 for await 逐段拿文本
export async function generateAnswerStream(
  question: string,
  contextChunks: { content: string; document_title: string }[],
  history: ChatMessage[] = []
): Promise<AsyncGenerator<string>> {
  // 1. 把搜到的文本块拼成参考资料，编号 [1][2] 方便引用
  const context = contextChunks
    .map((chunk, i) => `[${i + 1}] 《${chunk.document_title}》\n${chunk.content}`)
    .join('\n\n')

  // 2. 系统提示词：告诉 AI 角色 + 参考资料 + 回答规范
  const systemInstruction = `你是一个知识库问答助手。请根据以下参考资料回答用户问题。
如果参考资料中没有答案，请说明"知识库中未找到相关内容"，不要编造。

参考资料：
${context}

回答要求：
- 引用来源时用 [1] [2] 这样的标记（对应参考资料的编号）
- 回答用 Markdown 格式，方便渲染`

  // 3. 历史消息转成 Gemini 认识的格式（assistant → model）
  const geminiHistory = history.map((h) => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.content }],
  }))

  // 4. startChat：带系统提示 + 历史，Gemini 就"记得"之前聊过
  const model = genAI.getGenerativeModel({ model: CONFIG.CHAT_MODEL })
  const chat = model.startChat({
  systemInstruction: {
    role: 'system',
    parts: [{ text: systemInstruction }],   // ← 手动包成对象
  },
  history: geminiHistory,
})


  // 5. sendMessageStream：流式生成，一段一段返回
  const result = await chat.sendMessageStream(question)

  // 6. 包装成异步生成器，只吐有用的文本
  return (async function* () {
    for await (const chunk of result.stream) {
      const text = chunk.text()
      if (text) yield text
    }
  })()
}
