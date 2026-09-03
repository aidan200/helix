import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 双形态同构守护（AG-16/17/18）—— CL-4/F4.3 + TR-AD-12/R4（TR-AD-35）的
 * A 通道落地（TR-TEST-2 同口径：正则扫描禁区，命中即红；守护随迁纪律 =
 * 断言面随 src-tauri/scripts 目录全部产物生效）。
 *
 * 三面禁区（TR-AD-12「禁止形态特化通道」+ R4「daemon 不按形态分叉」）：
 * - AG-16：壳无 Tauri invoke 直调 daemon（src-tauri 禁 #[tauri::command]/
 *   invoke_handler/generate_handler!；前端禁 invoke( / __TAURI__ / @tauri-apps/api）；
 * - AG-17：壳/脚本层无内嵌 HTTP 直连绕过 WS（fetch/XHR/EventSource 唯一
 *   例外 = shared/api/helix-ws.ts 的 GET /helix-dev-token 握手前提端点；
 *   scripts 例外 = fetch-rg/fetch-codegraph 的 GitHub releases 二进制下载——均非业务
 *   数据通道）+ 壳/脚本层无形态分支连接逻辑（禁 __TAURI__ 形态检测词）；
 * - AG-18：daemon 内无 isCompiled/$bunfs 类形态检测分支（R4/TR-AD-35：
 *   资源定位差异只允许经启动参数注入消解，禁「检测自身形态走另一路径」）。
 *
 * 守护自证（test-design §CL-4/F4.3 RED 点）：findBannedHits 对含违规样例
 * 必须断言出命中（守护自身可红），对干净样例零命中。
 */

const daemonSrc = path.join(import.meta.dir, "..", "..", "src");
const repoRoot = path.join(import.meta.dir, "..", "..", "..", "..");
const tauriSrc = path.join(repoRoot, "apps", "shell", "src-tauri", "src");
const shellSrc = path.join(repoRoot, "apps", "shell", "src");
const scriptsDir = path.join(repoRoot, "scripts");

function listFiles(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (exts.some((ext) => entry.endsWith(ext))) out.push(entry);
  }
  return out.sort();
}

/**
 * 去注释（块注释 + 行注释）——守护目标是代码形态而非注释叙述
 * （例：SubagentLauncher 头注释提及 $bunfs 虚拟路径属设计说明，非形态检测分支）。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** 违规扫描纯函数（守护自证的挂点）：返回 [行号, 命中行] 列表。 */
export function findBannedHits(source: string, pattern: RegExp): Array<[number, string]> {
  const stripped = stripComments(source);
  const hits: Array<[number, string]> = [];
  stripped.split("\n").forEach((line, i) => {
    if (pattern.test(line)) hits.push([i + 1, line.trim()]);
  });
  return hits;
}

// ── 守护自证（RED）：对含违规样例必须变红 ─────────────────────

describe("守护自证：findBannedHits 对违规样例断言变红（test-design §CL-4/F4.3 RED 点）", () => {
  test("AG-16 样例：#[tauri::command] / invoke_handler / 前端 invoke( 必命中", () => {
    expect(
      findBannedHits('#[tauri::command]\nfn greet() -> String { "hi".into() }', TAURI_COMMAND_RE).length,
    ).toBeGreaterThan(0);
    expect(
      findBannedHits(".invoke_handler(tauri::generate_handler![greet])", TAURI_COMMAND_RE).length,
    ).toBeGreaterThan(0);
    expect(
      findBannedHits('import { invoke } from "@tauri-apps/api";\nconst r = await invoke<string>("greet");', FRONTEND_INVOKE_RE).length,
    ).toBeGreaterThan(0);
  });

  test("AG-17 样例：fetch/XHR 直调 daemon HTTP 端点、__TAURI__ 形态分支必命中", () => {
    expect(
      findBannedHits('const r = await fetch("http://127.0.0.1:7333/api/sessions");', HTTP_CALL_RE).length,
    ).toBeGreaterThan(0);
    expect(findBannedHits("const xhr = new XMLHttpRequest();", HTTP_CALL_RE).length).toBeGreaterThan(0);
    expect(
      findBannedHits("const url = (window as any).__TAURI__ ? tauriUrl : browserUrl;", FORM_BRANCH_RE).length,
    ).toBeGreaterThan(0);
  });

  test("AG-18 样例：isCompiled/$bunfs/Bun.embeddedFiles 形态检测分支必命中；注释提及不误伤", () => {
    expect(
      findBannedHits('if (Bun.main.includes("/$bunfs/")) { return bundledMain; }', FORM_DETECT_RE).length,
    ).toBeGreaterThan(0);
    expect(findBannedHits("const compiled = isCompiled();", FORM_DETECT_RE).length).toBeGreaterThan(0);
    expect(findBannedHits("for (const f of Bun.embeddedFiles) { f.name; }", FORM_DETECT_RE).length).toBeGreaterThan(0);
    // 干净面：注释/字符串叙述中的形态词不构成分支（SubagentLauncher 头注释同形态）
    expect(findBannedHits("// compile 形态该实参被产物惰性忽略（$bunfs 虚拟路径）", FORM_DETECT_RE)).toEqual([]);
    expect(findBannedHits("const DAEMON_ENTRY_PATH = join(import.meta.dir, '..', 'main.ts');", FORM_DETECT_RE)).toEqual([]);
  });
});

// ── AG-16：壳无 Tauri invoke 直调 daemon（TR-AD-12 禁区①）─────

/** Rust 侧命令定义面：#[tauri::command] 属性 / invoke_handler / generate_handler! 注册。 */
const TAURI_COMMAND_RE = /#\[tauri::command\]|invoke_handler|generate_handler!/;
/** 前端侧调用面：invoke( 调用 / __TAURI__ 全局 / @tauri-apps/api 依赖。 */
const FRONTEND_INVOKE_RE = /\binvoke\s*(?:<[^>]*>)?\s*\(|__TAURI|@tauri-apps\/api/;

/**
 * W6n 窄豁免：壳 UI 域自有命令（theme_hint——窗口底色/标题栏主题回写缓存，
 * 零 daemon RPC）。守卫意图 = 禁壳→daemon RPC 桥（见 test 名与 TR-AD-12 禁区①）；
 * UI 域命令不触 daemon，与 tauri-plugin-dialog（F3 裁决的壳原生 UX 能力）同类
 * 边界。豁免收敛到精确行：command 属性必须紧邻 `fn theme_hint`，注册必须为
 * 唯一精确行 `invoke_handler(tauri::generate_handler![theme_hint])`——任何其他
 * command/注册仍红。
 */
function isAllowedUiCommandHit(src: string, lineIdx: number): boolean {
  const lines = src.split("\n");
  const line = lines[lineIdx] ?? "";
  if (line.includes("#[tauri::command]")) {
    const next = lines.slice(lineIdx + 1).find((l) => l.trim() !== "");
    return next !== undefined && next.trim().startsWith("fn theme_hint");
  }
  return line.trim() === ".invoke_handler(tauri::generate_handler![theme_hint])";
}

describe("AG-16（CL-4/F4.3，TR-AD-12 禁区①）：壳无 Tauri invoke 直调 daemon", () => {
  test("src-tauri/src 全部 .rs 零 tauri command 定义/注册（壳=薄监督者，零 RPC 桥；W6n 窄豁免 theme_hint UI 域自有命令）", () => {
    const files = listFiles(tauriSrc, [".rs"]);
    expect(files.length).toBeGreaterThan(0); // 扫描面非空转（lib.rs/main.rs 在位）
    let allowedSeen = 0;
    for (const rel of files) {
      const src = readFileSync(path.join(tauriSrc, rel), "utf8");
      const hits = findBannedHits(src, TAURI_COMMAND_RE).filter(
        ([idx]) => !isAllowedUiCommandHit(src, idx - 1),
      );
      for (let i = 0; i < findBannedHits(src, TAURI_COMMAND_RE).length; i++) {
        if (isAllowedUiCommandHit(src, findBannedHits(src, TAURI_COMMAND_RE)[i]![0] - 1)) allowedSeen++;
      }
      expect(hits, `src-tauri/src/${rel} 出现 tauri command 面：${JSON.stringify(hits)}`).toEqual([]);
    }
    // 守护自证（豁免面非死代码）：main.rs 必须实际含 theme_hint UI 命令（3 命中 = 属性+fn 内属性行+注册行计数）
    expect(allowedSeen, "theme_hint UI 命令豁免面应在场（守卫自证）").toBeGreaterThan(0);
  });

  test("apps/shell/src 全部产物零 invoke( / __TAURI__ / @tauri-apps/api（前端唯一通路=WS）", () => {
    const files = listFiles(shellSrc, [".ts", ".tsx"]);
    expect(files.length).toBeGreaterThan(0); // 扫描面非空转
    for (const rel of files) {
      const src = readFileSync(path.join(shellSrc, rel), "utf8");
      const hits = findBannedHits(src, FRONTEND_INVOKE_RE);
      expect(hits, `apps/shell/src/${rel} 出现 invoke 直调面：${JSON.stringify(hits)}`).toEqual([]);
    }
  });
});

// ── AG-17：壳/脚本层无内嵌 HTTP 直连绕过 WS + 无形态分支连接 ───

/** HTTP 直连调用面：fetch( / XHR / EventSource / axios。 */
const HTTP_CALL_RE = /\bfetch\s*\(|new\s+XMLHttpRequest\s*\(|new\s+EventSource\s*\(|\baxios\s*[.(]/;
/** 形态分支连接面：__TAURI__ / __TAURI_INTERNALS__ 形态检测词（TR-AD-12 禁区③）。 */
const FORM_BRANCH_RE = /__TAURI(_INTERNALS)?__/;
/** Rust 侧 HTTP client 面（壳内嵌 HTTP 直连的 Rust 形态）。 */
const RUST_HTTP_RE = /\breqwest::|\bureq::|\bhyper::|\bisahc::|\bsurf::/;

/** token 端点唯一例外（TR-AD-12 白名单句：GET /helix-dev-token 是握手前提，非业务数据通道）。 */
const TOKEN_FETCH_FILE = path.join("shared", "api", "helix-ws.ts");
/** 三方二进制下载例外集（scripts 面：GitHub releases 拉取，非 daemon 通道——rg + codegraph）。 */
const BINARY_FETCH_FILES: readonly string[] = ["fetch-rg.ts", "fetch-codegraph.ts"];
/**
 * W5 预绑定通道唯一例外（scripts 面）：dev-desktop 经 daemon 公开 WS 协议
 *（hello 握手 + workspace.open，与前端同一通道——非绕过 TR-AD-12）做
 * e2e/无头场景预绑定。约束：目标恒 127.0.0.1 回环（禁外网 ws/wss），
 * HTTP fetch 面仍禁（token 经文件读取不走 HTTP）。
 */
const PREBIND_FILE = "dev-desktop.ts";

describe("AG-17（CL-4/F4.3，TR-AD-12 禁区②③）：壳/脚本层无 HTTP 直连绕过 WS、无形态分支连接", () => {
  test("apps/shell/src：HTTP 调用面唯一落点 = shared/api/helix-ws.ts（token 端点），且其 fetch 全打 /helix-dev-token", () => {
    const files = listFiles(shellSrc, [".ts", ".tsx"]).filter((rel) => !/\.test\.tsx?$/.test(rel));
    for (const rel of files) {
      const src = readFileSync(path.join(shellSrc, rel), "utf8");
      const hits = findBannedHits(src, HTTP_CALL_RE);
      if (rel === TOKEN_FETCH_FILE) {
        // 唯一例外文件：每个 fetch( 调用行必须指向 /helix-dev-token（TR-AD-12 白名单端点）。
        // 按原始行判定（去注释会截断 http:// 后的模板串路径）。
        expect(hits.length, `${rel} 应实际含 token fetch（守护面非空转）`).toBeGreaterThan(0);
        for (const line of src.split("\n")) {
          if (/\bfetch\s*\(/.test(line)) {
            expect(line, `${rel} 的 fetch 目标必须是 /helix-dev-token：${line.trim()}`).toContain("/helix-dev-token");
          }
        }
        continue;
      }
      expect(hits, `apps/shell/src/${rel} 出现 HTTP 直连（业务面唯一通路=WS）：${JSON.stringify(hits)}`).toEqual([]);
    }
  });

  test("apps/shell/src + scripts：零 __TAURI__ 形态分支连接词（双形态同一连接代码路径）", () => {
    const shellFiles = listFiles(shellSrc, [".ts", ".tsx"]).filter((rel) => !/\.test\.tsx?$/.test(rel));
    for (const rel of shellFiles) {
      const hits = findBannedHits(readFileSync(path.join(shellSrc, rel), "utf8"), FORM_BRANCH_RE);
      expect(hits, `apps/shell/src/${rel} 出现形态分支连接词：${JSON.stringify(hits)}`).toEqual([]);
    }
    const scriptFiles = listFiles(scriptsDir, [".ts"]).filter((rel) => !rel.endsWith(".test.ts"));
    expect(scriptFiles.length).toBeGreaterThan(0); // 扫描面非空转
    for (const rel of scriptFiles) {
      const hits = findBannedHits(readFileSync(path.join(scriptsDir, rel), "utf8"), FORM_BRANCH_RE);
      expect(hits, `scripts/${rel} 出现形态分支连接词：${JSON.stringify(hits)}`).toEqual([]);
    }
  });

  test("scripts（工程层，非测试面）：HTTP/WS 调用面唯一落点 = fetch-rg.ts（rg 下载），且其不触 daemon 回环", () => {
    // 测试文件（*.test.ts）豁免：dev-desktop.test 等的 raw socket/WebSocket 探测
    // 是编排面自动化断言 harness，非分发/连接通道。
    const files = listFiles(scriptsDir, [".ts"]).filter((rel) => !rel.endsWith(".test.ts"));
    const WS_CALL_RE = /new\s+WebSocket\s*\(/;
    for (const rel of files) {
      const src = readFileSync(path.join(scriptsDir, rel), "utf8");
      const httpHits = findBannedHits(src, HTTP_CALL_RE);
      const wsHits = findBannedHits(src, WS_CALL_RE);
      if (BINARY_FETCH_FILES.includes(rel)) {
        expect(httpHits.length, `${rel} 应实际含二进制下载 fetch（守护面非空转）`).toBeGreaterThan(0);
        // 下载唯一对象 = GitHub releases：不得触 daemon 回环/WS
        const daemonHits = findBannedHits(src, /127\.0\.0\.1|localhost|ws:\/\//);
        expect(daemonHits, `${rel} 不得触 daemon 回环地址：${JSON.stringify(daemonHits)}`).toEqual([]);
        continue;
      }
      if (rel === PREBIND_FILE) {
        // W5 预绑定：WS 面存在且仅限 daemon 回环；HTTP fetch 面仍禁（守护面非空转）
        expect(wsHits.length, `${rel} 应实际含预绑定 WS（守护面非空转）`).toBeGreaterThan(0);
        expect(httpHits, `${rel} 预绑定不得开 HTTP 面（token 走文件读）：${JSON.stringify(httpHits)}`).toEqual([]);
        const extWs = findBannedHits(src, /wss:\/\//);
        expect(extWs, `${rel} 禁外网 WS：${JSON.stringify(extWs)}`).toEqual([]);
        // 按原始行判定：每个 new WebSocket( 行必须钉 127.0.0.1 回环
        for (const line of src.split("\n")) {
          if (/new\s+WebSocket\s*\(/.test(line)) {
            expect(line, `${rel} 的 WS 目标必须钉 127.0.0.1：${line.trim()}`).toContain("127.0.0.1");
          }
        }
        continue;
      }
      expect(
        [...httpHits, ...wsHits],
        `scripts/${rel} 出现 HTTP/WS 直连调用面（工程层不开业务通道）：${JSON.stringify([...httpHits, ...wsHits])}`,
      ).toEqual([]);
    }
  });

  test("src-tauri/src：零 Rust HTTP client 面（壳不内嵌 HTTP 直连）", () => {
    for (const rel of listFiles(tauriSrc, [".rs"])) {
      const hits = findBannedHits(readFileSync(path.join(tauriSrc, rel), "utf8"), RUST_HTTP_RE);
      expect(hits, `src-tauri/src/${rel} 出现 Rust HTTP client 面：${JSON.stringify(hits)}`).toEqual([]);
    }
  });
});

// ── AG-18：daemon 无形态检测分支（R4/TR-AD-35）────────────────

/** 形态检测分支面：isCompiled / $bunfs / Bun.embeddedFiles（R4 禁区：
 * 禁「检测自身是 compile 产物则走另一路径」；资源定位差异经启动参数注入消解）。 */
const FORM_DETECT_RE = /\bisCompiled\b|\$bunfs|Bun\.embeddedFiles/;

describe("AG-18（CL-4/F4.3，R4/TR-AD-35）：daemon 内无 isCompiled/$bunfs 类形态检测分支", () => {
  test("apps/daemon/src 全部产物零形态检测分支词（注释叙述不误伤）", () => {
    const files = listFiles(daemonSrc, [".ts"]);
    expect(files.length).toBeGreaterThan(0); // 扫描面非空转
    for (const rel of files) {
      const src = readFileSync(path.join(daemonSrc, rel), "utf8");
      const hits = findBannedHits(src, FORM_DETECT_RE);
      expect(hits, `apps/daemon/src/${rel} 出现形态检测分支（R4/TR-AD-35）：${JSON.stringify(hits)}`).toEqual([]);
    }
  });
});
