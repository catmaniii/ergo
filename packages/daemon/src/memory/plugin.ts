// 记忆插件（ADR-0027 的第二个适配器："素材与记忆"）：素材怎么采、记忆命令、记忆删除卡、向量索引和检索在守护进程这一侧的
// 全部登记都在这里，组合根只在插件清单里列它。记忆系统（记忆管理者、做梦阶段、记忆简报、用户卡、动机挖掘）在这个插件里长出来：
// 新的内部作业、上下文块（记忆简报照 when: "wake" / "input" 作为消息追加进会话）、工具、视图都经这里的 ctx 登记。
// - 数据契约（停用也登记）：
//   - 它拥有的事件怎么变成素材：显式记忆命令（memory_command 里的"记住"和用户下的删除命令）、建议卡和提问卡长期没处理（card_stale，
//     回避信号计时追加的）、秘书存下的外部信息（material_ingested，materials/ingested.ts）——声明进内核的素材库，停用时照样声明
//     （素材库按它给本人的话留原话副本，重建 materials.db 时照样采得出来）；
//   - 这三类事件的改写函数（彻底删除照常），和素材"回的是什么"的判定（material_replies，每晚整理之前判的，素材库照它标）的改写函数；
//   - 记忆删除卡（卡上的动作现取 MEMORY，没启用时回"记忆插件没启用"）。
// - 装配：
//   - 开始采成素材（素材库的 collect：写进 materials.db 和关键词索引、从原文副本补回、向量补算和语义检索、回避信号计时），停用时停掉，
//     之后素材库只保管（见 materials/materials.ts 文件头）；
//   - 记忆命令的四个快速动作（记住、忘掉、彻底删除、别推断；忘掉等三种在"提议快速动作"的说明里带上"先用 search_materials 检索"那句）；
//   - 记忆插件的服务 MEMORY（记忆删除卡上确认的删除）；
//   - agent 那一侧：秘书的素材检索工具 search_materials、读素材 read_material、问记忆 ask_memory（
//     按需深查推理图谱）、问记忆管理员 ask_curator（把要深聊、要改/要忘的话转给它）经 agent 贡献缝只给秘书；
//     还多一个记一句 remember_memory（用户说"帮我记一句"时把原话交给记忆插件槽的宿主，插件没起来就只有别的几个）；
//     和存外部信息 ingest_material（ingest-tool.ts：用户要秘书把读到的邮件、网页、日程……存进素材时，写一条 material_ingested 事件，
//     素材由数据契约里登记的采集函数产生，来源外部（不可信）；不自动存）；
//     每轮醒来（和压缩之后）的简报上下文块 memory.brief（只给秘书，空串就不注入）；
//     每条输入后面的记忆简报（message-brief.ts，只给秘书：用户这句话有相关的记忆就带相关的结论连原话，同一段对话里带过没变的不再带，
//     结构化的部分随回话进"回忆了 N 条记忆"、账本记一笔估的 token；记忆页的设置里能关，默认开；和顺口问那块都跟在这一轮输入后面，简报在前；
//     正文问记忆插件槽要：插件声明了 capabilities.brief 就用它的，没有宿主拿 search 拼，插件没起来就不带）；
//     每条输入后面的顺口问上下文块（woven-questions.ts，只给秘书：这一轮话题对上了就交一个"了解你问题"，让秘书
//     用自己的话自然地问，问了用 mark_woven_question 标一下；用户紧接着的下一句明显的由规则判、回写成本人证据，认不出的留给每晚整理时
//     记忆管理员判；记忆页的设置里能关，默认开）。秘书的插件工具按插件装的先后排，
//     插件清单里记忆插件排在提醒后面，所以它在提醒的三个工具之后、内核的 propose_quick_action 之前——和搬过来之前的位置一样；
//     系统提示里的在定义里声明（prompts，见 prompt.ts：条件"记忆"、几个工具名占位符）。
// ask_memory 和简报用同一个懒打开、缓存的只读引擎（engine-provider.ts）：引擎是整理时开、跑完关，
// 会话里随用随开，插件停用时关掉；库用不了时这一轮照旧能检索素材。
// 这台机器上跑不跑整理由配置 memory.enabled 定（默认 true）——false 时不登记 03:00 的内部作业、不建 rg.db，
// 别的一行不变（采集、素材检索、简报、ask_memory 都用已有的库）；手动整理一次是快速动作 memory_nightly（nightly-action.ts），
// 走同一份作业，用户点了才跑（confirm: "always"）。
// 停用（配置 plugins.disabled 里写 memory，重启生效）：不再采成素材、没有记忆命令、秘书没有 search_materials、read_material
// 和 ask_memory、没有简报块、提示里不讲记忆命令；
// 素材库照旧保管——新的本人的话照样留原话副本（用户的数据承诺：本人说过的每句话留一份不可修改的原文副本，删项目也不受影响；
// 这和记忆功能开不开无关，停了就再也补不回来），设置里按会话、按时间段删除素材，删项目时随项目删内部记录照常（彻底删除照常能删已有的素材）。
// 再启用时素材库从停下的采集位置补采，停用期间的素材一条不少。设置 · 插件里运行中停用、启用马上生效（素材库运行中又开始采集）。
// 移除时"连数据删"只删记忆插件自己的："记住"的命令里的内容（现有的改写函数）、长期没处理的卡的
// 记录（card_stale）、记忆删除卡的每个版本；素材库不动（素材属于内核，设置里写明去成批删除删），删除类的记忆命令不碰（它是删除记录，
// 改写了重建时被删的素材会回来，ADR-0008）。
// 体检（412，doctor.ts）：setup 里经 ctx.doctor.register 登记自己的六项（向量索引、推理库、记忆系统、记忆简报、每晚整理、整理前导入数据源），
// 停用时跟着撤；记忆简报那一项读简报自己的统计（message-brief.ts 的 stats()，427）。
// 了解你访谈，interview.ts：数据契约里登记约访卡（卡片类型 interview，动作现取服务）、移除时连数据删访谈的记录；
// 装配：访谈的服务（MEMORY_INTERVIEWS：记忆管理员的访谈工具、组合根给访谈里的话标编号、网关的 /api/memory/interview 用它）、
// 每周六 10:00 约访的内部作业、秘书开访谈的快速动作 start_interview。访谈本身在记忆管理员的会话里（它是内核建的，curator.ts）。
// 不搬进来的：彻底删除的改写函数表和算改写的那一套（memory/rewriters.ts、purge.ts、deletion.ts、after-purge.ts）是横跨所有模块的契约，
// 设置里的批量删除（bulk.ts）、项目内部记录的认法（internal-records.ts）是删除照常要用的，都留在内核。
import fs from "node:fs";
import { backgroundVectors, DEEPSEEK_DEFAULT_MODEL, graphSelfCheck, type MemoryEngine } from "@ergo/memory";
import { CHANNELS, DEFAULT_MEMORY_SETTINGS, EVENT_TYPES, MEMORY_CURATOR_CONVERSATION, type MemoryCommandEventPayload, PURGED_TEXT, t } from "@ergo/protocol";
import { clockIso } from "../scheduler/clock.ts";
import { INTERNAL_CHANNEL } from "../scheduler/internal-jobs.ts";
import { RequestRejected } from "../errors.ts";
import {
  cardStalePurge,
  cardStaleSource,
  ingestedOf,
  MATERIALS_CHANNEL,
  type Material,
  materialIngestedPurge,
  materialIngestedSource,
  materialRepliesPurge,
  memoryCommandSource,
  rememberCommandPurge,
} from "../materials/index.ts";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { MEMORY, MEMORY_INTERVIEWS, MEMORY_NIGHTLY, type MemoryNightlyService } from "./api.ts";
import { createMemoryInterviews, INTERVIEW_EVENT, interviewCardType, interviewFilesCardType, startInterviewAction } from "./interview.ts";
import { askMemoryTool } from "./ask-tool.ts";
import { ingestMaterialTool } from "./ingest-tool.ts";
import { MEMORY_BRIEF_BLOCK_ID, wakeBriefText } from "./context.ts";
import { askCuratorTool } from "./curator-link.ts";
import { kernelEmbedderAdapter, secretaryEmbedder } from "./embedder-adapter.ts";
import { createMemoryEngineProvider, createWritableEngineUse } from "./engine-provider.ts";
import { memoryCommandExecutors, memoryDeleteCardType } from "./memory-commands.ts";
import { memoryNightlyAction } from "./nightly-action.ts";
import { createMemoryNightlyJob, MEMORY_NIGHTLY_FAILED_NOTICE, MEMORY_NIGHTLY_REBUILD_NOTICE, type MemoryNightlyJob, reasoningIssueText, reportUnusableReasoningDb } from "./nightly-job.ts";
import { MEMORY_NIGHTLY_EVENT, type MemoryNightlyRecord, memoryNightlyView } from "./nightly-record.ts";
import { memoryPrompts } from "./prompt.ts";
import { rememberTool } from "./provider/tool.ts";
import { createReasoningPurge } from "./purge-rg.ts";
import { purgedEvidenceIds } from "./purged-evidence.ts";
import { openReasoningDb } from "./rg-db.ts";
import { readMaterialTool, searchMaterialsTool } from "./search-tool.ts";
import { createProfileFactExpiry, learnedAbout } from "./personal-files-link.ts";
import { createWovenQuestions } from "./woven-questions.ts";
import { createMessageBriefs } from "./message-brief.ts";
import { memoryDoctorChecks } from "./doctor.ts";
import type { ReasoningDbIssue } from "./rg-db.ts";
import { inAbandonedBranch } from "../conversation/session-branches.ts";
import { savedPageOf } from "../browsing/api.ts";
import { internalRecordOf } from "./internal-records.ts";

/** 起来多久之后在后台先算好记忆简报的相关门槛要用的背景语料向量 */
const BRIEF_WARMUP_MS = 20_000;
/** 用户发来一句时拉起向量模型：最多等它这么久来记一行加载用了多久（只为日志，不挡任何事） */
const BRIEF_PREWARM_WAIT_MS = 30_000;

/** 推理库文件多大（字节）；不在、是空的、读不了是 undefined */
function rgDbBytes(file: string): number | undefined {
  try {
    const size = fs.statSync(file).size;
    return size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

export const memoryPlugin: PluginDefinition = {
  name: "memory",
  get title() {
    return t("memory.plugin.title");
  },
  get summary() {
    return t("memory.plugin.summary");
  },
  get brings() {
    return {
      tools: [t("memory.tool.search"), t("memory.tool.read"), t("memory.tool.ask"), t("memory.tool.curator"), t("memory.tool.woven"), t("memory.tool.remember"), t("memory.tool.ingest")],
      cards: [t("memory.plugin.card"), t("memory.plugin.interviewCard"), t("memory.plugin.interviewFilesCard")],
    };
  },
  needs: [
    KERNEL.config,
    KERNEL.store,
    KERNEL.clock,
    KERNEL.scheduler,
    KERNEL.cards,
    KERNEL.inbox,
    KERNEL.materials,
    KERNEL.materialOwners,
    KERNEL.quickActions,
    KERNEL.purgeRewriters,
    KERNEL.embedder,
    KERNEL.layout,
    KERNEL.env,
  ],
  wants: [KERNEL.memoryModel, KERNEL.memorySettings, KERNEL.usage, KERNEL.personalFiles, KERNEL.memorySlot, KERNEL.elementFiles, KERNEL.dataSourceSync],
  provides: [MEMORY, MEMORY_NIGHTLY, MEMORY_INTERVIEWS],
  views: [memoryNightlyView],
  prompts: memoryPrompts,
  contracts(ctx) {
    // 拥有的事件怎么变成素材（声明进内核的素材库）
    ctx.materialSources.register(memoryCommandSource);
    ctx.materialSources.register(cardStaleSource);
    // 秘书按用户的要求存下的外部信息：来源外部（不可信），正文只进检索
    ctx.materialSources.register(materialIngestedSource);
    // 彻底删除："记住"的命令只换掉内容；长期没处理的卡只换掉卡片的纯文本降级；存下的外部信息换掉标题、正文、出处；
    // 素材"回的是什么"的判定只换掉被删素材那几项的前文总结
    ctx.purge.register(rememberCommandPurge, cardStalePurge, materialIngestedPurge, materialRepliesPurge);
    ctx.cardTypes.register(memoryDeleteCardType(() => ctx.active(MEMORY)));
    // 约访卡（动作现取访谈的服务，插件没启用时回"记忆插件没启用"）
    ctx.cardTypes.register(interviewCardType(() => ctx.active(MEMORY_INTERVIEWS)));
    // 访谈的档案核对卡（"确认"现取访谈的服务，经 personal_file 的执行器写进档案；"不记"只改卡）
    ctx.cardTypes.register(interviewFilesCardType(() => ctx.active(MEMORY_INTERVIEWS)));
    // 移除时连数据一起彻底删除（选 A：只删记忆插件自己的，素材库不动）
    ctx.removal.declare({
      get deletes() {
        return [t("memory.plugin.purge.remember"), t("memory.plugin.purge.stale"), t("memory.plugin.purge.cards"), t("memory.plugin.purge.nightly"), t("memory.plugin.purge.interviews"), t("memory.plugin.purge.interviewCards")];
      },
      get keeps() {
        return [
          t("memory.plugin.keep.materials"),
          t("memory.plugin.keep.commands"),
          t("memory.plugin.keep.backup"),
          // 推理由库和素材原文都不删
          t("memory.plugin.keep.reasoning"),
          t("memory.plugin.keep.originals"),
        ];
      },
      events: [
        { channel: CHANNELS.cards, type: EVENT_TYPES.cardStale },
        // 每晚整理的记录：连数据删时一起换成删除标记（结论原文本来就不在这里）
        { channel: INTERNAL_CHANNEL, type: MEMORY_NIGHTLY_EVENT },
        // 了解你访谈的记录：约了、开始、结束（里面没有用户的话；访谈里说的话是素材，归内核的素材库，不跟着删）
        { channel: INTERNAL_CHANNEL, type: INTERVIEW_EVENT },
      ],
      notices: [MEMORY_NIGHTLY_FAILED_NOTICE, MEMORY_NIGHTLY_REBUILD_NOTICE],
      // "记住"的命令只换内容（rememberCommandPurge）；删除类的命令是删除记录，不碰
      rewrite: [
        {
          channel: MATERIALS_CHANNEL,
          type: EVENT_TYPES.memoryCommand,
          when: (event) => {
            const p = event.payload as MemoryCommandEventPayload;
            return p.command === "remember" && p.content !== PURGED_TEXT;
          },
        },
      ],
      cardTypes: ["memory_delete", "interview", "interview_files"],
    });
  },
  setup(ctx) {
    const config = ctx.use(KERNEL.config);
    const clock = ctx.use(KERNEL.clock);
    const materials = ctx.use(KERNEL.materials);
    const quickActions = ctx.use(KERNEL.quickActions);
    // 采成素材：素材库启动时补采、补回、约好向量补算、开始回避信号计时
    ctx.effect(() =>
      materials.collect({
        embedder: ctx.use(KERNEL.embedder),
        scheduler: ctx.use(KERNEL.scheduler),
        clock,
        inbox: ctx.use(KERNEL.inbox),
        staleCardDays: config.materials.staleCardDays,
      }),
    );
    // 记忆命令：记住、忘掉、彻底删除、别推断
    // 彻底删除时问记忆的结果按证据编号找（被删素材在推理库里的证据编号从 rg.db 查）
    const rgDb = ctx.use(KERNEL.layout).rgDb;
    const executors = memoryCommandExecutors({
      store: ctx.use(KERNEL.store),
      cards: ctx.use(KERNEL.cards),
      rewriters: ctx.use(KERNEL.purgeRewriters),
      now: () => clockIso(clock),
      materials,
      evidenceOf: (materialIds) => purgedEvidenceIds(rgDb, materialIds, (line) => ctx.log(line)),
    });
    for (const executor of executors) ctx.quickActions.register(executor);
    // "二狗了解到的"用简报那份缓存的只读引擎（下面建好以后才有，这里现取）
    let learnedEngine: () => MemoryEngine | undefined = () => undefined;
    ctx.provide(MEMORY, {
      confirmDeletion(mode, materialIds, context, title) {
        const executor = quickActions.registry.get(mode);
        if (!executor) throw new RequestRejected("not_allowed", t("memory.unknownMode", { mode }));
        return quickActions.execute(executor, { materialIds }, context, title);
      },
      learnedAbout: (subject) => learnedAbout(learnedEngine(), subject),
    });
    // 推理库和两处会话内用途。起来就把 rg.db 建好（打开一次、确认 manifest、随手关掉），
    // 03:00 由内部作业整理；版本对不上、库打不开：不开、不自动迁移，记一条"要重建推理库"并在待我处理里提示一次，
    // 素材检索和记忆命令照常。
    // ask_memory 和每轮简报用同一个懒打开的只读引擎（engine-provider.ts：第一次用时打开、缓存一个、停用时关掉）；
    // 库用不了时 ask_memory 回"记忆还没准备好"、简报是空串，这一轮照旧能检索素材。
    const layout = ctx.use(KERNEL.layout);
    const inbox = ctx.use(KERNEL.inbox);
    const kernelEmbedder = ctx.use(KERNEL.embedder);
    const embedder = kernelEmbedderAdapter(kernelEmbedder);
    const log = (line: string) => ctx.log(line);
    const modelFactory = ctx.optional(KERNEL.memoryModel);
    // 秘书那一侧共用的向量函数（embedder-adapter.ts）：查询向量记住最近几句，和每条消息的简报（会意插件那份引擎，组合根建的）
    // 是同一个实例——背景语料向量只算一次，下面预热的就是简报真用的那一份
    const secretary = secretaryEmbedder(kernelEmbedder);
    const engineProvider = createMemoryEngineProvider({ file: layout.rgDb, clock: () => clockIso(clock), model: DEEPSEEK_DEFAULT_MODEL, embedder: secretary, log });
    learnedEngine = () => engineProvider.get();
    // 起来一会儿之后在后台先算好相关门槛要用的背景语料向量（200 句，bge-m3 约 2–3 秒，按向量函数实例记住）——
    // 不然重启后第一条消息的记忆简报要等它算完，超过上限这一条就不带了。只算向量，不打开推理库。
    // 算的是 secretary 这一份：ask_memory 和每条消息的简报（会意那份引擎）都用它（427 之前简报那份是另一个实例，这里预热的它用不上）
    ctx.effect(() => {
      const timer = setTimeout(() => {
        if (!secretary.available() || !fs.existsSync(layout.rgDb)) return;
        backgroundVectors(secretary).catch((err: unknown) => log(`记忆简报：预先算背景语料的向量没成，第一次用时再算：${err instanceof Error ? err.message : String(err)}`));
      }, BRIEF_WARMUP_MS);
      timer.unref();
      return () => clearTimeout(timer);
    });
    ctx.lifecycle({
      stop: async () => {
        engineProvider.close();
      },
    });
    // 每轮醒来（和每次压缩之后）的简报：只给秘书；空的就不注入（空库、还没结论时都是空串）
    ctx.agent.context.register({ to: { agents: ["secretary"] }, when: "wake", id: MEMORY_BRIEF_BLOCK_ID, text: () => wakeBriefText(engineProvider.get()) });

    // 秘书的素材检索、读素材、问记忆、问记忆管理员、标顺口问、记一句、存外部信息：只给秘书（工具在下面顺口问建好以后一起登记）
    // 废弃分支里的话：照样检索得到，标"在废弃分支里"、排在当前分支的后面
    // 用户存的网页：正文从原始事件里取，夹在外部数据标记里给
    const store = ctx.use(KERNEL.store);
    const owners = ctx.use(KERNEL.materialOwners);
    // 记忆插件槽（宿主）。没接上（只有插件没组合根的测试）就不给"记一句"这个工具
    const memorySlot = ctx.optional(KERNEL.memorySlot);
    const options = {
      hidden: (m: Material) => internalRecordOf(m, owners) !== undefined,
      abandoned: (m: Material) => inAbandonedBranch(store.reader, m.ref.event),
      savedPage: (m: Material) => savedPageOf(store, m),
      // 存下的外部信息：正文、出处从原始事件里取，夹在外部数据标记里给
      ingested: (m: Material) => ingestedOf(store, m),
    };
    // 每条消息的记忆简报（message-brief.ts）：用户这句话有相关的记忆（本机检索和相关门槛判，不调模型）就追加一块【记忆简报】
    // 在这一轮输入的尾部，结论连原话、上限照 BRIEF_LIMITS，同一段对话里带过没变的不再带；结构化的部分随这一轮的回话进"回忆了 N 条记忆"；
    // 每带一次账本记一笔估的 token（用量页的"记忆简报"）。记忆页的设置里关掉就不带。
    // 这段正文不再直接问引擎，问记忆插件槽（宿主的 brief：插件声明了 brief 就用它的、没有拿 search 拼；插件没起来就不带）。
    // 登记在顺口问前面：两块都跟在输入后面，简报在前（背景），顺口问在后（回话末尾要带的那一句）
    // 简报自己记着每次的结局和各步用时（briefs.stats()，只在内存里），体检的"记忆简报"那一项读它
    const briefEnabled = () => ctx.optional(KERNEL.memorySettings)?.current().memoryBrief ?? DEFAULT_MEMORY_SETTINGS.memoryBrief;
    const briefs = createMessageBriefs({
      brief: (input) => (memorySlot === undefined ? Promise.resolve(undefined) : memorySlot.brief(input)),
      store,
      materials,
      enabled: briefEnabled,
      record: (usage) => ctx.optional(KERNEL.usage)?.recordContextUsage({ ...usage, role: "secretary" }),
      // 用户发来一句就把向量模型拉起来（闲置十分钟会卸掉）；这一次是真去加载的才记一行用了多久（看冷启动到底要几秒）
      prewarm: () => {
        if (secretary.ready()) return;
        const started = Date.now();
        void secretary.warm(BRIEF_PREWARM_WAIT_MS).then((state) => {
          if (state === "loaded") log(`记忆简报：用户发来一句时向量模型没加载，拉起来用了 ${Date.now() - started} 毫秒`);
          else log(`记忆简报：用户发来一句时向量模型没加载，拉起来 ${BRIEF_PREWARM_WAIT_MS} 毫秒还没好`);
        });
      },
      now: () => clockIso(clock),
      log,
    });
    ctx.agent.context.register({
      to: { agents: ["secretary"] },
      when: "input",
      text: (message, target) => briefs.inputText(message, target),
      replyParts: (message) => briefs.replyParts(message),
    });
    ctx.effect(() => store.onAppend((event) => briefs.onEvent(event)));

    // 顺口问（woven-questions.ts）：秘书开始处理用户的每一句时，先判上一轮顺口问的问题这句是不是在答（明显的回写成本人证据，
    // 认不出的留给每晚整理时记忆管理员判），再看这一轮要不要顺口问一个（只看不记）；秘书用自己的话问，问了调 mark_woven_question
    // 标一下（工具只在内存里记个标记），这一轮做完（turn_end）标了才记"问过"。
    // 要写问题箱和回答那条证据，用随用随开的可写引擎（写都经唯一写入口，记"经秘书顺口问"），不用简报那份缓存的读者引擎；
    // 记忆页的设置里关掉就都不做（现取，改了下一条输入就按新的）
    const woven = createWovenQuestions({
      withEngine: createWritableEngineUse({ file: layout.rgDb, clock: () => clockIso(clock), model: DEEPSEEK_DEFAULT_MODEL, embedder, log }),
      store,
      materials,
      enabled: () => ctx.optional(KERNEL.memorySettings)?.current().wovenQuestions ?? DEFAULT_MEMORY_SETTINGS.wovenQuestions,
      inferableSensitiveCategories: () => config.memory.sensitiveCategories,
      log,
    });
    ctx.agent.context.register({ to: { agents: ["secretary"] }, when: "input", text: (message) => woven.inputText(message) });
    ctx.effect(() => store.onAppend((event) => woven.onEvent(event)));
    const tools = [
      searchMaterialsTool(materials, options),
      readMaterialTool(materials, options),
      askMemoryTool(engineProvider, materials),
      askCuratorTool({ store, conversation: MEMORY_CURATOR_CONVERSATION, log }),
      woven.markTool(),
      // 用户说"帮我记一句"时秘书调它，转给记忆插件槽（在跑的那个记忆插件）。槽没接上就不给这个工具
      // 用户说"这张图记下来"时连文件一起存：这一轮长按的元素取回来的文件经组合根现取（浏览插件没启用时只能记文字）
      ...(memorySlot === undefined ? [] : [rememberTool({ remember: (input) => memorySlot.remember(input), store, elementToRemember: (ref, call) => ctx.optional(KERNEL.elementFiles)?.toRemember(ref, call) })]),
      // 用户要把读到的邮件、网页、日程……存进素材时秘书调它：只写一条事件，素材由上面数据契约里登记的采集函数产生
      ingestMaterialTool({ store, now: () => clockIso(clock) }),
    ];
    ctx.agent.tools.register({ to: { agents: ["secretary"] }, tools: () => tools });

    // 每晚整理：03:00 由内部作业整理。
    // memory.enabled = false 是"这台机器上不跑整理"（和插件停用是两回事）——不排作业、不建库、不花模型的调用；
    // 素材采集、素材检索、简报、ask_memory 照旧（简报和 ask_memory 读已有的库，没有库就回"还没准备好"）。
    let nightly: MemoryNightlyJob | undefined;
    let nightlyBlocked: string | undefined;
    /** 启动时推理库没打开成的原因（体检的"推理库"那一项读） */
    let setupIssue: ReasoningDbIssue | undefined;
    if (!config.memory.enabled) {
      nightlyBlocked = t("memory.nightly.manual.off");
      log("记忆整理在这台机器上关着（配置 memory.enabled 是 false）：不排每晚整理，素材采集、检索和简报照常");
    } else {
      const opened = openReasoningDb({ file: layout.rgDb, clock: () => clockIso(clock), model: DEEPSEEK_DEFAULT_MODEL, embedder });
      if (!opened.ok) {
        reportUnusableReasoningDb({ store, inbox, clock, issue: opened.issue, log });
        nightlyBlocked = reasoningIssueText(opened.issue);
        setupIssue = opened.issue;
      } else {
        if (opened.created) ctx.log(`记忆整理建好了推理库 ${layout.rgDb}`);
        opened.engine.close();
        const job = createMemoryNightlyJob({
          file: layout.rgDb,
          materials,
          clock,
          store,
          inbox,
          config: config.memory,
          embedder,
          env: ctx.use(KERNEL.env),
          ...(modelFactory === undefined ? {} : { chat: modelFactory }),
          // 整理完跑每晚校验；是记忆系统自己的图谱自检（不起别的程序，本机缺什么都照样查）
          validator: graphSelfCheck,
          // 判顺口问的回答时按会话取问过以后用户说的话
          conversations: store,
          // 个人档案（内核的）——档案摘要当情境、号码不进提示、认人物信息攒候选
          personalFiles: () => ctx.optional(KERNEL.personalFiles),
          // 整理之前判素材"回的是什么"：找前文、记结果、前文是卡片时取卡片的纯文本降级
          replyContext: { store, judged: () => materials.replyJudged(), cardText: (cardId) => ctx.use(KERNEL.cards).get(cardId)?.text },
          // 整理之前让能由电脑拉的数据源各同步一次、等导完再读（内核的数据源服务；没有就不同步）
          sourceSync: { sync: () => ctx.optional(KERNEL.dataSourceSync) },
          log,
        });
        nightly = job;
        // 作业随插件停用撤销（取消计时器，不再排下一次）
        ctx.effect(() => ctx.internalJobs.register(job.job));
        // 停用（运行中或守护进程停止）：正在等推后的那一次马上停；rg.db 不关不删
        ctx.lifecycle({
          stop: async () => {
            job.abort();
            await job.whenIdle();
          },
        });
      }
    }

    // 体检（412，memory/doctor.ts）：向量索引、推理库、记忆系统（槽里在跑的那一套）、记忆简报、每晚整理、整理前导入数据源六项，
    // 都只读内存、文件和事件日志（不开推理库、不联网、不调模型）；经 ctx 登记，插件停用时跟着撤、体检页上记忆那一块就没了。
    // 记忆系统那一项要记忆插件槽：没接上（只有插件的测试）就不登记
    for (const check of memoryDoctorChecks({
      vectors: () => materials.vectorStatus(),
      graph: () => {
        const issue = engineProvider.issue();
        const bytes = rgDbBytes(layout.rgDb);
        return {
          enabled: config.memory.enabled,
          opened: engineProvider.opened,
          ...(setupIssue === undefined ? {} : { setupIssue }),
          ...(issue === undefined ? {} : { engineIssue: issue }),
          ...(bytes === undefined ? {} : { bytes }),
        };
      },
      ...(memorySlot === undefined ? {} : { system: { info: () => memorySlot.info(), health: () => memorySlot.health() } }),
      briefEnabled,
      briefStats: () => briefs.stats(),
      enabled: () => config.memory.enabled,
      store,
      now: () => clock.now(),
    })) {
      ctx.doctor.register(check);
    }

    // 把每晚整理露给记忆管理员（内核那个按需拉起的 agent）——立即整理一次（同一份 runNow）、
    // 以及"03:00 交给它来跑"的委派。整理关着、推理库用不了时也提供（blocked 写明原因），管理员照旧能解释已有的结论
    ctx.provide<MemoryNightlyService>(MEMORY_NIGHTLY, {
      blocked: () => nightlyBlocked,
      runNow: () => (nightly === undefined ? Promise.resolve(undefined) : nightly.runNow()),
      wakeWith: (wake) => nightly?.wakeWith(wake) ?? (() => {}),
    });

    // 了解你访谈（interview.ts）：记录和发起。每周六 10:00 看一眼该不该约（约访开着、没在聊、离上次够久），
    // 秘书开访谈的快速动作；服务给记忆管理员（访谈工具）、组合根（访谈里的话标编号）、网关（GET / POST /api/memory/interview）
    const interviews = createMemoryInterviews({
      store,
      cards: ctx.use(KERNEL.cards),
      inbox,
      clock,
      materials,
      settings: () => ctx.optional(KERNEL.memorySettings),
      // 访谈里听到的档案信息按快速动作 personal_file 校验、确认时经它写进档案（内核登记的执行器）
      quickActions,
      log,
    });
    ctx.effect(() => ctx.internalJobs.register(interviews.job));
    ctx.quickActions.register(startInterviewAction(() => interviews));
    ctx.provide(MEMORY_INTERVIEWS, interviews);

    // 个人档案的字段换了新值，事实图谱里旧值的事实马上到期（依赖的结论转待复核，经唯一写入口；每晚整理时再对一遍）。
    // 档案在内核、建在插件之后，订阅经组合根转交
    const personalFiles = ctx.optional(KERNEL.personalFiles);
    if (personalFiles !== undefined) {
      const expire = createProfileFactExpiry({ withEngine: createWritableEngineUse({ file: layout.rgDb, clock: () => clockIso(clock), model: DEEPSEEK_DEFAULT_MODEL, embedder, log }), log });
      ctx.effect(() => personalFiles.onFieldReplaced((change) => expire(change)));
    }

    // 彻底删除、忘掉、别推断、敏感类别登记进推理库：跟着记忆命令走，引擎随用随开；
    // 启动时把历史命令和敏感类别对一遍（插件停用期间下的命令、已经进库的健康证据都补上；数据源素材的证据照当前设置重读一遍）
    const reasoningPurge = createReasoningPurge({ file: layout.rgDb, store, clock, config: config.memory, materials, embedder, log });
    ctx.effect(() => reasoningPurge.start());
    reasoningPurge.reconcile();

    // 手动整理一次：用户（演示、验收）不用等到 03:00。它是快速动作，不是工具——模型只能在"提议快速动作"里提一句，
    // 总要用户核对后执行（confirm: "always"），默认不会被模型随便调用；跑的是上面同一份作业、同一份预算、同一条整理记录。
    const runNow = (): Promise<MemoryNightlyRecord | undefined> => {
      if (nightly === undefined) throw new Error("记忆整理没在跑"); // @i18n-ignore log：这里到不了（blocked 先拦下）
      return nightly.runNow();
    };
    ctx.quickActions.register(memoryNightlyAction({ run: runNow, blocked: () => nightlyBlocked }));
  },
};
