/**
 * 执行轮子域单测（DDD 重构批 2：StewardRun + RunWatchdog + AskQueue——TDD 红→绿）。
 *
 * 三模块（设计文档 §3.2①）：
 * - RunWatchdog：看门狗纯判定（快照 → verdict——六态穷举表驱动；副作用
 *   归应用层 tick 翻译）。历史事故场景的判定面：挂死流快进（手动 abort
 *   8s 不收口）/ 零事件挂起 180s / abort 宽限 15s 强制收口 / 挂闸等待
 *   零通知（10-07 事故修订）/ 推进锚未锚定哨兵（CAND-666）。
 * - StewardRun：run 状态容器（批 2 绞杀形态——字段搬运非语义重写，迁移
 *   方法与原读写点一一对应；锚清理集中在迁移函数内，「三处清锚」问题
 *   从根上消灭——所有清锚只经 begin/finish/assemblyFailed/clearAll）。
 * - AskQueue：输入队列值对象（上限/溢出/清空保序）。
 *
 * 绞杀不变量：既有 steward-reliability/manual-stop/hotfix-cascade 三族
 * 测试全绿 = 事故场景重放证明（10-07 双 run 竞态/挂死流/级联事故链）。
 */
import { describe, expect, test } from "bun:test";
import {
  judgeRunWatchdog,
  type RunWatchdogSnapshot,
} from "../../src/domain/steward/run/RunWatchdog";
import { StewardRun } from "../../src/domain/steward/run/StewardRun";
import { AskQueue } from "../../src/domain/steward/run/AskQueue";
import { STEWARD_TUNING_DEFAULTS } from "../../src/domain/steward/tuning/StewardTuning";

const T = STEWARD_TUNING_DEFAULTS;

// ── RunWatchdog 表驱动穷举 ─────────────────────────────────

describe("RunWatchdog 判定（六态穷举）", () => {
  const base: RunWatchdogSnapshot = {
    runActive: true,
    enginePresent: true,
    manualAbortAt: undefined,
    runLastProgressAt: 1_000_000,
    watchdogFiredAt: undefined,
  };

  test("idle 态（runActive=false）→ idle-reset（看门狗锚复位，下一 run 重计）", () => {
    const v = judgeRunWatchdog({ ...base, runActive: false }, T, 2_000_000);
    expect(v.kind).toBe("idle-reset");
  });

  test("engine 缺席（弃引擎后）→ idle-reset", () => {
    const v = judgeRunWatchdog({ ...base, enginePresent: false }, T, 2_000_000);
    expect(v.kind).toBe("idle-reset");
  });

  test("手动快进轨：manualAbortAt 超 grace 仍 runActive → manual-fast-forward（不等被动 180s）", () => {
    const v = judgeRunWatchdog(
      { ...base, manualAbortAt: 1_000_000 },
      T,
      1_000_000 + T.run.manualAbortGraceMs + 1,
    );
    expect(v.kind).toBe("manual-fast-forward");
  });

  test("手动快进轨：grace 窗内 → none（正常流 abort 后 1-2s 收口，8s 足宽）", () => {
    const v = judgeRunWatchdog(
      { ...base, manualAbortAt: 1_000_000 },
      T,
      1_000_000 + T.run.manualAbortGraceMs - 1,
    );
    expect(v.kind).toBe("none");
  });

  test("推进锚未锚定（runActive=true 但锚 undefined——收口复位与下一 run 置位间竞态）→ unanchored（不判挂起——CAND-666 哨兵）", () => {
    const v = judgeRunWatchdog({ ...base, runLastProgressAt: undefined }, T, 2_000_000);
    expect(v.kind).toBe("unanchored");
  });

  test("挂起未触发：无事件推进 < watchdogMs → none", () => {
    const v = judgeRunWatchdog(base, T, 1_000_000 + T.run.watchdogMs - 1);
    expect(v.kind).toBe("none");
  });

  test("挂起首次触发：≥ watchdogMs → arm（携挂起秒数；gatedWait 归调用方置——挂闸等待是合法业务态）", () => {
    const v = judgeRunWatchdog(base, T, 1_000_000 + T.run.watchdogMs);
    expect(v.kind).toBe("arm");
    if (v.kind !== "arm") throw new Error("unreachable");
    expect(v.hungSeconds).toBe(T.run.watchdogMs / 1000);
  });

  test("已触发 + 宽限窗内 → none（等 abort 收口）", () => {
    const v = judgeRunWatchdog(
      { ...base, watchdogFiredAt: 1_500_000 },
      T,
      1_500_000 + T.run.watchdogAbortGraceMs - 1,
    );
    expect(v.kind).toBe("none");
  });

  test("已触发 + 宽限超时仍 runActive → force-recover（弃引擎重建——挂死流唯一恢复路径）", () => {
    const v = judgeRunWatchdog(
      { ...base, watchdogFiredAt: 1_500_000 },
      T,
      1_500_000 + T.run.watchdogAbortGraceMs,
    );
    expect(v.kind).toBe("force-recover");
  });

  test("手动快进优先于被动轨（manualAbortAt 在场即快进判定——abort 打不醒场景不等 180s）", () => {
    const v = judgeRunWatchdog(
      { ...base, manualAbortAt: 1_000_000, watchdogFiredAt: 1_000_000 },
      T,
      1_000_000 + T.run.manualAbortGraceMs + 1,
    );
    expect(v.kind).toBe("manual-fast-forward");
  });
});

describe("StewardRun 状态容器", () => {
  test("occupy：同步占位（idle→occupied——ask 检查面立即可见，26ms 双 run 竞态防御）", () => {
    const run = new StewardRun(() => 0);
    expect(run.active).toBe(false);
    run.occupy();
    expect(run.active).toBe(true);
  });

  test("begin：run 开始赋值块（锚定推进锚/清双锚/重置 runState/gate 锚清空）", () => {
    let now = 1_000;
    const run = new StewardRun(() => now);
    run.occupy();
    run.noteAbort(); // 上一 run 残锚模拟
    now += 5_000;
    run.begin();
    expect(run.active).toBe(true); // 幂等（driveAsk 已占位）
    expect(run.lastProgressAt).toBe(6_000); // 推进锚锚定
    expect(run.manualAbortAt).toBeUndefined(); // 残锚清除
    expect(run.watchdogFiredAt).toBeUndefined();
    expect(run.state.sawAborted).toBe(false);
    expect(run.state.toolCalls).toBe(0);
    expect(run.gateToken).toBeUndefined();
  });

  test("touch：任何引擎事件推进锚（活跃轮永不触发看门狗）", () => {
    let now = 1_000;
    const run = new StewardRun(() => now);
    run.occupy();
    run.begin();
    now += 60_000;
    run.touch();
    expect(run.lastProgressAt).toBe(61_000);
  });

  test("finish：run 收口清块（runActive=false + 三锚复位——幂等守卫在调用方）", () => {
    let now = 1_000;
    const run = new StewardRun(() => now);
    run.occupy();
    run.begin();
    run.noteAbort();
    run.armWatchdog();
    run.finish();
    expect(run.active).toBe(false);
    expect(run.lastProgressAt).toBeUndefined();
    expect(run.watchdogFiredAt).toBeUndefined();
    expect(run.manualAbortAt).toBeUndefined();
  });

  test("assemblyFailed：装配异常释放占位 + 清锚（防 runActive 永真死锁队列）", () => {
    const run = new StewardRun(() => 0);
    run.occupy();
    run.assemblyFailed();
    expect(run.active).toBe(false);
    expect(run.lastProgressAt).toBeUndefined();
    expect(run.watchdogFiredAt).toBeUndefined();
    expect(run.manualAbortAt).toBeUndefined();
  });

  test("clearAll：新对话清场（run 态全复位——clearHistory 面）", () => {
    const run = new StewardRun(() => 0);
    run.occupy();
    run.begin();
    run.gate("token-1");
    run.clearAll();
    expect(run.active).toBe(false);
    expect(run.gateToken).toBeUndefined();
  });

  test("gate/ungate：挂闸凭据登记与清除（pending 清空判据归调用方）", () => {
    const run = new StewardRun(() => 0);
    run.occupy();
    run.begin();
    run.gate("pause-1");
    expect(run.gateToken).toBe("pause-1");
    run.ungate();
    expect(run.gateToken).toBeUndefined();
  });

  test("forceRecoverPrepared：强制收口前置清手动锚（重复 tick 不二触）", () => {
    const run = new StewardRun(() => 0);
    run.occupy();
    run.begin();
    run.noteAbort();
    run.forceRecoverPrepared();
    expect(run.manualAbortAt).toBeUndefined();
  });
});

// ── AskQueue 值对象 ────────────────────────────────────────

describe("AskQueue 值对象", () => {
  test("入队序/驱动序（FIFO 不丢）；满判定拒新", () => {
    const q = new AskQueue<string>(() => 3);
    expect(q.tryPush("a")).toBe(true);
    expect(q.tryPush("b")).toBe(true);
    expect(q.tryPush("c")).toBe(true);
    expect(q.tryPush("d")).toBe(false); // 满拒新
    expect(q.length).toBe(3);
    expect(q.shift()).toBe("a");
    expect(q.shift()).toBe("b");
    expect(q.shift()).toBe("c");
    expect(q.shift()).toBeUndefined();
  });

  test("clearAll：停止词全停清空（返回被丢弃条数）", () => {
    const q = new AskQueue<string>(() => 3);
    q.tryPush("a");
    q.tryPush("b");
    expect(q.clearAll()).toBe(2);
    expect(q.length).toBe(0);
    expect(q.clearAll()).toBe(0); // 幂等
  });

  test("上限现拍（KV 即热）：maxOf 变化后下一判即生效", () => {
    let max = 2;
    const q = new AskQueue<string>(() => max);
    q.tryPush("a");
    q.tryPush("b");
    expect(q.tryPush("c")).toBe(false);
    max = 3; // KV 改写（即热）
    expect(q.tryPush("c")).toBe(true);
  });
});
