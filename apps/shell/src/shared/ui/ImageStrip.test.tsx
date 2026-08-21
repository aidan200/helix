// @vitest-environment jsdom
/**
 * ImageStrip 测试（T9 图片下行/上行共用渲染件）：缩略图行 + 点击放大
 * lightbox（Esc/点外关闭）。user 气泡与工具卡复用同一组件。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import ImageStrip from "./ImageStrip";

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

function ui(images: string[]) {
  return render(
    <I18nProvider>
      <ImageStrip images={images} />
    </I18nProvider>,
  );
}

afterEach(cleanup);
localStorage.setItem("helix-lang", "zh-CN");

describe("ImageStrip（T9 图片渲染共用件）", () => {
  it("渲染缩略图行：每张图一个 img（data URL 直载，alt 带序号）", () => {
    ui([TINY_PNG, TINY_JPEG]);
    const imgs = screen.getAllByRole("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0]!.getAttribute("src")).toBe(TINY_PNG);
    expect(imgs[1]!.getAttribute("src")).toBe(TINY_JPEG);
    expect(imgs[0]!.getAttribute("alt")).toContain("1");
  });

  it("点击缩略图放大（lightbox 大图）；Esc 关闭", () => {
    ui([TINY_PNG]);
    fireEvent.click(screen.getByRole("img"));
    // lightbox：大图 img（与缩略图区分——dialog 角色）
    const dialog = screen.getByRole("dialog");
    const big = dialog.querySelector("img");
    expect(big).not.toBeNull();
    expect(big!.getAttribute("src")).toBe(TINY_PNG);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("空数组不渲染任何 img", () => {
    const { container } = ui([]);
    expect(container.querySelector("img")).toBeNull();
  });
});
