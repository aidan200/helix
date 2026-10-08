/**
 * embed-engine —— 说话人向量推理引擎（M3-c 声纹批；wasm ort-web 驱动面）。
 *
 * 生产链（v2：模型归位 ~/.helix/models/ 磁盘目录）：daemon HTTP 模型路由
 * （GET /models/voiceprint-model.onnx，content-length 供进度）→ ort-web
 * wasm session（单线程——WKWebView 无 crossOriginIsolation/SAB）→
 * computeFbank + session.run。磁盘即缓存——shell 侧无持久化（IndexedDB
 * 缓存随 v2 退役）；手动放置/导入经 daemon PUT 路由落盘（importModelFile）。
 *
 * 测试缝：fetchImpl / modelCache 均可注入（fbank.test.ts 的端到端对拍
 * 用例直连 createWasmEmbedEngineForModelBuffer——node 下 wasm 路径经
 * createRequire 解析 dist 前缀，浏览器经 vite ?url 资产映射）。
 */
import * as ortNS from "onnxruntime-web";
import { DAEMON_PORT } from "@/shared/config/env";
import { VOICEPRINT_MODEL_HTTP_PATH, VOICEPRINT_MODEL_MAX_BYTES } from "@helix/protocol";
import type { EmbedEngine, EmbedEngineLoader } from "./voiceprint-service";
import { computeFbank } from "./fbank";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ort = ortNS as any;

/** 手动下载源（sherpa-onnx 官方 release；wespeaker Apache-2.0，26.5MB）。
 * 仅供设置页提示文案引用——拉取本体走 daemon 磁盘路由（网络受阻时
 * 用户按此 URL 手动下载后经「从本地导入」上行落盘）。 */
export const VOICEPRINT_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_zh_cnceleb_resnet34_LM.onnx";

/** daemon 模型路由 base（与 ws 同端口；生产唯一拉取源）。 */
export const VOICEPRINT_MODEL_DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}${VOICEPRINT_MODEL_HTTP_PATH}`;

/** 模型体积（字节；下载进度分母与完整性粗校验）。 */
export const VOICEPRINT_MODEL_BYTES = 26_530_548;

/** fbank 特征维（模型输入 [B,T,80]）。 */
export const FBANK_FEAT_DIM = 80;

let wasmConfigured = false;

/** ort-web wasm 运行时配置（单次；单线程——WKWebView 无 crossOriginIsolation/SAB。
 * 入口取 default 条件（bundle 版内嵌 wasm，零 wasmPaths/零外部资产——桌面
 * 本地加载无网络代价；node 条件下 ort.node.min.mjs 自读 node_modules）。 */
function configureWasm(): void {
  if (wasmConfigured) return;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  wasmConfigured = true;
}

/** 模型缓存 port（测试缝：node 下注入内存实现；生产 v2 无持久缓存——
 *  磁盘即缓存，daemon 路由命中即零成本）。 */
export interface ModelCache {
  get(): Promise<ArrayBuffer | undefined>;
  put(buffer: ArrayBuffer): Promise<void>;
}

/** 内存模型缓存（测试）。 */
export function createMemoryModelCache(): ModelCache {
  let held: ArrayBuffer | undefined;
  return {
    async get() {
      return held;
    },
    async put(buffer) {
      held = buffer;
    },
  };
}

export interface WasmEngineLoaderOptions {
  readonly modelUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly modelCache?: ModelCache;
  readonly onProgress?: (received: number, total: number | null) => void;
}

/** 拉取模型字节（daemon 磁盘路由流式拉取；带进度；404 → 手动放置/导入
 *  引导的专用错误名）。 */
export async function loadModelBytes(options: WasmEngineLoaderOptions = {}): Promise<ArrayBuffer> {
  const cache = options.modelCache;
  const cached = cache === undefined ? undefined : await cache.get();
  if (cached !== undefined && cached.byteLength > 0) return cached;
  const url = options.modelUrl ?? VOICEPRINT_MODEL_DAEMON_URL;
  const doFetch = options.fetchImpl ?? ((input: string) => fetch(input));
  const resp = await doFetch(url);
  if (!resp.ok) throw new Error(`model asset missing (HTTP ${resp.status})`);
  const total = resp.headers.get("content-length") !== null ? Number(resp.headers.get("content-length")) : null;
  if (resp.body === null || typeof resp.body.getReader !== "function") {
    const buf = await resp.arrayBuffer();
    options.onProgress?.(buf.byteLength, buf.byteLength);
    await cache?.put(buf);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    options.onProgress?.(received, total);
  }
  const merged = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.byteLength;
  }
  const buffer = merged.buffer;
  await cache?.put(buffer);
  return buffer;
}

/** 从本地文件导入模型（设置页「从本地导入」：GitHub 直连受阻时的手动
 *  通道——手动下载后选文件 → PUT 上行 daemon 落盘 ~/.helix/models/）。
 *  幂等覆写；体积护栏与路由侧一致（MAX 字节）。 */
export async function importModelFile(file: File, options: WasmEngineLoaderOptions = {}): Promise<void> {
  if (file.size <= 0 || file.size > VOICEPRINT_MODEL_MAX_BYTES) {
    throw new Error(`model file size out of range (${file.size} bytes)`);
  }
  const doFetch = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const resp = await doFetch(VOICEPRINT_MODEL_DAEMON_URL, {
    method: "PUT",
    body: await file.arrayBuffer(),
  });
  if (!resp.ok) throw new Error(`model import failed (HTTP ${resp.status})`);
}

/** 由模型字节（或 node 文件路径——测试对拍直连）建推理引擎。 */
export async function createWasmEmbedEngineForModelBuffer(model: ArrayBuffer | string): Promise<EmbedEngine> {
  configureWasm();
  const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
  const inputNames: string[] = session.inputNames as string[];
  const outputNames: string[] = session.outputNames as string[];
  if (inputNames.length !== 1 || outputNames.length !== 1) {
    throw new Error("model io mismatch (expected single input/output)");
  }
  return {
    async embed(samples: Float32Array): Promise<Float32Array> {
      const feats = computeFbank(samples);
      const frames = feats.length / FBANK_FEAT_DIM;
      if (frames <= 0) throw new Error("audio too short for features");
      const tensor = new ortNS.Tensor("float32", feats, [1, frames, FBANK_FEAT_DIM]);
      const outputs = await session.run({ [inputNames[0]!]: tensor });
      const emb = outputs[outputNames[0]!];
      if (emb === undefined || emb.data === undefined) throw new Error("model produced no output");
      return new Float32Array(emb.data as Float32Array);
    },
  };
}

/** 生产引擎加载器（缓存 → 下载 → 引擎；单飞由 service 层持有）。 */
export function createWasmEmbedEngineLoader(options: WasmEngineLoaderOptions = {}): EmbedEngineLoader {
  return async () => createWasmEmbedEngineForModelBuffer(await loadModelBytes(options));
}
