# 知识库问答系统 · 检索智能升级 —— 架构设计文档

| 项目 | 内容 |
|------|------|
| 文档版本 | v1.0 |
| 编写日期 | 2026-08-08 |
| 关联文档 | 《requirements-retrieval-upgrade.md》需求设计文档 |
| 目标读者 | 项目维护者（1 人，Web 开发新手，需原理讲解） |

---

## 1. 架构总览：从"单管道"到"流水线 + Agent"

### 1.1 现在的架构（一条直线）

```
┌─────────────────────────────────────────────────────────┐
│                     app/api/chat/route.ts               │
│                                                         │
│  问题 ──► generateEmbedding ──► searchSimilarChunks ──► │
│                (embedding-service)   (vector-service)   │
│                                                         │
│                       ┌──────────────┐                  │
│                       │ chat-service │◄──────────────────┘
│                       │  (生成回答)   │
│                       └──────┬───────┘
│                              ▼
│                    SSE 流式返回前端
└─────────────────────────────────────────────────────────┘
```

问题：所有逻辑挤在 route 里，检索 = 一步到位，没有中间环节。

### 1.2 目标架构（流水线 + 可选 Agent 循环）

```
                    ┌──────────────────────────────┐
                    │        chat/route.ts         │
                    │        (编排器/Orchestrator)  │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  ① 意图路由 router.ts         │
                    │  简单问题？→ 单跳流水线        │
                    │  复杂问题？→ Agentic 循环      │
                    └──────────────┬───────────────┘
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        │                                                     │
┌───────▼────────┐                                  ┌──────────▼─────────┐
│  单跳流水线      │                                  │  多跳循环            │
│                │                                  │  (Agentic)         │
│ ② query-       │                                  │  planner/          │
│    rewriter.ts │                                  │  react-loop         │
│  （改写+关键词） │                                  └──────────┬─────────┘
└───────┬────────┘                                             │
        ▼                                                      ▼
┌─────────────────────────┐                         ┌────────────────────┐
│ ③ hybrid-retriever.ts   │◄────────────────────────┤ search_knowledge   │
│  (向量 + 关键词双通道)    │      Agent 调用的工具      │ _base 工具（复用流水线）│
└───────────┬─────────────┘                         └────────────────────┘
            ▼
┌─────────────────────────┐
│ ④ reranker.ts           │
│  (LLM 精排 top3)         │
└───────────┬─────────────┘
            ▼
┌─────────────────────────┐
│ ⑤ chat-service.ts       │  ← 现有文件，只改入参
│  (生成回答，基本不动)      │
└─────────────────────────┘
```

**核心思想**：把原来"检索"这一个动作，拆成 5 个独立环节（路由 → 改写 → 混合检索 → 重排序 → 生成）。每个环节是一个独立模块，可以单独测试、单独降级、单独替换——这正是从"脚本"走向"系统"的分水岭。

---

## 2. 检索流水线分环节设计

### 2.1 环节①：意图路由（router）

**目的**：判断这个问题"单跳能不能答"，决定走哪条路。

**实现**：先不上 LLM 判断（省一次调用），用启发式规则：

```
触发多跳（Agentic）的条件（任一命中）：
- 问题中出现对比词：对比、比较、区别、差异、不同、分别、各自
- 问题中出现 "和/与/以及" 连接两个以上主题词
- 问题包含 "哪些文档 / 几份文档" 等跨文档措辞
```

命中 → 走多跳；未命中 → 走单跳流水线。

> 为什么用规则而不是 LLM 判断？因为路由错了代价很低（多跳流程兜底也能处理简单问题），规则零成本、零延迟。等数据积累后再考虑学一个路由器。

### 2.2 环节②：查询改写（query-rewriter）

**目的**：解决"追问断片" + 产出关键词。

**输入**：当前问题 + 最近 N 轮历史（建议 N=4，够消解指代又不撑爆 token）。

**输出**（JSON，强制）：

```json
{
  "standalone_question": "报销流程中，款项到账需要多久？",
  "keywords": ["报销", "到账", "时间", "流程"]
}
```

**Prompt 设计要点**：

```
你是检索查询改写器。根据对话历史，把用户最新问题改写成可独立检索的问句，
并提取 2~6 个搜索关键词（中文词或短语，不要单个字）。
只输出 JSON：{"standalone_question": "...", "keywords": [...]}
```

**降级**：JSON 解析失败 → 直接用原问题 + 原问题按标点切词兜底。

### 2.3 环节③：混合检索（hybrid-retriever）

#### 3.3.1 双通道设计

```
        standalone_question + keywords
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   通道 A：向量通道          通道 B：关键词通道
   generateEmbedding         WHERE content ILIKE ANY(keywords)
   (原逻辑不变)                (数据库直查，毫秒级)
        │                       │
        ▼                       ▼
   返回 top20 带相似度        返回 top20 带命中关键词数/覆盖率
        │                       │
        └───────────┬───────────┘
                    ▼
             RRF 融合 + 去重
                    │
                    ▼
              top20 候选块（送 rerank）
```

#### 3.3.2 关键词通道的 SQL（核心实现）

```sql
SELECT id, document_id, content, position,
       -- 命中关键词个数（越多个数越靠前）
       (SELECT count(*) FROM unnest(:keywords) kw
        WHERE content ILIKE '%' || kw || '%') AS hit_count,
       -- 第一个命中位置（越早出现越靠前）
       position(content) AS first_hit_pos
FROM document_chunks
WHERE content ILIKE ANY (ARRAY(SELECT '%' || kw || '%' FROM unnest(:keywords) kw))
ORDER BY hit_count DESC, first_hit_pos ASC
LIMIT 20;
```

> **为什么不用 tsvector？** Postgres 内置的 `tsvector` 默认分词器（english/simple）按空格和标点分词，**对中文无效**——"报销流程"会被当成一个词，搜"报销"匹配不上。要真正支持中文分词需要装 zhparser 扩展（Supabase 托管环境不支持）。所以选择 `ILIKE` 模糊匹配 + LLM 提取关键词（LLM 本身就是最强中文分词器）。数据量几百块时，ILIKE 全表扫也只要几毫秒，完全没有性能问题。

#### 3.3.3 融合算法：RRF（Reciprocal Rank Fusion）

**为什么不用分数加权？**
- 向量通道给的是余弦相似度（0~1），关键词通道给的是命中数/位置——**量纲完全不同**，不能直接相加
- 归一化（min-max）会被极端值带偏

**RRF 的思路**：不看分数，只看**排名**。

```
score(d) = Σ  1 / (k + rankᵢ(d))
             i∈{A,B}

k 取 60（标准默认值，平滑作用，防止 rank=1 的块分数爆炸）

例子：
  块 X：向量通道第 2 名，关键词通道第 8 名
        → 1/(60+2) + 1/(60+8) = 0.0161 + 0.0147 = 0.0308
  块 Y：向量通道第 15 名，关键词通道没命中
        → 1/(60+15) = 0.0133
  块 X 胜出 —— 因为它"两边都有名次"，这叫交叉验证
```

**为什么 RRF 效果好**：向量和关键词是互补的信号，一个块如果两种信号都命中，几乎可以确定它相关。RRF 天然奖励这种"双保险"。

**实现位置**：在 JS 里算（拿到两个通道的排名数组，各带 id），不需要数据库参与。

### 2.4 环节④：重排序（reranker）

**目的**：从 20 个候选里挑出真正该进 prompt 的 3 个。

**为什么需要它**：混合检索的 top20 里，可能前 10 名都在讲同一段落（高度相似导致扎堆），真正不同的信息点排在后面。LLM 生成时如果只喂 3 块"相似的废话"，答案就窄。

**实现**（LLM rerank，一次调用）：

```
prompt:
  问题：{standalone_question}
  以下是检索到的文本块，编号 [1]~[20]，每块带来源标题。
  选出与问题最相关且信息互补（不重复）的 3 块，只输出编号数组。

  [1] 《报销制度》……  [2] 《差旅制度》……  …

输出：["7", "15", "3"]
```

**两点设计**：
1. **要 JSON 数组输出**，解析失败降级为"取粗召回前 3"
2. **prompt 里强调"信息互补"**——这利用了 LLM 的语义理解，比任何算法都更能避免重复块

> 为什么不用专用 rerank 模型（bge-reranker 等）？那些要本地部署或付费 API，对这个数据量是杀鸡用牛刀。用 gemini-3.6-flash 当 reranker，零额外成本，且它读中文的能力就是最好的相关性判断器。

### 2.5 环节⑤：生成（chat-service，几乎不改）

只改入参：`contextChunks` 从"3 块"变成"rerank 后的 3 块"，内部逻辑不变。**顺手加一个能力**：如果 rerank 返回的块不足 3 个，或相似度全部低于阈值，直接返回"知识库未找到相关内容"。

---

## 3. Agentic 多跳检索设计

### 3.1 两种模式

#### 模式一：查询规划（Query Planning）—— 主推

**流程**：

```
用户问题（对比/跨主题类）
   │
   ▼
① 规划器（LLM 一次调用）
   输入：问题 + 知识库文档清单（只给标题列表，帮助它知道该查哪个文档）
   输出：["报销制度 发票要求", "差旅制度 发票要求"]  ← 2~4 个子查询
   │
   ▼
② 每个子查询并行执行「单跳流水线的 ②③④」：
   改写（不需要，子查询已自足）→ 混合检索 → （可选 rerank）
   │
   ▼
③ 合并：去重（按 chunk id），总数封顶 9 块（3 个子查询 × 3 块）
   │
   ▼
④ 一次性送入 chat-service 生成最终对比回答
```

**为什么先做这个模式**：查询规划是"一次性决策"——拆完并行执行就完事，没有循环，没有状态机。延迟可控（并行），结果可预测（子问题数量固定），是 Agentic 里最稳妥的入门形态。

#### 模式二：ReAct 循环（自主 Agent）—— 进阶

**流程**：

```
循环开始（最多 5 轮）
   │
   ▼
LLM 思考（sendMessage，带工具定义）
   │
   ├─ 输出 text（想直接回答）→ 结束，返回最终回答
   │
   └─ 输出 functionCall(search_knowledge_base, {query: "..."})
         │
         ▼
      执行工具：内部就是「单跳流水线的 ②③④」（复用！）
         │
         ▼
      把检索结果作为 functionResponse 送回 LLM
         │
         └──► 回到循环
```

**工具定义**（Gemini function calling）：

```ts
const tools = {
  functionDeclarations: [{
    name: 'search_knowledge_base',
    description: '在知识库中检索与给定查询最相关的文本块，返回块内容与来源文档',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的问题或关键词' },
      },
      required: ['query'],
    },
  }],
}
```

**调用循环的关键代码形态**（讲清"谁调用的"）：

```ts
const chat = model.startChat({ tools })

// 第 1 轮：把用户问题发给 LLM
let result = await chat.sendMessage(userQuestion)

// 循环：只要 LLM 要求调工具，就执行并回传结果
while (result.response.functionCalls?.length) {   // ← 谁在驱动循环？这里
  const call = result.response.functionCalls[0]
  const toolResult = await searchKnowledgeBase(call.args.query)  // ← 执行工具（复用流水线）
  result = await chat.sendMessage([{
    functionResponse: {
      name: call.name,
      response: { results: toolResult },   // 以 functionResponse 形式回传
    },
  }])
  // 下一轮循环：LLM 会看到工具结果，决定继续搜还是直接答
}
// 循环退出：result.response.text() 就是最终回答
```

**为什么需要循环**：单次 LLM 调用只能"决定一次动作"。多跳的本质是"根据上一跳结果决定下一跳"，所以必须把 LLM 和工具执行器用循环串起来——LLM 负责决策（思考），代码负责执行（行动），这就是 ReAct 名字的由来（Reason + Act）。

**防死循环**：循环条件里加计数器，超过 5 次强制跳出，用当前已收集的结果生成回答。

### 3.2 单跳 vs 多跳的权衡

| 维度 | 单跳（现有） | 规划模式 | ReAct 模式 |
|------|-------------|---------|-----------|
| 延迟 | ~3-4s | 单跳 + 0.5-1s | 每跳 + 1-2s（可到 8s+） |
| LLM 调用次数 | 1-3 次 | 规划 1 + 生成 1 + rerank N | 思考 N + 生成 1 |
| 可靠性 | 高（简单） | 高（无循环） | 中（可能绕圈） |
| 处理对比/链式问题 | ✗ | ✓ | ✓✓ |
| 实现复杂度 | 0 | 低 | 中 |

**结论**：路由规则判断"需要拆解" → 规划模式；规划后的子问题仍太复杂（链式推理）→ ReAct。先做前两个，ReAct 作为阶段 F 可选。

---

## 4. 数据模型变更

### 4.1 document_chunks 表：新增一列（FR4 标题感知分块需要）

```sql
-- 标题路径列：记录该块属于哪个章节，检索命中后能携带上下文
ALTER TABLE document_chunks
ADD COLUMN IF NOT EXISTS heading_path TEXT;

COMMENT ON COLUMN document_chunks.heading_path IS '块所属的标题路径，如：公司制度 > 报销管理';
```

写入逻辑：分块时如果文本含 Markdown 标题，维护一个"当前标题栈"，切块时把 `标题路径 + 原文` 拼起来存进 content，同时单独存 heading_path 列供调试显示。

### 4.2 无需新增表

- 关键词通道直接用现有 `content` 列 ILIKE 查询，无索引也可（数据量小）
- 后续如果文档量增长（>1 万块），再考虑 `pg_trgm` 的 GIN 索引优化 ILIKE：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_chunks_content_trgm ON document_chunks USING gin (content gin_trgm_ops);
```

（pg_trgm 是 Supabase 默认支持的扩展，这是量变引发质变的升级路径，先不建。）

### 4.3 历史文档重处理

提供 `POST /api/documents/:id/reprocess`：把 status 置 processing → 复用 document-service 的现有 parse → chunk（新逻辑）→ embedding 流程。前端在文档列表加"重新处理"按钮。

---

## 5. API 设计

### 5.1 现有接口改动

**POST /api/chat** —— 内部流水线升级，请求/响应格式**完全不变**（兼容旧前端）：

```
请求：{ question, history }
响应：SSE 流（data: {text} / data: {sources} / data: [DONE]）—— 不变
```

`sources` 字段新增可选信息：`heading_path`（标题路径）、`channel`（该块来自向量/关键词/两者）、`rerank_rank`（重排后名次）——前端可选择性展示。

### 5.2 新增调试接口（NFR-3 / 开放问题 1）

**GET /api/chat/debug?question=...&history=...** —— 只跑检索不生成，返回完整中间过程：

```json
{
  "standalone_question": "报销流程中，款项到账需要多久？",
  "keywords": ["报销", "到账", "时间"],
  "vector_top20": [ { "chunk_id": "...", "similarity": 0.82 } ],
  "keyword_top20": [ { "chunk_id": "...", "hit_count": 3 } ],
  "rrf_top20": [ { "chunk_id": "...", "rrf_score": 0.0308 } ],
  "rerank_top3": [ { "chunk_id": "...", "title": "报销制度", "heading_path": "公司制度 > 报销管理" } ],
  "timings_ms": { "rewrite": 350, "vector": 80, "keyword": 12, "rerank": 420 }
}
```

这个接口是**学习调试神器**：每一次问答的"检索到底发生了什么"一目了然，也能直接用来验证第 3 节的验收标准。

### 5.3 Agentic 相关接口

- 规划模式：内部逻辑，不新增接口（chat/route 内部路由即可）
- ReAct 模式：同上，全部封装在服务层，前端无感知
- 新增 `POST /api/documents/:id/reprocess`（4.3）

---

## 6. 模块划分与文件结构

```
lib/
├── services/
│   ├── chat-service.ts          # 不改（或微调入参注释）
│   ├── embedding-service.ts     # 不改
│   ├── vector-service.ts        # 改：接受 top_k 参数（原来写死 3，现在粗召回要 20）
│   ├── hybrid-service.ts        # 【新】混合检索：双通道 + RRF 融合
│   ├── keyword-search.ts        # 【新】关键词通道：SQL ILIKE 查询 + 打分
│   ├── query-rewriter.ts        # 【新】改写：LLM 调用 + JSON 解析 + 降级
│   ├── reranker.ts              # 【新】LLM 重排序
│   ├── router.ts                # 【新】意图路由（规则判断单跳/多跳）
│   ├── planner.ts               # 【新】规划模式：拆子问题 + 并行检索 + 合并
│   ├── react-agent.ts           # 【新·阶段F】ReAct 循环（function calling）
│   └── document-service.ts      # 改：分块逻辑换新 chunker，标题路径入库
├── services/chunk-service.ts    # 【重写】FR4 智能分块（句子/标题感知）
├── config/constants.ts          # 改：新增 CONFIG 项（见下）
└── db/supabase-admin.ts         # 不改
```

**CONFIG 新增项**：

```ts
export const CONFIG = {
  // ...原有项不动
  CANDIDATE_POOL: 20,        // 粗召回候选数（原 TOP_K 语义变为"最终入 prompt 数"）
  RRF_K: 60,                 // RRF 融合常数
  REWRITE_HISTORY_TURNS: 4,  // 改写时参考的历史轮数
  RERANK_FINAL_K: 3,         // rerank 后送入生成的块数
  AGENT_MAX_TURNS: 5,        // ReAct 最大循环轮数
  PLANNER_MAX_SUBQUERIES: 4, // 规划模式最大子问题数
}
```

---

## 7. 关键技术原理速查（学习向）

### 7.1 BM25 是什么（关键词通道的理论锚点）

我们的关键词通道是简化版 BM25。BM25 的完整公式：

```
score(文档, 查询) = Σ   IDF(qᵢ) ×  f(qᵢ, 文档) × (k₁+1)
               qᵢ∈查询     ───────────────────────────────
                             f(qᵢ, 文档) + k₁(1 - b + b·len/avgdl)

IDF(qᵢ) = ln( (文档总数 - 含qᵢ的文档数 + 0.5) / (含qᵢ的文档数 + 0.5) + 1 )
```

三个直觉：
1. **TF 项**：词在文档里出现越多越相关（但 k₁ 抑制线性增长，出现 10 次不等于 10 倍相关）
2. **IDF 项**：越稀有的词权重越高（"报销"比"的"值钱）
3. **长度归一化**：同样命中一次，短文比长文更相关（长文稀释了关键词密度）

**我们的简化**：用 `hit_count` 近似 TF（统计关键词命中个数），未算 IDF 和长度归一化。**够用**——因为关键词由 LLM 精心提取（天然过滤了"的/了/吗"这类无意义词），且最终有 rerank 兜底。如果想升级为真 BM25，数据量小可以在 JS 里全量计算（几百块全拉出来算，几十毫秒），作为后续优化点。

### 7.2 RRF 为什么用 1/(60+rank)

- `+60` 是平滑项：防止第一名分数碾压一切（1/61 ≈ 0.0164 vs 2/62 ≈ 0.0161，几乎没差别，第一名没有特权）
- 分数只取决于"两边的名次相对位置"，与各通道分数绝对值无关 → 天然兼容异构信号
- 这是学术界（TREC 检索评测）和工业界（Elasticsearch、Weaviate、Qdrant 都内置）的标准做法

### 7.3 function calling 是谁在驱动

Gemini 的 function calling **不是**"模型直接调你的函数"，而是**模型输出一个"调用请求"（functionCall 对象）**，由**你的代码**去执行并回传结果。权力关系：

```
你（宿主代码）          Gemini
    │                     │
    ├── 发消息 ──────────►│  （带工具定义）
    │                     ├── 返回 functionCall 或 text
    │◄── 调用请求 ────────┤
    ├── 执行工具（你写）    │
    ├── 回传结果 ────────►│  functionResponse
    │                     ├── 返回下一个 functionCall 或 text
    │◄── 结果 ───────────┤
    └── 循环直到 text      │
```

**所以"谁调用的"答案是：模型只负责"决定调什么"，真正执行工具的是宿主代码。** 这也是为什么 Agent 的安全边界在宿主侧：你完全控制工具的执行逻辑和频率。

---

## 8. 技术选型对比

| 决策点 | 方案 A（推荐） | 方案 B | 方案 C |
|--------|---------------|--------|--------|
| 关键词通道 | **LLM 提取关键词 + ILIKE 匹配**：中文友好、零扩展依赖、实现简单 | pg_search（ParadeDB）真 BM25：算法正宗，但 Supabase 托管环境中文分词配置复杂、扩展可用性需验证 | tsvector + simple 分词：中文支持差，关键词"报销流程"切不开，**不推荐** |
| 融合 | **RRF**：只看排名、鲁棒 | 分数加权：需要归一化、易被极端值带偏 | — |
| 重排序 | **LLM rerank（gemini-3.6-flash）**：零成本、中文强 | 专用 rerank 模型：效果更稳但要部署/付费 | 纯算法重排（MMR 去重）：无语义理解 |
| 多跳 | **规划模式先行 + ReAct 进阶**：循序渐进 | 直接 ReAct：灵活但难调试、易绕圈 | — |
| 调试 | **/api/chat/debug 接口**：可验证、可学习 | 只靠日志：黑盒 | — |

---

## 9. 成本与性能预算

| 环节 | 额外 LLM 调用 | 预计延迟 | 备注 |
|------|-------------|---------|------|
| 路由（规则） | 0 | ~0ms | 纯 JS 判断 |
| 改写 | 1 次 | 300-500ms | 输入输出都很小 |
| 混合检索（向量） | 0（embedding 不算 chat 模型） | 80-150ms | 原逻辑 |
| 混合检索（关键词） | 0 | 5-20ms | ILIKE 全表扫 |
| RRF 融合 | 0 | ~1ms | 纯内存计算 |
| rerank | 1 次 | 300-500ms | 20 块 → 3 块 |
| 生成 | 1 次 | 2-4s 流式 | 原逻辑 |

**单跳总新增**：2 次 LLM 调用 + ~800ms 延迟 → 总耗时约 3.5-5s。可接受。
**多跳（规划模式）**：规划 1 + rerank N(2-4) + 生成 1 → 约 4-8 次调用，总耗时 5-8s。对比类问题用户可接受。

**降级链**（NFR-4）：任一步失败 → 跳过该步 → 最终兜底为"纯向量 top3"（= 现在的行为），保证永远不倒退到"答不了"。

---

## 10. 实施步骤（分阶段落地）

| 阶段 | 操作 | 验证方式 |
|------|------|---------|
| A | 写 keyword-search.ts + hybrid-service.ts（双通道 + RRF）；vector-service 加 top_k 参数；CONFIG 加 CANDIDATE_POOL=20 | 用 /api/chat/debug 看混合检索 top20 结果；构造"KK-1024"类问题验证关键词通道命中 |
| B | 写 query-rewriter.ts；chat/route 接入（先于混合检索接入，产出 keywords） | debug 接口看改写结果；连续追问验证不跑题 |
| C | 重写 chunk-service（句子/标题感知）；加 heading_path 列；documents 重处理接口 | 抽查分块质量；重新处理旧文档；debug 看标题路径 |
| D | 写 reranker.ts；接入流水线尾部 | debug 看 rerank 前后排名变化；验证最终 top3 无重复主题 |
| E | 写 router.ts + planner.ts；chat/route 编排 | 对比类问题验证跨主题命中 |
| F | （可选）写 react-agent.ts；前端调试面板 | ReAct 测试集验证 ≤3 跳 |

**每个阶段完成后跑一遍全链路冒烟**：上传一份测试文档 → 问 5 个问题（1 个专有名词 + 1 个追问 + 1 个对比）→ 检查 debug 输出。

---

## 11. 风险与回滚

- **回滚策略**：所有新模块独立成文件，chat/route 里通过 CONFIG 开关控制 `ENABLE_HYBRID` / `ENABLE_RERANK` / `ENABLE_AGENTIC`，任一环节出问题只需关开关，立即回到旧链路（NFR-4 已保证）
- **503 高峰**（踩坑经验）：改写/rerank 调用包一层 `retry(1) + timeout(8s)`，超时走降级
- **JSON 解析**：所有 LLM 结构化输出统一走一个 `safeJsonParse` 工具函数，失败抛 null 触发降级
- **免费额度**：监控每日调用量，若超标把 rerank 候选池从 20 降为 10 或跳过改写（保留关键词提取）

---

# 第二部分：追平 2026 路线图（阶段 G~L）

> 第一部分（阶段 A~F）让你从 Naive RAG 走到 Advanced RAG + 入门 Agentic，对标 2024-2025 年主流水平。
> 本部分补上 **2026 年顶级的六大能力**，把项目从"检索质量好"推到"信息生命周期管理"的完整闭环。
>
> **2026 核心竞争维度已经转移**：摄取 → 索引 → 检索 → 生成 → 评估 → 记忆，全链路编排才是分水岭。

## 12. 阶段 G：评估体系（RAGAS + LLM-as-judge）—— 半天，质变点

### 12.1 为什么它排第一

**没有评估就没有迭代飞轮。** 后续所有阶段（CRAG / Self-RAG / GraphRAG）效果好不好，必须用数据说话——否则永远停留在"感觉变好了"的玄学阶段。这是"玩具"与"作品"的本质分界线。

### 12.2 核心概念：RAGAS 三大指标

| 指标 | 中文 | 问的是什么 | 简化版算法 |
|------|------|-----------|-----------|
| Faithfulness | 忠实度 | 回答有没有凭空捏造？ | 把回答拆成断言列表，逐个问 LLM "此断言在上下文中是否有依据"，有依据占比 |
| Answer Relevance | 答案相关性 | 答的是不是用户问的？ | LLM 对"答案-问题"匹配度打分（1~5） |
| Context Precision | 上下文精确率 | 检索的块到底准不准？ | 把每块检索结果逐个问 LLM "与问题相关吗"，相关块占比 |

> **类比**：这三个指标分别对应"没有瞎编"、"没有跑题"、"原料是对的"。缺任何一环，系统都是瘸腿的。

### 12.3 架构

```
scripts/eval.ts（离线评估脚本，不是 API）
   ├── 读取测试集 eval/questions.json
   │    （50 条：10 简单 + 10 专有名词 + 10 追问 + 10 对比 + 10 多跳）
   ├── 对每条：跑检索流水线（不生成）→ 得到 top3 块
   ├── LLM-as-judge（gemini-3.6-flash）打三个指标
   └── 输出 eval/report.md（表格：每条分数 + 平均值 + 环比对比）
```

**关键设计**：测试集是"黄金集"，一次建好长期复用。每个阶段做完跑一遍——分数涨了说明有效，跌了说明回退，这是全项目最重要的投资。

**工作量**：测试集 50 条（1-2 小时）+ 脚本 ~200 行 = **半天**。

## 13. 阶段 H：自适应路由升级（规则 → 分类器）—— 半天

### 13.1 为什么升级

规则路由（对比词/连接词）能覆盖 80% 的场景，但"如何评价 A 与 B 的关系"这种**隐式对比**会漏。2026 生产标配是 Adaptive RAG：用轻量判断器分流。

### 13.2 概念：Adaptive RAG

```
simple（单跳能答）   → 快速标准检索（不废话）
complex（多跳/对比/推理） → 完整 Agent 流程（不糊弄）
```

**这是 2026 最重要的生产模式**：保证简单问题不被 Agent 拖慢，复杂问题不被简单检索糊弄。

### 13.3 架构：router.ts 升级

```
规则快速判断（零成本）→ 命中规则直接走对应分支
规则未命中 → 一次 LLM 调用，输出 {"mode": "simple"|"complex", "reason": "..."}
```

**工作量**：~150 行，**半天**。

## 14. 阶段 I：CRAG 质量门控（检索后、生成前）—— 1 天

### 14.1 概念：Corrective RAG

在"检索完成"和"生成开始"之间加一道闸门，对上下文质量做**三态判断**：

```
correct（检索结果可靠）   → 直接用，进入生成
incorrect（检索跑题了）    → 换策略重搜：降阈值 / 换关键词 / 扩大候选池
ambiguous（模糊）         → 追加一次不同表述的检索，合并上下文再判断
```

> **类比**：点外卖前先看评价——差评多（incorrect）就换一家店；评价两极分化（ambiguous），先翻翻差评详情再决定。

### 14.2 架构

```
模块：crag-gate.ts
输入：问题 + 粗召回 top20 + rerank top3
一次 LLM 调用：{"verdict": "correct"|"incorrect"|"ambiguous", "reason": "..."}

correct   → 继续走生成
incorrect → 触发"补救检索"：关键词通道降阈值重搜 / 候选池 20→50
ambiguous → 追加一次不同表述的检索，合并上下文
```

**它补的是现有系统最大的盲区**："检索错了但系统不知道"。CRAG 是流水线内部的自愈机制（不是降级，降级是 NFR-4 的兜底）。

**工作量**：~200 行 + 1 天（含调试三态触发场景）。

## 15. 阶段 J：Self-RAG 反射令牌（生成侧质量自检）—— 1 天

### 15.1 概念

让模型在生成过程中自我检查，输出特殊令牌：

```
[Retrieve]       → 模型自主决定是否需要检索
[IsRelevant]     → 检索结果是否与问题相关
[IsSupported]    → 回答中的断言是否被证据支持
[IsUseful]       → 回答是否真正满足用户
```

> **类比**：写作文时的自我审稿——每写一段问自己"这段跟题目有关吗？有论据支撑吗？"

### 15.2 简化落地（prompt 版，不做微调版）

```
self-rag.ts：
  pre-check（生成前）：
    问题 → 判断是否需要检索；简单问题直接答，省一次检索调用
    （与阶段 H 的路由复用同一判断）
  post-check（生成后）：
    回答 + 引用来源 → {"supported": true/false, "unsupported_claims": [...]}
    若发现大量无依据断言 → 重新生成一次（最多 2 次），提示"只依据引用回答"
```

**工作量**：~250 行，**1 天**。

## 16. 阶段 K：GraphRAG 知识图谱（重头戏）—— 1-2 周

### 16.1 为什么是重头戏

**多跳准确率 23% → 87%** 的跃迁来自这里。它把知识从"文本块的相似度匹配"升级为"实体间的关系推理"——这是你目前**最大的知识盲区，也是最值钱的一课**。

### 16.2 核心概念（微软 GraphRAG 四步法）

```
① 实体抽取：LLM 从每个 chunk 提取（实体, 关系, 实体）三元组
   例：《报销制度》→ ("报销申请", "需要", "发票")、("财务部", "审批", "报销申请")
② 图构建：三元组存入图谱（我们简化：Supabase 两张关系表）
③ 社区检测：Leiden 算法聚类 → 每社区 LLM 生成摘要
   （简化版可跳过聚类，按文档/主题分组即可）
④ 双模式检索：
   本地搜索：从问题提取实体 → 查该实体的关系子图 → 命中实体周边文本
   全局搜索：社区摘要 → 回答"知识库整体上怎么说 X"类问题
```

### 16.3 架构（LightRAG 思路，不引图数据库）

**数据模型（Supabase 新增两张表）**：

```sql
-- 实体表
CREATE TABLE graph_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,               -- 实体名（如：财务部）
  type TEXT,                        -- 实体类型（如：部门/流程/文档）
  description TEXT,                 -- LLM 生成的实体描述
  chunk_id UUID REFERENCES document_chunks(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 关系表
CREATE TABLE graph_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES graph_entities(id),   -- 起点实体
  target_id UUID REFERENCES graph_entities(id),   -- 终点实体
  relation TEXT NOT NULL,            -- 关系（如：审批）
  description TEXT,                  -- 关系描述/证据文本
  chunk_id UUID REFERENCES document_chunks(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 图检索：SQL 自连接做一跳关系遍历
-- 例：查"财务部"相关的所有实体与关系
SELECT e2.name AS target, r.relation, r.description
FROM graph_entities e1
JOIN graph_relations r ON r.source_id = e1.id
JOIN graph_entities e2 ON e2.id = r.target_id
WHERE e1.name ILIKE '%' || :entity || '%';
```

**流程**：

```
摄取端：chunk → graph-extractor.ts（LLM 批量抽取三元组）→ 写入两张表
检索端：问题 → 提取问题实体（一次 LLM 调用）
       → SQL 查实体 + 一跳关系 → 拼成"子图文本"
       → 与混合检索结果合并
融合：vector + keyword + graph 三路 → RRF 融合 → rerank
```

**为什么用关系表而不是真图数据库（Neo4j）**：个人项目数据量（几百实体）用两张表 + SQL 自连接完全够，还能让你看清图检索的本质——**就是关系表的遍历**。Neo4j 是重武器，先懂原理再上。

**工作量**：抽取器 ~300 行 + 图检索 ~250 行 + 表结构 + 调试，**1-2 周（含学习时间，这是新范式）**。

## 17. 阶段 L：记忆系统入门（2026 新战场）—— 1-2 天

### 17.1 概念：四层记忆架构

| 层 | 名称 | 类比 | 我们怎么落地 |
|----|------|------|-------------|
| L1 | 模型记忆（参数 + KV 缓存） | CPU 缓存 | 模型厂商的事，用不上 |
| L2 | 工作记忆（上下文窗口） | RAM | 已有（多轮 history） |
| L3 | 外部记忆（向量库 + 图谱） | 磁盘 | 已有（知识库） |
| L4 | 认知记忆（反思 + 偏好） | 操作系统 | **本阶段做** |

### 17.2 简化落地

```sql
-- 对话持久化（Phase 3 遗留的 conversations/messages 表，终于落地）
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id),
  role TEXT NOT NULL,               -- user / assistant
  content TEXT NOT NULL,
  sources_json JSONB,               -- 引用来源快照
  created_at TIMESTAMPTZ DEFAULT now()
);
```

```
memory-store.ts：
  对话结束 → LLM 生成"会话摘要"存 user_memories 表
  每次问答前 → 检索相关历史偏好/摘要 → 注入 system prompt
```

**价值**：这是 2026 顶级玩家（MemGPT/Letta、Graphiti 时序图谱）的主战场。做了 L4 入门版，你就摸到了"长期记忆"的边，为将来读 MemGPT 论文打好底。

**工作量**：~300 行 + 建 2 张表，**1-2 天**。

## 18. 完整路线图总览（A~L）

| 阶段 | 内容 | 对标水平 | 工作量 | 质变点 |
|------|------|---------|--------|--------|
| A | 混合检索（双通道 + RRF） | Advanced RAG | 半天 | ⭐ |
| B | 查询改写 | Advanced RAG | 2-3 小时 | |
| C | 智能分块 | Advanced RAG | 2-3 小时 | |
| D | 粗召回 + rerank | Advanced RAG | 2-3 小时 | |
| E | 规划模式多跳 | Agentic RAG | 1 天 | ⭐ |
| F | ReAct 循环 | Agentic RAG | 1-2 天 | |
| G | 评估体系（RAGAS） | 生产标配 | 半天 | ⭐⭐ |
| H | 自适应路由 | 2026 主流 | 半天 | ⭐ |
| I | CRAG 质量门控 | 2026 主流 | 1 天 | ⭐ |
| J | Self-RAG 反射 | 前沿 | 1 天 | |
| K | GraphRAG 知识图谱 | 2026 前沿 | 1-2 周 | ⭐⭐⭐ |
| L | 记忆系统 | 2026 新战场 | 1-2 天 | ⭐ |

**合计**：约 3-6 周（按个人节奏）→ 摸到 2026 主线 80%。剩下 20% 是工程规模（千万级向量、分布式、多模态），属于企业级范畴，个人项目不需要。

## 19. 追平后的最终架构图

```
┌────────────── 摄取端（Ingestion）──────────────┐
│ 上传 → 解析(pdf/docx) → 智能分块(chunk)          │
│      → 向量化(embedding)                        │
│      → 实体抽取(GraphRAG) → 图入库              │
└────────────────────┬───────────────────────────┘
                     ▼
┌────────────── 检索端（Retrieval）───────────────┐
│ 问题 → 自适应路由(adaptive router)              │
│     ├─ simple → 改写 → 混合检索(向量+关键词)     │
│     ├─ complex → 规划/ReAct 多跳循环             │
│     └─ 图通道(实体子图检索)                      │
│ 融合：RRF 三路 → CRAG 质量门控 → rerank top3     │
└────────────────────┬───────────────────────────┘
                     ▼
┌────────────── 生成端（Generation）──────────────┐
│ chat-service：system prompt 组装                 │
│   + 记忆注入（L4 偏好/摘要）                      │
│   + Self-RAG 生成后自检（无依据断言重试）          │
│ 流式输出 SSE → 前端                              │
└────────────────────┬───────────────────────────┘
                     ▼
┌────────────── 评估端（Evaluation）──────────────┐
│ scripts/eval.ts：RAGAS 三指标 → report.md       │
│ 每次改动跑一遍 → 分数驱动迭代                     │
└─────────────────────────────────────────────────┘
```

**至此，项目覆盖完整的信息生命周期：摄取 → 索引 → 检索 → 生成 → 评估 → 记忆。** 这就是 2026 顶级系统的骨架——区别只剩规模和工程深度。
