/** Bun 把 .wasm import 加载为文件路径（编译形态内嵌，值为可读路径；pi 同款机制）。 */
declare module "quickjs-wasi/quickjs.wasm" {
  const quickjsWasmPath: string;
  export default quickjsWasmPath;
}
