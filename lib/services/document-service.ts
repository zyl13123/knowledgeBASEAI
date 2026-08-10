import { supabaseAdmin } from '@/lib/db/supabase-admin'
import { parseDocument } from '@/lib/parsers'
import { chunkText } from './chunk-service'
import { generateEmbeddings } from './embedding-service'

export async function processDocument(
  documentId: string,
  file: Buffer,
  fileType: string
) {
  try {
    // 1. 解析
    const text = await parseDocument(file, fileType)

    // 2. 切片
    const chunks = chunkText(text)

    // 2.5 空文档直接标记失败，不浪费 API 调用
    if (chunks.length === 0) {
      await supabaseAdmin
        .from('documents')
        .update({ status: 'failed' })
        .eq('id', documentId)
      console.error('文档内容为空，无法处理:', documentId)
      return
    }

    // 3. 批量向量化（每批 100 个）
    for (let i = 0; i < chunks.length; i += 100) {
      const batch = chunks.slice(i, i + 100)
      const embeddings = await generateEmbeddings(batch.map((c) => c.content))

      // 4. 存入 document_chunks
      await supabaseAdmin.from('document_chunks').insert(
        batch.map((c, j) => ({
          document_id: documentId,
          content: c.content,
          position: c.position,
          embedding: embeddings[j],
          token_count: c.content.length,
        }))
      )
    }

    // 5. 更新文档状态
    await supabaseAdmin
      .from('documents')
      .update({ status: 'completed', chunk_count: chunks.length })
      .eq('id', documentId)
  } catch (err) {
    console.error('文档处理失败:', err)
    // 6. 失败也要记录，状态置 failed
    await supabaseAdmin
      .from('documents')
      .update({ status: 'failed' })
      .eq('id', documentId)
    throw err
  }
}
