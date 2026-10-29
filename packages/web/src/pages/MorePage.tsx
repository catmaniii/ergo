// "更多"（33 号票）：主导航放不下、收进来的那些项（消耗、记忆、设置，从末尾起收）；直接显示在导航里的项
// 各自是一页，不再出现在"更多"里。设置下面的几页（外观与风格、关注类别、工作日规则、skill 库、语音、已配对设备……）照旧在设置里。
// 35 号票：工作日历升为主导航的日历（CalendarPage），设置里只留"工作日规则"（额外上班规则）。主导航收不下日历时，它也收进"更多"。
// 地址都还是 #/more/<页>：同一页显示在"更多"里还是自己一页，看它现在收没收起。
// 74 号票：外观和风格不再摊在设置列表上，合成设置下面的一页"外观与风格"（#/more/appearance），和别的设置项一样点进去改。
// 71 号票：设置下面的"系统提示"（#/more/prompts），点进某一份是下一级（#/more/prompts/<编号>）：标题栏的返回回到系统提示的列表。
// 158 号票：删除素材里点开一条看内容也是下一级，标题写"素材详情"，返回回到素材列表。
// 167 号票：设置里的"删除素材"去掉，并进"记忆"：记忆分几层（233 号票起是素材、结论、证据与推理、问题箱），每层单独点进去（plugins/memory/MemoryPage.tsx）；
// 记忆直接显示在导航里时自己排（MemorySection：宽屏左边几项、右边那一层），收进"更多"时在"更多"右边那一栏里（MemoryColumn）。
// 73 号票：设置下面加一页"模型"（#/more/models）：服务商、API key 的状态、默认模型和各个 agent 的模型、看图能力、连通测试。
// 123 号票：已配对设备自己排一栏（标题栏上的"多选"、多选时贴在底边的操作栏，和待办一样），别的页照旧是标题栏加一整块滚动区（SubPageCol）。
// 124 号票：设置最下面加"关于二狗"（#/more/about：版本、更新日志）；关于页连点版本号 8 次打开的"Debug 工具集"（#/more/debug），
// 打开后列表里"关于二狗"下面多出一项，1 小时后消失。
// 168 号票：设置列表里加"语言 / Language"（#/more/language，第一项，永远中英两种写着），页面名字、说明按当前语言现取（多语言的外壳）。
// 193 号票：记忆挪进记忆插件（网页插件的页面插槽，plugins/memory/MemoryPage.tsx）。网页插件的页面和记忆原来一样排：直接显示在导航里时
// 自己排（PageSlot.Section），收进"更多"时在"更多"右边那一栏里（PageSlot.Column），"更多"的菜单里按导航的先后列；插件停用了没有这一页
// （地址还在的写"X插件没启用"）。设置列表里核心的各页之后是网页插件的设置分节（SettingsSectionSlot）。设置下面加回内核的"删除素材"
// （#/more/materials-delete，21、158 号票那一套成批删除）：只在没有哪个在用的插件页面包含它（PageSlot.covers：记忆页里有）时列出——
// 记忆插件停用时删除照常（129 号票）。
// 211 号票：设置下面加一页"插件"（#/more/plugins，排在已配对设备后面）：看装了哪些插件，运行中停用、启用、移除（pages/more/PluginsPage.tsx）。
// 213 号票：日历挪进日历插件（网页插件的页面，plugins/calendar/）：它有自己的地址（PageSlot.route，#/calendar），"更多"里点了照旧去那一页，
// 不在"更多"右边那一栏；日历插件停用时"更多"里没有它。
// 214 号票：设置 · 语音的页面内容是语音插件画的（settingsPages 插槽，plugins/voice/VoicePage.tsx）；地址、名字、在设置列表里的位置照旧在这里。
// 插件拥有、却没在用（停用了）的设置页：设置列表里不列，地址写"X插件没启用"。
// 281 号票："更多"的菜单里在收进来的导航项后面多一项"个人档案"（#/more/files，内核的页面，一直在；不是导航项，主导航放得下全部时
// 导航上没有"更多"，就从设置 · 身份"我的名字"下面那一行、记忆页的链接进）。点进一个人是下一级，返回回到列表；列表的返回回到来处
// （从设置、记忆页点过来的回那里），没有来处回"更多"。入口位置和版式要用户定（票的 Comments）。
// 295 号票：设置 · 数据与设备组的第一项"数据源"（#/more/data-sources，内核的页面，pages/more/DataSourcesPage.tsx）：插件登记的数据源一处列出
// 和共用的导入文件夹；记忆页里也有链接过来。
// 285 号票：记忆插件在用时，个人档案是记忆页里的"档案"一栏（PageSlot.covers + coverRoute）——"更多"里不再列它，#/more/files[/<编号>]
// 换到 #/more/memory/files[/<编号>]（地址栏里换掉，不压新记录；核对卡、回执上的链接都经这里），设置 · 身份那一行直接去那里；
// 记忆插件停用时照旧："更多"里有个人档案，就是这一页。"加一个人"在标题栏上（PersonalFilesColumn）。
// 323 号票：设置 · 能力组里插件后面加一页"组件"（#/more/components，内核的页面，pages/more/ComponentsPage.tsx）：模型、语音这些大件
// 装了哪些、多大、哪个版本，装 / 删 / 更新、暂停 / 继续 / 取消、从文件导入；没装的组件对应的功能在界面上灰掉，点一下来这里装。
// 247 号票：设置列表从 12 项平铺改成四组可折叠——身份（名字、语言、外观与风格、语音）、能力（模型、skill 和 MCP、插件、浏览与填框）、
// 规则（关注类别、系统提示、工作日规则）、数据与设备（删除素材、工具调用的完整内容、已配对设备、关于二狗）。组标题一行，点一下收起 / 展开，
// 四组默认都展开，这台设备记住收起了哪几组（state/settings-groups.ts、app/page-settings-fold.ts）。组只是列表上的组织：地址照旧
// #/more/<页>，插件停用时那一页不列的规矩、记忆页里已经有"删除素材"就不重复列的规矩都不变（settingsShown / settingsGroups）。
// 319 号票：设置列表最上面多一行"设置向导"（#/more/setup，pages/SetupWizard.tsx）：首次设置的五步加一屏外网访问的说明。
// 它不进四组（不是哪一类的设置，是一次走完的流程），所以 settingsShown / settingsGroups 里没有它。
// 319b：数据与设备组里"关于二狗"前面多一行"体检"（#/more/doctor，pages/more/DoctorPage.tsx）：八项一查、右上"再查一遍"。
import { Fragment, useEffect } from "react";
import { useDebugUnlock } from "../app/page-debug.ts";
import { pageSettingsFold, useSettingsFolded } from "../app/page-settings-fold.ts";
import { backToHash, cameFrom } from "../app/history-nav.ts";
import { goBackTo, isMorePage, type MorePage as Sub, type Navigate, navItemOf, type Route, toHash } from "../app/route.ts";
import { usePlugins, type WebPluginHost } from "../plugins/api.ts";
import { activeLocale, LANGUAGE_SETTING_TITLE, type NavItem, type SettingsGroupId, t, tTable } from "../state/index.ts";
import { ListDetail, TopBar } from "../ui/common.tsx";
import { Icon } from "../ui/icons.tsx";
import { NavIcon } from "../ui/main-nav.tsx";
import { PersonalFilesColumn } from "./more/PersonalFilesPage.tsx";
import { AboutPage } from "./more/AboutPage.tsx";
import { AppearancePage, AppearanceSummary } from "./more/AppearancePage.tsx";
import { UserNameSetting } from "./more/UserNameSetting.tsx";
import { BrowsingPage } from "./more/BrowsingPage.tsx";
import { DebugPage } from "./more/DebugPage.tsx";
import { DevicesPage } from "./more/DevicesPage.tsx";
import { LanguagePage } from "./more/LanguagePage.tsx";
import { MaterialsBulkDelete } from "./more/MaterialsBulkDelete.tsx";
import { ModelsPage } from "./more/ModelsPage.tsx";
import { NativeAppInfo } from "./more/NativeAppInfo.tsx";
import { PluginsPage } from "./more/PluginsPage.tsx";
import { ComponentsPage } from "./more/ComponentsPage.tsx";
import { DataSourcesPage } from "./more/DataSourcesPage.tsx";
import { DoctorPage } from "./more/DoctorPage.tsx";
import { PromptsPage } from "./more/PromptsPage.tsx";
import { RolesPage } from "./more/RolesPage.tsx";
import { SettingsGroup } from "./more/SettingsGroup.tsx";
import { SkillsPage } from "./more/SkillsPage.tsx";
import { ToolCallStorageSetting } from "./more/ToolCallStorageSetting.tsx";
import { BackupSetting } from "./more/BackupSetting.tsx";
import { UsagePage } from "./more/UsagePage.tsx";
import { WatchCategoriesPage } from "./more/WatchCategoriesPage.tsx";
import { WorkdayRulesPage } from "./more/WorkdayRulesPage.tsx";
import { SetupPage } from "./SetupWizard.tsx";

/** 每一页的名字（标题栏和菜单共用）和菜单里的一句说明（168 号票起按当前语言现取，语言文件 shell.json 的 shell.pages.*） */
const PAGE_TITLES: Readonly<Record<Exclude<Sub, "language">, string>> = tTable({
  usage: "shell.pages.usage.title",
  settings: "shell.pages.settings.title",
  setup: "shell.pages.setup.title",
  appearance: "shell.pages.appearance.title",
  models: "shell.pages.models.title",
  watch: "shell.pages.watch.title",
  "workday-rules": "shell.pages.workdayRules.title",
  skills: "shell.pages.skills.title",
  prompts: "shell.pages.prompts.title",
  roles: "shell.pages.roles.title",
  voice: "shell.pages.voice.title",
  browsing: "shell.pages.browsing.title",
  devices: "shell.pages.devices.title",
  plugins: "shell.pages.plugins.title",
  components: "shell.pages.components.title",
  "claude-code": "shell.pages.claudeCode.title",
  "data-sources": "shell.pages.dataSources.title",
  "materials-delete": "shell.pages.materialsDelete.title",
  doctor: "doctor.title",
  about: "shell.pages.about.title",
  debug: "shell.pages.debug.title",
  files: "shell.pages.files.title",
});
// 设置列表上外观与风格的副标题不用这句，写的是现在选的（AppearanceSummary）；语言的写的是正在用的那种的本地名
const PAGE_SUBS: Readonly<Record<Exclude<Sub, "language">, string>> = tTable({
  usage: "shell.pages.usage.sub",
  settings: "shell.pages.settings.sub",
  setup: "shell.pages.setup.sub",
  appearance: "shell.pages.appearance.sub",
  models: "shell.pages.models.sub",
  watch: "shell.pages.watch.sub",
  "workday-rules": "shell.pages.workdayRules.sub",
  skills: "shell.pages.skills.sub",
  prompts: "shell.pages.prompts.sub",
  roles: "shell.pages.roles.sub",
  voice: "shell.pages.voice.sub",
  browsing: "shell.pages.browsing.sub",
  devices: "shell.pages.devices.sub",
  plugins: "shell.pages.plugins.sub",
  components: "shell.pages.components.sub",
  "claude-code": "shell.pages.claudeCode.sub",
  "data-sources": "shell.pages.dataSources.sub",
  "materials-delete": "shell.pages.materialsDelete.sub",
  doctor: "doctor.sub",
  about: "shell.pages.about.sub",
  debug: "shell.pages.debug.sub",
  files: "shell.pages.files.sub",
});

/** 一页的名字：语言那一页永远中英两种写着（168 号票：选错了语言也找得回来） */
const pageTitle = (p: Sub) => (p === "language" ? LANGUAGE_SETTING_TITLE : PAGE_TITLES[p]);
/** 菜单里的一句说明：语言那一页写正在用的那种的本地名 */
const pageSub = (p: Sub) => (p === "language" ? activeLocale().meta.nativeName : PAGE_SUBS[p]);

/**
 * 设置列表里的一行：一页，或者不是页的那几块（我的名字、工具调用的完整内容、备份〔335 号票〕）；"个人档案"（281 号票）是"更多"下面的页，
 * 在身份组"我的名字"下面放一个去那里的链接
 */
type SettingsRow = Sub | "user-name" | "tool-call-storage" | "backup" | "personal-files-link";
const isPage = (row: SettingsRow): row is Sub => row !== "user-name" && row !== "tool-call-storage" && row !== "backup" && row !== "personal-files-link";

/**
 * 设置的四组和组里的项（247 号票，用户 2026-10-22 定方案 A），按显示顺序。组只是列表上的组织，每页的地址照旧 #/more/<页>。
 * 语音（音色）票面上没写归哪组，放"身份"（"二狗这个人"的声音）；248 号票会把它和名字合成"角色与声音"。
 */
const SETTINGS_GROUPS: readonly { id: SettingsGroupId; rows: readonly SettingsRow[] }[] = [
  // 248 号票："角色与声音"紧挨着"我的名字"（助理的名字不再单独设：就是默认角色的名字，在这一页里改），语音页只留引擎状态和自动播放
  // 281 号票："我的名字"下面一行去个人档案的链接（本人那份的姓名就是我的名字）
  { id: "identity", rows: ["user-name", "personal-files-link", "roles", "language", "appearance", "voice"] },
  // 305 号票：设置 · Claude Code（Claude Code 插件画的页，新建时的默认文件夹）排在插件后面；插件停用时不列
  // 323 号票：设置 · 组件（模型、语音这些大件按需下载）紧挨着插件
  { id: "ability", rows: ["models", "skills", "plugins", "components", "claude-code", "browsing"] },
  { id: "rules", rows: ["watch", "prompts", "workday-rules"] },
  // 295 号票：数据源排在这一组最前面（外面接进来的数据，和删除素材挨着）
  // 335 号票："备份"（同步目录、最近一次、下一次、立即备份）紧挨着工具调用的完整内容
  // 319b：体检（八项一查）排在"关于二狗"前面：都是"这套东西现在怎么样"的那一类
  { id: "data", rows: ["data-sources", "materials-delete", "tool-call-storage", "backup", "devices", "doctor", "about"] },
];

/**
 * 设置列表里列哪几页（按显示顺序）：在用的网页插件页面里已经有的设置页不再列（193 号票：记忆页里有成批删除，记忆插件停用时才列"删除素材"）；
 * 插件画的设置页（214 号票：设置 · 语音），插件没在用时不列。247 号票起顺序按四组摊平（组见 SETTINGS_GROUPS）
 */
export function settingsShown(plugins: Pick<WebPluginHost, "list" | "unavailable">): Sub[] {
  const covered = new Set(plugins.list("pages").flatMap((p) => p.covers ?? []));
  return SETTINGS_GROUPS.flatMap((g) => g.rows)
    .filter(isPage)
    .filter((s) => !covered.has(s) && plugins.unavailable("settingsPages", s) === undefined);
}

/**
 * 四组各自现在列哪些（247 号票）：页按 settingsShown 的规矩过滤，"名字""工具调用的完整内容"两块照旧常列。
 * Debug 工具集打开着时挂在最后一组的"关于二狗"下面（124 号票照旧：1 小时内有效，到期就没了）
 */
export function settingsGroups(plugins: Pick<WebPluginHost, "list" | "unavailable">, debugOpen: boolean): { id: SettingsGroupId; rows: SettingsRow[] }[] {
  const shown = new Set(settingsShown(plugins));
  return SETTINGS_GROUPS.map((group) => {
    const rows = group.rows.filter((row) => !isPage(row) || shown.has(row));
    return { id: group.id, rows: group.id === "data" && debugOpen ? [...rows, "debug" as const] : rows };
  });
}

/**
 * 285 号票：核心的这一页被在用的网页插件页面盖住了、搬到了那一页里时去哪（个人档案 → 记忆 · 档案）；没被盖住、
 * 或者盖住的只是设置里不列（成批删除）是 undefined
 */
export function coveredRoute(plugins: Pick<WebPluginHost, "list">, page: Sub, item: string | undefined): Route | undefined {
  for (const slot of plugins.list("pages")) {
    if (!slot.covers?.includes(page)) continue;
    const route = slot.coverRoute?.(page, item);
    if (route !== undefined) return route;
  }
  return undefined;
}

/** folded：主导航现在收进"更多"的项（按导航的顺序） */
/** item、sub：有下一级的页点进去的那一项（系统提示的编号、删除素材里点开的一条；网页插件的页面自己认，比如记忆的哪一层、那一层里点开的素材） */
export function MorePage({ wide, page: shownPage, item, sub, folded, navigate }: { wide: boolean; page?: string; item?: string; sub?: string; folded: readonly NavItem[]; navigate: Navigate }) {
  const plugins = usePlugins();
  // 网页插件的页面（193 号票）：在用的插件登记了它；停用的插件拥有它就写"X插件没启用"；谁都不认得的地址当作"更多"
  const plugin = shownPage !== undefined && !isMorePage(shownPage) ? shownPage : undefined;
  const pluginPage = plugin === undefined ? undefined : plugins.get("pages", plugin);
  const offPage = plugin !== undefined && !pluginPage ? plugins.unavailable("pages", plugin) : undefined;
  const page = shownPage !== undefined && isMorePage(shownPage) ? shownPage : undefined;
  const go = (p: Sub) => navigate({ tab: "more", page: p });
  // 285：搬进了插件页面的（记忆插件在用时的个人档案）：地址栏里换到那里
  const moved = page === undefined ? undefined : coveredRoute(plugins, page, item);
  const movedHash = moved === undefined ? undefined : toHash(moved);
  useEffect(() => {
    if (movedHash !== undefined) window.location.replace(movedHash);
  }, [movedHash]);
  if (moved !== undefined) return null;
  // 这一页所属的项直接显示在导航里：它自己一页，不经过"更多"
  const owner = page && navItemOf({ tab: "more", page });
  // 有自己地址的（213 号票：日历）没有"更多"右边那一栏：#/more/<id> 也整页画
  if (pluginPage && (!folded.includes(pluginPage.id) || !pluginPage.Column)) return <pluginPage.Section wide={wide} item={item} sub={sub} navigate={navigate} />;
  if (page && owner === "usage" && !folded.includes(owner)) return <OwnPage page={page} go={go} navigate={navigate} />;
  if (page && owner === "settings" && !folded.includes("settings")) return <SettingsSection wide={wide} page={page} item={item} go={go} navigate={navigate} />;

  // 竖屏：设置下面的页返回到设置，其余返回到"更多"；有下一级的页点进去的那一项返回到那一页（宽屏也是）。网页插件的页面同"消耗"。
  // 个人档案（281）不是设置下面的页：回到来处（从设置、记忆页点过来的回那里），没有来处回"更多"
  const back =
    page && item
      ? () => go(page)
      : wide
        ? undefined
        : page === "files"
          ? () => backToHash(window, cameFrom(window) ?? toHash({ tab: "more" }))
          : () => navigate(page && page !== "settings" && page !== "usage" ? { tab: "more", page: "settings" } : { tab: "more" });
  const menu = <MoreMenu wide={wide} folded={folded} current={shownPage} go={go} navigate={navigate} />;
  const detail = pluginPage?.Column ? (
    // 网页插件的页面自己管下一级的返回（记忆的几层）：back 只用在它最上面那一栏
    <pluginPage.Column item={item} sub={sub} navigate={navigate} onBack={back} />
  ) : offPage !== undefined ? (
    <div className="chat-col">
      <TopBar title={offPage} onBack={back} />
      <div className="page-placeholder">{t("ui.plugins.pageUnavailable", { plugin: offPage })}</div>
    </div>
  ) : page ? (
    page === "settings" && !wide ? (
      <div className="chat-col">
        <TopBar title={pageTitle("settings")} onBack={back} />
        <div className="scroll">
          <SettingsList current={page} go={go} navigate={navigate} />
        </div>
      </div>
    ) : (
      <SubPageCol page={page} item={item} onBack={back} go={go} navigate={navigate} />
    )
  ) : undefined;
  return <ListDetail wide={wide} list={menu} detail={detail} listWidth={280} />;
}

/** 消耗直接显示在导航里时：自己一页，没有返回（记忆 167 号票起分三层，自己排：MemorySection） */
function OwnPage({ page, go, navigate }: { page: Sub; go(p: Sub): void; navigate: Navigate }) {
  return (
    <div className="chat-col">
      <TopBar title={pageTitle(page)} />
      <div className="scroll page-pad">
        <SubPage page={page} go={go} navigate={navigate} />
      </div>
    </div>
  );
}

/**
 * 设置直接显示在导航里时：宽屏左边是设置的列表、右边是选中的那页；竖屏先列设置，点进去的页返回到设置。
 * 有下一级的页（系统提示）点进去的那一项返回到那一页
 */
function SettingsSection({ wide, page, item, go, navigate }: { wide: boolean; page: Sub; item?: string; go(p: Sub): void; navigate: Navigate }) {
  const sub = page === "settings" ? undefined : page;
  const list = (
    <div className="chat-col">
      <TopBar title={pageTitle("settings")} />
      <div className="scroll">
        <SettingsList current={sub} go={go} navigate={navigate} />
      </div>
    </div>
  );
  const detail = sub && <SubPageCol page={sub} item={item} onBack={item ? () => go(sub) : wide ? undefined : () => go("settings")} go={go} navigate={navigate} />;
  return <ListDetail wide={wide} list={list} detail={detail} listWidth={280} />;
}

/** 子页的一栏：标题栏和一整块滚动区。已配对设备（123 号票）自己排这一栏：标题栏上的"多选"、多选时贴在底边的操作栏 */
function SubPageCol({ page, item, onBack, go, navigate }: { page: Sub; item?: string | undefined; onBack: (() => void) | undefined; go(p: Sub): void; navigate: Navigate }) {
  if (page === "devices") return <DevicesPage title={pageTitle("devices")} onBack={onBack} onPreviewPairing={() => navigate({ tab: "pair-wait" })} />;
  // 设置向导（319 号票）：标题栏上除了返回还有它自己的"先不弄了"（任何时候都能出去接着用），内容和步骤在 pages/SetupWizard.tsx
  if (page === "setup") return <SetupPage title={pageTitle("setup")} onBack={onBack} navigate={navigate} />;
  // 体检（319b）：标题栏右上"再查一遍"，八项在 pages/more/DoctorPage.tsx
  if (page === "doctor") return <DoctorPage title={pageTitle("doctor")} onBack={onBack} />;
  // 个人档案（281）：标题栏上有"加一个人"（285），点进一个人是下一级 #/more/files/<编号>；删掉这个人回到列表（不压新记录）
  if (page === "files")
    return (
      <PersonalFilesColumn
        title={pageTitle("files")}
        item={item}
        onBack={onBack}
        onOpen={(id) => navigate({ tab: "more", page: "files", item: id })}
        onRemoved={() => goBackTo({ tab: "more", page: "files" })}
      />
    );
  return (
    <div className="chat-col">
      <TopBar title={pageTitle(page)} onBack={onBack} />
      <div className="scroll page-pad">
        <SubPage page={page} item={item} go={go} navigate={navigate} />
      </div>
    </div>
  );
}

function SubPage({ page, item, go, navigate }: { page: Sub; item?: string; go(p: Sub): void; navigate: Navigate }) {
  // 插件画的设置页（214 号票：设置 · 语音）：在用的插件登记了就画它的；插件停用了写"X插件没启用"
  const plugins = usePlugins();
  const drawn = plugins.get("settingsPages", page);
  if (drawn) return <drawn.Page navigate={navigate} />;
  const offPlugin = plugins.unavailable("settingsPages", page);
  if (offPlugin !== undefined) return <div className="page-placeholder">{t("ui.plugins.pageUnavailable", { plugin: offPlugin })}</div>;
  switch (page) {
    case "usage":
      return <UsagePage />;
    case "settings":
      return <SettingsList current={page} go={go} navigate={navigate} />;
    case "language":
      return <LanguagePage />;
    case "appearance":
      return <AppearancePage />;
    case "models":
      return <ModelsPage navigate={navigate} />;
    case "watch":
      return <WatchCategoriesPage />;
    case "workday-rules":
      return <WorkdayRulesPage navigate={navigate} />;
    case "skills":
      return <SkillsPage />;
    case "prompts":
      return <PromptsPage item={item} onOpen={(id) => navigate({ tab: "more", page: "prompts", item: id })} />;
    case "roles":
      // 角色与声音（248 号票）：角色表、默认角色、每个 agent 用哪个角色
      return <RolesPage />;
    case "voice":
      // 语音插件画的（上面），谁都不认得时（只渲染一个组件的测试）空着
      return null;
    case "browsing":
      return <BrowsingPage />;
    case "devices":
      // 自己排一栏，见 SubPageCol
      return null;
    case "setup":
      // 自己排一栏（标题栏上多个"先不弄了"），见 SubPageCol
      return null;
    case "doctor":
      // 自己排一栏（标题栏右上"再查一遍"），见 SubPageCol
      return null;
    case "plugins":
      return <PluginsPage />;
    case "components":
      return <ComponentsPage />;
    case "data-sources":
      return <DataSourcesPage />;
    case "materials-delete":
      // 内核的成批删除（193 号票：记忆插件停用时从设置进来；点开一条是下一级 #/more/materials-delete/<素材 id>，删了这一条回到列表）
      return (
        <MaterialsBulkDelete
          item={item}
          onOpen={(id) => navigate({ tab: "more", page: "materials-delete", item: id })}
          onClose={() => goBackTo({ tab: "more", page: "materials-delete" })}
          navigate={navigate}
        />
      );
    case "files":
      // 个人档案自己排一栏，见 SubPageCol
      return null;
    case "about":
      return <AboutPage onDebug={() => go("debug")} />;
    case "debug":
      return <DebugPage navigate={navigate} />;
  }
}

/**
 * "更多"的菜单：只列收进来的项，按导航的顺序（秘书、任务、项目、待我处理再挤也直接显示，不会收进来）。
 * 网页插件的页面（193 号票）照"消耗"那样一项：导航那一项的图标、页面标题、一句说明；有自己地址的（213 号票：日历）点了去那里
 */
function MoreMenu({ wide, folded, current, go, navigate }: { wide: boolean; folded: readonly NavItem[]; current?: string | undefined; go(p: Sub): void; navigate: Navigate }) {
  const plugins = usePlugins();
  const entry = (item: NavItem) => {
    if (item === "usage")
      return (
        <button key={item} type="button" className={`menu-item${current === "usage" ? " on" : ""}`} onClick={() => go("usage")}>
          <NavIcon entry="usage" className="menu-icon" />
          <span className="menu-text">
            {pageTitle("usage")}
            <small>{pageSub("usage")}</small>
          </span>
        </button>
      );
    if (item === "settings")
      return wide ? (
        <Fragment key={item}>
          <div className="menu-group">{pageTitle("settings")}</div>
          <SettingsList current={current !== undefined && isMorePage(current) ? current : undefined} go={go} navigate={navigate} />
        </Fragment>
      ) : (
        <button key={item} type="button" className="menu-item" onClick={() => go("settings")}>
          <NavIcon entry="settings" className="menu-icon" />
          <span className="menu-text">
            {pageTitle("settings")}
            <small>{pageSub("settings")}</small>
          </span>
        </button>
      );
    const page = plugins.get("pages", item);
    if (!page) return null;
    return (
      <button key={item} type="button" className={`menu-item${current === page.id ? " on" : ""}`} onClick={() => navigate(page.route ?? { tab: "more", page: page.id })}>
        <NavIcon entry={page.id} icon={page.icon} className="menu-icon" />
        <span className="menu-text">
          {page.title}
          <small>{page.sub}</small>
        </span>
      </button>
    );
  };
  return (
    <div className="chat-col">
      <TopBar title={t("shell.more.title")} />
      <div className="scroll">
        <div className="menu">
          {folded.map(entry)}
          {/* 281 号票：个人档案（内核的页面；不是导航项，所以没有导航图标，用线条图标）。285 号票：记忆插件在用时它是记忆页里的"档案"，这里不列 */}
          {coveredRoute(plugins, "files", undefined) === undefined && (
            <button type="button" className={`menu-item${current === "files" ? " on" : ""}`} data-page="files" onClick={() => go("files")}>
              <span className="menu-icon pf-menu-icon" aria-hidden="true">
                <Icon name="person" />
              </span>
              <span className="menu-text">
                {pageTitle("files")}
                <small>{pageSub("files")}</small>
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 设置的列表（247 号票起分四组）：开在鸿蒙 App 里时最上面多一行"在鸿蒙 App 里运行"（62 号票）。
 * 第一组"身份"的第一块是个人助理的名字（43 号票，存在守护进程、各设备一样），紧挨着是"我的名字"（249 号票：用户自己的名字，
 * 和助理的名字是两回事，两项挨着、各自写明"这是谁的名字"）；组里各页的名字、说明照 PAGE_TITLES / PAGE_SUBS，
 * 外观与风格的副标题是现在选的（74 号票：外观（34 号票）和风格（39 号票）合成一项，点进去才是具体选项；"自动播放 agent 的语音"
 * 开关 45 号票起在语音页里）。193 号票：四组之后是网页插件的设置分节；内核的"删除素材"只在没有哪个在用的插件页面包含它时列出
 * （记忆插件停用时）。"数据与设备"里有工具调用的完整内容占了多大、"现在就清理"（65 号票），最下面是"关于二狗"（124 号票）；
 * 在关于页连点版本号打开了 Debug 工具集的，它下面多一项"Debug 工具集"（1 小时内有效，到期就没了）
 */
function SettingsList({ current, go, navigate }: { current?: Sub | undefined; go(p: Sub): void; navigate: Navigate }) {
  const debug = useDebugUnlock();
  const plugins = usePlugins();
  const folded = useSettingsFolded();
  const row = (s: SettingsRow) => {
    if (s === "user-name") return <UserNameSetting key={s} />;
    if (s === "tool-call-storage") return <ToolCallStorageSetting key={s} />;
    if (s === "backup") return <BackupSetting key={s} />;
    if (s === "personal-files-link")
      return (
        <button
          key={s}
          type="button"
          className="menu-item settings-link-row"
          data-page="files"
          // 285：记忆插件在用时直接去记忆 · 档案
          onClick={() => {
            const moved = coveredRoute(plugins, "files", undefined);
            if (moved) navigate(moved);
            else go("files");
          }}
        >
          <span className="menu-text">
            {pageTitle("files")}
            <small>{t("shell.pages.files.fromSettings")}</small>
          </span>
          <span className="muted">›</span>
        </button>
      );
    return (
      <button key={s} type="button" className={`menu-item${current === s ? " on" : ""}`} data-page={s} onClick={() => go(s)}>
        <span className="menu-text">
          {pageTitle(s)}
          <small>{s === "appearance" ? <AppearanceSummary /> : s === "debug" ? `${pageSub("debug")} · ${t("shell.pages.debug.minutesLeft", { count: debug.minutesLeft, minutes: debug.minutesLeft })}` : pageSub(s)}</small>
        </span>
        <span className="muted">›</span>
      </button>
    );
  };
  return (
    <div className="menu">
      <NativeAppInfo />
      {/* 319 号票：首次设置向导排在设置列表最上面（四组之前）：第一次用的时候从这里一步一步走完 */}
      <button type="button" className={`menu-item${current === "setup" ? " on" : ""}`} data-page="setup" onClick={() => go("setup")}>
        <span className="menu-text">
          {pageTitle("setup")}
          <small>{pageSub("setup")}</small>
        </span>
        <span className="muted">›</span>
      </button>
      {settingsGroups(plugins, debug.open).map((group) => (
        <SettingsGroup key={group.id} id={group.id} collapsed={folded.has(group.id)} onToggle={() => pageSettingsFold().toggle(group.id)}>
          {group.rows.map(row)}
        </SettingsGroup>
      ))}
      {/* 网页插件的设置分节（193 号票）：四组之后、设置列表最下面 */}
      {plugins.list("settingsSections").map(({ id, Section }) => (
        <Section key={id} navigate={navigate} />
      ))}
    </div>
  );
}
