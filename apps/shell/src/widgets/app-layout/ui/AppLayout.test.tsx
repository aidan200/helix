// @vitest-environment jsdom
/**
 * S1 AppLayout 统一壳布局契约（应用壳统一；后续任务依赖的核心契约）。
 *
 * - 壳结构：.app-layout（100dvh flex column，自身不滚）→ header.app-header
 *   （48px 全宽置顶，headerLeft …spacer… headerRight）→ .layout-body
 *   （flex row，min-height:0）→ sidebar 槽（可省）+ main.layout-main
 *   （flex:1，min-width:0，唯一滚动容器）；
 * - 槽语义：组件只负责布局，不感知内容语义（纯展示，TR-AD-8）；
 * - 根元素 position:relative（承接原 .workbench 的 absolute 定位上下文职责）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import AppLayout from "./AppLayout";

afterEach(cleanup);

describe("S1 AppLayout 布局契约", () => {
  it("壳结构：.app-layout = header.app-header + .layout-body；body = sidebar 槽 + main.layout-main", () => {
    render(
      <AppLayout
        headerLeft={<span>左槽</span>}
        headerRight={<b>右槽</b>}
        sidebar={<nav data-testid="sb" />}
      >
        <div data-testid="content" />
      </AppLayout>,
    );
    const root = document.querySelector(".app-layout")!;
    expect(root.tagName).toBe("DIV");
    expect(Array.from(root.children).map((c) => c.className)).toEqual([
      "app-header",
      "layout-body",
    ]);
    const header = root.children[0]!;
    expect(header.tagName).toBe("HEADER");
    const body = root.children[1]!;
    expect(Array.from(body.children).map((c) => c.tagName)).toEqual(["NAV", "MAIN"]);
    expect(body.children[1]!.className).toBe("layout-main");
    // 槽内容落位：headerLeft 在 .header-right 之前；headerRight 在 .header-right 内
    expect(header.querySelector("span")!.textContent).toBe("左槽");
    expect(header.querySelector(".header-right b")!.textContent).toBe("右槽");
    // children 落位 main.layout-main（唯一滚动容器）
    expect(body.children[1]!.querySelector("[data-testid='content']")).not.toBeNull();
  });

  it("sidebar / headerRight 可省略：无空槽节点残留（.layout-body 仅 main）", () => {
    render(<AppLayout>主区</AppLayout>);
    const root = document.querySelector(".app-layout")!;
    expect(root.querySelector(".header-right")).toBeNull();
    const body = root.querySelector(".layout-body")!;
    expect(body.children.length).toBe(1);
    expect(body.children[0]!.tagName).toBe("MAIN");
    expect(body.children[0]!.textContent).toBe("主区");
  });
});
