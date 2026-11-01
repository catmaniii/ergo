// 设置向导"能力"那一步：列出插件和组件，每项一句它能做什么、要下多大；勾上的走现有的组件安装和插件启用接口，在后台进行，
// 这里显示进度和失败原因，失败的能重试、能跳过（之后在设置 · 组件里重做）。要确认许可的先弹设置 · 组件那个确认框，绕不过去。
// 下面还有两块：现在装了什么（组件带版本），开机自启的开关（调 ergo svc 同一套，自动拉起哪些服务在服务管家里改）。
// 算哪几项、默认勾不勾、调哪些接口都在 app/setup-capabilities.ts；这里的列表、开关是纯渲染的（CapabilityList、AutostartBlock、InstalledNow），测试在 Node 里直接渲染。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyCapabilities,
  type CapabilityApi,
  capabilityActive,
  capabilityPlan,
  type CapabilityRow,
  capabilityRows,
  capabilityTotal,
  defaultTicked,
  installedNow,
  progressOwner,
  retryCapability,
  serviceOwner,
  stoppedDependency,
} from "../../app/setup-capabilities.ts";
import { useStore } from "../../app/store.tsx";
import type { Navigate } from "../../app/route.ts";
import { type AutostartView, type ComponentsView, type ComponentView, formatList, type PluginInfo, sizeLabel, t } from "../../state/index.ts";
import { setComponentsCache } from "../../ui/component-gate.tsx";
import { useToast } from "../../ui/toast.tsx";
import { actionText, componentStateText, LicenseConfirm, progressText } from "./ComponentsPage.tsx";
import { pluginStateText } from "./PluginsPage.tsx";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** 要下多大那一句 */
export function downloadText(row: CapabilityRow): string {
  if (row.download === 0) return t("setup.steps.capabilities.noDownload");
  if (row.downloadWith.length === 0) return t("setup.steps.capabilities.download", { size: sizeLabel(row.download) });
  return t("setup.steps.capabilities.downloadWith", { size: sizeLabel(row.download), names: formatList(row.downloadWith) });
}

/** 小签上的字：插件写它的状况，组件写它的状况（Claude Code 正在下 SDK 时写下载的状况） */
function stateText(row: CapabilityRow): string {
  if (row.kind === "plugin" && (row.status === "on" || !row.component) && row.plugin) return pluginStateText(row.plugin.state, row.plugin.missing);
  return row.component ? componentStateText(row.component.state) : "";
}

const CHIP: Readonly<Record<CapabilityRow["status"], string>> = { on: "chip chip-ok", available: "chip", working: "chip chip-op", stopped: "chip chip-no", locked: "chip chip-quiet" };

export interface CapabilityListProps {
  rows: readonly CapabilityRow[];
  all: readonly ComponentView[];
  ticked: ReadonlySet<string>;
  /** 跳过了的（这次打开里） */
  skipped: ReadonlySet<string>;
  /** 没成的：行的 key → 原因 */
  failures: ReadonlyMap<string, string>;
  /** 正在发请求 */
  busy: boolean;
  onToggle(key: string, on: boolean): void;
  onRetry(row: CapabilityRow): void;
  onSkip(row: CapabilityRow): void;
}

function CapabilityItem({ row, all, ticked, skipped, failures, busy, onToggle, onRetry, onSkip }: CapabilityListProps & { row: CapabilityRow }) {
  const c = row.component;
  const owner = c && progressOwner(c, all);
  const progress = owner?.progress;
  const percent = progress && progress.total > 0 ? Math.min(100, Math.floor((progress.done / progress.total) * 100)) : undefined;
  const dep = c && stoppedDependency(c, all);
  const service = c && row.status === "on" ? serviceOwner(c, all)?.service : undefined;
  const failure = failures.get(row.key);
  const wasSkipped = skipped.has(row.key);
  const version = row.status === "on" && row.kind === "component" && c?.state !== "provided" ? c?.installedVersion : undefined;
  const can = row.status === "available";
  return (
    <div className={`capability-row capability-${row.status}`} data-capability={row.key}>
      <label className="capability-head">
        <input type="checkbox" aria-label={row.title} checked={row.status === "on" || row.status === "working" || (row.status === "stopped" && !wasSkipped) || (can && ticked.has(row.key))} disabled={!can || busy} onChange={(e) => onToggle(row.key, e.currentTarget.checked)} />
        <span className="capability-name">{row.title}</span>
        {(row.status !== "available" || row.plugin?.state === "disabled" || row.plugin?.state === "removed") && <span className={CHIP[row.status]}>{stateText(row)}</span>}
        {version !== undefined && <span className="muted capability-version">{t("setup.steps.capabilities.version", { version })}</span>}
      </label>
      {row.summary && <div className="capability-summary">{row.summary}</div>}
      {row.status !== "on" && row.status !== "working" && <div className="capability-size">{downloadText(row)}</div>}
      {row.note !== undefined && <div className={row.status === "on" ? "component-provided" : "component-note"}>{row.note}</div>}
      {c?.note !== undefined && row.status !== "on" && <div className="component-note">{c.note}</div>}
      {c?.license?.attribution !== undefined && <div className="component-attribution">{c.license.attribution}</div>}
      {row.status === "working" && owner && (
        <div className="component-progress">
          {percent !== undefined && (
            <div className="component-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div style={{ width: `${percent}%` }} />
            </div>
          )}
          <div className="component-progress-text">{owner === c ? (progressText(owner) ?? componentStateText(owner.state)) : t("setup.steps.capabilities.depProgress", { title: owner.title, progress: progressText(owner) ?? componentStateText(owner.state) })}</div>
        </div>
      )}
      {service?.state === "starting" && <div className="component-note">{t("setup.steps.capabilities.serviceStarting")}</div>}
      {service?.error !== undefined && <div className="field-error">{service.error}</div>}
      {row.status === "stopped" && c?.error !== undefined && <div className={c.state === "failed" ? "field-error" : "component-note"}>{c.error}</div>}
      {row.status === "stopped" && dep && <div className="field-error">{t("setup.steps.capabilities.depFailed", { title: dep.title, reason: dep.error ?? "" })}</div>}
      {failure !== undefined && !wasSkipped && <div className="field-error">{t("setup.steps.capabilities.failed", { reason: failure })}</div>}
      {wasSkipped && <div className="component-note capability-skipped">{t("setup.steps.capabilities.skipped")}</div>}
      {!wasSkipped && (row.status === "stopped" || failure !== undefined) && (
        <div className="capability-actions">
          <button type="button" className="btn primary small" disabled={busy} onClick={() => onRetry(row)}>
            {c && row.status === "stopped" ? actionText(c, "resume") : t("pages.components.action.retry")}
          </button>
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => onSkip(row)}>
            {t("setup.steps.capabilities.skip")}
          </button>
        </div>
      )}
    </div>
  );
}

/** 插件一组、组件一组 */
export function CapabilityList(props: CapabilityListProps) {
  const groups = [
    { kind: "plugin" as const, title: t("setup.steps.capabilities.plugins") },
    { kind: "component" as const, title: t("setup.steps.capabilities.components") },
  ];
  return (
    <div className="capability-list">
      {groups.map((group) => {
        const rows = props.rows.filter((row) => row.kind === group.kind);
        if (rows.length === 0) return null;
        return (
          <div key={group.kind} className="capability-group" data-group={group.kind}>
            <div className="capability-group-title">{group.title}</div>
            {rows.map((row) => (
              <CapabilityItem key={row.key} {...props} row={row} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

const nowItem = (c: ComponentView) => (c.state === "provided" ? t("setup.steps.capabilities.nowProvided", { title: c.title }) : t("setup.steps.capabilities.nowComponent", { title: c.title, version: c.installedVersion ?? c.version }));

/** 现在装了什么（组件带版本；别处已有的写"已有"） */
export function InstalledNow({ components, plugins }: { components: ComponentsView | undefined; plugins: readonly PluginInfo[] | undefined }) {
  const now = installedNow(components, plugins);
  return (
    <div className="capability-now">
      <div className="capability-group-title">{t("setup.steps.capabilities.nowTitle")}</div>
      <div className="setup-line">
        <span className="setup-line-key">{t("setup.steps.capabilities.components")}</span>
        <span>{now.components.length > 0 ? formatList(now.components.map(nowItem)) : t("setup.steps.capabilities.nowNone")}</span>
      </div>
      <div className="setup-line">
        <span className="setup-line-key">{t("setup.steps.capabilities.plugins")}</span>
        <span>{now.plugins.length > 0 ? formatList(now.plugins.map((p) => p.title)) : t("setup.steps.capabilities.nowNone")}</span>
      </div>
    </div>
  );
}

/** 开机自启那一块（纯渲染：还没取到时开关点不了；不能从这里改的写原因，开关灰着） */
export function AutostartBlock({ view, failed, saving, onChange }: { view: AutostartView | undefined; failed: string | undefined; saving: boolean; onChange(on: boolean): void }) {
  return (
    <div className="capability-autostart" data-autostart={view?.state ?? "loading"}>
      <label className="menu-item mem-setting">
        <span className="menu-text">
          {t("setup.autostart.title")}
          <small>{view === undefined ? t("setup.autostart.loading") : t(`setup.autostart.state.${view.state}`)}</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="mem-setting-switch"
          aria-label={t("setup.autostart.title")}
          checked={view?.state === "on" || view?.state === "elsewhere"}
          disabled={view === undefined || view.cannotChange !== undefined || saving}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
      </label>
      {view?.cannotChange !== undefined && <div className="setup-note">{view.cannotChange}</div>}
      <div className="setup-note">{t("setup.autostart.sub")}</div>
      {view !== undefined && <div className="setup-note">{t("setup.autostart.services", { url: view.managerUrl })}</div>}
      {failed !== undefined && (
        <div className="field-error" role="alert">
          {failed}
        </div>
      )}
    </div>
  );
}

function AutostartSwitch() {
  const { http } = useStore();
  const toast = useToast();
  const [view, setView] = useState<AutostartView>();
  const [failed, setFailed] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    http.autostart().then(
      (next) => {
        if (live) setView(next);
      },
      (err: unknown) => {
        if (live) setFailed(t("setup.autostart.loadFailed", { reason: messageOf(err) }));
      },
    );
    return () => {
      live = false;
    };
  }, [http]);

  const change = (on: boolean) => {
    setSaving(true);
    setFailed(undefined);
    http
      .setAutostart(on)
      .then(
        (next) => {
          setView(next);
          toast(t(on ? "setup.autostart.turnedOn" : "setup.autostart.turnedOff"));
        },
        (err: unknown) => setFailed(messageOf(err)),
      )
      .finally(() => setSaving(false));
  };

  return <AutostartBlock view={view} failed={failed} saving={saving} onChange={change} />;
}

export function CapabilitiesStep({ navigate }: { navigate: Navigate }) {
  const { http, ui } = useStore();
  const toast = useToast();
  const revision = ui.locale?.revision;
  const [components, setComponents] = useState<ComponentsView>();
  const [plugins, setPlugins] = useState<PluginInfo[]>();
  const [loadFailed, setLoadFailed] = useState<string>();
  const [ticked, setTicked] = useState<Set<string>>();
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  /** 组件装好了才能启用的插件 */
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [licensing, setLicensing] = useState<ComponentView>();
  const answerLicense = useRef<(ok: boolean) => void>(undefined);

  const applyComponents = useCallback((next: ComponentsView) => {
    setComponents(next);
    setComponentsCache(next);
  }, []);

  // 打开时取一次（换了语言再取：字是守护进程按语言写的）；有在下的时候每秒再取
  const active = capabilityActive(components);
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- revision 只用来在换了语言时重取
  useEffect(() => {
    let live = true;
    const load = () =>
      http.components().then(
        (next) => {
          if (!live) return;
          applyComponents(next);
          setLoadFailed(undefined);
        },
        (err: unknown) => {
          if (live) setLoadFailed(messageOf(err));
        },
      );
    void load();
    const timer = active ? setInterval(() => void load(), 1000) : undefined;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [http, active, revision, applyComponents]);

  // 换了语言再取；插件的状况变了（这台设备上或者别处）跟着变
  const statusKey = (ui.pluginStatus?.plugins ?? []).map((p) => `${p.name}:${p.state}`).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- statusKey、revision 只用来在状况、语言变了时重取
  useEffect(() => {
    let live = true;
    http.plugins().then(
      (view) => {
        if (live) setPlugins(view.plugins);
      },
      (err: unknown) => {
        if (live) setLoadFailed(messageOf(err));
      },
    );
    return () => {
      live = false;
    };
  }, [http, statusKey, revision]);

  const rows = capabilityRows(components, plugins);

  // 两份清单都到了：照默认勾上（只这一次，之后是用户自己勾的）
  const loaded = components !== undefined && plugins !== undefined;
  useEffect(() => {
    if (components && plugins) setTicked((now) => now ?? defaultTicked(capabilityRows(components, plugins)));
  }, [components, plugins]);

  // 等着组件的插件：组件装好了就启用
  useEffect(() => {
    const ready = rows.filter((row) => row.kind === "plugin" && waiting.has(row.id) && row.status === "available" && !row.component);
    if (ready.length === 0 || busy) return;
    setWaiting((now) => new Set([...now].filter((name) => !ready.some((row) => row.id === name))));
    void (async () => {
      for (const row of ready) {
        try {
          setPlugins((await http.pluginAction(row.id, { action: "enable", idempotencyKey: newKey() })).plugins);
        } catch (err) {
          setFailures((now) => new Map(now).set(row.key, messageOf(err)));
        }
      }
    })();
  }, [rows, waiting, busy, http]);

  const api: CapabilityApi = {
    componentAction: (id, action, extra) => http.componentAction(id, action, extra),
    pluginAction: (name, body) => http.pluginAction(name, body),
    confirmLicense: (c) =>
      new Promise((resolve) => {
        answerLicense.current = resolve;
        setLicensing(c);
      }),
    newKey,
  };

  const start = () => {
    if (!ticked) return;
    const plan = capabilityPlan(rows, ticked);
    setBusy(true);
    setFailures(new Map());
    setWaiting((now) => new Set([...now, ...plan.afterInstall]));
    void applyCapabilities(plan, rows, api)
      .then((result) => {
        if (result.plugins) setPlugins(result.plugins);
        if (result.components) applyComponents(result.components);
        setFailures(result.failures);
        if (result.declined.length > 0) {
          // 没同意许可的：不下载，勾也去掉
          setTicked((now) => new Set([...(now ?? [])].filter((key) => !result.declined.includes(key))));
          toast(t("setup.steps.capabilities.declined"));
        }
      })
      .finally(() => setBusy(false));
  };

  const retry = (row: CapabilityRow) => {
    setBusy(true);
    setFailures((now) => {
      const next = new Map(now);
      next.delete(row.key);
      return next;
    });
    const again = row.component
      ? retryCapability(row.component, components?.components ?? [], api).then((next) => {
          if (next) applyComponents(next);
        })
      : http.pluginAction(row.id, { action: "enable", idempotencyKey: newKey() }).then((result) => setPlugins(result.plugins));
    void again.catch((err: unknown) => setFailures((now) => new Map(now).set(row.key, messageOf(err)))).finally(() => setBusy(false));
  };

  const closeLicense = (ok: boolean) => {
    setLicensing(undefined);
    answerLicense.current?.(ok);
    answerLicense.current = undefined;
  };

  const chosen = ticked ? capabilityPlan(rows, ticked) : undefined;
  const count = (chosen?.plugins.length ?? 0) + (chosen?.components.length ?? 0);
  const total = ticked ? capabilityTotal(rows, ticked, components) : 0;

  return (
    <>
      {!loaded && loadFailed === undefined && <div className="muted">{t("setup.steps.capabilities.loading")}</div>}
      {loadFailed !== undefined && (
        <div className="field-error" role="alert">
          {t("setup.steps.capabilities.loadFailed", { reason: loadFailed })}
        </div>
      )}
      <CapabilityList
        rows={rows}
        all={components?.components ?? []}
        ticked={ticked ?? new Set()}
        skipped={skipped}
        failures={failures}
        busy={busy}
        onToggle={(key, on) => setTicked((now) => (on ? new Set([...(now ?? []), key]) : new Set([...(now ?? [])].filter((k) => k !== key))))}
        onRetry={retry}
        onSkip={(row) => {
          setSkipped((now) => new Set([...now, row.key]));
          setTicked((now) => new Set([...(now ?? [])].filter((key) => key !== row.key)));
        }}
      />
      {loaded && (
        <div className="capability-start">
          <button type="button" className="btn primary" disabled={busy || count === 0} onClick={start} data-capability-start="">
            {busy ? t("setup.steps.capabilities.working") : total > 0 ? t("setup.steps.capabilities.startDownload", { n: count, size: sizeLabel(total) }) : t("setup.steps.capabilities.start", { n: count })}
          </button>
          <div className="setup-note">{t("setup.steps.capabilities.background")}</div>
          <div className="capability-links">
            <button type="button" className="link" onClick={() => navigate({ tab: "more", page: "components" })}>
              {t("setup.steps.capabilities.componentsGo")}
            </button>
            <button type="button" className="link" onClick={() => navigate({ tab: "more", page: "plugins" })}>
              {t("setup.steps.capabilities.pluginsGo")}
            </button>
          </div>
        </div>
      )}
      {loaded && <InstalledNow components={components} plugins={plugins} />}
      <AutostartSwitch />
      {licensing && <LicenseConfirm component={licensing} all={components?.components ?? []} onCancel={() => closeLicense(false)} onConfirm={() => closeLicense(true)} />}
    </>
  );
}
