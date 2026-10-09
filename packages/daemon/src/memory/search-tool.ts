// 秘书的素材检索工具（规格第 7 节的只读工具、第 15 节、第 21 节"素材检索"）：关键词（FTS5 trigram，3 个字以下的词退回子串扫描，
// 沿用 08 号票）加向量（语义）检索，返回匹配的素材。用于执行显式记忆命令：用户说忘掉、彻底删除、别推断时，
// 秘书据此找出匹配的素材，再用"提议快速动作"出记忆删除卡。只读、幂等。
// 秘书正在处理的那条消息（就是用户的命令本身）不列出来，免得把命令也当成要删的话。
// 项目内部的记录（64 号票，ADR-0023）秘书检索不到：素材属于的任务、引着的审批或卡片是项目内部的（internal-records.ts 的
// internalRecordOf）——内部任务的结局、计划和审批的决定、验收、提问卡的回答、建议卡被关掉……；用户自己说过的话（发言、投喂的材料、
// 记忆命令）照常检索得到（ADR-0006）。
import { Type } from "@ergou/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import { EmbeddingUnavailable, type Material, MATERIAL_KIND_LABEL, type Materials } from "../materials/index.ts";
import { internalRecordOf, type MaterialOwners } from "./internal-records.ts";
import { excerptOf } from "./memory-commands.ts";
import { SEARCH_MATERIALS } from "./tool-names.ts";

export { SEARCH_MATERIALS } from "./tool-names.ts";

/** 语义检索的分数低于它的不算匹配（余弦相似度） */
export const SEMANTIC_MIN_SCORE = 0.5;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

const Params = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 200, description: "检索什么：关键词（空格隔开的几个词都要出现）或者一句描述" }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `最多几条，默认 ${DEFAULT_LIMIT}` })),
  },
  { additionalProperties: false },
);

/** owners：认出项目内部的记录（64 号票，秘书检索不到）；不给就都检索得到 */
export function searchMaterialsTool(materials: Materials, owners?: MaterialOwners): HostTool {
  return defineHostTool({
    name: SEARCH_MATERIALS,
    title: "检索素材",
    description:
      "检索素材库（用户说过的话、投喂的材料、记忆命令……）：关键词加语义两路。用户说忘掉、彻底删除、别推断某件事时，先用它找出匹配的素材，" +
      "再用 propose_quick_action（type 写 forget、purge 或 no_infer，materialIds 写素材 id）出记忆删除卡让用户核对。只读。",
    parameters: Params,
    // 只读：不落入任何类别
    readOnlyOrIdempotent: true,
    nature: "look",
    async run(args, call) {
      const limit = args.limit ?? DEFAULT_LIMIT;
      // 秘书正在处理的那条命令本身、项目内部的记录（用户自己说过的话除外）不列出来
      const hidden = (m: Material) =>
        (call.inputMessageId !== undefined && m.ref.messageId === call.inputMessageId) || (owners !== undefined && internalRecordOf(m, owners) !== undefined);
      const found = new Map<string, { material: Material; how: string }>();
      for (const m of materials.searchKeyword(args.query, { limit })) if (!hidden(m)) found.set(m.id, { material: m, how: "关键词" });
      let note = "";
      try {
        for (const hit of await materials.searchSemantic(args.query, { limit })) {
          if (hit.score < SEMANTIC_MIN_SCORE || hidden(hit.material)) continue;
          const known = found.get(hit.material.id);
          found.set(hit.material.id, { material: hit.material, how: known ? `${known.how}+语义 ${hit.score.toFixed(2)}` : `语义 ${hit.score.toFixed(2)}` });
        }
      } catch (err) {
        if (!(err instanceof EmbeddingUnavailable)) throw err;
        note = "\n（向量模型不在，这次只按关键词检索）";
      }
      const lines = [...found.values()].slice(0, limit).map(({ material: m, how }) => {
        const where = m.conversation === null ? "" : ` · ${m.conversation}`;
        const mark = m.noInfer ? " · 不参与推断" : "";
        return `- ${m.id} · ${m.time.slice(0, 16).replace("T", " ")} · ${MATERIAL_KIND_LABEL[m.kind]}${where}${mark}（${how}）：${excerptOf(m, 80)}`;
      });
      if (lines.length === 0) return { text: `没有找到和「${args.query}」匹配的素材。${note}` };
      return { text: `找到 ${lines.length} 条素材：\n${lines.join("\n")}${note}` };
    },
  });
}
