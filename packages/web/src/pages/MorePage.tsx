// "更多"：消耗、记忆入口（第二阶段，不可用）、设置（关注类别、工作日历、skill 库、已配对设备、删除素材）。
import type { MorePage as Sub, Navigate } from "../app/route.ts";
import { LaterBadge, ListDetail, TopBar } from "../ui/common.tsx";
import { DevicesPage } from "./more/DevicesPage.tsx";
import { MaterialsPage } from "./more/MaterialsPage.tsx";
import { SkillsPage } from "./more/SkillsPage.tsx";
import { UsagePage } from "./more/UsagePage.tsx";
import { WatchCategoriesPage } from "./more/WatchCategoriesPage.tsx";
import { WorkCalendarPage } from "./more/WorkCalendarPage.tsx";

const SETTINGS: { page: Sub; label: string; sub: string }[] = [
  { page: "watch", label: "关注类别", sub: "哪些操作要引起你注意，各怎么处置" },
  { page: "calendar", label: "工作日历", sub: "上班日和休息日，按我的工作日的提醒用它" },
  { page: "skills", label: "skill 库", sub: "导入 skill，给项目或任务的工具包用" },
  { page: "devices", label: "已配对设备", sub: "从外网用二狗的设备，可以随时吊销" },
  { page: "materials", label: "删除素材", sub: "按会话或按时间段删" },
];

const TITLES: Record<Sub, string> = {
  usage: "消耗",
  settings: "设置",
  watch: "关注类别",
  calendar: "工作日历",
  skills: "skill 库",
  devices: "已配对设备",
  materials: "删除素材",
};

export function MorePage({ wide, page, navigate }: { wide: boolean; page?: Sub; navigate: Navigate }) {
  const go = (p: Sub) => navigate({ tab: "more", page: p });
  // 竖屏：设置下面的页返回到设置，其余返回到"更多"
  const back = wide ? undefined : () => navigate(page && page !== "settings" && page !== "usage" ? { tab: "more", page: "settings" } : { tab: "more" });
  const menu = <MoreMenu wide={wide} current={page} go={go} />;
  const detail = page ? (
    page === "settings" && !wide ? (
      <div className="chat-col">
        <TopBar title="设置" onBack={back} />
        <div className="scroll">
          <SettingsList current={page} go={go} />
        </div>
      </div>
    ) : (
      <div className="chat-col">
        <TopBar title={TITLES[page]} onBack={back} />
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
    case "calendar":
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
              消耗<small>按天、按 agent 的 token 用量和粗估成本</small>
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
              <div className="menu-group">设置</div>
              <SettingsList current={current} go={go} />
            </>
          ) : (
            <button type="button" className="menu-item" onClick={() => go("settings")}>
              <span className="menu-icon">⚙️</span>
              <span className="menu-text">
                设置<small>关注类别、工作日历、skill 库、已配对设备、删除素材</small>
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
        <button key={s.page} type="button" className={`menu-item${current === s.page ? " on" : ""}`} onClick={() => go(s.page)}>
          <span className="menu-text">
            {s.label}
            <small>{s.sub}</small>
          </span>
          <span className="muted">›</span>
        </button>
      ))}
    </div>
  );
}
