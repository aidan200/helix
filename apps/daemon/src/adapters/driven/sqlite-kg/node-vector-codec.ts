/**
 * kg 节点向量编解码（批1 WP-B；driven 层——node:crypto 只在 adapters 落地，
 * AG-02 domain/application 禁 node: 的边界适配）。
 *
 * - content_hash（§4.2）：sha256(doc) 十六进制——增量重嵌判据；经
 *   KgVectorService 依赖注入消费（application 层不引 node:crypto）；
 * - 向量 BLOB 序列化：float32[dim] 二进制（node_vectors.embedding 列对齐；
 *   不引 vec0/better-sqlite3——全量余弦场景 bun:sqlite 即可，E-224 dim 锁表
 *   思想沿用：dim 记行上，换模型/换维度 = 全量重嵌，文本是唯一 source of
 *   truth）。
 */
import { createHash } from "node:crypto";

/** content_hash = sha256(doc) 十六进制（增量重嵌判据）。 */
export function nodeVectorContentHash(doc: string): string {
  return createHash("sha256").update(doc, "utf8").digest("hex");
}

/** Float32Array → BLOB 字节（float32[dim] 序列化）。 */
export function float32ToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

/** BLOB 字节 → Float32Array（读面反序列化；长度非 4 倍数视为脏数据抛错）。 */
export function blobToFloat32(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`向量 BLOB 长度非法（${blob.byteLength}——非 float32 整倍）`);
  }
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}
