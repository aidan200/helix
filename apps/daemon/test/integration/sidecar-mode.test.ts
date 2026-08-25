import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@helix/protocol";

/**
 * `--sidecar` 信号面集成测（contracts/sidecar-lifecycle.md §1/§2，T2.1）：
 * 真实 main.ts 入口子进程，验证——
 * - headless 运行：不起 CLI REPL，stdout 首行 = 单行 ready JSON；
 * - ready 行 port/token 可用：WS 握手（hello + token）拿到 connection.welcome；
 * - `--home` 透传生效：<home>/dev-token 文件内容 = ready 行 token；
 * - SIGTERM 优雅退出（与 CLI 形态同一路径）。
 */
describe("daemon --sidecar 信号面（sidecar-lifecycle 契约）", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function makeHome(): string {
    home = mkdtempSync(path.join(tmpdir(), "helix-sidecar-"));
    // port=0 随机（防撞 7333；ready 行上报实际端口）
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: 0 }), "utf8");
    return home;
  }

  async function readReadyLine(stdout: ReadableStream<Uint8Array>): Promise<Record<string, unknown>> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!buf.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    const line = buf.split("\n", 1)[0]!;
    return JSON.parse(line) as Record<string, unknown>;
  }

  /** WS 握手（hello + token）：resolve welcome 帧，reject error 帧/超时。 */
  function handshake(port: number, token: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("WS 握手超时"));
      }, 5000);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: "hello",
            payload: { token, protocolVersion: PROTOCOL_VERSION },
          }),
        );
      };
      ws.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data)) as { type?: string; payload?: Record<string, unknown> };
        if (frame.type === "connection.welcome") {
          clearTimeout(timer);
          ws.close();
          resolve(frame.payload ?? {});
        } else if (frame.type === "connection.error") {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`握手被拒：${JSON.stringify(frame.payload)}`));
        }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("WS 连接失败"));
      };
    });
  }

  test("--sidecar：stdout 首行 ready JSON（port/token 可用，--home 透传，SIGTERM 优雅退出）", async () => {
    const dir = makeHome();
    const mainTs = path.join(import.meta.dir, "..", "..", "src", "main.ts");
    const proc = Bun.spawn({
      cmd: [process.execPath, mainTs, "--sidecar", "--home", dir],
      // cwd 指向 tmp home：daemon 启动 cwd = workspace 根（§3.1）——kg sync
      // 启动触发（T2.2）会一层扫描 cwd，测试进程 cwd（仓库内）不可被扫
      //（真 .kg 副作用）；tmp home = 空扫描面，无副作用。
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const ready = await readReadyLine(proc.stdout);

      // ready 行契约形状（契约 §2）
      expect(ready.type).toBe("ready");
      expect(typeof ready.port).toBe("number");
      expect((ready.port as number) > 0).toBe(true);
      expect(typeof ready.token).toBe("string");
      expect((ready.token as string).length > 0).toBe(true);

      // --home 透传：dev-token 文件落在显式 home 且与 ready 行 token 一致
      const fileToken = readFileSync(path.join(dir, "dev-token"), "utf8");
      expect(fileToken).toBe(ready.token as string);

      // port/token 可用：WS 握手拿到 connection.welcome
      const welcome = await handshake(ready.port as number, ready.token as string);
      expect(typeof welcome.sessionId).toBe("string");

      // headless：不应进入 CLI REPL（进程仍存活，未自行退出）
      expect(proc.exitCode).toBeNull();

      // SIGTERM 优雅退出（与 CLI 形态同一路径）
      proc.kill("SIGTERM");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  }, 30000);

  test("H-4 父死看门狗：中间进程退出 → sidecar reparent 成孤儿 → 看门狗优雅自杀 + 锁释放", async () => {
    const dir = makeHome();
    const mainTs = path.join(import.meta.dir, "..", "..", "src", "main.ts");
    const readyFile = path.join(dir, "ready.out");
    // 中间进程（模拟壳）：spawn daemon（独立进程组 + stdout 落文件，无管道
    // 断裂面）后立即退出——daemon 被 reparent 到 pid 1（孤儿化）。
    const spawner = path.join(dir, "spawn-middle.ts");
    writeFileSync(
      spawner,
      [
        `import { openSync } from "node:fs";`,
        `const out = openSync(${JSON.stringify(readyFile)}, "w");`,
        `const proc = Bun.spawn({`,
        `  cmd: [process.execPath, ${JSON.stringify(mainTs)}, "--sidecar", "--home", ${JSON.stringify(dir)}],`,
        `  cwd: ${JSON.stringify(dir)}, // kg sync 启动扫描面 = tmp（同上：仓库目录不可扫）`,
        `  stdin: "ignore", stdout: out, stderr: "inherit", detached: true,`,
        `});`,
        `console.log("DAEMON_PID=" + proc.pid);`,
        `process.exit(0); // 父即死——daemon 成为孤儿`,
      ].join("\n"),
      "utf8",
    );
    const middle = Bun.spawn({
      cmd: [process.execPath, spawner],
      stdout: "pipe",
      stderr: "inherit",
    });
    const middleOut = await new Response(middle.stdout).text();
    await middle.exited;
    const daemonPid = Number(middleOut.match(/DAEMON_PID=(\d+)/)?.[1]);
    expect(daemonPid).toBeGreaterThan(0);

    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      // 等 ready 行落文件（daemon 起跑成功 + 持锁）
      const lockPath = path.join(dir, "daemon.lock");
      const deadline1 = Date.now() + 15_000;
      for (;;) {
        try {
          const ready = JSON.parse(readFileSync(readyFile, "utf8").split("\n", 1)[0]!) as { type?: string };
          if (ready.type === "ready") break;
        } catch {
          /* 文件未就绪 */
        }
        if (Date.now() > deadline1) throw new Error("ready 行等待超时");
        await Bun.sleep(200);
      }
      expect(alive(daemonPid)).toBe(true);

      // 看门狗周期 5s：孤儿判定 → 优雅关停（与 SIGTERM 同路径）→ 锁释放
      const deadline2 = Date.now() + 20_000;
      for (;;) {
        if (!alive(daemonPid)) break;
        if (Date.now() > deadline2) {
          throw new Error(`看门狗未在窗口内关停孤儿 sidecar（pid ${daemonPid} 仍存活）`);
        }
        await Bun.sleep(300);
      }
      // 优雅关停 = 锁文件释放（同 SIGTERM 路径）
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (alive(daemonPid)) process.kill(daemonPid, "SIGKILL"); // 失败兜底防孤儿
    }
  }, 45_000);
});
