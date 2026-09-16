# 📚 Knowledge Base AI

> 基于 Next.js + Supabase + pgvector 的 RAG 知识库问答系统

上传文档 → 自动分块向量化 → 混合检索 → AI 流式回答

---

## ✨ 功能

- 📄 支持 PDF / DOCX / Markdown / TXT
- ✂️ 按标题智能分块，保留章节路径
- 🔍 向量 + 关键词混合检索（RRF 融合）
- 🎯 Rerank 精排，提升相关性
- 🤖 复杂问题自动拆解
- ⚡ SSE 流式输出

---

## 🛠 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js (App Router) |
| 数据库 | Supabase + pgvector |
| 向量 | 768 维 Embedding |
| 检索 | 向量 + 关键词 + RRF + Rerank |
| LLM | Gemini |

---

## 🚀 快速开始

### 1️⃣ 安装

```bash
pnpm install
