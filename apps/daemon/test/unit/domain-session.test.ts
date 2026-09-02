import { describe, expect, test } from "bun:test";
import { Session } from "../../src/domain/session/Session";
import type { SessionSnapshot } from "../../src/domain/session/SessionSnapshot";

/**
 * TP-CL4-1 / TP-CL4-5（U 半）：会话聚合行为——
 * ① appendUserEntry→beginTurn→completeTurn→toSnapshot 往返；
 * ② restoreFrom(snapshot) 重建等价（重启恢复语义，AD-16）；
 * ③ 同 lane 防重入：open turn 未收尾前 beginTurn 抛领域错误；
 * ④ applySteer→SteerQueue 入队→turn 边界 drain 全链。
 */

describe("Session 会话聚合（TP-CL4-1 ①③）", () => {
  test("appendUserEntry 生成关联 entry；beginTurn 后重入抛错；completeTurn 收尾", () => {
    const s = Session.create("s-1");
    const user = s.appendUserEntry("你好");
    expect(user.role).toBe("user");
    expect(user.text).toBe("你好");

    const turn = s.beginTurn(user.id);
    expect(turn.inputEntryId).toBe(user.id);
    expect(turn.status).toBe("generating");

    // 同 lane 防重入：open turn 未 complete 前再 beginTurn 抛错
    expect(() => s.beginTurn("e-x")).toThrow();

    s.appendAssistantEntry("你好，有什么可以帮你？");
    const done = s.completeTurn();
    expect(done.status).toBe("completed");

    // 收尾后可开新轮
    const user2 = s.appendUserEntry("再来一轮");
    s.beginTurn(user2.id);
    s.completeTurn();
    expect(s.turnCount).toBe(2);
  });

  test("interruptTurn 把 open turn 标记中断（abort 语义）", () => {
    const s = Session.create("s-2");
    const u = s.appendUserEntry("长问题");
    s.beginTurn(u.id);
    const t = s.interruptTurn();
    expect(t.status).toBe("interrupted");
    expect(() => s.completeTurn()).toThrow(); // 已收尾
  });

  test("无 open turn 时 completeTurn/interruptTurn 抛错", () => {
    const s = Session.create("s-3");
    expect(() => s.completeTurn()).toThrow();
    expect(() => s.interruptTurn()).toThrow();
  });
});

describe("Session steer 全链（TP-CL4-1 ④）", () => {
  test("applySteer 入队（预分配 id 入队不落条目）→ drain 落盘（生效时机）逐条消费", () => {
    const s = Session.create("s-4");
    const u = s.appendUserEntry("写一首诗");
    s.beginTurn(u.id);
    const entriesBefore = s.toSnapshot().entries.length;

    const st1 = s.applySteer("改成散文");
    const st2 = s.applySteer("加上月亮");
    expect(typeof st1).toBe("string"); // 返回预分配 entryId
    expect(s.steerQueueSize).toBe(2);
    // 新语义：queued 期间不落时间轴条目（drain 时才进 entries）
    expect(s.toSnapshot().entries.length).toBe(entriesBefore);

    // one-at-a-time drain：turn 边界逐条取；drain 落盘 = 生效时机位置
    const d1 = s.dequeueSteer();
    expect(d1?.entryId).toBe(st1);
    expect(s.steerQueueSize).toBe(1);
    const drained = s.appendSteerEntryAtDrain(d1!);
    expect(drained.id).toBe(st1); // 预分配 id 同源落盘（D-2）
    expect(drained.isSteer).toBe(true);
    expect(s.toSnapshot().entries.length).toBe(entriesBefore + 1);

    s.appendAssistantEntry("（按注入调整后的回复）");
    s.completeTurn();
    expect(s.steerQueueSize).toBe(1); // 未消费的保留（等下一轮）

    // drainAll：turn 完成后可整批取余
    expect(s.drainAllSteer().map((x) => x.entryId)).toEqual([st2]);
    expect(s.steerQueueSize).toBe(0);
  });

  test("无 open turn 时 applySteer 抛错（steer 只在运行中合法）", () => {
    const s = Session.create("s-5");
    expect(() => s.applySteer("没有轮次")).toThrow();
  });
});

describe("D-2：entry id 预分配（reserveEntryId / appendAssistantEntry reservedId）", () => {
  test("reserveEntryId 唯一，后续 appendUserEntry 得到下一个 id（预分配不碰撞）", () => {
    const s = Session.create("s-reserve");
    const r1 = s.reserveEntryId();
    const r2 = s.reserveEntryId();
    expect(r1).not.toBe(r2);

    const u = s.appendUserEntry("紧跟的输入");
    expect(u.id).not.toBe(r1);
    expect(u.id).not.toBe(r2); // 预分配消耗的序号不复用
    expect(Number.parseInt(u.id.slice(1), 10)).toBeGreaterThan(Number.parseInt(r2.slice(1), 10));
  });

  test("appendAssistantEntry(text, at, reservedId) 以 reservedId 落条目", () => {
    const s = Session.create("s-reserve2");
    const u = s.appendUserEntry("问");
    s.beginTurn(u.id);
    const reserved = s.reserveEntryId();
    const a = s.appendAssistantEntry("答", "2026-08-15T00:00:01.000Z", reserved);
    expect(a.id).toBe(reserved);
    expect(a.createdAt).toBe("2026-08-15T00:00:01.000Z");
    expect(s.entryList().at(-1)!.id).toBe(reserved);
    s.completeTurn();

    // 预分配之后正常续分配不碰撞
    const u2 = s.appendUserEntry("再问");
    expect(u2.id).not.toBe(reserved);
  });

  test("id 空洞（放弃的预留不回收）下 restoreFrom 计数器重建正常", () => {
    const s = Session.create("s-hole");
    const u = s.appendUserEntry("q"); // e1
    s.beginTurn(u.id);
    s.reserveEntryId(); // e2 放弃（空洞）
    s.reserveEntryId(); // e3 放弃（空洞）
    s.appendAssistantEntry("a"); // e4
    s.completeTurn();

    const restored = Session.restoreFrom(s.toSnapshot());
    const next = restored.appendUserEntry("重启后的新输入");
    expect(next.id).toBe("e5"); // 从 max(e4) 重建，不复用空洞
    expect(restored.entryList().map((e) => e.id)).toEqual(["e1", "e4", "e5"]);
  });
});

describe("Session.isEmpty 草稿判定（TP-1.2a：任何条目皆无才空，含 thinking/compaction）", () => {
  test("零条目 → true（新建即空草稿）", () => {
    const s = Session.create("s-empty");
    expect(s.isEmpty()).toBe(true);
  });

  test("含用户条目 → false", () => {
    const s = Session.create("s-user");
    s.appendUserEntry("第一句");
    expect(s.isEmpty()).toBe(false);
  });

  test("仅 thinking 条目 → false（entries 非空即非草稿）", () => {
    const s = Session.create("s-thinking");
    s.appendThinkingEntry({
      kind: "thinking",
      instanceId: "main",
      text: "推理中…",
      durationMs: 120,
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    expect(s.isEmpty()).toBe(false);
  });

  test("仅 compaction 条目 → false（entries 非空即非草稿）", () => {
    const s = Session.create("s-compaction");
    s.appendCompactionEntry({
      kind: "compaction",
      instanceId: "main",
      tokensBefore: 340_000,
      tokensAfter: 20_000,
      summary: "早期对话压缩摘要",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 },
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    expect(s.isEmpty()).toBe(false);
  });
});

describe("Session 快照往返（TP-CL4-1 ①②）", () => {
  test("toSnapshot→restoreFrom 重建等价（entries/turns/steer 队列/计数器）", () => {
    const s = Session.create("s-snap");
    const u1 = s.appendUserEntry("第一问");
    s.beginTurn(u1.id);
    const st = s.applySteer("补充一点");
    s.appendAssistantEntry("第一答");
    s.completeTurn();
    const u2 = s.appendUserEntry("第二问");
    s.beginTurn(u2.id);
    s.appendAssistantEntry("第二答（进行到一半）");

    const snap: SessionSnapshot = s.toSnapshot();

    const restored = Session.restoreFrom(snap);
    expect(restored.id).toBe(s.id);
    expect(restored.toSnapshot()).toEqual(snap); // 重建后再快照 → 深等价

    // 重建后行为延续：计数器不回卷、可继续完成中断的轮次
    const r2 = restored.completeTurn();
    expect(r2.status).toBe("completed");
    const u3 = restored.appendUserEntry("恢复后的新消息");
    expect(u3.id).not.toBe(u2.id); // id 序列延续
    restored.beginTurn(u3.id);
    expect(restored.turnCount).toBe(3);

    // steer 队列经快照存活（spike ④：steerQueueSurvivesCrash）；
    // 新语义：queued 不落条目——预分配 entryId 随队列快照往返
    const s2 = Session.create("s-snap2");
    const u = s2.appendUserEntry("x");
    s2.beginTurn(u.id);
    const queued = s2.applySteer("等恢复后注入");
    expect(Session.restoreFrom(s2.toSnapshot()).dequeueSteer()?.entryId).toBe(queued);
    // drain 落盘后的条目才是 isSteer entry
    expect(typeof st).toBe("string");
  });
});
