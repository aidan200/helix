/**
 * 本地模型资产面（M3-c 声纹批 v2：模型归位 `~/.helix/models/` 磁盘目录）。
 *
 * daemon HTTP 面挂静态模型路由（PROTOCOL.md §9 HTTP 通道的扩展面）：
 * - `GET  /models/voiceprint-model.onnx` —— shell 流式拉取（content-length 供进度）；
 * - `PUT  /models/voiceprint-model.onnx` —— 设置页「从本地导入」上行
 *   （GitHub 直连受阻时的手动放置通道：手动下载 → 导入 → 落盘）。
 *
 * 文件名是**固定白名单**（不开放任意写盘）：本常量是 daemon 路由与 shell
 * 拉取/上行的唯一同源真身——两侧各自硬编码字符串必漂移，故收 protocol。
 */
export const VOICEPRINT_MODEL_FILENAME = "voiceprint-model.onnx";

/** 模型路由路径（daemon HTTP 面；base = `http://127.0.0.1:<ws 端口>`）。 */
export const VOICEPRINT_MODEL_HTTP_PATH = `/models/${VOICEPRINT_MODEL_FILENAME}`;

/** 上行体积上限（字节）：wespeaker resnet34 实际 26.5MB，64MB 留余量防误传大文件。 */
export const VOICEPRINT_MODEL_MAX_BYTES = 64 * 1024 * 1024;
