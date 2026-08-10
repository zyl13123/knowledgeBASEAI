import { supabaseAdmin } from '@/lib/db/supabase-admin'
import { CONFIG } from '@/lib/config/constants'

export async function searchSimilarChunks(
  queryEmbedding: number[],
  topK: number = CONFIG.TOP_K
) {
  const { data, error } = await supabaseAdmin.rpc('match_document_chunks', {
    query_embedding: queryEmbedding,
    match_threshold: CONFIG.MATCH_THRESHOLD,
    match_count: topK,
  })

  if (error) throw error
  return data
}
