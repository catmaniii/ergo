// 插件开发手册（docs/guides/plugin-development.md，215 号票）的例子：照手册写的最小插件"笔记"（notes-example/），在假内核
// （helpers/plugin-kernel.ts：真的插件宿主、真的登记表和设置 · 插件那一层、临时数据目录）里装上、停用、启用、移除。
// 这条测试也是手册的例子：手册"跑起来"一节摘的就是这里的代码（plugin-guide-doc.test.ts 核对摘录和代码对得上，改了这里记得看手册）。
// 走真实装配路径（组合根、插件清单、HTTP 接口）的那条在 test/main/plugin-guide.test.ts。
import { CHANNELS, EVENT_TYPES, isDeletedEventPayload, type PluginDataPurgedEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { RequestRejected } from "../../src/errors.ts";
import { SECRETARY_TARGET } from "../../src/secretary/secretary.ts";
import { startPluginKernel } from "../helpers/plugin-kernel.ts";
import { NOTES } from "./notes-example/api.ts";
import { ADD_NOTE_TOOL, listNotes, NOTE_EVENT, NOTES_CHANNEL } from "./notes-example/notes.ts";
import { notesPlugin } from "./notes-example/plugin.ts";

/** 秘书此刻拿到的工具名、醒来时的上下文块 */
const secretaryTools = (k: Awaited<ReturnType<typeof startPluginKernel>>) => k.agent.toolsFor(SECRETARY_TARGET).map((tool) => tool.spec.name);
const secretaryBlocks = (k: Awaited<ReturnType<typeof startPluginKernel>>) => k.agent.manifestFor(SECRETARY_TARGET).contextBlocks;

describe("手册的例子：笔记插件", () => {
  it("装上：服务、视图、给秘书的工具和上下文块都在，设置 · 插件里看得到它", async () => {
    const k = await startPluginKernel({ plugins: [notesPlugin] });
    expect(k.host.report()).toEqual({ running: ["notes"], disabled: [], skipped: [] });

    // 秘书调"记笔记"：写进事件日志，视图里有，下一轮醒来的上下文块里有
    const [addNote] = k.agent.toolsFor(SECRETARY_TARGET);
    expect(addNote!.spec.name).toBe(ADD_NOTE_TOOL);
    expect(await addNote!.run({ text: "周三下午体检" }, { toolCallId: "c-1" })).toEqual({ text: "记好了（note-1）。" });
    expect(k.host.service(NOTES)!.list().map((n) => n.text)).toEqual(["周三下午体检"]);
    expect(secretaryBlocks(k)).toContainEqual({ id: "notes:recent", text: "用户最近记的笔记：\n- 周三下午体检" });

    // 设置 · 插件里的样子：一句话、带来了什么、连数据删写明的
    const info = k.settings.view().plugins.find((p) => p.name === "notes")!;
    expect(info).toMatchObject({ title: "笔记", state: "running", summary: "记下你让二狗记的话", brings: { tools: ["记笔记"] } });
    expect(info.removal).toEqual({ deletes: ["全部笔记"], keeps: ["聊天里提到过的笔记内容", "备份快照里的一份"] });
  });

  it("停用（设置 · 插件里点）：登记都撤掉、写进 plugins.disabled；数据契约还在；正在跑的一轮里再调它的工具回没启用", async () => {
    const k = await startPluginKernel({ plugins: [notesPlugin] });
    const [addNote] = k.agent.toolsFor(SECRETARY_TARGET);
    await addNote!.run({ text: "周三下午体检" }, { toolCallId: "c-1" });

    const result = await k.settings.act("notes", { action: "disable", idempotencyKey: "off-1" });
    expect(result.changed).toEqual(["notes"]);
    expect(k.pluginsConfig()).toEqual({ disabled: ["notes"] });
    expect(k.host.report()).toEqual({ running: [], disabled: ["notes"], skipped: [] });

    // 服务、工具、上下文块都没了；内核替它接请求时回"笔记插件没启用"
    expect(k.host.service(NOTES)).toBeUndefined();
    expect(() => k.host.active(NOTES)).toThrow(new RequestRejected("not_allowed", "笔记插件没启用"));
    expect(secretaryTools(k)).toEqual([]);
    expect(secretaryBlocks(k).map((b) => b.id)).not.toContain("notes:recent");
    // agent 手里还是停用前的工具（这一轮还没重新装配）：回没启用，不做
    const late = await addNote!.run({ text: "不该记下" }, { toolCallId: "c-2" });
    expect(late).toMatchObject({ isError: true, text: expect.stringContaining("笔记插件没启用：现在用不了 add_note") });
    expect(k.store.read(NOTES_CHANNEL)).toHaveLength(1);

    // 数据契约停用也登记：笔记照样能彻底删除（改写函数还在）
    const [note] = k.store.read(NOTES_CHANNEL, 0, NOTE_EVENT);
    expect(k.purge.rewrite(note!, { deletedAt: "2026-10-24T10:00:00.000+08:00", materialIds: new Set() })).toEqual({ note: { id: "note-1", text: "（这条内容已彻底删除）", time: expect.any(String) } });
  });

  it("再启用：新的一次装配，停着时追加的事件视图补齐，配置里拿掉", async () => {
    const k = await startPluginKernel({ plugins: [notesPlugin] });
    await k.host.service(NOTES)!.add("周三下午体检", "add-1");
    await k.settings.act("notes", { action: "disable", idempotencyKey: "off-1" });

    // 停着时视图不更新（比如恢复备份、别的入口写进来的事件）
    k.store.append({ channel: NOTES_CHANNEL, type: NOTE_EVENT, payload: { note: { id: "note-2", text: "周五交报告", time: "2026-10-24T10:00:00.000+08:00" } } });
    expect(listNotes(k.store.reader).map((n) => n.text)).toEqual(["周三下午体检"]);

    const result = await k.settings.act("notes", { action: "enable", idempotencyKey: "on-1" });
    expect(result.changed).toEqual(["notes"]);
    expect(k.pluginsConfig()).toEqual({});
    expect(k.host.service(NOTES)!.list().map((n) => n.text)).toEqual(["周三下午体检", "周五交报告"]);
    expect(secretaryTools(k)).toEqual([ADD_NOTE_TOOL]);
  });

  it("移除并连数据删：它的事件换成删除标记、视图空了，留一条删除记录；装回就是启用", async () => {
    const k = await startPluginKernel({ plugins: [notesPlugin] });
    await k.host.service(NOTES)!.add("周三下午体检", "add-1");
    await k.host.service(NOTES)!.add("周五交报告", "add-2");

    const result = await k.settings.act("notes", { action: "remove", purgeData: true, idempotencyKey: "rm-1" });
    expect(result.purged).toEqual({ events: 2, cards: 0, inboxItems: 0, files: 0 });
    expect(k.pluginsConfig()).toEqual({ removed: ["notes"] });
    expect(k.host.status().find((s) => s.name === "notes")!.state).toBe("removed");
    expect(k.store.read(NOTES_CHANNEL).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect(listNotes(k.store.reader)).toEqual([]);
    const [record] = k.store.read(CHANNELS.plugins, 0, EVENT_TYPES.pluginDataPurged);
    expect(record!.payload).toMatchObject({ plugin: "notes", eventTypes: [NOTE_EVENT] } satisfies Partial<PluginDataPurgedEventPayload>);

    // 装回：照常用，以前的笔记没有了
    await k.settings.act("notes", { action: "enable", idempotencyKey: "back-1" });
    expect(k.pluginsConfig()).toEqual({});
    expect(k.host.service(NOTES)!.list()).toEqual([]);
    expect(k.host.service(NOTES)!.add("下周一开会", "add-3").text).toBe("下周一开会");
  });

  it("配置里停用了的（plugins.disabled，重启生效）：起来就不装、视图停着，数据契约照样登记", async () => {
    const k = await startPluginKernel({ plugins: [notesPlugin], disabled: ["notes"] });
    expect(k.host.report()).toEqual({ running: [], disabled: ["notes"], skipped: [] });
    expect(k.logs).toContain("插件 notes（笔记）在配置里停用了");
    expect(secretaryTools(k)).toEqual([]);
    expect(k.host.removalOf("notes")?.events).toEqual([{ channel: NOTES_CHANNEL, type: NOTE_EVENT }]);
  });
});
