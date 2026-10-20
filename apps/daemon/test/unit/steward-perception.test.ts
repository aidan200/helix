/**
 * 管家感知批（M0.5 + M0.5-R LLM 参与修正）单测：StewardPerceptionService
 * （感知地基 + 激活判定 + 分诊编排 + notify 限流）与 BroadcastService 归一
 * 链路。
 *
 * 2026-10-08 用户裁决（白话播报重构）：①任务终态锚机械化——任务状态是机械
 * 事实，零 LLM 零判官，notify/语音同句白话短讯；②任务内 agent 终态零播报
 * （用户只关心任务整体）；③会话回复锚：notify 机械短讯（生命周期短），
 * 详文归宿是管家语音，判官 noul 单判详略（verbose）；④凡是播报出来的都
 * 必须是大白话（机械短讯/保底句/生成文案全部白话，禁术语英文 UUID）。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. 启用+未激活态：任务完成 → 分诊 LLM 调用发生 + notify 携呈现轨摘要与
 *    接续提案 + 语音同源 + 零对话插话 + 摄入轨照产（回来能看到干了什么）；
 * 2. 未启用（money gate 关）：零 LLM + 极简保底不变（回归钉子保留）；
 * 3. 投递面分支：激活=对话内主动汇报路径+notify；未激活=notify+语音无对话
 *    插话；分诊静默裁决（notify=false）两态一致；
 * 4. 机械增强：title=任务标题（非 UUID）；suggestions 含机械 [看看报告]
 *    （点按才动）；
 * 5. 归一：一次事件只触发一次 LLM 调用，语音文本与 notify 载荷同源；
 * 6. progress 薄条目走既有 recordSessionProgress 覆盖更新路径；
 * 7. 限流：窗口内第 5 条 normal 通知被丢弃（未激活同样生效）；high 豁免；
 * 8. 激活判定：feed 订阅在场 ∧ 近期 ask（5 分钟衰减窗）——投递面判据；
 * 9. ring buffer：终态/周期事件入 ring、滚动上限；
 * 10. 聚合粗筛：task:* 会话的 agent.completed 不在 agent 级播报（聚任务级锚）。
 *
 * 设计锚点：docs/temp/steward-browser-awareness-design.md v2.9 D10/D11/D12
 * （⑨启用门/⑩摘要双轨/⑪两环二分+⑫ LLM 参与修正）；E-249 ③层 gate 回
 * 「启用」档。
 */
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { STEWARD_ACTIVE_WINDOW_MS } from "../../src/application/steward/StewardPerceptionService";
import type { SurfaceEvent } from "@helix/protocol";
import {
  agentEvent,
  broadcast_drain,
  closure,
  fakeDiagnose,
  fakeTriageJudge,
  makeStack,
} from "./helpers/steward-perception-fixtures";

describe("激活判定（feed 订阅在场 ∧ 近期 ask 衰减窗）——v2.9：投递面判据（非 LLM 门槛）", () => {
  test("双信号齐备 → 激活", () => {
    const { perception } = makeStack({ stewardSubscribed: true, recentAsk: true });
    expect(perception.isActive()).toBe(true);
  });

  test("feed 零订阅 → 未激活（即使近期有 ask）", () => {
    const { perception } = makeStack({ stewardSubscribed: false, recentAsk: true });
    expect(perception.isActive()).toBe(false);
  });

  test("近期无 ask → 未激活（即使 feed 订阅在场）", () => {
    const { perception } = makeStack({ stewardSubscribed: true, recentAsk: false });
    expect(perception.isActive()).toBe(false);
  });

  test("ask 衰减窗：窗口内激活，超窗（>5min）衰减为未激活", () => {
    const { perception, advance } = makeStack({ stewardSubscribed: true, recentAsk: true });
    expect(perception.isActive()).toBe(true);
    advance(STEWARD_ACTIVE_WINDOW_MS + 1);
    expect(perception.isActive()).toBe(false);
    // 新 ask 重新点亮
    perception.noteUserActivity();
    expect(perception.isActive()).toBe(true);
  });
});

describe("激活判定③光球在场信号（批 4a：E-250 升级接点兑现——presence 事件）", () => {
  function presenceEvent(visible: boolean): SurfaceEvent {
    return {
      kind: "presence",
      origin: "user",
      surfaceId: "shell:c1:steward-orb",
      at: Date.now(),
      detail: { component: "orb", visible },
    };
  }

  test("光球在场、面板零订阅 → 激活（E-250 裂缝场景：开光球不开面板）", () => {
    const { perception } = makeStack({ stewardSubscribed: false, recentAsk: true });
    expect(perception.isActive()).toBe(false); // 上报前：原判据不激活
    perception.onSurfaceEvent(presenceEvent(true));
    expect(perception.isActive()).toBe(true); // 上报后：光球位点亮
  });

  test("光球显式离场（visible=false）→ 即刻不激活（不等 TTL）", () => {
    const { perception } = makeStack({ stewardSubscribed: false, recentAsk: true });
    perception.onSurfaceEvent(presenceEvent(true));
    perception.onSurfaceEvent(presenceEvent(false));
    expect(perception.isActive()).toBe(false);
  });

  test("光球信号 TTL 过期（断连残留防御）→ 不激活", () => {
    const { perception, advance } = makeStack({ stewardSubscribed: false, recentAsk: true });
    perception.onSurfaceEvent(presenceEvent(true));
    expect(perception.isActive()).toBe(true);
    advance(90_001); // 缺省 presenceTtlMs=90s 过界（ask 衰减窗内推进）
    expect(perception.isActive()).toBe(false);
  });

  test("非 shell 命名空间 presence 不点亮（browser/cli 表面非光球）", () => {
    const { perception } = makeStack({ stewardSubscribed: false, recentAsk: true });
    perception.onSurfaceEvent({ ...presenceEvent(true), surfaceId: "browser:t1:main" });
    expect(perception.isActive()).toBe(false);
  });

  test("detail 形状防御：非布尔 visible 照丢（不写位不清位）", () => {
    const { perception } = makeStack({ stewardSubscribed: false, recentAsk: true });
    perception.onSurfaceEvent(presenceEvent(true));
    perception.onSurfaceEvent({ ...presenceEvent("yes" as unknown as boolean), detail: { visible: "yes" } });
    expect(perception.isActive()).toBe(true); // 垃圾帧不清在场位
  });
});

describe("任务终态锚机械化（用户裁决 2026-10-08：任务状态是机械事实——零 LLM 零判官零分诊；notify/语音同句机械短讯）", () => {
  test("job done → 零分诊调用 + 机械 notify「xx 任务完成了」（未激活零语音——C 裁决，激活对照见下节）", async () => {
    const { perception, diagnose, tts, notifies, dialogReports, memory } = makeStack({
      stewardSubscribed: false,
      subscribers: 1,
    });
    perception.onJobTerminal("job-1", "done", "管家感知修正（helix）");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0); // 机械事实不进 LLM
    expect(notifies.length).toBe(1);
    expect(notifies[0]!.title).toBe("管家感知修正（helix）");
    expect(notifies[0]!.body).toBe("任务完成了"); // 机械短句（非 600 字详文）
    expect(tts.calls.length).toBe(0); // C 裁决：光球不在场，normal 只 toast 静默
    expect(dialogReports.length).toBe(0); // 主动对话汇报随分诊退役
    expect(memory.progress.length).toBe(0); // progress 薄条目随分诊退役（ring task.terminal 照记）
    expect(perception.ringSnapshot().some((r) => r.kind === "task.terminal")).toBe(true); // ring 照记
  });

  test("title 缺省 → 回退「后台任务」标题（非 UUID）", async () => {
    const { perception, notifies } = makeStack({ stewardSubscribed: false, subscribers: 1 });
    perception.onJobTerminal("job-1", "done");
    await broadcast_drain(perception);
    expect(notifies.length).toBe(1);
    expect(notifies[0]!.title).toBe("后台任务");
    expect(notifies[0]!.title).not.toContain("job-1");
  });

  test("job failed/cancelled → 机械通知照发（失败早知道——仍零 LLM）", async () => {
    const { perception, diagnose, notifies } = makeStack({ stewardSubscribed: false, subscribers: 1 });
    perception.onJobTerminal("job-2", "failed", "判官接入批");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0);
    expect(notifies.length).toBe(1);
    expect(notifies[0]!.body).toContain("失败");
  });

  test("机械通知受 normal 预算限流（第 5 条丢弃——防轰炸）", async () => {
    const { perception, notifies } = makeStack({ stewardSubscribed: false, subscribers: 1 });
    for (let i = 1; i <= 5; i++) {
      perception.onJobTerminal(`job-${i}`, "done", `任务${i}`);
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(4);
  });
});

describe("语音播报激活绑定（用户裁决 2026-10-08 C：光球不在场 = normal 只 toast 静默，仅 failed/high 才开口；光球在场 = 完整详报——说面与 TR-250 听面原则同源）", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("任务 done + 激活 → 语音同句恢复（toast + 语音双通道）", async () => {
    const { perception, tts, notifies } = makeStack({ stewardSubscribed: true, recentAsk: true, subscribers: 1 });
    perception.onJobTerminal("job-1", "done", "判官接入批");
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1);
    expect(tts.calls).toHaveLength(1);
    expect(tts.calls[0]!.text).toBe("任务完成了");
  });

  test("任务 done + 未激活 → 零语音（C 裁决核心：normal 档只 toast）", async () => {
    const { perception, tts, notifies } = makeStack({ stewardSubscribed: false, recentAsk: false, subscribers: 1 });
    perception.onJobTerminal("job-1", "done", "判官接入批");
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1); // toast 照发
    expect(tts.calls).toHaveLength(0); // 零语音
  });

  test("任务 failed + 未激活 → 语音照播（失败豁免——真出事才破沉默）", async () => {
    const { perception, tts, notifies } = makeStack({ stewardSubscribed: false, recentAsk: false, subscribers: 1 });
    perception.onJobTerminal("job-2", "failed", "判官接入批");
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1);
    expect(tts.calls).toHaveLength(1);
    expect(tts.calls[0]!.text).toBe("任务失败了");
  });

  test("会话回复详报 + 未激活 → notify 短讯照发 + 零语音（详报只在光球在场时上嘴）", async () => {
    const { perception, notifies, frames } = makeStack({
      stewardSubscribed: false,
      recentAsk: false,
      diagnose: fakeDiagnose({
        result: { present: "对话回复了", detail: "这是详细的逐项汇报正文，未激活不该被念出来。" },
      }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1); // 机械短讯照发
    expect(frames).toHaveLength(0); // 零语音帧
  });

  test("分诊失败 fallback + 未激活 → notify 保底照发 + 零语音", async () => {
    const { perception, notifies, frames } = makeStack({
      stewardSubscribed: false,
      recentAsk: false,
      diagnose: fakeDiagnose({ available: false }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.body).toBe("那个对话回你了");
    expect(frames).toHaveLength(0);
  });
});

describe("任务内 agent 终态零播报（用户裁决：用户只关心任务整体——内部 agent 状态不进任何播报/通知面）", () => {
  test("agent.failed/killed（任何会话）→ 零分诊零 notify 零语音（仅 ring 记录）", async () => {
    const { perception, diagnose, tts, notifies } = makeStack({ subscribers: 1, stewardSubscribed: false });
    for (const type of ["agent.failed", "agent.killed", "agent.completed"] as const) {
      perception.onDomainEvent(agentEvent(type, { agentId: "agent-x", error: "boom", closure: closure("xx") }));
    }
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0); // agent 级不再触发分诊
    expect(notifies.length).toBe(0); // 零 notify
    expect(tts.calls.length).toBe(0); // 零语音
    expect(perception.ringSnapshot().some((r) => r.kind === "agent.failed")).toBe(true); // ring 照记
  });
});

describe("会话回复锚：notify 机械简化 + 正文全给管家（用户裁决 2026-10-08：通知生命周期短——机械短讯；详文归宿是管家语音，jev 判定详略）", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("回复命中 → notify 机械短讯「对话回复了」+ 语音为详文主体（detail 优先，600 字料归嘴）", async () => {
    const { perception, notifies, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: fakeDiagnose({
        result: {
          present: "对话回复了",
          detail: "出声面协调器批已交付：双声重叠根治，说停全轨静默，对话优先于通知播报。这是详细的逐项汇报正文。",
        },
      }),
    });
    perception.noteDelivered("sess-target", "语音问题修了吗");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.title).toBe("对话回复了");
    expect(notifies[0]!.body).toBe("回完了，具体我语音里说"); // 机械短讯（非 600 字详文）
    expect(frames[frames.length - 1]!.text).toBe(
      "出声面协调器批已交付：双声重叠根治，说停全轨静默，对话优先于通知播报。这是详细的逐项汇报正文。", // 详文归宿 = 管家语音
    );
  });

  test("判官详略判定：jev 裁「简短」→ 语音也一句（present 单轨）；裁「详细」→ 语音用 detail", async () => {
    const judge = fakeTriageJudge({ verbose: 0.1 }); // 简短裁决
    const diagnose = fakeDiagnose({ text: "口语句简短。\n\n详细逐项正文。" });
    const { perception: p1, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge,
      readReply: async () => "回复正文",
    });
    p1.noteDelivered("sess-a", "问题 A");
    p1.onDomainEvent(turnEvent("sess-a"));
    await broadcast_drain(p1);
    expect(frames[frames.length - 1]!.text).toBe("口语句简短。"); // 简短裁决 → present 单轨

    const judge2 = fakeTriageJudge({ verbose: 0.9 }); // 详细裁决
    const { perception: p2, frames: frames2 } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge2,
      readReply: async () => "回复正文",
    });
    p2.noteDelivered("sess-b", "问题 B");
    p2.onDomainEvent(turnEvent("sess-b"));
    await broadcast_drain(p2);
    expect(frames2[frames2.length - 1]!.text).toBe("详细逐项正文。"); // 详细裁决 → detail 上嘴
  });

  test("无判官（回退路径）→ 详略由 detail 在场决定：有 detail 用 detail，缺席用 present", async () => {
    const { perception: p1, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: fakeDiagnose({ result: { present: "短句", detail: "详文内容" } }),
      readReply: async () => "回复正文",
    });
    p1.noteDelivered("sess-a", "问题 A");
    p1.onDomainEvent(turnEvent("sess-a"));
    await broadcast_drain(p1);
    expect(frames[frames.length - 1]!.text).toBe("详文内容");

    const { perception: p2, frames: frames2 } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: fakeDiagnose({ result: { present: "短句", detail: undefined } }),
      readReply: async () => "回复正文",
    });
    p2.noteDelivered("sess-b", "问题 B");
    p2.onDomainEvent(turnEvent("sess-b"));
    await broadcast_drain(p2);
    expect(frames2[frames2.length - 1]!.text).toBe("短句");
  });
});

describe("agent 级播报退役（用户裁决：agent 事件零播报——用户只关心任务整体）", () => {
  test("agent.completed/failed/killed（task 与非 task 会话）→ 零分诊零 notify 零语音（仅 ring 记录）", async () => {
    const { perception, diagnose, tts, notifies } = makeStack({ subscribers: 1, stewardSubscribed: false });
    perception.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-b1", closure: closure("批次完成") }, "task:job-1"));
    perception.onDomainEvent(agentEvent("agent.failed", { agentId: "agent-9", error: "x", closure: closure("") }, "sess-x"));
    perception.onDomainEvent(agentEvent("agent.killed", { agentId: "agent-c", closure: closure("手动停") }));
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0);
    expect(notifies.length).toBe(0);
    expect(tts.calls.length).toBe(0);
    expect(perception.ringSnapshot().length).toBeGreaterThanOrEqual(3); // ring 照记
  });
});

describe("ring buffer：汇报分级沉淀", () => {
  test("终态事件入 ring + 周期进展 ping 入 ring（零 LLM 零唤醒）", () => {
    const { perception, diagnose } = makeStack({ stewardSubscribed: false });
    perception.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-b1", closure: closure("批次一") }, "task:job-1"));
    perception.onDomainEvent({
      type: "steer.queued",
      sessionId: "task:job-1",
      payload: { entryId: "e1", text: "[agent-2 进展报告 #3] 状态=running", source: "progress" },
      occurredAt: "2026-10-10T06:00:00.000Z",
    });
    const ring = perception.ringSnapshot();
    expect(ring.some((r) => r.kind === "agent.completed" && r.agentId === "agent-b1")).toBe(true);
    expect(ring.some((r) => r.kind === "progress.ping")).toBe(true);
    expect(diagnose.calls.length).toBe(0); // 入 ring 零 LLM
  });

  test("滚动上限：超限丢最旧（内存有界，不落盘）", () => {
    const { perception } = makeStack({ stewardSubscribed: false });
    for (let i = 0; i < 250; i++) {
      perception.onDomainEvent(agentEvent("agent.completed", { agentId: `agent-${i}`, closure: closure(`批次${i}`) }, "task:job-1"));
    }
    const ring = perception.ringSnapshot();
    expect(ring.length).toBeLessThanOrEqual(200);
    expect(ring[0]!.agentId).toBe("agent-50"); // 最旧 50 条被滚动淘汰
  });

  test("job 终态（failed）入 ring 但不触发分诊（失败类保留 agent 级即报）", async () => {
    const { perception, diagnose } = makeStack();
    perception.onJobTerminal("job-2", "failed");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0);
    expect(perception.ringSnapshot().some((r) => r.kind === "task.terminal")).toBe(true);
  });
});

describe("通知预算：normal ≤4 条/小时，high 豁免（机械通知同样生效）", () => {
  test("窗口内第 5 条 normal 机械通知被丢弃（语音照播——语音有自己的队列限流）", async () => {
    const { perception, notifies, tts } = makeStack({ subscribers: 1 });
    for (let i = 1; i <= 5; i++) {
      perception.onJobTerminal(`job-${i}`, "done");
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(4); // 第 5 条被丢弃
    expect(tts.calls.length).toBe(5); // 语音照播（播报队列独立限流）
  });

  test("窗口滑出后恢复配额", async () => {
    const { perception, notifies, advance } = makeStack({ subscribers: 1 });
    for (let i = 1; i <= 4; i++) {
      perception.onJobTerminal(`job-${i}`, "done");
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(4);
    advance(60 * 60_000 + 1); // 1h 窗口滑出
    perception.onJobTerminal("job-5", "done");
    await broadcast_drain(perception);
    expect(notifies.length).toBe(5);
  });

  test("failed 任务 → high 档豁免限流（失败早知道——零 LLM 纯机械档位）", async () => {
    const { perception, notifies } = makeStack({ subscribers: 1 });
    for (let i = 1; i <= 6; i++) {
      perception.onJobTerminal(`job-${i}`, "failed", `任务${i}`);
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(6); // high 全达
    expect(notifies.every((n) => n.urgency === "high")).toBe(true);
    expect(notifies.every((n) => n.body === "任务失败了")).toBe(true); // 白话机械短讯
  });
});
