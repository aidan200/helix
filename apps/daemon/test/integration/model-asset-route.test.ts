import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Daemon } from "../../src/infrastructure/container";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PassThrough } from "node:stream";
import { VOICEPRINT_MODEL_FILENAME } from "@helix/protocol";

/**
 * 本地模型资产路由（M3-c v2：模型归位 ~/.helix/models/ 磁盘目录）。
 *
 * 覆盖：GET 命中（流式字节 + content-length 进度分母）/ GET 未装配 404 /
 * HEAD 就绪探测（命中 200 零 body / 缺席 404——设置页自动检测面）/
 * PUT 导入落盘（幂等覆写）/ PUT 体积护栏 413 / 任意其他 /models/* 路径 404
 * （白名单——不开放任意读写盘）。
 */
interface Rig {
  home: string;
  daemon: Daemon;
  dispose: () => Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-models-route-"));
  const daemon = await createTestDaemon({
    home,
    engine: () => new FakeAgentEngine(),
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    skipConfig: true,
    port: 0,
  });
  return { home, daemon, dispose: async () => {
    await daemon.shutdown();
    rmSync(home, { recursive: true, force: true });
  } };
}

const base = (rig: Rig) => `http://127.0.0.1:${rig.daemon.ws.port}`;

describe("本地模型资产路由（~/.helix/models/）", () => {
  test("GET：模型在盘 → 流式返回 + content-length（shell 进度分母）", async () => {
    const rig = await makeRig();
    try {
      const dir = path.join(rig.home, "models");
      mkdirSync(dir, { recursive: true });
      const payload = new Uint8Array(2048).fill(7);
      writeFileSync(path.join(dir, VOICEPRINT_MODEL_FILENAME), payload);
      const res = await fetch(`${base(rig)}/models/${VOICEPRINT_MODEL_FILENAME}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe("2048");
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf.byteLength).toBe(2048);
      expect(buf[0]).toBe(7);
    } finally {
      await rig.dispose();
    }
  });

  test("GET：模型不在盘 → 404（shell 侧提示导入/手动放置）", async () => {
    const rig = await makeRig();
    try {
      const res = await fetch(`${base(rig)}/models/${VOICEPRINT_MODEL_FILENAME}`);
      expect(res.status).toBe(404);
    } finally {
      await rig.dispose();
    }
  });

  test("HEAD：模型在盘 → 200 + content-length + 零 body（就绪探测零搬运）", async () => {
    const rig = await makeRig();
    try {
      const dir = path.join(rig.home, "models");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, VOICEPRINT_MODEL_FILENAME), new Uint8Array(4096).fill(3));
      const res = await fetch(`${base(rig)}/models/${VOICEPRINT_MODEL_FILENAME}`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe("4096");
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    } finally {
      await rig.dispose();
    }
  });

  test("HEAD：模型不在盘 → 404（设置页显示下载/导入通道）", async () => {
    const rig = await makeRig();
    try {
      const res = await fetch(`${base(rig)}/models/${VOICEPRINT_MODEL_FILENAME}`, { method: "HEAD" });
      expect(res.status).toBe(404);
    } finally {
      await rig.dispose();
    }
  });

  test("PUT：导入上行 → 落盘 <home>/models/（幂等覆写）", async () => {
    const rig = await makeRig();
    try {
      const first = new Uint8Array(1024).fill(1);
      const res1 = await fetch(`${base(rig)}/models/${VOICEPRINT_MODEL_FILENAME}`, {
        method: "PUT",
        body: first,
      });
      expect(res1.status).toBe(200);
      const filePath = path.join(rig.home, "models", VOICEPRINT_MODEL_FILENAME);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath).byteLength).toBe(1024);
      // 幂等覆写：同名重导即替换
      const second = new Uint8Array(512).fill(2);
      const res2 = await fetch(`${base(rig)}/models/${VOICEPRINT_MODEL_FILENAME}`, {
        method: "PUT",
        body: second,
      });
      expect(res2.status).toBe(200);
      expect(readFileSync(filePath).byteLength).toBe(512);
      // 落盘后 GET 命中（导入 → 拉取全链）
      const got = await fetch(`${base(rig)}/models/${VOICEPRINT_MODEL_FILENAME}`);
      expect(got.status).toBe(200);
      expect(new Uint8Array(await got.arrayBuffer()).byteLength).toBe(512);
    } finally {
      await rig.dispose();
    }
  });

  test("PUT：空体/超限 → 413（体积护栏）", async () => {
    const rig = await makeRig();
    try {
      const res = await fetch(`${base(rig)}/models/${VOICEPRINT_MODEL_FILENAME}`, {
        method: "PUT",
        body: new Uint8Array(0),
      });
      expect(res.status).toBe(413);
    } finally {
      await rig.dispose();
    }
  });

  test("白名单：任意其他 /models/* 路径 → 404（不开放任意读写盘）", async () => {
    const rig = await makeRig();
    try {
      const probe = await fetch(`${base(rig)}/models/../../config.json`);
      expect(probe.status).toBe(404);
      const other = await fetch(`${base(rig)}/models/some-other-file.bin`);
      expect(other.status).toBe(404);
    } finally {
      await rig.dispose();
    }
  });
});
