import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/db/supabase-admin'

// DELETE /api/documents/[id] —— 删除文档及其所有文本块
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // 1. 删文本块
    await supabaseAdmin.from('document_chunks').delete().eq('document_id', id)
    // 2. 删文档
    await supabaseAdmin.from('documents').delete().eq('id', id)

    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '删除失败' },
      { status: 500 }
    )
  }
}
