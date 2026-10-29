// 记忆 · 素材按种类筛（167 号票）：给用户看的六种（协议包的 MATERIAL_FACETS）怎么从素材认出来。纯函数，只看信封。
// - 记忆命令：显式记忆命令（kind memory_command）；
// - 做过的：别的"做"（MATERIAL_MODE：对产出的反应、审批决定、任务结局、回避信号——点了卡片、关掉或一直没处理的卡）；
// - 说过的话：别的"说"（用户发言、澄清问题的回答、投喂的材料）里有字的——有一段不是附件、语音、网页的（打的字、引用块、选的、文字）；
// - 附件、语音：有附件、语音转写的段（和上面可以同时算：说了话还发了附件，两种都算）；
// - 存的网页："浏览"里存进素材的（情境标签 saved_web_page，165 号票）；
// - 数据源：数据源导入的三种（303 号票）——观察到的本人行为也算做过的，本人写的也算说过的话，别人写给你的只算这一种（不是你说的）。
// 每条至少算一种：一段都没有的"说"算说过的话。
import { type MaterialFacet, SAVED_WEB_PAGE_CONTEXT } from "@ergo/protocol";
import { DATA_SOURCE_MATERIAL_KINDS, type Material, type SegmentForm } from "./types.ts";

/** 不算"说过的话"的段：它们各有自己的种类 */
const OWN_FACET_FORMS: ReadonlySet<SegmentForm> = new Set(["attachment", "voice", "web_page"]);

/** 一条素材算哪几种（按 MATERIAL_FACETS 的先后） */
export function materialFacets(m: Pick<Material, "kind" | "mode" | "context" | "segments">): MaterialFacet[] {
  const forms = new Set(m.segments.map((s) => s.form));
  const out: MaterialFacet[] = [];
  const webPage = m.context.includes(SAVED_WEB_PAGE_CONTEXT);
  const fromSource = (DATA_SOURCE_MATERIAL_KINDS as readonly string[]).includes(m.kind);
  if (m.kind !== "memory_command" && m.kind !== "received_writing" && m.mode === "say" && !webPage && (forms.size === 0 || [...forms].some((f) => !OWN_FACET_FORMS.has(f)))) out.push("said");
  if (m.kind !== "memory_command" && m.mode === "do") out.push("did");
  if (forms.has("attachment")) out.push("attachment");
  if (forms.has("voice")) out.push("voice");
  if (webPage) out.push("web_page");
  if (fromSource) out.push("data_source");
  if (m.kind === "memory_command") out.push("memory_command");
  return out;
}

/** 按种类筛：算其中任一种就留下；没给、空的不筛 */
export function matchesFacets(m: Pick<Material, "kind" | "mode" | "context" | "segments">, facets: readonly MaterialFacet[] | undefined): boolean {
  if (!facets || facets.length === 0) return true;
  return materialFacets(m).some((f) => facets.includes(f));
}
