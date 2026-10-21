/**
 * zh-CN 默认词条包（AD-18；AG-16-② 完备性由 zh-CN.test.ts 守护）。
 *
 * 文案来自 prototype/review.md「P-1 文案 key 清单」（原型文案逐条对齐）；
 * 变量占位 {n}/{addr}/{code}；enterHint 的 [[x]] 标记渲染为 kbd 键帽。
 *
 * T1.1 起 Translations 类型由本文件词条结构推导（typeof zhCN，单一事实源，
 * 手写接口 types.ts 已删除；en-US 以 satisfies 对齐）。
 *
 * 词条按顶层业务域分片存放（zh-CN/<域>.ts、en-US/<域>.ts，域名即顶层键），
 * 本文件只做 spread 组装 barrel：消费面 import 路径与 Translations 类型推导不变。
 * 分片顶层键两两不相交由 domains.test.ts 守护（spread 静默覆盖防线）。
 */
import { chat } from "./zh-CN/chat";
import { trace } from "./zh-CN/trace";
import { agents } from "./zh-CN/agents";
import { pj } from "./zh-CN/pj";
import { tk } from "./zh-CN/tk";
import { workspace } from "./zh-CN/workspace";
import { steward } from "./zh-CN/steward";

export const zhCN = {
  ...chat,
  ...trace,
  ...agents,
  ...pj,
  ...tk,
  ...workspace,
  ...steward,
};

/** 词条结构即 i18n 类型单一事实源（T1.1：消手写接口 types.ts）。 */
export type Translations = typeof zhCN;
