/**
 * TP-CL4-1（U 层）：routeOfPath 六路径映射 + 未知/旧路径回落。
 *
 * Q-4b：六页签一次立（/ /models /skills /trace /project /settings）；
 * /settings/models → /models 迁移不保旧路径兼容——旧路径按未知路径
 * 回落工作台（不出现 models 页）。
 */
import { describe, expect, it } from "vitest";
import {
  ROUTE_MODELS,
  ROUTE_PROJECT,
  ROUTE_SETTINGS,
  ROUTE_SKILLS,
  ROUTE_TRACE,
  ROUTE_WORKBENCH,
  routeOfPath,
} from "./route";

describe("TP-CL4-1 routeOfPath 六路径映射", () => {
  it("六路径各自映射到对应路由位", () => {
    expect(routeOfPath("/")).toBe(ROUTE_WORKBENCH);
    expect(routeOfPath("/models")).toBe(ROUTE_MODELS);
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

  it("旧路径 /settings/models 不保兼容 → 回落工作台（不出现 models 页，Q-4b）", () => {
    expect(routeOfPath("/settings/models")).toBe(ROUTE_WORKBENCH);
  });
});
