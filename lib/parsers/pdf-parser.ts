import 'server-only'
import { PDFParse } from 'pdf-parse'

export async function parsePdf(file: Buffer): Promise<string> {
  const parser = new PDFParse({ data: file })
  const result = await parser.getText()
  await parser.destroy()
  return result.text
}