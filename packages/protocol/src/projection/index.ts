/**
 * 投影模块门面 —— 三域纯函数（usage 合计 / instance 归组+锚 / trace 归一，
 * iter-20260821-dg90 T3.1 / CL-4：协议包从类型契约升级为类型+行为契约）。
 *
 * 纪律（TP-3.1d）：成员一律纯函数 + 纯数据形状——无 IO、framework-free、
 * 不 import node 内建、ws、daemon、shell 任何符号；daemon/shell/fake 三方共引
 * 单源（镜像实现即违反 AG-13 精神）。
 */
export * from "./usage";
export * from "./instance";
export * from "./trace";
