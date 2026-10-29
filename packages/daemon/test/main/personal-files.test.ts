// 主切面：个人档案（281 号票，用户 2026-10-25 定："每个人单独建立一个档案库……对我自己，我重要的一些人会专门记一些重要的事情"）。
// 档案放内核（停用记忆插件也照常），写进去的都经用户确认：秘书用快速动作 personal_file 提议，号码类出核对卡逐位列出；
// 原话里明说了的非号码类直接写（聊天里留"已执行"的回执）；用户在档案页里直接改的改了就算确认。秘书用 read_personal_file 按人、按字段读。
// 这里跑的是真的守护进程（模型是 faux）：
// - "记住我身份证号是……"：核对卡逐位列出 → 确认后档案里有，按字段读回一字不差；"我搬家了，新地址是……"直接写、历史里有旧的；
//   彻底删除（连出处那句话）之后事件库里不留号码；
// - 档案页建"妈妈"、记下一件事、改生日；删掉后读不到，彻底删除后事件库里不留原值；忘掉的事件日志里原话还在；
// - 本人档案的姓名就是"我的名字"：改一边另一边跟着变；
// - 285 号票：档案里的人分组——建人时选、不选按关系猜、档案页上改，秘书经快速动作建的人按关系猜；
// - 停用记忆插件，档案页和秘书的读写照常。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  type HttpErrorBody,
  type MessageEventPayload,
  numberGroups,
  type PersonalFileCardPayload,
  type PersonalFileDeleteResult,
  type PersonalFilesView,
  type PersonalFileView,
  type QuickActionCardPayload,
  SELF_PERSON_ID,
  type ToolCallDetail,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemonHandle } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { requestJson, toolCallDetail, userNameApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX } = CHANNELS;
const ALL = { [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0 };

// 示例数据全是编的：身份证号、手机号是明显的假号码
const ID_CARD = "110101199003071234";
const OLD_ADDRESS = "杭州市西湖区文三路 18 号";
const NEW_ADDRESS = "上海市徐汇区漕溪北路 9 号";

const propose = (params: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type: "personal_file", params } as never }] });
const read = (args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name: "read_personal_file", arguments: args as never }] });
/** 秘书的回复不回显上下文：彻底删除的用例要查事件库里还有没有号码，秘书自己转述的话本来就删不掉（PURGE_LIMITS） */
const OK: FauxStep = { kind: "reply", text: "好的。" };

const filesApi = {
  list: (url: string) => requestJson<PersonalFilesView & HttpErrorBody>(url, HTTP_PATHS.personalFiles),
  get: (url: string, id: string) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFile(id)),
  add: (url: string, body: unknown) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFiles, { method: "POST", body }),
  change: (url: string, id: string, body: unknown) => requestJson<PersonalFileView & HttpErrorBody>(url, HTTP_PATHS.personalFile(id), { method: "POST", body }),
  remove: (url: string, id: string, body: unknown) => requestJson<PersonalFileDeleteResult & HttpErrorBody>(url, HTTP_PATHS.personalFileDelete(id), { method: "POST", body }),
};

const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).length;

/** 用户说一句，等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string) {
  const before = turnEnds(frontend);
  const sent = await frontend.sendText(text);
  await waitUntil(() => turnEnds(frontend) > before, { timeoutMs: 30_000, describe: () => `等秘书处理完「${text.slice(0, 12)}」` });
  return sent;
}

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const latestCard = (frontend: TestFrontend, id: string): Card => cardsOf(frontend).filter((c) => c.id === id).at(-1)!;
const executions = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.quickActionExecuted }).length;

/** 某个工具最近一次调用的完整返回（读档案的结果给模型看的那份） */
async function lastResultOf(frontend: TestFrontend, url: string, tool: string): Promise<string> {
  const part = frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
    .findLast((p) => p.type === "tool_call" && p.tool === tool);
  if (part?.type !== "tool_call") throw new Error(`没有 ${tool} 的调用`);
  return ((await toolCallDetail(url, part.callId)).body as ToolCallDetail).result;
}

const fieldOf = (file: PersonalFileView, field: string) => file.fields.find((f) => f.field === field);
/** 事件库里负载含这段文字的事件（彻底删除后应该一条都没有） */
const eventsContaining = (daemon: TestDaemonHandle, text: string) =>
  daemon.store.reader.all<{ channel: string; type: string }>("SELECT channel, type FROM events WHERE instr(payload, ?) > 0", text).map((r) => `${r.channel}/${r.type}`);

describe("秘书写档案：号码出核对卡逐位列出，确认后按字段读回一字不差", () => {
  it("\"记住我身份证号是……\"：核对卡逐位列出 → 确认后档案里有、读得回；搬家后读到新地址、历史里有旧的；彻底删除连出处后事件库里不留号码", async () => {
    const { url, daemon } = await startTestDaemon({
      secretary: [
        propose({ person: "我", fields: [{ field: "身份证号", value: ID_CARD }] }),
        OK,
        read({ person: "我", fields: ["身份证号"] }),
        OK,
        propose({ person: "我", fields: [{ field: "住址", value: OLD_ADDRESS }] }),
        OK,
        propose({ person: "我", fields: [{ field: "住址", value: NEW_ADDRESS }] }),
        OK,
        read({ person: "我", fields: ["住址"] }),
        OK,
      ],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);

    // ① 号码类：不论点没点明都出核对卡，同时进待我处理；还没写进档案
    const sent = await tell(frontend, `记住我身份证号是 ${ID_CARD}`);
    const [card, ...others] = cardsOf(frontend);
    expect(others).toEqual([]);
    expect(card).toMatchObject({ type: "personal_file", status: "pending" });
    const payload = card!.payload as PersonalFileCardPayload;
    expect(payload.person).toMatchObject({ id: SELF_PERSON_ID, kind: "self", isNew: false });
    expect(payload.fields).toEqual([{ field: "id_card", label: "身份证号", value: ID_CARD, number: true }]);
    // 逐位列出：身份证号按 6 · 8 · 4 分组（地区、出生日期、顺序码和校验码）
    expect(numberGroups(ID_CARD)).toEqual([["1", "1", "0", "1", "0", "1"], ["1", "9", "9", "0", "0", "3", "0", "7"], ["1", "2", "3", "4"]]);
    // 认不得这种卡的前端看纯文本：号码也是一位一位的
    expect(card!.text).toContain("1 1 0 1 0 1 · 1 9 9 0 0 3 0 7 · 1 2 3 4");
    expect(frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).length).toBe(1);
    expect(fieldOf((await filesApi.get(url, SELF_PERSON_ID)).body, "id_card")?.current).toBeUndefined();

    // 确认后写进档案：一字不差，出处是秘书转达、用户在核对卡上确认的那句话
    await frontend.cardAction({ cardId: card!.id, action: "execute", expectedVersion: card!.version });
    await waitUntil(() => executions(frontend) === 1, { describe: () => "等核对卡上的确认执行" });
    expect(latestCard(frontend, card!.id).status).toBe("handled");
    const afterConfirm = (await filesApi.get(url, SELF_PERSON_ID)).body;
    expect(fieldOf(afterConfirm, "id_card")?.current).toMatchObject({ value: ID_CARD, source: { via: "secretary", basis: "confirmed", messageId: sent.messageId } });

    // ② 秘书按字段读：拿到确认过的原值
    await tell(frontend, "我的身份证号是多少？");
    expect(await lastResultOf(frontend, url, "read_personal_file")).toContain(ID_CARD);

    // ③ 原话里明说了的住址（不是号码）：直接写，聊天里留"已执行"的回执
    await tell(frontend, `我搬家了，新地址是${OLD_ADDRESS}`);
    const receipt = cardsOf(frontend).findLast((c) => c.type === "quick_action")!;
    expect(receipt).toMatchObject({ status: "handled", payload: { action: { type: "personal_file" }, explicit: true } });
    expect((receipt.payload as QuickActionCardPayload).content).toContain(OLD_ADDRESS);
    expect(fieldOf((await filesApi.get(url, SELF_PERSON_ID)).body, "address")?.current).toMatchObject({ value: OLD_ADDRESS, source: { via: "secretary", basis: "explicit" } });

    // 又搬了：读到新地址，旧的记成历史（到某天为止）
    await tell(frontend, `又搬家了，新地址是${NEW_ADDRESS}`);
    const moved = fieldOf((await filesApi.get(url, SELF_PERSON_ID)).body, "address")!;
    expect(moved.current?.value).toBe(NEW_ADDRESS);
    expect(moved.history).toMatchObject([{ value: OLD_ADDRESS, until: expect.any(String) }]);
    await tell(frontend, "我以前住哪？");
    const history = await lastResultOf(frontend, url, "read_personal_file");
    expect(history).toContain(NEW_ADDRESS);
    expect(history).toContain(OLD_ADDRESS);

    // ④ 彻底删除身份证号，连出处那句话一起：档案里没有了，事件库里一条都不留（核对卡、操作记录、提议和读取的调用记录、用户的原话）
    expect(eventsContaining(daemon, ID_CARD).length).toBeGreaterThan(0);
    const removed = await filesApi.remove(url, SELF_PERSON_ID, { target: { kind: "field", field: "id_card" }, mode: "purge", withSources: true });
    expect(removed).toMatchObject({ status: 200, body: { sources: 1 } });
    const purged = fieldOf((await filesApi.get(url, SELF_PERSON_ID)).body, "id_card")!;
    expect(purged.current).toBeUndefined();
    expect(purged.history).toEqual([]);
    expect(eventsContaining(daemon, ID_CARD)).toEqual([]);
    expect(eventsContaining(daemon, "1 1 0 1 0 1 · 1 9 9 0")).toEqual([]);
    // 住址没动
    expect(fieldOf((await filesApi.get(url, SELF_PERSON_ID)).body, "address")?.current?.value).toBe(NEW_ADDRESS);
  });
});

describe("档案页：建重要的人、记下一件事、改生日；删人", () => {
  it("建\"妈妈\"、记下一件事、改生日（旧的进历史）；秘书读得到；彻底删除后读不到、事件库里不留原值；忘掉的人读不到但事件日志里原话还在", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [read({ person: "妈妈" }), OK, read({ person: "妈妈" }), OK] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);

    const added = await filesApi.add(url, { name: "妈妈", relation: "母亲" });
    expect(added.status).toBe(200);
    const mom = added.body;
    expect(mom).toMatchObject({ kind: "person", name: "妈妈" });
    expect(fieldOf(mom, "relation")?.current).toMatchObject({ value: "母亲", source: { via: "page" } });

    const noted = await filesApi.change(url, mom.id, { kind: "add_note", text: "腿脚不好，爬楼吃力", date: "2026-10-20" });
    expect(noted.body.notes).toMatchObject([{ text: "腿脚不好，爬楼吃力", date: "2026-10-20", source: { via: "page" } }]);
    await filesApi.change(url, mom.id, { kind: "set_field", field: "birthday", value: "3月2日" });
    const changed = await filesApi.change(url, mom.id, { kind: "set_field", field: "birthday", value: "3月5日" });
    expect(fieldOf(changed.body, "birthday")).toMatchObject({ current: { value: "3月5日" }, history: [{ value: "3月2日" }] });
    // 列表：本人那份在最前（一直在），然后是重要的人
    expect((await filesApi.list(url)).body.files.map((f) => [f.id, f.kind])).toEqual([
      [SELF_PERSON_ID, "self"],
      [mom.id, "person"],
    ]);

    await tell(frontend, "我妈生日哪天？");
    const seen = await lastResultOf(frontend, url, "read_personal_file");
    expect(seen).toContain("3月5日");
    expect(seen).toContain("腿脚不好，爬楼吃力");

    // 彻底删除：整份档案没了，秘书读不到；事件库里不留原值
    const purged = await filesApi.remove(url, mom.id, { target: { kind: "person" }, mode: "purge" });
    expect(purged).toMatchObject({ status: 200, body: { sources: 0 } });
    expect(purged.body.file).toBeUndefined();
    expect((await filesApi.list(url)).body.files.map((f) => f.id)).toEqual([SELF_PERSON_ID]);
    expect((await filesApi.get(url, mom.id)).status).toBe(404);
    await tell(frontend, "我妈生日哪天？");
    expect(await lastResultOf(frontend, url, "read_personal_file")).toContain("档案里没有「妈妈」");
    for (const text of ["腿脚不好，爬楼吃力", "3月5日", "3月2日", "母亲"]) expect(eventsContaining(daemon, text)).toEqual([]);

    // 忘掉：读不到，事件日志里原话还在（和忘掉素材一样）
    const zhang = (await filesApi.add(url, { name: "小张", relation: "表弟" })).body;
    await filesApi.change(url, zhang.id, { kind: "set_field", field: "work", value: "示例科技公司" });
    expect((await filesApi.remove(url, zhang.id, { target: { kind: "person" }, mode: "forget" })).status).toBe(200);
    expect((await filesApi.get(url, zhang.id)).status).toBe(404);
    expect(eventsContaining(daemon, "示例科技公司").length).toBeGreaterThan(0);

    // 本人那份删不掉
    expect((await filesApi.remove(url, SELF_PERSON_ID, { target: { kind: "person" }, mode: "forget" })).status).toBe(400);
  });
});

describe("档案里的人分组（285 号票）", () => {
  it("建人时选分组、不选按关系猜；档案页上改分组；本人那份改不了；秘书经快速动作建的人没选分组、按关系猜", async () => {
    const { url } = await startTestDaemon({ secretary: [propose({ person: "老周", relation: "同事", fields: [{ field: "单位", value: "示例科技公司" }] }), OK] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);

    const zhang = await filesApi.add(url, { name: "小张", relation: "同事", group: "important" });
    expect(zhang).toMatchObject({ status: 200, body: { group: "important" } });
    expect(zhang.body).not.toHaveProperty("groupGuessed");
    const mom = (await filesApi.add(url, { name: "妈妈", relation: "母亲" })).body;
    expect(mom).toMatchObject({ group: "family", groupGuessed: true });
    // 不认得的分组：接口的 schema 就拒
    expect((await filesApi.add(url, { name: "王师傅", group: "vip" })).status).toBe(400);

    const moved = await filesApi.change(url, mom.id, { kind: "set_group", group: "important" });
    expect(moved).toMatchObject({ status: 200, body: { group: "important" } });
    expect((await filesApi.change(url, SELF_PERSON_ID, { kind: "set_group", group: "family" })).status).toBe(400);

    // 秘书提议建的人（新建的人出核对卡，确认后建）：没选分组，按关系猜——同事猜不出，归其他人
    await tell(frontend, "记一下，我同事老周在示例科技公司上班");
    const card = cardsOf(frontend).find((c) => c.type === "personal_file")!;
    await frontend.cardAction({ cardId: card.id, action: "execute", expectedVersion: card.version });
    await waitUntil(() => executions(frontend) === 1, { describe: () => "等核对卡上的确认执行" });
    const list = (await filesApi.list(url)).body.files;
    expect(list.map((f) => [f.name ?? f.id, f.group ?? null, f.groupGuessed ?? false])).toEqual([
      [SELF_PERSON_ID, null, false],
      ["小张", "important", false],
      ["妈妈", "important", false],
      ["老周", "others", true],
    ]);
  });
});

describe("本人档案的姓名就是\"我的名字\"", () => {
  it("设置里改了我的名字，档案里的姓名跟着变；档案里改姓名、秘书按原话改，我的名字跟着变", async () => {
    const { url } = await startTestDaemon({ secretary: [propose({ person: "我", fields: [{ field: "姓名", value: "阿明" }] }), OK] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);

    expect(fieldOf((await filesApi.get(url, SELF_PERSON_ID)).body, "name")?.current).toBeUndefined();
    await userNameApi.change(url, "文翰");
    const me = (await filesApi.get(url, SELF_PERSON_ID)).body;
    expect(me.name).toBe("文翰");
    expect(fieldOf(me, "name")?.current?.value).toBe("文翰");

    await filesApi.change(url, SELF_PERSON_ID, { kind: "set_field", field: "name", value: "小明" });
    expect((await userNameApi.get(url)).body).toEqual({ name: "小明" });
    // 不合规的名字（超过 8 个字）照我的名字的规矩拒
    expect((await filesApi.change(url, SELF_PERSON_ID, { kind: "set_field", field: "name", value: "一二三四五六七八九" })).status).toBe(400);

    await tell(frontend, "以后叫我阿明，记住我叫阿明");
    await waitUntil(() => executions(frontend) === 1, { describe: () => "等改姓名直接执行" });
    expect((await userNameApi.get(url)).body).toEqual({ name: "阿明" });
    expect((await filesApi.get(url, SELF_PERSON_ID)).body.name).toBe("阿明");
  });
});

describe("停用记忆插件，档案照常", () => {
  it("记忆插件停用：秘书提议、核对卡确认、按字段读、档案页增删、彻底删除连出处都照常", async () => {
    const { url, daemon } = await startTestDaemon({
      memoryPlugin: false,
      secretary: [propose({ person: "我", fields: [{ field: "手机", value: "13800001111" }] }), OK, read({ person: "我" }), OK],
    });
    expect(daemon.plugins.running("memory")).toBe(false);
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe(ALL);

    await tell(frontend, "记住我手机号 13800001111");
    const card = cardsOf(frontend).find((c) => c.type === "personal_file")!;
    expect((card.payload as PersonalFileCardPayload).fields).toEqual([{ field: "phone", label: "手机", value: "13800001111", number: true }]);
    // 手机号按 3 · 4 · 4 分组
    expect(card.text).toContain("1 3 8 · 0 0 0 0 · 1 1 1 1");
    await frontend.cardAction({ cardId: card.id, action: "execute", expectedVersion: card.version });
    await waitUntil(() => executions(frontend) === 1);
    await tell(frontend, "我手机号多少");
    expect(await lastResultOf(frontend, url, "read_personal_file")).toContain("13800001111");

    const friend = (await filesApi.add(url, { name: "老周", relation: "朋友" })).body;
    expect((await filesApi.list(url)).body.files.map((f) => f.name)).toContain("老周");
    expect((await filesApi.remove(url, friend.id, { target: { kind: "person" }, mode: "forget" })).status).toBe(200);

    const removed = await filesApi.remove(url, SELF_PERSON_ID, { target: { kind: "field", field: "phone" }, mode: "purge", withSources: true });
    expect(removed).toMatchObject({ status: 200, body: { sources: 1 } });
    expect(eventsContaining(daemon, "13800001111")).toEqual([]);
  });
});
