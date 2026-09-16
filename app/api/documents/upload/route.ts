import { after, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/db/supabase-admin'
import { processDocument } from '@/lib/services/document-service'

export async function POST(req: Request) {
  // 1. 拿到上传的文件
  const formData = await req.formData()
  const file = formData.get('file') as File
  if (!file) return NextResponse.json({ error: '没有文件' }, { status: 400 })

  // 2. 先建记录，状态 processing（立即可见）
  const { data: doc,error} = await supabaseAdmin
    .from('documents')
    .insert({
      title: file.name,
      file_type: file.name.includes('.') ? file.name.split('.').pop() : null,
      file_size: file.size,
      status: 'processing',
    })
    .select()
    .single()
  if (error) {
  console.error('插入文档失败:', error)
  throw error
  }
  if (!doc) {
  throw new Error('插入文档失败：未返回数据')
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  // 3. after()：响应发完后再后台慢慢处理
  after(async () => {
    try {
      await processDocument(doc.id, buffer, doc.file_type,doc.title)
    } catch (err) {
      console.error('after() 后台处理失败:', err)
    }
  })

  // 4. 立即返回，不等处理完
  return NextResponse.json({ success: true, docId: doc.id })
}
