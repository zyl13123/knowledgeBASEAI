import { GoogleGenerativeAI } from '@google/generative-ai'
import { CONFIG } from '@/lib/config/constants'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

// 单条向量化（seed / chat 接口用）
export async function generateEmbedding(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: CONFIG.EMBEDDING_MODEL })
  const result = await model.embedContent({
    content: { parts: [{ text }], role: 'user' },
    outputDimensionality: 768,
  }as any)
  return result.embedding.values
}

// 批量向量化（上传文档用）
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  const model = genAI.getGenerativeModel({ model: CONFIG.EMBEDDING_MODEL })

  const result = await model.batchEmbedContents({
    requests: texts.map((text) => ({
      content: { parts: [{ text }], role: 'user' },
      outputDimensionality: CONFIG.EMBEDDING_DIM,
    })),
  } as any)

  return result.embeddings.map((e) => e.values)
}
