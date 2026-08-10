export const CONFIG = {
  // 文本分块
  CHUNK_SIZE: 500,        // 每块最多 500 个字符
  CHUNK_OVERLAP: 50,      // 相邻块之间重叠 50 个字符

  // 向量搜索
  TOP_K: 3,               // 每次搜索返回最相似的 3 个文本块
  MATCH_THRESHOLD: 0.3,   // 相似度低于 0.3 的不要
  CANDIDATE_POOL:20,
  RRF_K: 60,

  // Gemini 模型
  EMBEDDING_MODEL: 'gemini-embedding-001',  // embedding 用的模型
  // lib/config/constants.ts
  CHAT_MODEL: 'gemini-2.5-flash'   // 3.6 换成 2.5
 // 当前新用户可用的最新免费模型

  //历史对话取最后几个
  REWRITE_HISTORY_TURNS:4,
  
  //选出几个chunk
  RERANK_TOP_K: 3
}
