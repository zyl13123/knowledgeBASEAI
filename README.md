```markdown
# 项目成果总结 · 懒大王知识库问答系统

> 基于 Next.js + Supabase + pgvector 的 RAG + Agent 知识库问答系统  
> 完成时间：2026-09-18
> https://knowledge-baseai-eight.vercel.app/
---

## 一、系统架构

```
┌─────────────────────────────────────────────────┐
│                   前端 (page.tsx)                │
│  sessionId 持久化 · 流式渲染 · 引用展示 · 文档管理  │
└────────────────────┬────────────────────────────┘
                     │ POST /api/chat
                     ▼
┌─────────────────────────────────────────────────┐
│              chat/route.ts (编排层)              │
│  sessionId → 读历史 → 存用户消息 → 分流           │
└────────────────────┬────────────────────────────┘
                     │
      ┌──────────────┴──────────────┐
      ▼                              ▼
┌──────────────┐            ┌──────────────┐
│ 简单问题      │            │ 复杂问题      │
│ hybridSearch │            │ ReAct Agent  │
└──────┬───────┘            └──────┬───────┘
       │                          │
       ▼                          ▼
┌─────────────────────────────────────────────────┐
│  向量通道 + 关键词通道 → RRF 融合 → LLM 重排      │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│          Gemini 流式生成 → SSE 推送              │
└─────────────────────────────────────────────────┘
```

---

## 二、模块清单

### 数据处理层

| 模块 | 文件 | 状态 |
|------|------|------|
| 文件解析 | `lib/parsers/index.ts` | 完成 PDF/DOCX/MD/TXT |
| 智能分块 | `lib/chunking/smart-chunker.ts` | 完成 标题感知 + 表格/代码块保护 |
| 中文关键词 | `lib/services/keyword-extractor.ts` | 完成 jieba v2 |
| 文档处理 | `lib/services/document-service.ts` | 完成 解析→分块→embedding→入库 |
| 向量化 | `lib/services/embedding-service.ts` | 完成 单条 + 批量 |

### 检索层

| 模块 | 文件 | 状态 |
|------|------|------|
| 向量检索 | `lib/services/vector-service.ts` | 完成 pgvector |
| 关键词检索 | `lib/services/keyword-search.ts` | 完成 ILIKE + hit_count |
| 混合检索 + RRF | `lib/services/hybrid-service.ts` | 完成 双通道融合 |
| LLM 重排 | `lib/services/reranker.ts` | 完成 1-based + JSON 解析 |

### 查询理解层

| 模块 | 文件 | 状态 |
|------|------|------|
| 查询改写 | `lib/services/query-rewriter.ts` | 完成 指代消解 |
| 复杂度路由 | `lib/services/router.ts` | 完成 规则匹配 |
| 多查询拆解 | `lib/services/planner.ts` | 完成 并行检索 + 去重 |

### Agent 层

| 模块 | 文件 | 状态 |
|------|------|------|
| ReAct 循环 | `lib/services/react-agent.ts` | 完成 function calling |
| 单跳流水线 | `hybridSearch` + `rerank` | 完成 被工具复用 |
| 对话持久化 | `chat_messages` 表 | 完成 匿名 session |

### 会话层

| 模块 | 文件 | 状态 |
|------|------|------|
| 问答接口 | `app/api/chat/route.ts` | 完成 |
| 历史加载 | `app/api/chat/history/route.ts` | 完成 |
| 流式生成 | `lib/services/chat-service.ts` | 完成 超时保护 |
| 前端 | `app/page.tsx` | 完成 sessionId 持久化 |

### 工程化

| 模块 | 状态 |
|------|------|
| `server-only` 隔离 | 完成 保护密钥 |
| API key 启动检查 | 完成 |
| `stripPrefix` 工具 | 完成 |
| CONFIG 开关 | 完成 `ENABLE_REACT` |
| 超时保护 | 完成 `Promise.race` |

---

## 三、数据库结构

```
documents                    document_chunks
├── id (uuid)               ├── id (uuid)
├── title                   ├── document_id
├── file_type               ├── raw_content      ← 原文
├── file_size               ├── content          ← 带【章节路径】前缀
├── file_path               ├── title_path       ← "公司制度 > 报销流程"
├── chunk_count             ├── chunk_index
├── status                  ├── char_count
└── created_at              ├── metadata
                            ├── embedding (768维)
chat_messages               ├── token_count
├── id                      └── created_at
├── session_id
├── role (user/assistant)
├── content
├── sources_json
└── created_at
```

**存储过程**：
- `match_document_chunks`（向量通道）
- `search_chunks_by_keywords`（关键词通道）

**索引**：
- `document_chunks_pkey`
- `idx_document_chunks_doc_chunk` (document_id, chunk_index)
- `idx_document_chunks_metadata`
- `idx_chat_messages_session`

---

## 四、核心能力

| 能力 | 实现 |
|------|------|
| 混合检索 | 向量 + 关键词 → RRF 融合（交叉验证） |
| LLM 重排 | 20 候选 → 精选 top 3 |
| 查询改写 | 多轮对话中指代消解 |
| 复杂度路由 | 简单走单跳，复杂走 ReAct |
| ReAct Agent | LLM 自主决定查什么、查几次 |
| 流式输出 | SSE + 逐 token 推送 |
| 对话持久化 | 匿名 session + 数据库，刷新不丢 |
| 引用来源 | 每条回答绑定 sources，可展开 |

---

## 五、技术栈

| 层 | 技术 |
|----|------|
| 框架 | Next.js (App Router) |
| 数据库 | Supabase (PostgreSQL + pgvector) |
| 向量 | 768 维 (Gemini text-embedding-004) |
| LLM | Gemini 2.0 Flash |
| 分词 | @node-rs/jieba v2 |
| 前端 | React 19 + Tailwind + react-markdown |

---

## 六、未实现（理性跳过）

| 项目 | 为什么跳过 |
|------|-----------|
| RAGAS 评估 | 库不匹配，自己写太麻烦，先用起来再说 |
| GraphRAG | 数据量不够，1-2 周投入不划算 |
| Self-RAG | prompt 已有防幻觉约束，没感知到幻觉问题 |
| 认证系统 | 匿名 session 够用，不需要注册登录 |
| CRAG 质量门控 | 复杂度高，收益待验证 |
| CONFIG 开关全面化 | 只做了 `ENABLE_REACT` |

---
