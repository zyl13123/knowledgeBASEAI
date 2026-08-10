import { GoogleGenerativeAI } from '@google/generative-ai'
import { CONFIG } from '@/lib/config/constants'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

// 单条向量化（seed / chat 接口用）
export async function generateEmbedding(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: CONFIG.EMBEDDING_MODEL })
  const result = await model.embedContent({
    content: { parts: [{ text }], role: 'user' },
    outputDimensionality: 768,
  })
  return result.embedding.values
}

// 批量向量化（上传文档用）
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const model = genAI.getGenerativeModel({ model: CONFIG.EMBEDDING_MODEL })

  const results = await Promise.all(
    texts.map((text) =>
      model.embedContent({
        content: { parts: [{ text }], role: 'user' },
        outputDimensionality: 768,
      })
    )
  )
  return results.map((r) => r.embedding.values)
}
