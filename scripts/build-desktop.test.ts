/**
 * build-desktop 管线测试（CL-2/F2.1/F2.4；test-design §CL-2；TR-AD-34）。
 *
 * - F2.1 编排：runPipeline 假命令注入各步失败 → 断言管线在对应步中断、
 *   返回该步 exit code（非零）、后续步骤未执行（调用序列记录断言）、
 *   日志含 `✗ 步骤N` + stderr 末 50 行透传。
 * - F2.4 签名配置位：resolveSigning 纯函数三分支——全缺 → adhoc；
 *   部分存在 → sign-only（签名不公证明示）；齐全 → sign-and-notarize。
 * - 接线断言：根 package.json build:desktop 脚本存在且指向本脚本，
 *   既有 dev/test 命令不受影响。
 *
 * 真实全管线跑通（产出 .app/.dmg + codesign ad-hoc 断言）属本任务
 * 一次性验收动作（首次 tauri release 编译分钟级），不挂进常态测试集；
 * 证据落 docs/iterations/iter-20260822-m1uc/evidence/。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  pipelineSteps,
  resolveSigning,
  runPipeline,
  stderrTail,
  type SigningMode,
  type StepResult,
} from "./build-desktop";

const root = join(import.meta.dir, "..");

// ── F2.4 签名配置位判定纯函数（三分支全矩阵）────────────────

describe("resolveSigning（签名配置位纯函数，tauri 官方环境变量键族）", () => {
  test("全缺 → adhoc", () => {
    expect(resolveSigning({})).toBe("adhoc");
    expect(resolveSigning({ UNRELATED: "1" })).toBe("adhoc");
  });

  test("空串/纯空白视为缺失 → adhoc", () => {
    expect(
      resolveSigning({
        APPLE_SIGNING_IDENTITY: "  ",
        APPLE_CERTIFICATE: "",
        APPLE_ID: "\t",
      }),
    ).toBe("adhoc");
  });

  test("仅签名身份 → sign-only（签名不公证）", () => {
    expect(resolveSigning({ APPLE_SIGNING_IDENTITY: "Developer ID Application: X" })).toBe(
      "sign-only",
    );
  });

  test("仅证书对（APPLE_CERTIFICATE + PASSWORD）→ sign-only", () => {
    expect(
      resolveSigning({ APPLE_CERTIFICATE: "base64…", APPLE_CERTIFICATE_PASSWORD: "pw" }),
    ).toBe("sign-only");
  });

  test("证书缺密码 → 视为缺失 → adhoc", () => {
    expect(resolveSigning({ APPLE_CERTIFICATE: "base64…" })).toBe("adhoc");
  });

  test("仅公证凭据（无签名身份）→ 部分存在 → sign-only", () => {
    expect(
      resolveSigning({
        APPLE_ID: "dev@example.com",
        APPLE_PASSWORD: "app-specific",
        APPLE_TEAM_ID: "TEAMID",
      }),
    ).toBe("sign-only");
  });

  test("签名身份 + Apple ID 公证三件套 → sign-and-notarize", () => {
    expect(
      resolveSigning({
        APPLE_SIGNING_IDENTITY: "Developer ID Application: X",
        APPLE_ID: "dev@example.com",
        APPLE_PASSWORD: "app-specific",
        APPLE_TEAM_ID: "TEAMID",
      }),
    ).toBe("sign-and-notarize");
  });

  test("证书对 + API key 公证族 → sign-and-notarize", () => {
    expect(
      resolveSigning({
        APPLE_CERTIFICATE: "base64…",
        APPLE_CERTIFICATE_PASSWORD: "pw",
        APPLE_API_KEY: "KEYID",
        APPLE_API_ISSUER: "issuer-uuid",
      }),
    ).toBe("sign-and-notarize");
  });

  test("签名身份 + 公证缺一项（缺 TEAM_ID）→ sign-only", () => {
    expect(
      resolveSigning({
        APPLE_SIGNING_IDENTITY: "Developer ID Application: X",
        APPLE_ID: "dev@example.com",
        APPLE_PASSWORD: "app-specific",
      }),
    ).toBe("sign-only");
  });

  test("返回类型仅三分支", () => {
    const modes: SigningMode[] = ["adhoc", "sign-only", "sign-and-notarize"];
    expect(modes).toContain(resolveSigning({}));
  });
});

// ── F2.1 管线编排（假命令注入成败，调用序列断言）────────────

describe("pipelineSteps（六步契约）", () => {
  test("六步依序：fetch-rg → fetch-codegraph → compile → F2.2 验证 → vite build → tauri build", () => {
    const steps = pipelineSteps(root);
    expect(steps.length).toBe(6);
    expect(steps[0]!.name).toContain("fetch-rg");
    expect(steps[1]!.name).toContain("fetch-codegraph");
    expect(steps[2]!.name).toContain("compile");
    expect(steps[3]!.name).toContain("F2.2");
    expect(steps[4]!.name).toContain("vite build");
    expect(steps[5]!.name).toContain("tauri build");
  });

  test("vite build / tauri build 工作目录 = apps/shell", () => {
    const steps = pipelineSteps(root);
    expect(steps[4]!.cwd).toBe(join(root, "apps/shell"));
    expect(steps[5]!.cwd).toBe(join(root, "apps/shell"));
  });
});

describe("pipelineSteps（平台分档，TR-95）", () => {
  test("缺省 = darwin-arm64 档（mac 零回归）：fetch/compile 步骤带 --platform darwin-arm64，tauri build 显式 --target aarch64-apple-darwin", () => {
    const steps = pipelineSteps(root);
    expect(steps[0]!.cmd).toContain("--platform");
    expect(steps[0]!.cmd).toContain("darwin-arm64");
    expect(steps[2]!.cmd).toContain("darwin-arm64");
    expect(steps[5]!.cmd).toEqual(["cargo", "tauri", "build", "--target", "aarch64-apple-darwin"]);
  });

  test("windows-x64 档五步（无 F2.2——交叉编译产物 mac 宿主不可执行），tauri build 带 --target", () => {
    const steps = pipelineSteps(root, "windows-x64");
    expect(steps.length).toBe(5);
    expect(steps.map((s) => s.name).some((n) => n.includes("F2.2"))).toBe(false);
    expect(steps[0]!.cmd).toContain("windows-x64");
    expect(steps[1]!.cmd).toContain("windows-x64");
    expect(steps[2]!.cmd).toContain("windows-x64");
    const tauri = steps[4]!;
    expect(tauri.cmd).toEqual(["cargo", "tauri", "build", "--target", "x86_64-pc-windows-msvc"]);
    expect(tauri.cwd).toBe(join(root, "apps/shell"));
  });
});

/** 假 runner：记录调用序列；failAt 指定失败步骤号（1-based）。 */
function fakeRunner(
  failAt: number | null,
  failCode = 7,
  stderr = "",
): { runner: (step: { name: string }) => Promise<StepResult>; calls: string[] } {
  const calls: string[] = [];
  const runner = async (step: { name: string }): Promise<StepResult> => {
    calls.push(step.name);
    if (failAt !== null && calls.length === failAt) {
      return { code: failCode, stderr };
    }
    return { code: 0, stderr: "" };
  };
  return { runner, calls };
}

describe("runPipeline（F2.1 失败即中断）", () => {
  test("全部成功 → 返回 0，六步依序执行，日志带步骤号", async () => {
    const steps = pipelineSteps(root);
    const { runner, calls } = fakeRunner(null);
    const logs: string[] = [];
    const code = await runPipeline(steps, runner, (l) => logs.push(l));
    expect(code).toBe(0);
    expect(calls).toEqual(steps.map((s) => s.name));
    for (let i = 1; i <= steps.length; i++) {
      expect(logs.some((l) => l.includes(`✓ 步骤${i}`))).toBe(true);
    }
  });

  test("步骤1 失败 → 以该步 code 退出，后续步骤未启动", async () => {
    const steps = pipelineSteps(root);
    const { runner, calls } = fakeRunner(1, 3);
    const logs: string[] = [];
    const code = await runPipeline(steps, runner, (l) => logs.push(l));
    expect(code).toBe(3);
    expect(calls).toEqual([steps[0]!.name]); // 后续步骤进程不存在
    expect(logs.some((l) => l.includes("✗ 步骤1") && l.includes("失败"))).toBe(true);
  });

  test("步骤3（F2.2 验证）失败 → 前三步执行、后两步未执行 + stderr 末 50 行透传", async () => {
    const steps = pipelineSteps(root);
    const stderr60 = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n");
    const { runner, calls } = fakeRunner(3, 42, stderr60);
    const logs: string[] = [];
    const code = await runPipeline(steps, runner, (l) => logs.push(l));
    expect(code).toBe(42);
    expect(calls).toEqual(steps.slice(0, 3).map((s) => s.name));
    const out = logs.join("\n");
    expect(out).toContain("✗ 步骤3");
    expect(out).toContain("exit 42");
    expect(out).toContain("line-60"); // 末行在
    expect(out).toContain("line-11"); // 末 50 行起点在
    expect(out).not.toContain("line-10"); // 第 50 行之前被截断
  });

  test("末步（tauri build）失败 → 全部六步执行后以非零退出", async () => {
    const steps = pipelineSteps(root);
    const { runner, calls } = fakeRunner(6, 1);
    const code = await runPipeline(steps, runner, () => {});
    expect(code).toBe(1);
    expect(calls).toEqual(steps.map((s) => s.name));
  });
});

describe("stderrTail（末 N 行截取）", () => {
  test("不足 N 行 → 原样", () => {
    expect(stderrTail("a\nb\nc", 50)).toBe("a\nb\nc");
  });
  test("超 N 行 → 只保留末 N 行", () => {
    const text = Array.from({ length: 60 }, (_, i) => `l${i + 1}`).join("\n");
    expect(stderrTail(text, 50)).toBe(
      Array.from({ length: 50 }, (_, i) => `l${i + 11}`).join("\n"),
    );
  });
  test("空串 → 空串", () => {
    expect(stderrTail("", 50)).toBe("");
  });
});

// ── 接线断言：根 package.json build:desktop ─────────────────

test("根 package.json build:desktop 接线，既有 dev/test 不受影响", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts["build:desktop"]).toContain("build-desktop");
  expect(pkg.scripts["dev"]).toBe("bun apps/daemon/src/main.ts");
  // test 脚本可挂后缀链（如 test:protocol），只锚 daemon 测试主链仍在首位
  expect(pkg.scripts["test"]).toContain("bun test apps/daemon");
});
