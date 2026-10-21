/**
 * i18n 词条域分片守护（体量门 P6：zh-CN.ts / en-US.ts 按业务域分片重构）：
 *
 * 每个分片（lang/<语言>/<域>.ts）导出「单顶层键包装对象」——顶层键即域名，
 * barrel（lang/zh-CN.ts、lang/en-US.ts）以 spread 组装。spread 是后写覆盖
 * 前写的静默语义：某域文件里混入他域顶层键时零编译错误、零测试红，只是
 * 悄悄吃掉另一个域的同名键。本测试守护三件事：
 * ① 分片顶层键恰一个且等于自身域名（分片不许跨界）；
 * ② 七域分片顶层键两两不相交（spread 静默覆盖防线）；
 * ③ barrel 组装结果 == 分片并集（不漏拼、不多拼；键序保持域声明序）。
 */
import { describe, expect, it } from "vitest";
import { zhCN } from "./zh-CN";
import { enUS } from "./en-US";
import { chat as zhChat } from "./zh-CN/chat";
import { trace as zhTrace } from "./zh-CN/trace";
import { agents as zhAgents } from "./zh-CN/agents";
import { pj as zhPj } from "./zh-CN/pj";
import { tk as zhTk } from "./zh-CN/tk";
import { workspace as zhWorkspace } from "./zh-CN/workspace";
import { steward as zhSteward } from "./zh-CN/steward";
import { chat as enChat } from "./en-US/chat";
import { trace as enTrace } from "./en-US/trace";
import { agents as enAgents } from "./en-US/agents";
import { pj as enPj } from "./en-US/pj";
import { tk as enTk } from "./en-US/tk";
import { workspace as enWorkspace } from "./en-US/workspace";
import { steward as enSteward } from "./en-US/steward";

type Shard = Record<string, unknown>;

const ZH_SHARDS: Record<string, Shard> = {
  chat: zhChat,
  trace: zhTrace,
  agents: zhAgents,
  pj: zhPj,
  tk: zhTk,
  workspace: zhWorkspace,
  steward: zhSteward,
};

const EN_SHARDS: Record<string, Shard> = {
  chat: enChat,
  trace: enTrace,
  agents: enAgents,
  pj: enPj,
  tk: enTk,
  workspace: enWorkspace,
  steward: enSteward,
};

const DOMAINS = Object.keys(ZH_SHARDS);

describe.each([
  ["zh-CN", ZH_SHARDS, zhCN as Shard],
  ["en-US", EN_SHARDS, enUS as Shard],
])("%s 域分片结构", (lang, shards, barrel) => {
  it("每个分片顶层键恰一个且等于域名（分片不跨界）", () => {
    const offenders = DOMAINS.filter((domain) => {
      const keys = Object.keys(shards[domain]!);
      return keys.length !== 1 || keys[0] !== domain;
    }).map((domain) => `${domain}: ${Object.keys(shards[domain]!).join(",")}`);
    expect(offenders, `${lang} 分片顶层键与域名不符`).toEqual([]);
  });

  it("七域分片顶层键两两不相交（spread 静默覆盖防线）", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const domain of DOMAINS) {
      for (const key of Object.keys(shards[domain]!)) {
        const owner = seen.get(key);
        if (owner !== undefined) collisions.push(`${key}（${owner} 与 ${domain} 同时提供）`);
        else seen.set(key, domain);
      }
    }
    expect(collisions, `${lang} 分片顶层键相撞——barrel spread 会静默覆盖`).toEqual([]);
  });

  it("barrel == 分片并集（不漏拼/不多拼，键序保持域声明序）", () => {
    const assembled = DOMAINS.flatMap((domain) => Object.keys(shards[domain]!));
    expect(Object.keys(barrel)).toEqual(assembled);
  });
});

describe("双语域面对齐", () => {
  it("zh-CN 与 en-US 顶层域键集一致", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
  });
});
