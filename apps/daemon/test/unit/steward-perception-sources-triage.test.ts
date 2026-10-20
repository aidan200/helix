/**
 * StewardPerceptionService 单测——感知源扩展与分诊判定面（表面族第三源
 * onSurfaceEvent / 回合终态感知 turn.completed / 分诊降级保底 / 语音详文轨
 * 预算 / 判官详略判定面）。纯位置迁移自 steward-perception.test.ts
 * （P1 体量门拆分批，测试逻辑与断言零改动）；共享夹具在
 * ./helpers/steward-perception-fixtures。
 */
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import {
  TRIAGE_JUDGE_VERBOSE_QUESTION,
  TRIAGE_GENERATION_SYSTEM_PROMPT,
} from "../../src/application/steward/StewardPerceptionService";
import type { SurfaceEvent } from "@helix/protocol";
import {
  agentEvent,
  broadcast_drain,
  fakeDiagnose,
  fakeTriageJudge,
  makeFakeKv,
  makeStack,
} from "./helpers/steward-perception-fixtures";

// ── 表面族第三源（M1 browser adapter 接线点：SurfaceEvent → ring） ───

describe("onSurfaceEvent（感知源扩「表面族」第三源——不改分诊/激活门语义）", () => {
  test("SurfaceEvent 入 ring：kind=surface.event、sessionId 位承载 surfaceId、text 携 kind 摘要", () => {
    const { perception } = makeStack();
    perception.onSurfaceEvent({
      kind: "user_click",
      origin: "user",
      surfaceId: "browser:tab-1",
      at: 2_000_000,
      detail: { tag: "button" },
    });
    const ring = perception.ringSnapshot();
    expect(ring).toHaveLength(1);
    expect(ring[0]).toMatchObject({
      kind: "surface.event",
      sessionId: "browser:tab-1",
      at: 2_000_000,
    });
    expect(ring[0]!.text).toContain("user_click");
  });

  test("表面事件零分诊（激活态 + 分诊可用也零 LLM——分诊锚判定语义不变）", async () => {
    const { perception, diagnose } = makeStack({ stewardSubscribed: true, recentAsk: true });
    expect(perception.isActive()).toBe(true);
    perception.onSurfaceEvent({ kind: "navigated", origin: "system", surfaceId: "browser:tab-1", at: 2_000_000 });
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(0);
    expect(perception.ringSnapshot()).toHaveLength(1);
  });

  test("ring 滚动上限（PERCEPTION_RING_LIMIT）对表面事件同效", () => {
    const { perception } = makeStack();
    for (let i = 0; i < 205; i++) {
      perception.onSurfaceEvent({ kind: "user_input", origin: "user", surfaceId: `browser:t${i}`, at: 2_000_000 + i });
    }
    const ring = perception.ringSnapshot();
    expect(ring).toHaveLength(200);
    expect(ring[ring.length - 1]!.sessionId).toBe("browser:t204"); // 最新在尾
    expect(ring[0]!.sessionId).toBe("browser:t5"); // 最旧滚出
  });
});

// ── 回合终态感知（用户反馈批：主会话 turn.completed——设计 D10 系统族最后
// 一块订阅面；成本闸 = 投递关注命中才分诊，无关注只入 ring 零 LLM） ──────

describe("回合终态感知：turn.completed 入 ring + 投递关注命中分诊", () => {
  function turnEvent(sessionId: string, reason: "done" | "aborted" | "steerDrained" | "daemon_restarted"): DomainEvent {
    return agentEvent("turn.completed", { reason, replyEntryId: "entry-1" }, sessionId);
  }

  test("无关注会话的 turn.completed：入 ring 零 LLM（回合终态不全量分诊——成本闸）", () => {
    const { perception, diagnose } = makeStack();
    perception.onDomainEvent(turnEvent("sess-a", "done"));
    expect(diagnose.calls).toHaveLength(0);
    const ring = perception.ringSnapshot();
    expect(ring[ring.length - 1]!.kind).toBe("turn.completed");
    expect(ring[ring.length - 1]!.sessionId).toBe("sess-a");
  });

  test("投递关注命中：noteDelivered → 该会话 turn.completed → 分诊一次 + notify（userPrompt 含投递文本与回复读面）", async () => {
    const { perception, diagnose, notifies } = makeStack();
    perception.noteDelivered("sess-target", "帮我看看语音批的测试覆盖情况");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1);
    expect(diagnose.calls[0]!.userPrompt).toContain("帮我看看语音批的测试覆盖情况");
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.title).toBe("对话回复了");
  });

  test("关注一次性消费：同会话第二次 turn.completed 不再分诊（一次投递等一次回复）", async () => {
    const { perception, diagnose } = makeStack();
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1);
  });

  test("reason=daemon_restarted 不触发分诊（重启恢复不是回复）", async () => {
    const { perception, diagnose } = makeStack();
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target", "daemon_restarted"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(0);
  });

  test("未启用（money gate 关）：零 LLM，机械保底 notify + 语音同句「那个对话回你了」（对齐任务终态机械语义）", async () => {
    const { perception, diagnose, notifies, frames } = makeStack({
      diagnose: fakeDiagnose({ available: false }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(0);
    expect(notifies).toHaveLength(1); // 机械事实不依赖 LLM 配置
    expect(notifies[0]!.title).toBe("对话回复了");
    expect(notifies[0]!.body).toBe("那个对话回你了");
    expect(frames[frames.length - 1]!.text).toBe("那个对话回你了");
  });

  test("修复①：分诊 userPrompt 含回复正文（readReply 读面命中——LLM 能看到那边回了什么）", async () => {
    const { perception, diagnose } = makeStack({
      readReply: async () => "测试覆盖 87%，两处缺口在语音链重试面",
    });
    perception.noteDelivered("sess-target", "帮我看看语音批的测试覆盖情况");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1);
    expect(diagnose.calls[0]!.userPrompt).toContain("测试覆盖 87%");
  });

  test("修复①降级：读面缺席/报错 → prompt 标注无正文可读，分诊照常（读面失败不阻塞诊断）", async () => {
    const { perception, diagnose } = makeStack({
      readReply: async () => {
        throw new Error("db busy");
      },
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1);
    expect(diagnose.calls[0]!.userPrompt).toContain("无回复正文可读");
  });

  test("修复②：投递关注跨重启存活（kv 单键快照——新实例构造即恢复关注，回合终态照命中分诊）", async () => {
    const kv = makeFakeKv();
    const first = makeStack({ kv });
    first.perception.noteDelivered("sess-target", "问题 A");
    await first.kvFlush(); // 落盘（fire-and-forget 收口）
    const second = makeStack({ kv }); // 「重启」——新服务实例同一 kv
    second.perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(second.perception);
    expect(second.diagnose.calls).toHaveLength(1);
  });

  test("修复②：消费后快照更新——重启后不重复通知（一次性消费跨重启成立）", async () => {
    const kv = makeFakeKv();
    const first = makeStack({ kv });
    first.perception.noteDelivered("sess-target", "问题 A");
    await first.kvFlush();
    first.perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(first.perception);
    await first.kvFlush(); // 消费后的快照重写落盘
    const second = makeStack({ kv });
    second.perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(second.perception);
    expect(second.diagnose.calls).toHaveLength(0); // 关注已消费，不再命中
  });

  test("修复② TTL：陈旧关注（>24h）重启后不恢复（防僵尸关注永久滞留）", async () => {
    const kv = makeFakeKv();
    const first = makeStack({ kv, now: 1_000_000 });
    first.perception.noteDelivered("sess-target", "问题 A");
    await first.kvFlush();
    const second = makeStack({ kv, now: 1_000_000 + 25 * 60 * 60_000 }); // 25h 后「重启」
    second.perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(second.perception);
    expect(second.diagnose.calls).toHaveLength(0);
  });
});

// ── 通知双轨预算与分诊降级（用户反馈批：第二条通知静默丢失 + 摘要不细致）──
// 实锤样本 daemon-2026-10-07.log 15:03:08Z：「分诊产物 JSON 解析失败（烂输出
// 整体丢弃——不播半产物）」→ 零通知零语音——事件真实发生（用户在等回复），
// 分诊失败不该静默吞掉事件本身。 ──────────────────────

describe("分诊降级保底：LLM/解析失败 → 机械通知（事件不静默丢失）", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("分诊抛错（解析失败同形）：机械保底 notify + 语音同句（不再整体静默）", async () => {
    const { perception, diagnose, notifies, frames } = makeStack({
      diagnose: fakeDiagnose({ error: new Error("分诊产物 JSON 解析失败") }),
    });
    perception.noteDelivered("sess-target", "问题 B");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1); // LLM 调了（启用态）
    expect(notifies).toHaveLength(1); // 失败不再静默——机械保底通知
    expect(notifies[0]!.title).toBe("对话回复了");
    expect(notifies[0]!.body).toBe("那个对话回你了");
    expect(frames[frames.length - 1]!.text).toBe("那个对话回你了"); // 语音保底同句（白话）
  });

  test("agent 级锚已退役：分诊失败也零 notify（agent 事件零播报面）", async () => {
    const { perception, notifies } = makeStack({
      diagnose: fakeDiagnose({ error: new Error("boom") }),
    });
    perception.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-x" }, "sess-agent"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(0);
  });
});

describe("语音详文轨预算：detail 语音轨独立预算（2000，长报告不截断）+ notify 视觉面保 600", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("语音轨 650 字不截断（600 是 notify 视觉预算，不再误伤语音）", async () => {
    const long = "长".repeat(650);
    const { perception, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: fakeDiagnose({ result: { detail: long } }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect([...frames[frames.length - 1]!.text].length).toBe(650); // 语音轨全文上嘴（无截断）
  });

  test("语音轨超长防御：>2000 字截断加省略号（prompt 约束外兑底）", async () => {
    const long = "长".repeat(2100);
    const { perception, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: fakeDiagnose({ result: { detail: long } }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect([...frames[frames.length - 1]!.text].length).toBe(2001); // 2000 字 + 省略号（语音轨兑底）
  });

  test("白话硬约束：生成提示词明禁术语/英文/变量名/UUID（两段均白话）", async () => {
    const diagnose = fakeDiagnose();
    const { perception } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: fakeTriageJudge({ verbose: 0.9 }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(diagnose.textCalls[0]!.systemPrompt).toContain("大白话");
    expect(diagnose.textCalls[0]!.systemPrompt).toContain("禁止技术术语");
  });
});

describe("判官详略判定面（用户裁决：管家用 jev 判断回复要不要详细播报——noul 单判 + 生成纯文本两段制白话）", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("判官开启：noul 详略单判 + generateText 纯文本两段（零 JSON 调用），详略裁决取 detail/present", async () => {
    const diagnose = fakeDiagnose({ text: "一句话总结。\n\n逐项详述正文。" });
    const judge = fakeTriageJudge({ verbose: 0.9 });
    const { perception, frames, notifies } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge,
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-a", "问题 A");
    perception.onDomainEvent(turnEvent("sess-a"));
    await broadcast_drain(perception);
    expect(judge.calls.length).toBe(1); // 单判：详略
    expect(judge.calls[0]!.question).toBe(TRIAGE_JUDGE_VERBOSE_QUESTION);
    expect(judge.calls[0]!.state).toContain("问题 A"); // 现场摘要 = 分诊 userPrompt 同源
    expect(diagnose.textCalls.length).toBe(1); // 纯文本两段制
    expect(diagnose.calls.length).toBe(0); // 零 JSON
    expect(diagnose.textCalls[0]!.systemPrompt).toBe(TRIAGE_GENERATION_SYSTEM_PROMPT);
    expect(frames[frames.length - 1]!.text).toBe("逐项详述正文。"); // 详略=详细 → detail 上嘴
    expect(notifies[0]!.body).toBe("回完了，具体我语音里说"); // notify 机械短讯不变
  });

  test("判官详略=简短（verbose < 0.5）→ 语音用 present 单轨（notify 照机械短讯）", async () => {
    const diagnose = fakeDiagnose({ text: "一句话总结。\n\n逐项详述正文。" });
    const judge = fakeTriageJudge({ verbose: 0.1 });
    const { perception, frames, notifies } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge,
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-b", "问题 B");
    perception.onDomainEvent(turnEvent("sess-b"));
    await broadcast_drain(perception);
    expect(frames[frames.length - 1]!.text).toBe("一句话总结。"); // 简短裁决
    expect(notifies[0]!.body).toBe("回完了，具体我语音里说");
  });

  test("判官抛错 → WARN + 回退：detail 在场决定详略（不重试判官）", async () => {
    const diagnose = fakeDiagnose({ result: { present: "短句", detail: "详文内容" } });
    const judge = fakeTriageJudge({ error: new Error("判官端点不可达") });
    const { perception, frames, warns } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge,
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-c", "问题 C");
    perception.onDomainEvent(turnEvent("sess-c"));
    await broadcast_drain(perception);
    expect(judge.calls.length).toBe(1); // 抛错即降级：不重试
    expect(warns.some((w) => w.includes("判官"))).toBe(true);
    expect(diagnose.calls.length).toBe(1); // 回退 JSON 路径
    expect(diagnose.textCalls.length).toBe(0);
    expect(frames[frames.length - 1]!.text).toBe("详文内容"); // 回退详略：detail 在场 → 详
  });

  test("开关开但端点未配/失效（ready false）→ WARN + 回退 detail 在场决定", async () => {
    const diagnose = fakeDiagnose({ result: { present: "短句", detail: undefined } });
    const { perception, frames, warns } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: fakeTriageJudge({ ready: false }),
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-d", "问题 D");
    perception.onDomainEvent(turnEvent("sess-d"));
    await broadcast_drain(perception);
    expect(warns.some((w) => w.includes("未配") || w.includes("失效"))).toBe(true);
    expect(frames[frames.length - 1]!.text).toBe("短句"); // detail 缺席 → present
  });

  test("判官关闭（enabled false）→ 零判官调用零 warn，回退 detail 在场决定", async () => {
    const diagnose = fakeDiagnose({ result: { present: "短句", detail: "详文" } });
    const judge = fakeTriageJudge({ enabled: false });
    const { perception, frames, warns } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge,
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-e", "问题 E");
    perception.onDomainEvent(turnEvent("sess-e"));
    await broadcast_drain(perception);
    expect(judge.calls.length).toBe(0);
    expect(warns.length).toBe(0);
    expect(frames[frames.length - 1]!.text).toBe("详文");
  });

  test("烂文本兑底：空文本 → notify 机械短讯照发 + 语音保底白话句（无解析失败类别）", async () => {
    const diagnose = fakeDiagnose({ text: "   " });
    const { perception, tts, notifies, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: fakeTriageJudge({ verbose: 0.9 }),
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-f", "问题 F");
    perception.onDomainEvent(turnEvent("sess-f"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1); // 事件不静默：机械短讯照发
    expect(notifies[0]!.body).toBe("那个对话回你了"); // 保底白话
    expect(frames[frames.length - 1]!.text).toBe("那个对话回你了"); // 语音保底同句
    expect(tts.calls[0]!.text).toBe("那个对话回你了"); // 广播合成面同句
  });

  test("单段文本（无空行）→ detail 缺席回退 present；单换行多行 → 首行 present 其余 detail", async () => {
    const diagnose = fakeDiagnose({ text: "只有一段的口语句。" });
    const { perception, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: fakeTriageJudge({ verbose: 0.9 }),
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-g", "问题 G");
    perception.onDomainEvent(turnEvent("sess-g"));
    await broadcast_drain(perception);
    expect(frames[frames.length - 1]!.text).toBe("只有一段的口语句。"); // 单段 = present

    const diagnose2 = fakeDiagnose({ text: "首行口语句。\n第二行要点。\n第三行要点。" });
    const { perception: p2, frames: f2 } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: diagnose2,
      triageJudge: fakeTriageJudge({ verbose: 0.9 }),
      readReply: async () => "回复正文",
    });
    p2.noteDelivered("sess-h", "问题 H");
    p2.onDomainEvent(turnEvent("sess-h"));
    await broadcast_drain(p2);
    expect(f2[f2.length - 1]!.text).toBe("第二行要点。\n第三行要点。"); // 首行=present，余行=detail
  });
});
