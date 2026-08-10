import 'server-only'
import { parsePdf } from './pdf-parser'
import { parseDocx } from './docx-parser'

// 统一入口：不管什么文件，都返回纯文本
export async function parseDocument(file: Buffer, fileType: string): Promise<string> {
  if (fileType === 'pdf') return parsePdf(file)
  if (fileType === 'docx') return parseDocx(file)
  return file.toString('utf-8') // txt / md 直接转字符串
}
