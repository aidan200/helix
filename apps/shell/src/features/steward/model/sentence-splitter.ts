/**
 * SentenceBuffer：V3b-2 分句缓冲器（shell 侧件二）。
 *
 * 职责：steward.ask.delta 喂入 push() → 句读边界切出（当次返回切出句数组）。
 * 调用方驱动强制切（1.5s 无边界 timer 到点调 cut()——定时器归属播放调度层，
 * 本层保持纯函数性质便于测试）；LLM 流终止 flush() 尾句冲刷；reset() 清位。
 *
 * 边界语义（brief 件二）：
 * - 句界：。！？；… 与换行（中英双覆盖）——SENTENCE_BOUNDARY_CHARS 单源导出
 * - 连续边界合并（！！！/……不拆句）；边界后收尾引号并入本句
 * - 句首空白剥除；纯空白句不产出
 */
export const SENTENCE_BOUNDARY_CHARS = [
  "。", "！", "？", "；", "…",
  "!", "?", ";", "\n", "\r",
] as const;

const BOUNDARY_SET = new Set<string>(SENTENCE_BOUNDARY_CHARS);

/** 边界后可并入句内的收尾引号/括号（「你好。」+」 一体） */
const CLOSING_QUOTES = new Set<string>([
  "」", "』", "）", "】", "》", '"', "'", ")", "]", ">",
]);

/** 句尾保留字符：换行（TTS 韵律信号）不剥除 */
const TRAILING_KEEP = new Set<string>(["\n"]);

/** 跨类边界合并对：？！（问+叹）连用视为一句 */
const BOUNDARY_PAIRS = new Set<string>(["？！", "!?"]);

export class SentenceBuffer {
  private buffer = "";

  /** delta 喂入：返回本次切出的完整句（含句界符），无则空数组 */
  push(delta: string): string[] {
    this.buffer += delta;
    return this.drainBoundary();
  }

  /** 强制切：把当前残余整段切出（定时器驱动方调用）；空残量返回 null */
  cut(): string | null {
    const text = this.buffer.trim();
    this.buffer = "";
    return text.length > 0 ? text : null;
  }

  /** 流终止冲刷：无边界尾句也产出；之后调用返回 null */
  flush(): string | null {
    return this.cut();
  }

  /** 清位：新一轮回答残余不泄漏 */
  reset(): void {
    this.buffer = "";
  }

  /** 当前残余（调试/测试面） */
  get pending(): string {
    return this.buffer;
  }

  private drainBoundary(): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < this.buffer.length) {
      const ch: string = this.buffer[i] ?? "";
      if (BOUNDARY_SET.has(ch)) {
        // 跨类合并对（？！）出现时句界后移：?!后接文字继续吸收到下一个独立边界
        const nextCh = this.buffer[i + 1] ?? "";
        const pair = ch + nextCh;
        if (BOUNDARY_PAIRS.has(pair)) {
          i += 2;
          continue;
        }
        let end = i + 1;
        while (end < this.buffer.length) {
          const next: string = this.buffer[end] ?? "";
          // 同类连续边界（！！！/……）与收尾引号并入本句
          if (next !== "" && (BOUNDARY_SET.has(next) || CLOSING_QUOTES.has(next))) {
            const p2 = this.buffer[end - 1] + next;
            if (!BOUNDARY_PAIRS.has(p2)) {
              end += 1;
              continue;
            }
            end += 0;
            break;
          }
          break;
        }
        const sentence = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        const trimmed = trimSentence(sentence);
        if (trimmed.length > 0) out.push(trimmed);
        i = 0;
        continue;
      }
      i += 1;
    }
    return out;
  }
}

/** 句首空白剥除；句尾仅剥空白（保留换行），纯空白返回空串 */
function trimSentence(sentence: string): string {
  const headStripped = sentence.replace(/^[\s\t\r]+/, "");
  return headStripped.replace(/[ \t]+$/, "");
}
