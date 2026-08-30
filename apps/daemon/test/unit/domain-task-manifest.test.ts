import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/DomainError";
import {
  parseTaskManifest,
  resolveStagePlan,
  validateTaskParams,
} from "../../src/domain/task/manifest";
import type { TaskManifest } from "../../src/domain/task/types";

/**
 * CL-2-T9 / CL-1-T5（U 半）：manifest 校验矩阵——
 * ④ 解析：合法 roundtrip；无 task 块 → null（普通技能向后兼容）；坏 task 块 → DomainError；
 * ⑤ params 校验：缺 required / 型错误 / projects 基数违例 → 逐一拒绝且 message 含违例项；
 * ⑥ stages 策略：fixed → 序号行；free 缺 confirmedStages → 拒绝；free + 确认列表 → 按列表生成。
 */

/** §7.1 kg-bootstrap 形状的合法 manifest 块。 */
function validTaskBlock(): TaskManifest {
  return {
    paramsSchema: {
      projectRoot: { type: "string", required: true },
      scope: { type: "string", required: false },
    },
    stages: { strategy: "fixed", list: ["L0 核心层", "L1 领域层", "L2 实体层"] },
    confirm: "required",
    plan: "enforced",
    projects: { min: 1, max: 1 },
  };
}

function parseValid(): TaskManifest {
  const m = parseTaskManifest({ name: "kg-bootstrap", task: validTaskBlock() });
  expect(m).not.toBeNull();
  return m as TaskManifest;
}

describe("manifest 解析（CL-2-T9 ④）", () => {
  test("合法 manifest roundtrip", () => {
    const manifest = parseValid();
    expect(manifest).toEqual(validTaskBlock());
  });

  test("无 task 块 → null（普通技能向后兼容，不算非法）", () => {
    expect(parseTaskManifest({ name: "web-access", description: "普通技能" })).toBeNull();
    expect(parseTaskManifest({})).toBeNull();
  });

  test("坏 task 块 → DomainError：缺 paramsSchema", () => {
    const block: Record<string, unknown> = { ...validTaskBlock() };
    delete block["paramsSchema"];
    expect(() => parseTaskManifest({ task: block })).toThrow(DomainError);
    expect(() => parseTaskManifest({ task: block })).toThrow(/paramsSchema/);
  });

  test("坏 task 块 → DomainError：paramsSchema 子集外声明（嵌套对象型 / pattern 字段）", () => {
    expect(() =>
      parseTaskManifest({ task: { ...validTaskBlock(), paramsSchema: { nested: { type: "object" } } } }),
    ).toThrow(DomainError);
    expect(() =>
      parseTaskManifest({
        task: {
          ...validTaskBlock(),
          paramsSchema: { name: { type: "string", pattern: "^a" } },
        },
      }),
    ).toThrow(DomainError);
  });

  test("坏 task 块 → DomainError：坏 stages 策略 / fixed 缺 list", () => {
    expect(() =>
      parseTaskManifest({ task: { ...validTaskBlock(), stages: { strategy: "auto" } } }),
    ).toThrow(DomainError);
    expect(() =>
      parseTaskManifest({ task: { ...validTaskBlock(), stages: { strategy: "fixed" } } }),
    ).toThrow(DomainError);
    expect(() =>
      parseTaskManifest({ task: { ...validTaskBlock(), stages: { strategy: "fixed", list: ["L0", 42] } } }),
    ).toThrow(DomainError);
  });

  test("坏 task 块 → DomainError：projects min>max / 非法基数", () => {
    expect(() =>
      parseTaskManifest({ task: { ...validTaskBlock(), projects: { min: 2, max: 1 } } }),
    ).toThrow(DomainError);
    expect(() =>
      parseTaskManifest({ task: { ...validTaskBlock(), projects: { min: -1, max: 1 } } }),
    ).toThrow(DomainError);
  });

  test("坏 task 块 → DomainError：confirm/plan 语义词外取值；max=Infinity 合法（0..n 类型）", () => {
    expect(() =>
      parseTaskManifest({ task: { ...validTaskBlock(), confirm: "always" } }),
    ).toThrow(DomainError);
    expect(() =>
      parseTaskManifest({ task: { ...validTaskBlock(), plan: "never" } }),
    ).toThrow(DomainError);
    expect(() =>
      parseTaskManifest({ task: { ...validTaskBlock(), projects: { min: 0, max: Infinity } } }),
    ).not.toThrow();
  });
});

describe("params 校验（CL-1-T5 ⑤）", () => {
  test("合法 params + projects 在界内 → 通过不抛", () => {
    const manifest = parseValid();
    expect(() =>
      validateTaskParams(manifest, { projectRoot: "/repo", scope: "src" }, ["/repo"]),
    ).not.toThrow();
    // 可选字段缺省合法（required: false）
    expect(() => validateTaskParams(manifest, { projectRoot: "/repo" }, ["/repo"])).not.toThrow();
  });

  test("缺 required → DomainError 且 message 含违例字段名", () => {
    const manifest = parseValid();
    expect(() => validateTaskParams(manifest, {}, ["/repo"])).toThrow(DomainError);
    expect(() => validateTaskParams(manifest, {}, ["/repo"])).toThrow(/projectRoot/);
  });

  test("型错误 → DomainError 且 message 含违例字段名", () => {
    const manifest = parseValid();
    expect(() => validateTaskParams(manifest, { projectRoot: 123 }, ["/repo"])).toThrow(DomainError);
    expect(() => validateTaskParams(manifest, { projectRoot: 123 }, ["/repo"])).toThrow(/projectRoot/);
    expect(() => validateTaskParams(manifest, { projectRoot: null }, ["/repo"])).toThrow(DomainError);
  });

  test("string[] 型字段：非数组 / 数组混入非 string → 拒绝；合法数组通过", () => {
    const manifest = parseTaskManifest({
      task: {
        ...validTaskBlock(),
        paramsSchema: { tags: { type: "string[]", required: true } },
      },
    }) as TaskManifest;
    expect(() => validateTaskParams(manifest, { tags: ["a", "b"] }, ["/repo"])).not.toThrow();
    expect(() => validateTaskParams(manifest, { tags: "a" }, ["/repo"])).toThrow(DomainError);
    expect(() => validateTaskParams(manifest, { tags: ["a", 1] }, ["/repo"])).toThrow(DomainError);
  });

  test("projects=[] 且 min=1 → DomainError 且 message 指明「projects 数量违例」", () => {
    const manifest = parseValid();
    expect(() => validateTaskParams(manifest, { projectRoot: "/repo" }, [])).toThrow(DomainError);
    expect(() => validateTaskParams(manifest, { projectRoot: "/repo" }, [])).toThrow(/projects 数量违例/);
  });

  test("projects 2 个且 max=1 → DomainError（基数上限违例）", () => {
    const manifest = parseValid();
    expect(() =>
      validateTaskParams(manifest, { projectRoot: "/repo" }, ["/a", "/b"]),
    ).toThrow(DomainError);
    expect(() =>
      validateTaskParams(manifest, { projectRoot: "/repo" }, ["/a", "/b"]),
    ).toThrow(/projects 数量违例/);
  });

  test("min=0 时空 projects 合法（AD-8：0..n 普通标签）", () => {
    const manifest = parseTaskManifest({
      task: { ...validTaskBlock(), projects: { min: 0, max: Infinity } },
    }) as TaskManifest;
    expect(() => validateTaskParams(manifest, { projectRoot: "/repo" }, [])).not.toThrow();
    expect(() => validateTaskParams(manifest, { projectRoot: "/repo" }, ["/a", "/b", "/c"])).not.toThrow();
  });
});

describe("stages 策略求值（CL-2-T9 ⑥）", () => {
  test("fixed → 按 manifest.list 生成 seq 1..3 的 StagePlan", () => {
    const manifest = parseValid();
    expect(resolveStagePlan(manifest)).toEqual([
      { seq: 1, name: "L0 核心层" },
      { seq: 2, name: "L1 领域层" },
      { seq: 3, name: "L2 实体层" },
    ]);
  });

  test("free + 缺 confirmedStages → DomainError", () => {
    const manifest = parseTaskManifest({
      task: { ...validTaskBlock(), stages: { strategy: "free" } },
    }) as TaskManifest;
    expect(() => resolveStagePlan(manifest)).toThrow(DomainError);
    expect(() => resolveStagePlan(manifest, [])).toThrow(DomainError);
  });

  test("free + 确认列表 → 按列表生成序号行", () => {
    const manifest = parseTaskManifest({
      task: { ...validTaskBlock(), stages: { strategy: "free" } },
    }) as TaskManifest;
    expect(resolveStagePlan(manifest, ["探索", "建模"])).toEqual([
      { seq: 1, name: "探索" },
      { seq: 2, name: "建模" },
    ]);
  });
});
