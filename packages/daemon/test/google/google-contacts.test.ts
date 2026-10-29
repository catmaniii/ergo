// Google 插件的联系人导入（301 号票）在假内核里（startPluginKernel：真的插件宿主、数据源那一层、导入文件夹），个人档案换成记下调用的
// 假的（合成核对卡时在假内核里真建一张，测试能把它改成处理完了），vCard 都是编的（helpers/fake-vcard.ts）：
// - 设置 · 数据源里的 Google · 联系人：手动导入、只有导入、认 vCard、导入的进档案候选不进素材；
// - 放进一份 vCard → 交给档案候选（来源 vcard、数据源 google-contacts）：本人那张进本人、家人带着关系、档案里有的按昵称对上、
//   重复的卡片合起来、只有电话的不进；当场一张卡；导入结果写明；同一份再放一次不重复交；换了号码的只交新号码、等上一张卡处理完；
// - 几百人的：只取有生日的，一张卡最多 10 个人，处理完接着交下一批；
// - 空的、不是 vCard 的留在导入文件夹并写明；
// - 插件停用时卡处理了的，启用时补交；删除已导入的：记录换成标记、条数归零。
import fs from "node:fs";
import path from "node:path";
import { isDeletedEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { GOOGLE_CONTACT, GOOGLE_CONTACTS_OFFERED } from "../../src/google/contacts-events.ts";
import { GOOGLE_CHANNEL } from "../../src/google/events.ts";
import { createGooglePlugin } from "../../src/google/plugin.ts";
import type { PersonForMemory } from "../../src/personal-files/index.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { fakePersonalFiles } from "../helpers/fake-personal-files.ts";
import { bigAddressBook, GOOGLE_CONTACTS_VCF, GOOGLE_CONTACTS_VCF_NEW_PHONE, SELF_NAME } from "../helpers/fake-vcard.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

const SOURCE = "google-contacts";
let keySeq = 0;
const key = () => `gc-${++keySeq}`;

const PEOPLE: PersonForMemory[] = [
  { id: "me", kind: "self", name: SELF_NAME, aliases: [] },
  { id: "p-1", kind: "person", name: "老周", aliases: ["周哥"] },
];

async function start() {
  const files = fakePersonalFiles({ people: () => PEOPLE });
  const k = await startPluginKernel({ plugins: [createGooglePlugin()], services: [extraService(KERNEL.personalFiles, () => files.service)] });
  files.attach(k);
  return { k, files };
}

const sourceOf = (k: PluginKernel) => k.dataSources.view().sources.find((s) => s.id === SOURCE)!;
/** 往导入文件夹放一个文件、看一遍 */
async function drop(k: PluginKernel, name: string, content: string | Buffer) {
  fs.mkdirSync(k.layout.imports, { recursive: true });
  fs.writeFileSync(path.join(k.layout.imports, name), content);
  await k.dataSources.scan();
}
const live = (k: PluginKernel, type: string) => k.store.read(GOOGLE_CHANNEL, 0, type).filter((e) => !isDeletedEventPayload(e.payload));
/** 最后一次交给档案候选的那批 */
const lastBatch = (files: ReturnType<typeof fakePersonalFiles>) => files.calls.at(-1)!;
/** 最后合成的那张卡（假内核里真建的） */
const lastCard = (k: PluginKernel) =>
  k.store
    .read("cards", 0, "card")
    .map((e) => (e.payload as { card: { id: string; status: string; payload: { names: string[] } } }).card)
    .at(-1)!;

describe("设置 · 数据源里的 Google · 联系人", () => {
  it("手动导入、只有导入（去档案候选、不进素材）、认 vCard；排在 Google · 日历、Gmail 后面", async () => {
    const { k } = await start();
    const google = k.dataSources.view().sources.filter((s) => s.plugin === "google");
    expect(google.map((s) => s.id)).toEqual(["google-calendar", "google-gmail", SOURCE]);
    expect(sourceOf(k)).toMatchObject({
      title: "Google · 联系人",
      pluginTitle: "Google",
      connection: "manual",
      usages: [{ usage: "import", on: true }],
      destination: "进档案候选核对卡（逐条确认才写），不进素材",
      files: ["Google 联系人导出的 vCard（.vcf）"],
      canSync: false,
      count: 0,
    });
  });
});

describe("放进一份 vCard", () => {
  it("交给档案候选：本人、家人带关系、档案里有的、有日子的；只有电话的不进；当场一张卡；再放一次不重复交", async () => {
    const { k, files } = await start();
    await drop(k, "contacts.vcf", GOOGLE_CONTACTS_VCF);
    expect(files.calls).toHaveLength(1);
    const imported = { materialIds: [], heard: [], dataSource: SOURCE };
    expect(lastBatch(files)).toEqual({
      origin: "vcard",
      inputs: [
        {
          name: "me",
          aliases: [],
          fields: [
            { field: "birthday", value: "1992-05-20" },
            { field: "anniversary:纪念日", value: "2018-10-01" },
            { field: "phone", value: "13800000001" },
            { field: "address", value: "浙江省杭州市某某路 9 号" },
          ],
          ...imported,
        },
        { name: "周建国", aliases: ["老周"], fields: [{ field: "phone", value: "13700000003" }], ...imported },
        {
          name: "张丽",
          aliases: [],
          relation: "母亲",
          fields: [
            { field: "birthday", value: "03-02" },
            { field: "phone", value: "13900000002", also: ["057188000002"] },
          ],
          ...imported,
        },
        { name: "王大伟", aliases: [], relation: "配偶", fields: [], ...imported },
        {
          name: "李芳",
          aliases: [],
          fields: [
            { field: "birthday", value: "1990-08-15" },
            { field: "anniversary:相识纪念日", value: "2012-05-20" },
            { field: "phone", value: "13600000004", also: ["02112345678"] },
          ],
          ...imported,
        },
      ],
    });
    // 当场一张卡；导入结果写明几人进、几人没进；"共几条"是几个人；文件挪进已导入
    expect(lastCard(k)).toMatchObject({ status: "pending", payload: { names: ["me", "周建国", "张丽", "王大伟", "李芳"] } });
    const view = k.dataSources.view();
    expect(view.sources.find((s) => s.id === SOURCE)).toMatchObject({
      count: 5,
      lastSync: { trigger: "file", file: "contacts.vcf", added: 5, summary: "5 人进档案候选；另有 1 人没进候选（没有生日、纪念日、关系，档案里也还没有）" },
    });
    expect(view.folder.recent.map((r) => [r.name, r.source, r.added])).toEqual([["contacts.vcf", SOURCE, 5]]);
    expect(fs.readdirSync(k.layout.importedDir)).toEqual(["contacts.vcf"]);
    // 日志里没有名字、号码
    expect(k.logs.filter((l) => l.includes("Google 联系人")).some((l) => /张丽|13900000002/.test(l))).toBe(false);

    // 同一份再放一次：什么都不交、不记
    await drop(k, "contacts.vcf", GOOGLE_CONTACTS_VCF);
    expect(files.calls).toHaveLength(1);
    expect(live(k, GOOGLE_CONTACT)).toHaveLength(5);
    expect(sourceOf(k)).toMatchObject({ count: 5, lastSync: { added: 0, summary: "没有要进档案的；5 人之前导过、没有新的；另有 1 人没进候选（没有生日、纪念日、关系，档案里也还没有）" } });
    expect(fs.readdirSync(k.layout.importedDir).toSorted()).toEqual(["contacts (2).vcf", "contacts.vcf"]);

    // 张丽换了手机号：只记这一个新号码；上一张卡还没处理，等它处理完才交
    await drop(k, "contacts-new.vcf", GOOGLE_CONTACTS_VCF_NEW_PHONE);
    expect(files.calls).toHaveLength(1);
    expect(sourceOf(k)).toMatchObject({ count: 5, lastSync: { added: 1, summary: "1 人进档案候选；上一张核对卡处理完就上卡；4 人之前导过、没有新的；另有 1 人没进候选（没有生日、纪念日、关系，档案里也还没有）" } });
    files.handle(lastCard(k).id);
    expect(lastBatch(files).inputs).toEqual([{ name: "张丽", aliases: [], fields: [{ field: "phone", value: "13900000012", also: ["057188000002"] }], ...imported }]);
    expect(live(k, GOOGLE_CONTACTS_OFFERED).map((e) => (e.payload as { ids: string[] }).ids.length)).toEqual([5, 1]);
  });

  it("几百人的通讯录：只取有生日的；一张卡最多 10 个人，处理完接着交下一批", async () => {
    const { k, files } = await start();
    await drop(k, "contacts.vcf", bigAddressBook(25, 275));
    expect(files.calls.map((c) => c.inputs.length)).toEqual([10]);
    expect(sourceOf(k).lastSync).toMatchObject({ added: 25, summary: "25 人进档案候选；这次先上卡 10 人，处理完接着上；另有 275 人没进候选（没有生日、纪念日、关系，档案里也还没有）" });
    expect(lastBatch(files).inputs.map((i) => i.name)).toEqual(Array.from({ length: 10 }, (_, i) => `联系人${String(i + 1).padStart(3, "0")}`));
    // 卡还没处理：再看一遍文件夹也不交
    await k.dataSources.scan();
    expect(files.calls).toHaveLength(1);
    files.handle(lastCard(k).id);
    expect(files.calls.map((c) => c.inputs.length)).toEqual([10, 10]);
    expect(lastBatch(files).inputs[0]!.name).toBe("联系人011");
    files.handle(lastCard(k).id);
    files.handle(lastCard(k).id);
    expect(files.calls.map((c) => c.inputs.length)).toEqual([10, 10, 5]);
    expect(sourceOf(k).count).toBe(25);
  });

  it("空的、不是 vCard 的留在导入文件夹并写明原因", async () => {
    const { k, files } = await start();
    await drop(k, "empty.vcf", "BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n");
    await drop(k, "notes.vcf", "随手记的几个号码\n");
    expect(k.dataSources.view().folder.pending.map((p) => [p.name, p.problem, p.text])).toEqual([
      ["empty.vcf", "failed", "导入出错：文件里没有认得出的联系人（要 Google 联系人导出的 vCard）"],
      ["notes.vcf", "unrecognized", "认不出是哪个数据源的文件，留在这里"],
    ]);
    expect(files.calls).toEqual([]);
  });
});

describe("停用、删除", () => {
  it("插件停着时那张卡处理了：启用时补交下一批；删除已导入的：记录换成标记、条数归零", async () => {
    const { k, files } = await start();
    await drop(k, "contacts.vcf", bigAddressBook(15, 0));
    expect(files.calls.map((c) => c.inputs.length)).toEqual([10]);
    await k.settings.act("google", { action: "disable", idempotencyKey: key() });
    files.handle(lastCard(k).id);
    expect(files.calls).toHaveLength(1);
    expect(sourceOf(k)).toMatchObject({ available: false });
    await k.settings.act("google", { action: "enable", idempotencyKey: key() });
    expect(files.calls.map((c) => c.inputs.length)).toEqual([10, 5]);

    const purged = await k.dataSources.act(SOURCE, { action: "disconnect", purge: true, idempotencyKey: key() });
    // 15 个人、两批、一条导入记录
    expect(purged.purged).toMatchObject({ events: 18, files: 1 });
    expect(live(k, GOOGLE_CONTACT)).toEqual([]);
    expect(live(k, GOOGLE_CONTACTS_OFFERED)).toEqual([]);
    expect(sourceOf(k).count).toBe(0);
    expect(fs.readdirSync(k.layout.importedDir)).toEqual([]);
    // 记录没了：再导就是从头来
    await drop(k, "contacts.vcf", bigAddressBook(3, 0));
    expect(lastBatch(files).inputs.map((i) => i.name)).toEqual(["联系人001", "联系人002", "联系人003"]);
  });
});
