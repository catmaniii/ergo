// 本项目的规范改写（261 号票；issue 19 Decisions 第 5 条，照立项要求变更那套：charter-change.ts）：用户在会话里说这个项目不要规范里的
// 某一份（"不用画架构图"）、某一份换一种写法（"进展按周写"）、多一份文档、恢复照默认规范，或者要跟新版规范，项目的维护者用
// propose_standard_change 提出——只交要改的几处，附上它引用的用户消息 id（运行时核实，conversation/user-words.ts）。运行时出一张
// "规范改写"卡（standard_change）：
// - 卡上逐处对照（同一份改写前后：照默认 → 不要、换写法 → 另一种写法、不要 → 恢复照默认……），跟新版规范写明从哪一版到哪一版，附运行时
//   核实过的用户原话；进待办（不卡任务），也出在用户说话的那个会话里；同一个项目一次只有一张在等；
// - 用户确认：standards 频道上一条 standard_change_decided（confirmed），从此按改过的规范算（projects/views.ts 的 standardOverrides：
//   只读接口、项目页、检查清单、守护进程补文档都按它）；同一事务项目列表频道上一条 standard_changed（跟新版规范的，项目上记着的版本换成新的；
//   之后项目模块按新版模板补上缺的文档，已有的不动）；项目档案里的 standard-overrides.md 重写（现在生效的每一条，末尾记一条变更记录：
//   哪天、改了什么、依据的用户原话、用户确认）；维护者收到通知，时间线上记一笔；
// - 用户拒绝（可附说明）：规范不变，维护者收到通知，时间线上记一笔。
// 模板出了新版不自动带旧项目（只读接口里 latest 比项目记着的新，项目页提示"有新版规范"），要跟也走这条路。规范上线之前建的项目没有版本：
// 先由补齐文档的卡（262 号票）问一次；272 号票起这里也放开——卡上选了不补、之后用户又要补，维护者照样提"跟新版"（upgrade），卡上写明是
// 补齐规范文档、缺哪几份；确认后照 262 的补齐做：项目列表频道上一条 standard_adopted（记下版本，项目模块从模板放进缺的几份，已有的不动），
// 再建一个项目内部的普通任务交给维护者照项目现状写好（确认时又都齐了就不建）。补齐卡还在等用户选时不让提（两张卡都能补齐，免得重了）。
// 立项书确认之前没有这个工具（项目类型没定，规范里有哪几份还没定）。
// 运行时不删档案里已有的文件（"不要架构图"只是不再要求、不再从模板补回来），多出来的那份由维护者建。
import path from "node:path";
import {
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type Project,
  PROJECT_KIND_LABEL,
  type ProjectEventPayload,
  type ProjectStandardView,
  PURGED_TEXT,
  refusedUserWordsText,
  STANDARD_DOC_LABEL,
  STANDARD_DOCS,
  STANDARD_OVERRIDABLE_DOCS,
  STANDARD_UNDROPPABLE_DOCS,
  standardBackfillDocs,
  standardBackfillDocText,
  type StandardChangeCardPayload,
  StandardChangeCardPayload as StandardChangeCardSchema,
  type StandardChangeItem,
  standardChangeItemText,
  type StandardDocKey,
  standardDocsOf,
  type StandardOverride,
  type StandardOverridableDoc,
  type StandardOverrideEntry,
  standardOverrideTarget,
  type StandardUpgrade,
  standardUpgradeText,
  sameStandardOverride,
  bareStandardOverride,
  Type,
  USER_WORDS_TITLE,
  userWordsLine,
  type VerifiedUserWords,
  t,
} from "@ergo/protocol";
import { defineHostTool, type HostTool } from "../agent-manager/host-tools.ts";
import type { CardService } from "../cards/cards.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { buildAgentNotice, buildTimelineRecord } from "../conversation/messages.ts";
import { cardRefsElsewhere, NO_USER_WORDS, USER_WORDS_PARAM, type UserWordsCheck, type UserWordsDeps, verifyUserWords } from "../conversation/user-words.ts";
import { inModelLanguage } from "../guard/index.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { purgedField, type PurgeRewriter } from "../events/purge.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { type MaterialSource, userDecisionDraft } from "../materials/index.ts";
import { oneLine } from "../util/text.ts";
import { STANDARD_EVENTS, type StandardChangeDecidedPayload, type StandardChangeProposedPayload, STANDARDS_CHANNEL } from "./events.ts";
import { type ProjectRecordsPaths, type StandardChangeRecord, standardOverridesMarkdown, writeStandardOverrides } from "./records.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { backfillTaskSummary } from "./standard-backfill.ts";
import { latestStandardVersion, standardTemplates, type StandardTemplates } from "./standard.ts";
import { PROPOSE_STANDARD_CHANGE_TOOL } from "./tool-names.ts";
import { getProjectRow, listProjects, standardChanges, standardOverrides } from "./views.ts";

export interface StandardChangesOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  /** 项目档案的位置 */
  records(projectId: string): ProjectRecordsPaths;
  /** 核实维护者引用的用户原话；不给就不核实（引用的一律当没核实过） */
  userWords?: UserWordsDeps;
  /** 规范模板（不给是框架里的）：跟新版规范跟到里面最新的那一版 */
  templates?: StandardTemplates;
  /**
   * 272 号票：规范上线之前建的项目补齐规范文档——项目规范现在的样子（只读接口那一份，算缺哪几份）、建补齐任务、
   * 这个项目的"补齐规范文档"卡是不是还在等用户选（还在等就不让另提）。不给就不算缺的、不建任务、不查卡
   */
  standard?: (projectId: string) => ProjectStandardView | undefined;
  tasks?: Pick<TaskService, "buildInternal">;
  backfillPending?: (projectId: string) => boolean;
  now: () => string;
  log: (line: string) => void;
}

export interface StandardChanges {
  /** 项目维护者的"提规范改写"工具（立项书确认之后才给） */
  tool(projectId: string, maintainerId: string): HostTool;
  /** "规范改写"卡上的确认、拒绝（卡片动作，和卡片更新同一事务） */
  decide(payload: StandardChangeCardPayload, confirmed: boolean, note: string | undefined, idempotencyKey: string): CardActionEffect<StandardChangeCardPayload>;
  /** 开始：确认了的规范改写写进项目档案的 standard-overrides.md（事件追加之后；启动时把有改写的项目再对一遍，不一样才写） */
  start(): void;
  stop(): void;
}

/** 维护者交上来的改法（工具的参数，去掉了为什么和原话） */
interface StandardDraft {
  drop?: readonly string[];
  change?: ReadonlyArray<{ doc: string; how: string }>;
  add?: ReadonlyArray<{ path: string; title: string; what: string }>;
  restore?: readonly string[];
  upgrade?: boolean;
}

/**
 * 项目列表频道上一条"规范改了"（standard_changed）：项目本身更新时间变，跟新版规范的版本换成新的。
 * 没有版本的项目补齐规范文档（272 号票）是 standard_adopted（同 262 号票的补齐：项目模块据此从模板放进缺的几份）
 */
const projectChanged = (project: Project, time: string, upgrade: StandardUpgrade | undefined): NewEvent => {
  const payload: ProjectEventPayload = {
    project: { ...project, updatedAt: time, ...(upgrade ? { standardVersion: upgrade.to } : {}) },
    change: upgrade && upgrade.from === undefined ? "standard_adopted" : "standard_changed",
    from: project.state,
    by: "user",
  };
  return { channel: CHANNELS.projects, type: EVENT_TYPES.project, payload };
};

/** 卡的纯文本降级、交给维护者的通知、时间线说明里的改动（一处一行；跟新版规范在最前） */
const changeLines = (p: { items: readonly StandardChangeItem[]; upgrade?: StandardUpgrade | undefined }) => [
  ...(p.upgrade ? [`- ${standardUpgradeText(p.upgrade)}`] : []),
  ...p.items.map((item) => `- ${standardChangeItemText(item)}`),
];

/** 依据的用户原话（运行时核实过的）的几行（给用户看：生成时按当时的语言） */
const wordsLines = (words: readonly VerifiedUserWords[]) => (words.length > 0 ? [t("projects.standardChange.words", { title: USER_WORDS_TITLE }), ...words.map((w) => `- ${userWordsLine(w)}`)] : []);

/** 规范里的一份叫什么、多出来的那份写位置（给维护者的拒绝原因里） */
const docName = (doc: StandardDocKey) => inModelLanguage(() => STANDARD_DOC_LABEL[doc]);

/** 多出来的那份在档案里的位置：相对档案、正斜杠、目录以 / 结尾；不合规矩的（绝对路径、..、空的段、Windows 不让用的字）是 undefined */
export function normalizedRecordPath(raw: string): string | undefined {
  const s = raw.trim().replace(/\\/g, "/");
  if (!s || s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return undefined;
  const dir = s.endsWith("/");
  const segments = (dir ? s.slice(0, -1) : s).split("/");
  // oxlint-disable-next-line no-control-regex -- 控制字符不能进文件名
  if (segments.some((x) => x === "" || x === "." || x === ".." || /[<>:"|?*\u0000-\u001f]/.test(x) || /[. ]$/.test(x))) return undefined;
  return segments.join("/") + (dir ? "/" : "");
}

/** 档案里已有的位置（规范里的文档、立项书、绑定关系、规范改写、工作目录、历史区……）：多出来的那份不能放在这些位置上、里面或者把它们包进去 */
function reservedPlace(paths: ProjectRecordsPaths, rel: string): boolean {
  const mine = rel.replace(/\/$/, "").toLowerCase();
  return Object.entries(paths).some(([key, abs]) => {
    if (key === "root") return false;
    const taken = path.relative(paths.root, abs).split(path.sep).join("/").toLowerCase();
    return taken === mine || mine.startsWith(`${taken}/`) || taken.startsWith(`${mine}/`);
  });
}

/**
 * 维护者的工具说明。里面引了协议包的标签（文档的名字），那些跟着当前语言：给模型看的这份在中文下现取（173 号票）
 */
// @i18n-ignore-start model：工具说明、参数说明给维护者看
const toolDescription = () =>
  "用户在会话里说这个项目的规范要改时用（立项书确认之后）：这个项目不要规范里的某一份（drop，比如不画架构图；进展不能不要）、" +
  "某一份照样要但换一种写法（change，比如进展按周写）、多一份文档（add，写位置、名字、写什么；算必须有的，会检查）、" +
  "去掉以前的改写恢复照默认规范（restore），或者跟到框架里新版的规范（upgrade：项目用的版本比最新的旧时；规范上线之前建的、没有记版本的项目" +
  "写 upgrade 就是补齐规范文档——用户确认后改用最新的规范、缺的从模板放进档案，再建一个“补齐规范文档”的任务交给你照项目现状写好）。只交要改的几处，" +
  "把用户那句话的消息 id（用户消息末尾“[用户消息 id：…]”里的）写进 userWords。运行时出一张“规范改写”卡，逐处对照、附运行时核实过的用户原话，" +
  "进用户的待办，也出在用户说话的那个会话里；用户确认后才生效（运行时记进项目档案的 standard-overrides.md，跟新版的缺的文档从新版模板补上），" +
  "拒绝的不变。告诉用户“卡在这里，点确认就生效”。不要自己删规范里的文档、也不要自己改 standard-overrides.md（改了不算数）。";

const docParam = () => Type.Enum(STANDARD_OVERRIDABLE_DOCS, { description: "规范里的哪一份：spec 规格、architecture 架构图、progress 进展、adr 决策记录、tickets 票、ops 运营接口清单" });

const proposeParams = () =>
  Type.Object(
    {
      drop: Type.Optional(Type.Array(docParam(), { minItems: 1, maxItems: STANDARD_OVERRIDABLE_DOCS.length, description: "这个项目不要的几份（进展不能不要）；不改就不写" })),
      change: Type.Optional(
        Type.Array(Type.Object({ doc: docParam(), how: Type.String({ minLength: 1, maxLength: 500, description: "换成怎么写（一两句）" }) }, { additionalProperties: false }), {
          minItems: 1,
          maxItems: STANDARD_OVERRIDABLE_DOCS.length,
          description: "照样要、换一种写法的几份；不改就不写",
        }),
      ),
      add: Type.Optional(
        Type.Array(
          Type.Object(
            {
              path: Type.String({ minLength: 1, maxLength: 120, description: "在项目档案里的位置：相对档案写、用正斜杠，目录以 / 结尾（比如 runbook.md、recipes/）" }),
              title: Type.String({ minLength: 1, maxLength: 40, description: "这份叫什么（比如 运维手册）" }),
              what: Type.String({ minLength: 1, maxLength: 500, description: "这份写什么、什么时候更新" }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 10, description: "多出来的几份（算必须有的，会检查）；不加就不写" },
        ),
      ),
      restore: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 16, description: "恢复照默认规范：去掉对这几份的改写（规范里的写名字，比如 architecture；多出来的写它的位置）；不恢复就不写" }),
      ),
      upgrade: Type.Optional(
        Type.Boolean({ description: "true：跟到框架里最新的规范版本（缺的文档从新版模板补上，已有的不动）；项目用的版本比最新的旧时写，规范上线之前建的、没有记版本的项目要补齐规范文档时也写" }),
      ),
      why: Type.String({ minLength: 1, maxLength: 2000, description: "为什么要改（用户在卡上看得到）" }),
      // @i18n-ignore-end
      userWords: Type.Optional(USER_WORDS_PARAM),
    },
    { additionalProperties: false },
  );

export function createStandardChanges(options: StandardChangesOptions): StandardChanges {
  const { store, cards, inbox, now, log } = options;
  const templates = () => options.templates ?? standardTemplates();
  let unsubscribe: (() => void) | undefined;

  const projectOf = (projectId: string): Project => {
    const row = getProjectRow(store.reader, projectId);
    if (!row || row.deleted) throw new RequestRejected("not_found", t("projects.standardChange.noProject", { id: projectId }));
    return row.project;
  };

  /** 现在生效的改写（不带第几次、为什么） */
  const currentOverrides = (projectId: string): StandardOverrideEntry[] => standardOverrides(store.reader, projectId);

  /** 用户确认了的每一次（standard-overrides.md 末尾的变更记录） */
  const confirmedRecords = (projectId: string): StandardChangeRecord[] =>
    standardChanges(store.reader, projectId).flatMap(({ proposed, decided }) =>
      decided?.confirmed
        ? [{ revision: proposed.revision, items: decided.items, upgrade: decided.upgrade, userWords: decided.userWords, why: decided.why, proposedAt: proposed.time, confirmedAt: decided.time, note: decided.note }]
        : [],
    );

  /** 确认了的规范改写写进项目档案：standard-overrides.md 不一样才重写（旧的先留进历史区） */
  const writeOverrides = (projectId: string) => {
    const row = getProjectRow(store.reader, projectId);
    if (!row || row.deleted) return;
    const changes = confirmedRecords(projectId);
    if (changes.length === 0) return;
    try {
      const text = standardOverridesMarkdown(row.project, row.project.standardVersion, currentOverrides(projectId), changes);
      writeStandardOverrides(options.records(projectId), text, changes.at(-1)!.confirmedAt);
    } catch (err) {
      log(`把项目 ${projectId} 的规范改写写进项目档案时出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 还在等用户的那张（同一个项目一次只有一张） */
  const pendingOf = (projectId: string) => standardChanges(store.reader, projectId).find((c) => !c.decided && cards.get(c.proposed.cardId)?.status === "pending");

  /** 维护者交上来的改法算成逐处的变化（同一份改写前后）和跟新版规范；不合规矩的抛 RequestRejected（原因交回维护者） */
  const itemsOf = (project: Project, draft: StandardDraft): { items: StandardChangeItem[]; upgrade?: StandardUpgrade } => {
    const paths = options.records(project.id);
    const current = currentOverrides(project.id);
    const currentOf = (target: string) => {
      const found = current.find((e) => standardOverrideTarget(e) === target);
      return found && bareStandardOverride(found);
    };
    /** 这类项目规范里有、能改写的几份 */
    const own = new Set<string>(standardDocsOf(project.kind).map((d) => d.key));
    const kindLabel = inModelLanguage(() => PROJECT_KIND_LABEL[project.kind ?? "other"]);
    const items: StandardChangeItem[] = [];
    const touched = new Set<string>();
    // @i18n-ignore-start model：提的时候的拒绝原因交回维护者（工具结果）
    const take = (after: StandardOverride | undefined, target: string, label: string, restoring = false) => {
      if (touched.has(target)) throw new RequestRejected("bad_params", `同一份只能改一处：${label}`);
      touched.add(target);
      const before = currentOf(target);
      if (restoring && !before) throw new RequestRejected("not_allowed", `${label}现在没有改写，不用恢复`);
      if (sameStandardOverride(before, after)) return;
      items.push({ ...(before ? { before } : {}), ...(after ? { after } : {}) });
    };
    const docOf = (doc: string): StandardOverridableDoc => {
      if (!(STANDARD_OVERRIDABLE_DOCS as readonly string[]).includes(doc)) throw new RequestRejected("bad_params", `规范里没有「${doc}」这一份（能改写的是 ${STANDARD_OVERRIDABLE_DOCS.join("、")}）`);
      if (!own.has(doc)) throw new RequestRejected("not_allowed", `${kindLabel}项目的规范里本来就没有${docName(doc as StandardDocKey)}`);
      return doc as StandardOverridableDoc;
    };
    for (const raw of draft.drop ?? []) {
      const doc = docOf(raw);
      if (STANDARD_UNDROPPABLE_DOCS.includes(doc)) throw new RequestRejected("not_allowed", `${docName(doc)}不能不要：每段工作结束都要写回进展，运行时靠它判断写回了没有；要换写法用 change`);
      take({ kind: "drop", doc }, `doc:${doc}`, docName(doc));
    }
    for (const c of draft.change ?? []) {
      const doc = docOf(c.doc);
      take({ kind: "change", doc, note: c.how.trim() }, `doc:${doc}`, docName(doc));
    }
    for (const a of draft.add ?? []) {
      const rel = normalizedRecordPath(a.path);
      if (rel === undefined) throw new RequestRejected("bad_params", `多出来的那份的位置不对：「${a.path}」（相对项目档案写、用正斜杠，不能是绝对路径、不能有 ..）`);
      if (reservedPlace(paths, rel)) throw new RequestRejected("not_allowed", `「${rel}」是项目档案里已有的位置（规范里的文档、立项书、规范改写、工作目录、历史区……），换一个`);
      take({ kind: "add", path: rel, title: a.title.trim(), note: a.what.trim() }, `path:${rel}`, `「${a.title.trim()}」（${rel}）`);
    }
    for (const raw of draft.restore ?? []) {
      const name = raw.trim();
      if ((STANDARD_DOCS as readonly string[]).includes(name)) {
        take(undefined, `doc:${name}`, docName(name as StandardDocKey), true);
        continue;
      }
      const rel = normalizedRecordPath(name);
      take(undefined, `path:${rel ?? name}`, `「${name}」`, true);
    }
    let upgrade: StandardUpgrade | undefined;
    if (draft.upgrade === true) {
      const latest = latestStandardVersion(templates());
      if (project.standardVersion === undefined) {
        // 272 号票：规范上线之前建的（没有版本）——补齐规范文档。补齐卡还在等用户选时不另提
        if (options.backfillPending?.(project.id) === true) {
          throw new RequestRejected("not_allowed", `项目「${project.name}」补齐规范文档的卡还在等用户选（补齐还是不补），让用户在那张卡上选；选了不补以后用户又要补，再这样提`);
        }
        const view = options.standard?.(project.id);
        const missing = view ? standardBackfillDocs(view) : [];
        upgrade = { to: latest, ...(missing.length > 0 ? { missing } : {}) };
      } else {
        if (project.standardVersion === latest) throw new RequestRejected("not_allowed", `项目「${project.name}」用的已经是最新的规范 ${latest}`);
        upgrade = { from: project.standardVersion, to: latest };
      }
    }
    if (items.length === 0 && !upgrade) throw new RequestRejected("not_allowed", "和现在的规范一样，没有要改的");
    // @i18n-ignore-end
    return { items, ...(upgrade ? { upgrade } : {}) };
  };

  const propose = (projectId: string, maintainerId: string, draft: StandardDraft, why: string, cited: readonly string[] | undefined) => {
    const project = projectOf(projectId);
    // @i18n-ignore-start model：提的时候的拒绝原因交回维护者（工具结果）
    if (project.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", `项目 ${projectId} 不是你维护的`);
    if (project.state === "archived") throw new RequestRejected("not_allowed", `项目「${project.name}」已归档，规范不能再改`);
    if (!project.charterConfirmed) throw new RequestRejected("not_allowed", `项目「${project.name}」的立项书还没确认：项目类型定了，规范里有哪几份才定下来`);
    const waiting = pendingOf(projectId);
    if (waiting) throw new RequestRejected("not_allowed", `上一张规范改写卡（第 ${waiting.proposed.revision} 次）还在等用户，先等它有结论`);
    // @i18n-ignore-end
    const { items, upgrade } = itemsOf(project, draft);
    const words: UserWordsCheck =
      !cited || cited.length === 0
        ? NO_USER_WORDS
        : options.userWords
          ? verifyUserWords(options.userWords, cited, maintainerChannel(maintainerId))
          : { verified: [], refused: cited.map((id) => ({ id, reason: "这个版本还不能核实用户原话" })) }; // @i18n-ignore model
    const revision = standardChanges(store.reader, projectId).length + 1;
    const payload: StandardChangeCardPayload = {
      projectId,
      projectName: project.name,
      revision,
      why,
      items,
      ...(upgrade ? { upgrade } : {}),
      ...(words.verified.length > 0 ? { userWords: words.verified } : {}),
    };
    const card = cards.buildCreate({ type: "standard_change", urgency: "non_blocking", payload });
    const item = inbox.buildAdd({
      kind: "card",
      cardId: card.card.id,
      title: oneLine(t("projects.standardChange.inboxTitle", { name: project.name }), 60),
      source: t("projects.source.project", { name: project.name }),
      origin: { projectId },
      urgency: "non_blocking",
    });
    const proposed: StandardChangeProposedPayload = { projectId, revision, cardId: card.card.id, maintainerId, why, items, ...(upgrade ? { upgrade } : {}), userWords: words.verified, time: now() };
    store.appendBatch([
      { channel: STANDARDS_CHANNEL, type: STANDARD_EVENTS.changeProposed, payload: proposed },
      card.event,
      item.event,
      // 卡也出在用户说那句话的会话里（维护者自己的会话里本来就有：工具产生的卡片）
      ...cardRefsElsewhere(card.card.id, words.verified, maintainerChannel(maintainerId)),
    ]);
    inbox.alert(item.item);
    return { cardId: card.card.id, revision, items, upgrade, words };
  };

  const decide: StandardChanges["decide"] = (payload, confirmed, note, idempotencyKey) => {
    const project = projectOf(payload.projectId);
    const row = standardChanges(store.reader, project.id).find((c) => c.proposed.revision === payload.revision);
    if (!row) throw new RequestRejected("not_found", t("projects.standardChange.noChange", { revision: payload.revision }));
    if (row.decided) throw new RequestRejected("conflict", t("projects.standardChange.decided"));
    // 卡出来之后规范又改过了（不该发生：一次只有一张在等）
    if (confirmed) {
      const current = currentOverrides(project.id);
      const stale =
        row.proposed.items.some((item) => {
          const target = standardOverrideTarget((item.after ?? item.before)!);
          return !sameStandardOverride(item.before, current.find((e) => standardOverrideTarget(e) === target));
        }) ||
        (row.proposed.upgrade !== undefined && row.proposed.upgrade.from !== project.standardVersion);
      if (stale) throw new RequestRejected("conflict", t("projects.standardChange.stale"));
    }
    const comment = note?.trim() || undefined;
    const time = now();
    // 272 号票：规范上线之前建的项目补齐规范文档，确认后照 262 号票的补齐做——按现在的样子再算一遍缺哪几份（卡出来之后维护者可能已经补了），
    // 缺的建一个项目内部的普通任务交给维护者照项目现状写好
    const adopting = confirmed && row.proposed.upgrade !== undefined && row.proposed.upgrade.from === undefined;
    if (adopting && project.state === "archived") throw new RequestRejected("not_allowed", t("projects.standardBackfill.archived", { name: project.name }));
    const view = adopting ? options.standard?.(project.id) : undefined;
    const missing = adopting ? (view ? standardBackfillDocs(view) : (row.proposed.upgrade?.missing ?? [])) : [];
    const task =
      adopting && missing.length > 0 && options.tasks
        ? options.tasks.buildInternal(
            {
              projectId: project.id,
              title: t("projects.standardBackfill.taskTitle"),
              summary: backfillTaskSummary(project, project.kind ?? "other", row.proposed.upgrade!.to, missing, view, comment),
              kind: "plain",
              origin: "suggestion",
            },
            "user",
          )
        : undefined;
    const decided: StandardChangeDecidedPayload = {
      projectId: project.id,
      projectName: project.name,
      revision: payload.revision,
      cardId: row.proposed.cardId,
      confirmed,
      why: row.proposed.why,
      items: row.proposed.items,
      ...(row.proposed.upgrade ? { upgrade: row.proposed.upgrade } : {}),
      userWords: row.proposed.userWords,
      proposedAt: row.proposed.time,
      ...(comment ? { note: comment } : {}),
      by: "user",
      time,
    };
    const conversation = maintainerChannel(project.maintainerId);
    const scope = { projectId: project.id };
    const changeText = changeLines(row.proposed);
    const added = row.proposed.items.flatMap((item) => (item.after?.kind === "add" && !item.before ? [item.after.path] : []));
    // @i18n-ignore-start model：交给维护者的通知
    const notice = confirmed
      ? [
          `用户确认了规范改写（第 ${payload.revision} 次），从现在起这个项目按改过的规范做（项目档案里的 standard-overrides.md 记着现在生效的每一条和这次变更）：`,
          ...changeText,
          ...(row.proposed.upgrade
            ? [
                adopting
                  ? `项目改用规范 ${row.proposed.upgrade.to}（补齐规范文档）：缺的几份从模板放进项目档案了，已有的没动。${task ? `建了任务 ${task.task.id}「${task.task.title}」交给你照项目现状写好：${missing.map((doc) => inModelLanguage(() => standardBackfillDocText(doc))).join("、")}。` : "文档都齐了，没建任务。"}`
                  : `项目改用规范 ${row.proposed.upgrade.to}：缺的文档从新版模板补上，已有的没动。`,
              ]
            : []),
          ...(added.length > 0 ? [`多出来的几份由你建好、写上内容：${added.join("、")}。`] : []),
          ...(comment ? [`用户说：「${comment}」`] : []),
        ].join("\n")
      : [`用户拒绝了规范改写（第 ${payload.revision} 次）${comment ? `：「${comment}」` : ""}。规范不变，照现在的规范做。`, ...changeText].join("\n");
    // @i18n-ignore-end
    const summary = confirmed
      ? t("projects.standardChange.confirmedSummary", { revision: payload.revision, why: row.proposed.why })
      : t("projects.standardChange.rejectedSummary", { revision: payload.revision });
    const events: NewEvent[] = [
      { channel: STANDARDS_CHANNEL, type: STANDARD_EVENTS.changeDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` },
      // 确认的：项目列表上记一笔"规范改了"（跟新版规范的版本换成新的；项目模块据此按新版模板补缺的文档）
      ...(confirmed ? [projectChanged(project, time, row.proposed.upgrade)] : []),
      // 补齐的任务建在项目改用规范之后：维护者开工时模板已经在档案里了（同 262 号票）
      ...(task?.events ?? []),
      buildTimelineRecord(conversation, { kind: "standard_change", summary, detail: [...changeText, ...wordsLines(row.proposed.userWords)].join("\n") }, scope).event,
      buildAgentNotice(conversation, notice, `${idempotencyKey}#notice`, scope).event,
    ];
    return {
      status: "handled",
      payload: { ...payload, decided: { confirmed, at: time } },
      ...(comment ? { note: comment } : {}),
      events,
    };
  };

  return {
    tool: (projectId, maintainerId) =>
      defineHostTool({
        name: PROPOSE_STANDARD_CHANGE_TOOL,
        title: t("projects.tools.proposeStandardChange"),
        description: inModelLanguage(toolDescription),
        parameters: inModelLanguage(proposeParams),
        readOnlyOrIdempotent: false,
        run: ({ drop, change, add, restore, upgrade, why, userWords }) => {
          const draft: StandardDraft = {
            ...(drop === undefined ? {} : { drop }),
            ...(change === undefined ? {} : { change }),
            ...(add === undefined ? {} : { add }),
            ...(restore === undefined ? {} : { restore }),
            ...(upgrade === undefined ? {} : { upgrade }),
          };
          try {
            const r = propose(projectId, maintainerId, draft, why.trim(), userWords);
            // @i18n-ignore-start model：工具结果
            const taken = r.words.verified.length > 0 ? `你引用的 ${r.words.verified.length} 条用户原话运行时核实过了，已写进卡上的"${inModelLanguage(() => USER_WORDS_TITLE)}"一栏。` : "";
            return {
              text: [
                `规范改写卡（第 ${r.revision} 次）已放进用户的待办，也出在用户说话的会话里；用户确认后才生效，拒绝的不变。告诉用户：卡在这里，点确认就生效。`,
                taken,
                refusedUserWordsText(r.words.refused),
                "改动：",
                // @i18n-ignore-end
                ...inModelLanguage(() => changeLines(r)),
              ]
                .filter(Boolean)
                .join("\n"),
              cardIds: [r.cardId],
            };
          } catch (err) {
            if (err instanceof RequestRejected) return { text: err.message, isError: true };
            throw err;
          }
        },
      }),
    decide,
    start() {
      // 确认了的规范改写追加之后写进档案；之前追加了、没来得及写的（守护进程被杀）启动时再对一遍（不一样才写）
      unsubscribe = store.onAppend((event) => {
        if (event.channel !== STANDARDS_CHANNEL || event.type !== STANDARD_EVENTS.changeDecided) return;
        const p = event.payload as StandardChangeDecidedPayload;
        if (p.confirmed) writeOverrides(p.projectId);
      });
      for (const project of listProjects(store.reader)) writeOverrides(project.id);
    },
    stop() {
      unsubscribe?.();
    },
  };
}

/** "规范改写"卡（261 号票）：确认（confirm）、拒绝（reject，可附说明） */
export function standardChangeCardType(changes: Pick<StandardChanges, "decide">) {
  return defineCardType({
    type: "standard_change",
    version: 1,
    payload: StandardChangeCardSchema,
    actions: {
      confirm: { input: undefined, run: ({ payload, note, idempotencyKey }) => changes.decide(payload, true, note, idempotencyKey) },
      reject: { input: undefined, run: ({ payload, note, idempotencyKey }) => changes.decide(payload, false, note, idempotencyKey) },
    },
    toText: (p) =>
      [
        t("projects.standardChange.cardText", {
          name: p.projectName,
          revision: p.revision,
          state: t(p.decided ? (p.decided.confirmed ? "projects.standardChange.stateConfirmed" : "projects.standardChange.stateRejected") : "projects.standardChange.stateWaiting"),
          why: p.why,
        }),
        ...changeLines(p),
        ...wordsLines(p.userWords ?? []),
      ].join("\n"),
    // 彻底删除、删除项目时：维护者的说明、改写里写的话（怎么写、写什么）、引用的原话换成删除标记，改了哪几份、确认结果不变
    purge: (p) => ({ ...p, why: PURGED_TEXT, items: p.items.map(purgedItem), ...(p.userWords ? { userWords: p.userWords.map(purgedWords) } : {}) }),
  });
}

const purgedOverride = (o: StandardOverride): StandardOverride => (o.kind === "drop" ? o : { ...o, note: PURGED_TEXT });

const purgedItem = (item: StandardChangeItem): StandardChangeItem => ({
  ...(item.before ? { before: purgedOverride(item.before) } : {}),
  ...(item.after ? { after: purgedOverride(item.after) } : {}),
});

const purgedWords = (w: VerifiedUserWords): VerifiedUserWords => ({ ...w, text: PURGED_TEXT });

/** 彻底删除、删除项目时 standards 频道上的规范改写：说明、改写里写的话换成删除标记，改了哪几份、确认结果不变 */
export const standardChangePurges: readonly PurgeRewriter[] = [
  {
    eventType: STANDARD_EVENTS.changeProposed,
    rewrite(event) {
      const p = event.payload as StandardChangeProposedPayload;
      return { ...p, why: PURGED_TEXT, items: p.items.map(purgedItem), userWords: p.userWords.map(purgedWords) } satisfies StandardChangeProposedPayload;
    },
  },
  {
    eventType: STANDARD_EVENTS.changeDecided,
    rewrite(event) {
      const p = event.payload as StandardChangeDecidedPayload;
      return { ...p, why: PURGED_TEXT, items: p.items.map(purgedItem), userWords: p.userWords.map(purgedWords), ...purgedField(p, "note") } satisfies StandardChangeDecidedPayload;
    },
  },
];

/** 用户在"规范改写"卡上确认、拒绝：审批决定（本人的选择），卡上写的话是本人打的字 */
export const standardChangeDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "standard-change-decision",
  eventType: STANDARD_EVENTS.changeDecided,
  capture(event) {
    const p = event.payload as StandardChangeDecidedPayload;
    const what = changeLines(p)
      .map((line) => line.replace(/^- /, ""))
      .join(t("projects.standardChange.sep"));
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        project: p.projectId,
        context: ["card:standard_change", `decision:${p.confirmed ? "confirmed" : "rejected"}`],
        ref: { recordId: `${p.projectId}-standard-change-${p.revision}`, cardId: p.cardId },
        accepted: { text: t(p.confirmed ? "projects.standardChange.materialConfirmed" : "projects.standardChange.materialRejected", { name: p.projectName, what }), field: "decision" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};
