// lib/chunking/smart-chunker.ts

export interface ChunkOptions {
  maxChunkSize?: number;      // 目标块最大字符数（推荐 400~600）
  chunkOverlap?: number;      // 块重叠大小（推荐 50~100）
  prependBreadcrumbs?: boolean; // 是否在内容前注入标题路径前缀
}

export interface ChunkResult {
  content: string;            // 带前缀的最终块内容（用于 Embedding 和 RAG Context）
  rawContent: string;         // 原始无前缀内容
  titlePath: string;          // 标题路径，例如: "一级标题 > 二级标题"
  chunkIndex: number;
  charCount: number;
}

/**
 * 智能 Markdown 分块核心算法
 */
export function smartChunkMarkdown(
  markdownText: string,
  docTitle: string = '',
  options: ChunkOptions = {}
): ChunkResult[] {
  const {
    maxChunkSize = 500,
    chunkOverlap = 60,
    prependBreadcrumbs = true,
  } = options;

  const lines = markdownText.split('\n');
  const sections: { titlePath: string; blocks: string[] }[] = [];

  // 当前标题栈：[{ level: 1, title: '公司制度' }, { level: 2, title: '报销流程' }]
  const currentHeaderStack: { level: number; title: string }[] = [];
  if (docTitle) {
    currentHeaderStack.push({ level: 0, title: docTitle });
  }

  let currentBlocks: string[] = [];
  let isInsideTable = false;
  let isInsideCodeBlock = false;
  let accumulatedTableOrCode: string[] = [];

  const getBreadcrumbs = () => currentHeaderStack.map((h) => h.title).join(' > ');

  const flushCurrentSection = () => {
    if (currentBlocks.length > 0) {
      sections.push({
        titlePath: getBreadcrumbs(),
        blocks: [...currentBlocks],
      });
      currentBlocks = [];
    }
  };

  // ============================================================
  // 1. 第一遍扫描：按 Markdown 标题切分 Section，保护表格与代码块
  // ============================================================
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 检查代码块界定符 ```
    if (trimmed.startsWith('```')) {
      if (isInsideCodeBlock) {
        // 代码块结束
        accumulatedTableOrCode.push(line);
        currentBlocks.push(accumulatedTableOrCode.join('\n'));
        accumulatedTableOrCode = [];
        isInsideCodeBlock = false;
      } else {
        // 代码块开始
        isInsideCodeBlock = true;
        accumulatedTableOrCode.push(line);
      }
      continue;
    }

    if (isInsideCodeBlock) {
      accumulatedTableOrCode.push(line);
      continue;
    }

    // 🔄 检查 Markdown 表格行（去掉 endsWith('|') 的要求，尾 | 可选）
    const isTableLine = trimmed.startsWith('|');
    if (isTableLine) {
      isInsideTable = true;
      accumulatedTableOrCode.push(line);
      continue;
    } else if (isInsideTable) {
      // 表格结束
      currentBlocks.push(accumulatedTableOrCode.join('\n'));
      accumulatedTableOrCode = [];
      isInsideTable = false;
    }

    // 🔄 检查标题行，用 trimmed 而不是 line（支持前导空格缩进的标题）
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      flushCurrentSection();
      const level = headerMatch[1].length;
      const title = headerMatch[2].trim();

      // 维护标题层级栈
      while (
        currentHeaderStack.length > 0 &&
        currentHeaderStack[currentHeaderStack.length - 1].level >= level &&
        currentHeaderStack[currentHeaderStack.length - 1].level !== 0
      ) {
        currentHeaderStack.pop();
      }
      currentHeaderStack.push({ level, title });

      // 🆕 标题行本身也加入块内容（避免标题词从 rawContent 里消失）
      currentBlocks.push(line);
      continue;
    }

    // 🔄 普通段落行：push 原始 line 而不是 trimmed，保留缩进
    if (trimmed.length > 0) {
      currentBlocks.push(line);
    }
  }

  // 收尾未闭合的结构
  if (accumulatedTableOrCode.length > 0) {
    currentBlocks.push(accumulatedTableOrCode.join('\n'));
  }
  flushCurrentSection();

  // ============================================================
  // 2. 第二遍扫描：将 Section 内的 blocks 组合并进行句子级分块
  // ============================================================
  const finalChunks: ChunkResult[] = [];
  let globalChunkIndex = 0;

  for (const section of sections) {
    let currentBuffer = '';

    const pushChunk = (rawText: string) => {
      const trimmed = rawText.trim();
      if (!trimmed) return;

      const prefix = prependBreadcrumbs && section.titlePath ? `【章节路径: ${section.titlePath}】\n` : '';
      const fullContent = `${prefix}${trimmed}`;

      finalChunks.push({
        content: fullContent,
        rawContent: trimmed,
        titlePath: section.titlePath,
        chunkIndex: globalChunkIndex++,
        charCount: fullContent.length,
      });
    };

    for (const block of section.blocks) {
      // 如果单个 block（如表格/长段落）已经超出了 maxChunkSize
      if (block.length > maxChunkSize) {
        // 先冲刷之前的 buffer
        if (currentBuffer) {
          pushChunk(currentBuffer);
          currentBuffer = '';
        }

        if (block.startsWith('|') || block.startsWith('```')) {
          // 🆕 表格/代码块：能整块保留就保留，超过 3 倍 maxChunkSize 才拆
          if (block.length <= maxChunkSize * 3) {
            pushChunk(block);
          } else {
            // 按行切，避免从行中间断开
            const blockLines = block.split('\n');
            let buf = '';
            for (const l of blockLines) {
              if (buf && (buf + '\n' + l).length > maxChunkSize) {
                pushChunk(buf);
                buf = l;
              } else {
                buf = buf ? `${buf}\n${l}` : l;
              }
            }
            if (buf) pushChunk(buf);
          }
        } else {
          // 普通超长段落：按标点符号断句并切分
          const sentenceChunks = splitParagraphIntoSentences(block, maxChunkSize, chunkOverlap);
          sentenceChunks.forEach((s) => pushChunk(s));
        }
        continue;
      }

      // 如果累加当前 block 后会超出大小限制，则切分
      if ((currentBuffer + '\n' + block).length > maxChunkSize) {
        pushChunk(currentBuffer);
        // 保留 overlap: 提取 buffer 尾部的句子作为新 buffer 的开头
        const overlapBuffer = extractTailOverlap(currentBuffer, chunkOverlap);
        currentBuffer = overlapBuffer ? `${overlapBuffer}\n${block}` : block;
      } else {
        currentBuffer = currentBuffer ? `${currentBuffer}\n${block}` : block;
      }
    }

    // 冲刷 Section 最后的 buffer
    if (currentBuffer) {
      pushChunk(currentBuffer);
    }
  }

  return finalChunks;
}

/**
 * 句子感知切分器：优先匹配中文句号、问号、感叹号及换行
 */
function splitParagraphIntoSentences(paragraph: string, maxSize: number, overlap: number): string[] {
  // 正则按中英文标点拆分（保留标点）
  const sentences = paragraph.match(/[^。！？!?\n]+[。！？!?\n]?/g) || [paragraph];
  const chunks: string[] = [];
  let temp = '';

  for (const s of sentences) {
    // 🆕 单句超长（无标点长句）→ 硬切兜底，避免 maxSize 失效
    if (s.length > maxSize) {
      if (temp) {
        chunks.push(temp);
        temp = '';
      }
      const step = Math.max(1, maxSize - overlap);
      for (let i = 0; i < s.length; i += step) {
        chunks.push(s.slice(i, i + maxSize));
        if (i + maxSize >= s.length) break;
      }
      continue;
    }

    if ((temp + s).length > maxSize) {
      if (temp) chunks.push(temp);
      temp = extractTailOverlap(temp, overlap) + s;
    } else {
      temp += s;
    }
  }
  if (temp) chunks.push(temp);
  return chunks;
}

/**
 * 提取文本末尾的重叠部分（按标点回退找完整句子）
 */
function extractTailOverlap(text: string, overlapSize: number): string {
  if (text.length <= overlapSize) return '';
  const tail = text.slice(-overlapSize);
  const firstPunctuation = tail.search(/[。！？!?\n]/);
  if (firstPunctuation !== -1 && firstPunctuation < tail.length - 1) {
    return tail.slice(firstPunctuation + 1).trim();
  }
  return tail.trim();
}