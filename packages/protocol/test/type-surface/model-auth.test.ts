/**
 * model/auth 族类型面（源 TP-v0.2-②；类型级断言 + 负向编译守护承载文件）。
 *
 * 旧文件按版本批次组织，model/auth 无独立运行时用例——其运行时契约事实由
 * catalog（全事件遍历）/ envelope（model.changed 章印）承载；本文件守护
 * model 通道分族类型面（_ModelFamily）与 auth.set_key 必填字段负向样例。
 */
import type { AuthSetKeyCommand, EventEnvelope } from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──
type _ModelFamily = Expect<
  Equal<
    TypeOfChannel<"model">,
    | "model.changed"
    | "model.get.result"
    | "model.catalog.result"
    | "model.catalog_refresh.result"
    | "model.set_default.result"
    | "model.set_thinking_default.result"
    | "model.get_default.result"
    | "auth.list.result"
    | "auth.set_key.result"
    | "auth.delete_key.result"
    | "auth.verify.result"
  >
>;

// ── 负向断言（编译期守护指令；运行时字面量回读见对应 test） ──
// 负向断言（v0.2）：auth.set_key 缺 apiKey
// @ts-expect-error apiKey 必填
const badSetKey: AuthSetKeyCommand = { v: "0.11", type: "auth.set_key", payload: { providerId: "moonshot" } };
