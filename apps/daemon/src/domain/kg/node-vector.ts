/**
 * kg 节点向量纯函数（批1 WP-B）。
 *
 * 向量化文本（设计稿 §4.2 公式——单一来源，写入口增量重嵌与存量回填共用
 * 同一实现）：
 *
 * ```
 * doc(node) = name + "\n" + scene + "\n" + digest + "\n" + body.slice(0, 1500)
 * ```
 *
 * name+digest 是主信号（兼检索匹配字段语义），scene 补适用场景，body 截断
 * 防长文稀释。content_hash = sha256(doc) 与 BLOB float32 序列化归
 * adapters/driven/sqlite-kg/node-vector-codec.ts（AG-02：domain 禁 node:，
 *  hash 经 KgVectorService 依赖注入）。
 */
/** body 截断上限（码元；§4.2 公式常量）。 */
export const NODE_VECTOR_BODY_LIMIT = 1500;

/** 向量化输入（nodes 表四字段投影）。 */
export interface NodeVectorSource {
  readonly name: string;
  readonly scene: string;
  readonly digest: string;
  readonly body: string;
}

/** doc 文本（§4.2 公式）。 */
export function buildNodeVectorDoc(node: NodeVectorSource): string {
  return `${node.name}\n${node.scene}\n${node.digest}\n${node.body.slice(0, NODE_VECTOR_BODY_LIMIT)}`;
}

/**
 * 余弦相似度（批2 WP-C 查重闸比对内核——同库活跃节点全量余弦场景）。
 * 维度不齐 / 零向量抛错（余弦无定义）——调用方（KgDedupService）捕获
 * 降级 warn，绝不静默算错。
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度不齐（${a.length} vs ${b.length}）——余弦不可算`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) throw new Error("零向量余弦无定义");
  return dot / denom;
}
