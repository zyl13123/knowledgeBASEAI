# MEMORY.md - 长期记忆

## 项目信息
- 项目名：knowledge-base-ai
- 路径：d:\next\knowledge-base-ai
- 技术栈：Next.js 16.3.0 + React 19.2.8 + TypeScript + Tailwind CSS v4 + pnpm
- 创建方式：pnpm create next-app@latest，参数 --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --turbopack
- 当前状态：create-next-app 初始模板，尚未添加自定义代码

## 部署状态
- 已推送 GitHub（zyl13123/knowledgeBASEAI），通过 Vercel 自动/手动部署
- Gemini 免费层模型配额问题：gemini-3.6-flash 仅 20次/天，gemini-2.5-flash 已对新用户下线，当前使用 gemini-3.1-flash-lite
- 每次 chat 请求消耗 3 次 Gemini 调用（query rewrite + rerank + answer），免费层配额消耗较快

## 移动端适配
- 2026-08-10 完成 app/page.tsx 移动端响应式适配
- 方案：左栏 aside 改为 fixed md:relative + translate-x 滑入/滑出抽屉，手机端通过汉堡按钮控制
- 所有固定 px 内边距改为 px-4 md:px-8 响应式

## 环境配置经验
- pnpm 需配置淘宝镜像源：`pnpm config set registry https://registry.npmmirror.com`，否则在国内下载 next 等大包会超时
- node_modules 实际 353 个包（pnpm .pnpm 目录结构），package.json 直接依赖仅 12 个
