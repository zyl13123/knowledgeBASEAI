import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/db/supabase-admin'

// GET /api/documents —— 获取所有文档列表
export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from('documents')
      .select('id, title, file_type, chunk_count, status, created_at')
      .order('created_at', { ascending: false })

    if (error) throw error
    return NextResponse.json({ documents: data })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取失败' },
      { status: 500 }
    )
  }
}
