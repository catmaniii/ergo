// 设置 · 关注类别最上面的两个开关（315 号票，用户 2026-10-27 定："风险和任务预算的事情，做成一个设置吧。默认收紧，如果用户觉得比较难受，它可以自己关掉"）：
// - 有风险的事先问我：配置 guard.conversationApprovals（对话里"先问我"的出审批卡、任务超出授权的先问）；
// - 任务超预算就停下：配置 tasks.thresholds.budgetControl（超了先说明进展、过了 2 倍停下等你）。
// 新装时两个都开着，已有的数据目录里没写的照旧关着；每个开关下面一句大白话写开着、关掉各会怎样。打开时现取 GET /api/safety-settings，
// 拨一下 PUT 只带拨的那一项，守护进程写进配置文件、马上生效（不用重启），存好提示一句。319 号票的设置向导复用这一对接口。
// 样子照设置 · 记忆的开关（.mem-setting）。
import { useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { type SafetySettingsBody, type SafetySettingsView, t } from "../../state/index.ts";
import { Section } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Switch = keyof SafetySettingsView;

/** 每个开关的说法：标题、下面那句（开着、关掉各会怎样）、读屏的名字、拨开、拨关时提示的一句 */
export const SAFETY_SWITCHES: readonly { key: Switch; title: string; sub: string; on: string; off: string }[] = [
  { key: "conversationApprovals", title: "pages.safety.askFirst", sub: "pages.safety.askFirstSub", on: "pages.safety.askFirstOn", off: "pages.safety.askFirstOff" },
  { key: "budgetControl", title: "pages.safety.budget", sub: "pages.safety.budgetSub", on: "pages.safety.budgetOn", off: "pages.safety.budgetOff" },
];

/** 两个开关那一块（纯渲染：view 还没取到时开关点不了） */
export function SafetySwitchList({ view, failed, saving, onChange }: { view: SafetySettingsView | undefined; failed: string | undefined; saving: boolean; onChange(key: Switch, on: boolean): void }) {
  return (
    <Section title={t("pages.safety.title")}>
      {failed && (
        <div className="field-error" role="alert">
          {failed}
        </div>
      )}
      {SAFETY_SWITCHES.map((s) => (
        <label key={s.key} className="menu-item mem-setting safety-setting" data-switch={s.key}>
          <span className="menu-text">
            {t(s.title)}
            <small>{t(s.sub)}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="mem-setting-switch"
            aria-label={t(s.title)}
            checked={view?.[s.key] ?? false}
            disabled={view === undefined || saving}
            onChange={(e) => onChange(s.key, e.currentTarget.checked)}
          />
        </label>
      ))}
    </Section>
  );
}

export function SafetySwitches() {
  const { http } = useStore();
  const toast = useToast();
  const [view, setView] = useState<SafetySettingsView>();
  const [failed, setFailed] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    http.safetySettings().then(
      (next) => {
        if (!live) return;
        setView(next);
        setFailed(undefined);
      },
      (err: unknown) => live && setFailed(t("pages.safety.loadFailed", { reason: errorText(err) })),
    );
    return () => {
      live = false;
    };
  }, [http]);

  const change = (key: Switch, on: boolean) => {
    setSaving(true);
    const body: SafetySettingsBody = { [key]: on };
    const words = SAFETY_SWITCHES.find((s) => s.key === key)!;
    http
      .saveSafetySettings(body)
      .then(
        (next) => {
          setView(next);
          toast(t(next[key] ? words.on : words.off));
        },
        (err: unknown) => toast(t("pages.safety.saveFailed", { reason: errorText(err) })),
      )
      .finally(() => setSaving(false));
  };

  return <SafetySwitchList view={view} failed={failed} saving={saving} onChange={change} />;
}
