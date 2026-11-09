// 负责人的运行时在界面上：运行时清单（GET /api/runtimes，取一次缓存着；发起对话框、⚙ 打开时重取，插件停用、启用之后跟着变）、
// 卡上的运行时签（默认的 pi 不标）、新建项目和任务时选运行时（照发起对话框里"什么时候做"那一排 .seg；只有 pi 能选时不显示）。
// 说法在状态层（state/runtimes.ts）。
import { useEffect, useState } from "react";
import { useStore } from "../app/store.tsx";
import { type AgentRuntimeView, COMPONENT_FEATURES, runtimeChipText, runtimeChoices, t } from "../state/index.ts";
import { ComponentMissing, goInstallComponent, useComponentGate } from "./component-gate.tsx";

let cached: readonly AgentRuntimeView[] | undefined;
let inFlight: Promise<void> | undefined;
const listeners = new Set<(list: readonly AgentRuntimeView[]) => void>();

/** 运行时清单：还没取到是 undefined（界面按"都支持"）；fresh 时这次挂上去现取一遍（发起对话框、⚙） */
export function useRuntimes(fresh = false): readonly AgentRuntimeView[] | undefined {
  const { http } = useStore();
  const [list, setList] = useState(cached);
  useEffect(() => {
    listeners.add(setList);
    if (fresh || (cached === undefined && inFlight === undefined)) {
      inFlight = http.runtimes().then(
        (view) => {
          cached = view.runtimes;
          inFlight = undefined;
          for (const listener of listeners) listener(view.runtimes);
        },
        () => {
          inFlight = undefined;
        },
      );
    }
    return () => {
      listeners.delete(setList);
    };
  }, [http, fresh]);
  return list;
}

/** 改了运行时的设置之后（新建时的默认文件夹）把守护进程交回的清单换上，挂着的都跟着变 */
export function setRuntimesCache(list: readonly AgentRuntimeView[]): void {
  cached = list;
  for (const listener of listeners) listener(list);
}

/** 卡上的运行时签：插件登记的运行时才标（默认的 pi 不标） */
export function RuntimeChip({ runtime, className }: { runtime: string | undefined; className?: string }) {
  const runtimes = useRuntimes();
  const text = runtimeChipText(runtimes, runtime);
  return text === undefined ? null : (
    <span className={`chip chip-quiet runtime-chip${className ? ` ${className}` : ""}`} title={t("ui.runtimes.chipTitle", { runtime: text })}>
      {text}
    </span>
  );
}

/**
 * 卡上的"在官方 App 里"（会话交给了官方 App）：卡整张是按钮，里面不能再套链接，拿到的链接放在提示里（⚙ 里那一块能点开）
 */
export function RemoteBadge({ badge, className }: { badge: { label: string; url?: string }; className?: string }) {
  return (
    <span className={`chip remote-badge${className ? ` ${className}` : ""}`} title={badge.url ?? badge.label}>
      {badge.label}
    </span>
  );
}

/**
 * 新建项目、任务时选运行时：现在能用的几个排成一排；只有 pi 能选时什么都不显示。
 * Claude Code 接入、Codex 接入的组件没装（别处也没有）时那一项灰掉，点一下去设置 · 组件装；
 * 组件有了、插件却还没装上的（没点启用：runtimeChoices 的 unavailable）也灰掉，点一下写明缺什么、怎么办
 */
export function RuntimePicker({ value, onChange }: { value: string; onChange(runtime: string): void }) {
  const choices = runtimeChoices(useRuntimes(true));
  const claudeCodeOff = useComponentGate(COMPONENT_FEATURES.runtimeClaudeCode);
  const codexOff = useComponentGate(COMPONENT_FEATURES.runtimeCodex);
  const [why, setWhy] = useState<string>();
  if (choices.length === 0) return null;
  const off = (id: string) => (id === "claude-code" ? claudeCodeOff : id === "codex" ? codexOff : undefined);
  const missing = choices.map((choice) => off(choice.id)).find((gate) => gate !== undefined);
  return (
    <fieldset className="field runtime-picker">
      <legend>{t("ui.runtimes.legend")}</legend>
      <div className="seg runtime-seg" role="radiogroup" aria-label={t("ui.runtimes.legend")}>
        {choices.map((choice) => {
          const gate = off(choice.id);
          if (!gate && choice.unavailable !== undefined) {
            return (
              <button key={choice.id} type="button" role="radio" aria-checked={false} aria-disabled="true" className="seg-btn component-off" title={choice.unavailable} onClick={() => setWhy(choice.unavailable)}>
                {choice.title}
              </button>
            );
          }
          return gate ? (
            <button key={choice.id} type="button" role="radio" aria-checked={false} aria-disabled="true" className="seg-btn component-off" title={t("ui.components.offHint", { title: gate.title })} onClick={() => goInstallComponent(gate.component)}>
              {choice.title}
            </button>
          ) : (
            <button key={choice.id} type="button" role="radio" aria-checked={value === choice.id} className={`seg-btn${value === choice.id ? " on" : ""}`} onClick={() => onChange(choice.id)}>
              {choice.title}
            </button>
          );
        })}
      </div>
      {missing && <ComponentMissing gate={missing} />}
      {why !== undefined && <div className="sc-mode-hint">{why}</div>}
      <div className="sc-mode-hint">{t("ui.runtimes.hint")}</div>
    </fieldset>
  );
}
