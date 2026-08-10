import 'server-only'
import mammoth from 'mammoth'


export async function parseDocx(file:Buffer):Promise<string> {
    const result = await mammoth.extractRawText({buffer:file})
    return result.value
}