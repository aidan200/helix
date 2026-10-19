import { describe, expect, test } from "bun:test";
import { sanitizeMcpInputSchema } from "../../src/adapters/driven/mcp/mcp-tool";

/**
 * MCP inputSchema 钳制面（E-316）：tuple 形 items → anyOf 对象形。
 *
 * 实证背景（2026-10-19 zai 1210）：智谱 coding 端点严格校验 tools schema，
 * aseprite-ai-artist__validate 的 layerFrames/mustNotOverlap 两处 tuple 形
 * `"items": [s1, s2]` 触发 `400 code 1210 "API 调用参数有误"`——懒加载
 * 物化后该 schema 进请求 tools 数组，跨会话毒化共享注册表的全部后续请求。
 * 清洗变换（anyOf 对象形 + minItems/maxItems 原位保留）实测同端点 200。
 */

describe("sanitizeMcpInputSchema（E-316 tuple items 钳制）", () => {
  test("tuple 形 items → anyOf 对象形（实证毒点同构：嵌套 additionalProperties + 深层 tuple）", () => {
    const input = {
      type: "object",
      properties: {
        expect: {
          type: "object",
          properties: {
            layerFrames: {
              type: "object",
              additionalProperties: {
                type: "array",
                items: {
                  type: "array",
                  minItems: 2,
                  maxItems: 2,
                  items: [
                    { type: "integer", exclusiveMinimum: 0 },
                    { type: "integer", exclusiveMinimum: 0 },
                  ],
                },
              },
            },
            mustNotOverlap: {
              type: "array",
              items: {
                type: "array",
                minItems: 2,
                maxItems: 2,
                items: [{ type: "string" }, { type: "string" }],
              },
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    };
    const out = sanitizeMcpInputSchema(input) as any;
    const expect_ = out.properties.expect;
    // 深层 tuple（additionalProperties 内两层）被改写
    const inner = expect_.properties.layerFrames.additionalProperties.items.items;
    expect(inner).toEqual({
      anyOf: [
        { type: "integer", exclusiveMinimum: 0 },
        { type: "integer", exclusiveMinimum: 0 },
      ],
    });
    // 外层 minItems/maxItems 原位保留（位置严格性的残存锚）
    expect(expect_.properties.layerFrames.additionalProperties.items.minItems).toBe(2);
    expect(expect_.properties.layerFrames.additionalProperties.items.maxItems).toBe(2);
    // 第二处 tuple 同构改写
    expect(expect_.properties.mustNotOverlap.items.items).toEqual({
      anyOf: [{ type: "string" }, { type: "string" }],
    });
    // 非 items 字段零触碰（$schema/additionalProperties:false/enum 类形态）
    expect(out.$schema).toBe(input.$schema);
    expect(expect_.additionalProperties).toBe(false);
  });

  test("非 items 的数组形态不动（enum 等合法数组）+ 对象形 items 原样穿透", () => {
    const input = {
      type: "object",
      properties: {
        checks: { type: "array", items: { type: "string", enum: ["palette", "strays"] } },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    expect(sanitizeMcpInputSchema(input)).toEqual(input);
  });

  test("空 tuple items → 空 schema 对象（任意成员）；入参不被突变（纯函数）", () => {
    const input = { type: "array", items: [] };
    expect(sanitizeMcpInputSchema(input)).toEqual({ type: "array", items: {} });
    expect(input.items).toEqual([]);
  });

  test("标量 / null / 普通对象穿透同构", () => {
    expect(sanitizeMcpInputSchema(42)).toBe(42);
    expect(sanitizeMcpInputSchema("x")).toBe("x");
    expect(sanitizeMcpInputSchema(null)).toBe(null);
    expect(sanitizeMcpInputSchema({ type: "string" })).toEqual({ type: "string" });
  });

  test("幂等：清洗产物再清洗零变化", () => {
    const input = { type: "array", items: [{ type: "string" }, { type: "number" }] };
    const once = sanitizeMcpInputSchema(input);
    expect(sanitizeMcpInputSchema(once)).toEqual(once);
  });
});
