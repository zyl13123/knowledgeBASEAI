import 'server-only'
import { parsePdf } from './pdf-parser'
import { parseDocx } from './docx-parser'

const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv']

/**
 * 统一入口：把各种文件解析成纯文本
 * 不支持的类型直接抛错，由调用方标记文档失败
 */
export async function parseDocument(
  file: Buffer,
  fileType: string | null
): Promise<string> {
  if (!fileType) {
    throw new Error('缺少文件类型')
  }

  const ext = fileType.toLowerCase()

  if (ext === 'pdf') return parsePdf(file)
  if (ext === 'docx') return parseDocx(file)
  if (TEXT_EXTENSIONS.includes(ext)) return file.toString('utf-8')

  throw new Error(`不支持的文件类型: ${fileType}`)
}