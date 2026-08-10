
import { supabaseAdmin } from '@/lib/db/supabase-admin'
import { CONFIG } from '@/lib/config/constants'

// 关键词通道返回的结果结构（对应 SQL 的 RETURNS TABLE）
export interface KeywordHit {
  id: string
  document_id: string
  content: string
  position: number
  hit_count: number
  document_title: string
}

export async function searchByKeywords(
    keywords: string[],
    limit: number = CONFIG.CANDIDATE_POOL
): Promise<KeywordHit[]> {
    if (!keywords || keywords.length === 0)
        return []

    const patterns = keywords.map((kw) => `%${kw}%`)

    const { data, error } = await supabaseAdmin.rpc('search_chunks_by_keywords', {
        p_keywords: patterns,  
        p_limit: limit         
    })

    if (error) throw error
    return (data || []) as KeywordHit[]
}