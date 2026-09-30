/**
 * engine-shared/ —— 引擎中立声明与资产（W1b 拆分：设计 §7.1）。
 *
 * 五 profile 的提示词资源装载器（prompts.ts）与模板段库
 * （templates/：catalog/guide/validate + 三场景 md 片段）——纯声明与
 * 资产、零 pi import（不在 AG-04 白名单内即机械证明：引擎替换时这些
 * 声明不随 pi-engine 防腐墙死）。
 *
 * 依赖方向：pi-engine（防腐墙侧 profiles）→ 本目录；本目录不 import
 * 任何防腐墙/llm 文件。
 *
 * 本 barrel 是分区的公开面：分区外消费者从这里 import（分区内文件
 * 走相对直连）。validate.ts 是逻辑源码（非声明数据），仍受 AG-10
 * 模式词扫描覆盖（扫描根随本次拆分扩至本目录）。
 */

export * from "./prompts";
export * from "./templates/catalog";
export * from "./templates/guide";
export * from "./templates/validate";
