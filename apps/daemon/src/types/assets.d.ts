/**
 * 静态资产模块声明（bun text import 的 tsc 侧声明面）。
 *
 * bun 运行时/bun build --compile 原生支持 `import x from "./f.md" with
 * { type: "text" }`（dev 直跑与 compiled 产物同一嵌入通道）；tsc 侧需本
 * 声明让 .md 默认导入类型化为 string。消费点：pi-engine/runtime/prompts.ts
 * 提示词嵌入清单（EMBEDDED_PROMPTS）。
 */
declare module "*.md" {
  const content: string;
  export default content;
}
