import { supabaseAdmin } from '@/lib/db/supabase-admin'
import { parseDocument } from '@/lib/parsers'
import { smartChunkMarkdown } from './chunk-service'
import { generateEmbeddings } from './embedding-service'

export async function processDocument(
  documentId: string,
  file: Buffer,
  fileType: string,
  title: string
) {
  try {
    // 1. 解析
    const text = await parseDocument(file, fileType)

    // 2. 切片
    const chunks = smartChunkMarkdown(text, title)

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
      const { error: insertErr } = await supabaseAdmin
        .from('document_chunks')
        .insert(
          batch.map((c, j) => ({
            document_id: documentId,
            raw_content: c.rawContent,       // 🆕
            content: c.content,
            title_path: c.titlePath,         // 🆕
            chunk_index: c.chunkIndex,       // 🔄 从 position 改名
            char_count: c.charCount,         // 🆕
            embedding: embeddings[j],
            token_count: null,               // 🔄 先留空，后续用真 tokenizer 补
            metadata: {},                    // 🆕 显式给默认值
          }))
        )

      if (insertErr) throw insertErr
    }

    // 5. 更新文档状态
    const { error: updateErr } = await supabaseAdmin
      .from('documents')
      .update({ status: 'completed', chunk_count: chunks.length })
      .eq('id', documentId)

    if (updateErr) throw updateErr
  } catch (err) {
    console.error('文档处理失败:', err)

    // 6. 清理已插入的半截 chunk，避免脏数据
    await supabaseAdmin
      .from('document_chunks')
      .delete()
      .eq('document_id', documentId)

    // 7. 标记文档失败
    await supabaseAdmin
      .from('documents')
      .update({ status: 'failed' })
      .eq('id', documentId)
    throw err
  }
}

// 纯文本入口（给 seed 用）
export async function processText(
  documentId: string,
  text: string,
  title: string = ''            // 🆕 支持传标题
) {
  try {
    // 🔄 不再用 chunkText，改用 smartChunkMarkdown
    const chunks = smartChunkMarkdown(text, title)

    if (chunks.length === 0) {
      await supabaseAdmin
        .from('documents')
        .update({ status: 'failed' })
        .eq('id', documentId)
      return
    }

    for (let i = 0; i < chunks.length; i += 100) {
      const batch = chunks.slice(i, i + 100)
      const embeddings = await generateEmbeddings(batch.map((c) => c.content))

      const { error: insertErr } = await supabaseAdmin
        .from('document_chunks')
        .insert(
          batch.map((c, j) => ({
            document_id: documentId,
            raw_content: c.rawContent,
            content: c.content,
            title_path: c.titlePath,
            chunk_index: c.chunkIndex,
            char_count: c.charCount,
            embedding: embeddings[j],
            token_count: null,
            metadata: {},
          }))
        )

      if (insertErr) throw insertErr
    }

    await supabaseAdmin
      .from('documents')
      .update({ status: 'completed', chunk_count: chunks.length })
      .eq('id', documentId)
  } catch (err) {
    console.error('processText 失败:', err)
    await supabaseAdmin
      .from('document_chunks')
      .delete()
      .eq('document_id', documentId)
    await supabaseAdmin
      .from('documents')
      .update({ status: 'failed' })
      .eq('id', documentId)
    throw err
  }
}