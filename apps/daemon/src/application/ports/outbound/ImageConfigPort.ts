import type { ImageConfigState } from "../../services/imageConfig";

/**
 * 图片压缩配置读面端口（图片治理批）：ReadTool/BrowserTools 构造注入的
 * `isDownscaleEnabled` 数据源（运行期即热——每次工具执行读 current）。
 */
export interface ImageConfigPort {
  /** 当前生效配置（KV 不可用 → 最近已知值；初值 = 默认开）。 */
  current(): ImageConfigState;
  /** 写入（单写通道，落盘完成即返回；回读新现态）。 */
  set(next: ImageConfigState): Promise<ImageConfigState>;
}
