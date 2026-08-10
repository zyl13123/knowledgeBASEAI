# MEMORY.md - 长期记忆

## 项目信息
- 项目名：knowledge-base-ai
- 路径：d:\next\knowledge-base-ai
- 技术栈：Next.js 16.3.0 + React 19.2.8 + TypeScript + Tailwind CSS v4 + pnpm
- 创建方式：pnpm create next-app@latest，参数 --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --turbopack
- 当前状态：create-next-app 初始模板，尚未添加自定义代码

## 环境配置经验
- pnpm 需配置淘宝镜像源：`pnpm config set registry https://registry.npmmirror.com`，否则在国内下载 next 等大包会超时
- node_modules 实际 353 个包（pnpm .pnpm 目录结构），package.json 直接依赖仅 12 个
