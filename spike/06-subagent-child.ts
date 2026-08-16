/**
 * O-7 spike ⑥：SubAgent 子进程形态裁决驱动（候选 A：自建 Bun.spawn + ChildMain + stdio JSON）。
 *
 * 验证四步闭环 + O-6 进程组机制（全部在真实 Bun 运行时下）：
 *  S1  spawn detached 子进程（独立 PID/进程组），spawn 调用毫秒级返回；
 *  S2  子进程真实 AgentRuntime 跑一次 run，事件经 stdout JSON 行上行（挂 instanceId）；
 *  S3  父进程 send 一行 JSON → 子进程 Agent.steer() → 注入作为新 turn 被消费；
 *  S4  run 收敛 → closure 回传 → exit(0)；
 *  S5  O-6：kill(-pid, SIGTERM) 命中进程组（子进程优雅退出 + 组回收 ESRCH 探针）；
 *  S6  O-6 升级：忽略 SIGTERM 的子进程 → SIGKILL 强杀进程组 → 零残留。
 *
 * 运行：bun run 06-subagent-child.ts（spike/ 目录内）
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const CHILD_MAIN = join(import.meta.dir, "06-subagent-child-main.ts");

/** 离线假模型（与 test-profile.test.ts 同构，无网络）。 */
const fakeModel = {
  id: "spike-fake-model",
  name: "Spike Fake Model",
  api: "anthropic-messages",
  provider: "anthropic",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
};

interface WireLine {
  type: string;
  instanceId?: string;
  event?: { type: string; role?: string; text?: string };
  closure?: { status: string; summary: string };
  pid?: number;
}

interface SpawnedChild {
  proc: ReturnType<typeof Bun.spawn>;
  pid: number;
  lines: WireLine[];
}

/** spawn 子进程并开始收集 stdout JSON 行。 */
function spawnChild(task: string, replies: string[], chunkDelayMs = 6): SpawnedChild {
  const dir = mkdtempSync(join(tmpdir(), "helix-spike6-"));
  const scriptPath = join(dir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ replies, chunkDelayMs }));
  const t0 = Date.now();
  const proc = Bun.spawn({
    cmd: [process.execPath, CHILD_MAIN, "--task", task],
    env: {
      ...process.env,
      HELIX_INSTANCE_ID: "agent-1",
      HELIX_MODEL_JSON: JSON.stringify(fakeModel),
      HELIX_FAKE_ENGINE_SCRIPT: scriptPath,
    } as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    detached: true, // ★ 独立进程组（O-6 进程组回收前提）
  });
  const spawnMs = Date.now() - t0;
  const lines: WireLine[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          lines.push(JSON.parse(line) as WireLine);
        } catch {
          lines.push({ type: "unparseable", event: { type: line.slice(0, 60) } });
        }
      }
    }
  })();
  return { proc, pid: proc.pid!, lines, spawnMs };
}

function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`until 超时：${label}（${timeoutMs}ms）`));
      }
    }, 5);
  });
}

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` —— ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function scenarioS1toS4(): Promise<void> {
  console.log("\n━━━ S1-S4：spawn → run → send→steer → closure 四步闭环 ━━━");
  const closureBlock =
    '<<<CLOSURE\n{"status":"done","summary":"spike 任务完成","reportPath":null,"findings":[],"taskId":null}\nCLOSURE>>>';
  const child = spawnChild("验证子进程最小闭环", [
    "第一答：正在分析任务，" + "x".repeat(60) + "（流式中段等待注入）。\n" + closureBlock,
    "（按注入调整后的）第二答：已按补充指示完成。\n" + closureBlock,
  ]);

  // S1：spawn 毫秒级返回 + 独立 PID + 事件开始上行
  check("S1 spawn 调用毫秒级返回", child.spawnMs < 500, `${child.spawnMs}ms`);
  check("S1 子进程独立 PID", child.pid !== process.pid && child.pid > 0, `pid=${child.pid}`);
  const pgidOut = execSync(`ps -o pid=,pgid=,comm= -p ${child.pid}`, { encoding: "utf8" }).trim();
  check("S1 detached = 独立进程组（pgid == pid）", new RegExp(`^\\s*${child.pid}\\s+${child.pid}\\s`).test(pgidOut), pgidOut.replace(/\s+/g, " "));
  await until(() => child.lines.some((l) => l.type === "event" && l.event?.type === "message_update"), 5000, "等待子进程流式事件");
  check("S2 引擎事件经 stdout 上行（挂 instanceId）", child.lines.every((l) => l.instanceId === "agent-1"), `已收 ${child.lines.length} 行`);

  // S3：send → stdin → Agent.steer() → 注入作为新 turn 被消费
  child.proc.stdin!.write(JSON.stringify({ type: "send", text: "spike 注入：请按补充指示调整" }) + "\n");
  await until(() => child.lines.some((l) => l.type === "steered"), 3000, "等待子进程确认 steer");
  check("S3 send 经 stdin 到达并 Agent.steer() 转投", child.lines.some((l) => l.type === "steered"));
  await until(() => child.lines.some((l) => l.type === "closure"), 10000, "等待 closure 回传");

  // S4：closure 回传 + exit(0)
  const closureLine = child.lines.find((l) => l.type === "closure");
  check("S4 closure 五字段结构回传", closureLine?.closure?.status === "done" && closureLine.closure.summary === "spike 任务完成", JSON.stringify(closureLine?.closure));
  const exitCode = await child.proc.exited;
  check("S4 子进程 exit(0)", exitCode === 0, `exitCode=${exitCode}`);
  // 注入确实驱动了第二个 turn（message_start(user) 出现两次）
  const userStarts = child.lines.filter((l) => l.event?.type === "message_start" && l.event?.role === "user").length;
  check("S3 注入作为新 turn 消费（两条 user 消息）", userStarts >= 2, `userStarts=${userStarts}`);
}

async function scenarioS5gracefulKill(): Promise<void> {
  console.log("\n━━━ S5：O-6 优雅路径（SIGTERM 命中进程组） ━━━");
  const child = spawnChild("慢任务（验证 kill）", ["slow-" + "y".repeat(400)], 80);
  await until(() => child.lines.some((l) => l.event?.type === "message_update"), 5000, "等待流式开始");
  process.kill(-child.pid, "SIGTERM"); // ★ 负 pid = 进程组
  await until(() => child.lines.some((l) => l.type === "closure"), 5000, "等待终止 closure");
  const closureLine = child.lines.find((l) => l.type === "closure");
  check("S5 SIGTERM → 子进程 failed closure 回传", closureLine?.closure?.status === "failed", JSON.stringify(closureLine?.closure));
  const exitCode = await child.proc.exited;
  check("S5 子进程退出", exitCode === 0, `exitCode=${exitCode}`);
  await until(() => {
    try {
      process.kill(-child.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 2000, "等待进程组回收");
  let groupGone = false;
  try {
    process.kill(-child.pid, 0);
  } catch {
    groupGone = true;
  }
  check("S5 进程组已回收（kill(-pid,0) ESRCH）", groupGone);
}

async function scenarioS6escalation(): Promise<void> {
  console.log("\n━━━ S6：O-6 升级路径（忽略 SIGTERM → SIGKILL 进程组 → 零残留） ━━━");
  const proc = Bun.spawn({
    cmd: [process.execPath, "-e", 'process.on("SIGTERM", () => console.error("[ignore-sigterm]")); setInterval(() => {}, 1000);'],
    env: { ...process.env } as Record<string, string>,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });
  const pid = proc.pid!;
  await new Promise((r) => setTimeout(r, 300));
  process.kill(-pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  let alive = true;
  try {
    process.kill(-pid, 0);
  } catch {
    alive = false;
  }
  check("S6 忽略 SIGTERM 的子进程 500ms 后仍存活", alive);
  process.kill(-pid, "SIGKILL");
  const exitCode = await proc.exited;
  await new Promise((r) => setTimeout(r, 300));
  let gone = false;
  try {
    process.kill(-pid, 0);
  } catch {
    gone = true;
  }
  // 注意：不能 grep ChildMain 文件名——本 agent 进程的 --task 参数含 spike 名称会自匹配（误报）；
  // 只 grep 被杀子进程独有的标记（-e 剧本里的 ignore-sigterm 字符串）。
  const psOut = execSync("ps -eo pid,pgid,command | grep 'ignore-sigterm' | grep -v grep || true", { encoding: "utf8" });
  check("S6 SIGKILL 后进程组回收", gone, `exitCode=${exitCode}`);
  check("S6 ps 零残留", psOut.trim() === "", psOut.trim() === "" ? "（无匹配行）" : psOut.trim());
}

async function main(): Promise<void> {
  await scenarioS1toS4();
  await scenarioS5gracefulKill();
  await scenarioS6escalation();
  console.log(process.exitCode === 1 ? "\n❌ spike 存在失败项" : "\n✅ spike 全部通过：候选 A 四步闭环 + O-6 序列可行");
}

main().catch((err) => {
  console.error("spike 驱动崩溃：", err);
  process.exit(1);
});
