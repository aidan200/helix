/**
 * TP-CL4-1（U 层）：routeOfPath 路径映射 + 未知/旧路径回落。
 *
 * S2：models 独立页退役（路由五页签 / /skills /trace /project /settings；
 * 模型配置迁入 /settings 页内分区）。/models 与旧 /settings/models 同语义
 * ——未知路径回落工作台（不出现 models 页）。
 */
import { describe, expect, it } from "vitest";
import {
  ROUTE_PROJECT,
  ROUTE_SETTINGS,
  ROUTE_SKILLS,
  ROUTE_TRACE,
  ROUTE_WORKBENCH,
  routeOfPath,
} from "./route";

describe("TP-CL4-1 routeOfPath 路径映射", () => {
  it("五路径各自映射到对应路由位", () => {
    expect(routeOfPath("/")).toBe(ROUTE_WORKBENCH);
    expect(routeOfPath("/skills")).toBe(ROUTE_SKILLS);
    expect(routeOfPath("/trace")).toBe(ROUTE_TRACE);
    expect(routeOfPath("/project")).toBe(ROUTE_PROJECT);
    expect(routeOfPath("/settings")).toBe(ROUTE_SETTINGS);
  });

  it("未知路径回落工作台（F-9 既有语义）", () => {
    expect(routeOfPath("/nope")).toBe(ROUTE_WORKBENCH);
    expect(routeOfPath("/models/extra")).toBe(ROUTE_WORKBENCH);
    expect(routeOfPath("")).toBe(ROUTE_WORKBENCH);
  });

  it("退役路径 /models 回落工作台（S2：不出现 models 页，与旧 /settings/models 同语义）", () => {
    expect(routeOfPath("/models")).toBe(ROUTE_WORKBENCH);
  });

  it("旧路径 /settings/models 不保兼容 → 回落工作台（不出现 models 页，Q-4b）", () => {
    expect(routeOfPath("/settings/models")).toBe(ROUTE_WORKBENCH);
  });
});
