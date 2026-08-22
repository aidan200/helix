import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
