// "更多"：消耗、记忆入口（第二阶段，不可用）、设置（关注类别、工作日历、skill 库、已配对设备、删除素材）。
import type { MorePage as Sub, Navigate } from "../app/route.ts";
import { LaterBadge, ListDetail, TopBar } from "../ui/common.tsx";
import { DevicesPage } from "./more/DevicesPage.tsx";
import { MaterialsPage } from "./more/MaterialsPage.tsx";
import { SkillsPage } from "./more/SkillsPage.tsx";
import { UsagePage } from "./more/UsagePage.tsx";
import { WatchCategoriesPage } from "./more/WatchCategoriesPage.tsx";
import { WorkCalendarPage } from "./more/WorkCalendarPage.tsx";

/** 每一页的名字（标题栏和菜单共用）和菜单里的一句说明 */
const PAGES: Record<Sub, { title: string; sub: string }> = {
  usage: { title: "消耗", sub: "按天、按 agent 的 token 用量和粗估成本" },
  settings: { title: "设置", sub: "关注类别、工作日历、skill 库、已配对设备、删除素材" },
  watch: { title: "关注类别", sub: "哪些操作要引起你注意，各怎么处置" },
  "workday-calendar": { title: "工作日历", sub: "上班日和休息日，按我的工作日的提醒用它" },
  skills: { title: "skill 库", sub: "导入 skill，给项目或任务的工具包用" },
  devices: { title: "已配对设备", sub: "从外网用二狗的设备，可以随时吊销" },
  materials: { title: "删除素材", sub: "按会话或按时间段删" },
};

/** 设置下面的五页，按菜单顺序 */
const SETTINGS: Sub[] = ["watch", "workday-calendar", "skills", "devices", "materials"];

export function MorePage({ wide, page, navigate }: { wide: boolean; page?: Sub; navigate: Navigate }) {
  const go = (p: Sub) => navigate({ tab: "more", page: p });
  // 竖屏：设置下面的页返回到设置，其余返回到"更多"
  const back = wide ? undefined : () => navigate(page && page !== "settings" && page !== "usage" ? { tab: "more", page: "settings" } : { tab: "more" });
  const menu = <MoreMenu wide={wide} current={page} go={go} />;
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
          <SubPage page={page} go={go} navigate={navigate} />
        </div>
      </div>
    )
  ) : undefined;
  return <ListDetail wide={wide} list={menu} detail={detail} listWidth={280} />;
}

function SubPage({ page, go, navigate }: { page: Sub; go(p: Sub): void; navigate: Navigate }) {
  switch (page) {
    case "usage":
      return <UsagePage />;
    case "settings":
      return <SettingsList current={page} go={go} />;
    case "watch":
      return <WatchCategoriesPage />;
    case "workday-calendar":
      return <WorkCalendarPage />;
    case "skills":
      return <SkillsPage />;
    case "devices":
      return <DevicesPage onPreviewPairing={() => navigate({ tab: "pair-wait" })} />;
    case "materials":
      return <MaterialsPage />;
  }
}

function MoreMenu({ wide, current, go }: { wide: boolean; current?: Sub; go(p: Sub): void }) {
  return (
    <div className="chat-col">
      <TopBar title="更多" />
      <div className="scroll">
        <div className="menu">
          <button type="button" className={`menu-item${current === "usage" ? " on" : ""}`} onClick={() => go("usage")}>
            <span className="menu-icon">📊</span>
            <span className="menu-text">
              {PAGES.usage.title}
              <small>{PAGES.usage.sub}</small>
            </span>
          </button>
          <div className="menu-item disabled" aria-disabled="true">
            <span className="menu-icon">🧠</span>
            <span className="menu-text">
              <span>
                记忆 <LaterBadge />
              </span>
              <small>第一阶段只积累素材，不推断，也不产出记忆</small>
            </span>
          </div>
          {wide ? (
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
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsList({ current, go }: { current?: Sub; go(p: Sub): void }) {
  return (
    <div className="menu">
      {SETTINGS.map((s) => (
        <button key={s} type="button" className={`menu-item${current === s ? " on" : ""}`} onClick={() => go(s)}>
          <span className="menu-text">
            {PAGES[s].title}
            <small>{PAGES[s].sub}</small>
          </span>
          <span className="muted">›</span>
        </button>
      ))}
    </div>
  );
}
