// 临时脚本：从 Supabase 读取需求文档内容
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

function loadEnv() {
  const env = {}
  try {
    const content = readFileSync('.env.local', 'utf-8')
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].trim()
    }
  } catch (e) {
    console.error('读取 .env.local 失败:', e.message)
  }
  return env
}

const env = loadEnv()
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// 1. 找到需求文档的记录
const { data: doc, error: docErr } = await sb
  .from('documents')
  .select('id, title')
  .ilike('title', '%需求文档%')
  .order('created_at', { ascending: false })

if (docErr) { console.error('查询文档失败:', docErr.message); process.exit(1) }
if (!doc || doc.length === 0) { console.log('没找到需求文档'); process.exit(0) }

console.log('找到文档:', doc.map((d) => `${d.title} (${d.id})`).join('\n'))

// 2. 读最新那篇的所有 chunks，按 position 排序拼回全文
const target = doc[0]
const { data: chunks, error: chunkErr } = await sb
  .from('document_chunks')
  .select('content, position')
  .eq('document_id', target.id)
  .order('position', { ascending: true })

if (chunkErr) { console.error('读取chunks失败:', chunkErr.message); process.exit(1) }

const fullText = chunks.map((c) => c.content).join('\n\n')
console.log('---文档内容开始---')
console.log(fullText)
console.log('---文档内容结束---')
