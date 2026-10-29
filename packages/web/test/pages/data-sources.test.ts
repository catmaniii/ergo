// 设置 · 数据源（295 号票）：页面上的几块用 React 在 Node 里渲染出来查——
// - 一个数据源一块：连接状态的小签（连着 / 没连 / 出错了 / 手动导入 / 插件没启用）、账号、上次同步和共几条、两种用法的开关、
//   敏感内容（默认只记录、不用于推断）、认的文件；按钮：连着的有"立即同步""断开"，只靠导入文件夹的有"删除已导入的"；
//   插件画的设置那一块（dataSources 插槽）在插件在用时画、停用时不画；
// - 断开的确认框：留着已导入的 / 连已导入的一起删（选了删才写"不能恢复"、按钮变危险）；只靠导入文件夹的只有删除；
// - 导入文件夹：路径、按钮、没导入的和原因、最近导入的；
// - 做完说一句：同步好了几条、断开删了几条；
// - 300 号票：原始数据那一节（折起来、一天一行、还没整理的写明、点两下才清），清掉了几条。
// 设置列表里的位置、地址见 settings-groups.test.ts；页面打得开见 page-opens.test.ts（原型里编的数据源）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { DataSourceList, DisconnectConfirm, doneText, ImportFolderBlock, RawDays, sensitiveLine, syncLine } from "../../src/pages/more/DataSourcesPage.tsx";
import type { DataSourceSlot } from "../../src/plugins/api.ts";
import type { DataSourceView, ImportFolderView } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};
/** 插件画的设置那一块（假的） */
const Panel = ({ source: s }: { source: DataSourceView }) => createElement("div", { className: "fake-panel" }, `填 ${s.title} 的 Key`);
/** 只有 camera 有插件画的设置 */
const panel = (id: string): DataSourceSlot | undefined => (id === "camera" ? { id, Panel } : undefined);
/** 断开的确认框渲染出来 */
const confirm = (s: DataSourceView, purge: boolean) => renderToStaticMarkup(createElement(DisconnectConfirm, { confirming: { source: s, purge }, busy: false, onPurgeChange: noop, onCancel: noop, onConfirm: noop }));

function source(extra: Partial<DataSourceView> = {}): DataSourceView {
  return {
    id: "camera",
    title: "相机",
    summary: "每天的时刻",
    plugin: "camera",
    pluginTitle: "相机",
    available: true,
    connection: "connected",
    account: "d***@example.com",
    usages: [
      { usage: "query", on: true },
      { usage: "import", on: false },
    ],
    sensitive: [
      { id: "location", title: "位置", inferable: false },
      { id: "health", title: "健康", inferable: true },
    ],
    count: 128,
    lastSync: { at: "2026-10-25T04:00:00.000+08:00", trigger: "scheduled", added: 12 },
    syncing: false,
    canSync: true,
    schedule: "每天 04:00",
    files: ["时刻导出（.json）"],
    configurable: true,
    ...extra,
  };
}

const list = (sources: DataSourceView[], panel: (id: string) => DataSourceSlot | undefined = () => undefined, busy?: string) =>
  renderToStaticMarkup(createElement(DataSourceList, { sources, busy, panel, onView: noop, onSync: noop, onUsage: noop, onDisconnect: noop }));

describe("一个数据源一块", () => {
  test("连着的：小签、账号、上次同步和共几条、两种用法的开关（各开没开）、敏感内容、认的文件、立即同步和断开", () => {
    const html = list([source()]);
    expect(html).toContain("相机");
    expect(html).toContain('class="chip chip-ok">连着');
    expect(html).toContain("账号：d***@example.com");
    expect(html).toContain("上次同步 10-25 04:00，新进来 12 条 · 共 128 条");
    expect(html).toContain("按需查");
    expect(html).toContain("每天 04:00 自动同步，整理成素材");
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-label="相机的按需查" checked=""/);
    expect(html).not.toMatch(/aria-label="相机的导入" checked=""/);
    expect(html).toContain("用到的敏感内容：位置（只记录、不用于推断）；健康（已打开推断）");
    expect(html).toContain("认导入文件夹里的：时刻导出（.json）");
    expect(html).toContain(">立即同步<");
    expect(html).toContain(">断开<");
    expect(html).not.toContain("删除已导入的");
  });

  test("没连、出错、手动导入、插件没启用、正在同步、还没同步过：小签和那一行各自写明；手动导入的只有删除已导入的", () => {
    expect(list([source({ connection: "not_connected", canSync: false, account: undefined, lastSync: undefined, count: 0 })])).toMatch(/class="chip">没连.*还没同步过 · 共 0 条/s);
    const error = list([source({ connection: "error", problem: "Key 失效了", canSync: false })]);
    expect(error).toContain('class="chip chip-no">出错了');
    expect(error).toContain("出错了：Key 失效了");
    expect(error).toContain(">断开<");
    expect(error).not.toContain(">立即同步<");
    const manual = list([source({ connection: "manual", account: undefined, canSync: false, schedule: undefined, usages: [{ usage: "import", on: true }], lastSync: { at: "2026-10-25T09:30:00.000+08:00", trigger: "file", added: 42, file: "账单.csv" } })]);
    expect(manual).toContain('class="chip chip-quiet">手动导入');
    expect(manual).toContain("上次导入 10-25 09:30（账单.csv），新进来 42 条");
    expect(manual).toContain(">删除已导入的<");
    expect(manual).not.toContain(">断开<");
    expect(manual).toContain("往导入文件夹放文件时导入，整理成素材");
    expect(list([source({ schedule: undefined })])).toContain("点「立即同步」时导入，整理成素材");
    const off = list([source({ available: false, unavailable: "相机插件没启用", canSync: false })]);
    expect(off).toContain('class="chip chip-no">插件没启用');
    expect(off).toContain("相机插件没启用：现在不能同步、按需查");
    expect(syncLine(source({ syncing: true }))).toBe("正在同步…… · 共 128 条");
    expect(syncLine(source({ lastSync: { at: "2026-10-25T04:00:00.000+08:00", trigger: "manual", error: "401" } }))).toBe("上次同步 10-25 04:00 出错：401 · 共 128 条");
    expect(sensitiveLine(source({ sensitive: [] }))).toBeUndefined();
    expect(list([])).toContain("还没有数据源");
  });

  test("299：设备交来的（手机上的二狗 App）——上次那一行写手机交来和数据源写的那一句；导入的说法换成 App 交来时收下", () => {
    const phone = source({ id: "phone-contacts", connection: "manual", account: undefined, usages: [{ usage: "import", on: true }], sensitive: [], files: [], count: 2, canSync: false, fromDevice: true, schedule: undefined });
    expect(syncLine({ ...phone, lastSync: { at: "2026-10-25T09:40:00.000+08:00", trigger: "device", added: 2, summary: "2 位联系人：王小明和妈妈" } })).toBe("上次 10-25 09:40 手机交来：2 位联系人：王小明和妈妈 · 共 2 条");
    expect(syncLine({ ...phone, lastSync: { at: "2026-10-25T09:40:00.000+08:00", trigger: "device", added: 2 } })).toBe("上次 10-25 09:40 手机交来 2 条 · 共 2 条");
    expect(syncLine(source({ lastSync: { at: "2026-10-25T04:00:00.000+08:00", trigger: "scheduled", added: 3, summary: "3 封邮件" } }))).toBe("上次同步 10-25 04:00：3 封邮件 · 共 128 条");
    const html = list([phone]);
    expect(html).toContain("手机上的二狗 App 交来时收下");
    expect(html).not.toContain("整理成素材");
  });

  test("插件画的设置那一块（dataSources 插槽）：插件在用时画在这个数据源下面，插件停用时不画；正在处理时按钮换成一句", () => {
    expect(list([source()], panel)).toContain('<div class="fake-panel">填 相机 的 Key</div>');
    expect(list([source({ available: false, unavailable: "相机插件没启用" })], panel)).not.toContain("fake-panel");
    const busy = list([source()], panel, "camera");
    expect(busy).toContain("正在处理……");
    expect(busy).not.toContain(">立即同步<");
  });

  test("300：原始数据那一节——折起来写几天、共几条、只在二狗这里；一天一行，还没整理的写明；没有原始数据、页面不给清的不画", () => {
    const raw = { title: "原始位置点", days: [{ date: "2026-10-26", count: 12, summarized: false }, { date: "2026-10-25", count: 68, summarized: true }] };
    const phone = source({ id: "phone-location", raw });
    const html = renderToStaticMarkup(createElement(DataSourceList, { sources: [phone], busy: undefined, panel: () => undefined, onView: noop, onSync: noop, onUsage: noop, onDisconnect: noop, onClearRaw: noop }));
    expect(html).toContain('<details class="source-raw" data-raw="phone-location">');
    expect(html).toContain("原始位置点：2 天、共 80 条（只在二狗这里，不进素材）");
    expect(html).toContain("2026-10-26 · 12 条");
    expect(html).toContain("还没整理");
    expect(html).toContain("清掉的手机再交来也不再收，还没整理的那天清掉了，摘要里就没有这些");
    expect(html.match(/>清掉</g)).toHaveLength(2);
    expect(list([phone])).not.toContain("source-raw");
    expect(renderToStaticMarkup(createElement(RawDays, { source: source({ raw: { title: "原始位置点", days: [] } }), busy: false, onClear: noop }))).toBe("");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("297 号票：导入的东西不进素材的写明去哪（每 30 分钟、显示在日历里）；数据源报的提示写在那一行、不标红", () => {
    const calendar = source({ title: "Google · 日历", schedule: "每 30 分钟", destination: "显示在日历里（只读），不进素材", note: "日历插件没启用：同步来的事件现在在日历里看不到（照样同步、照样查得到）" });
    const html = list([calendar]);
    expect(html).toContain("每 30 分钟 自动同步，显示在日历里（只读），不进素材");
    expect(html).not.toContain("整理成素材");
    expect(html).toContain('<div class="hint source-note">日历插件没启用：同步来的事件现在在日历里看不到（照样同步、照样查得到）</div>');
    expect(list([source({ schedule: undefined, destination: "显示在日历里（只读），不进素材" })])).toContain("点「立即同步」时导入，显示在日历里（只读），不进素材");
  });

  test("301 号票：只靠导入文件夹、导入的去档案候选的（Google · 联系人）——写放文件时导入和去哪；上次那一行写导入的文件和数据源写的那一句", () => {
    const contacts = source({
      id: "google-contacts",
      title: "Google · 联系人",
      connection: "manual",
      account: undefined,
      usages: [{ usage: "import", on: true }],
      sensitive: [],
      schedule: undefined,
      canSync: false,
      count: 5,
      destination: "进档案候选核对卡（逐条确认才写），不进素材",
      files: ["Google 联系人导出的 vCard（.vcf）"],
      lastSync: { at: "2026-10-25T09:20:00.000+08:00", trigger: "file", added: 5, file: "contacts.vcf", summary: "5 人进档案候选；另有 1 人没进候选" },
    });
    const html = list([contacts]);
    expect(html).toContain("往导入文件夹放文件时导入，进档案候选核对卡（逐条确认才写），不进素材");
    expect(html).not.toContain("点「立即同步」");
    expect(html).toContain("上次导入 10-25 09:20（contacts.vcf）：5 人进档案候选；另有 1 人没进候选 · 共 5 条");
    expect(html).toContain("认导入文件夹里的：Google 联系人导出的 vCard（.vcf）");
    expect(html).toContain(">删除已导入的<");
    expect(html).not.toMatch(/秘书|待我处理/);
  });
});

describe("断开的确认框", () => {
  test("两个选择：留着已导入的（默认）、连已导入的一起删；选了删写明不能恢复、按钮变危险", () => {
    const keep = confirm(source(), false);
    expect(keep).toContain("断开「相机」");
    expect(keep).toContain("已经导入的 128 条怎么办？");
    expect(keep).toContain("留着已导入的");
    expect(keep).toContain("连已导入的一起删");
    expect(keep).not.toContain("不能恢复");
    expect(keep).toContain('class="btn primary">断开<');
    const purge = confirm(source(), true);
    expect(purge).toContain("彻底删除不能恢复");
    expect(purge).toContain('class="btn danger">断开并删除<');
  });

  test("只靠导入文件夹的：只有删除已导入的，写明不能恢复", () => {
    const html = confirm(source({ connection: "manual", count: 42 }), true);
    expect(html).toContain("删除「相机」已导入的");
    expect(html).toContain("已经导入的 42 条记录");
    expect(html).not.toContain("留着已导入的");
    expect(html).toContain('class="btn danger">删除<');
  });
});

describe("导入文件夹", () => {
  const folder: ImportFolderView = {
    path: "D:\\ergo\\imports",
    importedPath: "D:\\ergo\\imports\\imported",
    pending: [{ name: "takeout.zip", size: 10, problem: "unrecognized", text: "认不出是哪个数据源的文件，留在这里" }],
    recent: [{ name: "账单.csv", source: "bills", sourceTitle: "账单", at: "2026-10-25T09:30:00.000+08:00", added: 42 }],
    scannedAt: "2026-10-25T10:05:00.000+08:00",
  };

  test("路径、复制、在电脑上打开、现在检查；没导入的和原因；最近导入的；上次检查", () => {
    const html = renderToStaticMarkup(createElement(ImportFolderBlock, { folder, busy: false, onCopy: noop, onOpen: noop, onScan: noop }));
    expect(html).toContain("D:\\ergo\\imports");
    expect(html).toContain(">复制路径<");
    expect(html).toContain(">在电脑上打开<");
    expect(html).toContain(">现在检查<");
    expect(html).toContain("没导入的（1）");
    expect(html).toContain('data-problem="unrecognized"');
    expect(html).toContain("认不出是哪个数据源的文件，留在这里");
    expect(html).toContain("账单.csv → 账单，42 条 · 10-25 09:30");
    expect(html).toContain("上次检查 10-25 10:05");
    const empty = renderToStaticMarkup(createElement(ImportFolderBlock, { folder: { ...folder, pending: [], recent: [], scannedAt: undefined }, busy: false, onCopy: noop, onOpen: noop, onScan: noop }));
    expect(empty).not.toContain("没导入的");
    expect(empty).toContain("还没检查过");
  });
});

describe("做完说一句", () => {
  test("同步好了几条、还在同步、出错；断开（连已导入的一起删时删了几条）；开关用法", () => {
    const s = source();
    expect(doneText(s, { action: "sync", idempotencyKey: "k" }, { view: { sources: [], folder: { path: "", importedPath: "", pending: [], recent: [] } }, added: 3 })).toBe("同步好了：新进来 3 条");
    const view = { sources: [], folder: { path: "", importedPath: "", pending: [], recent: [] } };
    expect(doneText(s, { action: "sync", idempotencyKey: "k" }, { view })).toBe("还在同步，好了会显示在这里");
    expect(doneText(s, { action: "sync", idempotencyKey: "k" }, { view, error: "401" })).toBe("同步出错：401");
    expect(doneText(s, { action: "disconnect", purge: false, idempotencyKey: "k" }, { view })).toBe("断开了「相机」");
    expect(doneText(s, { action: "disconnect", purge: true, idempotencyKey: "k" }, { view, purged: { events: 130, materials: 128, files: 0 } })).toBe("断开了「相机」：删了 130 条记录、128 条素材、0 个文件");
    expect(doneText(s, { action: "usage", usage: "import", on: false, idempotencyKey: "k" }, { view })).toBe("「相机」的导入关了");
    expect(doneText(source({ raw: { title: "原始位置点", days: [] } }), { action: "clear_raw", dates: ["2026-10-25"], idempotencyKey: "k" }, { view, cleared: 68 })).toBe("清掉了 68 条原始位置点");
    // 307 号票：在电脑上打开数据源的文件夹
    expect(doneText(s, { action: "open", idempotencyKey: "k" }, { view, opened: true })).toBe("在电脑上打开了「相机」的文件夹");
    expect(doneText(s, { action: "open", idempotencyKey: "k" }, { view, opened: false, error: "打不开：拒绝访问" })).toBe("打不开：拒绝访问");
  });
});

describe("断开的确认框里数据源报的那一句（307 号票）", () => {
  test("有就写（Looki：存到本地的文件不删），没有不写", () => {
    const note = "存到本地的照片、日记、vlog（D:\\Looki）不删：那是你自己的档案，要删自己去文件夹里删";
    expect(confirm(source({ disconnectNote: note }), true)).toContain(`<p class="source-keep-note">${note}</p>`);
    expect(confirm(source(), true)).not.toContain("source-keep-note");
  });
});

/** 只靠导入文件夹的数据源（共 4 条）删除已导入的确认框 */
const manual = (extra: Partial<DataSourceView>) => confirm(source({ connection: "manual", count: 4, ...extra }), true);

describe("断开的确认框按数据源说话（306 号票）", () => {
  const PHONE_NOTE = "断开后，同步来的手机日程不再显示在二狗的日历里，手机上的日历不动；选「连已导入的一起删」，这些日程在二狗这边的记录也删掉。";
  const phoneCalendar = () =>
    source({ id: "phone-calendar", title: "手机 · 日历", usages: [{ usage: "import", on: true }], files: [], count: 3, disconnectNote: PHONE_NOTE, fromDevice: true });

  test("真有密钥、真进素材（Looki 这种）：照旧说密钥从这台电脑上删掉、素材照样在、由它们整理出的素材一起删", () => {
    const html = confirm(source({ hasSecrets: true, toMaterials: true }), false);
    expect(html).toContain("断开以后不再同步、按需查，填过的密钥从这台电脑上删掉。已经导入的 128 条怎么办？");
    expect(html).toContain("素材照样在");
    expect(html).toContain("由它们整理出的素材和原文副本一起彻底删除");
  });

  test("手机日历（没密钥、不进素材、只有导入）：不提密钥、素材、按需查；数据源报的那一句写实际会怎样", () => {
    const html = confirm(phoneCalendar(), false);
    expect(html).toContain("断开以后不再同步。已经导入的 3 条怎么办？");
    expect(html).toContain("留着已导入的（记录留在这台电脑上，重新连上接着用）");
    expect(html).toContain("连已导入的一起删（导入的记录彻底删除）");
    expect(html).toContain(PHONE_NOTE);
    for (const generic of ["密钥", "素材", "按需查"]) expect(html).not.toContain(generic);
  });

  test("有密钥、不进素材（Google 日历）：说密钥，不说素材；只有按需查的说不再按需查", () => {
    const calendar = confirm(source({ hasSecrets: true, usages: [{ usage: "query", on: true }, { usage: "import", on: true }] }), true);
    expect(calendar).toContain("填过的密钥从这台电脑上删掉");
    expect(calendar).not.toContain("素材");
    expect(confirm(source({ hasSecrets: true, usages: [{ usage: "query", on: true }] }), false)).toContain("断开以后不再按需查，填过的密钥");
  });

  test("只靠导入文件夹的删除已导入的：按进不进素材、认不认文件四种说法（通讯录选人、Google 联系人不提素材）", () => {
    expect(manual({ toMaterials: true })).toContain("已经导入的 4 条记录、由它们整理出的素材和原文副本、「已导入」里它的文件一起彻底删除。");
    expect(manual({ toMaterials: true, files: [] })).toContain("已经导入的 4 条记录、由它们整理出的素材和原文副本一起彻底删除。");
    const contacts = manual({ files: ["Google 联系人导出的 vCard（.vcf）"], disconnectNote: "从 Google 联系人导入、档案候选里还没处理的一起作废" });
    expect(contacts).toContain("已经导入的 4 条记录、「已导入」里它的文件一起彻底删除。");
    expect(contacts).toContain("从 Google 联系人导入、档案候选里还没处理的一起作废");
    expect(contacts).not.toContain("素材");
    expect(manual({ files: [] })).toContain("已经导入的 4 条记录彻底删除。");
  });
});

describe("出错的每小时自动再试（306 号票）", () => {
  test("出错、内核每小时替它再试的：出错那一行下面写明（能填设置的加一句也可以重新填）；没有 autoRetry 的不写", () => {
    expect(list([source({ connection: "error", problem: "Key 失效了", autoRetry: true })])).toContain("每小时自动再试一次，也可以重新填。");
    expect(list([source({ connection: "error", problem: "那边出错了", autoRetry: true, configurable: false })])).toContain("每小时自动再试一次。");
    expect(list([source({ connection: "error", problem: "Key 不对" })])).not.toContain("每小时自动再试");
  });
});
