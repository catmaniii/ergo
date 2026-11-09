// Codex 插件对外的（ADR-0027）：内核、别的插件只从这里拿 Codex 插件的东西——插件名、运行时的 id，
// 设置 · 组件要的"PATH 上有没有用户自己装的、版本够的 codex"（组件清单里 codex 的 provided：codex-cli，components/probes.ts 用）；
// 不 import 插件的别的文件（test/codex/boundary.test.ts 检查，例外写在那里）。

/** 插件名：配置 plugins.disabled / plugins.removed、设置 · 插件里写的就是它，定了别改 */
export const CODEX_PLUGIN = "codex";

/** 运行时的 id：负责人的运行时属性（Task.runtime、Project.runtime）里写的就是它，定了别改 */
export const CODEX_RUNTIME_ID = "codex";

/** PATH 上用户自己装的、版本够的 codex：在哪、什么版本（组件页把 Codex 接入算"别处已经有了"）；没有是 undefined */
export { codexOnPath } from "./install.ts";
