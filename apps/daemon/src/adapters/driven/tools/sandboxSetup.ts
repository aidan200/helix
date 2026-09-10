/**
 * 沙箱装配面：配置读取 + 自检降级 → SandboxRuntime | undefined。
 *
 * 配置落点：`<helixHome>/sandbox.json`（`{ "enabled": true }`；缺文件/解析
 * 失败/非 true → off——失败安全方向是「不沙箱」而非「锁死」）。home 即
 * daemon 全局单点（TR-96 daemon 绑定单一 workspace 运行——home 级开关
 * 与 workspace 级等价），子进程经 HELIX_DB_PATH dirname 推得同一 home。
 *
 * 自检（mode=on 时，模块级缓存——daemon 进程内一次）：
 * ① /usr/bin/sandbox-exec 存在且可执行；② 试跑 profile 包裹 /bin/sh -c true
 * 成功。任一失败 → console.warn + 返回 undefined（自动降级透传，不锁死）。
 */

import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { parseSandboxConfig } from "../../../domain/sandbox/SandboxPolicy";
import { buildSeatbeltProfile } from "../../../domain/sandbox/seatbeltProfile";
import type { SandboxRuntime } from "./SandboxEnvWrap";

/** 自检结果缓存（roots 指纹 → 可用性）。 */
const selfCheckCache = new Map<string, boolean>();

/** /usr/bin/sandbox-exec 硬路径（防 PATH 劫持——照 codex 纪律）。 */
const SEATBELT_BIN = "/usr/bin/sandbox-exec";

function seatbeltAvailable(): boolean {
  try {
    accessSync(SEATBELT_BIN, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 试跑：沙箱内执行 /bin/sh -c true（profile 真实生效性验证——行为漂移探测）。 */
function selfCheck(profileText: string, cacheKey: string): boolean {
  const cached = selfCheckCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let ok = false;
  if (seatbeltAvailable()) {
    try {
      // -p 接内联 profile 文本（-f 才是文件）——自检零落盘
      const res = spawnSync(SEATBELT_BIN, ["-p", profileText, "--", "/bin/bash", "-c", "true"], {
        encoding: "utf-8",
        timeout: 10_000,
      });
      ok = res.status === 0;
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    console.warn(
      `[helix-sandbox] 自检失败：sandbox-exec 不可用或 profile 试跑未通过——本进程沙箱自动降级为关闭（bash/文件写不受限，仅记录警示）。`,
    );
  }
  selfCheckCache.set(cacheKey, true === ok);
  return ok;
}

/**
 * 读取沙箱配置并装配 SandboxRuntime。off / 配置缺失 / 自检失败 → undefined
 * （CoreToolExecutor 未注入 = 纯透传，行为零差）。
 */
export function readSandboxRuntime(helixHome: string, workspaceRoot: string): SandboxRuntime | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(helixHome, "sandbox.json"), "utf-8"));
  } catch {
    return undefined; // 缺文件/解析失败 → off（失败安全：不沙箱不锁死）
  }
  let policy = parseSandboxConfig(raw, workspaceRoot, helixHome);
  if (policy.mode !== "on") return undefined;
  // roots realpath 归一 + per-user tmpdir 追加：macOS 符号链接（/var → /private/var）
  // ——subpath 匹配真实 vnode 路径，未归一的 root 形同未放行；TMPDIR 的
  // DARWIN_USER_TEMP_DIR 因人而异，静态 SCRATCH 段覆盖不了，运行时入 roots
  // （codex 同题解法是剥 TMPDIR 回退 /tmp——helix 取更简的入根法）
  policy = {
    ...policy,
    writableRoots: [
      ...policy.writableRoots.map((r) => {
        try {
          return realpathSync(r);
        } catch {
          return r; // 不存在的路径保留原样（写时自然失败）
        }
      }),
      realpathSync(tmpdir()),
    ],
  };
  const profileDir = path.join(helixHome, "sandbox");
  const cacheKey = policy.writableRoots.join("\u0000");
  if (!selfCheck(buildSeatbeltProfile(policy), cacheKey)) return undefined;
  return { policy, profileDir };
}
