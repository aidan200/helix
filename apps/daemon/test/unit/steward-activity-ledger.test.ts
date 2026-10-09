/**
 * 管家活动账（M3-d1 感知兑现批）单测——StewardActivityService + 真库 store。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. 活动账条目化：六类 ring 条目（agent 终态三 kind 一类 / 周期进展 / 任务
 *    终态 / 分诊摄入 / 表面事件 / 回合终态）→ 统一模型 {at,domain,attribution,text}
 *    转换 + attribution 归一规则（agent=system、surface=origin 三值映射、
 *    管家自产=steward）+ TR-249 白话铁律（禁 UUID/英文报错原文）；
 * 2. notify 记账：notify 发出 → domain=notify / attribution=steward 白话条目；
 * 3. cli: 域标签：noteCliSession 后该会话条目 domain="cli" + 终端白话行文；
 * 4. 落盘可回看可清理：真库 append → 重开可查（时间窗过滤 + limit）→ clear；
 *    store 失败降级纯内存（回看降级、记录不丢）；
 * 5. 实时帧出口：条目落账 → emit 逐条发出（seq 连接内单调）；
 * 6. 感知接线：StewardPerceptionService.onRingEntry → 账本（六类条目沉淀零新采集）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StewardActivityService, ringEntryToActivity, notifyToActivity, plainTalkOf, ACTIVITY_LEDGER_MEMORY_LIMIT } from "../../src/application/steward/StewardActivityService";
import type { StewardActivityStorePort } from "../../src/application/ports/outbound/StewardActivityStorePort";
import { SqliteActivityLedgerStore, ACTIVITY_LEDGER_STORE_LIMIT } from "../../src/adapters/driven/steward-memory/SqliteActivityLedgerStore";
import { StewardPerceptionService, type PerceptionRingEntry } from "../../src/application/steward/StewardPerceptionService";
import { buildContextSnapshot } from "../../src/application/steward/StewardService";
import type { StewardActivityPayload } from "@helix/protocol";

// TR-152：tmpdir 登记回收
const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const FIXED_NOW = 1_760_000_000_000;
const clock = () => FIXED_NOW;

function ringEntry(over: Partial<PerceptionRingEntry> & Pick<PerceptionRingEntry, "kind" | "sessionId">): PerceptionRingEntry {
  return { at: FIXED_NOW, text: "", ...over };
}

// ── 1. 六类 ring 条目 → 统一模型（纯转换函数） ───────────────

describe("活动账①条目化：六类 ring 条目 → {at,domain,attribution,text}", () => {
  const notCli = (_sid: string) => false;

  test("agent 终态（一类三 kind）：domain=agent / attribution=system / 白话行文", () => {
    const done = ringEntryToActivity(
      ringEntry({ kind: "agent.completed", sessionId: "task:job-1", agentId: "agent-x1", text: "完成了光球动画的调色工作" }),
      notCli,
    );
    expect(done.domain).toBe("agent");
    expect(done.attribution).toBe("system");
    expect(done.at).toBe(FIXED_NOW);
    expect(done.text).toContain("后台有个帮手干完了一件事");
    expect(done.text).toContain("光球动画");

    const failed = ringEntryToActivity(
      ringEntry({ kind: "agent.failed", sessionId: "task:job-1", agentId: "agent-x2", text: "Error: ENOENT 9af3c2d1b7e4" }),
      notCli,
    );
    expect(failed.attribution).toBe("system");
    expect(failed.text).not.toContain("ENOENT"); // 英文报错原文禁入
    expect(failed.text).not.toContain("9af3c2d1b7e4"); // UUID/十六进制串禁入
    expect(failed.text).toContain("没能完成任务");

    const killed = ringEntryToActivity(ringEntry({ kind: "agent.killed", sessionId: "task:job-1", agentId: "agent-x3", text: "" }), notCli);
    expect(killed.text).toContain("被停掉了");
  });

  test("周期进展 ping：domain=session / attribution=system / 白话前缀", () => {
    const e = ringEntryToActivity(ringEntry({ kind: "progress.ping", sessionId: "s-main", text: "第一批测试已经跑绿了" }), notCli);
    expect(e.domain).toBe("session");
    expect(e.attribution).toBe("system");
    expect(e.text).toContain("工作有了新进展");
    expect(e.text).toContain("测试已经跑绿");
  });

  test("任务终态：domain=task / attribution=system / 标题白话行文（无 UUID）", () => {
    const e = ringEntryToActivity(
      ringEntry({ kind: "task.terminal", sessionId: "task:job-9f3a", jobId: "job-9f3a", title: "登录超时修复", text: "任务 job-9f3a 终态：done" }),
      notCli,
    );
    expect(e.domain).toBe("task");
    expect(e.attribution).toBe("system");
    expect(e.text).toContain("登录超时修复");
    expect(e.text).toContain("完成了");
    expect(e.text).not.toContain("job-9f3a"); // 任务 id 不进白话
    // 无标题回落
    const bare = ringEntryToActivity(ringEntry({ kind: "task.terminal", sessionId: "task:j", jobId: "j", text: "任务 j 终态：failed" }), notCli);
    expect(bare.text).toContain("后台任务");
    expect(bare.text).toContain("失败了");
  });

  test("分诊摄入（管家自产动作）：domain=task / attribution=steward——CAND-607 selfRef 并入解决", () => {
    const e = ringEntryToActivity(ringEntry({ kind: "task.diagnosed", sessionId: "s-1", text: "回复都处理完了，两轮测试全绿" }), notCli);
    expect(e.domain).toBe("task");
    expect(e.attribution).toBe("steward");
    expect(e.text).toContain("管家汇报");
    expect(e.text).toContain("测试全绿");
    // 空文本回落固定白话句
    const empty = ringEntryToActivity(ringEntry({ kind: "task.diagnosed", sessionId: "s-1", text: "" }), notCli);
    expect(empty.text).toContain("管家汇报了最新情况");
  });

  test("表面事件：domain=surface / attribution=origin 三值归一 + kind 白话映射", () => {
    const user = ringEntryToActivity(
      ringEntry({ kind: "surface.event", sessionId: "shell:c1:chat", text: "user_click {}", origin: "user", surfaceKind: "user_click" }),
      notCli,
    );
    expect(user.domain).toBe("surface");
    expect(user.attribution).toBe("user");
    expect(user.text).toContain("在界面上点了一下");

    const steward = ringEntryToActivity(
      ringEntry({ kind: "surface.event", sessionId: "shell:c1:chat", text: "navigated", origin: "steward", surfaceKind: "navigated" }),
      notCli,
    );
    expect(steward.attribution).toBe("steward");
    expect(steward.text).toContain("切换到了别的页面");

    const sys = ringEntryToActivity(
      ringEntry({ kind: "surface.event", sessionId: "shell:c1:chat", text: "idle", origin: "system", surfaceKind: "idle" }),
      notCli,
    );
    expect(sys.attribution).toBe("system");
    expect(sys.text).toContain("界面有一会儿没动静了");
    // origin 缺席（旧条目）→ 缺省 user（M0 shell 页面事件恒 user）
    const legacy = ringEntryToActivity(
      ringEntry({ kind: "surface.event", sessionId: "shell:c1:chat", text: "activated", surfaceKind: "activated" }),
      notCli,
    );
    expect(legacy.attribution).toBe("user");
    expect(legacy.text).toContain("打开了应用界面");
  });

  test("回合终态：domain=session / attribution=system / 白话句（原文技术形态不进 text）", () => {
    const e = ringEntryToActivity(ringEntry({ kind: "turn.completed", sessionId: "s-2", text: "回合结束（done #a1b2c3d4）" }), notCli);
    expect(e.domain).toBe("session");
    expect(e.attribution).toBe("system");
    expect(e.text).toContain("有一个对话回完了");
    expect(e.text).not.toContain("a1b2c3d4");
  });

  test("plainTalkOf：十六进制/UUID 串剥除 + 空白归一 + 截断省略号", () => {
    expect(plainTalkOf("修好了 9af3c2d1b7e4 的崩溃", 20)).toBe("修好了 的崩溃");
    expect(plainTalkOf("   多  空白  ", 20)).toBe("多 空白");
    expect(plainTalkOf("一二三四五", 3)).toBe("一二三…");
    expect(plainTalkOf("0xdeadBEEF12345678", 20)).toBe("");
  });
});

// ── 2. notify 记账 + 3. cli 域标签 ─────────────────────────

describe("活动账②notify 记账 + cli 域标签", () => {
  test("notify 发出时记账：domain=notify / attribution=steward / 白话", () => {
    const e = notifyToActivity({ at: FIXED_NOW, title: "后台任务", body: "任务完成了" });
    expect(e.domain).toBe("notify");
    expect(e.attribution).toBe("steward");
    expect(e.text).toContain("后台任务");
    expect(e.text).toContain("任务完成了");
  });

  test("cli: 域标签：noteCliSession 后该会话条目归组 cli + 终端行文", () => {
    const svc = new StewardActivityService({ clock });
    svc.noteCliSession("s-cli");
    svc.recordRingEntry(ringEntry({ kind: "turn.completed", sessionId: "s-cli", text: "回合结束（done）" }));
    svc.recordRingEntry(ringEntry({ kind: "turn.completed", sessionId: "s-gui", text: "回合结束（done）" }));
    const entries = svc.recent(10);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.domain).toBe("cli");
    expect(entries[0]!.text).toContain("终端里的对话回完了");
    expect(entries[1]!.domain).toBe("session");
    expect(entries[1]!.text).not.toContain("终端");
  });
});

// ── 4. 落盘可回看可清理（真库） + 5. 实时帧 ─────────────────

function memoryStore(): StewardActivityStorePort & { appended: unknown[] } {
  const appended: unknown[] = [];
  return {
    appended,
    append: (e) => appended.push(e),
    listWindow: () => [],
    clear: () => appended.splice(0),
  };
}

/** 抛错 store（开库失败/写失败形态——降级纯内存）。 */
function brokenStore(): StewardActivityStorePort {
  return {
    append: () => {
      throw new Error("db locked");
    },
    listWindow: () => {
      throw new Error("db locked");
    },
    clear: () => {
      throw new Error("db locked");
    },
  };
}

describe("活动账④落盘回看与清理（SqliteActivityLedgerStore 真库）", () => {
  test("append → 重开可查：时间窗过滤 + limit + 倒序上限（at 降序取最近）", () => {
    const dir = mkdtempSync(join(tmpdir(), "helix-activity-ledger-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "steward_memory.db");
    const store = new SqliteActivityLedgerStore(dbPath);
    store.append({ at: 1000, domain: "task", attribution: "system", text: "「修登录」完成了" });
    store.append({ at: 2000, domain: "session", attribution: "system", text: "有一个对话回完了" });
    store.append({ at: 3000, domain: "notify", attribution: "steward", text: "管家通知「后台任务」：任务完成了" });
    store.close();
    // 重开（重启后可查）
    const reopened = new SqliteActivityLedgerStore(dbPath);
    const all = reopened.listWindow({ sinceMs: 0, limit: 100 });
    expect(all).toHaveLength(3);
    expect(all[0]!.text).toBe("管家通知「后台任务」：任务完成了"); // 最新在前
    const windowed = reopened.listWindow({ sinceMs: 1500, limit: 100 });
    expect(windowed).toHaveLength(2);
    expect(windowed.every((e) => e.at >= 1500)).toBe(true);
    const limited = reopened.listWindow({ sinceMs: 0, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0]!.at).toBe(3000); // limit 取最近
    reopened.clear();
    expect(reopened.listWindow({ sinceMs: 0, limit: 100 })).toHaveLength(0);
    reopened.close();
  });

  test("条目上限：超 ACTIVITY_LEDGER_STORE_LIMIT 的旧条目滚动淘汰（可回看有界）", () => {
    const store = new SqliteActivityLedgerStore(":memory:");
    for (let i = 0; i < ACTIVITY_LEDGER_STORE_LIMIT + 300; i += 1) {
      store.append({ at: i, domain: "session", attribution: "system", text: `条目${i}` });
    }
    const all = store.listWindow({ sinceMs: 0, limit: 100_000 });
    expect(all.length).toBeLessThanOrEqual(ACTIVITY_LEDGER_STORE_LIMIT + 100);
    expect(all[0]!.text).not.toBe("条目0"); // 最老段已淘汰
    store.close();
  });

  test("store 失败降级纯内存：append 抛错不炸主链路、recent 照常、回看降级空窗", () => {
    const warns: string[] = [];
    const svc = new StewardActivityService({ store: brokenStore(), clock, logger: { warn: (m) => warns.push(m) } });
    expect(() => svc.recordRingEntry(ringEntry({ kind: "turn.completed", sessionId: "s", text: "x" }))).not.toThrow();
    expect(svc.recent(10)).toHaveLength(1); // 内存镜像在
    expect(warns.length).toBeGreaterThan(0); // 降级可观测
    expect(() => svc.listWindow({ sinceMs: 0, limit: 10 })).not.toThrow();
    expect(() => svc.clear()).not.toThrow();
  });

  test("store 缺席（未装配）：纯内存形态（记录 + recent + 内存窗查询 + 清理）", () => {
    const svc = new StewardActivityService({ clock: () => 5000 });
    svc.recordRingEntry(ringEntry({ kind: "task.terminal", sessionId: "task:j", jobId: "j", title: "修复", text: "t", at: 4000 }));
    svc.recordNotify({ title: "后台任务", body: "任务完成了" });
    expect(svc.recent(10)).toHaveLength(2);
    const windowed = svc.listWindow({ sinceMs: 4500, limit: 10 });
    expect(windowed).toHaveLength(1); // notify 条目 at=5000
    svc.clear();
    expect(svc.recent(10)).toHaveLength(0);
  });

  test("内存镜像滚动上限：recent 超窗截尾保最新", () => {
    const svc = new StewardActivityService({ clock: () => 0 });
    for (let i = 0; i < ACTIVITY_LEDGER_MEMORY_LIMIT + 20; i += 1) {
      svc.recordNotify({ title: "后台任务", body: `第${i}条通知` });
    }
    const recent = svc.recent(1000);
    expect(recent.length).toBeLessThanOrEqual(ACTIVITY_LEDGER_MEMORY_LIMIT);
    expect(recent[recent.length - 1]!.text).toContain(`第${ACTIVITY_LEDGER_MEMORY_LIMIT + 19}条通知`);
  });
});

describe("活动账⑤实时帧出口", () => {
  test("条目落账 → emit 逐条发出（载荷同形 + seq 单调）", () => {
    const frames: StewardActivityPayload[] = [];
    const svc = new StewardActivityService({ clock, emit: (p) => frames.push(p) });
    svc.recordRingEntry(ringEntry({ kind: "turn.completed", sessionId: "s", text: "x" }));
    svc.recordNotify({ title: "后台任务", body: "任务完成了" });
    expect(frames).toHaveLength(2);
    expect(frames[0]!.domain).toBe("session");
    expect(frames[0]!.text).toContain("对话回完了");
    expect(frames[1]!.domain).toBe("notify");
    expect(frames[1]!.seq).toBeGreaterThan(frames[0]!.seq);
  });
});

// ── 6. 感知接线：ring 沉淀（零新采集面） ─────────────────────

describe("活动账⑥感知接线：StewardPerceptionService.onRingEntry → 账本", () => {
  test("onRingEntry 回调挂接：域事件入 ring 的同时沉淀账本（六类条目零新采集）", () => {
    const svc = new StewardActivityService({ clock });
    const perception = new StewardPerceptionService({
      feedGate: { hasStewardSubscribers: () => false },
      onRingEntry: (entry) => svc.recordRingEntry(entry),
      clock,
    });
    perception.onDomainEvent({
      type: "agent.completed",
      sessionId: "s-1",
      payload: { agentId: "agent-a", closure: { summary: "改完了配色方案" } },
      occurredAt: "2026-10-09T00:00:00.000Z",
    } as never);
    perception.onJobTerminal("job-77", "done", "界面打磨");
    const entries = svc.recent(10);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toContain("改完了配色方案");
    expect(entries[1]!.domain).toBe("task");
    expect(entries[1]!.text).toContain("界面打磨");
    expect(entries[1]!.text).toContain("完成了");
  });

  test("感知→账本→投影全链：buildContextSnapshot(recentActivity=svc.recent) 含 ring 现场白话行", () => {
    // 完成标准验收链：ask 管家「刚才什么情况」时，快照段真实携带感知条目
    //（哪轮完成/哪个任务终态/哪些活动）——StewardService 消费 recentActivity
    // 的注入面在 steward-service-a2 批断言，此处断言数据链本身。
    const svc = new StewardActivityService({ clock });
    const perception = new StewardPerceptionService({
      feedGate: { hasStewardSubscribers: () => false },
      onRingEntry: (entry) => svc.recordRingEntry(entry),
      clock,
    });
    perception.onDomainEvent({
      type: "turn.completed",
      sessionId: "s-main",
      payload: { reason: "done" },
      occurredAt: "2026-10-09T00:00:00.000Z",
    } as never);
    perception.onJobTerminal("job-77", "failed", "登录修复");
    const snapshot = buildContextSnapshot({
      nowMs: FIXED_NOW,
      activeAgents: 0,
      totalAgents: 0,
      sessionCount: 1,
      recentSessions: [],
      recentActivity: svc.recent(10),
    });
    expect(snapshot).toContain("最近的活动");
    expect(snapshot).toContain("有一个对话回完了"); // 哪轮完成
    expect(snapshot).toContain("「登录修复」失败了"); // 哪个任务终态
    expect(snapshot).not.toContain("job-77"); // 白话铁律：id 不入投影
  });

  test("账本回调抛错不炸感知主链路（隔离面）", () => {
    const perception = new StewardPerceptionService({
      feedGate: { hasStewardSubscribers: () => false },
      onRingEntry: () => {
        throw new Error("ledger boom");
      },
      clock,
    });
    expect(() =>
      perception.onDomainEvent({
        type: "agent.completed",
        sessionId: "s-1",
        payload: { agentId: "agent-a", closure: { summary: "x" } },
        occurredAt: "2026-10-09T00:00:00.000Z",
      } as never),
    ).not.toThrow();
  });
});
