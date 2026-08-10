export interface Chunk{
    content:string
    position:number
}
export function chunkText(
    text:string,
    chunkSize=500,
    overlap=50
):Chunk[]{
    const chunks:Chunk[] = []
    let position = 0
    const paragraphs = text.split(/\n\n+/)
    for(const para of paragraphs){
        if(!para.trim()) continue           // 跳过空段落
        if(para.length<=chunkSize){
            chunks.push({content:para,position:position++})
        }else{
            for (let i = 0; i < para.length; i += chunkSize - overlap) {
            const start = Math.max(0, i)
            const end = i + chunkSize
            chunks.push({ content: para.slice(start, end), position: position++ })
}
        }
    }
    return chunks

}
