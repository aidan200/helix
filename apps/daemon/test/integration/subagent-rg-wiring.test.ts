import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";

/**
 * code-review H7 专项：rg 定格路径的会话栈接线（config 级 rg 的唯一通道）。
 *
 * 缺陷：container.ts 把 grepFreeze.rgPath 摊入 buildSessionStack 入参，但
 * BuildSessionStackDeps 无 rgPath 字段——对象字面量 spread 绕过 TS 超额
 * 属性检查静默丢弃，会话栈 SubagentLauncher 构造不透传。bundle 级
 * （HELIX_RG_PATH 经 ...process.env 继承）缺陷不可见；config 级（rg 定格
 * 来自 config.json rgPath）下子进程 grep 只吃 env（ChildMain 不重读
 * config.json）→ 唯一通道断裂，chat 会话 spawn 的 SubAgent 子进程 grep
 * 响亮失败——而任务编排栈（buildTaskOrchestrator → launcher）接线正常，
 * 两栈不对称。
 *
 * 断言链（production 模式装配真 launcher，不注入 engine）：
 * config.json rgPath → bootPrelude freeze（source=config）→ container
 * 透传 → BuildSessionStackDeps.rgPath → SubagentLauncher deps.rgPath。
 * 观测点 = launcher deps（TR-62 洗涮后 bundle 级缺席，config 级独占
 * 解析——正是缺陷暴露形态）。
 */

const tmpRoots: string[] = [];
const mkHome = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-rg-wiring-"));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** 宿主 rg（grep-contract.test.ts 同款前置——无 rg 即测试前置失败）。 */
function hostRg(): string {
  const rg = Bun.which("rg");
  if (rg === null) throw new Error("测试前置失败：宿主机无 rg（brew install ripgrep）");
  return rg;
}

interface LauncherDepsView {
  readonly deps: { readonly rgPath?: string };
}

describe("code-review H7：rg 定格路径会话栈接线（config 级唯一通道）", () => {
  test("① config.json rgPath → 冻结定格 → 会话栈 launcher deps.rgPath（整链透传）", async () => {
    const rg = hostRg();
    const home = mkHome();
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ rgPath: rg }), "utf8");
    const daemon = await createTestDaemon({
      home,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      // 不注入 engine → production 模式：真 SubagentLauncher 装配
    });
    try {
      const launcher = daemon.subagentLauncher as unknown as LauncherDepsView | undefined;
      expect(launcher).toBeDefined(); // production 装配真体（缺此即测试形态错位）
      expect(launcher!.deps.rgPath).toBe(rg); // config 级定格值到达会话栈 launcher
    } finally {
      await daemon.shutdown();
    }
  });

  test("② 无 config rgPath（洗涮态无 bundle env）→ freeze unavailable → deps.rgPath 不注入", async () => {
    const home = mkHome();
    const daemon = await createTestDaemon({
      home,
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      const launcher = daemon.subagentLauncher as unknown as LauncherDepsView | undefined;
      expect(launcher).toBeDefined();
      expect(launcher!.deps.rgPath).toBeUndefined(); // unavailable 定格 → 不注入键，子进程靠继承面
    } finally {
      await daemon.shutdown();
    }
  });
});
