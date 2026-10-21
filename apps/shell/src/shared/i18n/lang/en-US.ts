/**
 * en-US 词条包（结构随迁；内容不在首迭代范围，AD-18 / brief「不做 en-US 词条内容」）。
 * 键集合与 zh-CN 一致性由 zh-CN.test.ts 守护；结构匹配由
 * `satisfies Translations` 编译期兜底（T1.1）。
 *
 * 词条按顶层业务域分片存放（zh-CN/<域>.ts、en-US/<域>.ts，域名即顶层键），
 * 本文件只做 spread 组装 barrel：消费面 import 路径与 Translations 类型推导不变。
 * 分片顶层键两两不相交由 domains.test.ts 守护（spread 静默覆盖防线）。
 */
import type { Translations } from "./zh-CN";

import { chat } from "./en-US/chat";
import { trace } from "./en-US/trace";
import { agents } from "./en-US/agents";
import { pj } from "./en-US/pj";
import { tk } from "./en-US/tk";
import { workspace } from "./en-US/workspace";
import { steward } from "./en-US/steward";

export const enUS = {
  ...chat,
  ...trace,
  ...agents,
  ...pj,
  ...tk,
  ...workspace,
  ...steward,
} satisfies Translations;
