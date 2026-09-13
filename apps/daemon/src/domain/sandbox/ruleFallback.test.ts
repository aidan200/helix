import { describe, expect, test } from "bun:test";

import { parseSandboxConfig } from "./SandboxPolicy";
import { classifyBashWrites, fallbackDeniedMessage, resolveEnforcer } from "./ruleFallback";

const WS = "/Users/x/work";
const HOME = "/Users/x/.helix";
const policy = parseSandboxConfig({ enabled: true }, WS, HOME);

const CWD = `${WS}/apps/daemon`;

describe("classifyBashWrites（规则级写判定）", () => {
  test("重定向越界（绝对路径）", () => {
    const v = classifyBashWrites("echo x > /etc/hosts", CWD, policy);
    expect(v.allowed).toBe(false);
    expect(v.violations).toEqual(["/etc/hosts"]);
  });

  test("重定向 workspace 内（相对路径按 cwd 解析）", () => {
    expect(classifyBashWrites("echo x > out.log", CWD, policy).allowed).toBe(true);
    expect(classifyBashWrites("echo x > ../out.log", CWD, policy).allowed).toBe(true); // → WS/apps/out.log ✓
  });

  test("cd-aware：cd 进系统目录后的相对写判定", () => {
    const v = classifyBashWrites("cd /etc && echo x > hosts && cp hosts /tmp2/x", CWD, policy);
    expect(v.allowed).toBe(false);
    expect(v.violations).toEqual(["/etc/hosts", "/tmp2/x"]); // cp 绝对目标同样参与判定（不存在不影响越界判定）
  });

  test("mv 双参目标越界 / rm 越界", () => {
    expect(classifyBashWrites("mv a.ts /usr/local/bin/a", CWD, policy).allowed).toBe(false);
    expect(classifyBashWrites("rm /Users/x/.ssh/known_hosts", CWD, policy).allowed).toBe(false);
  });

  test("sed -i 就地写（workspace 内放行 / 系统路径拒）", () => {
    expect(classifyBashWrites("sed -i '' 's/a/b/' src/x.ts", CWD, policy).allowed).toBe(true);
    expect(classifyBashWrites("sed -i '' 's/a/b/' /etc/hosts", CWD, policy).allowed).toBe(false);
  });

  test("git 写子命令（apply/checkout 越界 patch 源也拦）", () => {
    expect(classifyBashWrites("git apply /etc/evil.patch", CWD, policy).allowed).toBe(false);
  });

  test("不可判定类零候选放行（python -c / node -e / eval）", () => {
    expect(classifyBashWrites("python3 -c 'open(\"/etc/x\",\"w\")'", CWD, policy).allowed).toBe(true);
    expect(classifyBashWrites("node -e 'fs.writeFileSync(\"/etc/x\",\"\")'", CWD, policy).allowed).toBe(true);
    expect(classifyBashWrites("make build && bun test", CWD, policy).allowed).toBe(true);
  });

  test("只读命令零候选", () => {
    expect(classifyBashWrites("ls -la | grep foo; cat README.md; find . -name '*.ts'", CWD, policy).allowed).toBe(true);
  });

  test("失锁段（cd $VAR）相对候选丢弃——绝对候选仍判", () => {
    const v = classifyBashWrites("cd $DIR && echo x > rel.txt && echo y > /etc/hosts2", CWD, policy);
    expect(v.allowed).toBe(false);
    expect(v.violations).toEqual(["/etc/hosts2"]); // rel.txt 丢弃（错根误判比漏判糟）
  });

  test("段折叠逃逸（../../.. 钻出 workspace）", () => {
    const v = classifyBashWrites("echo x > ../../../../etc/hosts", CWD, policy);
    expect(v.allowed).toBe(false);
    expect(v.violations[0]?.endsWith("/etc/hosts")).toBe(true);
  });

  test("writableRoots 内的 home（~/.helix）写放行", () => {
    expect(classifyBashWrites(`echo x > ${HOME}/reports/r.json`, CWD, policy).allowed).toBe(true);
  });
});

describe("fallbackDeniedMessage（出路文案）", () => {
  test("含越界清单 + 三条出路", () => {
    const m = fallbackDeniedMessage(["/etc/hosts"]);
    expect(m).toContain("/etc/hosts");
    expect(m).toContain("write/edit");
    expect(m).toContain("允许面");
  });
});

describe("resolveEnforcer（执行器形态决策）", () => {
  test("darwin + 自检过 → seatbelt", () => {
    expect(resolveEnforcer("darwin", true)).toBe("seatbelt");
  });
  test("darwin + 自检败 → fallback", () => {
    expect(resolveEnforcer("darwin", false)).toBe("fallback");
  });
  test("win32 / linux → fallback（无 seatbelt）", () => {
    expect(resolveEnforcer("win32", true)).toBe("fallback");
    expect(resolveEnforcer("linux", true)).toBe("fallback");
  });
});
