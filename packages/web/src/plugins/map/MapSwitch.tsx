// 地图切换（445，用户 2026-11-08："国内和国外都可以在可用的地图之间切换"）：地图页标题栏最右边那一格（.map-bar-tools）里的一个开关。
// - 宽的时候一个下拉（"地图：自动 ▾"），窄的时候收进 ⋮（底部弹层）；
// - 列的是现在看的这个区域（国内 / 国外）"自动"和能用的几家（有 Key、Key 没坏、插件开着、这家支持这个区域——地图那块报上来的，
//   MapView.tsx 的 BasemapStatus），这台设备加载不上的那一家标"连不上"、点不了；
// - 选了记在这台设备上（浏览器里，MAP_CHOICE_KEY），国内选的和国外选的分开记；那一家不能用了地图那块退回"自动"并说一句；
// - 查地点、算路线跟着现在用的那家走（秘书查的时候拿到地图上用的是谁才这样；拿不到按"自动"）；451 起足迹、聊天卡片的预览图也用这一家
//   （"当前地图"），菜单最后那一句照新规矩写；"自动"会挑的几家排在前面，只能手动选的排后面（providers.ts 的 switchEntries）。
// useBasemapSwitch 把"记着的、改它、地图那块报上来的样子"放在一起：地图页建一份，交给 MapCanvas（switcher）和这个开关。
import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type MapChoice, type MapRegion, t } from "../../state/index.ts";
import { Sheet } from "../../ui/common.tsx";
import { Icon } from "../../ui/icons.tsx";
import { PopupMenu } from "../../ui/popup.tsx";
import type { BasemapStatus, BasemapSwitcher } from "./MapView.tsx";
import { MAP_CHOICE_KEY, parseMapChoice, withChoice } from "./providers.ts";

/** 这台设备按区域记的手动选择（聊天卡片挑地图也用它，451） */
export function loadChoice(): MapChoice {
  try {
    return parseMapChoice(localStorage.getItem(MAP_CHOICE_KEY));
  } catch {
    return {};
  }
}

function saveChoice(choice: MapChoice): void {
  try {
    if (Object.keys(choice).length === 0) localStorage.removeItem(MAP_CHOICE_KEY);
    else localStorage.setItem(MAP_CHOICE_KEY, JSON.stringify(choice));
  } catch {
    // 存不了（隐私模式）就只在这一次打开里管用
  }
}

/** 地图切换要的：记着的手动选择、改它、地图那块报上来的样子 */
export interface BasemapSwitch extends BasemapSwitcher {
  readonly status: BasemapStatus | undefined;
}

/** 地图页建一份：交给 MapCanvas（switcher）和 MapSwitch */
export function useBasemapSwitch(): BasemapSwitch {
  const [choice, setChoiceState] = useState<MapChoice>(loadChoice);
  const [status, setStatus] = useState<BasemapStatus>();
  const setChoice = useCallback((region: MapRegion, id: string | undefined) => {
    setChoiceState((before) => {
      const next = withChoice(before, region, id);
      saveChoice(next);
      return next;
    });
  }, []);
  const report = useCallback((next: BasemapStatus) => setStatus(next), []);
  return useMemo(() => ({ choice, setChoice, report, status }), [choice, setChoice, report, status]);
}

/** 菜单里的几项（下拉、底部弹层共用；标题栏以后有别的 ⋮ 收纳菜单时可以把它放进去） */
export function MapSwitchItems({ status, current, onPick }: { status: BasemapStatus; current: string | undefined; onPick(id: string | undefined): void }) {
  const item = (id: string | undefined, label: string, note: string | undefined, disabled: boolean) => {
    const checked = current === id;
    return (
      <button
        key={id ?? "auto"}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        className="map-switch-item"
        data-id={id ?? "auto"}
        disabled={disabled}
        onClick={() => onPick(id)}
      >
        <span className="map-switch-label">
          {label}
          {note !== undefined && <small>{note}</small>}
        </span>
        <span className={`map-switch-check${checked ? " on" : ""}`} aria-hidden="true">
          {checked ? "✓" : ""}
        </span>
      </button>
    );
  };
  return (
    <>
      <div className="map-switch-head">{t(status.region === "mainland" ? "ui.plugins.map.switch.region.mainland" : "ui.plugins.map.switch.region.abroad")}</div>
      {item(undefined, t("ui.plugins.map.switch.auto"), status.autoTitle === undefined ? t("ui.plugins.map.switch.autoNone") : t("ui.plugins.map.switch.autoNow", { name: status.autoTitle }), false)}
      {status.options.map((o) => item(o.id, o.title, o.failed === undefined ? undefined : t("ui.plugins.map.switch.unreachable"), o.failed !== undefined))}
      <div className="menu-sep" role="separator" />
      <div className="map-switch-note">{t("ui.plugins.map.switch.lookupNote")}</div>
    </>
  );
}

/** 标题栏里的地图切换：宽的时候一个下拉，窄的时候收进 ⋮ */
export function MapSwitch({ sw, compact = false }: { sw: BasemapSwitch; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const status = sw.status;
  if (status === undefined) return null;
  const current = sw.choice[status.region];
  const name = current === undefined ? t("ui.plugins.map.switch.auto") : (status.options.find((o) => o.id === current)?.title ?? current);
  const label = t("ui.plugins.map.switch.label", { name });
  const close = () => setOpen(false);
  const pick = (id: string | undefined) => {
    sw.setChoice(status.region, id);
    close();
  };
  const items = <MapSwitchItems status={status} current={current} onPick={pick} />;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={compact ? `icon-btn map-switch-more${open ? " on" : ""}` : `chip map-switch-btn${open ? " on" : ""}`}
        data-choice={current ?? "auto"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={compact ? label : undefined}
        title={label}
        // 菜单开着时再按一下是收起（按下不让菜单先关、点击再打开）
        onPointerDown={(e) => {
          if (open) e.stopPropagation();
        }}
        onClick={() => setOpen(!open)}
      >
        {compact ? (
          <Icon name="kebab" />
        ) : (
          <>
            <Icon name="layers" />
            <span className="map-switch-name">{label}</span>
            <Icon name="down" />
          </>
        )}
      </button>
      {open &&
        (compact ? (
          // 底部弹层挂到 body 上：画在标题栏里会被地图上的钮、署名（层级更高）盖住
          createPortal(
            <Sheet title={t("ui.plugins.map.switch.title")} onClose={close}>
              <div className="map-switch-menu map-switch-sheet" role="menu" aria-label={t("ui.plugins.map.switch.title")}>
                {items}
              </div>
            </Sheet>,
            document.body,
          )
        ) : (
          <PopupMenu anchor={anchor} align="end" className="row-menu map-switch-menu" label={t("ui.plugins.map.switch.title")} onClose={close}>
            {items}
          </PopupMenu>
        ))}
    </>
  );
}
