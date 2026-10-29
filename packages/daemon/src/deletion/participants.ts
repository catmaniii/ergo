// "删除参与方"登记表（279 号票，方案 C：docs/research/29-plugin-expansion-review.html 第 5、7 节；ADR-0010 补记）。
// 删项目（projects/deletion.ts，ADR-0010）、删任务（tasks/deletion.ts，186 号票）、移除插件时连数据删（plugins/removal.ts，211 号票）
// 走同一张表：哪个模块拥有"属于某个项目 / 某个任务 / 某个插件"的事件，就由它登记一个参与方——怎么找到属于这次删除的、换成什么。
// 删除代码只管先停、复查、提交、删文件，删的范围由登记表决定：新加一种属于项目的事件，在拥有它的模块里登记就能随项目删，
// 不用改删除代码（以前要加进 projects/deletion.ts 的范围）。没登记改写函数的事件类型照旧整个拒删（见 rewrite）。
//
// 一次删除（plan）分几步，每个参与方在它要的那几步里做（join 交回这一次的几步，闭包里放这一次的状态）：
// 1. scope：定范围——随它一起走的东西（删项目时项目的内部任务由任务模块写进 plan.tasks），后面的参与方按它认；
// 2. claim：认领属于它的事件（marker 整条换成"已删除"标记、replace 换成给出的负载、rewrite 按改写函数表字段级改写）、
//    卡片（dropCard 整张换成标记、purgeCard 字段级改写并追加新版本）、同一事务要追加的事件（append，分段见下）、提交后要做的（afterCommit）；
// 3. follow：要看别人认领了哪些卡片的（待我处理里这些卡的事项）；
//    然后登记表自己收卡片和字段级改写：dropCard 的卡每个版本、关掉和长期没处理的记录整条换成标记；purgeCard 的（没被 dropCard 的）
//    每个版本连同那些记录一起字段级改写，追加改写后的新版本；要字段级改写的按全局序号一起改写——没登记改写函数的事件类型在这里抛错，
//    整个删除被拒（宁可删不成也不胡乱改坏状态，ADR-0008），什么都不改；
// 4. settle：要看整张改写单的（素材随删除彻底删：已经改写了的不改第二遍；项目之外的会话追加 messages_purged）。
// 同一步里按登记的先后（purgeCard 的卡追加新版本的先后就是认领的先后）。改写单里同一条事件出现两次时后面的算（appendBatch 依次改写）。
// 追加的事件按段排：conversations（会话的 messages_purged）→ records（随删除结束的任务）→ inbox（待我处理里删掉的事项）→
// cards（改写过的卡片的新版本）→ materials（素材的记忆命令和它连带的）；段里按追加的先后。三种删除原来追加的先后就是这样。
//
// 删除的种类（DeletionKind）带着这次删的是什么（subject）：这里定了现有的四种（295 号票加了断开数据源时连已导入的一起删）；别的模块要一种新的删除（比如以后删掉一个人的档案）
// 自己 deletionKind 一个，登记它的参与方，调 plan（见 docs/developer-guide.md"删除参与方登记表"）。
import { type CardDismissedEventPayload, type CardEventPayload, CHANNELS, EVENT_TYPES, isDeletedEventPayload, type PluginPurgeCounts, type Project, type Task } from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import type { EventStore, NewEvent, PurgeRewrite, StoredEvent } from "../events/event-store.ts";
import { deletedMarker, type PurgeContext } from "../events/purge.ts";
import type { PurgeRewriters } from "../memory/rewriters.ts";

/** 一种删除，带着这次删的是什么的类型（取的时候不用断言） */
export interface DeletionKind<S> {
  readonly id: string;
  /** 只给类型推导用，没有值 */
  readonly __subject?: S;
}

export function deletionKind<S>(id: string): DeletionKind<S> {
  return { id };
}

/** 删项目（ADR-0010）：已归档、复查过的这个项目 */
export interface ProjectDeletionSubject {
  readonly project: Project;
}

/** 删任务（186 号票）：复查过的这个任务、它自己的维护者会话（任务自己的维护者、迁移来的作业维护者；不是它自己的 undefined）、它的 agent（自己的维护者和子 agent） */
export interface TaskDeletionSubject {
  readonly task: Task;
  readonly conversation: string | undefined;
  readonly agents: ReadonlySet<string>;
}

/** 移除插件时连数据删（211 号票）：哪个插件；counts 由参与方报上各删了几条（删除记录里写） */
export interface PluginDataDeletionSubject {
  readonly plugin: string;
  readonly counts: PluginPurgeCounts;
}

/**
 * 断开数据源时连已导入的一起删（295 号票）：哪个数据源、它导入的记录是哪几类事件（数据源登记时写的 records）；
 * counts 由参与方报上各删了几条（断开记录里写）
 */
export interface DataSourceDeletionSubject {
  readonly source: string;
  readonly records: readonly { readonly channel?: string; readonly type: string }[];
  readonly counts: { events: number; materials: number; files: number };
}

export const PROJECT_DELETION = deletionKind<ProjectDeletionSubject>("project");
export const TASK_DELETION = deletionKind<TaskDeletionSubject>("task");
export const PLUGIN_DATA_DELETION = deletionKind<PluginDataDeletionSubject>("plugin-data");
export const DATA_SOURCE_DELETION = deletionKind<DataSourceDeletionSubject>("data-source");

/** 同一事务追加的事件排在哪一段（段的先后固定，见文件开头） */
export type AppendSection = "conversations" | "records" | "inbox" | "cards" | "materials";
const SECTIONS: readonly AppendSection[] = ["conversations", "records", "inbox", "cards", "materials"];

/** 一个参与方在这次删除里的几步（见文件开头）；不要的步不写 */
export interface DeletionSteps {
  scope?(): void;
  claim?(): void;
  follow?(): void;
  settle?(): void;
}

export interface DeletionParticipant<S> {
  /** 谁登记的（模块名）：日志、测试里认 */
  readonly owner: string;
  /** 这次删除里它要做的几步；和这次删除不相干的交回 undefined。只建闭包，别在这里读写 */
  join(subject: S, plan: DeletionPlan): DeletionSteps | undefined;
}

/** 参与方手上的这次删除（改写单） */
export interface DeletionPlan {
  readonly store: EventStore;
  /** 什么时候删的、哪种删除（删项目时 purgedBy 是 project_deletion：完整内容注明"已随项目删除"） */
  readonly context: PurgeContext;
  /** 随这次删除一起走的任务：scope 一步里写（删项目时是项目的内部任务，删任务时是它自己），之后各步按它认 */
  readonly tasks: Set<string>;
  /** 整条换成"已删除"标记（消息留下 id 和时间） */
  marker(event: StoredEvent): void;
  /** 换成给出的负载 */
  replace(event: Pick<StoredEvent, "globalSeq">, payload: unknown): void;
  /** 按改写函数表字段级改写（follow 之后按全局序号一起改；这类事件没登记改写函数的话整个删除被拒） */
  rewrite(event: StoredEvent): void;
  /** 马上按改写函数表算出改写后的负载（要自己排先后、自己去重的参与方用；没登记就抛错） */
  rewriteOf(event: StoredEvent): unknown;
  /** 这张卡每个版本、关掉和长期没处理的记录整条换成标记 */
  dropCard(cardId: string): void;
  /** 这张卡每个版本连同那些记录字段级改写，追加改写后的新版本（同一张卡也被 dropCard 的话按 dropCard） */
  purgeCard(cardId: string): void;
  /** 这张卡在这次删除里怎么处理：dropped（整张换成标记）、purged（字段级改写）、undefined（不动） */
  cardFate(cardId: string): "dropped" | "purged" | undefined;
  /** 同一事务追加的事件 */
  append(section: AppendSection, ...events: NewEvent[]): void;
  /** 提交之后要做的（删文件……）：删除代码在 appendBatch 之后依次做 */
  afterCommit(step: () => void): void;
  /** settle 一步里：字段级改写的事件和改写后的负载（按全局序号） */
  rewritten(): ReadonlyArray<{ event: StoredEvent; payload: unknown }>;
  /** settle 一步里：到这时改写单里已有的事件（全局序号） */
  claimedSeqs(): Set<number>;
}

/** 一次删除算出来的：同一事务里改写的、追加的，提交之后做的 */
export interface DeletionResult {
  purge: PurgeRewrite[];
  events: NewEvent[];
  afterCommit: Array<() => void>;
}

export interface DeletionParticipantsDeps {
  store: EventStore;
  /** 字段级改写的卡片追加新版本 */
  cards: Pick<CardService, "get" | "purged" | "buildUpdate">;
  /** 彻底删除的改写函数表（ADR-0008） */
  rewriters: Pick<PurgeRewriters, "rewrite">;
}

/** 还没被改写成"已删除"标记的 */
export const liveEvents = (events: readonly StoredEvent[]): StoredEvent[] => events.filter((e) => !isDeletedEventPayload(e.payload));

/** 卡片频道上的事件说的是哪张卡（卡片本身、关掉和长期没处理的记录） */
export const cardIdOf = (event: StoredEvent): string | undefined =>
  event.type === EVENT_TYPES.card ? (event.payload as CardEventPayload).card.id : (event.payload as Partial<CardDismissedEventPayload>).cardId;

/** 只能在 settle 一步里用的，早用了是编程错误 */
const notYet = (what: string) => new Error(`删除参与方：${what}只能在 settle 一步里用`); // @i18n-ignore log：编程错误

export class DeletionParticipants {
  private readonly participants = new Map<string, Array<DeletionParticipant<never>>>();
  private readonly deps: DeletionParticipantsDeps;

  constructor(deps: DeletionParticipantsDeps) {
    this.deps = deps;
  }

  /** 登记一个参与方；返回撤销函数 */
  register<S>(kind: DeletionKind<S>, participant: DeletionParticipant<S>): () => void {
    const list = this.participants.get(kind.id) ?? [];
    const entry = participant as DeletionParticipant<never>;
    list.push(entry);
    this.participants.set(kind.id, list);
    return () => {
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    };
  }

  /** 这种删除登记了哪些参与方（按登记的先后） */
  owners<S>(kind: DeletionKind<S>): string[] {
    return (this.participants.get(kind.id) ?? []).map((p) => p.owner);
  }

  /** 算出这次删除要改写的、要追加的（不提交）；没登记改写函数的事件类型抛错（整个删除被拒） */
  plan<S>(kind: DeletionKind<S>, subject: S, context: PurgeContext): DeletionResult {
    const { store, cards, rewriters } = this.deps;
    const claims: PurgeRewrite[] = [];
    const targets = new Map<number, StoredEvent>();
    const dropped = new Set<string>();
    const purged = new Set<string>();
    const sections = new Map<AppendSection, NewEvent[]>(SECTIONS.map((s) => [s, []]));
    const afterCommit: Array<() => void> = [];
    let resolved: { cardMarkers: PurgeRewrite[]; rewritten: Array<{ event: StoredEvent; payload: unknown }> } | undefined;
    const settled: PurgeRewrite[] = [];
    let settling = false;

    const plan: DeletionPlan = {
      store,
      context,
      tasks: new Set(),
      marker: (event) => (settling ? settled : claims).push({ globalSeq: event.globalSeq, payload: deletedMarker(event, context.deletedAt) }),
      replace: (event, payload) => (settling ? settled : claims).push({ globalSeq: event.globalSeq, payload }),
      rewrite: (event) => {
        if (resolved) throw new Error("删除参与方：字段级改写要在 follow 之前认领（settle 里用 rewriteOf）"); // @i18n-ignore log：编程错误
        targets.set(event.globalSeq, event);
      },
      rewriteOf: (event) => rewriters.rewrite(event, context),
      dropCard: (cardId) => void dropped.add(cardId),
      purgeCard: (cardId) => void purged.add(cardId),
      cardFate: (cardId) => (dropped.has(cardId) ? "dropped" : purged.has(cardId) ? "purged" : undefined),
      append: (section, ...events) => void sections.get(section)!.push(...events),
      afterCommit: (step) => void afterCommit.push(step),
      rewritten: () => {
        if (!resolved) throw notYet("rewritten()");
        return resolved.rewritten;
      },
      claimedSeqs: () => {
        if (!resolved) throw notYet("claimedSeqs()");
        return new Set([...claims, ...resolved.cardMarkers, ...resolved.rewritten.map(({ event }) => ({ globalSeq: event.globalSeq })), ...settled].map((p) => p.globalSeq));
      },
    };

    const steps = (this.participants.get(kind.id) ?? []).flatMap((p) => (p as DeletionParticipant<S>).join(subject, plan) ?? []);
    for (const step of steps) step.scope?.();
    for (const step of steps) step.claim?.();
    for (const step of steps) step.follow?.();

    // 卡片：dropCard 的整条换成标记；purgeCard 的（没被 dropCard 的）每个版本和记录字段级改写
    const cardMarkers: PurgeRewrite[] = [];
    const purgedOnly = [...purged].filter((cardId) => !dropped.has(cardId));
    const fieldCards = new Set(purgedOnly);
    if (dropped.size > 0 || fieldCards.size > 0) {
      for (const event of liveEvents(store.read(CHANNELS.cards))) {
        const cardId = cardIdOf(event);
        if (cardId === undefined) continue;
        if (dropped.has(cardId)) cardMarkers.push({ globalSeq: event.globalSeq, payload: deletedMarker(event, context.deletedAt) });
        else if (fieldCards.has(cardId)) targets.set(event.globalSeq, event);
      }
    }
    // 字段级改写：按全局序号（没登记改写函数的在这里抛错，整个删除被拒）
    const rewritten = [...targets.values()].toSorted((a, b) => a.globalSeq - b.globalSeq).map((event) => ({ event, payload: rewriters.rewrite(event, context) }));
    // 改写过的卡片：追加改写后的新版本（开着的页面据此换掉手里的卡）
    for (const cardId of purgedOnly) {
      const latest = cards.get(cardId);
      if (!latest) continue;
      const card = cards.purged(latest, context);
      sections.get("cards")!.push(cards.buildUpdate(cardId, { payload: card.payload, ...(card.outcome === undefined ? {} : { outcome: card.outcome }) }).event);
    }
    resolved = { cardMarkers, rewritten };

    settling = true;
    for (const step of steps) step.settle?.();

    return {
      purge: [...claims, ...cardMarkers, ...rewritten.map(({ event, payload }) => ({ globalSeq: event.globalSeq, payload })), ...settled],
      events: SECTIONS.flatMap((s) => sections.get(s)!),
      afterCommit,
    };
  }
}
