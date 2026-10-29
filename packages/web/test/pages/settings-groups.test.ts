// 247 号票：设置列表从 12 项平铺改成四组可折叠（身份、能力、规则、数据与设备，用户 2026-10-22 定的方案 A）。
// 这里查四件事：
// - 四组各放哪些页、什么顺序；每页的地址照旧 #/more/<页>（收藏、别处链接来的都不坏）；
// - 插件停用 / 记忆页里已经有"删除素材"的过滤照旧（193、214 号票）——过滤只是决定组里列不列，组和顺序不变；
// - 组标题点一下收起 / 展开：收起时组里的项不画，▸ / ▾，aria-expanded；默认四组都展开；
// - 记住收起了哪几组（state/settings-groups.ts，纯函数）和这台设备上那一半（app/settings-fold.ts，存储换成假的）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseHash, toHash } from "../../src/app/route-hash.ts";
import { SETTINGS_FOLD, settingsFoldSettingIn } from "../../src/app/board-fold-setting.ts";
import { pageSettingsFold } from "../../src/app/page-settings-fold.ts";
import { settingsGroups, settingsShown } from "../../src/pages/MorePage.tsx";
import { SettingsGroup } from "../../src/pages/more/SettingsGroup.tsx";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { activeLocale, activeLocaleFrom, type SettingsGroupId, setActiveLocale, settingsFoldedOf, settingsFoldedText, toggleSettingsGroup } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

/** 按真守护进程报的状况装好的网页插件宿主；不给录音是还没收到状况（全开：记忆页在，"删除素材"被它覆盖） */
function assembled() {
  const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
  host.apply(undefined);
  return host;
}

type Host = ReturnType<typeof assembled>;

const noop = () => {};
/** 一组渲染出来（children 是组里的项，这里换成一句好认的） */
const group = (id: SettingsGroupId, collapsed: boolean, children = "组里的项") => renderToStaticMarkup(createElement(SettingsGroup, { id, collapsed, onToggle: noop }, children));
/** 渲染出来的组标题 */
const titleOf = (html: string) => /settings-group-title">([^<]*)</.exec(html)![1];
/** "数据与设备"组现在列哪些 */
const dataRows = (host: Host) => settingsGroups(host, false).find((g) => g.id === "data")!.rows;

/** 假的 localStorage */
function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const before = activeLocale();
afterEach(() => setActiveLocale(before));

describe("四组：每组的页和顺序", () => {
  test("身份（我的名字、角色与声音、语言、外观与风格、语音）、能力（模型、skill 和 MCP、插件、浏览与填框）、规则（关注类别、系统提示、工作日规则）、数据与设备（删除素材、工具调用完整内容、已配对设备、体检、关于二狗）", () => {
    const host = assembled();
    // 记忆页里有成批删除，"删除素材"只在它不在时列（193 号票的规矩，247 号票不动）
    host.disable("memory");
    expect(settingsGroups(host, false)).toEqual([
      // 248 号票："角色与声音"就排在名字后面（名字=默认角色名，音色=默认角色音色）；281 号票：名字下面一行去个人档案的链接
      { id: "identity", rows: ["user-name", "personal-files-link", "roles", "language", "appearance", "voice"] },
      // 305 号票：设置 · Claude Code（Claude Code 插件画的页）排在插件后面；323 号票：设置 · 组件紧挨着插件
      { id: "ability", rows: ["models", "skills", "plugins", "components", "claude-code", "browsing"] },
      { id: "rules", rows: ["watch", "prompts", "workday-rules"] },
      // 295 号票：数据源排在数据与设备组的第一项
      // 335 号票："备份"一小节紧挨着工具调用的完整内容
      { id: "data", rows: ["data-sources", "materials-delete", "tool-call-storage", "backup", "devices", "doctor", "about"] },
    ]);
  });

  test("平铺那一项不少（248 号票起还有\"角色与声音\"），外加\"关于二狗\"：没有哪一页因为分组被漏掉", () => {
    const host = assembled();
    host.disable("memory");
    const pages = settingsGroups(host, false)
      .flatMap((g) => g.rows)
      .filter((r) => r !== "user-name" && r !== "tool-call-storage" && r !== "backup" && r !== "personal-files-link");
    expect(pages.toSorted()).toEqual(
      ["roles", "language", "appearance", "models", "watch", "workday-rules", "skills", "prompts", "voice", "browsing", "devices", "plugins", "components", "claude-code", "data-sources", "materials-delete", "doctor", "about"].toSorted(),
    );
  });

  test("Debug 工具集打开着：挂在最后一组的\"关于二狗\"下面（124 号票照旧），别的组不变", () => {
    const host = assembled();
    const groups = settingsGroups(host, true);
    expect(groups.at(-1)!.rows.slice(-2)).toEqual(["about", "debug"]);
    expect(groups.slice(0, 3).map((g) => g.rows)).toEqual(settingsGroups(host, false).slice(0, 3).map((g) => g.rows));
  });

  test("地址不变：组里的每一页还是 #/more/<页>，拆得回来（收藏、别处链接来的都不坏）", () => {
    const host = assembled();
    host.disable("memory");
    const pages = settingsGroups(host, false)
      .flatMap((g) => g.rows)
      .filter((r) => r !== "user-name" && r !== "tool-call-storage" && r !== "backup" && r !== "personal-files-link");
    for (const page of pages) {
      expect(toHash({ tab: "more", page })).toBe(`#/more/${page}`);
      expect(parseHash(`#/more/${page}`)).toEqual({ tab: "more", page });
    }
  });
});

describe("插件停用 / 记忆页覆盖的过滤照旧（193、214 号票），只是组里列不列", () => {
  test("记忆插件在用时\"删除素材\"不列；停用后回到\"数据与设备\"里数据源的后面，组和顺序不变", () => {
    const host = assembled();
    expect(dataRows(host)).toEqual(["data-sources", "tool-call-storage", "backup", "devices", "doctor", "about"]);
    host.disable("memory");
    expect(dataRows(host)).toEqual(["data-sources", "materials-delete", "tool-call-storage", "backup", "devices", "doctor", "about"]);
    expect(settingsGroups(host, false).map((g) => g.id)).toEqual(["identity", "ability", "rules", "data"]);
  });

  test("语音插件停用：\"语音\"从身份组里不列，其余三组一项不少；settingsShown 照旧只少它", () => {
    const on = assembled();
    const off = assembled();
    off.disable("voice");
    expect(settingsGroups(on, false)[0]!.rows).toEqual(["user-name", "personal-files-link", "roles", "language", "appearance", "voice"]);
    expect(settingsGroups(off, false)[0]!.rows).toEqual(["user-name", "personal-files-link", "roles", "language", "appearance"]);
    expect(settingsGroups(off, false).slice(1)).toEqual(settingsGroups(on, false).slice(1));
    expect(settingsShown(off)).toEqual(settingsShown(on).filter((s) => s !== "voice"));
  });

  test("settingsShown 还是按显示顺序的那一串页（不含名字、工具调用完整内容）：四组摊平", () => {
    const host = assembled();
    host.disable("memory");
    expect(settingsShown(host)).toEqual(["roles", "language", "appearance", "voice", "models", "skills", "plugins", "components", "claude-code", "browsing", "watch", "prompts", "workday-rules", "data-sources", "materials-delete", "devices", "doctor", "about"]);
  });
});

describe("一组：标题一行，点一下收起 / 展开", () => {
  test("默认展开：▾、aria-expanded=\"true\"、组里的项画出来；四组各是 data-group 上的一段", () => {
    const html = group("identity", false);
    expect(html).toContain('<section class="sec settings-group" data-group="identity">');
    expect(html).toContain('<button type="button" class="settings-group-head" aria-expanded="true">');
    expect(titleOf(html)).toBe("身份");
    expect(html).toContain("▾");
    expect(html).toContain('<div class="settings-group-body">组里的项</div>');
  });

  test("收起：▸、aria-expanded=\"false\"，组里的项不画（组标题还在）", () => {
    const html = group("ability", true);
    expect(html).toContain('data-group="ability"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("▸");
    expect(html).not.toContain("settings-group-body");
    expect(html).not.toContain("组里的项");
    expect(titleOf(html)).toBe("能力");
  });

  test("四组的名字按当前语言取：中文是身份 / 能力 / 规则 / 数据与设备，英文是 Identity / Capabilities / Rules / Data & devices", () => {
    const ids: SettingsGroupId[] = ["identity", "ability", "rules", "data"];
    expect(ids.map((id) => titleOf(group(id, true)))).toEqual(["身份", "能力", "规则", "数据与设备"]);
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    expect(ids.map((id) => titleOf(group(id, true)))).toEqual(["Identity", "Capabilities", "Rules", "Data &amp; devices"]);
  });
});

describe("记住收起了哪几组（纯函数，state/settings-groups.ts）", () => {
  test("没记过：四组都展开；记过的按记的；认不出的组名丢掉", () => {
    expect([...settingsFoldedOf(null)]).toEqual([]);
    expect([...settingsFoldedOf("")]).toEqual([]);
    expect([...settingsFoldedOf("ability,data")]).toEqual(["ability", "data"]);
    expect([...settingsFoldedOf("nonsense,identity")]).toEqual(["identity"]);
  });

  test("和默认（全展开）一样不留记号；不一样的按四组的先后连起来；点一下收起的展开、展开的收起", () => {
    expect(settingsFoldedText(new Set())).toBeUndefined();
    expect(settingsFoldedText(new Set(["rules"]))).toBe("rules");
    expect(settingsFoldedText(new Set(["data", "identity"]))).toBe("identity,data");
    expect([...toggleSettingsGroup(new Set(), "identity")]).toEqual(["identity"]);
    expect([...toggleSettingsGroup(new Set(["identity"]), "identity")]).toEqual([]);
  });
});

describe("这台设备上记住（app/settings-fold.ts）", () => {
  test("没改过全展开；收起一组马上告诉界面、下次打开还是这样；改回全展开擦掉记号", () => {
    const storage = memoryStorage();
    const setting = settingsFoldSettingIn(() => storage);
    let notified = 0;
    setting.subscribe(() => notified++);
    expect([...setting.folded()]).toEqual([]);

    setting.toggle("ability");
    expect([...setting.folded()]).toEqual(["ability"]);
    expect(notified).toBe(1);
    expect(storage.items.get(SETTINGS_FOLD.key)).toBe("ability");
    expect([...settingsFoldSettingIn(() => storage).folded()]).toEqual(["ability"]);

    setting.toggle("ability");
    expect([...setting.folded()]).toEqual([]);
    expect(storage.items.size).toBe(0);
    expect(notified).toBe(2);
  });

  test("存储用不了（隐私模式、禁用了站点数据）：读不出按默认；改了只在这次打开里生效，不报错", () => {
    const setting = settingsFoldSettingIn(() => {
      throw new Error("SecurityError");
    });
    expect([...setting.folded()]).toEqual([]);
    expect(() => setting.toggle("rules")).not.toThrow();
    expect([...setting.folded()]).toEqual(["rules"]);
  });

  test("页面上那一份只有一个：宽屏左栏、窄屏整页、更多里收进来的设置一起跟着变", () => {
    // Node 里没有 window：读不出按默认，toggle 也不报错（浏览器里接的是 localStorage）
    expect([...pageSettingsFold().folded()]).toEqual([]);
    expect(pageSettingsFold()).toBe(pageSettingsFold());
  });
});
