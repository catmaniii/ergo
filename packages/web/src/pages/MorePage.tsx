// "更多"（33 号票）：主导航放不下、收进来的那些项（消耗、记忆入口（第二阶段）、设置，从末尾起收）；直接显示在导航里的项
// 各自是一页，不再出现在"更多"里。设置下面的几页（外观与风格、关注类别、工作日规则、skill 库、语音、已配对设备、删除素材）照旧在设置里。
// 35 号票：工作日历升为主导航的日历（CalendarPage），设置里只留"工作日规则"（额外上班规则）。主导航收不下日历时，它也收进"更多"。
// 地址都还是 #/more/<页>：同一页显示在"更多"里还是自己一页，看它现在收没收起。
// 74 号票：外观和风格不再摊在设置列表上，合成设置下面的一页"外观与风格"（#/more/appearance），和别的设置项一样点进去改。
// 71 号票：设置下面的"系统提示"（#/more/prompts），点进某一份是下一级（#/more/prompts/<编号>）：标题栏的返回回到系统提示的列表。
// 73 号票：设置下面加一页"模型"（#/more/models）：服务商、API key 的状态、默认模型和各个 agent 的模型、看图能力、连通测试。
import { type MorePage as Sub, type Navigate, navItemOf } from "../app/route.ts";
import type { NavItem } from "../state/index.ts";
import { LaterBadge, ListDetail, TopBar } from "../ui/common.tsx";
import { AppearancePage, AppearanceSummary } from "./more/AppearancePage.tsx";
import { AssistantNameSetting } from "./more/AssistantNameSetting.tsx";
import { DevicesPage } from "./more/DevicesPage.tsx";
import { MaterialsPage } from "./more/MaterialsPage.tsx";
import { ModelsPage } from "./more/ModelsPage.tsx";
import { NativeAppInfo } from "./more/NativeAppInfo.tsx";
import { PromptsPage } from "./more/PromptsPage.tsx";
import { SkillsPage } from "./more/SkillsPage.tsx";
import { ToolCallStorageSetting } from "./more/ToolCallStorageSetting.tsx";
import { UsagePage } from "./more/UsagePage.tsx";
import { VoicePage } from "./more/VoicePage.tsx";
import { WatchCategoriesPage } from "./more/WatchCategoriesPage.tsx";
import { WorkdayRulesPage } from "./more/WorkdayRulesPage.tsx";

/** 每一页的名字（标题栏和菜单共用）和菜单里的一句说明 */
const PAGES: Record<Sub, { title: string; sub: string }> = {
  usage: { title: "消耗", sub: "按天、按 agent 的 token 用量和粗估成本" },
  memory: { title: "记忆", sub: "第一阶段只积累素材，不推断，也不产出记忆" },
  settings: { title: "设置", sub: "个人助理的名字、外观与风格、模型、关注类别、工作日规则、skill 库、系统提示、语音、已配对设备、删除素材、工具调用的完整内容" },
  // 设置列表上这一项的副标题不用这句，写的是现在选的（AppearanceSummary）
  appearance: { title: "外观与风格", sub: "浅色、深色或跟随系统，和视觉风格" },
  models: { title: "模型", sub: "DeepSeek（服务端调用）：默认模型、各个 agent 用什么模型和思考档位、看图能力、连通测试" },
  watch: { title: "关注类别", sub: "哪些操作要引起你注意，各怎么处置" },
  "workday-rules": { title: "工作日规则", sub: "额外上班规则（每天上班还是休息在日历里看）" },
  skills: { title: "skill 库", sub: "导入 skill，给项目或任务的工具包用" },
  prompts: { title: "系统提示", sub: "各 agent 的系统提示：看、改、恢复默认，还有加在最前面的前缀" },
  voice: { title: "语音", sub: "识别和合成模型的状态、参考音色、自动播放 agent 的语音" },
  devices: { title: "已配对设备", sub: "从外网用二狗的设备，可以随时吊销" },
  materials: { title: "删除素材", sub: "按会话或按时间段删" },
};

/** 设置下面的几页，按菜单顺序 */
const SETTINGS: Sub[] = ["appearance", "models", "watch", "workday-rules", "skills", "prompts", "voice", "devices", "materials"];

/** folded：主导航现在收进"更多"的项（按导航的顺序） */
export function MorePage({ wide, page, item, folded, navigate }: { wide: boolean; page?: Sub; item?: string; folded: readonly NavItem[]; navigate: Navigate }) {
  const go = (p: Sub) => navigate({ tab: "more", page: p });
  // 这一页所属的项直接显示在导航里：它自己一页，不经过"更多"
  const owner = page && navItemOf({ tab: "more", page });
  if (page && (owner === "usage" || owner === "memory") && !folded.includes(owner)) return <OwnPage page={page} go={go} navigate={navigate} />;
  if (page && owner === "settings" && !folded.includes("settings")) return <SettingsSection wide={wide} page={page} item={item} go={go} navigate={navigate} />;

  // 竖屏：设置下面的页返回到设置，其余返回到"更多"；有下一级的页点进去的那一项返回到那一页（宽屏也是）
  const back =
    page && item ? () => go(page) : wide ? undefined : () => navigate(page && page !== "settings" && page !== "usage" && page !== "memory" ? { tab: "more", page: "settings" } : { tab: "more" });
  const menu = <MoreMenu wide={wide} folded={folded} current={page} go={go} onCalendar={() => navigate({ tab: "calendar" })} />;
  const detail = page ? (
    page === "settings" && !wide ? (
      <div className="chat-col">
        <TopBar title={PAGES.settings.title} onBack={back} />
        <div className="scroll">
          <SettingsList current={page} go={go} />
        </div>
      </div>
    ) : (
      <div className="chat-col">
        <TopBar title={PAGES[page].title} onBack={back} />
        <div className="scroll page-pad">
          <SubPage page={page} item={item} go={go} navigate={navigate} />
        </div>
      </div>
    )
  ) : undefined;
  return <ListDetail wide={wide} list={menu} detail={detail} listWidth={280} />;
}

/** 消耗、记忆直接显示在导航里时：自己一页，没有返回 */
function OwnPage({ page, go, navigate }: { page: Sub; go(p: Sub): void; navigate: Navigate }) {
  return (
    <div className="chat-col">
      <TopBar title={PAGES[page].title} />
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
      <TopBar title={PAGES.settings.title} />
      <div className="scroll">
        <SettingsList current={sub} go={go} />
      </div>
    </div>
  );
  const detail = sub && (
    <div className="chat-col">
      <TopBar title={PAGES[sub].title} onBack={item ? () => go(sub) : wide ? undefined : () => go("settings")} />
      <div className="scroll page-pad">
        <SubPage page={sub} item={item} go={go} navigate={navigate} />
      </div>
    </div>
  );
  return <ListDetail wide={wide} list={list} detail={detail} listWidth={280} />;
}

function SubPage({ page, item, go, navigate }: { page: Sub; item?: string; go(p: Sub): void; navigate: Navigate }) {
  switch (page) {
    case "usage":
      return <UsagePage />;
    case "memory":
      return <MemoryLater />;
    case "settings":
      return <SettingsList current={page} go={go} />;
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
    case "voice":
      return <VoicePage />;
    case "devices":
      return <DevicesPage onPreviewPairing={() => navigate({ tab: "pair-wait" })} />;
    case "materials":
      return <MaterialsPage />;
  }
}

/** 记忆是第二阶段：只有说明 */
function MemoryLater() {
  return (
    <div className="page-placeholder">
      <span className="placeholder-icon" aria-hidden="true">
        🧠
      </span>
      <span>
        记忆 <LaterBadge />
      </span>
      <span>{PAGES.memory.sub}</span>
    </div>
  );
}

/** "更多"的菜单：只列收进来的项，按导航的顺序（秘书、任务、项目、待我处理再挤也直接显示，不会收进来） */
function MoreMenu({ wide, folded, current, go, onCalendar }: { wide: boolean; folded: readonly NavItem[]; current?: Sub; go(p: Sub): void; onCalendar(): void }) {
  return (
    <div className="chat-col">
      <TopBar title="更多" />
      <div className="scroll">
        <div className="menu">
          {folded.length === 0 && <div className="page-placeholder">导航里放得下全部的项，这里没有别的了</div>}
          {folded.includes("calendar") && (
            <button type="button" className="menu-item" onClick={onCalendar}>
              <span className="menu-icon">📅</span>
              <span className="menu-text">
                日历
                <small>每天上班还是休息，当天的提醒和定时触发的任务</small>
              </span>
            </button>
          )}
          {folded.includes("usage") && (
            <button type="button" className={`menu-item${current === "usage" ? " on" : ""}`} onClick={() => go("usage")}>
              <span className="menu-icon">📊</span>
              <span className="menu-text">
                {PAGES.usage.title}
                <small>{PAGES.usage.sub}</small>
              </span>
            </button>
          )}
          {folded.includes("memory") && (
            <div className="menu-item disabled" aria-disabled="true">
              <span className="menu-icon">🧠</span>
              <span className="menu-text">
                <span>
                  {PAGES.memory.title} <LaterBadge />
                </span>
                <small>{PAGES.memory.sub}</small>
              </span>
            </div>
          )}
          {folded.includes("settings") &&
            (wide ? (
              <>
                <div className="menu-group">{PAGES.settings.title}</div>
                <SettingsList current={current} go={go} />
              </>
            ) : (
              <button type="button" className="menu-item" onClick={() => go("settings")}>
                <span className="menu-icon">⚙️</span>
                <span className="menu-text">
                  {PAGES.settings.title}
                  <small>{PAGES.settings.sub}</small>
                </span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 设置的列表：顶上直接是个人助理的名字（43 号票，存在守护进程、各设备一样），下面是设置的各页，第一项是"外观与风格"
 * （74 号票：外观（34 号票）和风格（39 号票）原来直接摊在这里，合成一项，副标题是现在选的，点进去才是具体选项）
 * （"自动播放 agent 的语音"开关 45 号票起在语音页里）。开在鸿蒙 App 里时最上面多一行"在鸿蒙 App 里运行"（62 号票）。
 * 最下面是工具调用的完整内容占了多大、"现在就清理"（65 号票）
 */
function SettingsList({ current, go }: { current?: Sub; go(p: Sub): void }) {
  return (
    <div className="menu">
      <NativeAppInfo />
      <AssistantNameSetting />
      {SETTINGS.map((s) => (
        <button key={s} type="button" className={`menu-item${current === s ? " on" : ""}`} onClick={() => go(s)}>
          <span className="menu-text">
            {PAGES[s].title}
            <small>{s === "appearance" ? <AppearanceSummary /> : PAGES[s].sub}</small>
          </span>
          <span className="muted">›</span>
        </button>
      ))}
      <ToolCallStorageSetting />
    </div>
  );
}
