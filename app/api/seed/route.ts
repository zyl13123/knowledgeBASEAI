import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/db/supabase-admin'
import { generateEmbedding } from '@/lib/services/embedding-service'
import { CONFIG } from '@/lib/config/constants'

export async function POST(request: NextRequest) {
  try {
    const { title, text } = await request.json()

    if (!title || !text) {
      return NextResponse.json({ error: '标题和内容不能为空' }, { status: 400 })
    }

    // 1. 往 documents 表插入一条文档记录
    const { data: doc, error: docError } = await supabaseAdmin
      .from('documents')
      .insert({ title, file_type: 'text', file_size: text.length, status: 'completed' })
      .select()
      .single()

    if (docError) throw docError

    // 2. 把文本切块
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += CONFIG.CHUNK_SIZE) {
      const start = Math.max(0, i - CONFIG.CHUNK_OVERLAP)
      const end = i + CONFIG.CHUNK_SIZE
      chunks.push(text.slice(start, end))
    }

    // 3. 逐块转向量，插入 document_chunks 表
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await generateEmbedding(chunks[i])
      await supabaseAdmin.from('document_chunks').insert({
        document_id: doc.id,
        content: chunks[i],
        position: i,
        embedding,
        token_count: chunks[i].length,
      })
    }

    // 4. 更新文档的分块数量
    await supabaseAdmin
      .from('documents')
      .update({ chunk_count: chunks.length })
      .eq('id', doc.id)

    return NextResponse.json({ success: true, chunk_count: chunks.length })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '插入失败' },
      { status: 500 }
    )
  }
}
