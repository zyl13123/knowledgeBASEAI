// scripts/gen-eval-set.ts
import { GoogleGenerativeAI } from '@google/generative-ai'
import { supabaseAdmin } from '@/lib/db/supabase-admin'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

async function generateEvalSet() {
  // 1. 从数据库随机抽 20 个块
  const { data: chunks } = await supabaseAdmin
    .from('document_chunks')
    .select('id, content, document_id')
    .limit(100)

  // 随机抽 20 个
  const sampled = chunks!.sort(() => Math.random() - 0.5).slice(0, 20)

  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
  const results = []

  for (const chunk of sampled) {
    // 2. 让 LLM 根据这个块出题
    const prompt = `根据以下文本内容，生成一个用户可能会问的问题，以及该问题的标准答案。

要求：
- 问题要自然，像真实用户会问的
- 标准答案简洁（1-3 句话）
- 问题必须能用这段文本回答

文本内容：
${chunk.content.slice(0, 500)}

返回 JSON 格式（不要加 markdown 代码块）：
{"question": "...", "ground_truth": "..."}`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()

    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      results.push({
        question: parsed.question,
        ground_truth: parsed.ground_truth,
        relevant_chunk_ids: [chunk.id],   // 出题的块就是相关块
      })
    } catch {
      console.warn('解析失败，跳过:', text.slice(0, 50))
    }
  }

  // 3. 写入文件
  require('fs').writeFileSync(
    'eval/questions.json',
    JSON.stringify(results, null, 2)
  )

  console.log(`生成了 ${results.length} 条测试数据`)
}

generateEvalSet()


/**
 * # 1. 自动生成
pnpm tsx scripts/gen-eval-set.ts
# → eval/questions.json（30 条）

# 2. 打开文件，手动扫一眼
code eval/questions.json
# 删掉不自然的、答案不对的

# 3. 手动补几条
# 直接在 json 里加

# 4. 跑评估
pnpm tsx scripts/eval.ts
# → eval/report.md
 */