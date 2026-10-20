// @vitest-environment node
/**
 * commandError 尾缀归因单源测试（TR-145 契约 / TR-285 定式断言）。
 *
 * - 解析行为：带尾缀 → 命令 type；无尾缀（旧 daemon）→ undefined；
 * - 跨包契约钉子：daemon 单一构造点（WsServerAdapter.commandError）的尾缀模板
 *   必须在场——daemon 改格式/去尾缀时本断言先红（此前无任何编译期/测试信号，
 *   只能靠人记得同步十来处正则拷贝）；
 * - 回潮禁令：shell 源码内不得再出现内联尾缀正则字面量（单源只许本模块持有）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandOfConnectionError } from "./command-error";

/** 尾缀 = 全角括号包裹的命令名（daemon 单点拼接；此处分片拼接构造，避免本文件成为扫描目标）。 */
const OPEN = "\uFF08" + "\u547D\u4EE4 ";
const CLOSE = "\uFF09";

describe("commandOfConnectionError（尾缀归因单源）", () => {
  it("带尾缀 → 命令 type；message 其余部分不参与", () => {
    expect(commandOfConnectionError(`沙箱配置非法${OPEN}config.set_sandbox${CLOSE}`)).toBe("config.set_sandbox");
    expect(commandOfConnectionError(`端点不存在${OPEN}steward.memory_pin${CLOSE}`)).toBe("steward.memory_pin");
  });

  it("无尾缀（旧 daemon / 非命令类握手拒绝）→ undefined（调用方按容忍策略处理）", () => {
    expect(commandOfConnectionError("token 无效")).toBeUndefined();
    expect(commandOfConnectionError("")).toBeUndefined();
  });

  it("尾缀必须收在 message 末尾（句中提及命令名不归因）", () => {
    expect(commandOfConnectionError(`config.set_port 失败${OPEN}config.set_port${CLOSE} 再试`)).toBeUndefined();
  });

  it("daemon 单一构造点的尾缀模板在场（跨包契约钉子）", () => {
    const daemonSrc = readFileSync(
      new URL("../../../../daemon/src/adapters/driving/ws-server/WsServerAdapter.ts", import.meta.url),
      "utf8",
    );
    // 构造形态：`${message}` + 尾缀（命令名取自命令 type 变量）
    expect(daemonSrc).toContain(`${OPEN}\${type}${CLOSE}`);
  });

  it("shell 源码零内联尾缀正则拷贝（单源只许 command-error.ts 持有）", () => {
    // 分片拼接待禁串：本文件自身不得含完整字面量（否则扫描恒真/自伤）
    const needle = "\\" + "uFF08" + "\\" + "u547D" + "\\" + "u4EE4";
    const root = fileURLToPath(new URL("../", import.meta.url)); // = src/
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        if (p.endsWith("/shared/lib/command-error.ts")) continue;
        const text = readFileSync(p, "utf8");
        if (text.includes(needle)) hits.push(p);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
