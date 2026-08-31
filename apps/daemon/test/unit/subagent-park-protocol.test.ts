import { describe, expect, test } from "bun:test";
import {
  isParkInstruction,
  isResumeInstruction,
  PARK_INSTRUCTION_TEXT,
  parseParkBlock,
  RESUME_INSTRUCTION_TEXT,
} from "../../src/application/services/scheduler/parkProtocol";

/**
 * park/resume 批 T3：挂起协议纯数据面单测——
 * - PARK/RESUME 指令文本携带稳定标记（子进程 stdin 判别输入）；
 * - <<<PARK {...} PARK>>> 块解析（缺字段容错归一空串；非法 JSON → undefined）；
 * - 指令判别不误伤普通 steer 文本（LLM 可输出含 PARK 字样正文，但指令
 *   判别以行首标记为准）。
 */

const parkBlock = (progress: string, next: string) =>
  `<<<PARK\n${JSON.stringify({ progress, next })}\nPARK>>>`;

describe("parseParkBlock（PARK 标记块解析）", () => {
  test("标准块解析出 progress/next 摘要", () => {
    expect(parseParkBlock(`前置说明。\n${parkBlock("已调研一半", "继续写实现")}\n尾随`)).toEqual({
      progress: "已调研一半",
      next: "继续写实现",
    });
  });

  test("缺字段容错归一空串（progress/next 缺一不判失败）", () => {
    expect(parseParkBlock('<<<PARK\n{"progress":"只说了进展"}\nPARK>>>')).toEqual({
      progress: "只说了进展",
      next: "",
    });
  });

  test("非法 JSON / 无块 → undefined（调用方按未挂起处理）", () => {
    expect(parseParkBlock("没有块")).toBeUndefined();
    expect(parseParkBlock("<<<PARK\n{不是json}\nPARK>>>")).toBeUndefined();
    expect(parseParkBlock('<<<PARK\n"纯字符串"\nPARK>>>')).toBeUndefined();
  });

  test("与 CLOSURE 块互不误认（PARK 块文本不含 CLOSURE 块）", () => {
    expect(parseParkBlock('<<<CLOSURE\n{"status":"done","summary":"x"}\nCLOSURE>>>')).toBeUndefined();
  });
});

describe("指令判别（stdin 行 → park/resume 通道分派）", () => {
  test("PARK 指令文本自带行为说明 + 标记格式 + 结束说明", () => {
    expect(PARK_INSTRUCTION_TEXT).toContain("<<<PARK");
    expect(PARK_INSTRUCTION_TEXT).toContain("PARK>>>");
    expect(PARK_INSTRUCTION_TEXT).toContain("progress");
    expect(PARK_INSTRUCTION_TEXT).toContain("next");
    expect(isParkInstruction(PARK_INSTRUCTION_TEXT)).toBe(true);
  });

  test("RESUME 指令文本携带恢复说明", () => {
    expect(RESUME_INSTRUCTION_TEXT.length).toBeGreaterThan(0);
    expect(isResumeInstruction(RESUME_INSTRUCTION_TEXT)).toBe(true);
  });

  test("普通 steer 文本不判为指令（含 PARK 字样的正文也不误认）", () => {
    expect(isParkInstruction("补充指示：请继续")).toBe(false);
    expect(isParkInstruction("我可能会输出 <<<PARK 之类的字样")).toBe(false);
    expect(isResumeInstruction("继续执行任务")).toBe(false);
    expect(isParkInstruction(RESUME_INSTRUCTION_TEXT)).toBe(false);
    expect(isResumeInstruction(PARK_INSTRUCTION_TEXT)).toBe(false);
  });
});
