// @vitest-environment jsdom
/**
 * S4 project 页迁 AppLayout 装配测试（壳统一收尾；施工牌本体零变更）。
 *
 * 断言面（brief-S4 验收 a/b）：
 * - AppLayout 组装：.app-layout/.app-header 在场，headerLeft = 页名词条
 *   （chat.nav.pages.project.label）；
 * - main = 施工牌本体（data-construction 断言锚在 .layout-main 内），
 *   name/route/preview 完整呈现（CL-4 施工牌契约不回归）；
 * - sidebar 槽不启用：.layout-body 直系子仅 .layout-main 一枚（预留语义
 *   见页面 docblock，非渲染面）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import ProjectPage from "./ProjectPage";

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

function ui() {
  return render(
    <I18nProvider>
      <ProjectPage path="/project" />
    </I18nProvider>,
  );
}

describe("S4 project 页 AppLayout 壳统一", () => {
  it("AppLayout 组装：壳骨架在场 + headerLeft = 页名词条（chat.nav.pages.project.label）", () => {
    ui();
    expect(document.querySelector(".app-layout")).not.toBeNull();
    const header = document.querySelector(".app-header")!;
    expect(header).not.toBeNull();
    expect(header.querySelector(".tb-title")!.textContent).toBe("项目 project");
  });

  it("main = 施工牌本体：data-construction 锚在 .layout-main 内，name/route/preview 完整呈现", () => {
    ui();
    const main = document.querySelector(".layout-main")!;
    expect(main).not.toBeNull();
    const board = main.querySelector('[data-construction="/project"]')!;
    expect(board).not.toBeNull();
    const frame = board.querySelector(".construction-frame")!;
    expect(frame.querySelector(".cs-name")!.textContent).toBe("项目 project");
    expect(frame.querySelector(".cs-route")!.textContent).toBe("/project");
    expect(frame.querySelector(".cs-preview")!.textContent).toBe(
      "工作区文档、知识图谱与迭代状态的总览入口。",
    );
    expect(frame.querySelector(".hud-badge-cyan")).not.toBeNull();
  });

  it("sidebar 槽不启用：.layout-body 直系子仅 .layout-main 一枚", () => {
    ui();
    const body = document.querySelector(".layout-body")!;
    expect(body).not.toBeNull();
    expect(body.children).toHaveLength(1);
    expect(body.children[0]!.className).toBe("layout-main");
  });
});
