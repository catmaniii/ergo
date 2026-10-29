// 立项要求变更（125 号票；方案"用户授权的效力"第 2 节第 3 条）：立项书确认之后，用户在会话里说要改立项要求（目标、范围、首版），
// 项目的维护者用 propose_charter_change 提出——只交改动的几处（照 121 号票：没写的照旧，写了的整项按写的算），附上它引用的用户
// 消息 id（运行时核实，conversation/user-words.ts）。运行时出一张"立项要求变更"卡（charter_change）：
// - 卡上逐条对照新旧（协议包 projects.ts 的 charterChangeItems），附运行时核实过的用户原话；进待办（不卡任务），也出在用户说话的
//   那个会话里（项目维护者的会话本来就有：工具产生的卡片；秘书转达来的出在秘书会话里）；同一个项目一次只有一张在等；
// - 用户确认：立项书改写——charters 频道上一条 charter_change_decided（confirmed），从此现在的立项书是改过的那份（currentCharter，
//   范围审视的对照物也按它）；项目档案里的 charter.md 重写，末尾记一条变更记录（哪天、改了什么、依据的用户原话、用户确认）；
//   维护者收到通知，时间线上记一笔；
// - 用户拒绝（可附说明）：立项书不变，维护者收到通知，时间线上记一笔。
// 决定运行时行为的那几项不走这条路（CHARTER_FIXED_NOTE）：工具包照旧走工具包变更卡，项目类型和工作目录照旧不能改——工具的参数里
// 根本没有它们。立项书确认之前没有这个工具可用（立项问答里照旧用 submit_charter 交整份立项书）。
import {
  CHANNELS,
  type Charter,
  CHARTER_FIELD_LABEL,
  CHARTER_FIXED_NOTE,
  CharterChangeCardPayload,
  type CharterDraft,
  charterChangeItems,
  charterChangeItemText,
  type CharterDecision,
  EVENT_TYPES,
  maintainerChannel,
  mergeCharterDraft,
  type Project,
  type ProjectEventPayload,
  PURGED_TEXT,
  projectToolkit,
  refusedUserWordsText,
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
import { CHARTER_EVENTS, type CharterChangeDecidedPayload, type CharterChangeProposedPayload, type CharterDecidedPayload, CHARTERS_CHANNEL } from "./events.ts";
import { purgedCharter } from "./material-sources.ts";
import { type CharterChangeRecord, charterMarkdown, type ProjectRecordsPaths, projectWorkdir, writeConfirmedCharter } from "./records.ts";
import { REQUEST_TOOLKIT_CHANGE_TOOL } from "../toolkit/tool-names.ts";
import { PROPOSE_CHARTER_CHANGE_TOOL, SUBMIT_CHARTER_TOOL } from "./tool-names.ts";
import { charterChanges, getProjectRow, latestCharter } from "./views.ts";

export interface CharterChangesOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  /** 项目档案的位置 */
  records(projectId: string): ProjectRecordsPaths;
  /** 核实维护者引用的用户原话；不给就不核实（引用的一律当没核实过） */
  userWords?: UserWordsDeps;
  now: () => string;
  log: (line: string) => void;
}

export interface CharterChanges {
  /** 项目维护者的"提立项要求变更"工具（立项书确认之后才给） */
  tool(projectId: string, maintainerId: string): HostTool;
  /** "立项要求变更"卡上的确认、拒绝（卡片动作，和卡片更新同一事务） */
  decide(payload: CharterChangeCardPayload, confirmed: boolean, note: string | undefined, idempotencyKey: string): CardActionEffect<CharterChangeCardPayload>;
  /** 项目现在的立项书（确认过的那份，加上用户确认了的立项要求变更）；立项书还没确认的没有 */
  current(projectId: string): Charter | undefined;
  /** 项目现在的立项书全文（charter.md 的样子，从事件算，不读文件）：范围审视的对照物；立项书还没确认的没有 */
  text(projectId: string): string | undefined;
  /** 开始：确认了的立项要求变更改写 charter.md（事件追加之后；启动时把有变更的项目再写一遍） */
  start(): void;
  stop(): void;
}

/** 项目列表频道上一条"立项书改了"（charter_changed）：项目本身只有更新时间变 */
const projectChanged = (project: Project, time: string): NewEvent => {
  const payload: ProjectEventPayload = { project: { ...project, updatedAt: time }, change: "charter_changed", from: project.state, by: "user" };
  return { channel: CHANNELS.projects, type: EVENT_TYPES.project, payload };
};

/** 卡的纯文本降级、交给维护者的通知、时间线说明里的改动（一条一行） */
const changeLines = (p: { changes: CharterChangeCardPayload["changes"] }) => p.changes.map((c) => `- ${charterChangeItemText(c)}`);

/** 依据的用户原话（运行时核实过的）的几行 */
// 卡片的纯文本降级、时间线上那一笔的详细说明给用户看（173 号票：生成时按当时的语言）
const wordsLines = (words: readonly VerifiedUserWords[]) => (words.length > 0 ? [t("projects.charterChange.words", { title: USER_WORDS_TITLE }), ...words.map((w) => `- ${userWordsLine(w)}`)] : []);

/**
 * 维护者的工具说明（工具名都插值）。里面引了协议包的标签（立项书各栏的名字、"不走这条路"的说明），那些跟着当前语言：
 * 给模型看的这份在中文下现取（173 号票：不在模块加载时取，那时只有启动时的语言）
 */
// @i18n-ignore-start model：工具说明、参数说明给维护者看
const toolDescription = () =>
  "立项书确认之后，用户在会话里说要改立项要求（目标、范围、首版）时用：只交改动的几项（没写的照旧；范围要改就写全新的整栏），" +
  "把用户那句话的消息 id（用户消息末尾“[用户消息 id：…]”里的）写进 userWords。运行时出一张“立项要求变更”卡，逐条对照新旧、附运行时核实过的用户原话，" +
  "进用户的待办，也出在用户说话的那个会话里；用户确认后立项书才改写（末尾记一条变更记录），拒绝的立项书不变。告诉用户“卡在这里，点确认就生效”。" +
  `${CHARTER_FIXED_NOTE.replace("工具包变更卡", `工具包变更卡（${REQUEST_TOOLKIT_CHANGE_TOOL}）`)}不要自己改项目档案里的 charter.md，也不要再用 ${SUBMIT_CHARTER_TOOL}。`;

const proposeParams = () =>
  Type.Object(
    {
      goal: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: `新的${CHARTER_FIELD_LABEL.goal}（不改就不写）` })),
      scope: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 30, description: "新的范围：整栏写全（做哪些、不做哪些，一条一句）；不改就不写" })),
      firstVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: `新的${CHARTER_FIELD_LABEL.firstVersion}要做到什么程度（不改就不写）` })),
      why: Type.String({ minLength: 1, maxLength: 2000, description: "为什么要改（用户在卡上看得到）" }),
      // @i18n-ignore-end
      userWords: Type.Optional(USER_WORDS_PARAM),
    },
    { additionalProperties: false },
  );

export function createCharterChanges(options: CharterChangesOptions): CharterChanges {
  const { store, cards, inbox, now, log } = options;
  let unsubscribe: (() => void) | undefined;

  const projectOf = (projectId: string): Project => {
    const row = getProjectRow(store.reader, projectId);
    if (!row || row.deleted) throw new RequestRejected("not_found", t("projects.charterChange.noProject", { id: projectId }));
    return row.project;
  };

  const current = (projectId: string): Charter | undefined => {
    const project = getProjectRow(store.reader, projectId)?.project;
    const confirmed = project?.charterConfirmed ? latestCharter(store.reader, projectId) : undefined;
    if (!confirmed) return undefined;
    const last = charterChanges(store.reader, projectId)
      .filter((c) => c.decided?.confirmed)
      .at(-1);
    return last?.decided?.after ?? confirmed.charter;
  };

  /** 立项书确认的那一条（确认并开工 / 只确认）：charter.md 开头写的"用户什么时候确认" */
  const decisionOf = (projectId: string): CharterDecidedPayload | undefined =>
    store
      .read(CHARTERS_CHANNEL)
      .filter((e) => e.type === CHARTER_EVENTS.decided && (e.payload as { projectId?: string }).projectId === projectId)
      .map((e) => e.payload as CharterDecidedPayload)
      .at(-1);

  /** 用户确认了的每一次立项要求变更（立项书末尾的变更记录） */
  const confirmedRecords = (projectId: string): CharterChangeRecord[] =>
    charterChanges(store.reader, projectId).flatMap(({ proposed, decided }) =>
      decided?.confirmed
        ? [{ revision: proposed.revision, changes: decided.changes, userWords: decided.userWords, why: decided.why, proposedAt: proposed.time, confirmedAt: decided.time, note: decided.note }]
        : [],
    );

  /** 现在的立项书全文和写进档案要的东西；立项书还没确认的没有 */
  const rendered = (projectId: string) => {
    const project = getProjectRow(store.reader, projectId)?.project;
    const charter = current(projectId);
    const decided = decisionOf(projectId);
    if (!project || !charter || !decided) return undefined;
    const paths = options.records(projectId);
    const confirmed: { decision: CharterDecision; at: string; workdir: string } = { decision: decided.decision, at: decided.time, workdir: projectWorkdir(paths, project) };
    return { project, charter, toolkit: projectToolkit(project), confirmed, changes: confirmedRecords(projectId), paths };
  };

  /** 确认了的立项要求变更写进项目档案：charter.md 整个重写（旧的先留进历史区），末尾是变更记录 */
  const writeCharter = (projectId: string) => {
    const r = rendered(projectId);
    if (!r || r.changes.length === 0) return;
    try {
      writeConfirmedCharter(r.paths, r.project, r.charter, r.toolkit, r.confirmed, r.changes);
    } catch (err) {
      log(`把项目 ${projectId} 改过的立项书写进项目档案时出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 还在等用户的那张（同一个项目一次只有一张） */
  const pendingOf = (projectId: string) => charterChanges(store.reader, projectId).find((c) => !c.decided && cards.get(c.proposed.cardId)?.status === "pending");

  const propose = (projectId: string, maintainerId: string, draft: CharterDraft, why: string, cited: readonly string[] | undefined) => {
    const project = projectOf(projectId);
    // @i18n-ignore-start model：提的时候的拒绝原因交回维护者（工具结果）
    if (project.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", `项目 ${projectId} 不是你维护的`);
    if (project.state === "archived") throw new RequestRejected("not_allowed", `项目「${project.name}」已归档，立项要求不能再改`);
    const before = current(projectId);
    if (!before) throw new RequestRejected("not_allowed", `项目「${project.name}」的立项书还没确认：立项问答里用 ${SUBMIT_CHARTER_TOOL} 交整份立项书`);
    const waiting = pendingOf(projectId);
    if (waiting) throw new RequestRejected("not_allowed", `上一张立项要求变更卡（第 ${waiting.proposed.revision} 次）还在等用户，先等它有结论`);
    const after = mergeCharterDraft(before, draft);
    if (after.scope.length === 0) throw new RequestRejected("bad_params", "范围至少留一条");
    const changes = charterChangeItems(before, after);
    if (changes.length === 0) throw new RequestRejected("not_allowed", "和现在的立项书一样，没有要改的（只能改目标、范围、首版）");
    // @i18n-ignore-end
    const words: UserWordsCheck =
      !cited || cited.length === 0
        ? NO_USER_WORDS
        : options.userWords
          ? verifyUserWords(options.userWords, cited, maintainerChannel(maintainerId))
          : { verified: [], refused: cited.map((id) => ({ id, reason: "这个版本还不能核实用户原话" })) }; // @i18n-ignore model
    const revision = charterChanges(store.reader, projectId).length + 1;
    const payload: CharterChangeCardPayload = {
      projectId,
      projectName: project.name,
      revision,
      why,
      changes,
      before,
      after,
      ...(words.verified.length > 0 ? { userWords: words.verified } : {}),
    };
    const card = cards.buildCreate({ type: "charter_change", urgency: "non_blocking", payload });
    const item = inbox.buildAdd({
      kind: "card",
      cardId: card.card.id,
      title: oneLine(t("projects.charterChange.inboxTitle", { name: project.name }), 60),
      source: t("projects.source.project", { name: project.name }),
      origin: { projectId },
      urgency: "non_blocking",
    });
    const proposed: CharterChangeProposedPayload = { projectId, revision, cardId: card.card.id, maintainerId, why, before, after, changes, userWords: words.verified, time: now() };
    store.appendBatch([
      { channel: CHARTERS_CHANNEL, type: CHARTER_EVENTS.changeProposed, payload: proposed },
      card.event,
      item.event,
      // 卡也出在用户说那句话的会话里（维护者自己的会话里本来就有：工具产生的卡片）
      ...cardRefsElsewhere(card.card.id, words.verified, maintainerChannel(maintainerId)),
    ]);
    inbox.alert(item.item);
    return { cardId: card.card.id, revision, changes, words };
  };

  const decide: CharterChanges["decide"] = (payload, confirmed, note, idempotencyKey) => {
    const project = projectOf(payload.projectId);
    const row = charterChanges(store.reader, project.id).find((c) => c.proposed.revision === payload.revision);
    if (!row) throw new RequestRejected("not_found", t("projects.charterChange.noChange", { revision: payload.revision }));
    if (row.decided) throw new RequestRejected("conflict", t("projects.charterChange.decided"));
    const present = current(project.id);
    // 卡出来之后立项书又改过了（不该发生：一次只有一张在等）
    if (confirmed && JSON.stringify(present) !== JSON.stringify(row.proposed.before)) throw new RequestRejected("conflict", t("projects.charterChange.stale"));
    const comment = note?.trim() || undefined;
    const time = now();
    const decided: CharterChangeDecidedPayload = {
      projectId: project.id,
      projectName: project.name,
      revision: payload.revision,
      cardId: row.proposed.cardId,
      confirmed,
      why: row.proposed.why,
      before: row.proposed.before,
      after: row.proposed.after,
      changes: row.proposed.changes,
      userWords: row.proposed.userWords,
      proposedAt: row.proposed.time,
      ...(comment ? { note: comment } : {}),
      by: "user",
      time,
    };
    const conversation = maintainerChannel(project.maintainerId);
    const scope = { projectId: project.id };
    const changeText = changeLines(row.proposed);
    // @i18n-ignore-start model：交给维护者的通知
    const notice = confirmed
      ? [
          `用户确认了立项要求变更（第 ${payload.revision} 次），立项书已改写（项目档案里的 charter.md，末尾记了这条变更）：`,
          ...changeText,
          ...(comment ? [`用户说：「${comment}」`] : []),
          "之后按改过的立项要求做（范围审视也按它对照）。项目类型、工作目录、工具包没变。",
        ].join("\n")
      : [`用户拒绝了立项要求变更（第 ${payload.revision} 次）${comment ? `：「${comment}」` : ""}。立项书不变，照现在的立项要求做。`, ...changeText].join("\n");
    // @i18n-ignore-end
    const summary = confirmed
      ? t("projects.charterChange.confirmedSummary", { revision: payload.revision, why: row.proposed.why })
      : t("projects.charterChange.rejectedSummary", { revision: payload.revision });
    const events: NewEvent[] = [
      { channel: CHARTERS_CHANNEL, type: CHARTER_EVENTS.changeDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` },
      // 确认的：项目列表上记一笔"立项书改了"（项目本身的字段不变：类型、工作目录、工具包不走这条路）
      ...(confirmed ? [projectChanged(project, time)] : []),
      buildTimelineRecord(conversation, { kind: "charter_change", summary, detail: [...changeText, ...wordsLines(row.proposed.userWords)].join("\n") }, scope).event,
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
        name: PROPOSE_CHARTER_CHANGE_TOOL,
        title: t("projects.tools.proposeCharterChange"),
        description: inModelLanguage(toolDescription),
        parameters: inModelLanguage(proposeParams),
        readOnlyOrIdempotent: false,
        run: ({ goal, scope, firstVersion, why, userWords }) => {
          const draft: CharterDraft = { ...(goal === undefined ? {} : { goal }), ...(scope === undefined ? {} : { scope }), ...(firstVersion === undefined ? {} : { firstVersion }) };
          try {
            const r = propose(projectId, maintainerId, draft, why.trim(), userWords);
            // @i18n-ignore-start model：工具结果
            const taken = r.words.verified.length > 0 ? `你引用的 ${r.words.verified.length} 条用户原话运行时核实过了，已写进卡上的"${inModelLanguage(() => USER_WORDS_TITLE)}"一栏。` : "";
            return {
              text: [
                `立项要求变更卡（第 ${r.revision} 次）已放进用户的待办，也出在用户说话的会话里；用户确认后立项书才改写，拒绝的不变。告诉用户：卡在这里，点确认就生效。`,
                taken,
                refusedUserWordsText(r.words.refused),
                "改动：",
                // @i18n-ignore-end
                ...changeLines(r),
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
    current,
    text(projectId) {
      const r = rendered(projectId);
      return r && charterMarkdown(r.project, r.charter, r.toolkit, r.confirmed, r.changes);
    },
    start() {
      // 确认了的立项要求变更追加之后改写 charter.md；之前追加了、没来得及写的（守护进程被杀）启动时再写一遍
      unsubscribe = store.onAppend((event) => {
        if (event.channel !== CHARTERS_CHANNEL || event.type !== CHARTER_EVENTS.changeDecided) return;
        const p = event.payload as CharterChangeDecidedPayload;
        if (p.confirmed) writeCharter(p.projectId);
      });
      const projects = new Set(
        store
          .read(CHARTERS_CHANNEL)
          .filter((e) => e.type === CHARTER_EVENTS.changeDecided && (e.payload as CharterChangeDecidedPayload).confirmed)
          .map((e) => (e.payload as CharterChangeDecidedPayload).projectId),
      );
      for (const projectId of projects) if (getProjectRow(store.reader, projectId)?.deleted === false) writeCharter(projectId);
    },
    stop() {
      unsubscribe?.();
    },
  };
}

/** "立项要求变更"卡（125 号票）：确认（confirm）、拒绝（reject，可附说明） */
export function charterChangeCardType(changes: Pick<CharterChanges, "decide">) {
  return defineCardType({
    type: "charter_change",
    version: 1,
    payload: CharterChangeCardPayload,
    actions: {
      confirm: { input: undefined, run: ({ payload, note, idempotencyKey }) => changes.decide(payload, true, note, idempotencyKey) },
      reject: { input: undefined, run: ({ payload, note, idempotencyKey }) => changes.decide(payload, false, note, idempotencyKey) },
    },
    toText: (p) =>
      [
        t("projects.charterChange.cardText", {
          name: p.projectName,
          revision: p.revision,
          state: t(p.decided ? (p.decided.confirmed ? "projects.charterChange.stateConfirmed" : "projects.charterChange.stateRejected") : "projects.charterChange.stateWaiting"),
          why: p.why,
        }),
        ...changeLines(p),
        ...wordsLines(p.userWords ?? []),
        CHARTER_FIXED_NOTE,
      ].join("\n"),
    // 彻底删除、删除项目时：立项书正文、维护者的说明、引用的原话换成删除标记，改了哪几项、确认结果不变
    purge: (p) => ({ ...p, why: PURGED_TEXT, before: purgedCharter(p.before), after: purgedCharter(p.after), changes: p.changes.map(purgedItem), ...(p.userWords ? { userWords: p.userWords.map(purgedWords) } : {}) }),
  });
}

const purgedItem = (item: CharterChangeCardPayload["changes"][number]): CharterChangeCardPayload["changes"][number] =>
  item.field === "scope" ? { ...item, removed: item.removed.map(() => PURGED_TEXT), added: item.added.map(() => PURGED_TEXT) } : { ...item, before: PURGED_TEXT, after: PURGED_TEXT };

const purgedWords = (w: VerifiedUserWords): VerifiedUserWords => ({ ...w, text: PURGED_TEXT });

/** 彻底删除、删除项目时 charters 频道上的立项要求变更：正文换成删除标记，改了哪几项、确认结果不变 */
export const charterChangePurges: readonly PurgeRewriter[] = [
  {
    eventType: CHARTER_EVENTS.changeProposed,
    rewrite(event) {
      const p = event.payload as CharterChangeProposedPayload;
      return { ...p, why: PURGED_TEXT, before: purgedCharter(p.before), after: purgedCharter(p.after), changes: p.changes.map(purgedItem), userWords: p.userWords.map(purgedWords) } satisfies CharterChangeProposedPayload;
    },
  },
  {
    eventType: CHARTER_EVENTS.changeDecided,
    rewrite(event) {
      const p = event.payload as CharterChangeDecidedPayload;
      return {
        ...p,
        why: PURGED_TEXT,
        before: purgedCharter(p.before),
        after: purgedCharter(p.after),
        changes: p.changes.map(purgedItem),
        userWords: p.userWords.map(purgedWords),
        ...purgedField(p, "note"),
      } satisfies CharterChangeDecidedPayload;
    },
  },
];

/** 用户在"立项要求变更"卡上确认、拒绝：审批决定（本人的选择），卡上写的话是本人打的字 */
export const charterChangeDecisionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "charter-change-decision",
  eventType: CHARTER_EVENTS.changeDecided,
  capture(event) {
    const p = event.payload as CharterChangeDecidedPayload;
    const what = p.changes.map(charterChangeItemText).join(t("projects.charterChange.sep"));
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        project: p.projectId,
        context: ["card:charter_change", `decision:${p.confirmed ? "confirmed" : "rejected"}`],
        ref: { recordId: `${p.projectId}-charter-change-${p.revision}`, cardId: p.cardId },
        accepted: { text: t(p.confirmed ? "projects.charterChange.materialConfirmed" : "projects.charterChange.materialRejected", { name: p.projectName, what }), field: "decision" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};
