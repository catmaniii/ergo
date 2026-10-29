// 秘书的"问记忆"工具（232 号票，接入设计第 3、5 节）：用户问"我是不是……""为什么……""我最看重什么"这类关于他本人的
// 问题时，秘书按授权深查推理图谱——内部走 @ergo/memory 的 memoryBrief（D 组合法：记录 + 用户画像：对用户的理解、还没分出
// 胜负的竞争解释、明说过的要求和禁忌），只认简报正文里出现的证据编号（ev-…）、结论编号（cl-…）。
// - 只给秘书；只读、不写库、不调模型（memoryBrief 只查询和检索）；
// - 长度截到 4000 字以内：给 memoryBrief 的是比评测默认（BRIEF_LIMITS，约 6800 字）更紧的上限，让简报自己就在 4000 字以内
//   （简报按"明说的要求和禁忌 > 结论连原话 > 竞争解释"的优先级整条整条地放，直接截尾会把排在最后的禁忌砍掉），
//   万一还超就按字截断并写明；
// - 引擎没开、库没建、版本对不上、插件停用（provider 回 undefined）→ 回"记忆还没准备好（还没建库或插件没启用）"，不抛错，
//   这一轮照旧能用素材检索（search_materials）。
// - 263 号票：结果也进网页"回忆了 N 条记忆"那一行（协议包 MemoryRecall，source 是 ask）：查了什么是问题，命中是简报正文里出现的
//   证据背后的素材（证据的 sourceRef 是素材 id；表态证据这类不是素材的不算），和检索素材一样按素材 id 列、网页现取原文。
// @i18n-ignore-file model：工具的说明、参数说明和结果给秘书（模型）看（174 号票）；工具的名字走 t()
import { type BriefLimits, type MemoryBrief, type MemoryEngine } from "@ergo/memory";
import { MEMORY_RECALL_HITS_MAX, type MemoryRecall, type MemoryRecallHit, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { Materials } from "../materials/index.ts";
import { materialIdsOfRef } from "./data-source-evidence.ts";
import type { MemoryEngineProvider } from "./engine-provider.ts";
import { ASK_MEMORY } from "./tool-names.ts";

export { ASK_MEMORY } from "./tool-names.ts";

/** 工具交回的正文最多多少字（接设计第 3 节：总长截到 4000 字以内） */
export const ASK_MEMORY_MAX_CHARS = 4000;

/** 用不了推理库时回给秘书的一句（不抛错：这一轮照旧能用素材检索） */
export const ASK_MEMORY_NOT_READY = "记忆还没准备好（还没建库或插件没启用）";

/**
 * 给 memoryBrief 的上限（其余照 BRIEF_LIMITS）：记录 6 条、1200 字；用户画像 6 条结论、2400 字、2 组竞争解释。
 * 两节合起来约 3600 字，在 4000 字以内，不用靠截尾（截尾会把"明说过的要求和禁忌"砍掉）
 */
export const ASK_MEMORY_LIMITS: Partial<BriefLimits> = { records: 6, recordChars: 1200, claims: 6, profileChars: 2400, groups: 2, membersPerGroup: 2, supportQuotes: 2, refuteQuotes: 1 };

/** 太长时截断的那句 */
const CUT = "\n……（简报太长，后面的先略了；要更细的换个问法再问一次）";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const AskParams = Type.Object(
  {
    question: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "要问关于用户的什么（一句话）：比如\"她是不是特别在意自己安排时间\"\"为什么我老推掉周末的局\"\"我最看重什么\"",
    }),
  },
  { additionalProperties: false },
);

/** 简报正文截到 max 字以内：末尾写明略了（正常走不到，见 ASK_MEMORY_LIMITS） */
export function clipBriefText(text: string, max: number = ASK_MEMORY_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - CUT.length))}${CUT}`.slice(0, max);
}

/**
 * 263 号票：简报用到的记忆（给网页画"回忆了 N 条记忆"）：正文里出现的证据（按出现的先后）背后的素材，去重，最多 MEMORY_RECALL_HITS_MAX 条。
 * 素材库里已经没有的（忘掉、彻底删除了）不列；没给素材库时只认得出编号，种类、时间留空不得——这时也不列
 */
export function briefRecallHits(engine: Pick<MemoryEngine, "getEvidence">, brief: Pick<MemoryBrief, "evidenceIds">, materials: Pick<Materials, "get">): MemoryRecallHit[] {
  const hits: MemoryRecallHit[] = [];
  const seen = new Set<string>();
  for (const evidenceId of brief.evidenceIds) {
    // 303 号票：几条数据源素材合成的一条证据，背后几条素材都列
    for (const ref of materialIdsOfRef(engine.getEvidence(evidenceId)?.sourceRef)) {
      if (seen.has(ref)) continue;
      const material = materials.get(ref);
      if (material === undefined) continue;
      seen.add(ref);
      hits.push({ materialId: material.id, kind: material.kind, time: material.time, ...(material.conversation === null ? {} : { conversation: material.conversation }) });
      if (hits.length >= MEMORY_RECALL_HITS_MAX) return hits;
    }
  }
  return hits;
}

/** materials：素材库（263 号票：把简报用到的证据对回素材，进"回忆了 N 条记忆"）；不给就不带结构化的那份 */
export function askMemoryTool(provider: Pick<MemoryEngineProvider, "get">, materials?: Pick<Materials, "get">): HostTool {
  return defineHostTool({
    name: ASK_MEMORY,
    title: t("memory.tool.ask"),
    description:
      "问记忆：从推理图谱里取和这个问题相关的东西——对用户的理解（需求、价值观、偏好、近期状态，每条写明是用户说的、推断的、用户确认过的和把握）、" +
      "还没分出胜负的几种竞争解释（带能区分它们的问题）、用户明说过的要求和禁忌，用来回答\"我是不是……\"\"为什么……\"\"我最看重什么\"这类关于用户本人的问题。" +
      "返回的是推断，不是用户的原话：引用时说清是推断的、带把握；只有正文里出现的证据编号（ev-…）、结论编号（cl-…）可以引用。" +
      "问用户以前说过、存过的原话（某句话、存的网页）用 search_materials，读一条的全文用 read_material。只读，不调模型。",
    parameters: AskParams,
    // 只读：不落入任何类别
    readOnlyOrIdempotent: true,
    nature: "look",
    async run(args) {
      const engine = provider.get();
      // 引擎没开、库没建、版本对不上、插件停用：说清没准备好，不抛错
      if (!engine) return { text: ASK_MEMORY_NOT_READY };
      try {
        const brief: MemoryBrief = await engine.memoryBrief(args.question, { group: "hybrid_kg_rg", at: engine.store.now(), limits: ASK_MEMORY_LIMITS });
        if (materials === undefined) return { text: clipBriefText(brief.text) };
        const recall: MemoryRecall = { source: "ask", query: args.question, hits: briefRecallHits(engine, brief, materials) };
        return { text: clipBriefText(brief.text), recall };
      } catch (err) {
        // 检索、渲染出错：如实说没问成，这一轮还能用素材检索（不把整轮弄坏）
        return { text: `问记忆时出错：${messageOf(err)}。这一轮还能用 search_materials 检索原话。`, isError: true };
      }
    },
  });
}
