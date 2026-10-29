// 主切面：插件开发手册（docs/guides/plugin-development.md，215 号票）的例子"笔记"走真实装配路径——笔记插件接在插件清单后面
// （startTestDaemon 的 extraPlugins，和清单里的五个走同一条装配路径），经组合根起真的守护进程：秘书真的调到"记笔记"（agent 贡献经宿主协议
// 下发、子进程的桥接带给 pi），设置 · 插件的 HTTP 接口停用、启用、移除并连数据删，插件频道推新的状况、写数据目录配置。
// 只在假内核里测的那条在 test/plugins/plugin-guide.test.ts。
import fs from "node:fs";
import { CHANNELS, EVENT_TYPES, isDeletedEventPayload, type PluginStatusEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { pluginsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { NOTES } from "../plugins/notes-example/api.ts";
import { ADD_NOTE_TOOL, listNotes, NOTES_CHANNEL } from "../plugins/notes-example/notes.ts";
import { notesPlugin } from "../plugins/notes-example/plugin.ts";

const { secretary: SECRETARY, plugins: PLUGINS } = CHANNELS;

/** 插件频道上最后一条状况里笔记插件的状况 */
const notesState = (frontend: TestFrontend) =>
  (frontend.events({ channel: PLUGINS, type: EVENT_TYPES.pluginStatus }).at(-1)?.payload as PluginStatusEventPayload | undefined)?.plugins.find((p) => p.name === "notes")?.state;

/** 数据目录配置文件里的 plugins */
const pluginsConfig = (dataDir: string): unknown => (JSON.parse(fs.readFileSync(dataDirLayout(dataDir).configFile, "utf8")) as { plugins?: unknown }).plugins;

describe("手册的例子：笔记插件走真实装配路径", () => {
  it("秘书调到记笔记；设置 · 插件里停用、启用、移除并连数据删，状况推给网页、写进配置", { timeout: 60_000 }, async () => {
    const td = await startTestDaemon({
      extraPlugins: [notesPlugin],
      secretary: [{ kind: "reply", toolCalls: [{ name: ADD_NOTE_TOOL, arguments: { text: "周三下午体检" } as never }] }, { kind: "reply", text: "记好了。" }],
    });
    expect(td.daemon.plugins.report().running.at(-1)).toBe("notes");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0, [PLUGINS]: 0 });
    expect(notesState(frontend)).toBe("running");

    // 秘书这一轮调"记笔记"：写进事件日志、视图里有
    await frontend.sendText("记一下周三下午体检");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(td.daemon.plugins.service(NOTES)!.list().map((n) => n.text)).toEqual(["周三下午体检"]);

    // 设置 · 插件里看得到它
    const view = await pluginsApi.view(td.url);
    expect(view.body.plugins.find((p) => p.name === "notes")).toMatchObject({ title: "笔记", state: "running", brings: { tools: ["记笔记"] } });

    // 停用：马上生效，插件频道推新的状况，写进配置
    expect((await pluginsApi.act(td.url, "notes", { action: "disable", idempotencyKey: "notes-off" })).body.changed).toEqual(["notes"]);
    await waitUntil(() => notesState(frontend) === "disabled");
    expect(pluginsConfig(td.dataDir)).toEqual({ disabled: ["notes"] });
    expect(td.daemon.plugins.service(NOTES)).toBeUndefined();

    // 启用：回来，配置里拿掉
    expect((await pluginsApi.act(td.url, "notes", { action: "enable", idempotencyKey: "notes-on" })).body.changed).toEqual(["notes"]);
    await waitUntil(() => notesState(frontend) === "running");
    expect(pluginsConfig(td.dataDir)).toBeUndefined();

    // 移除并连数据删：笔记事件换成删除标记，视图里也不留
    const removed = await pluginsApi.act(td.url, "notes", { action: "remove", purgeData: true, idempotencyKey: "notes-rm" });
    expect(removed.body.purged).toMatchObject({ events: 1 });
    await waitUntil(() => notesState(frontend) === "removed");
    expect(pluginsConfig(td.dataDir)).toEqual({ removed: ["notes"] });
    expect(td.daemon.store.read(NOTES_CHANNEL).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect(listNotes(td.daemon.store.reader)).toEqual([]);
  });
});
