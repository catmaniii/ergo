// @i18n-ignore-file model：工具的名字走 t()（别的文件），说明、参数说明和交回的文字都是给记忆管理员（模型）看的；
// 写进推理库修订记录的"为什么改"是数据，随被改的数据走（和 purge-rg.ts 同一个规矩），不随界面语言变。
//
// 记忆管理员的工具（242 号票）：尽量复用已有的实现，别自己造一套。
// - run_memory_consolidation：现在整理一次。走的是同一份作业（235 号票的 runNow / 03:00 那一夜作业给的 run）——同一个引擎、
//   同一份 memory.maxModelCalls、同一条整理记录；管理员只是外面那层壳，不改整理出来的结论；
// - inspect_memory：看一条结论的来龙去脉（233 号票的只读视图，memory/graph.ts 的 claim）；
// - review_memory_claim：用户对一条结论表态——对（改回成立）、不对（撤回）、拿不准（标成待复核）。263 号票起走 @ergo/memory 引擎的
//   recordClaimVerdict（记一条本人的表态证据，再走 confirmClaim / rejectClaim / markClaimForReview），不直接改库：
//   整理计分认决定性的支持、反证，下一次整理不会把它改回去；修订记录写明是记忆管理员按用户的话记的；
// - forget_material / no_infer_material：忘掉、别推断（234 号票的 purge-rg）：追加一条记忆命令，记忆插件那边照常处理
//   （证据清原文、事实撤回、依赖的结论待复核；别推断的以后读素材也跳过它）。不走 SQL 直接删；
// - memory_questions：看问题箱、挑该问的（233 号票的只读视图）；
// - 另外复用秘书那两个只读的素材工具：检索素材、读素材全文（找要忘掉的是哪一条、看原话）。
// 不给的：改配置、删素材库、改别人的会话——管理员没有这些工具，用户要就只能说"这个我不做"。
// 267 号票：推理图谱只有一个写入口（@ergo/memory 的 engine.gate，ADR-0030）。管理员的写（表态）也经它：写之前检查、权限分档、留痕；
// 不合格被拒时什么都没写，工具把写入口给的原因逐条交回，管理员照实告诉用户或者改了再写。
import { type Claim, type ClaimVerdict, ClaimVerdictRefused, type Embedder, type MemoryEngine, ReasoningWriteRefused } from "@ergo/memory";
import { type ConversationId, type DeleteCommandPayload, EVENT_TYPES, nowIso, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { EventStore } from "../events/event-store.ts";
import type { MaterialToolOptions } from "./search-tool.ts";
import { readMaterialTool, searchMaterialsTool } from "./search-tool.ts";
import type { Materials } from "../materials/index.ts";
import { MATERIALS_CHANNEL } from "../materials/commands.ts";
import { openReasoningDb } from "./rg-db.ts";
import { materialIdsOfRef } from "./data-source-evidence.ts";
import { type MemoryGraphReader } from "./graph.ts";
import type { MemoryNightlyRecord } from "./nightly-record.ts";
import { reasoningIssueText } from "./nightly-job.ts";
import { commandText, CURATOR_COMMAND_ALIASES, CURATOR_COMMANDS } from "../slash-commands/commands.ts";

/**
 * 记忆管理员能记下的表态：active 对（确认）、retracted 不对（撤回）、needs_review 拿不准（加复核标记）。别的（猜测、被取代）是整理自己判的。
 * 329 号票起"待复核"不再是结论的状态，是单独的复核标记（真值状态不动）；工具参数沿用 needs_review 这个词
 */
export const CURATOR_CLAIM_STATUSES = ["active", "needs_review", "retracted"] as const;
export type CuratorClaimStatus = (typeof CURATOR_CLAIM_STATUSES)[number];

/** 一次忘掉、别推断最多几条（和记忆删除卡的 50 条同一个量级） */
export const CURATOR_MATERIALS_MAX = 50;

/** 一条结论里最多带几段原话（工具结果别太长） */
const QUOTES_MAX = 6;
/** 一段原话最多多少字 */
const QUOTE_CHARS = 160;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 工具交回的一段文字（长的截断） */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 一条整理记录 → 给管理员的一段结果（和 nightly-action.ts 的卡片说法同源，措辞给模型看） */
export function consolidationText(record: MemoryNightlyRecord | undefined): string {
  if (record === undefined) return "这一夜没有留下整理记录（作业没跑）。素材一条没少，下一夜照常整理。";
  if (record.state === "ran") {
    const head = `整理完了（${record.night}）：新出 ${record.newClaims} 条结论、改了 ${record.changedClaims} 条、重判了 ${record.reviewed} 条待复核、跑完还待复核 ${record.needsReview} 条；问题箱里还开着 ${record.questions.open} 个；这次整理调了 ${record.modelCalls} 次模型${record.budgetExhausted ? "（预算用完，剩下的下一夜接着做）" : ""}。`;
    // 270 号票：新证据整理完几条、还积压几条，预算花在哪几道（写进日记，积压着的时候管理员能照实说）
    const spend = record.spend;
    const lanes =
      spend === undefined
        ? ""
        : `新证据整理完 ${record.processedEvidence} 条、还积压 ${record.pendingEvidence} 条；调用按道分：新证据 ${spend.newEvidence}、判回答 ${spend.replies ?? 0}、重跑旧追问 ${spend.rejudge}、往上抽 ${spend.lift}、判预测 ${spend.predictions}、编策略 ${spend.strategies}（上限 ${spend.limit}），对抗复核另算 ${spend.review} 次。`;
    // 271 号票：这一夜判了顺口问的回答（有动静时告诉管理员，写进日记）
    const r = record.replies;
    const replies =
      r === undefined || r.answered + r.notAnswered + r.unsure + r.waiting === 0
        ? ""
        : `看了白天顺口问以后用户说的话：答了 ${r.answered} 个（回写成本人证据）、没在答 ${r.notAnswered} 个（算跳过一次）、拿不准 ${r.unsure} 个（留到下一夜）${r.waiting > 0 ? `、没轮到 ${r.waiting} 个（下一夜接着看）` : ""}。`;
    // 263 号票：对抗复核、判到期预测线上接上了，有动静时告诉管理员（写进日记）
    const review = record.review !== undefined && record.review.reviewed > 0 ? `对抗复核了 ${record.review.reviewed} 条，${record.review.rejected} 条复核员不认、加了复核标记，${record.review.unclear} 条拿不准。` : "";
    const predictions =
      record.predictions !== undefined && record.predictions.judged > 0
        ? `判了 ${record.predictions.judged} 条到期的预测：应验 ${record.predictions.hit}、落空 ${record.predictions.miss}、说不清 ${record.predictions.unclear}。${
            record.predictions.backprop
              ? `落空的往回打了来源：撤了错的前提 ${record.predictions.backprop.retracted} 条、挨反证 ${record.predictions.backprop.countered} 条、判不出撤哪条 ${record.predictions.backprop.undetermined} 条（进了问题箱）、前提都已验证挨反例 ${record.predictions.backprop.counterexamples} 条。`
              : ""
          }`
        : "";
    // 267 号票：每晚校验、写入口拒了的，有动静时也告诉管理员
    const validation =
      record.validation === undefined
        ? ""
        : record.validation.state === "skipped"
          ? `每晚校验跳过了（${record.validation.reason ?? "原因不明"}）。`
          : record.validation.state === "ok"
            ? "每晚校验通过了。"
            : `每晚校验报了 ${record.validation.problems} 个问题，${record.validation.claimIds.length} 条结论加了复核标记${record.validation.claimIds.length > 0 ? `（${record.validation.claimIds.join("、")}）` : ""}${(record.validation.downgraded ?? []).length > 0 ? `，${record.validation.downgraded!.length} 条已验证的压在没验证的前提上、降回猜测（${record.validation.downgraded!.join("、")}）` : ""}。`;
    // 326 号票：结论 ↔ 假设换了的，有动静时告诉管理员（只在 326 号票的老记录里有；329 号票起身份锁死，不再写）
    const h = record.hypotheses;
    const down = h === undefined || h.downgraded.length === 0 ? "" : `${h.downgraded.length} 条结论的前提里有拿不准的事实，降成了假设（${h.downgraded.join("、")}）`;
    const up = h === undefined || h.upgraded.length === 0 ? "" : `${h.upgraded.length} 条冲突解决了，升回结论（${h.upgraded.join("、")}）`;
    const hypotheses = down === "" && up === "" ? "" : `${[down, up].filter((s) => s !== "").join("；")}。`;
    const refused = record.refused !== undefined && record.refused > 0 ? `写入口拒了 ${record.refused} 处不合规矩的写（这一夜没写进去，整理报告里有原因）。` : "";
    return `${head}${lanes}${replies}${review}${predictions}${validation}${hypotheses}${refused}\n接下来把这一夜写成一段整理日记，追加在你的回复里（不要另开话题）：干了什么、新出/变化几条、还拿不准什么、想问用户什么。`;
  }
  if (record.state === "failed" || record.state === "rebuild_needed") {
    return `这一夜没整理成：${record.reason ?? "原因不明"}。照实告诉用户（素材一条没少，下一夜照常整理），不要编造整理结果。`;
  }
  return `这一夜没有整理（${record.reason ?? record.state}）。照实说，不要编造整理结果。`;
}

/** 结论状态的叫法（给模型看） */
const STATUS_TEXT: Readonly<Record<string, string>> = { active: "已验证", contested: "猜测（没验证）", needs_review: "拿不准（加复核标记）", retracted: "已撤回", superseded: "已被取代" };

type GraphView = Pick<MemoryGraphReader, "claim" | "questions">;

/** 一条结论的来龙去脉写成给管理员看的一段（只读） */
function claimText(graph: GraphView, claimId: string): string {
  const view = graph.claim(claimId);
  if (view === undefined) return `没有这条结论：${claimId}`;
  if (!view.ready) return `推理库这会儿读不了：${view.reason ?? "原因不明"}。这一轮还能用 search_materials 检索原话。`;
  const claim = view.claim;
  if (claim === undefined) return `没有这条结论：${claimId}`;
  const lines = [
    `${claim.id}「${claim.statement}」`,
    `层：${claim.tier}；状态：${STATUS_TEXT[claim.status] ?? claim.status}${claim.needsReview ? "（标着复核，下一次整理重判）" : ""}；把握：${claim.confidence}；认知来源：${claim.epistemic}；最后变化：${claim.updatedAt}`,
    `同一组里的竞争解释 ${claim.competitors} 条；支持 ${claim.supports} 条、反驳 ${claim.refutes} 条`,
  ];
  if (view.group) lines.push(`观察：「${clip(view.group.description, 80)}」`);
  for (const link of [...view.supports, ...view.refutes].slice(0, QUOTES_MAX)) {
    // 272 号票：每段原话前面写上是哪条证据（ev-…）——管理员回答时照提示词引证据编号，彻底删除那条素材时按编号抹掉回答里的那几行
    const quotes = link.evidence
      .filter((evidence) => evidence.text !== "")
      .slice(0, 2)
      .map((evidence) => `${evidence.id}「${clip(evidence.text, QUOTE_CHARS)}」`);
    lines.push(`- ${link.kind === "fact" ? `事实「${clip(link.statement ?? "", 60)}」` : "证据"}（${link.rationale}）${quotes.length > 0 ? `：${quotes.join("")}` : ""}`);
  }
  if (view.competitors.length > 0) lines.push(`竞争解释：${view.competitors.map((other) => `${other.id}「${clip(other.statement, 40)}」`).join("；")}`);
  if (view.revisions.length > 0) {
    const last = view.revisions.at(-1)!;
    lines.push(`最近一次改动（${last.at}）：${last.reason}`);
  }
  return lines.join("\n");
}

/** 问题箱写成给管理员看的一段（只读）：还开着的在前，带上编号好引用 */
function questionsText(graph: GraphView, limit: number): string {
  const view = graph.questions({ limit });
  if (!view.ready) return `推理库这会儿读不了：${view.reason ?? "原因不明"}。`;
  if (view.items.length === 0) return "问题箱是空的。";
  const open = view.items.filter((question) => question.status === "open" || question.status === "asked");
  const lines = [`问题箱：一共 ${view.total} 个，还开着 ${view.open} 个（按优先级排）。`];
  for (const question of open.slice(0, limit)) {
    const targets = question.targets.map((target) => `${target.id}「${clip(target.statement, 30)}」`).join("、");
    lines.push(`- ${question.id}（优先级 ${question.priority.toFixed(2)}）${question.text}${targets ? `（为了分清：${targets}）` : ""}`);
  }
  const other = view.items.filter((question) => question.status !== "open" && question.status !== "asked");
  if (other.length > 0) lines.push(`（还有 ${other.length} 个问过、判过、过期或不用问了的，不用管）`);
  return lines.join("\n");
}

/** 管理员改成的状态 → 用户的表态（263 号票：对、不对、拿不准） */
const VERDICT_OF: Readonly<Record<CuratorClaimStatus, ClaimVerdict>> = { active: "confirm", retracted: "reject", needs_review: "doubt" };

/** 表态转达的说法（写进表态证据的原文：固定的一句，不放用户的原话） */
const VIA_CURATOR = "经记忆管理员";

/** 证据背后的素材编号（mat-…；303 号票几条数据源素材合成的那条拆开；表态证据、合成数据这类不是素材的不算） */
function materialIdsOf(engine: MemoryEngine, evidenceIds: readonly string[]): string[] {
  return [...new Set(evidenceIds.flatMap((id) => materialIdsOfRef(engine.store.getEvidence(id)?.sourceRef)))];
}

/** 被拒的表态（什么都没写）怎么跟管理员说 */
function refusalText(engine: MemoryEngine, err: ClaimVerdictRefused, claim: Claim): string {
  if (err.code === "explicit") {
    const materials = materialIdsOf(engine, err.evidenceIds);
    const where = materials.length > 0 ? `它来自素材 ${materials.join("、")}` : `它背后的证据是 ${err.evidenceIds.join("、") || "（没找到）"}`;
    return `${claim.id} 是用户自己明说的（不是推断的），状态跟着那句话走，直接撤不掉，没改。${where}；用户要它不算数，按他的意思用 no_infer_material（别拿来推断）或 forget_material（忘掉）。`;
  }
  if (err.code === "superseded") return `${claim.id} 已经被 ${claim.supersededBy ?? "新的一条"} 取代了，没改；要改就改新的那条。`;
  return `${claim.id} 已经撤回了（${claim.retractedBy === null ? "依据不在了" : `因为 ${claim.retractedBy}`}），不是用户表态撤的，不能直接改回，没改。照实告诉用户：下一次整理有新的证据会重新推。`;
}

/**
 * 263 号票：记下用户对一条结论的表态，走引擎的 recordClaimVerdict（不直接改库）。已经是那个样子的不重复记：
 * 成立且用户确认过 / 用户自己明说的再说对，待复核的再说拿不准，撤回的再说不对
 */
function reviewClaim(engine: MemoryEngine, claimId: string, status: CuratorClaimStatus, note: string): { text: string; isError?: boolean } {
  const claim = engine.store.getClaim(claimId);
  if (claim === undefined) return { text: `没有这条结论：${claimId}`, isError: true };
  const already =
    (status === "active" && claim.status === "active" && claim.epistemic !== "inferred") ||
    (status === "needs_review" && claim.needsReview) ||
    (status === "retracted" && claim.status === "retracted");
  if (already) {
    const how = status === "active" ? (claim.epistemic === "explicit" ? "用户自己明说的已验证" : "用户确认过的已验证") : status === "needs_review" ? "标着复核的" : (STATUS_TEXT[status] ?? status);
    return { text: `${claimId} 已经是${how}了，没改。` };
  }
  let outcome;
  try {
    outcome = engine.recordClaimVerdict(claimId, VERDICT_OF[status], { via: VIA_CURATOR, note });
  } catch (err) {
    if (err instanceof ClaimVerdictRefused) return { text: refusalText(engine, err, claim), isError: true };
    // 267 号票：唯一写入口查出不合规矩，整次没写；原因逐条交回
    if (err instanceof ReasoningWriteRefused) return { text: `${claimId} 没改：推理图谱的写入口没让写——${err.problems.map((p) => p.message).join("；")}。照实告诉用户，能改的改了再写。`, isError: true };
    throw err;
  }
  const now = STATUS_TEXT[outcome.claim.status] ?? outcome.claim.status;
  const withdrawn = outcome.withdrawn.length > 0 ? `用户先前对它的表态（${outcome.withdrawn.join("、")}）收回了。` : "";
  const record = `修订记录写着：${note}。`;
  if (status === "active") {
    const tail = outcome.claim.status === "active" ? "以后整理不会把这个确认改掉；用户改主意时再调一次。" : "按现有的证据它还没胜出（同一组里有别的解释证据更多），照实告诉用户。";
    return { text: `${claimId} 记成用户确认过了（决定性的支持），现在是${now}。${tail}${withdrawn}${record}` };
  }
  if (status === "retracted") {
    const tail = outcome.claim.status === "retracted" ? "以后整理不会把它恢复；用户改主意时再调一次。" : "还有用户以前明说过的话撑着它，没撤成，照实告诉用户（要撤得纠正、忘掉那句话）。";
    return { text: `${claimId} 记下用户说它不对（决定性的反证），现在是${now}。${tail}${withdrawn}${record}` };
  }
  return { text: `${claimId} 加了复核标记，现在是${now}（标记不改真值状态）。下一次整理会按证据重判：证据还撑得住照旧，撑不住会降成猜测或撤回。${withdrawn}${record}` };
}

export interface CuratorToolDeps {
  /** rg.db 的路径（推理库） */
  file: string;
  /** 引擎的时钟 */
  now: () => string;
  /** manifest 里记的整理模型名（打开引擎时要的参数） */
  model: string;
  /** 向量函数（打开引擎时给；不给就不算向量） */
  embedder?: Embedder;
  /** 事件日志：忘掉、别推断的那条记忆命令追加到这里 */
  store: Pick<EventStore, "append">;
  /** 记忆管理员的会话（命令记着它从哪来） */
  conversation: ConversationId;
  /** 结论、问题箱的只读视图（和记忆页同一份） */
  graph: GraphView;
  /** 素材（检索、读全文、认出要忘的是哪几条） */
  materials: Materials;
  /** 素材工具看不到的、存的网页（和秘书那一份同一套） */
  materialOptions: MaterialToolOptions;
  /** 现在整理一次（03:00 唤醒时是这一夜作业给的 run；平时是立即整理一次的 runNow） */
  consolidate(): Promise<MemoryNightlyRecord | undefined>;
  /** 现在能不能整理（已经翻成用户的语言）；能是 undefined */
  blocked(): string | undefined;
  log?: (line: string) => void;
}

/** 记忆管理员的工具清单（永远不连真的模型：整理用记忆插件自己那份配置） */
export function curatorTools(deps: CuratorToolDeps): HostTool[] {
  const log = deps.log ?? (() => {});
  /** 打开推理库、做一件事、关掉（和 233、234 号票一样随用随开） */
  const withEngine = <T>(fn: (engine: MemoryEngine) => T): { ok: true; value: T } | { ok: false; text: string } => {
    let opened: ReturnType<typeof openReasoningDb>;
    try {
      opened = openReasoningDb({ file: deps.file, clock: deps.now, model: deps.model, ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }) });
    } catch (err) {
      return { ok: false, text: `推理库打不开：${messageOf(err)}` };
    }
    if (!opened.ok) return { ok: false, text: `推理库这会儿用不了：${reasoningIssueText(opened.issue)}` };
    try {
      return { ok: true, value: fn(opened.engine) };
    } catch (err) {
      return { ok: false, text: `改不动推理库：${messageOf(err)}` };
    } finally {
      opened.engine.close();
    }
  };

  /** 追加一条记忆命令（忘掉、别推断）：234 号票的 purge-rg 订阅它，按老规矩处理推理库 */
  const command = (mode: "forget" | "no_infer", materialIds: readonly string[], reason: string) => {
    const payload: DeleteCommandPayload = {
      commandId: `curator-${nowIso()}-${Math.random().toString(36).slice(2, 8)}`,
      command: mode,
      materialIds: [...materialIds],
      from: { kind: "curator", conversation: deps.conversation },
    };
    deps.store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.memoryCommand, payload });
    log(`记忆管理员按用户的话 ${mode === "forget" ? "忘掉" : "别推断"}了 ${materialIds.join("、")}：${reason}`);
  };

  /** 忘掉 / 别推断 两个工具共用：认出素材、下命令、交回结果 */
  const materialCommand = (mode: "forget" | "no_infer") =>
    defineHostTool({
      name: mode === "forget" ? "forget_material" : "no_infer_material",
      title: t(mode === "forget" ? "memory.curator.tool.forget" : "memory.curator.tool.noInfer"),
      description:
        mode === "forget"
          ? "忘掉几条素材：用户说「把这条忘掉」时用。素材本身的墓碑留着，从它读出来的证据清掉原文、只靠它的事实撤回、依赖的结论转待复核；" +
            "素材 id 先用 search_materials 找出来（参数是 mat- 开头的编号）。只改记忆，删素材库不是这个工具的事。"
          : "别推断几条素材：用户说「这条别拿来推断」时用。以后读素材跳过它，已经进过库的证据、事实从推理库撤掉，依赖的结论转待复核。" +
            "素材 id 先用 search_materials 找出来。",
      parameters: Type.Object(
        {
          materialIds: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: CURATOR_MATERIALS_MAX, description: "要处理的素材 id（mat- 开头，search_materials 列出来的）" }),
          reason: Type.Optional(Type.String({ maxLength: 200, description: "为什么（用户怎么说的，一句话；写进推理库的修订记录）" })),
        },
        { additionalProperties: false },
      ),
      // 改库：不是只读（再做一次没效果，但它是删改，照从严写）
      readOnlyOrIdempotent: false,
      nature: "modify",
      run(args) {
        const reason = args.reason ?? (mode === "forget" ? "用户让记忆管理员忘掉" : "用户让记忆管理员别用这条推断");
        const known = args.materialIds.filter((id) => deps.materials.get(id) !== undefined);
        const unknown = args.materialIds.filter((id) => deps.materials.get(id) === undefined);
        if (known.length === 0) return { text: `没有这些素材：${args.materialIds.join("、")}。先用 search_materials 找出 mat- 开头的编号。`, isError: true };
        command(mode, known, reason);
        const head = mode === "forget" ? `忘掉了 ${known.length} 条素材` : `这 ${known.length} 条素材不再参与推断了`;
        const extra = unknown.length > 0 ? `（这些没找到：${unknown.join("、")}）` : "";
        const tail = "从它们读出来的证据、事实和依赖的结论已经按老规矩处理；下一次整理重新推拿不准的那些。";
        return { text: `${head}：${known.join("、")}。${tail}${extra}` };
      },
    });

  return [
    defineHostTool({
      name: "run_memory_consolidation",
      title: t("memory.curator.tool.consolidate"),
      description:
        "现在整理一次记忆：走每晚 03:00 同一份整理（同一个引擎、同一份预算、同一条整理记录），把攒着的素材整理成结论、更新问题箱。" +
        "03:00 被唤醒时先调这个，再写整理日记；用户让你现在就整理一次时也用它（用户打 " +
        commandText(CURATOR_COMMANDS.consolidate, CURATOR_COMMAND_ALIASES.consolidate) +
        " 就是这个意思）。它是增量、幂等的：没有新素材时几乎不调模型。" +
        "整理失败时照实交回原因（素材一条没少，下一夜接着做）；不要自己编造整理结果。",
      parameters: Type.Object({}, { additionalProperties: false }),
      readOnlyOrIdempotent: false,
      nature: "modify",
      async run() {
        const blocked = deps.blocked();
        if (blocked !== undefined) return { text: `现在整理不了：${blocked}` };
        try {
          return { text: consolidationText(await deps.consolidate()) };
        } catch (err) {
          return { text: `整理没跑成：${messageOf(err)}。照实告诉用户，素材一条没少。`, isError: true };
        }
      },
    }),
    defineHostTool({
      name: "inspect_memory",
      title: t("memory.curator.tool.inspect"),
      description:
        "看一条结论的来龙去脉：陈述、层、状态、把握、是用户说的还是推断的、支持/反驳它的证据和原话、同一组里的竞争解释、最近一次改动。" +
        "用户问「这条是哪来的」「为什么这么标」时用；结论编号（cl- 开头）从整理结果或结论列表里来。只读。",
      parameters: Type.Object({ claimId: Type.String({ minLength: 1, maxLength: 64, description: "结论编号（cl- 开头）" }) }, { additionalProperties: false }),
      readOnlyOrIdempotent: true,
      nature: "look",
      run(args) {
        return { text: claimText(deps.graph, args.claimId) };
      },
    }),
    defineHostTool({
      name: "review_memory_claim",
      title: t("memory.curator.tool.review"),
      description:
        "记下用户对一条结论的表态：用户说「这条对」→ active（记成用户确认过，改回成立）；「这条不对，撤回」→ retracted；" +
        "「这条拿不准，标一下」→ needs_review（加复核标记：真值状态不动，下一次整理按证据重判）。用户点名了是哪条、怎么说的才调；拿不准先问。" +
        "确认和撤回会记成决定性的支持、反证，以后整理不会把它改回去；用户改主意时再调一次（先前的表态自动收回）。" +
        "用户自己明说的结论撤不掉（它跟着那句话走），工具会交回那句话是哪条素材，按用户的意思用 no_infer_material 或 forget_material。",
      parameters: Type.Object(
        {
          claimId: Type.String({ minLength: 1, maxLength: 64, description: "结论编号（cl- 开头）" }),
          status: Type.Union(CURATOR_CLAIM_STATUSES.map((status) => Type.Literal(status)), { description: "用户怎么说：active 对（确认）、retracted 不对（撤回）、needs_review 拿不准（加复核标记）" }),
          reason: Type.Optional(Type.String({ maxLength: 200, description: "为什么（用户怎么说的，一句话；写进修订记录）" })),
        },
        { additionalProperties: false },
      ),
      readOnlyOrIdempotent: false,
      nature: "modify",
      run(args) {
        const note = `记忆管理员按用户的话改成${STATUS_TEXT[args.status] ?? args.status}${args.reason === undefined ? "" : `：${args.reason}`}`;
        const result = withEngine((engine) => reviewClaim(engine, args.claimId, args.status, note));
        return result.ok ? result.value : { text: result.text, isError: true };
      },
    }),
    materialCommand("forget"),
    materialCommand("no_infer"),
    defineHostTool({
      name: "memory_questions",
      title: t("memory.curator.tool.questions"),
      description:
        "看问题箱：整理时还拿不准、想问用户的问题（按优先级），包括还开着的和问过、判过的。用户问「你还想问什么」「有什么拿不准的」时用，" +
        "也可以挑一两个顺口问。只读。",
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "最多几个（默认 10）" })) }, { additionalProperties: false }),
      readOnlyOrIdempotent: true,
      nature: "look",
      run(args) {
        return { text: questionsText(deps.graph, args.limit ?? 10) };
      },
    }),
    // 秘书那两个只读的素材工具：找要忘掉的是哪一条、看原话
    searchMaterialsTool(deps.materials, deps.materialOptions),
    readMaterialTool(deps.materials, deps.materialOptions),
  ];
}

/** 记忆管理员的工具名（守卫看到的工具包、测试比对）；284 号票起后四个是了解你访谈的（interview-tools.ts） */
export const CURATOR_TOOL_NAMES = [
  "run_memory_consolidation",
  "inspect_memory",
  "review_memory_claim",
  "forget_material",
  "no_infer_material",
  "memory_questions",
  "search_materials",
  "read_material",
  "begin_interview",
  "finish_interview",
  "forget_interview_answers",
  "propose_personal_file",
] as const;

/** 结论状态是不是能由管理员改的那几种 */
export function isCuratorClaimStatus(value: string): value is CuratorClaimStatus {
  return (CURATOR_CLAIM_STATUSES as readonly string[]).includes(value);
}
