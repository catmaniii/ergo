// Claude Code 插件对外的（287 号票，ADR-0027）：内核、别的插件、以后的票只从这里拿 Claude Code 插件的东西——插件名、运行时的 id；
// 不 import 插件的别的文件（test/claude-code/boundary.test.ts 检查，例外写在那里）。

/** 插件名：配置 plugins.disabled / plugins.removed、设置 · 插件里写的就是它，定了别改 */
export const CLAUDE_CODE_PLUGIN = "claude-code";

/** 运行时的 id：维护者的运行时属性（Task.runtime、Project.runtime）里写的就是它，定了别改 */
export const CLAUDE_CODE_RUNTIME_ID = "claude-code";
