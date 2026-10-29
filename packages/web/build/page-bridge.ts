// 把页面桥（src/page-bridge/entry.ts，134 号票）打包成注入网页用的一段独立脚本（IIFE，压缩过）。
// 鸿蒙 App 构建时（npm run build:harmony，frontend/scripts/build-harmony.ts）写进 App 的 rawfile/page-bridge.js，App 注入前把口令占位换掉；
// 测试（test/page-bridge/）在真的 Chrome 里跑同一份。
import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 脚本里口令的占位（和 src/page-bridge/protocol.ts 的 PAGE_BRIDGE_NONCE_MARK 一样）：打包后要正好出现一次 */
export const NONCE_MARK = "__ERGO_PAGE_NONCE__";

export async function buildPageBridge(): Promise<string> {
  const result = await build({
    configFile: false,
    root: WEB_ROOT,
    logLevel: "silent",
    build: {
      write: false,
      minify: true,
      target: "chrome100",
      lib: { entry: `${WEB_ROOT}src/page-bridge/entry.ts`, formats: ["iife"], name: "ergoPageBridge", fileName: () => "page-bridge.js" },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const chunk = outputs.flatMap((o) => o.output).find((f) => f.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("页面桥没打包出来");
  const count = chunk.code.split(NONCE_MARK).length - 1;
  if (count !== 1) throw new Error(`页面桥里口令的占位出现了 ${count} 次（要正好一次）`);
  return chunk.code;
}
