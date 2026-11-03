// 目录授权表（folders/folder-grants.ts、folder-grant-expiry.ts，ADR-0049）：
// - 登记：只认完整路径、在、是目录，存它的真实路径（目录联接登记的是它指过去的地方）；数据目录、程序目录不能登记；
//   只有能有表的 agent（个人助理、项目和任务的负责人）能登记；读写删至少一种；到期时间要是以后的；
// - 同一个 agent 同一个目录只有一条：再加换掉；审批卡上的"以后都允许"并进去、变成长期有效；
// - 守卫拿到的是这个 agent 的那一份（到期时间换成毫秒，过期的也给）；能删一条、清掉已过期的、清掉某个 agent 的；
// - 文件坏了当没有；设置页看的样子标出已过期、找不到了；
// - 到期前三天在待办里提示一次，过期了的、提示过的不再提示。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type InboxItem, nowIso } from "@ergo/protocol";
import { RequestRejected } from "../../src/errors.ts";
import { createFolderGrantExpiryNotices } from "../../src/folders/folder-grant-expiry.ts";
import { folderGrantsView, openFolderGrants } from "../../src/folders/folder-grants.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 3, 4, 0, 0);

function setup() {
  const root = makeTempDir("ergo-folder-grants-");
  const notes = path.join(root, "notes");
  const other = path.join(root, "other");
  const dataDir = path.join(root, "ergo-data");
  for (const dir of [notes, other, dataDir, path.join(dataDir, "config")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, "file.txt"), "x");
  const file = path.join(dataDir, "config", "folder-grants.json");
  const logs: string[] = [];
  let now = NOW;
  const grants = openFolderGrants({
    file,
    now: () => now,
    forbidden: () => [fs.realpathSync.native(dataDir)],
    canHold: (agentId) => ["secretary", "pm-1", "tm-1"].includes(agentId),
    log: (line) => logs.push(line),
  });
  return { root, notes, other, dataDir, file, grants, logs, setNow: (at: number) => (now = at) };
}

function rejection(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RequestRejected) return err.message;
    throw err;
  }
  throw new Error("应当被拒绝");
}

describe("登记", () => {
  it("存真实路径、操作按读写删排好、到期时间写成协议时间", () => {
    const { notes, grants } = setup();
    const at = nowIso(new Date(NOW + 7 * DAY));
    const g = grants.add({ agentId: "pm-1", path: `${notes}\\`, modes: ["delete", "read"], expiresAt: at, note: " 导入账单 ", addedBy: "user" });
    expect(g).toMatchObject({ agentId: "pm-1", path: fs.realpathSync.native(notes), modes: ["read", "delete"], note: "导入账单", addedBy: "user" });
    expect(Date.parse(g.expiresAt!)).toBe(NOW + 7 * DAY);
    expect(grants.forAgent("pm-1")).toEqual([{ grantId: g.id, dir: fs.realpathSync.native(notes), modes: ["read", "delete"], expiresAt: NOW + 7 * DAY }]);
    expect(grants.forAgent("secretary")).toEqual([]);
  });

  it("目录联接：登记的是它指过去的地方", () => {
    const { root, other, grants } = setup();
    const link = path.join(root, "link");
    fs.symlinkSync(other, link, "junction");
    const g = grants.add({ agentId: "secretary", path: link, modes: ["read"], addedBy: "user" });
    expect(g.path).toBe(fs.realpathSync.native(other));
  });

  it("不对的都拒绝，写明原因", () => {
    const { root, dataDir, notes, grants } = setup();
    expect(rejection(() => grants.add({ agentId: "pm-1", path: "notes", modes: ["read"], addedBy: "user" }))).toContain("完整的路径");
    expect(rejection(() => grants.add({ agentId: "pm-1", path: path.join(root, "nope"), modes: ["read"], addedBy: "user" }))).toContain("没有这个文件夹");
    expect(rejection(() => grants.add({ agentId: "pm-1", path: path.join(root, "file.txt"), modes: ["read"], addedBy: "user" }))).toContain("不是文件夹");
    expect(rejection(() => grants.add({ agentId: "pm-1", path: path.join(dataDir, "config"), modes: ["read"], addedBy: "user" }))).toContain("不能登记");
    expect(rejection(() => grants.add({ agentId: "sa-1", path: notes, modes: ["read"], addedBy: "user" }))).toContain("没有目录授权表");
    expect(rejection(() => grants.add({ agentId: "pm-1", path: notes, modes: [], addedBy: "user" }))).toContain("至少要勾一种");
    expect(rejection(() => grants.add({ agentId: "pm-1", path: notes, modes: ["read"], expiresAt: nowIso(new Date(NOW - 1)), addedBy: "user" }))).toContain("晚于现在");
    expect(rejection(() => grants.add({ agentId: "pm-1", path: notes, modes: ["read"], expiresAt: "明天", addedBy: "user" }))).toContain("写得不对");
    expect(grants.list()).toEqual([]);
  });

  it("同一个 agent 同一个目录再加：换掉（编号不变）；别的 agent 的另算", () => {
    const { notes, grants } = setup();
    const first = grants.add({ agentId: "pm-1", path: notes, modes: ["read"], addedBy: "user" });
    const second = grants.add({ agentId: "pm-1", path: notes.toUpperCase(), modes: ["write"], note: "改成只写", addedBy: "user" });
    grants.add({ agentId: "tm-1", path: notes, modes: ["read"], addedBy: "user" });
    expect(second.id).toBe(first.id);
    expect(grants.list().map((g) => [g.agentId, g.modes, g.note])).toEqual([
      ["pm-1", ["write"], "改成只写"],
      ["tm-1", ["read"], ""],
    ]);
  });

  it("以后都允许：并进已有的、变成长期有效；过期了的只留这次要的", () => {
    const { notes, other, grants, setNow } = setup();
    grants.add({ agentId: "secretary", path: notes, modes: ["read"], expiresAt: nowIso(new Date(NOW + DAY)), note: "笔记", addedBy: "user" });
    const merged = grants.allow("secretary", notes, ["write"]);
    expect(merged).toMatchObject({ modes: ["read", "write"], note: "笔记", addedBy: "approval" });
    expect(merged.expiresAt).toBeUndefined();
    grants.add({ agentId: "secretary", path: other, modes: ["read", "delete"], expiresAt: nowIso(new Date(NOW + DAY)), addedBy: "user" });
    setNow(NOW + 2 * DAY);
    expect(grants.allow("secretary", other, ["write"]).modes).toEqual(["write"]);
  });
});

describe("删、清", () => {
  it("删一条、清掉已过期的、清掉某个 agent 的", () => {
    const { notes, other, grants, setNow } = setup();
    const a = grants.add({ agentId: "pm-1", path: notes, modes: ["read"], expiresAt: nowIso(new Date(NOW + DAY)), addedBy: "user" });
    grants.add({ agentId: "pm-1", path: other, modes: ["read"], addedBy: "user" });
    grants.add({ agentId: "tm-1", path: notes, modes: ["read"], addedBy: "user" });
    const s = grants.add({ agentId: "secretary", path: notes, modes: ["read"], addedBy: "user" });
    setNow(NOW + 2 * DAY);
    expect(grants.clear({ expired: true })).toBe(1);
    expect(grants.list().some((g) => g.id === a.id)).toBe(false);
    expect(grants.clear({ agentId: "pm-1" })).toBe(1);
    expect(grants.remove([s.id, "nope"])).toBe(1);
    expect(grants.list().map((g) => g.agentId)).toEqual(["tm-1"]);
  });

  it("文件坏了当没有（记一条日志），下次存的时候整份重写", () => {
    const { file, notes, grants, logs } = setup();
    fs.writeFileSync(file, "{坏的");
    expect(grants.list()).toEqual([]);
    expect(logs.some((l) => l.includes("读不出来"))).toBe(true);
    grants.add({ agentId: "pm-1", path: notes, modes: ["read"], addedBy: "user" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ format: 1, grants: [{ agentId: "pm-1" }] });
  });
});

describe("设置页看的样子", () => {
  it("标出已过期、找不到了；认不得的 agent 不写名字；带上授权的文件夹", () => {
    const { notes, other, grants, setNow } = setup();
    grants.add({ agentId: "pm-1", path: notes, modes: ["read"], expiresAt: nowIso(new Date(NOW + DAY)), addedBy: "user" });
    grants.add({ agentId: "tm-1", path: other, modes: ["read"], addedBy: "user" });
    setNow(NOW + 2 * DAY);
    fs.rmSync(other, { recursive: true });
    const view = folderGrantsView(grants.list(), {
      now: NOW + 2 * DAY,
      labelOf: (id) => (id === "pm-1" ? "项目「记账本」的负责人" : undefined),
      authorizedFolders: ["D:\\照片"],
      isDirectory: (dir) => fs.existsSync(dir),
    });
    expect(view.grants.map((g) => [g.agentId, g.agentLabel, g.state])).toEqual([
      ["pm-1", "项目「记账本」的负责人", "expired"],
      ["tm-1", undefined, "missing"],
    ]);
    expect(view.authorizedFolders).toEqual(["D:\\照片"]);
  });
});

describe("快到期的提示", () => {
  it("三天内到期、没提示过的放一条；过期了的、提示过的、长期有效的不放", () => {
    const { notes, other, root, grants, setNow } = setup();
    const third = path.join(root, "third");
    fs.mkdirSync(third);
    const soon = grants.add({ agentId: "pm-1", path: notes, modes: ["read", "write"], expiresAt: nowIso(new Date(NOW + 2 * DAY)), addedBy: "user" });
    grants.add({ agentId: "pm-1", path: other, modes: ["read"], expiresAt: nowIso(new Date(NOW + 10 * DAY)), addedBy: "user" });
    grants.add({ agentId: "secretary", path: third, modes: ["read"], addedBy: "user" });
    const added: Array<Record<string, unknown>> = [];
    const jobs: string[] = [];
    let at = NOW;
    const reminders = createFolderGrantExpiryNotices({
      grants,
      inbox: { add: (item) => (added.push(item as Record<string, unknown>), item as unknown as InboxItem) },
      internalJobs: { register: (job) => (jobs.push(job.name), () => {}) },
      clock: { now: () => at },
      agentName: () => "项目「记账本」的负责人",
      timeText: (iso) => iso.slice(0, 10),
      log: () => {},
    });
    reminders.start();
    expect(jobs).toEqual(["folder_grant_expiry_check"]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "notice", notice: "folder_grant_expiring", urgency: "non_blocking", data: { grantId: soon.id, agentId: "pm-1" } });
    expect(String(added[0]!.body)).toContain("项目「记账本」的负责人");
    expect(String(added[0]!.body)).toContain("读、写");
    reminders.check();
    expect(added).toHaveLength(1);
    expect(grants.list().find((g) => g.id === soon.id)?.remindedAt).toBeDefined();
    // 过了八天：第一条早过期了（不再提示），第二条进了三天之内
    at = NOW + 8 * DAY;
    setNow(at);
    reminders.check();
    expect(added).toHaveLength(2);
    expect(added[1]).toMatchObject({ data: { path: fs.realpathSync.native(other) } });
  });
});
