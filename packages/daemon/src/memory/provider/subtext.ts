// @i18n-ignore-file log：这一版没接线（工具、简报、页面下一段才改接），中文只有日志、给宿主的出错说明和插件清单里的名字
// 会意 / Subtext 记忆插件（337 号票第二步"插件化"的第一步：把现有这套包成一个 MemoryProvider、登记进注册表、在组合根起来）。
//
// 这一版**只包一层**，不搬实现、不改行为：现有的素材采集、记忆命令、curator、purge、访谈、网页照旧走各自的路
// （packages/daemon/src/memory/*、packages/memory），插件里的每个方法都接到**现成的**东西上：
//
//   search  → @ergo/memory 的引擎检索（memoryBrief / ask_memory 用的那一套：hybrid_kg、两层、关键词 + 向量 + 事实图谱），
//             命中是证据（Evidence），映射成 MemoryItem；出处从证据的 sourceRef 拆回素材 id（几条合成的一条是 digest:<id,…>，
//             materialIdsOfRef），素材库还在的话再补上它来自哪条消息。**出处一条都对不上的条目不交出去**（用户 2026-10-28 定：
//             没有出处的条目不进简报）——这一版宁可少给，不硬编。
//   remember → 337 号票第二段接上了：用户说"帮我记一句"时按原话存一条（不猜、不改写）。落的是现有的"显式记忆命令"那条链
//             （组合根给 write 这一手：追加一条 memory_command（from.kind 是 secretary，带会话/消息/工具调用）→ 素材库照旧采成
//             "显式记忆命令"素材 → 立刻用每晚整理同一个 evidenceDraftOf 读成证据、经推理库的唯一写入口入库；整理时按出处跳过）。
//             这一步**不**再要求快速动作和卡片：REMEMBER 的 from 多了一支没有卡片的来源（protocol 的 RememberCommandPayload），
//             老事件（chat 来源）照旧。组合根没给 write 时明着回 not_implemented，不编造事件。
//   forget   → 推理库那一侧现成的彻底删除（purge-rg.ts 的 purgeMaterials：按素材 id 删证据和只靠它的事实、依赖的结论加复核标记、
//             写审计），按来源把素材 id 找出来交给它（material 直接是它；conversation / message 查素材库；task / project 在素材库里按
//             信封上的 task / project 过滤）。只动推理库：素材库、原话副本是内核的，这里不碰。
//             按条目（items）、按时间段（range）这一版没接；all（整库删）**明确拒绝**（回 failed 写清原因）。
//   health   → 有效证据条数（引擎开着才数得出来）、最近一次整理跑完的时间（整理记录里最近一条 ran 的 ranAt）、
//             推理库占多少字节（会意的数据就是推理库；338 号票起它在会意自己的数据目录里，<数据目录>/memory/subtext/rg.db）。
//   brief    → 现成的每条消息简报（266 号票，engine.messageBrief，和秘书那条路同一份实现）：回正文和这次带上了哪几条
//             （keys 就是 engine.messageBrief 回来的 brought：键 → 指纹，宿主下一轮当 known 交回来，没变的不再带）；
//             结构化那两样（为什么带、命中的素材）一起回，宿主写进"回忆了 N 条记忆"。不带是 undefined。
//   observe  → 这一步回 skipped：现有管道自己摄取（素材库采集 + 每晚整理读成证据），插件不重复收。
//   start/stop → 只记上下文、拿引擎引用；引擎不是它建的（engine-provider.ts 那份缓存的只读引擎由组合根持有），stop 什么都不用关。
//
// 不在这一版里的（下一步）：consolidate（每晚整理仍归记忆插件自己的内部作业）、额外的工具、设置项、页签、身份语言之外的提示；
// 也不把现有工具改接宿主（那样行为会变）。
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  MEMORY_API_VERSION,
  type MemoryBriefInput,
  type MemoryBriefResult,
  type MemoryForgetResult,
  type MemoryForgetSelector,
  type MemoryHealth,
  type MemoryItem,
  type MemoryObserveResult,
  type MemoryProvider,
  type MemoryProviderContext,
  type MemoryProviderInfo,
  type MemoryRememberInput,
  type MemorySearchQuery,
  type MemorySearchResult,
  type MemorySource,
} from "@ergo/protocol";
import { type MemoryEngine, type PurgeReport } from "@ergo/memory";
import { RequestRejected } from "../../errors.ts";
import type { Material, Materials } from "../../materials/index.ts";
import { materialIdsOfRef } from "../data-source-evidence.ts";
import { engineMessageBrief } from "../message-brief.ts";
import type { MemoryProviderFactory } from "./host.ts";

/** 插件自己说的版本：跟着仓库走（packages/daemon/package.json，和 DAEMON_VERSION 同一个文件） */
const SUBTEXT_VERSION = (JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** 检索条数：和 search_materials 工具同一档（不给是 10，最多 30） */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

/** 只给了 since / until 一边时，另一边用这两个把 eventRange 补全（引擎要闭区间；证据没有发生时间的这一版不返回） */
const MIN_TIME = "1970-01-01T00:00:00.000Z";
const MAX_TIME = "9999-12-31T23:59:59.999Z";

/** 宿主给插件的东西：都是"宿主（组合根）做、插件用"，插件自己不建引擎、不写库 */
export interface SubtextProviderDeps {
  /**
   * 现在能用的引擎（组合根持有的那份缓存的只读引擎，engine-provider.ts）；还没建库、打不开、已经关掉时是 undefined。
   * 插件自己不打开、不关它
   */
  engine: () => MemoryEngine | undefined;
  /** 素材库（只读）：把证据的出处对回素材，补上消息、会话的坐标，按来源找素材 */
  materials?: Pick<Materials, "get" | "list">;
  /**
   * 彻底删除这些素材在推理库里的东西（purge-rg.ts 的 purgeMaterials：删证据和事实、依赖的结论加复核标记、写审计）。
   * 不给时 forget 回 failed（说清还没接上）
   */
  deleteMaterials?: (materialIds: readonly string[]) => PurgeReport | undefined;
  /**
   * 337 号票：按原话记一条要写库的那一手（组合根给：追加一条"显式记忆命令"事件 → 素材库照旧采成素材 →
   * 立刻用每晚整理同一个 evidenceDraftOf 读成证据、经推理库的唯一写入口入库）。不给时 remember 回 not_implemented
   */
  remember?: (command: SubtextRememberCommand) => SubtextRememberRecord;
  /** 最近一次整理跑完的时间（整理记录里最近一条 state = ran 的 ranAt）；没有就是没整理过 */
  lastConsolidatedAt?: () => string | undefined;
  /** 会意的数据现在占多少字节（推理库 rg.db）；数据搬进插件自己的数据目录是后面的迁移步骤 */
  bytes?: () => number | undefined;
}

/** 要按原话记的一条：原话本身和它从哪来（哪条会话、哪条消息、哪次工具调用），外加一个防重复的幂等键 */
export interface SubtextRememberCommand {
  text: string;
  conversation: string;
  inputMessageId?: string;
  toolCallId?: string;
  idempotencyKey: string;
}

/** 记下以后的样子：命中的素材、进了检索的证据（只保管、敏感类别挡住时没有）、事件的记时 */
export interface SubtextRememberRecord {
  materialId: string;
  evidenceId?: string;
  at: string;
}

/** 插件清单里那一条：id、名字、版本、接口版本都是现成的，宿主不用起实例就能看 */
export function subtextProviderFactory(deps: SubtextProviderDeps): MemoryProviderFactory {
  return {
    id: SUBTEXT_INFO.id,
    name: SUBTEXT_INFO.name,
    version: SUBTEXT_INFO.version,
    api: SUBTEXT_INFO.api,
    create: () => createSubtextProvider(deps),
  };
}

/** 会意对宿主说的：接口版本、id（也是数据目录名）、名字、版本、能力 */
export const SUBTEXT_INFO: MemoryProviderInfo = {
  api: MEMORY_API_VERSION,
  id: "subtext",
  // @i18n-ignore-next fixed：插件清单里的名字（和 336 号票定的"会意 / Subtext"一致）
  name: { zh: "会意", en: "Subtext" },
  version: SUBTEXT_VERSION,
  // 会意是自研的实验性那一个（337 号票：生产里只有它，标"实验性"）
  experimental: true,
  // 这一版只声明 brief（每轮简报是它自己的实现）；整理、工具、设置项、页签下一段再说
  capabilities: { brief: true },
  // 会意不要求装什么：向量模型不在时检索退回关键词，照样能用
  requirements: {},
};

/** 会意的一个实例：核心八个，加上它自己实现的简报（声明了 capabilities.brief，宿主就用它的） */
export type SubtextProvider = MemoryProvider & { brief(context: MemoryBriefInput): Promise<MemoryBriefResult | undefined> };

/** 一个会意实例（每次 activate 一个新的；引擎、素材库都是组合根的） */
export function createSubtextProvider(deps: SubtextProviderDeps): SubtextProvider {
  /** start 给的上下文；stop 之后清掉——再来的调用一律按"没在跑"拒 */
  let ctx: MemoryProviderContext | undefined;

  const running = (): MemoryProviderContext => {
    if (ctx === undefined) throw new RequestRejected("not_found", "会意没在跑：先由宿主 activate 起来"); // @i18n-ignore log
    return ctx;
  };

  const log = (line: string) => ctx?.log(line);

  /** 一条证据的出处：素材 id（digest 拆开）+ 素材库还认得的话，补上它来自哪条消息 */
  const sourcesOf = (sourceRef: string | null): MemorySource[] => {
    const out: MemorySource[] = [];
    const seen = new Set<string>();
    const push = (source: MemorySource) => {
      const key = `${source.kind}\u0000${source.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(source);
    };
    for (const materialId of materialIdsOfRef(sourceRef)) {
      push({ kind: "material", id: materialId });
      const messageId = deps.materials?.get(materialId)?.ref.messageId;
      if (messageId !== undefined) push({ kind: "message", id: messageId });
    }
    return out;
  };

  /** 一条证据 → 通用条目；没有出处（sourceRef 不是素材、也找不到）的是 undefined，调用方丢掉 */
  const itemOf = (engine: MemoryEngine, evidenceId: string): MemoryItem | undefined => {
    const evidence = engine.getEvidence(evidenceId);
    if (evidence === undefined) return undefined;
    const sources = sourcesOf(evidence.sourceRef);
    if (sources.length === 0) return undefined;
    return {
      id: evidence.id,
      kind: evidence.kind,
      text: evidence.text,
      createdAt: evidence.observedAt,
      // 证据没有"什么时候开始成立"（那是事实的 validFrom / validTo）：发生时间、来源等级放 extra，核心不解释
      extra: { eventTime: evidence.eventTime, sourceLevel: evidence.sourceLevel, mode: evidence.mode, status: evidence.status },
      tags: [...evidence.context],
      sources,
    };
  };

  /** 按来源找素材：认不出来（这一版接不上）是 undefined */
  const materialIdsFor = (source: MemorySource): string[] | undefined => {
    const materials = deps.materials;
    if (source.kind === "material") return [source.id];
    if (materials === undefined) return undefined;
    switch (source.kind) {
      case "conversation":
        return materials.list({ conversation: source.id }).map((m) => m.id);
      case "message":
        return materials.list({ messageId: source.id }).map((m) => m.id);
      // 素材库的筛选只有种类、会话、消息（memory-db.ts 的 MaterialFilter）：任务、项目按信封上的字段在内存里筛
      case "task":
        return materials
          .list()
          .filter((m: Material) => m.task === source.id)
          .map((m) => m.id);
      case "project":
        return materials
          .list()
          .filter((m: Material) => m.project === source.id)
          .map((m) => m.id);
      // 工具调用、文件这一版认不出对应哪些素材
      case "tool_call":
      case "file":
        return undefined;
    }
  };

  /** 删这些素材在推理库里的东西；删不掉（推理库用不了、没有接上）如实回 failed */
  const forgetSources = (materialIds: readonly string[]): MemoryForgetResult => {
    if (materialIds.length === 0) return { removed: 0 };
    if (deps.deleteMaterials === undefined) return { removed: 0, failed: "会意还没接上删除（组合根没给推理库的彻底删除）" }; // @i18n-ignore log
    if (deps.engine() === undefined) return { removed: 0, failed: "推理库现在用不了（还没建库、还没整理过，或者打不开）：这些记忆这一会儿删不掉" }; // @i18n-ignore log
    const report = deps.deleteMaterials(materialIds);
    if (report === undefined) return { removed: 0, failed: "推理库那边没删成（打不开，或者这几条来源本来就没进过推理库）" }; // @i18n-ignore log
    return { removed: report.evidenceIds.length };
  };

  /** 条目在不在这个范围里（项目、任务、会话）：证据背后的素材有一个对得上就算 */
  const inScope = (item: MemoryItem, scope: { projectId?: string; taskId?: string; conversationId?: string }): boolean => {
    for (const source of item.sources) {
      if (source.kind !== "material") continue;
      const material = deps.materials?.get(source.id);
      if (material === undefined) continue;
      if (scope.projectId !== undefined && material.project !== scope.projectId) continue;
      if (scope.taskId !== undefined && material.task !== scope.taskId) continue;
      if (scope.conversationId !== undefined && material.conversation !== scope.conversationId) continue;
      return true;
    }
    return false;
  };

  return {
    info: () => SUBTEXT_INFO,

    async start(context) {
      // 只记上下文：引擎、素材库都是宿主（组合根）建好交进来的，这里不另建一套
      ctx = context;
      log(`会意起来了（插件数据目录 ${context.dataDir}；推理库和素材库还是现有的那两份，没搬）`);
    },

    async stop() {
      // 引擎不是它建的（组合根持有、由组合根关）：这里什么都不用收
      ctx = undefined;
    },

    async observe(): Promise<MemoryObserveResult> {
      // 这一步不重复收：素材库的采集 + 每晚整理读成证据是现有管道
      running();
      return { status: "skipped", reason: "会意现在由素材库和每晚整理自己摄取，插件这一版不收 observe" }; // @i18n-ignore log
    },

    async remember(input: MemoryRememberInput): Promise<MemoryItem> {
      running();
      // 按原话存：只去掉首尾空白，不改写、不推断（用户 2026-10-28 定）
      const text = input.text.trim();
      if (text === "") throw new RequestRejected("bad_params", "记什么？要记住的那一句话是空的"); // @i18n-ignore log：调用方（工具）据此回话
      const sources = input.sources ?? [];
      const conversation = sources.find((source) => source.kind === "conversation")?.id;
      // 出处至少要有会话：没有就说不清这条是哪来的（不硬编一个会话）
      if (conversation === undefined) throw new RequestRejected("bad_params", "记不住：这条记忆没说它是哪个会话里说的（出处至少要会话）"); // @i18n-ignore log
      const messageId = sources.find((source) => source.kind === "message")?.id;
      const toolCallId = sources.find((source) => source.kind === "tool_call")?.id;
      const write = deps.remember;
      if (write === undefined) {
        // 组合根没给写库的路（比如只拿插件单测）：明着说没接，不假装记下了、也不去碰事件日志
        throw new RequestRejected("not_implemented", "会意还不能按原话记一条：组合根没给它写库的路（现有\"记住\"要走对话里的快速动作和卡片）"); // @i18n-ignore log
      }
      const record = write({
        text,
        conversation,
        ...(messageId === undefined ? {} : { inputMessageId: messageId }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
        idempotencyKey: rememberKey(text, conversation, messageId),
      });
      // 出处：素材（采到的那条"显式记忆命令"）+ 这条会话 + 那条消息 + 那次工具调用（都没有的就不硬编）
      const itemSources: MemorySource[] = [
        { kind: "material", id: record.materialId },
        { kind: "conversation", id: conversation },
        ...(messageId === undefined ? [] : [{ kind: "message" as const, id: messageId }]),
        ...(toolCallId === undefined ? [] : [{ kind: "tool_call" as const, id: toolCallId }]),
      ];
      log(
        `会意记了一条：${record.materialId}（会话 ${conversation}${messageId === undefined ? "" : `，消息 ${messageId}`}）${record.evidenceId === undefined ? "，这一会儿没进检索" : `，证据 ${record.evidenceId}`}`,
      );
      return {
        // 进了检索的是证据编号；没进的（只保管、敏感类别挡住）用素材编号，至少有个 id 能给秘书回话
        id: record.evidenceId ?? record.materialId,
        kind: input.kind ?? "note",
        text,
        createdAt: record.at,
        tags: input.tags ?? ["manual"],
        sources: itemSources,
        extra: { conversation, ...(messageId === undefined ? {} : { messageId }), ...(toolCallId === undefined ? {} : { toolCallId }), ingested: record.evidenceId !== undefined },
      };
    },

    async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
      running();
      const started = Date.now();
      const engine = deps.engine();
      // 库还没建、打不开：这一版就当没有（不抛错——宿主拿它拼简报时不带就行）
      if (engine === undefined) return { items: [], tookMs: 0 };
      const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
      const ranged = query.since !== undefined || query.until !== undefined;
      const hits = await engine.search(query.text, {
        // 和 ask_memory（memoryBrief）同一个检索档：关键词 + 向量 + 事实图谱扩展，原话和精炼陈述两层
        mode: "hybrid_kg",
        layers: "both",
        limit,
        ...(ranged ? { eventRange: [query.since ?? MIN_TIME, query.until ?? MAX_TIME] as [string, string] } : {}),
      });
      const kinds = query.kinds === undefined ? undefined : new Set(query.kinds);
      const items: MemoryItem[] = [];
      let withoutSource = 0;
      for (const hit of hits) {
        const item = itemOf(engine, hit.evidenceId);
        if (item === undefined) {
          withoutSource += 1;
          continue;
        }
        if (kinds !== undefined && !kinds.has(item.kind)) continue;
        // 场景范围（项目、任务、会话）：按证据背后的素材判断；没有素材库时这一版不按它筛
        if (query.scope !== undefined && deps.materials !== undefined && !inScope(item, query.scope)) continue;
        if (items.length >= limit) break;
        items.push(item);
      }
      if (withoutSource > 0) log(`会意检索：${withoutSource} 条命中没有出处（sourceRef 不是素材），没交出去`);
      return { items, tookMs: Date.now() - started };
    },

    async forget(selector: MemoryForgetSelector): Promise<MemoryForgetResult> {
      running();
      if ("all" in selector) {
        // 整库删这一版不做：先明着拒，别半删
        return { removed: 0, failed: "会意还不支持整库删除（all）：这一步没做，先把插件槽跑通" }; // @i18n-ignore log
      }
      if ("items" in selector || "range" in selector) {
        return { removed: 0, failed: "会意这一版只支持按来源删（素材、会话、消息、任务、项目）：按条目、按时间段还没接" }; // @i18n-ignore log
      }
      const materialIds = materialIdsFor(selector.source);
      if (materialIds === undefined) {
        return { removed: 0, failed: `会意认不出这个来源该删哪些素材：${selector.source.kind} ${selector.source.id}` }; // @i18n-ignore log
      }
      return forgetSources(materialIds);
    },

    async health(): Promise<MemoryHealth> {
      running();
      const engine = deps.engine();
      const problems: string[] = [];
      let items = 0;
      if (engine === undefined) {
        problems.push("推理库现在用不了（还没建库、还没整理过，或者打不开）：检索和简报这一会儿都是空的"); // @i18n-ignore log
      } else {
        // 条目数按有效证据算：检索交出去的就是它
        items = engine.store.listEvidence({ status: "active" }).length;
      }
      const lastConsolidatedAt = deps.lastConsolidatedAt?.();
      const bytes = deps.bytes?.();
      return {
        items,
        ...(lastConsolidatedAt === undefined ? {} : { lastConsolidatedAt }),
        ...(bytes === undefined ? {} : { bytes }),
        ...(problems.length === 0 ? {} : { problems }),
      };
    },

    async brief(context: MemoryBriefInput): Promise<MemoryBriefResult | undefined> {
      running();
      const engine = deps.engine();
      // 库用不了就不带（和秘书那条路一样：这一轮照常回话）
      if (engine === undefined) return undefined;
      try {
        // 现成的每条消息简报（266 号票）：本机检索 + 相关门槛，不调模型；不相关、都带过了是 undefined。
        // known（这一段带过的键和指纹）交回引擎，没变的不再带；brought 当 keys 交给宿主
        return await engineMessageBrief(engine, context, deps.materials);
      } catch (err) {
        // 检索、渲染出错：这一轮不带，记一行（宿主那边也当作"没有简报"）
        log(`会意简报出错，这一轮不带：${messageOf(err)}`);
        return undefined;
      }
    },
  };
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * 按原话记一条的幂等键：同一个会话、同一条消息里的同一句话再记一次不落第二条事件（模型重试、同一句调用两次）。
 * 换个会话、换句话就是另一条；哈希一下免得把整句原话当键存进库里
 */
function rememberKey(text: string, conversation: string, messageId: string | undefined): string {
  return `memory-remember:${createHash("sha256").update([conversation, messageId ?? "", text].join("\u0000"), "utf8").digest("hex").slice(0, 32)}`;
}
