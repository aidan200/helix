/**
 * fbank 测试（M3-c 声纹批）。
 *
 * 两层：
 * 1. 纯单元（恒跑）：帧数公式、输出形状、确定性（同输入同输出）、静音
 *    输入有限值防御；
 * 2. 端到端对拍（模型在场才跑，skipIf）：确定性 LCG 波形 → 本 fbank +
 *    onnxruntime-web(wasm) → embedding，与 python sherpa-onnx 官方参考
 *    embedding（fbank.fixture.json，make_fixture.py 产）余弦 > 0.999。
 *    模型文件 26.5MB 不进仓（/tmp/m3c-sv/ 本地路径），CI/他人环境自动跳过
 *    ——红绿链证据在本地运行记录（调研报告 docs/temp/m3c-sv/research.md）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { computeFbank, fbankNumFrames } from "./fbank";
import fixture from "./fbank.fixture.json";

/** 确定性 LCG 波形（与 make_fixture.py 逐样本一致；BigInt 防 JS 乘法
 * 超 2^53 丢精度——1103515245×2^31 ≈ 2.4e18 远超 number 安全整数域）。 */
export function lcgWave(n: number): Float32Array {
  let x = 42n;
  const M = 2n ** 31n;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x = (1103515245n * x + 12345n) % M;
    out[i] = (Number(x) / 2 ** 30 - 1) * 8000 + 300 * Math.sin((2 * Math.PI * 220 * i) / 16000);
  }
  return out;
}

describe("fbankNumFrames（snip_edges=false 四舍五入）", () => {
  it("整帧对齐 / 半帧进位 / 不足半帧舍", () => {
    expect(fbankNumFrames(16000)).toBe(100); // 1s
    expect(fbankNumFrames(16080)).toBe(101); // +0.5 帧 → 进位
    expect(fbankNumFrames(16079)).toBe(100);
    expect(fbankNumFrames(0)).toBe(0);
    expect(fbankNumFrames(160)).toBe(1);
  });
});

describe("computeFbank（纯单元）", () => {
  it("输出形状 [T][80]；值有限", () => {
    const samples = lcgWave(32000); // 2s
    const feats = computeFbank(samples);
    expect(feats.length).toBe(200 * 80);
    for (let i = 0; i < feats.length; i += 997) {
      expect(Number.isFinite(feats[i]!)).toBe(true);
    }
  });

  it("确定性：同输入两次计算逐位一致", () => {
    const samples = lcgWave(4800);
    const a = computeFbank(samples);
    const b = computeFbank(samples);
    expect(a).toEqual(b);
  });

  it("静音输入有限值（log(eps) 下界防御）", () => {
    const feats = computeFbank(new Float32Array(3200));
    for (let i = 0; i < feats.length; i += 101) {
      expect(Number.isFinite(feats[i]!)).toBe(true);
    }
  });
});

const MODEL_PATH = join(tmpdir(), "m3c-sv", "wespeaker_zh_cnceleb_resnet34_LM.onnx");
const modelAvailable = existsSync(MODEL_PATH);

describe.skipIf(!modelAvailable)("端到端对拍（模型在场：fbank + ort-web vs python sherpa-onnx 参考）", () => {
  it("LCG 波形 embedding 与官方参考余弦 > 0.999", async () => {
    const { createWasmEmbedEngineForModelBuffer } = await import("./embed-engine");
    const engine = await createWasmEmbedEngineForModelBuffer(MODEL_PATH);
    const emb = await engine.embed(lcgWave(32000));
    expect(emb.length).toBe(fixture.embedding.length);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < emb.length; i++) {
      dot += emb[i]! * fixture.embedding[i]!;
      na += emb[i]! * emb[i]!;
      nb += fixture.embedding[i]! * fixture.embedding[i]!;
    }
    const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
    expect(cos).toBeGreaterThan(0.999);
  }, 60_000);
});
