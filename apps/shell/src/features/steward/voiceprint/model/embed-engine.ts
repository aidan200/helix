/**
 * embed-engine —— 说话人向量推理引擎（M3-c 声纹批；wasm ort-web 驱动面）。
 *
 * 生产链：IndexedDB 模型缓存（26.5MB ArrayBuffer，本机应用数据区）→ 未
 * 命中 fetch 下载源（onProgress 供注册 UI 进度）→ 缓存回写 → ort-web
 * wasm session（单线程——WKWebView 无 crossOriginIsolation/SAB）→
 * computeFbank + session.run。
 *
 * 测试缝：fetchImpl / modelCache 均可注入（fbank.test.ts 的端到端对拍
 * 用例直连 createWasmEmbedEngineForModelBuffer——node 下 wasm 路径经
 * createRequire 解析 dist 前缀，浏览器经 vite ?url 资产映射）。
 */
import * as ortNS from "onnxruntime-web";
import type { EmbedEngine, EmbedEngineLoader } from "./voiceprint-service";
import { computeFbank } from "./fbank";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ort = ortNS as any;

/** 模型下载源（sherpa-onnx 官方 release；wespeaker Apache-2.0，26.5MB）。 */
export const VOICEPRINT_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_zh_cnceleb_resnet34_LM.onnx";

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

/** 模型缓存 port（生产 = IndexedDB；测试注入内存实现）。 */
export interface ModelCache {
  get(): Promise<ArrayBuffer | undefined>;
  put(buffer: ArrayBuffer): Promise<void>;
}

/** IndexedDB 模型缓存（db=helix-voiceprint / store=models；不可用 → 空缓存直落下载）。 */
export function createIndexedDbModelCache(): ModelCache {
  const DB_NAME = "helix-voiceprint";
  const STORE = "models";
  const KEY = "wespeaker-resnet34-LM";
  const globalWindow = globalThis as { indexedDB?: IDBFactory };
  if (typeof globalWindow.indexedDB === "undefined") {
    return { get: async () => undefined, put: async () => undefined };
  }
  const openDb = (): Promise<IDBDatabase | null> =>
    new Promise((resolve) => {
      const req = globalWindow.indexedDB!.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  return {
    async get() {
      const db = await openDb();
      if (db === null) return undefined;
      return new Promise((resolve) => {
        const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
        tx.onsuccess = () => resolve(tx.result as ArrayBuffer | undefined);
        tx.onerror = () => resolve(undefined);
      });
    },
    async put(buffer) {
      const db = await openDb();
      if (db === null) return;
      await new Promise<void>((resolve) => {
        const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(buffer, KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    },
  };
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

/** 下载模型字节（缓存优先；带进度；完整性体积校验）。 */
export async function loadModelBytes(options: WasmEngineLoaderOptions = {}): Promise<ArrayBuffer> {
  const cache = options.modelCache ?? createIndexedDbModelCache();
  const cached = await cache.get();
  if (cached !== undefined && cached.byteLength > 0) return cached;
  const url = options.modelUrl ?? VOICEPRINT_MODEL_URL;
  const doFetch = options.fetchImpl ?? ((input: string) => fetch(input));
  const resp = await doFetch(url);
  if (!resp.ok) throw new Error(`model download failed (HTTP ${resp.status})`);
  const total = resp.headers.get("content-length") !== null ? Number(resp.headers.get("content-length")) : null;
  if (resp.body === null || typeof resp.body.getReader !== "function") {
    const buf = await resp.arrayBuffer();
    options.onProgress?.(buf.byteLength, buf.byteLength);
    await cache.put(buf);
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
  await cache.put(buffer);
  return buffer;
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
