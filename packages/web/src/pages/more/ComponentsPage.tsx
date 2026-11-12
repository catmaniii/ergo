// 设置 · 组件（议题 26"安装包、组件和源码安装"）：模型、语音这些大件不放进安装包，要用时在这里下载。
// - 一个组件一块：名字和状况的小签、一句话；版本（装着的、清单里的）、大小（下载多大、装好占多大）、默认装不装（清单里写的，
//   "检测到才装"的写检测到了没有）、用哪一版（CUDA / CPU 和为什么）、打开哪些功能、从哪几个地方下、装在哪；别处已经有了的写谁提供的；
//   这一版还不能从这里装的写原因；
// - 正在下：进度条、已下 / 一共、速度、还要多久、从哪个地址下；按钮按状况给：安装 / 暂停 / 继续 / 取消 / 重试 / 删除 / 更新；
// -标了推荐的亮一个小签；许可写一行（名字带链接、一句话），要求标注的那句（Built with Fish Audio）单独一行；要确认许可的，
//   下载前弹确认框（名字、大小、许可、那一句话、原文链接），同意了才带上确认标记去下载；带常驻服务的（语音合成程序）多一个运行状态的小签、
//   端口和开机自启，按钮多启动 / 停止；下载失败、暂停着时列出还差的文件和下载地址，自己下好了用现有的"从文件导入…"；
// - 上面一排："装上默认的组件"（照清单的默认该装、还没装的）、"从文件导入…"（这台电脑上一个文件、文件夹或 .tar / .tgz 包的路径，
//   守护进程按清单里的大小和校验值认；和设置里导入 skill 一样填路径）；
// - 正在下的时候每秒重取一次；别处（功能灰掉的地方）点"去装"过来的那一块亮一下；
// -"检查更新"（每晚也自己查一次）：有新版本的组件显示"有新版本"，点了"更新"才换；没查成只在这里写一行，写明查的是哪里、只取版本清单。
// 下载在守护进程里做，关掉这一页照样下。列表、确认框是纯渲染的组件（ComponentList、ComponentRow），测试在 Node 里直接渲染。
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../app/store.tsx";
import {
  type ComponentAction,
  type ComponentImportResult,
  componentBusy,
  componentNeedsLicense,
  type ComponentServiceState,
  type ComponentsView,
  type ComponentState,
  type ComponentView,
  formatList,
  sizeLabel,
  t,
} from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";
import { setComponentsCache, takeComponentFocus } from "../../ui/component-gate.tsx";
import { timeLabel } from "../../util/time.ts";

/** 状况的小签 */
const STATE_CHIP: Readonly<Record<ComponentState, string>> = {
  installed: "chip chip-ok",
  update: "chip chip-op",
  provided: "chip chip-ok",
  missing: "chip",
  queued: "chip chip-quiet",
  downloading: "chip chip-op",
  paused: "chip chip-quiet",
  installing: "chip chip-op",
  failed: "chip chip-no",
};

/** 常驻服务的小签（还接不上的不亮，下面有一句说明） */
const SERVICE_CHIP: Readonly<Record<ComponentServiceState, string>> = {
  idle: "chip chip-quiet",
  starting: "chip chip-op",
  running: "chip chip-ok",
  stopped: "chip chip-quiet",
  failed: "chip chip-no",
};

export function componentStateText(state: ComponentState): string {
  return t(`pages.components.state.${state}`);
}

/** 还要多久："不到 1 分钟""约 5 分钟""约 1 小时 20 分钟" */
export function etaText(seconds: number): string {
  if (seconds < 60) return t("pages.components.eta.underMinute");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("pages.components.eta.minutes", { count: minutes, minutes });
  return t("pages.components.eta.hours", { count: Math.floor(minutes / 60), hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** 进度那一行："已下 216.4 MB / 559.6 MB · 6.4 MB/s · 还要约 1 分钟 · 从 hf-mirror" */
export function progressText(c: ComponentView): string | undefined {
  const p = c.progress;
  if (!p) return undefined;
  if (p.phase === "probing") return t("pages.components.phase.probing");
  if (p.phase === "verifying") return t("pages.components.phase.verifying");
  if (p.phase === "installing") return t("pages.components.phase.installing");
  const parts = [t("pages.components.progress.done", { done: sizeLabel(p.done), total: sizeLabel(p.total) })];
  if (p.speed !== undefined) parts.push(t("pages.components.progress.speed", { speed: sizeLabel(p.speed) }));
  if (p.etaSeconds !== undefined) parts.push(t("pages.components.progress.eta", { eta: etaText(p.etaSeconds) }));
  if (p.source !== undefined) parts.push(t("pages.components.progress.source", { source: p.source }));
  return parts.join(" · ");
}

/** 带一句括号里的说明（"本机装了 Claude Code 才装（没检测到）"） */
const withNote = (text: string, note: string | undefined) => (note === undefined ? text : t("pages.components.withNote", { text, note }));

/** 一块下面的几行（键、值）：版本、大小、默认、用哪一版、打开的功能、依赖、下载地址、装在哪 */
export function componentLines(c: ComponentView, all: readonly ComponentView[]): { key: string; label: string; value: string }[] {
  const lines: { key: string; label: string; value: string }[] = [];
  const version = c.installedVersion !== undefined && c.installedVersion !== c.version ? t("pages.components.versionUpdate", { installed: c.installedVersion, latest: c.version }) : c.version;
  lines.push({ key: "version", label: t("pages.components.label.version"), value: version });
  if (c.service) {
    const address = `127.0.0.1:${c.service.port}`;
    lines.push({ key: "service", label: t("pages.components.label.service"), value: c.service.autostart ? `${address} · ${t("pages.components.serviceAutostart")}` : address });
  }
  const size = c.size > 0 ? sizeLabel(c.size) : t("pages.components.sizeUnknown");
  lines.push({ key: "size", label: t("pages.components.label.size"), value: c.diskSize !== undefined ? t("pages.components.sizeInstalled", { download: size, disk: sizeLabel(c.diskSize) }) : size });
  lines.push({ key: "default", label: t("pages.components.label.default"), value: withNote(c.defaultText, c.detectedText) });
  if (c.variant) lines.push({ key: "variant", label: t("pages.components.label.variant"), value: withNote(c.variant.title, c.variant.reason) });
  if (c.enables.length > 0) lines.push({ key: "enables", label: t("pages.components.label.enables"), value: formatList(c.enables.map((f) => f.title)) });
  if (c.dependsOn.length > 0) lines.push({ key: "depends", label: t("pages.components.label.depends"), value: formatList(c.dependsOn.map((id) => all.find((o) => o.id === id)?.title ?? id)) });
  if (c.sources.length > 0) lines.push({ key: "sources", label: t("pages.components.label.sources"), value: formatList(c.sources) });
  lines.push({ key: "location", label: t("pages.components.label.location"), value: withNote(c.location, c.locationNote) });
  return lines;
}

/** 按状况给哪几个按钮（先后就是显示的先后；第一个是主按钮） */
export function componentActions(c: ComponentView): ComponentAction[] {
  const installable = c.cannotInstall === undefined;
  const serviceState = c.service?.state;
  const service: ComponentAction[] = serviceState === "running" ? ["stop"] : serviceState === "stopped" || serviceState === "failed" ? ["start"] : [];
  switch (c.state) {
    case "missing":
      return installable ? ["install"] : [];
    case "provided":
      return installable ? ["install"] : [];
    case "queued":
      return ["cancel"];
    case "downloading":
      return ["pause", "cancel"];
    case "paused":
      return ["resume", "cancel"];
    case "failed":
      return ["resume", "cancel"];
    case "installing":
      return [];
    case "installed":
      return [...service, "remove"];
    case "update":
      return ["update", ...service, "remove"];
  }
}

const ACTION_TEXT: Readonly<Record<ComponentAction, string>> = {
  install: "pages.components.action.install",
  update: "pages.components.action.update",
  remove: "pages.components.action.remove",
  pause: "pages.components.action.pause",
  resume: "pages.components.action.resume",
  cancel: "pages.components.action.cancel",
  start: "pages.components.action.start",
  stop: "pages.components.action.stop",
};

/** 按钮上的字："继续"在出错了的时候是"重试"，别处有的"安装"是"从这里装" */
export function actionText(c: ComponentView, action: ComponentAction): string {
  if (action === "resume" && c.state === "failed") return t("pages.components.action.retry");
  if (action === "start" && c.service?.state === "failed") return t("pages.components.action.retry");
  if (action === "install" && c.state === "provided") return t("pages.components.action.installHere");
  return t(ACTION_TEXT[action]);
}

/** 离线导入完说一句 */
export function importText(result: ComponentImportResult): string {
  const title = (id: string) => result.view.components.find((c) => c.id === id)?.title ?? id;
  const lines: string[] = [];
  if (result.installed.length > 0) lines.push(t("pages.components.import.installed", { names: formatList(result.installed.map(title)) }));
  if (result.matched.length > 0) lines.push(t("pages.components.import.matched", { count: result.matched.length, n: result.matched.length }));
  for (const m of result.missing) lines.push(t("pages.components.import.missing", { title: title(m.component), files: formatList(m.files) }));
  if (result.unknown.length > 0) lines.push(t("pages.components.import.unknown", { count: result.unknown.length, n: result.unknown.length, names: formatList(result.unknown.slice(0, 5)) }));
  if (lines.length === 0) lines.push(t("pages.components.import.nothing"));
  return lines.join("\n");
}

export interface ComponentRowProps {
  component: ComponentView;
  all: readonly ComponentView[];
  /** 正在点的（等守护进程回话） */
  busy: boolean;
  /** 别处点"去装"过来的：亮一下 */
  focused: boolean;
  onAct(action: ComponentAction, c: ComponentView): void;
  /** 打开"从文件导入…"（下载不下来时那一块里也放一个） */
  onImport?: () => void;
}

export function ComponentRow({ component: c, all, busy, focused, onAct, onImport }: ComponentRowProps) {
  const progress = progressText(c);
  const p = c.progress;
  const percent = p && p.total > 0 ? Math.min(100, Math.floor((p.done / p.total) * 100)) : undefined;
  const actions = componentActions(c);
  return (
    <div className={`component-row component-state-${c.state}${focused ? " component-focus" : ""}`} data-component={c.id}>
      <div className="component-head">
        <span className="component-name">{c.title}</span>
        <span className={STATE_CHIP[c.state]}>{componentStateText(c.state)}</span>
        {c.wanted && (c.state === "missing" || c.state === "failed" || c.state === "paused") && c.cannotInstall === undefined && <span className="chip chip-quiet">{t("pages.components.wanted")}</span>}
        {c.recommended && <span className="chip chip-op component-recommended">{t("pages.components.recommended")}</span>}
        {c.service && c.service.state !== "idle" && <span className={`${SERVICE_CHIP[c.service.state]} component-service-state`}>{t(`pages.components.service.${c.service.state}`)}</span>}
      </div>
      {c.summary && <div className="component-summary">{c.summary}</div>}
      {c.providedBy !== undefined && <div className="component-provided">{c.providedBy}</div>}
      {c.note !== undefined && <div className="component-note">{c.note}</div>}
      <dl className="component-lines">
        {componentLines(c, all).map((line) => (
          <div key={line.key} className={`component-line component-line-${line.key}`}>
            <dt>{line.label}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
      </dl>
      {c.license && (
        <div className="component-license">
          <a href={c.license.url} target="_blank" rel="noopener noreferrer">
            {c.license.name}
          </a>
          <span> · {c.license.summary}</span>
        </div>
      )}
      {c.license?.attribution !== undefined && <div className="component-attribution">{c.license.attribution}</div>}
      {p && percent !== undefined && (c.state === "downloading" || c.state === "paused" || c.state === "installing" || c.state === "failed") && (
        <div className="component-progress">
          <div className="component-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div style={{ width: `${percent}%` }} />
          </div>
          <div className="component-progress-text">{c.state === "downloading" || c.state === "installing" ? progress : t("pages.components.progress.done", { done: sizeLabel(p.done), total: sizeLabel(p.total) })}</div>
        </div>
      )}
      {c.cannotInstall !== undefined && c.state !== "installed" && <div className="component-note">{c.cannotInstall}</div>}
      {c.error !== undefined && <div className={c.state === "failed" ? "field-error" : "component-note"}>{c.error}</div>}
      {c.service?.note !== undefined && <div className="component-note">{c.service.note}</div>}
      {c.service?.error !== undefined && <div className="field-error">{c.service.error}</div>}
      {c.service?.warning !== undefined && <div className="field-error">{c.service.warning}</div>}
      {c.manualDownload && c.manualDownload.length > 0 && (
        <div className="component-manual">
          <div>{t("pages.components.manual.hint")}</div>
          <ul>
            {c.manualDownload.map((file) => (
              <li key={file.name}>
                <span>{t("pages.components.manual.file", { name: file.name, size: sizeLabel(file.size) })}</span>
                {file.links.map((link) => (
                  <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.title}
                  </a>
                ))}
              </li>
            ))}
          </ul>
          {onImport && (
            <div>
              <button type="button" className="btn ghost small" onClick={onImport}>
                {t("pages.components.import.button")}
              </button>
            </div>
          )}
        </div>
      )}
      {actions.length > 0 && (
        <div className="component-actions">
          {busy ? (
            <span className="muted">{t("pages.components.working")}</span>
          ) : (
            actions.map((action, i) => (
              <button key={action} type="button" className={`btn ${i === 0 && action !== "remove" && action !== "cancel" && action !== "stop" ? "primary" : "ghost"} small`} onClick={() => onAct(action, c)}>
                {actionText(c, action)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** 查更新那两行：上次查的结果（没查成只是一句话，不算出错）、查的是哪里 */
export function ComponentUpdates({ view }: { view: ComponentsView }) {
  const updates = view.updates;
  if (!updates) return null;
  const time = updates.checkedAt === undefined ? "" : timeLabel(updates.checkedAt);
  const names = updates.available.map((id) => view.components.find((c) => c.id === id)?.title ?? id);
  const result =
    updates.available.length > 0
      ? t("pages.components.updates.available", { names: formatList(names), time })
      : updates.notPublished === true
        ? t("pages.components.updates.notPublished", { time })
        : updates.error !== undefined
        ? t("pages.components.updates.failed", { time, reason: updates.error })
        : updates.checkedAt !== undefined
          ? t("pages.components.updates.none", { time })
          : t("pages.components.updates.never");
  return (
    <div className="component-updates muted" data-updates={updates.available.length > 0 ? "available" : updates.notPublished === true ? "not-published" : updates.error !== undefined ? "failed" : "none"}>
      <div>{result}</div>
      <div className="component-updates-where">{t("pages.components.updates.where", { where: updates.where })}</div>
    </div>
  );
}

export function ComponentList({ view, busy, focused, onAct, onImport }: { view: ComponentsView; busy: string | undefined; focused: string | undefined; onAct: ComponentRowProps["onAct"]; onImport?: () => void }) {
  return (
    <div className="component-list">
      {view.components.length === 0 ? (
        <div className="muted">{t("pages.components.none")}</div>
      ) : (
        view.components.map((c) => <ComponentRow key={c.id} component={c} all={view.components} busy={busy === c.id} focused={focused === c.id} onAct={onAct} {...(onImport ? { onImport } : {})} />)
      )}
    </div>
  );
}

/** 从文件导入：填这台电脑上的路径 */
function ImportSheet({ onClose, onImport }: { onClose(): void; onImport(path: string): Promise<void> }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = () => {
    setBusy(true);
    setError(undefined);
    onImport(path.trim()).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    });
  };
  return (
    <Sheet title={t("pages.components.import.title")} onClose={onClose} center>
      <label className="field">
        <span>{t("pages.components.import.path")}</span>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t("pages.components.import.placeholder")} />
      </label>
      <div className="hint">{t("pages.components.import.hint")}</div>
      {error && <div className="field-error">{error}</div>}
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.components.cancel")}
        </button>
        <button type="button" className="btn primary" disabled={path.trim() === "" || busy} onClick={submit}>
          {busy ? t("pages.components.import.importing") : t("pages.components.import.ok")}
        </button>
      </div>
    </Sheet>
  );
}

/** 删之前确认：对应的功能会灰掉、要用时再装 */
function RemoveConfirm({ component: c, onCancel, onConfirm }: { component: ComponentView; onCancel(): void; onConfirm(): void }) {
  return (
    <Sheet title={t("pages.components.confirm.removeTitle", { title: c.title })} onClose={onCancel} center>
      <div className="modal-body">
        <p>{t("pages.components.confirm.removeBody", { location: c.location })}</p>
        {c.enables.length > 0 && <p>{t("pages.components.confirm.removeFeatures", { features: formatList(c.enables.map((f) => f.title)) })}</p>}
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("pages.components.cancel")}
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          {t("pages.components.action.remove")}
        </button>
      </div>
    </Sheet>
  );
}

/** 确认框里的大小：按 1000 算的那个（模型页、下载工具写的）；Windows 按 1024 算、数字小一些，不一样时两个都写，免得以为下错了 */
export function licenseSizeText(size: number): string {
  const binary = sizeLabel(size);
  if (size < 1e9) return binary;
  const decimal = `${(size / 1e9).toFixed(1)} GB`;
  return decimal === binary ? binary : t("pages.components.license.sizeValue", { decimal, binary });
}

/** 下载前确认许可：名字、大小、许可、那一句话、原文链接；还没装的依赖也要下，写明 */
export function LicenseConfirm({ component: c, all, onCancel, onConfirm }: { component: ComponentView; all: readonly ComponentView[]; onCancel(): void; onConfirm(): void }) {
  const license = c.license;
  if (!license) return null;
  const deps = c.dependsOn.flatMap((id) => all.filter((o) => o.id === id && o.state === "missing"));
  return (
    <Sheet title={t("pages.components.license.title")} onClose={onCancel} center>
      <div className="modal-body component-license-confirm">
        <dl className="component-lines">
          <div className="component-line">
            <dt>{t("pages.components.license.name")}</dt>
            <dd>{c.title}</dd>
          </div>
          <div className="component-line">
            <dt>{t("pages.components.license.size")}</dt>
            <dd>{licenseSizeText(c.size)}</dd>
          </div>
          <div className="component-line">
            <dt>{t("pages.components.license.license")}</dt>
            <dd>{license.name}</dd>
          </div>
        </dl>
        <p className="component-license-summary">{license.summary}</p>
        <p>
          <a href={license.url} target="_blank" rel="noopener noreferrer">
            {t("pages.components.license.original")}
          </a>
        </p>
        {deps.length > 0 && <p className="muted">{t("pages.components.license.deps", { names: formatList(deps.map((d) => d.title)), size: sizeLabel(deps.reduce((sum, d) => sum + d.size, 0)) })}</p>}
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("pages.components.cancel")}
        </button>
        <button type="button" className="btn primary" onClick={onConfirm}>
          {t("pages.components.license.accept")}
        </button>
      </div>
    </Sheet>
  );
}

export function ComponentsPage() {
  const { http, ui } = useStore();
  const revision = ui.locale?.revision;
  const [view, setView] = useState<ComponentsView>();
  const [loadFailed, setLoadFailed] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [note, setNote] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState<ComponentView>();
  const [licensing, setLicensing] = useState<{ action: ComponentAction; component: ComponentView }>();
  const [checking, setChecking] = useState(false);
  const [focused] = useState(takeComponentFocus);
  const listRef = useRef<HTMLDivElement>(null);

  const apply = (next: ComponentsView) => {
    setView(next);
    setComponentsCache(next);
  };

  // 打开时取一次（换了语言再取：字是守护进程按语言写的）；正在下的时候每秒再取
  const active = view?.components.some((c) => componentBusy(c.state) || c.service?.state === "starting") ?? false;
  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- revision 只用来在换了语言时重取
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      http.components().then(
        (next) => {
          if (cancelled) return;
          apply(next);
          setLoadFailed(undefined);
        },
        (err: unknown) => {
          if (!cancelled) setLoadFailed(err instanceof Error ? err.message : String(err));
        },
      );
    void load();
    const timer = active ? setInterval(() => void load(), 1000) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [http, active, revision]);

  // 别处点"去装"过来的：清单到了以后那一块滚到看得见
  const loaded = view !== undefined;
  useEffect(() => {
    if (!focused || !loaded) return;
    listRef.current?.querySelector(`[data-component="${CSS.escape(focused)}"]`)?.scrollIntoView({ block: "center" });
  }, [focused, loaded]);

  const run = (action: ComponentAction, c: ComponentView, extra?: { licenseAccepted?: boolean }) => {
    setBusy(c.id);
    setFailed(undefined);
    setNote(undefined);
    http
      .componentAction(c.id, action, extra)
      .then(apply, (err: unknown) => setFailed(t("pages.components.failed", { reason: err instanceof Error ? err.message : String(err) })))
      .finally(() => setBusy(undefined));
  };

  const onAct = (action: ComponentAction, c: ComponentView) => {
    if (action === "remove") return setRemoving(c);
    if ((action === "install" || action === "update" || action === "resume") && componentNeedsLicense(c)) return setLicensing({ action, component: c });
    run(action, c);
  };

  const defaults = view?.defaultsMissing ?? [];
  return (
    <div className="components-page">
      <Section title={t("pages.components.listTitle")}>
        <span className="muted">{t("pages.components.intro")}</span>
        <div className="component-toolbar">
          {defaults.length > 0 && (
            <button
              type="button"
              className="btn primary small"
              disabled={busy !== undefined}
              onClick={() => {
                setFailed(undefined);
                http.installDefaultComponents().then(apply, (err: unknown) => setFailed(t("pages.components.failed", { reason: err instanceof Error ? err.message : String(err) })));
              }}
            >
              {t("pages.components.installDefaults", { count: defaults.length, n: defaults.length })}
            </button>
          )}
          <button type="button" className="btn ghost small" onClick={() => setImporting(true)}>
            {t("pages.components.import.button")}
          </button>
          <button
            type="button"
            className="btn ghost small"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              setFailed(undefined);
              http
                .checkComponentUpdates()
                .then(apply, (err: unknown) => setFailed(t("pages.components.failed", { reason: err instanceof Error ? err.message : String(err) })))
                .finally(() => setChecking(false));
            }}
          >
            {checking ? t("pages.components.updates.checking") : t("pages.components.updates.check")}
          </button>
        </div>
        {view && <ComponentUpdates view={view} />}
        {!view && !loadFailed && <div className="muted">{t("pages.components.loading")}</div>}
        {loadFailed && (
          <div className="field-error" role="alert">
            {t("pages.components.loadFailed", { reason: loadFailed })}
          </div>
        )}
        <div ref={listRef}>{view && <ComponentList view={view} busy={busy} focused={focused} onAct={onAct} onImport={() => setImporting(true)} />}</div>
        {failed && (
          <div className="field-error" role="alert">
            {failed}
          </div>
        )}
        {note && (
          <div className="hint component-import-note" role="status">
            {note}
          </div>
        )}
        {view && <div className="muted component-manifest">{view.manifest.signed ? t("pages.components.manifestSigned", { release: view.manifest.release }) : t("pages.components.manifestUnsigned", { release: view.manifest.release })}</div>}
      </Section>
      {importing && (
        <ImportSheet
          onClose={() => setImporting(false)}
          onImport={async (path) => {
            const result = await http.importComponents(path);
            apply(result.view);
            setImporting(false);
            setNote(importText(result));
          }}
        />
      )}
      {licensing && (
        <LicenseConfirm
          component={licensing.component}
          all={view?.components ?? []}
          onCancel={() => setLicensing(undefined)}
          onConfirm={() => {
            const { action, component } = licensing;
            setLicensing(undefined);
            run(action, component, { licenseAccepted: true });
          }}
        />
      )}
      {removing && (
        <RemoveConfirm
          component={removing}
          onCancel={() => setRemoving(undefined)}
          onConfirm={() => {
            const c = removing;
            setRemoving(undefined);
            run("remove", c);
          }}
        />
      )}
    </div>
  );
}
