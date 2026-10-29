// 主切面：插件的状况给网页（193 号票，ADR-0027 的网页插槽）。走真实的装配路径：经组合根和插件清单起守护进程，停用插件只经数据目录配置的
// plugins.disabled（startTestDaemon 的 plugins 选项写的就是它），装不上的插件经 extraPlugins 接在清单后面（同一条装配路径）。
// - 订阅插件频道时补推一条临时事件 plugin_status：清单里每个插件按清单的先后，名字、给人看的名字（按当前语言）、在运行 / 停用了 / 没装上（带原因）；
// - 运行中停用（只给测试用）、换了语言再推一条；
// - 录下停用记忆插件、停用提醒插件、停用浏览插件（212 号票）时网页收到的事件流（web/test/state/recordings/plugins-*.json）：网页那边按真守护进程报的状态装自己的
//   网页插件（web/test/plugins/assembly.test.ts，dsh 的复盘 0001：手挂插件的单元测试全过、上线即崩）。
// - 213 号票：清单里多了日历插件；录下配置里停用日历、设置里运行中停用再启用日历时网页收到的事件流（plugins-calendar-off、plugins-calendar-hot）。
// - 297 号票：清单里多了 Google 插件（排最后）；录下配置里停用 Google 时网页收到的事件流（plugins-google-off）。
import { CHANNELS, EVENT_TYPES, type PluginStatusEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { serviceKey } from "../../src/plugins/host.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { languageApi, pluginsApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";

const { plugins: PLUGINS, secretary: SECRETARY } = CHANNELS;

const statusEvents = (frontend: TestFrontend) => frontend.events({ channel: PLUGINS, type: EVENT_TYPES.pluginStatus }).map((f) => f.payload as PluginStatusEventPayload);

/** 连上、订阅插件频道，等补推的那一条 */
async function watch(url: string, extra: Record<string, number> = {}): Promise<TestFrontend> {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe({ [PLUGINS]: 0, ...extra });
  await waitUntil(() => statusEvents(frontend).length >= 1);
  return frontend;
}

describe("插件的状况给网页", () => {
  it("默认全开：订阅时补推一条，提醒、记忆、日历、语音、内置浏览器（212 号票）都在运行（按清单的先后，给人看的名字按当前语言）", async () => {
    const { url } = await startTestDaemon();
    const frontend = await watch(url);
    expect(statusEvents(frontend)).toEqual([
      {
        plugins: [
          { name: "reminders", title: "提醒", state: "running" },
          { name: "memory", title: "记忆", state: "running" },
          { name: "calendar", title: "日历", state: "running" },
          { name: "voice", title: "语音", state: "running" },
          { name: "browsing", title: "内置浏览器", state: "running" },
          { name: "claude-code", title: "Claude Code", state: "running" },
          { name: "phone", title: "手机", state: "running" },
          { name: "google", title: "Google", state: "running" },
          { name: "looki", title: "Looki", state: "running" },
        ],
      },
    ]);
    // 临时事件不占序号：插件频道上没有落盘的事件
    expect(frontend.events({ channel: PLUGINS }).every((f) => f.seq === 0)).toBe(true);
  });

  it("配置里停用记忆插件：记忆是 disabled（录下来给网页回放）", async () => {
    const { url } = await startTestDaemon({ plugins: ["reminders", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"] });
    const frontend = await watch(url, { [SECRETARY]: 0 });
    expect(statusEvents(frontend).at(-1)!.plugins).toEqual([
      { name: "reminders", title: "提醒", state: "running" },
      { name: "memory", title: "记忆", state: "disabled" },
      { name: "calendar", title: "日历", state: "running" },
      { name: "voice", title: "语音", state: "running" },
      { name: "browsing", title: "内置浏览器", state: "running" },
      { name: "claude-code", title: "Claude Code", state: "running" },
      { name: "phone", title: "手机", state: "running" },
      { name: "google", title: "Google", state: "running" },
      { name: "looki", title: "Looki", state: "running" },
    ]);
    saveOrCheckRecording("plugins-memory-off", frontend.recording);
  });

  it("配置里停用提醒插件：提醒是 disabled，日历照常在运行（录下来给网页回放）", async () => {
    const { url } = await startTestDaemon({ plugins: ["memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"] });
    const frontend = await watch(url, { [SECRETARY]: 0 });
    expect(statusEvents(frontend).at(-1)!.plugins).toEqual([
      { name: "reminders", title: "提醒", state: "disabled" },
      { name: "memory", title: "记忆", state: "running" },
      { name: "calendar", title: "日历", state: "running" },
      { name: "voice", title: "语音", state: "running" },
      { name: "browsing", title: "内置浏览器", state: "running" },
      { name: "claude-code", title: "Claude Code", state: "running" },
      { name: "phone", title: "手机", state: "running" },
      { name: "google", title: "Google", state: "running" },
      { name: "looki", title: "Looki", state: "running" },
    ]);
    saveOrCheckRecording("plugins-reminders-off", frontend.recording);
  });

  it("配置里停用日历插件（213 号票）：日历是 disabled，提醒、记忆照常（录下来给网页回放）", async () => {
    const { url } = await startTestDaemon({ plugins: ["reminders", "memory", "voice", "browsing", "claude-code", "phone", "google", "looki"] });
    const frontend = await watch(url, { [SECRETARY]: 0 });
    expect(statusEvents(frontend).at(-1)!.plugins).toEqual([
      { name: "reminders", title: "提醒", state: "running" },
      { name: "memory", title: "记忆", state: "running" },
      { name: "calendar", title: "日历", state: "disabled" },
      { name: "voice", title: "语音", state: "running" },
      { name: "browsing", title: "内置浏览器", state: "running" },
      { name: "claude-code", title: "Claude Code", state: "running" },
      { name: "phone", title: "手机", state: "running" },
      { name: "google", title: "Google", state: "running" },
      { name: "looki", title: "Looki", state: "running" },
    ]);
    saveOrCheckRecording("plugins-calendar-off", frontend.recording);
  });

  it("配置里停用语音插件（214 号票）：语音是 disabled，别的照常（录下来给网页回放：输入框没有话筒、设置里没有语音）", async () => {
    const { url } = await startTestDaemon({ plugins: ["reminders", "memory", "calendar", "browsing", "claude-code", "phone", "google", "looki"] });
    const frontend = await watch(url, { [SECRETARY]: 0 });
    expect(statusEvents(frontend).at(-1)!.plugins).toEqual([
      { name: "reminders", title: "提醒", state: "running" },
      { name: "memory", title: "记忆", state: "running" },
      { name: "calendar", title: "日历", state: "running" },
      { name: "voice", title: "语音", state: "disabled" },
      { name: "browsing", title: "内置浏览器", state: "running" },
      { name: "claude-code", title: "Claude Code", state: "running" },
      { name: "phone", title: "手机", state: "running" },
      { name: "google", title: "Google", state: "running" },
      { name: "looki", title: "Looki", state: "running" },
    ]);
    saveOrCheckRecording("plugins-voice-off", frontend.recording);
  });

  it("配置里停用浏览插件（212 号票）：内置浏览器是 disabled（录下来给网页回放：没有浏览页签、侧边栏、网页候选卡是占位）", async () => {
    const { url } = await startTestDaemon({ plugins: ["reminders", "memory", "calendar", "voice", "claude-code", "phone", "google", "looki"] });
    const frontend = await watch(url, { [SECRETARY]: 0 });
    expect(statusEvents(frontend).at(-1)!.plugins).toEqual([
      { name: "reminders", title: "提醒", state: "running" },
      { name: "memory", title: "记忆", state: "running" },
      { name: "calendar", title: "日历", state: "running" },
      { name: "voice", title: "语音", state: "running" },
      { name: "browsing", title: "内置浏览器", state: "disabled" },
      { name: "claude-code", title: "Claude Code", state: "running" },
      { name: "phone", title: "手机", state: "running" },
      { name: "google", title: "Google", state: "running" },
      { name: "looki", title: "Looki", state: "running" },
    ]);
    saveOrCheckRecording("plugins-browsing-off", frontend.recording);
  });

  it("配置里停用 Google 插件（297 号票）：Google 是 disabled，日历照常（录下来给网页回放：设置 · 数据源里没有填日历地址的那一块）", async () => {
    const { url } = await startTestDaemon({ plugins: ["reminders", "memory", "calendar", "voice", "browsing", "claude-code", "phone", "looki"] });
    const frontend = await watch(url, { [SECRETARY]: 0 });
    expect(statusEvents(frontend).at(-1)!.plugins.map((p) => [p.name, p.state])).toEqual([
      ["reminders", "running"],
      ["memory", "running"],
      ["calendar", "running"],
      ["voice", "running"],
      ["browsing", "running"],
      ["claude-code", "running"],
      ["phone", "running"],
      ["google", "disabled"],
      ["looki", "running"],
    ]);
    saveOrCheckRecording("plugins-google-off", frontend.recording);
  });

  it("启用着却没装上的：skipped，带原因", async () => {
    const nowhere = serviceKey<unknown>("nowhere");
    const { url } = await startTestDaemon({ extraPlugins: [{ name: "orphan", title: "缺依赖的", needs: [nowhere], setup() {} }] });
    const frontend = await watch(url);
    expect(statusEvents(frontend).at(-1)!.plugins.at(-1)).toEqual({ name: "orphan", title: "缺依赖的", state: "skipped", reason: "要的服务 nowhere 没有谁提供" });
  });

  it("运行中停用（只给测试用）：开着的前端收到新的一条", async () => {
    const { url, daemon } = await startTestDaemon();
    const frontend = await watch(url);
    await daemon.plugins.disable("reminders");
    await waitUntil(() => statusEvents(frontend).length === 2);
    expect(statusEvents(frontend)[1]!.plugins.map((p) => [p.name, p.state])).toEqual([
      ["reminders", "disabled"],
      ["memory", "running"],
      ["calendar", "running"],
      ["voice", "running"],
      ["browsing", "running"],
      ["claude-code", "running"],
      ["phone", "running"],
      ["google", "running"],
      ["looki", "running"],
    ]);
  });

  it("设置里运行中停用、启用记忆插件，移除提醒插件并连数据删（211 号票）：每一下推一条新的状况，删除记录落在插件频道上（录下来给网页回放）", async () => {
    const { url } = await startTestDaemon();
    const frontend = await watch(url, { [SECRETARY]: 0, [CHANNELS.board]: 0, [CHANNELS.cards]: 0, [CHANNELS.inbox]: 0 });
    expect((await frontend.createReminder("交报告", { kind: "once", at: "2099-10-08T09:00:00.000+08:00" }, "hot-reminder")).ok).toBe(true);
    await frontend.next(CHANNELS.cards, EVENT_TYPES.card);
    const act = (name: string, action: "disable" | "enable" | "remove", purgeData = false) => pluginsApi.act(url, name, { action, ...(purgeData ? { purgeData } : {}), idempotencyKey: `hot-${name}-${action}` });
    expect((await act("memory", "disable")).body.changed).toEqual(["memory"]);
    await waitUntil(() => statusEvents(frontend).length === 2);
    expect((await act("memory", "enable")).body.changed).toEqual(["memory"]);
    await waitUntil(() => statusEvents(frontend).length === 3);
    expect((await act("reminders", "remove", true)).body.changed).toEqual(["reminders"]);
    await waitUntil(() => statusEvents(frontend).length === 4 && frontend.events({ channel: PLUGINS, type: EVENT_TYPES.pluginDataPurged }).length === 1);
    expect(statusEvents(frontend).map((e) => e.plugins.map((p) => p.state))).toEqual([
      ["running", "running", "running", "running", "running", "running", "running", "running", "running"],
      ["running", "disabled", "running", "running", "running", "running", "running", "running", "running"],
      ["running", "running", "running", "running", "running", "running", "running", "running", "running"],
      ["removed", "running", "running", "running", "running", "running", "running", "running", "running"],
    ]);
    saveOrCheckRecording("plugins-hot-toggle", frontend.recording, { perChannel: true });
  });

  it("设置里运行中停用、再启用日历插件（213 号票）：每一下推一条新的状况，提醒、记忆不跟着动（录下来给网页回放）", async () => {
    const { url } = await startTestDaemon();
    const frontend = await watch(url, { [SECRETARY]: 0 });
    const act = (action: "disable" | "enable") => pluginsApi.act(url, "calendar", { action, idempotencyKey: `hot-calendar-${action}` });
    expect((await act("disable")).body.changed).toEqual(["calendar"]);
    await waitUntil(() => statusEvents(frontend).length === 2);
    expect((await act("enable")).body.changed).toEqual(["calendar"]);
    await waitUntil(() => statusEvents(frontend).length === 3);
    expect(statusEvents(frontend).map((e) => e.plugins.map((p) => p.state))).toEqual([
      ["running", "running", "running", "running", "running", "running", "running", "running", "running"],
      ["running", "running", "disabled", "running", "running", "running", "running", "running", "running"],
      ["running", "running", "running", "running", "running", "running", "running", "running", "running"],
    ]);
    saveOrCheckRecording("plugins-calendar-hot", frontend.recording);
  });

  it("换了语言：再推一条，给人看的名字跟着变", async () => {
    const { url } = await startTestDaemon();
    const frontend = await watch(url);
    expect((await languageApi.change(url, "en")).status).toBe(200);
    await waitUntil(() => statusEvents(frontend).length >= 2);
    expect(statusEvents(frontend).at(-1)!.plugins.map((p) => p.title)).toEqual(["Reminders", "Memory", "Calendar", "Voice", "Built-in browser", "Claude Code", "Phone", "Google", "Looki"]);
  });
});
