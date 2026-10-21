/**
 * llm/ —— 引擎中立层（Phase 0b 物理拆分，设计 §7.1）。
 *
 * pi-ai 栈的唯一所在：streamFn 工厂（model-provider）/ 网络重试
 * （network-retry）/ thinking 解析（thinking-resolve）/ 模型目录
 * （model-catalog）/ 自定义 provider 装配（custom-providers）。
 *
 * 定位：未来 helix-loop 替换 pi agent-loop 时（设计 Phase 6）本目录
 * 永存不动——死的只有 pi-engine/（agent-core 防腐墙）半边；替换半径
 * 因此收敛。pi-* import 只允许出现在本目录与 pi-engine/tools/subagent/
 * mcp/loop 等 AG-04 白名单根内。
 *
 * 本 barrel 是分区的公开面：分区外消费者从这里 import（分区内文件
 * 走相对直连）。
 */

export * from "./model-provider";
export * from "./network-retry";
export * from "./thinking-resolve";
export * from "./model-catalog";
export * from "./custom-providers";
export * from "./pi-auth";
