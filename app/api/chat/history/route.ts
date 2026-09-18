// app/api/chat/history/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/db/supabase-admin'

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) {
    return NextResponse.json({ messages: [] })
  }

  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .select('role, content, sources_json')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(50)

  if (error) {
    console.error('加载历史失败:', error)
    return NextResponse.json({ messages: [] })
  }

  // 转成前端格式
  const messages = (data ?? []).map((m) => ({
    role: m.role,
    content: m.content,
    sources: m.sources_json ?? undefined,
  }))

  return NextResponse.json({ messages })
}