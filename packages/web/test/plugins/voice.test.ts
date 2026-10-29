// 语音插件的网页这一半（214 号票，ADR-0027 的网页插槽；照 assembly.test.ts 走真实的装配路径）：守护进程那边的主切面
// （packages/daemon/test/main/plugin-status.test.ts）经组合根和插件清单起真的守护进程、配置里停用语音插件，把网页收到的事件流
// 录成 recordings/plugins-voice-off.json；这里原样交给前端状态层，用真的网页插件清单建宿主、按状况装和停，再用 React 在 Node 里渲染：
// - 开着：输入框右边有"文字 / 语音"切换（话筒），设置列表里有"语音"、页面是语音插件画的，后台部件里有自动播放；
// - 停用：输入框里没有话筒（浏览器里记着的语音模式留着也一律打字），设置列表里没有"语音"，地址 #/more/voice 写"语音插件没启用"，
//   没有自动播放；历史里的语音气泡是核心的（不归插件，不换成占位）。
import fs from "node:fs";
import path from "node:path";
import { type ComponentProps, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Connection } from "../../src/app/connection.ts";
import type { DaemonHttp } from "../../src/app/daemon-http.ts";
import { StoreProvider } from "../../src/app/store.tsx";
import { settingsShown } from "../../src/pages/MorePage.tsx";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { PluginHostProvider } from "../../src/plugins/react.tsx";
import { replay, t, type UiInput } from "../../src/state/index.ts";
import { Composer } from "../../src/ui/conversation/Composer.tsx";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const load = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../state/recordings", `${name}.json`), "utf8")) as UiInput[];

/** 按真守护进程报的状况装好的网页插件宿主（不给录音是还没收到状况：全开） */
function assembled(recording?: string) {
  const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
  host.apply(recording === undefined ? undefined : replay(load(recording)).pluginStatus?.plugins);
  return host;
}

type Host = ReturnType<typeof assembled>;

const noop = () => {};
/** 不连线的 StoreProvider（渲染时不跑副作用，连接、HTTP 都用不到） */
const offline = { connection: {} as Connection, http: {} as DaemonHttp } as ComponentProps<typeof StoreProvider>;
const render = (host: Host, child: ReactElement) => renderToStaticMarkup(createElement(StoreProvider, offline, createElement(PluginHostProvider, { host }, child)));
const composer = (host: Host) => render(host, createElement(Composer, { conversation: "secretary", mode: "secretary", onSend: noop }));

const MIC = 'class="icon-btn voice-toggle" data-to="voice"';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("语音插件的网页这一半", () => {
  test("配置里停用语音插件（录下的事件流）：守护进程报它停用了，网页插件跟着停；三个位置交回\"语音\"", () => {
    const host = assembled("plugins-voice-off");
    expect(replay(load("plugins-voice-off")).pluginStatus?.plugins.map((p) => [p.name, p.state])).toEqual([
      ["reminders", "running"],
      ["memory", "running"],
      ["calendar", "running"],
      ["voice", "disabled"],
      ["browsing", "running"],
      ["claude-code", "running"],
      ["phone", "running"],
      ["google", "running"],
      ["looki", "running"],
    ]);
    expect(host.running("voice")).toBe(false);
    // 设置页里只剩别的插件的（305 号票：设置 · Claude Code）
    expect([host.list("composerVoice"), host.list("settingsPages").map((e) => e.id)]).toEqual([[], ["claude-code"]]);
    // 后台部件里只剩别的插件的（299 号票：手机插件同步手机日历；300 号票：同步照片、位置）
    expect(host.list("background").map((e) => e.id)).toEqual(["phone-calendar-sync", "phone-media-sync"]);
    expect([host.unavailable("composerVoice", "voice"), host.unavailable("background", "voice-autoplay"), host.unavailable("settingsPages", "voice")]).toEqual(["语音", "语音", "语音"]);
    // 别的插件照常
    expect([host.running("reminders"), host.running("memory"), host.running("calendar"), host.running("browsing")]).toEqual([true, true, true, true]);
  });

  test("开着：登记了输入框的语音模式、自动播放、设置 · 语音的页面", () => {
    const host = assembled();
    expect(host.running("voice")).toBe(true);
    expect(host.list("composerVoice").map((e) => e.id)).toEqual(["voice"]);
    expect(host.list("background").map((e) => e.id)).toEqual(["voice-autoplay", "phone-calendar-sync", "phone-media-sync"]);
    expect(host.list("settingsPages").map((e) => e.id)).toEqual(["voice", "claude-code"]);
  });

  test("输入框：开着时右边有话筒（切到语音）；停用时没有，一律打字", () => {
    expect(composer(assembled())).toContain(MIC);
    const off = composer(assembled("plugins-voice-off"));
    expect(off).not.toContain("voice-toggle");
    expect(off).toContain("<textarea");
  });

  test("浏览器里记着上次是语音模式，语音插件停用了：照打字的样子（没有按住说话、没有切换），启用回来照旧是语音模式", () => {
    const saved = new Map([["ergo.input_mode", "voice"]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) });
    const off = composer(assembled("plugins-voice-off"));
    expect(off).not.toContain("voice-hold");
    expect(off).not.toContain("voice-toggle");
    expect(off).toContain("<textarea");
    expect(saved.get("ergo.input_mode")).toBe("voice");
  });

  test("设置：开着时列表里有\"语音\"（页面是插件画的）；停用时没有，地址 #/more/voice 写\"语音插件没启用\"", () => {
    const on = assembled();
    expect(settingsShown(on)).toContain("voice");
    expect(on.get("settingsPages", "voice")).toBeDefined();
    const off = assembled("plugins-voice-off");
    expect(settingsShown(off)).toEqual(settingsShown(on).filter((s) => s !== "voice"));
    // 别的设置照常
    expect(settingsShown(off)).toContain("plugins");
    // 停用时那一页（SubPage）写的是这一句
    expect(t("ui.plugins.pageUnavailable", { plugin: off.unavailable("settingsPages", "voice")! })).toContain("语音插件没启用");
  });
});
