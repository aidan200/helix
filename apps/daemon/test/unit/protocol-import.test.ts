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
    expect(PROTOCOL_VERSION).toBe("0.10"); // v0.10 升位（T9 图片上下行批次标记；契约 = PROTOCOL.md §17.10）

    const cmd: ChatSendCommand = { v: PROTOCOL_VERSION, type: "chat.send", payload: { text: "ping" } };
    expect(cmd.type).toBe("chat.send");
    expect(cmd.payload.text).toBe("ping");

    const evt: EventEnvelope = {
      v: 0, // v0/v0.1 历史帧兼容读（FrameVersion = 0 | "0.10"）
      type: "agent.state.changed",
      payload: { state: "idle" },
    };
    expect(evt.type).toBe("agent.state.changed");
  });
});

describe("MAIN_INSTANCE_ID 单源守护（AD-1 / iter-20260821-dg90 T3.3）", () => {
  test("单源负命题：daemon src + packages 内值定义点唯一 = @helix/common", () => {
    // 原「protocol 导出 == domain 本地定义」双源相等断言（OI 收口 F-2⑬）随
    // 双源退役失去对象（T3.3：domain/AgentInstance.ts 与 protocol/envelope.ts
    // 本地定义均删除，唯一定义 = packages/common/src/constants.ts）。守护改
    // 负命题：`export const MAIN_INSTANCE_ID = "main"` 值定义点在 daemon src
    // + packages 内恰一处 = common；re-export 通道（protocol envelope）与
    // domain 锚点转发（AgentInstance）不算定义。第二定义点出现即红
    // （双源复发守护，TR-AD-28 反例面；AG-13① 取源语义随迁）。
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
    expect(definitions).toEqual([path.join("packages", "common", "src", "constants.ts")]);
  });
});

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (entry.endsWith(".ts")) out.push(entry);
  }
  return out;
}
