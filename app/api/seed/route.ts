import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/db/supabase-admin'
import { processText } from '@/lib/services/document-service'   // ← 复用

export async function POST(request: NextRequest) {
  try {
    const { title, text } = await request.json()

    if (!title || !text) {
      return NextResponse.json({ error: '标题和内容不能为空' }, { status: 400 })
    }

    // 1. 插 documents 记录
    const { data: doc, error: docError } = await supabaseAdmin
      .from('documents')
      .insert({
        title,
        file_type: 'text',
        file_size: text.length,
        status: 'processing',
      })
      .select()
      .single()

    if (docError) throw docError
    if (!doc) throw new Error('插入文档失败：未返回数据')

    // 2. 复用 processText，完事
    await processText(doc.id, text, title)

    return NextResponse.json({ success: true, docId: doc.id })
  } catch (error) {
    console.error('seed 插入失败:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '插入失败' },
      { status: 500 }
    )
  }
}