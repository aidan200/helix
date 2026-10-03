/**
 * 管家全局光球层 CSS 纪律测试（B2 皮面 + 手绘帧动画雪碧图换皮；node 环境
 * 直读样式表——jsdom 不加载 CSS；steward-dock.css.test 直读模式同构）。
 *
 * 钉纪律（Cyber HUD 铁律：色值/字号走 token 注册表变量零内联 hex；E-124
 * WKWebView：animation 简写禁 calc()/var()）：
 * - .stv 真全屏语义：fixed 视口层 + z 序压过 StewardDock（z-index 68）；
 * - 字幕条玻璃族（用户裁决视觉例外）：popover-fill + blur 14px（亮色降
 *   10px）+ shadow-pop 保持；**直角（radius 0）+ 无边框**（用户裁决，
 *   E-135 玻璃族 border/10px 圆角条款对管家族例外——候选台账留痕）；
 *   满窗高（max-height = 100vh - 126px：扣 bottom 20 + 光球 96 + 间距 10）
 *   + justify-content: flex-end（溢出裁最旧行于顶，最新行恒完整——
 *   「最下面一行显示不全」根修）——**光球命中区 96px 是该 calc 的锚**；
 * - 雪碧图皮面（用户手绘 orb.png 6×6 网格/36px 帧）：单层 .stv-sprite；
 *   帧停点=background-position 逐 keyframe steps(1,end)（帧动画标准式
 *   ——keyframes 允许面含 background-position，其余布局/绘制属性仍禁）；
 *   intro/loop 串联全常量（含 thinking 疑问→思考两段式 iteration/delay）；
 * - RMS=整图微缩放：--stv-lv 由 TSX 预计算（E-124：calc 乘法不进 CSS
 *   ——**整段 calc( 零容忍**）；animation 简写零 var()/calc()；
 * - reduced-motion 全关停（!important 压相位类特异性）+ 各相位静态代表帧。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../../../shared/ui/styles/app.css", import.meta.url)),
  "utf8",
);

const SEG_START = css.indexOf("/* ── 管家全局光球层");
expect(SEG_START).toBeGreaterThan(0);
const seg = css.slice(SEG_START);

describe("管家全局光球层 CSS 纪律（Cyber HUD token 合规 + 帧动画雪碧图皮面）", () => {
  it("真全屏语义：fixed 视口层 + z-index 68（压过 StewardDock 60/ConfirmStack 65）+ pointer-events 穿透", () => {
    expect(seg).toMatch(/\.stv\s*\{[^}]*position:\s*fixed/);
    expect(seg).toMatch(/\.stv\s*\{[^}]*z-index:\s*68/);
    expect(seg).toMatch(/\.stv\s*\{[^}]*pointer-events:\s*none/);
    expect(seg).toMatch(/\.stv-orb\s*\{[^}]*pointer-events:\s*auto/); // 光球本体可点（D5）
  });

  it("光球命中区 96px（字幕条满窗高 calc(100vh - 126px) 的锚：20 底距 + 96 球 + 10 间距）", () => {
    expect(seg).toMatch(/\.stv-orb\s*\{[^}]*width:\s*96px/);
    expect(seg).toMatch(/\.stv-orb\s*\{[^}]*height:\s*96px/);
  });

  it("字幕条玻璃族（用户裁决）：直角 + 无边框 + 满窗高 + 溢出裁顶保最新行", () => {
    const caption = seg.match(/\.stv-caption\s*\{[^}]*\}/)![0];
    expect(seg).toMatch(/\.stv-caption\s*\{[^}]*background:\s*var\(--popover-fill\)/);
    expect(seg).toMatch(/\.stv-caption\s*\{[^}]*backdrop-filter:\s*blur\(14px\)/);
    expect(seg).toMatch(/html\.light \.stv-caption\s*\{[^}]*backdrop-filter:\s*blur\(10px\)/);
    expect(seg).toMatch(/\.stv-caption\s*\{[^}]*box-shadow:\s*var\(--shadow-pop\)/);
    expect(caption).toMatch(/border-radius:\s*0/); // 直角（用户裁决）
    expect(caption).not.toMatch(/border:/); // 无边框（用户裁决）
    expect(caption).toMatch(/max-height:\s*calc\(100vh - 126px\)/); // 满窗高（扣 bottom 20 + 光球 96 + gap 10）
    expect(caption).toMatch(/justify-content:\s*flex-end/); // 溢出裁最旧行于顶，最新行恒完整
  });

  it("零内联 hex / 零裸 rgb 三元字面量（通道变量模式唯一合法）", () => {
    expect(seg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const bareRgb = seg.match(/rgb\((?!\s*var\()[^)]*\)/g) ?? [];
    expect(bareRgb).toEqual([]);
  });

  it("字号全走 --text-* 语义阶梯（无 px 字号字面量）", () => {
    expect(seg).not.toMatch(/font-size:\s*\d/);
    expect(seg).toMatch(/font-size:\s*var\(--text-body\)/);
  });

  it("雪碧图皮面：单层 .stv-sprite 引 orb.png + 6×6 满格（600%）+ 像素硬边放大", () => {
    const sprite = seg.match(/\.stv-sprite\s*\{[^}]*\}/)![0];
    expect(sprite).toMatch(/background-image:\s*url\("[^"]*assets\/steward\/orb\.png"\)/);
    // url 相对路径必须真实解析到文件（app.css 位于 shared/ui/styles/——差一层
    // 就是运行时 404 无图；--no-verify 提交漏网教训，文件系统钉住）
    const rel = sprite.match(/url\("([^"]+)"\)/)?.[1] ?? "";
    const cssDir = fileURLToPath(new URL("../../../shared/ui/styles/", import.meta.url));
    expect(existsSync(resolve(cssDir, rel))).toBe(true);
    expect(sprite).toMatch(/background-size:\s*600% 600%/); // 6×6 网格整图 6 倍容器
    expect(sprite).toMatch(/background-repeat:\s*no-repeat/);
    expect(sprite).toMatch(/image-rendering:\s*pixelated/); // 36px 帧硬边放大（像素风）
    expect(sprite).toMatch(/transform:\s*scale\(var\(--stv-lv, 1\)\)/); // RMS 微缩放（var 只入 transform）
  });

  it("九序列 keyframes 齐备（待机/疑问·思考·倾听·说话 各 intro+loop；帧位=(列-1)×20% (行-1)×20%）", () => {
    const names = [
      "stv-idle",
      "stv-query-in", "stv-query-loop",
      "stv-think-in", "stv-think-loop",
      "stv-listen-in", "stv-listen-loop",
      "stv-speak-in", "stv-speak-loop",
    ];
    for (const name of names) {
      expect(seg.includes(`@keyframes ${name} `), `keyframes ${name} 应存在`).toBe(true);
    }
  });

  it("帧表抽查：一停点一帧（首帧双拍是错写）+ 待机回绕 (1,1) + 说话回摆 + intro 待机基准", () => {
    const idle = seg.match(/@keyframes stv-idle\s*\{[\s\S]*?\n\}/)![0];
    expect(idle).toMatch(/0% \{ background-position: 0% 0%; \}/); // (1,1) 首帧单停点
    expect(idle).toMatch(/80% \{ background-position: 0% 0%; \}/); // 回绕帧=首帧（无缝循环）
    const speakLoop = seg.match(/@keyframes stv-speak-loop\s*\{[\s\S]*?\n\}/)![0];
    expect(speakLoop).toMatch(/40% \{ background-position: 100% 100%; \}/); // (6,6) 张嘴峰值
    expect(speakLoop).toMatch(/60% \{ background-position: 80% 100%; \}/); // (6,5) 回摆
    expect(speakLoop).toMatch(/80% \{ background-position: 60% 100%; \}/); // (6,4) 回绕
    const speakIn = seg.match(/@keyframes stv-speak-in\s*\{[\s\S]*?\n\}/)![0];
    expect(speakIn).toMatch(/0% \{ background-position: 0% 0%; \}/); // intro 从待机基准 (1,1) 出发
    // 防回归：双停点写法（0%, 20% {…}）会让首帧停两拍丢末帧——探针验证过的教训
    expect(seg).not.toMatch(/0%, 20% \{/);
  });

  it("相位动画映射：intro 单次 forwards + loop 无限（delay=intro 时长）；thinking 两段式串联", () => {
    const listen = seg.match(/\.stv-orb\.stv-phase-listening \.stv-sprite\s*\{[^}]*\}/)![0];
    expect(listen).toMatch(/stv-listen-in 0\.5s steps\(1,end\) 1 forwards/);
    expect(listen).toMatch(/stv-listen-loop 0\.9s steps\(1,end\) infinite 0\.5s/);
    const think = seg.match(/\.stv-orb\.stv-phase-thinking \.stv-sprite\s*\{[^}]*\}/)![0];
    expect(think).toMatch(/stv-query-loop 0\.9s steps\(1,end\) 2 0\.5s forwards/); // 疑问循环×2（1.8s）
    expect(think).toMatch(/stv-think-in 0\.5s steps\(1,end\) 1 2\.3s forwards/); // →思考 intro（图布局 (3,1)(3,2) 衔接）
    expect(think).toMatch(/stv-think-loop 0\.9s steps\(1,end\) infinite 2\.8s/);
    // welcome 复用说话（欢迎语即管家输出——同动画声明不重启，衔接不闪）
    const speakSel = seg.match(/\.stv-orb\.stv-phase-speaking \.stv-sprite,\s*\.stv-orb\.stv-phase-welcome \.stv-sprite\s*\{[^}]*\}/);
    expect(speakSel).not.toBeNull();
  });

  it("muted/closing 冻结当前帧（paused 无跳变）+ muted 暗淡", () => {
    expect(seg).toMatch(/\.stv-orb\.stv-phase-closing \.stv-sprite\s*\{[^}]*animation-play-state:\s*paused/);
    expect(seg).toMatch(/\.stv-orb\.stv-muted \.stv-sprite\s*\{[^}]*animation-play-state:\s*paused/);
    expect(seg).toMatch(/\.stv-orb\.stv-muted\s*\{[^}]*opacity:\s*0\.6/);
  });

  it("光球皮面段 calc 零容忍（E-124 加严：RMS 系数 TSX 预计算 --stv-lv；字幕条布局 calc 为减法合法保留项）", () => {
    const orbSeg = seg.slice(seg.indexOf("/* 光球（帧动画"));
    expect(orbSeg.length).toBeGreaterThan(0);
    expect(orbSeg).not.toMatch(/calc\(/);
  });

  it("keyframes 仅 background-position/transform/opacity + animation 简写零 var()/calc()（E-124；帧动画特例：帧停点合法动 background-position）", () => {
    const kfBlocks = seg.match(/@keyframes stv-[a-z-]+[\s\S]*?\n\}/g) ?? [];
    expect(kfBlocks.length).toBeGreaterThanOrEqual(9);
    for (const block of kfBlocks) {
      expect(
        block.match(/(?:left|top|right|bottom|width|height|background(?!-position)|border|box-shadow|margin|padding|filter)\s*:/),
      ).toBeNull();
    }
    const animationLines = seg.match(/animation:[^;]+;/g) ?? [];
    for (const line of animationLines) {
      expect(line.includes("var(")).toBe(false);
      expect(line.includes("calc(")).toBe(false);
    }
  });

  it("reduced-motion 全关停（!important 压相位类特异性）+ 各相位静态代表帧兜底（声明两用）", () => {
    expect(seg).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.stv-sprite\s*\{[^}]*animation:\s*none !important/);
    // 相位类带静态 background-position（动画关停后落位代表帧）
    expect(seg).toMatch(/\.stv-orb\.stv-phase-listening \.stv-sprite\s*\{[^}]*background-position:\s*40% 80%/); // (5,3)
    expect(seg).toMatch(/\.stv-orb\.stv-phase-speaking \.stv-sprite,\s*\.stv-orb\.stv-phase-welcome \.stv-sprite\s*\{[^}]*background-position:\s*60% 100%/); // (6,4)
  });
});
