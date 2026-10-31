// 记忆的三个开关（336 号票：从设置列表最下面搬到了记忆页最下面——用户 2026-10-28："设置里面有几个关于记忆的打勾的设置，
// 记忆那个 tab 里面又没有，按理说这几个设置应该放到记忆里面去，因为这都是这个记忆插件带来的"）。
// 三个开关的内容照旧，都默认开：每条消息有相关记忆时自动带上记忆简报（266 号票）、秘书回话时顺口问"了解你问题"（264）、
// 记忆管理员每周在待办里约一次了解你访谈（284；约访卡上点"不想做了"会关掉它，这里能重新打开）。
// 画法是记忆页最下面一个默认收起的"记忆系统 · 会意 v1.0 · 设置"块（memorySystemSettingsTitle，336 号票起的名字；用户 2026-10-31 定
// 标题带上"记忆模块"，它下面那句写明这组是"实验性"），点一下展开：
// 收起时也写清里面是哪三个，不占地方；展开时才现取 GET /api/memory/settings，拨一下 PUT 只带拨的那一项
// （266 号票起改哪项给哪项），存好提示一句；存在守护进程那边（配置区的 memory-settings.json），所有设备一样，下一条消息起就按新的。
// 记忆插件停用时整页不出现（193 号票），这块自然也不出现。
import { useEffect, useState } from "react";
import type { DaemonHttp } from "../../app/daemon-http.ts";
import { useStore } from "../../app/store.tsx";
import { type MemorySettingsBody, type MemorySettingsView, t } from "../../state/index.ts";
import { useToast } from "../../ui/toast.tsx";
import { memorySystemSettingsTitle } from "./system.ts";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type MemorySwitch = keyof MemorySettingsView;

/** 每个开关的说法：标题、下面那行小字、读屏的名字、拨开、拨关时提示的一句 */
export const MEMORY_SWITCHES: readonly { key: MemorySwitch; title: string; sub: string; label: string; on: string; off: string }[] = [
  { key: "memoryBrief", title: "pages.memorySettings.brief", sub: "pages.memorySettings.briefSub", label: "pages.memorySettings.briefLabel", on: "pages.memorySettings.briefOn", off: "pages.memorySettings.briefOff" },
  { key: "wovenQuestions", title: "pages.memorySettings.woven", sub: "pages.memorySettings.wovenSub", label: "pages.memorySettings.wovenLabel", on: "pages.memorySettings.on", off: "pages.memorySettings.off" },
  {
    key: "interviewInvites",
    title: "pages.memorySettings.interview",
    sub: "pages.memorySettings.interviewSub",
    label: "pages.memorySettings.interviewLabel",
    on: "pages.memorySettings.interviewOn",
    off: "pages.memorySettings.interviewOff",
  },
];

/** 拨一下：只带拨的那一项（266 号票起改哪项给哪项），守护进程存好回整份设置（PUT /api/memory/settings） */
export function saveMemorySetting(http: Pick<DaemonHttp, "saveMemorySettings">, key: MemorySwitch, on: boolean): Promise<MemorySettingsView> {
  const body: MemorySettingsBody = { [key]: on };
  return http.saveMemorySettings(body);
}

/** 三个开关那几行（纯渲染：还没取到时点不了；读不到的原因写在第一行下面） */
export function MemorySwitchList({
  view,
  failed,
  saving,
  onChange,
}: {
  view: MemorySettingsView | undefined;
  failed: string | undefined;
  saving: boolean;
  onChange(key: MemorySwitch, on: boolean): void;
}) {
  return (
    <>
      {MEMORY_SWITCHES.map((s, i) => (
        <label key={s.key} className="menu-item mem-setting" data-switch={s.key}>
          <span className="menu-text">
            {t(s.title)}
            <small>{(i === 0 ? failed : undefined) ?? t(s.sub)}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="mem-setting-switch"
            aria-label={t(s.label)}
            checked={view?.[s.key] ?? true}
            disabled={view === undefined || saving}
            onChange={(e) => onChange(s.key, e.currentTarget.checked)}
          />
        </label>
      ))}
    </>
  );
}

/** 展开后取的三个开关：打开时现取，拨一下存好提示一句 */
function MemorySwitchRows() {
  const { http } = useStore();
  const toast = useToast();
  const [view, setView] = useState<MemorySettingsView>();
  const [failed, setFailed] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    http.memorySettings().then(
      (next) => {
        if (!live) return;
        setView(next);
        setFailed(undefined);
      },
      (err: unknown) => live && setFailed(t("pages.memorySettings.loadFailed", { reason: errorText(err) })),
    );
    return () => {
      live = false;
    };
  }, [http]);

  const change = (key: MemorySwitch, on: boolean) => {
    setSaving(true);
    const words = MEMORY_SWITCHES.find((s) => s.key === key)!;
    saveMemorySetting(http, key, on)
      .then(
        (next) => {
          setView(next);
          toast(t(next[key] ? words.on : words.off));
        },
        (err: unknown) => toast(t("pages.memorySettings.saveFailed", { reason: errorText(err) })),
      )
      .finally(() => setSaving(false));
  };

  return <MemorySwitchList view={view} failed={failed} saving={saving} onChange={change} />;
}

/** 记忆页最下面的"记忆系统 · 会意 v1.0 · 设置"（336 号票）：默认收起，标题下面一行写清里面是哪三个；点一下展开那三个开关 */
export function MemorySettingsSection() {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu memory-settings" data-block="memory-settings">
      <button type="button" className="menu-item memory-settings-head" data-action="memory-settings" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="menu-text">
          <span>{memorySystemSettingsTitle()}</span>
          <small>{t("pages.memory.systemSettingsSub")}</small>
        </span>
        <span className="muted" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && <MemorySwitchRows />}
    </div>
  );
}
