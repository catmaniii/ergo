// 主切面：Google 联系人从 vCard 导入进档案候选（301 号票）。真的守护进程走组合根和插件清单（Google 插件在清单里），往导入文件夹放一份编的
// vCard（helpers/fake-vcard.ts，照 Google 联系人导出的样子），经 POST /api/import-folder 看一遍：
// - 认出是 Google · 联系人的、挪进已导入；当场一张候选核对卡（进待办，来源"导入的通讯录"）按人列出：本人（"我的名字"那张）的生日、
//   纪念日、电话、住址，家人带着关系建档，档案里已有的"老周"按昵称对上（补电话、把通讯录里的称呼记成别名），有生日、纪念日的新人建档；
//   只有电话的不进；电话逐位核对、生日纪念日带每年提醒的勾；
// - 逐条确认后写进档案（留痕：从导入的通讯录来的、你确认的），不勾建档的人不建；不进记忆素材；
// - 同一份再放一次：不出新的卡、不重复问；
// - 几百人的：一张卡最多 10 个人，处理完接着出下一张；删除已导入的：还没处理的候选、卡上的值跟着删，卡作废。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  type HttpErrorBody,
  type PersonalFilesView,
  type PersonalFileSuggestCardPayload,
  type PersonalFileView,
  PURGED_TEXT,
  SELF_PERSON_ID,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { GOOGLE_CHANNEL } from "../../src/google/events.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { bigAddressBook, GOOGLE_CONTACTS_VCF, SELF_NAME } from "../helpers/fake-vcard.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { dataSourcesApi, requestJson, userNameApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { cards: CARDS, inbox: INBOX } = CHANNELS;
const SOURCE = "google-contacts";

let n = 0;
const key = () => `gcontacts-${++n}`;
const filesApi = {
  list: (url: string) => requestJson<PersonalFilesView & HttpErrorBody>(url, HTTP_PATHS.personalFiles),
  get: (url: string, id: string) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFile(id)),
  add: (url: string, body: unknown) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFiles, { method: "POST", body }),
};
const suggestCards = (frontend: TestFrontend): Card[] =>
  frontend
    .events({ channel: CARDS, type: EVENT_TYPES.card })
    .map((f) => (f.payload as CardEventPayload).card)
    .filter((c) => c.type === "personal_file_suggest");
const cardIds = (frontend: TestFrontend) => [...new Set(suggestCards(frontend).map((c) => c.id))];
const latestCard = (frontend: TestFrontend, id: string): Card => suggestCards(frontend).filter((c) => c.id === id).at(-1)!;
/** 卡上列了哪几个人 */
const people = (c: Card) => [...new Set((c.payload as PersonalFileSuggestCardPayload).items.map((i) => i.person.name))];
const fieldOf = (file: PersonalFileView, field: string) => file.fields.find((f) => f.field === field);
const fileNamed = async (url: string, name: string) => {
  const summary = (await filesApi.list(url)).body.files.find((f) => f.name === name);
  return summary === undefined ? undefined : (await filesApi.get(url, summary.id)).body;
};

/** 往导入文件夹放一个文件（修改时间拨到一分钟前：刚写的文件算"还在写"，不碰）、看一遍 */
async function drop(td: TestDaemon, name: string, content: string) {
  const { imports } = dataDirLayout(td.dataDir);
  fs.mkdirSync(imports, { recursive: true });
  const file = path.join(imports, name);
  fs.writeFileSync(file, content);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
  const scanned = await dataSourcesApi.folder(td.url, { action: "scan" });
  expect(scanned.status).toBe(200);
  return scanned.body.view;
}

describe("Google 联系人：vCard 导入进档案候选", () => {
  it("放进一份 vCard → 候选卡按人列出 → 逐条确认写进档案；再放一次不重复", { timeout: 90_000 }, async () => {
    const td = await startTestDaemon({ plugins: ["reminders", "google"] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CARDS]: 0, [INBOX]: 0 });
    expect((await userNameApi.change(td.url, SELF_NAME)).status).toBe(200);
    const zhou = (await filesApi.add(td.url, { name: "老周", relation: "朋友" })).body;

    // 放进去：认出是 Google · 联系人的、挪进已导入；5 人进候选、只有电话的赵六不进
    const view = await drop(td, "contacts.vcf", GOOGLE_CONTACTS_VCF);
    expect(view.folder.pending).toEqual([]);
    expect(view.folder.recent.map((r) => [r.name, r.source, r.sourceTitle, r.added])).toEqual([["contacts.vcf", SOURCE, "Google · 联系人", 5]]);
    expect(view.sources.find((s) => s.id === SOURCE)).toMatchObject({
      connection: "manual",
      count: 5,
      lastSync: { trigger: "file", summary: "5 人进档案候选；另有 1 人没进候选（没有生日、纪念日、关系，档案里也还没有）" },
    });

    // 当场一张候选核对卡（进待办，来源"导入的通讯录"），按人列出
    await waitUntil(() => cardIds(frontend).length === 1, { describe: () => "等候选核对卡" });
    const card = latestCard(frontend, cardIds(frontend)[0]!);
    const payload = card.payload as PersonalFileSuggestCardPayload;
    expect(payload.items.map((i) => [i.kind, i.person.name, i.person.relation ?? "", i.field ?? "", i.value ?? "", i.origin])).toEqual([
      ["field", "我", "", "birthday", "1992-05-20", "vcard"],
      ["field", "我", "", "anniversary:纪念日", "2018-10-01", "vcard"],
      ["field", "我", "", "phone", "13800000001", "vcard"],
      ["field", "我", "", "address", "浙江省杭州市某某路 9 号", "vcard"],
      ["field", "老周", "", "phone", "13700000003", "vcard"],
      ["field", "老周", "", "aliases", "周建国", "vcard"],
      ["create", "张丽", "母亲", "", "", "vcard"],
      ["field", "张丽", "母亲", "birthday", "03-02", "vcard"],
      ["field", "张丽", "母亲", "phone", "13900000002", "vcard"],
      ["create", "王大伟", "配偶", "", "", "vcard"],
      ["create", "李芳", "", "", "", "vcard"],
      ["field", "李芳", "", "birthday", "1990-08-15", "vcard"],
      ["field", "李芳", "", "anniversary:相识纪念日", "2012-05-20", "vcard"],
      ["field", "李芳", "", "phone", "13600000004", "vcard"],
    ]);
    // 电话逐位核对、生日纪念日带每年提醒的勾
    expect(payload.items.filter((i) => i.field === "phone").every((i) => i.number === true)).toBe(true);
    expect(payload.items.find((i) => i.person.name === "张丽" && i.field === "birthday")!.remind).toEqual({ month: 3, day: 2, daysBefore: 3 });
    expect(payload.items.find((i) => i.field === "anniversary:纪念日")!.remind).toEqual({ month: 10, day: 1, daysBefore: 3 });
    expect(card.text).toContain("建档：张丽（母亲，从导入的通讯录来的）");
    const inboxItem = frontend
      .events({ channel: INBOX, type: EVENT_TYPES.inboxItem })
      .map((f) => (f.payload as { item: { cardId?: string; source?: string } }).item)
      .find((i) => i.cardId === card.id);
    expect(inboxItem?.source).toBe("导入的通讯录");
    // 不进记忆素材
    expect(td.daemon.materials.list().some((m) => m.ref.event.channel === GOOGLE_CHANNEL)).toBe(false);

    // 逐条确认：不建李芳（她的几条跟着不写），别的都写
    const skip = new Set(payload.items.filter((i) => i.person.name === "李芳").map((i) => i.id));
    await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { accept: payload.items.filter((i) => !skip.has(i.id)).map((i) => i.id), remind: [] } });
    await waitUntil(() => latestCard(frontend, card.id).status === "handled", { describe: () => "等候选核对卡处理完" });
    const me = (await filesApi.get(td.url, SELF_PERSON_ID)).body;
    expect(fieldOf(me, "birthday")?.current).toMatchObject({ value: "1992-05-20", source: { via: "curator", basis: "confirmed", origin: "vcard" } });
    expect([fieldOf(me, "anniversary:纪念日")?.current?.value, fieldOf(me, "phone")?.current?.value, fieldOf(me, "address")?.current?.value]).toEqual(["2018-10-01", "13800000001", "浙江省杭州市某某路 9 号"]);
    const zhouFile = (await filesApi.get(td.url, zhou.id)).body;
    expect([fieldOf(zhouFile, "phone")?.current?.value, fieldOf(zhouFile, "aliases")?.current?.value]).toEqual(["13700000003", "周建国"]);
    const mom = (await fileNamed(td.url, "张丽"))!;
    expect([fieldOf(mom, "relation")?.current?.value, fieldOf(mom, "birthday")?.current?.value, fieldOf(mom, "phone")?.current?.value]).toEqual(["母亲", "03-02", "13900000002"]);
    expect(fieldOf((await fileNamed(td.url, "王大伟"))!, "relation")?.current?.value).toBe("配偶");
    expect(await fileNamed(td.url, "李芳")).toBeUndefined();

    // 同一份再放一次：不出新卡、不重复问（李芳拒过的建档也不再问）
    const again = await drop(td, "contacts.vcf", GOOGLE_CONTACTS_VCF);
    expect(again.sources.find((s) => s.id === SOURCE)).toMatchObject({ count: 5, lastSync: { added: 0, summary: "没有要进档案的；5 人之前导过、没有新的；另有 1 人没进候选（没有生日、纪念日、关系，档案里也还没有）" } });
    expect(again.folder.recent.map((r) => [r.name, r.added])).toEqual([
      ["contacts.vcf", 0],
      ["contacts.vcf", 5],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(cardIds(frontend)).toEqual([card.id]);
  });

  it("几百人的：一张卡最多 10 个人，处理完接着出下一张；删除已导入的：还没处理的候选和卡上的值跟着删、卡作废", { timeout: 90_000 }, async () => {
    const td = await startTestDaemon({ plugins: ["reminders", "google"] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CARDS]: 0, [INBOX]: 0 });

    const view = await drop(td, "contacts.vcf", bigAddressBook(12, 288));
    expect(view.sources.find((s) => s.id === SOURCE)!.lastSync?.summary).toBe("12 人进档案候选；这次先上卡 10 人，处理完接着上；另有 288 人没进候选（没有生日、纪念日、关系，档案里也还没有）");
    await waitUntil(() => cardIds(frontend).length === 1, { describe: () => "等第一张卡" });
    const first = latestCard(frontend, cardIds(frontend)[0]!);
    expect(people(first)).toHaveLength(10);

    // 都不用 → 接着出第二张（剩下的两个人）
    await frontend.cardAction({ cardId: first.id, action: "reject", expectedVersion: first.version });
    await waitUntil(() => cardIds(frontend).length === 2, { describe: () => `卡：${cardIds(frontend).length}` });
    const second = latestCard(frontend, cardIds(frontend)[1]!);
    expect(people(second)).toEqual(["联系人011", "联系人012"]);

    // 删除已导入的（只靠导入文件夹的数据源，"断开并删"）：记录换成标记、第二张卡上的值删掉并作废、"已导入"里的文件删掉
    const purged = await dataSourcesApi.act(td.url, SOURCE, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(purged.status).toBe(200);
    expect(purged.body.view.sources.find((s) => s.id === SOURCE)).toMatchObject({ count: 0 });
    await waitUntil(() => latestCard(frontend, second.id).status === "expired", { describe: () => `第二张卡：${latestCard(frontend, second.id).status}` });
    const gone = latestCard(frontend, second.id).payload as PersonalFileSuggestCardPayload;
    expect(gone.items.every((i) => i.person.name === PURGED_TEXT && (i.value === undefined || i.value === PURGED_TEXT))).toBe(true);
    expect(JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000).map((e) => e.payload))).not.toContain("联系人012");
    expect(fs.readdirSync(dataDirLayout(td.dataDir).importedDir)).toEqual([]);
  });
});
