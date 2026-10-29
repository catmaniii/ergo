// "删除参与方"登记表（279 号票，方案 C；ADR-0010 补记）：删项目、删任务、移除插件时连数据删走同一张表。
// 1. 新加一种属于项目的事件：只在拥有它的模块里登记（参与方 + 彻底删除的改写函数）就随项目删，删除代码（projects/deletion.ts）不用改；
//    没登记改写函数的照旧整个拒删，什么都不改；
// 2. 登记表自己的规矩：几步的先后、卡片（整张换成标记 / 字段级改写追加新版本，两样都有时按前者）、追加的事件按段排、提交后要做的；
// 3. projects/deletion.ts 不再 import 别的模块的内部文件（只经登记表）。
// 三种删除"结果和以前逐条一样"由现有的主切面守着（test/main/projects.test.ts、project-deletion-reads、project-internal-tasks、
// task-delete、plugin-settings 和几个插件的主切面）。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, isDeletedEventPayload, type Project, type ProjectEventPayload, PURGED_TEXT } from "@ergo/protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import type { CardService } from "../../src/cards/cards.ts";
import { DeletionParticipants, deletionKind, PROJECT_DELETION } from "../../src/deletion/participants.ts";
import { type EventStore, openEventStore, type StoredEvent } from "../../src/events/event-store.ts";
import { PurgeRewriters } from "../../src/memory/rewriters.ts";
import { deleteProject } from "../../src/projects/deletion.ts";
import { projectRecordsPaths } from "../../src/projects/records.ts";
import { getProjectRow, projectsView } from "../../src/projects/views.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const NOW = "2026-10-25T10:00:00.000+08:00";

function openStore(): { dir: string; store: EventStore } {
  const dir = makeTempDir("ergo-deletion-");
  const store = openEventStore({ file: path.join(dir, "ergo.db"), views: [projectsView], now: () => NOW, log: () => {} });
  onTestFinished(() => store.close());
  return { dir, store };
}

/** 用不到卡片新版本的地方给的卡片服务（叫到就红） */
const noCards = {
  get: () => undefined,
  purged: () => {
    throw new Error("不该叫到");
  },
  buildUpdate: () => {
    throw new Error("不该叫到");
  },
} as unknown as Pick<CardService, "get" | "purged" | "buildUpdate">;

const archivedProject = (id: string): Project => ({
  id,
  name: `项目${id}`,
  goal: "记账",
  state: "archived",
  origin: "suggestion",
  maintainerId: `pm-${id}`,
  workdir: { external: false },
  charterConfirmed: false,
  createdAt: NOW,
  updatedAt: NOW,
});

/** 一个"以后的模块"：它的 notes 频道上有属于项目的 project_note 事件（带着项目编号和用户的原话） */
const NOTES = "notes";
const NOTE = "project_note";

/** 一个已归档的 p-1、p-2，各有一条笔记；那个模块在登记表里登记了自己的参与方（改写函数按 withRewriter 登不登记） */
function setup(withRewriter: boolean) {
  const { dir, store } = openStore();
  const rewriters = new PurgeRewriters();
  const participants = new DeletionParticipants({ store, cards: noCards, rewriters });
  // —— 那个模块自己的登记（不碰删除代码）——
  if (withRewriter) rewriters.register({ eventType: NOTE, rewrite: (event) => ({ ...(event.payload as object), text: PURGED_TEXT }) });
  participants.register(PROJECT_DELETION, {
    owner: "notes",
    join: ({ project }, plan) => ({
      claim() {
        for (const event of plan.store.read(NOTES, 0, NOTE)) if ((event.payload as { projectId: string }).projectId === project.id) plan.rewrite(event);
      },
    }),
  });
  for (const id of ["p-1", "p-2"]) {
    store.append({ channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: { project: archivedProject(id), change: "archived", from: "building", by: "user" } satisfies ProjectEventPayload });
    store.append({ channel: NOTES, type: NOTE, payload: { projectId: id, text: `${id} 的用户原话` } });
  }
  const calls: string[] = [];
  const deps = {
    store,
    participants,
    maintainers: {
      suspend: async (id: string) => void calls.push(`suspend ${id}`),
      resume: (id: string) => void calls.push(`resume ${id}`),
      removeSession: (id: string) => void calls.push(`removeSession ${id}`),
    },
    records: (projectId: string) => projectRecordsPaths(path.join(dir, "projects"), projectId),
    deletedEvent: (project: Project): { channel: string; type: string; payload: ProjectEventPayload } => ({ channel: CHANNELS.projects, type: EVENT_TYPES.project, payload: { project, change: "deleted", from: "archived", by: "user" } }),
    now: () => NOW,
    log: () => {},
  };
  const note = (id: string) => store.read(NOTES, 0, NOTE).find((e) => (e.payload as { projectId: string }).projectId === id)!.payload as { text: string };
  return { store, deps, calls, note, dir };
}

describe("新加一种属于项目的事件", () => {

  it("只在拥有它的模块里登记（参与方 + 改写函数），删项目就把它改写了；别的项目的不动", async () => {
    const { store, deps, calls, note, dir } = setup(true);
    fs.mkdirSync(path.join(dir, "projects", "p-1"), { recursive: true });
    await deleteProject(deps, "p-1");
    expect(getProjectRow(store.reader, "p-1")?.deleted).toBe(true);
    expect(note("p-1").text).toBe(PURGED_TEXT);
    expect(note("p-2").text).toBe("p-2 的用户原话");
    expect(calls).toEqual(["suspend pm-p-1", "removeSession pm-p-1"]);
    expect(fs.existsSync(path.join(dir, "projects", "p-1"))).toBe(false);
  });

  it("那类事件没登记改写函数：整个删除被拒，什么都不改（项目还在、原话还在）", async () => {
    const { store, deps, note } = setup(false);
    await expect(deleteProject(deps, "p-1")).rejects.toThrow(`事件类型 ${NOTE}`);
    expect(getProjectRow(store.reader, "p-1")?.deleted).toBe(false);
    expect(note("p-1").text).toBe("p-1 的用户原话");
  });
});

describe("登记表自己的规矩", () => {
  const KIND = deletionKind<{ id: string }>("test");

  it("几步的先后、plan.tasks、卡片两种处理、追加的事件按段排、提交后要做的；settle 之前拿不到改写后的", () => {
    const { store } = openStore();
    const rewriters = new PurgeRewriters();
    rewriters.register({ eventType: "fact", rewrite: (event) => ({ ...(event.payload as object), text: PURGED_TEXT }) });
    rewriters.register({ eventType: EVENT_TYPES.card, rewrite: (event) => ({ ...(event.payload as object), purged: true }) });
    const card = (id: string) => store.append({ channel: CHANNELS.cards, type: EVENT_TYPES.card, payload: { card: { id } } }).event;
    const both = card("c-both");
    const field = card("c-field");
    const dropped = card("c-drop");
    const untouched = card("c-keep");
    const fact = store.append({ channel: "facts", type: "fact", payload: { text: "原话" } }).event;
    const whole = store.append({ channel: "facts", type: "other", payload: { text: "整条" } }).event;
    const cards = {
      get: (id: string) => ({ id, payload: { text: "卡上的原话" } }),
      purged: (c: { id: string }) => ({ ...c, payload: { text: PURGED_TEXT } }),
      buildUpdate: (id: string, change: { payload: unknown }) => ({ card: { id }, event: { channel: CHANNELS.cards, type: EVENT_TYPES.card, payload: { card: { id, ...change } } } }),
    } as unknown as Pick<CardService, "get" | "purged" | "buildUpdate">;
    const participants = new DeletionParticipants({ store, cards, rewriters });
    const steps: string[] = [];
    let after = 0;
    participants.register(KIND, {
      owner: "late",
      join: (_s, plan) => ({
        follow: () => void steps.push(`late follow：卡 c-drop ${plan.cardFate("c-drop")}、c-both ${plan.cardFate("c-both")}`),
        settle() {
          steps.push(`late settle：字段级 ${plan.rewritten().map(({ event }) => event.globalSeq).join(",")}`);
          // 追加的先后：先追加的段号大的，排出来仍按段
          plan.append("materials", { channel: "m", type: "x", payload: 1 });
          plan.append("conversations", { channel: "c", type: "x", payload: 2 });
          plan.afterCommit(() => void (after += 1));
        },
      }),
    });
    participants.register(KIND, {
      owner: "early",
      join: (_s, plan) => {
        expect(() => plan.rewritten()).toThrow("settle");
        return {
          claim() {
            steps.push(`early claim：tasks ${[...plan.tasks].join(",")}`);
            plan.rewrite(fact);
            plan.marker(whole);
            plan.dropCard("c-drop");
            plan.dropCard("c-both");
            plan.purgeCard("c-both");
            plan.purgeCard("c-field");
            plan.append("records", { channel: "r", type: "x", payload: 3 });
          },
          settle() {
            expect(() => plan.rewrite(fact)).toThrow("follow 之前");
            expect([...plan.claimedSeqs()].toSorted((a, b) => a - b)).toEqual([both.globalSeq, field.globalSeq, dropped.globalSeq, fact.globalSeq, whole.globalSeq]);
          },
        };
      },
    });
    participants.register(KIND, { owner: "scope", join: ({ id }, plan) => ({ scope: () => void plan.tasks.add(`t-${id}`) }) });
    participants.register(KIND, { owner: "absent", join: () => undefined });
    expect(participants.owners(KIND)).toEqual(["late", "early", "scope", "absent"]);

    const result = participants.plan(KIND, { id: "1" }, { deletedAt: NOW, materialIds: new Set() });
    expect(steps).toEqual(["early claim：tasks t-1", "late follow：卡 c-drop dropped、c-both dropped", `late settle：字段级 ${field.globalSeq},${fact.globalSeq}`]);
    const purged = new Map(result.purge.map((p) => [p.globalSeq, p.payload]));
    // 整张换成标记的（两样都有的按它）、字段级改写的卡、字段级改写的事件、整条换成标记的；没认领的不动
    expect(isDeletedEventPayload(purged.get(both.globalSeq))).toBe(true);
    expect(isDeletedEventPayload(purged.get(dropped.globalSeq))).toBe(true);
    expect(purged.get(field.globalSeq)).toEqual({ card: { id: "c-field" }, purged: true });
    expect(purged.get(fact.globalSeq)).toEqual({ text: PURGED_TEXT });
    expect(isDeletedEventPayload(purged.get(whole.globalSeq))).toBe(true);
    expect(purged.has(untouched.globalSeq)).toBe(false);
    // 追加的：会话 → 记录 → 卡片的新版本（只给字段级改写的卡）→ 素材
    expect(result.events.map((e) => e.channel)).toEqual(["c", "r", CHANNELS.cards, "m"]);
    expect(result.events[2]!.payload).toEqual({ card: { id: "c-field", payload: { text: PURGED_TEXT } } });
    // 提交之后要做的交给删除代码，算的时候不做
    expect(after).toBe(0);
    for (const step of result.afterCommit) step();
    expect(after).toBe(1);
  });

  it("撤销登记；这种删除没有参与方时什么都不改", () => {
    const { store } = openStore();
    const participants = new DeletionParticipants({ store, cards: noCards, rewriters: new PurgeRewriters() });
    const undo = participants.register(KIND, { owner: "x", join: (_s, plan) => ({ claim: () => plan.marker({ globalSeq: 1 } as StoredEvent) }) });
    undo();
    expect(participants.owners(KIND)).toEqual([]);
    expect(participants.plan(KIND, { id: "1" }, { deletedAt: NOW, materialIds: new Set() })).toEqual({ purge: [], events: [], afterCommit: [] });
  });
});

describe("projects/deletion.ts 只经登记表", () => {
  it("不再 import 别的模块的内部文件：只有协议包、登记表、事件存储的类型和项目自己的文件", () => {
    const file = path.resolve(import.meta.dirname, "../../src/projects/deletion.ts");
    const imports = [...fs.readFileSync(file, "utf8").matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gms)].map((m) => m[1]);
    expect(imports.filter((from) => !(from === "@ergo/protocol" || from === "../deletion/participants.ts" || from === "../events/event-store.ts" || from!.startsWith("./")))).toEqual([]);
    // 检查本身有效：确实扫到了
    expect(imports).toContain("../deletion/participants.ts");
  });
});
