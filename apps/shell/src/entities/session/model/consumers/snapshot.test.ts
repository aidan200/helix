/**
 * snapshot 消费者 · 重连合入并集语义（F3a 续修）。
 *
 * 钉住 mergeChannelItems：原实现 `live ?? rebuilt` 二选一整组取用——断连窗口内
 * daemon 侧新增行（SubAgent 新消息/工具/思考/closure 卡）被整组丢弃且后续快照
 * 持续不自愈。现按行身份并集：live 独有行原位保留，快照新行按快照序补入，
 * 同 id 行取快照内容但保 live seq（React key 稳定）。
 */
import { describe, expect, test } from "vitest";
import { mergeChannelItems } from "./snapshot";
import type { ChannelItem } from "../state";

const lc = (seq: number, key: "spawned" | "modelResolved" | "stalled"): ChannelItem => ({
  kind: "lifecycle",
  seq,
  lc: key,
  tone: "info",
});

const msg = (seq: number, text: string, ts: number): ChannelItem => ({
  kind: "message",
  seq,
  text,
  ts,
});

const closure = (seq: number): ChannelItem => ({
  kind: "closure",
  seq,
  closure: { summary: "收口", status: "ok" } as never,
});

describe("mergeChannelItems · 重连合入并集", () => {
  test("快照新行补入 + live 独有行保留（原实现整组丢弃快照新行）", () => {
    // live：spawned/modelResolved + 一条消息 + stalled（仅事件流有）
    const live: ChannelItem[] = [lc(1, "spawned"), lc(2, "modelResolved"), msg(3, "断连前", 100), lc(4, "stalled")];
    // 快照：spawned/modelResolved + 断连前那条 + 断连窗口内新到的消息 + closure 尾卡
    const snap: ChannelItem[] = [
      lc(1, "spawned"),
      lc(2, "modelResolved"),
      msg(3, "断连前", 100),
      msg(4, "断连窗口内新到", 200),
      closure(5),
    ];
    const { items } = mergeChannelItems(snap, live, 10);
    const shape = items.map((i) => {
      if (i.kind === "message") return `m:${i.text}`;
      if (i.kind === "lifecycle") return `lc:${i.lc}`;
      return i.kind;
    });
    expect(shape).toEqual([
      "lc:spawned",
      "lc:modelResolved",
      "m:断连前",
      "lc:stalled", // live 独有行原位保留（无快照对应行）
      "m:断连窗口内新到", // 快照新行排在 live 末行之后（时间上后到）
      "closure", // 快照 closure 尾卡补齐
    ]);
  });

  test("同 id 行取快照内容 + 保 live seq（React key 稳定）+ seq 唯一", () => {
    const live: ChannelItem[] = [lc(7, "spawned"), msg(8, "工具前文本", 100)];
    const snap: ChannelItem[] = [lc(1, "spawned"), msg(2, "工具前文本", 100), msg(3, "新行", 200)];
    const { items, nextSeq } = mergeChannelItems(snap, live, 20);
    // 已存在于 live 的行：seq 保持 7/8（不重排 key）
    expect(items[0]!.seq).toBe(7);
    expect(items[1]!.seq).toBe(8);
    // 快照新行取全局新号（≥ 传入 nextSeq）
    expect(items[2]!.seq).toBeGreaterThanOrEqual(20);
    // 全列表 seq 唯一（ChannelTimeline key 列表内唯一）
    const seqs = items.map((i) => i.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(nextSeq).toBeGreaterThan(Math.max(...seqs));
  });

  test("快照新行插位：早于 live 已存行的新行不被排到尾部（按快照序相对定位）", () => {
    // live 只保留了后段两行（更早行被快照预览截掉后由快照补回）
    const live: ChannelItem[] = [msg(9, "第三", 300), msg(10, "第四", 400)];
    const snap: ChannelItem[] = [msg(1, "第一", 100), msg(2, "第二", 200), msg(3, "第三", 300), msg(4, "第四", 400)];
    const { items } = mergeChannelItems(snap, live, 50);
    expect(items.map((i) => (i.kind === "message" ? i.text : i.kind))).toEqual(["第一", "第二", "第三", "第四"]);
  });
});
