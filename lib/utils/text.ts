// lib/utils/text.ts

/**
 * 剥掉 content 里的【章节路径: ...】前缀
 * 用于展示（用户不需要看到前缀）
 */
export function stripPrefix(content: string): string {
  return content.replace(/^【章节路径: [^】]+】\n/, '')
}