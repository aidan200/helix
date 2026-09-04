import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  type ChatSendCommand,
  type EventEnvelope,
} from "@helix/protocol";

/**
 * TP-CL2-2 基线（A 简版）：daemon 侧以 workspace 包名 import @helix/protocol。
 * 验证 monorepo 依赖解析（bun workspace 链接 + tsc bundler resolution）就位；
 * ws-server adapter 正式接线在 T1.6（CL-6），此处仅守护「两端同源」的解析基线
 * （AD-8 / AG-13：仓库内不得存在平行手写协议类型）。
 */
describe("@helix/protocol 工作区解析（TP-CL2-2 基线）", () => {
  test("daemon 侧 import 同一协议包并使用其类型", () => {
    expect(PROTOCOL_VERSION).toBe("0.11"); // v0.11 升位（thinking 批 additive，iter-20260823-6ps5 T1.1；契约 = PROTOCOL-CHANGELOG.md §17.11）

    const cmd: ChatSendCommand = { v: PROTOCOL_VERSION, type: "chat.send", payload: { text: "ping" } };
    expect(cmd.type).toBe("chat.send");
    expect(cmd.payload.text).toBe("ping");

    const evt: EventEnvelope = {
      v: 0, // v0/v0.1 历史帧兼容读（FrameVersion = 0 | "0.11"）
      type: "agent.state.changed",
      payload: { state: "idle" },
    };
    expect(evt.type).toBe("agent.state.changed");
  });
});

describe("MAIN_INSTANCE_ID 常量退役守护（T10 实例 ID 统一 T10c）", () => {
  test("退役负命题：daemon src + packages 内值定义点零残留（常量不复活）", () => {
    // 原「protocol 导出 == domain 本地定义」双源相等断言（OI 收口 F-2⑬）随
    // 双源退役失去对象（T3.3）；此后守护「唯一定义 = common」单源。T10c
    // 常量最终退役（shell 消费摘除后 common 定义 + protocol re-export 同批
    // 删除）：守护翻转为全零负命题——`export const MAIN_INSTANCE_ID =
    // "main"` 值定义点在 daemon src + packages 内零残留；legacy "main"
    // 判别由读侧 helper 承担（domain isMainInstanceId / protocol
    // projection isMainInstance / shell entities/session isMainChannel，
    // 各自单点）。定义点再现即红（常量复活守护，TR-AD-28 反例面；
    // AG-13① 语义随迁）。
    const defRe = /export\s+const\s+MAIN_INSTANCE_ID\s*=\s*"main"/;
    const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
    const scanRoots = [
      path.join(repoRoot, "apps", "daemon", "src"),
      path.join(repoRoot, "packages"),
    ];
    const definitions: string[] = [];
    for (const root of scanRoots) {
      for (const rel of listTsFiles(root)) {
        if (rel.split(path.sep).includes("node_modules")) continue; // workspace 链接安装面非源码
        const src = readFileSync(path.join(root, rel), "utf8");
        if (defRe.test(src)) definitions.push(path.relative(repoRoot, path.join(root, rel)));
      }
    }
    expect(definitions).toEqual([]);
  });
});

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (entry.endsWith(".ts")) out.push(entry);
  }
  return out;
}
