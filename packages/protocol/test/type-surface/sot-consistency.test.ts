/**
 * sot-consistency：PROTOCOL.md ↔ @helix/protocol 导出 SoT 守护断言（T2.4，AD-4；
 * 断言口径 = PROTOCOL.md §17.3 五条；AC2.4「可演示」——每条断言的红演示证据
 * 落 docs/iterations/iter-20260820-qhv8/evidence/dev/T2.4/）。
 *
 * 守护面（文档 ↔ 代码不一致即红）：
 * ① 版本位一致：标题行 + §3 代码块版本字面量 == PROTOCOL_VERSION（§17.2② 单点律的文档面）；
 * ② 类型 presence：COMMAND_TYPES / EVENT_TYPES 每字面量在 §15/§16 有 `#### \`<type>\`` 登记锚；
 * ③ 计数一致：§15/§16 计数声明行数值 == 常量目录长度（22 / 40）；
 * ④ additive 字段 presence：anchorEntryId / tier / instanceId / draft / model 在对应登记表有字段行；
 * ⑤ 通道归属一致：§16 各族小节事件 type 集合 == EVENT_CHANNELS 对应通道值域。
 *
 * 粒度边界（§17.4 已裁决）：presence 级——字段改类型不改名不守护（字段级逐形状
 * diff 属生成式文档工具，转池不做）。
 *
 * 解析失败必须红（禁止静默通过）：以下全部解析 helper 在结构缺失时 throw
 * （标题/节标题/计数声明行/登记锚/族小节缺失 → 测试失败），永真断言 = 未生效。
 *
 * 位于 test/type-surface/（T3.4 随迁自 test/ 根；断言与解析逻辑原样）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES, PROTOCOL_VERSION } from "../../src/index";

const DOC = fileURLToPath(new URL("../../PROTOCOL.md", import.meta.url));

/** 读入文档（文件缺失/不可读 → throw = 红）。 */
function loadDoc(): string {
  const text = readFileSync(DOC, "utf8");
  if (text.trim() === "") throw new Error("PROTOCOL.md 解析失败：文档为空");
  return text;
}

/** 截取 [startRe 节标题, endRe 节标题) 的节文本（任一节标题缺失 → throw = 红）。 */
function section(doc: string, startRe: RegExp, endRe: RegExp): string {
  const start = doc.match(startRe);
  if (!start || start.index === undefined) throw new Error(`PROTOCOL.md 解析失败：未找到节标题 ${startRe}`);
  const end = doc.slice(start.index).match(endRe);
  if (!end || end.index === undefined) throw new Error(`PROTOCOL.md 解析失败：未找到 ${startRe} 节的结束节标题 ${endRe}`);
  return doc.slice(start.index, start.index + end.index);
}

/** 提取节内全部 `#### \`<type>\`` 登记锚（锚格式 §15/§16 钉死）。 */
function anchorsOf(sectionText: string): string[] {
  return [...sectionText.matchAll(/^#### `([^`]+)`/gm)].map((m) => m[1]!);
}

/** 节内唯一匹配（零命中或多命中 → throw = 红：声明行歧义即解析失败）。 */
function uniqueNumber(sectionText: string, re: RegExp, what: string): number {
  const hits = [...sectionText.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))];
  if (hits.length !== 1) throw new Error(`PROTOCOL.md 解析失败：${what} 声明行应恰有一条，实得 ${hits.length} 条`);
  return Number(hits[0]![1]);
}

/** §15（命令）/ §16（事件）登记节。 */
function commandRegistry(doc: string): string {
  return section(doc, /^## 15\. /m, /^## 16\. /m);
}
function eventRegistry(doc: string): string {
  return section(doc, /^## 16\. /m, /^## 17\. /m);
}

/** 定位登记锚小节文本（锚缺失 → throw = 红；小节止于下一 `####` 锚或 `###` 族小节标题）。 */
function anchorSection(registryText: string, anchor: string): string {
  const re = new RegExp(`^#### \`${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`$`, "m");
  const head = registryText.match(re);
  if (!head || head.index === undefined) throw new Error(`PROTOCOL.md 解析失败：未找到登记锚 \`#### \\\`${anchor}\\\`\``);
  const after = registryText.slice(head.index + head[0].length);
  const stop = after.match(/^#### |^### /m);
  return stop && stop.index !== undefined ? after.slice(0, stop.index) : after;
}

/** 登记锚小节的字段表行名集合（首列表格单元格 `` `field` ``）。 */
function fieldRowsOf(anchorText: string): Set<string> {
  return new Set([...anchorText.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!));
}

// ── ⑤ 解析：§16 族小节 → { 声明通道, 小节事件集 } ─────────────

interface FamilySection {
  channels: string[];
  events: string[];
}

/** 解析 §16 全部 `### 16.N <通道名…>族` 小节（无小节/标题无通道名 → throw = 红）。 */
function parseEventFamilies(doc: string): FamilySection[] {
  const sec16 = eventRegistry(doc);
  const heads = [...sec16.matchAll(/^### (16\.\d+) (.+)$/gm)];
  if (heads.length === 0) throw new Error("PROTOCOL.md 解析失败：§16 无 `### 16.N` 族小节");
  const sections: FamilySection[] = [];
  for (let i = 0; i < heads.length; i += 1) {
    const head = heads[i]!;
    // 标题通道段：`### 16.N <通道 · 通道 · …>（通道）?族…`——截到首个「族」前
    const titleMatch = head[2]!.match(/^([^族]*?)(?:通道)?族/);
    if (!titleMatch) throw new Error(`PROTOCOL.md 解析失败：§16 小节标题未声明族通道（${head[1]}）`);
    const channels = titleMatch[1]!.split("·").map((s) => s.trim()).filter((s) => s !== "");
    if (channels.length === 0 || channels.some((c) => c === "")) {
      throw new Error(`PROTOCOL.md 解析失败：§16 小节标题通道名为空（${head[1]}）`);
    }
    const bodyStart = head.index! + head[0].length;
    const bodyEnd = i + 1 < heads.length ? heads[i + 1]!.index! : sec16.length;
    sections.push({ channels, events: anchorsOf(sec16.slice(bodyStart, bodyEnd)) });
  }
  return sections;
}

describe("sot-consistency：PROTOCOL.md ↔ protocol 类型 SoT 守护（T2.4，AD-4；口径 = PROTOCOL.md §17.3）", () => {
  test("① 版本位一致：标题行与 §3 代码块版本字面量 == PROTOCOL_VERSION 导出值", () => {
    const doc = loadDoc();
    const title = doc.match(/^# .+ v(\d+(?:\.\d+)?)\s*$/m);
    if (!title) throw new Error("PROTOCOL.md 解析失败：标题行未找到 `# … vX.Y` 版本位");
    const sec3 = section(doc, /^## 3\. /m, /^## 4\. /m);
    const codeVer = sec3.match(/export const PROTOCOL_VERSION = "([^"]+)"/);
    if (!codeVer) throw new Error("PROTOCOL.md 解析失败：§3 代码块未找到 PROTOCOL_VERSION 导出行");
    expect(title[1]).toBe(PROTOCOL_VERSION);
    expect(codeVer[1]).toBe(PROTOCOL_VERSION);
  });

  test("② 类型 presence：COMMAND_TYPES / EVENT_TYPES 每字面量在 §15/§16 有登记锚", () => {
    const doc = loadDoc();
    const cmdAnchors = anchorsOf(commandRegistry(doc));
    const evtAnchors = anchorsOf(eventRegistry(doc));
    const missingCommands = COMMAND_TYPES.filter((t) => !cmdAnchors.includes(t));
    const missingEvents = EVENT_TYPES.filter((t) => !evtAnchors.includes(t));
    expect(missingCommands).toEqual([]);
    expect(missingEvents).toEqual([]);
  });

  test("③ 计数一致：§15/§16 计数声明行数值 == 常量目录长度", () => {
    const doc = loadDoc();
    const declaredCommands = uniqueNumber(commandRegistry(doc), /计数声明：(\d+) 命令全集/, "§15 命令计数");
    const declaredEvents = uniqueNumber(eventRegistry(doc), /计数声明：(\d+) 事件全集/, "§16 事件计数");
    expect(declaredCommands).toBe(COMMAND_TYPES.length);
    expect(declaredEvents).toBe(EVENT_TYPES.length);
  });

  test("④ additive 字段 presence：anchorEntryId / tier / instanceId / draft / model 在对应登记表有字段行", () => {
    const doc = loadDoc();
    const cmdRegistry = commandRegistry(doc);
    const evtRegistry = eventRegistry(doc);
    // (登记锚, 字段) presence 清单：v0.3/v0.4/§14 批次新增可选字段 + 首登必填字段（§17.3④）
    const required: ReadonlyArray<{ registry: "cmd" | "evt"; anchor: string; field: string }> = [
      { registry: "cmd", anchor: "chat.send", field: "draft" }, // §14.3（防 draft 零登记复发）
      { registry: "cmd", anchor: "chat.send", field: "model" }, // §14.2
      { registry: "cmd", anchor: "chat.steer", field: "instanceId" }, // §12.1 steer 定向寻址
      { registry: "cmd", anchor: "session.subscribe", field: "tier" }, // §12.2 monitor 档
      { registry: "evt", anchor: "agent.spawned", field: "anchorEntryId" }, // §12.1 spawn 锚
      { registry: "evt", anchor: "agent.instantiated", field: "instanceId" }, // §13.3
      { registry: "evt", anchor: "agent.model.changed", field: "instanceId" }, // §13.3
      { registry: "evt", anchor: "connection.welcome", field: "draft" }, // §14.1
      { registry: "evt", anchor: "connection.welcome", field: "model" }, // v0 首登（draft 同批位对照）
      // v0.6 批次（M6 T3 agent.config 族）：首登必填字段 presence（防零登记复发）
      { registry: "cmd", anchor: "agent.config.list", field: "profileKind" },
      { registry: "cmd", anchor: "agent.config.set_enabled", field: "profileKind" },
      { registry: "cmd", anchor: "agent.config.set_enabled", field: "resourceType" },
      { registry: "cmd", anchor: "agent.config.set_enabled", field: "name" },
      { registry: "cmd", anchor: "agent.config.set_enabled", field: "enabled" },
      { registry: "evt", anchor: "agent.config.changed", field: "profileKind" },
      { registry: "evt", anchor: "agent.config.changed", field: "resourceType" },
      { registry: "evt", anchor: "agent.config.changed", field: "name" },
      { registry: "evt", anchor: "agent.config.changed", field: "enabled" },
    ];
    const missing: string[] = [];
    for (const item of required) {
      const text = item.registry === "cmd" ? anchorSection(cmdRegistry, item.anchor) : anchorSection(evtRegistry, item.anchor);
      if (!fieldRowsOf(text).has(item.field)) missing.push(`\`${item.anchor}\` 缺字段行 \`${item.field}\``);
    }
    expect(missing).toEqual([]);
  });

  test("⑤ 通道归属一致：§16 各族小节事件 type 集合 == EVENT_CHANNELS 对应通道值域", () => {
    const doc = loadDoc();
    const families = parseEventFamilies(doc);
    const valueChannels = [...new Set(Object.values(EVENT_CHANNELS))];
    const channelDomain = new Map<string, string[]>(valueChannels.map((c) => [c, [] as string[]]));
    for (const [evt, ch] of Object.entries(EVENT_CHANNELS)) {
      channelDomain.get(ch)!.push(evt);
    }

    const violations: string[] = [];
    // (a) 小节声明的通道必须在 EVENT_CHANNELS 值域内（标题通道名漂移即红）
    for (const f of families) {
      for (const c of f.channels) {
        if (!channelDomain.has(c)) violations.push(`§16 小节声明通道 \`${c}\` 不在 EVENT_CHANNELS 值域`);
      }
    }
    // (b) 每个通道恰被一个小节认领（零认领/重复认领即红）
    for (const c of valueChannels) {
      const claims = families.filter((f) => f.channels.includes(c)).length;
      if (claims !== 1) violations.push(`通道 \`${c}\` 应恰被 1 个 §16 小节认领，实得 ${claims}`);
    }
    // (c) 双向恰等：小节事件集 == 其声明通道的值域并集（漏登/错挂/幽灵事件即红）
    for (const f of families) {
      const expected = new Set(f.channels.flatMap((c) => channelDomain.get(c) ?? []));
      const actual = new Set(f.events);
      for (const e of expected) if (!actual.has(e)) violations.push(`事件 \`${e}\` 未落在其通道所属 §16 小节`);
      for (const e of actual) if (!expected.has(e)) violations.push(`§16 小节事件 \`${e}\` 不属于该小节声明的通道值域`);
    }
    expect(violations).toEqual([]);
  });
});
