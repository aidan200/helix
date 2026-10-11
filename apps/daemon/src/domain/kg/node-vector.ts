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
