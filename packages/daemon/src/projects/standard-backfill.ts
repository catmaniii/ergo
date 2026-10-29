// 现有项目补齐规范文档（262 号票；issue 19 Decisions 第 10 条，用户原话："可以给个任务，但是不一定要补，我确认后再补"）：
// - 规范上线：守护进程第一次带着这一版起来时，在 standards 频道上记一条 standard_backfill_launched，写明那时规范上线之前建的项目
//   （没有版本的；之后建的项目立项时都记了版本）。只记一次（幂等键），补齐规范文档的卡只给这几个项目出；
// - 出卡：其中立项书确认了（项目类型定了）、没归档、按类型和本项目的规范改写缺文档的（只读接口的 docs 里必须有的、这类另有的不在或者
//   只有说明：standardBackfillDocs），出一张"补齐规范文档"卡（standard_backfill），进待我处理（不卡任务，也不另弹提醒）。守护进程起来时
//   对一遍，之后这几个项目有变化（取消归档、立项书确认……）时再对一遍。卡的幂等键是 standard-backfill:<项目编号>：出过就不再出，
//   一个项目只出一次；不缺的不出；
// - "补齐"：同一事务项目列表频道上一条 standard_adopted（项目记下现在的规范版本；项目模块据此按这一版的模板补上缺的几份，已有的不动）、
//   建一个项目内部的普通任务（交给维护者照项目现状补：缺哪几份、每份写什么；确认时又都齐了就不建）、维护者会话时间线上记一笔；
// - "不补"：什么都不动（项目还是没有版本，档案不补），时间线上记一笔；卡不会再出，272 号票起之后用户又要补，由维护者提"跟新版"
//   （standard-change.ts：没有版本的项目写 upgrade 就是补齐，确认后照这里的补齐做）；
// - 不硬卡：卡一直挂着也不碍事，项目照常用。删除项目时卡随项目整条删掉（deletion-participants.ts）。
import {
  CARD_TYPE_VERSIONS,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  PROJECT_KIND_LABEL,
  type Project,
  type ProjectEventPayload,
  type ProjectKind,
  type ProjectStandardView,
  STANDARD_BACKFILL_CHOICE_LABEL,
  STANDARD_BACKFILL_CHOICES,
  type StandardBackfillCardPayload,
  StandardBackfillCardPayload as StandardBackfillCardSchema,
  type StandardBackfillChoice,
  type StandardBackfillDoc,
  standardBackfillDocs,
  standardBackfillDocText,
  STANDARD_CUSTOM_DOC,
  t,
} from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import { type CardActionEffect, defineCardType } from "../cards/registry.ts";
import { buildTimelineRecord } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { oneLine } from "../util/text.ts";
import { STANDARD_EVENTS, type StandardBackfillLaunchedPayload, STANDARDS_CHANNEL } from "./events.ts";
import { latestStandardVersion } from "./standard.ts";
import { getProjectRow, listProjects } from "./views.ts";

export interface StandardBackfillOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  /** 项目规范现在的样子（只读接口那一份：按项目类型和本项目的规范改写算）；没有这个项目是 undefined */
  standard(projectId: string): ProjectStandardView | undefined;
  /** 选"补齐"时建项目内部的普通任务 */
  tasks: Pick<TaskService, "buildInternal">;
  now: () => string;
  log: (line: string) => void;
}

export interface StandardBackfill {
  /** "补齐规范文档"卡上的补齐、不补（卡片动作，和卡片更新同一事务） */
  decide(payload: StandardBackfillCardPayload, choice: StandardBackfillChoice, note: string | undefined, idempotencyKey: string): CardActionEffect<StandardBackfillCardPayload>;
  /** 开始：规范上线记一次（只记一次），给该出卡的项目出卡；之后这几个项目有变化时再对一遍 */
  start(): void;
  stop(): void;
}

/** 规范上线那一条的幂等键（只记一次） */
const LAUNCH_KEY = "standard-backfill:launched";
/** 一个项目的"补齐规范文档"卡的幂等键：出过就不再出 */
const offerKey = (projectId: string) => `standard-backfill:${projectId}`;

/** 这个项目的"补齐规范文档"卡出过、还在等用户选（272 号票：这时维护者不另提"跟新版"补齐） */
export function backfillOfferPending(store: Pick<EventStore, "eventByIdempotencyKey">, cards: Pick<CardService, "get">, projectId: string): boolean {
  const offered = store.eventByIdempotencyKey(offerKey(projectId));
  if (!offered) return false;
  const cardId = (offered.payload as { card?: { id?: string } }).card?.id;
  return cardId !== undefined && cards.get(cardId)?.status === "pending";
}

/** 规范里每一份补的时候写什么（交给维护者的任务书里）；改写里多出来的那份写改写里说的 */
const docHint = (doc: StandardBackfillDoc, view: ProjectStandardView | undefined): string => {
  if (doc.key !== STANDARD_CUSTOM_DOC) return t(`projects.standardBackfill.hint.${doc.key}`);
  const added = view?.overrides.find((o) => o.kind === "add" && o.path === doc.path);
  return added?.kind === "add" ? added.note : t("projects.standardBackfill.hint.custom");
};

/**
 * 交给维护者的任务书（项目内部的普通任务，任务详情里你也看得到）：缺哪几份、每份写什么、只补文档。
 * 272 号票：卡上选了不补、之后维护者照用户的话提"跟新版"补齐时（standard-change.ts）也用这一份
 */
export function backfillTaskSummary(project: Project, kind: ProjectKind, version: string, missing: readonly StandardBackfillDoc[], view: ProjectStandardView | undefined, note: string | undefined): string {
  const docs = missing.map((doc) => t("projects.standardBackfill.docLine", { doc: standardBackfillDocText(doc), hint: docHint(doc, view) })).join("\n");
  const body = t("projects.standardBackfill.taskSummary", { name: project.name, version, kind: PROJECT_KIND_LABEL[kind], docs });
  return note ? `${body}\n${t("projects.standardBackfill.taskNote", { note })}` : body;
}

/** 卡上缺的几份写成一句 */
const docsText = (missing: readonly StandardBackfillDoc[]) => missing.map(standardBackfillDocText).join(t("pages.common.listSep"));

export function createStandardBackfill(options: StandardBackfillOptions): StandardBackfill {
  const { store, cards, inbox, now, log } = options;
  /** 规范上线时规范上线之前建的项目：卡只给它们出 */
  let launched: ReadonlySet<string> = new Set();
  let unsubscribe: (() => void) | undefined;

  const projectOf = (projectId: string): Project | undefined => {
    const row = getProjectRow(store.reader, projectId);
    return row && !row.deleted ? row.project : undefined;
  };

  /** 该给这个项目出卡了：规范上线之前建的、还没有版本、立项书确认了（项目类型定了）、没归档、没出过；缺几份由调用方再算 */
  const due = (project: Project): project is Project & { kind: ProjectKind } =>
    launched.has(project.id) &&
    project.standardVersion === undefined &&
    project.charterConfirmed &&
    project.kind !== undefined &&
    project.state !== "archived" &&
    store.eventByIdempotencyKey(offerKey(project.id)) === undefined;

  /** 该出卡、又缺文档的：出一张"补齐规范文档"卡，放进待我处理 */
  const offer = (projectId: string) => {
    const project = projectOf(projectId);
    if (!project || !due(project)) return;
    const view = options.standard(projectId);
    if (!view) return;
    const missing = standardBackfillDocs(view);
    if (missing.length === 0) return;
    const payload: StandardBackfillCardPayload = { projectId, projectName: project.name, kind: project.kind, version: view.latest, missing };
    const card = cards.buildCreate({ type: "standard_backfill", urgency: "non_blocking", payload });
    const item = inbox.buildAdd({
      kind: "card",
      cardId: card.card.id,
      title: oneLine(t("projects.standardBackfill.inboxTitle", { name: project.name }), 60),
      source: t("projects.source.project", { name: project.name }),
      origin: { projectId },
      urgency: "non_blocking",
    });
    store.appendBatch([{ ...card.event, idempotencyKey: offerKey(projectId) }, item.event]);
  };

  const safeOffer = (projectId: string) => {
    try {
      offer(projectId);
    } catch (err) {
      log(`给项目 ${projectId} 出补齐规范文档的卡时出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const decide: StandardBackfill["decide"] = (payload, choice, note, _idempotencyKey) => {
    const project = projectOf(payload.projectId);
    if (!project) throw new RequestRejected("not_found", t("projects.standardBackfill.noProject", { id: payload.projectId }));
    const comment = note?.trim() || undefined;
    const time = now();
    const conversation = maintainerChannel(project.maintainerId);
    const scope = { projectId: project.id };
    const detail = payload.missing.map((doc) => `- ${standardBackfillDocText(doc)}`).join("\n");
    if (choice === "skip") {
      const record = buildTimelineRecord(conversation, { kind: "standard_backfill", summary: t("projects.standardBackfill.skipSummary"), detail }, scope);
      return { status: "handled", payload: { ...payload, decided: { choice, at: time } }, ...(comment ? { note: comment } : {}), events: [record.event] };
    }
    if (project.standardVersion !== undefined) throw new RequestRejected("conflict", t("projects.standardBackfill.adopted", { name: project.name, version: project.standardVersion }));
    if (project.state === "archived") throw new RequestRejected("not_allowed", t("projects.standardBackfill.archived", { name: project.name }));
    // 按现在的样子再算一遍：出卡之后维护者可能已经补了几份
    const view = options.standard(project.id);
    const version = view?.latest ?? payload.version;
    const missing = view ? standardBackfillDocs(view) : payload.missing;
    const kind = project.kind ?? payload.kind;
    const adopted: ProjectEventPayload = { project: { ...project, standardVersion: version, updatedAt: time }, change: "standard_adopted", from: project.state, by: "user" };
    const task =
      missing.length > 0
        ? options.tasks.buildInternal(
            { projectId: project.id, title: t("projects.standardBackfill.taskTitle"), summary: backfillTaskSummary(project, kind, version, missing, view, comment), kind: "plain", origin: "suggestion" },
            "user",
          )
        : undefined;
    const summary = task ? t("projects.standardBackfill.backfillSummary", { taskId: task.task.id }) : t("projects.standardBackfill.backfillNoTaskSummary", { version });
    const events: NewEvent[] = [
      // 项目先改用规范（项目模块据此从模板补上缺的几份），再建任务：维护者开工时模板已经在档案里了
      { channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: adopted },
      ...(task?.events ?? []),
      buildTimelineRecord(conversation, { kind: "standard_backfill", summary, detail }, scope).event,
    ];
    return {
      status: "handled",
      payload: { ...payload, decided: { choice, at: time, ...(task ? { taskId: task.task.id } : {}) } },
      ...(comment ? { note: comment } : {}),
      events,
    };
  };

  return {
    decide,
    start() {
      const existing = store.eventByIdempotencyKey(LAUNCH_KEY);
      if (existing) {
        launched = new Set((existing.payload as StandardBackfillLaunchedPayload).projects);
      } else {
        // 规范上线：这时没有版本的项目都是规范上线之前建的（之后立项的都记了版本）
        const projects = listProjects(store.reader)
          .filter((p) => p.standardVersion === undefined)
          .map((p) => p.id);
        const payload: StandardBackfillLaunchedPayload = { projects, version: latestStandardVersion(), time: now() };
        store.append({ channel: STANDARDS_CHANNEL, type: STANDARD_EVENTS.backfillLaunched, payload, idempotencyKey: LAUNCH_KEY });
        launched = new Set(projects);
      }
      // 这几个项目有变化（取消归档、立项书确认……）时再对一遍；出过的、改用了规范的不会再出
      unsubscribe = store.onAppend((event) => {
        if (event.channel !== CHANNELS.projects || event.type !== EVENT_TYPES.project) return;
        const { project } = event.payload as ProjectEventPayload;
        if (launched.has(project.id)) safeOffer(project.id);
      });
      for (const projectId of launched) safeOffer(projectId);
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/** 卡上处理之后写什么：补齐（建了哪个任务；确认时都齐了就没建）、不补 */
const choseText = (p: StandardBackfillCardPayload): string => {
  if (!p.decided) return t("projects.standardBackfill.waiting", { choices: STANDARD_BACKFILL_CHOICES.map((c) => STANDARD_BACKFILL_CHOICE_LABEL[c]).join(t("pages.common.listSep")) });
  if (p.decided.choice === "skip") return t("projects.standardBackfill.chose.skip");
  return p.decided.taskId ? t("projects.standardBackfill.chose.backfill", { taskId: p.decided.taskId }) : t("projects.standardBackfill.chose.backfillNoTask", { version: p.version });
};

/**
 * "补齐规范文档"卡（262 号票）：补齐（confirm）、不补（dismiss）。纯文本降级（秘书列待办看开头）先写哪个项目缺哪几份，再写等你选什么
 * （选过的写选了哪个）。负载里没有谁写的话（用户在卡上附的一句在处理结果里，彻底删除照通用的换掉）
 */
export function standardBackfillCardType(backfill: Pick<StandardBackfill, "decide">) {
  return defineCardType({
    type: "standard_backfill",
    version: CARD_TYPE_VERSIONS.standard_backfill,
    payload: StandardBackfillCardSchema,
    actions: {
      confirm: { input: undefined, run: ({ payload, note, idempotencyKey }) => backfill.decide(payload, "backfill", note, idempotencyKey) },
      dismiss: { input: undefined, run: ({ payload, note, idempotencyKey }) => backfill.decide(payload, "skip", note, idempotencyKey) },
    },
    toText: (p) =>
      [t("projects.standardBackfill.cardText", { name: p.projectName, version: p.version, kind: PROJECT_KIND_LABEL[p.kind], docs: docsText(p.missing) }), choseText(p)].join(t("projects.cards.sep")),
  });
}
