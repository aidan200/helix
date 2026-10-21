import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  sweepWorkspaceTmp,
  startWorkspaceTmpSweeper,
  TMP_SWEEP_FIRST_DELAY_MS,
  TMP_SWEEP_INTERVAL_MS,
  type SweepScheduleHandle,
} from "../../src/infrastructure/workspaceTmpSweeper";
import { ensureWorkspaceTmp } from "../../src/infrastructure/workspacePaths";

/** TR-152：mkdtemp 登记回收（afterAll force 幂等）。 */
const registered: string[] = [];
afterAll(() => {
  for (const dir of registered) rmSync(dir, { recursive: true, force: true });
});
function newWorkspaceRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-tmp-sweeper-"));
  registered.push(dir);
  return dir;
}
const DAY = 24 * 60 * 60 * 1000;
/** 把条目 mtime 设到相对 now 的偏移（负 = 过去）。 */
function age(p: string, days: number, nowMs: number): void {
  const at = new Date(nowMs + days * DAY);
  utimesSync(p, at, at);
}

describe("sweepWorkspaceTmp（纯扫描面）", () => {
  const NOW = Date.parse("2026-10-21T12:00:00Z");

  test("过龄文件删除、未过龄保留（顶层条目年龄判）", () => {
    const root = newWorkspaceRoot();
    const tmp = ensureWorkspaceTmp(root);
    writeFileSync(path.join(tmp, "old.png"), "x");
    writeFileSync(path.join(tmp, "fresh.png"), "x");
    age(path.join(tmp, "old.png"), -8, NOW);
    age(path.join(tmp, "fresh.png"), -1, NOW);
    const result = sweepWorkspaceTmp(root, NOW);
    expect(result.removed).toEqual(["old.png"]);
    expect(result.kept).toBe(1);
    expect(result.failed).toEqual([]);
  });

  test("目录年龄 = 树内最新 mtime：顶层老但内有新文件 → 保留；树内全老 → 整目录删除", () => {
    const root = newWorkspaceRoot();
    const tmp = ensureWorkspaceTmp(root);
    // 目录 A：自身 mtime 老，深层有新文件（父目录 mtime 不随深层写入更新）
    const a = path.join(tmp, "dir-a");
    mkdirSync(path.join(a, "sub"), { recursive: true });
    writeFileSync(path.join(a, "sub", "recent.log"), "x");
    age(a, -9, NOW);
    age(path.join(a, "sub"), -9, NOW);
    age(path.join(a, "sub", "recent.log"), -0.5, NOW);
    // 目录 B：全树过龄
    const b = path.join(tmp, "dir-b");
    mkdirSync(b, { recursive: true });
    writeFileSync(path.join(b, "stale.log"), "x");
    age(b, -9, NOW);
    age(path.join(b, "stale.log"), -9, NOW);
    const result = sweepWorkspaceTmp(root, NOW);
    expect(result.removed).toEqual(["dir-b"]);
    expect(result.kept).toBe(1); // dir-a 保留
  });

  test("tmp 根不存在（ENOENT）：空结果 no-op", () => {
    const root = newWorkspaceRoot(); // 不 ensure tmp
    expect(sweepWorkspaceTmp(root, NOW)).toEqual({ removed: [], kept: 0, failed: [] });
  });

  test("单条目删除失败：warn 出口收到 + 计入 failed + 继续删其余", () => {
    const root = newWorkspaceRoot();
    const tmp = ensureWorkspaceTmp(root);
    writeFileSync(path.join(tmp, "busy.log"), "x");
    writeFileSync(path.join(tmp, "gone.log"), "x");
    age(path.join(tmp, "busy.log"), -8, NOW);
    age(path.join(tmp, "gone.log"), -8, NOW);
    const seen: string[] = [];
    const errors: string[] = [];
    const result = sweepWorkspaceTmp(root, NOW, {
      rm: (p) => {
        if (p.endsWith("busy.log")) throw new Error("EBUSY");
        rmSync(p, { recursive: true, force: true });
        seen.push(path.basename(p));
      },
      onRemoveError: (name, reason) => errors.push(`${name}:${(reason as Error).message}`),
    });
    expect(result.removed).toEqual(["gone.log"]);
    expect(result.failed).toEqual(["busy.log"]);
    expect(errors).toEqual(["busy.log:EBUSY"]);
    expect(seen).toEqual(["gone.log"]);
  });

  test("扫描预算耗尽：停深入用已见 max（保守过龄判），不死循环", () => {
    const root = newWorkspaceRoot();
    const tmp = ensureWorkspaceTmp(root);
    const a = path.join(tmp, "dir-capped");
    mkdirSync(a, { recursive: true });
    writeFileSync(path.join(a, "deep-recent.log"), "x");
    age(a, -9, NOW);
    age(path.join(a, "deep-recent.log"), -0.5, NOW);
    // maxScanEntries=0：深层文件不被扫到，目录年龄退化为自身 mtime（老）→ 过龄删
    const result = sweepWorkspaceTmp(root, NOW, { maxScanEntries: 0 });
    expect(result.removed).toEqual(["dir-capped"]);
  });
});

describe("startWorkspaceTmpSweeper（定时器面）", () => {
  const NOW = Date.parse("2026-10-21T12:00:00Z");

  function fakeSchedule(): {
    calls: { ms: number; fn: () => void }[];
    schedule: (fn: () => void, ms: number) => SweepScheduleHandle;
    cleared: number[];
    fire: (i?: number) => void;
  } {
    const calls: { ms: number; fn: () => void }[] = [];
    const cleared: number[] = [];
    return {
      calls,
      cleared,
      schedule: (fn, ms) => {
        const i = calls.length;
        calls.push({ ms, fn });
        return { clear: () => cleared.push(i) };
      },
      fire: (i = 0) => calls[i]!.fn(),
    };
  }

  test("启动即排首轮（60s 缺省），触发后清仓 + info 汇总 + 重排 24h", () => {
    const root = newWorkspaceRoot();
    const tmp = ensureWorkspaceTmp(root);
    writeFileSync(path.join(tmp, "old.json"), "x");
    age(path.join(tmp, "old.json"), -8, NOW);
    const s = fakeSchedule();
    const logs: string[] = [];
    const sweeper = startWorkspaceTmpSweeper({
      currentRoot: () => root,
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      now: () => NOW,
      schedule: s.schedule,
    });
    expect(s.calls.length).toBe(1);
    expect(s.calls[0]!.ms).toBe(TMP_SWEEP_FIRST_DELAY_MS);
    s.fire(0);
    expect(s.calls.length).toBe(2);
    expect(s.calls[1]!.ms).toBe(TMP_SWEEP_INTERVAL_MS);
    expect(logs.some((l) => l.includes("删 1") && l.includes(root))).toBe(true);
    sweeper.stop();
  });

  test("未绑定 root：空转跳过（零删除零日志），仍按节奏重排", () => {
    const s = fakeSchedule();
    const logs: string[] = [];
    const sweeper = startWorkspaceTmpSweeper({
      currentRoot: () => null,
      logger: { info: (m) => logs.push(m), warn: () => {} },
      now: () => NOW,
      schedule: s.schedule,
    });
    s.fire(0);
    expect(logs).toEqual([]);
    expect(s.calls.length).toBe(2);
    expect(s.calls[1]!.ms).toBe(TMP_SWEEP_INTERVAL_MS);
    sweeper.stop();
  });

  test("stop：clear 当前句柄 + 停后不再重排；幂等", () => {
    const s = fakeSchedule();
    const sweeper = startWorkspaceTmpSweeper({
      currentRoot: () => null,
      logger: { info: () => {}, warn: () => {} },
      now: () => NOW,
      schedule: s.schedule,
    });
    sweeper.stop();
    sweeper.stop(); // 幂等
    expect(s.cleared).toEqual([0]);
    const before = s.calls.length;
    s.fire(0); // 已停：即使旧 fn 被外部触发也不重排
    expect(s.calls.length).toBe(before);
  });

  test("sweepNow：立即执行一轮（未绑定 → 空结果；绑定 → 真删）", () => {
    const root = newWorkspaceRoot();
    const tmp = ensureWorkspaceTmp(root);
    writeFileSync(path.join(tmp, "old.md"), "x");
    age(path.join(tmp, "old.md"), -10, NOW);
    const s = fakeSchedule();
    const sweeper = startWorkspaceTmpSweeper({
      currentRoot: () => root,
      logger: { info: () => {}, warn: () => {} },
      now: () => NOW,
      schedule: s.schedule,
    });
    expect(sweeper.sweepNow().removed).toEqual(["old.md"]);
    expect(sweepWorkspaceTmp(root, NOW).removed).toEqual([]); // 已删净
    sweeper.stop();
  });
});
