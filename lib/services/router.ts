const RELATION_WORDS = [
  '对比', '比较', '区别', '不同', '差异', '相同', '异同',
  '还是', '分别', '哪个好', '优缺点', '利弊',
]

const ENTITY_SEPARATOR = /[\u4e00-\u9fa5A-Za-z0-9]{2,}\s*(?:和|与|跟|及)\s*[\u4e00-\u9fa5A-Za-z0-9]{2,}/

export function isComplexQuery(question: string): boolean {
  const q = question.trim()

  // 太短的问题（< 6 字）基本不可能是复杂对比
  if (q.length < 6) return false

  // 太长（> 100 字）可能是误贴，降级为普通查询
  if (q.length > 100) return false

  // 命中明确关系词
  if (RELATION_WORDS.some((w) => q.includes(w))) return true

  // "X 和 Y" 结构
  if (ENTITY_SEPARATOR.test(q)) return true

  return false
}