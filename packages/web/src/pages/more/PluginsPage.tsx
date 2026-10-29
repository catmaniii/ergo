// 设置 · 插件（211 号票，用户 2026-10-20："设置界面里面要能查看当前加载了哪些插件，还有可以把它暂时禁用或者是移除。相当于是可以热插拔"）：
// - 列出守护进程清单里的全部插件：名字（按当前语言）、一句话、状况（运行中 / 已停用 / 没装上带原因 / 已移除；315 号票起要的外部组件没装的
//   写"没装"和怎么装，装好之前启用不了）、它带来了什么
//   （给二狗的工具几个、卡片、定时作业——守护进程写；网页上的页面、栏目——网页插件自己写，WebPluginDefinition.brings）、依赖；
// - 停用、启用马上生效（不重启）：停用之前确认框里列出会一起停的（要用它的插件），启用时它要的插件没开的列出、一起开；
// - 移除：停用并收进下面折叠着的"已移除"（能装回，就是启用）。确认框里多一个勾选"连它的数据一起彻底删除"（默认不勾），
//   勾了再确认一次，写明删哪些、删不掉哪些、不能恢复（守护进程按插件在数据契约里写明的删，留删除记录）；
// - 状况变了守护进程在插件频道上推来：网页插件跟着收起、放回它的页面和栏目（plugins/react.tsx 的 PluginStatusSync），这一页跟着重取清单。
// 每次打开、插件的状况或者词典的版本变了现取一次清单。列表和确认框是纯渲染的组件（PluginList、PluginConfirm），测试在 Node 里直接渲染。
import { useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { usePlugins } from "../../plugins/api.ts";
import { formatList, type PluginAction, type PluginActionResult, type PluginInfo, type PluginState, t } from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 状况的小签 */
const STATE_CHIP: Readonly<Record<PluginState, string>> = { running: "chip chip-ok", disabled: "chip", skipped: "chip chip-no", removed: "chip chip-quiet" };

/** 一组插件名写成给人看的：「提醒」、「记忆」 */
export function pluginNames(names: readonly string[], all: readonly PluginInfo[]): string {
  return formatList(names.map((name) => t("pages.plugins.quoted", { title: all.find((p) => p.name === name)?.title ?? name })));
}

/** 一个插件下面的几行：它带来了什么（工具、卡片、定时作业、网页上的页面和栏目）、要用谁、谁要用它 */
export function pluginLines(plugin: PluginInfo, all: readonly PluginInfo[], web: readonly string[]): string[] {
  const { tools, cards, jobs } = plugin.brings;
  const lines = [
    ...(tools.length > 0 ? [t("pages.plugins.tools", { count: tools.length, n: tools.length, names: formatList(tools) })] : []),
    ...(cards.length > 0 ? [t("pages.plugins.cards", { names: formatList(cards) })] : []),
    ...(jobs.length > 0 ? [t("pages.plugins.jobs", { names: formatList(jobs) })] : []),
    ...(web.length > 0 ? [t("pages.plugins.web", { names: formatList(web) })] : []),
  ];
  if (lines.length === 0) lines.push(t("pages.plugins.bringsNothing"));
  if (plugin.needs.length > 0) lines.push(t("pages.plugins.needs", { names: pluginNames(plugin.needs, all) }));
  if (plugin.neededBy.length > 0) lines.push(t("pages.plugins.neededBy", { names: pluginNames(plugin.neededBy, all) }));
  return lines;
}

/** 状况的说法；没装上是因为它要的外部组件没装时（315 号票）写"没装" */
export function pluginStateText(state: PluginState, missing?: boolean): string {
  return state === "skipped" && missing ? t("pages.plugins.state.missing") : t(`pages.plugins.state.${state}`);
}

/** 正在确认的：哪一步（停用、启用、移除；移除勾了连数据删的第二步 purge） */
export interface PluginConfirming {
  kind: "disable" | "enable" | "remove" | "purge";
  plugin: PluginInfo;
  /** 移除时勾了"连它的数据一起彻底删除"没有 */
  purge: boolean;
}

/** 确认框里写什么：标题、几段话、确认的按钮、是不是危险的 */
export function confirmText(c: PluginConfirming, all: readonly PluginInfo[]): { title: string; lines: string[]; ok: string; danger: boolean } {
  const title = c.plugin.title;
  const together = c.plugin.stopsWith.length > 0 ? [t("pages.plugins.confirm.stopsWith", { names: pluginNames(c.plugin.stopsWith, all) })] : [];
  switch (c.kind) {
    case "disable":
      return { title: t("pages.plugins.confirm.disableTitle", { title }), lines: [t("pages.plugins.confirm.disableBody"), ...together], ok: t("pages.plugins.action.disable"), danger: false };
    case "enable":
      return {
        title: t(c.plugin.state === "removed" ? "pages.plugins.confirm.restoreTitle" : "pages.plugins.confirm.enableTitle", { title }),
        lines: [t("pages.plugins.confirm.startsWith", { names: pluginNames(c.plugin.startsWith, all) })],
        ok: t(c.plugin.state === "removed" ? "pages.plugins.action.restore" : "pages.plugins.action.enable"),
        danger: false,
      };
    case "remove":
      return { title: t("pages.plugins.confirm.removeTitle", { title }), lines: [t("pages.plugins.confirm.removeBody"), ...together], ok: t("pages.plugins.action.remove"), danger: c.purge };
    case "purge":
      return { title: t("pages.plugins.confirm.purgeTitle", { title }), lines: [], ok: t("pages.plugins.confirm.purgeOk"), danger: true };
  }
}

/** 做完了说一句：变了哪些、连数据删了几条 */
export function doneText(action: PluginAction, plugin: PluginInfo, result: PluginActionResult, all: readonly PluginInfo[]): string {
  const names = pluginNames(result.changed.length > 0 ? result.changed : [plugin.name], all);
  const done = t(`pages.plugins.done.${action === "enable" && plugin.state === "removed" ? "restore" : action}`, { names });
  if (!result.purged) return done;
  const { events, cards, inboxItems } = result.purged;
  return `${done}${t("pages.plugins.done.purged", { events, cards, inbox: inboxItems })}`;
}

export interface PluginListProps {
  plugins: readonly PluginInfo[];
  /** 网页插件写的"网页上的页面、栏目"（按插件名） */
  web: (name: string) => readonly string[];
  /** 正在处理的插件 */
  busy: string | undefined;
  /** "已移除"那一组展开着没有 */
  removedOpen: boolean;
  onToggleRemoved(): void;
  onAct(kind: "disable" | "enable" | "remove", plugin: PluginInfo): void;
}

/** 插件的列表：在用的（运行中、已停用、没装上）一个一块；移除了的收在下面"已移除（N）"里，折叠着 */
export function PluginList({ plugins, web, busy, removedOpen, onToggleRemoved, onAct }: PluginListProps) {
  const shown = plugins.filter((p) => p.state !== "removed");
  const removed = plugins.filter((p) => p.state === "removed");
  const row = (p: PluginInfo) => <PluginRow key={p.name} plugin={p} all={plugins} web={web(p.name)} busy={busy} onAct={onAct} />;
  return (
    <>
      <div className="plugin-list">{shown.length > 0 ? shown.map(row) : <div className="muted">{t("pages.plugins.noneInUse")}</div>}</div>
      {removed.length > 0 && (
        <div className="plugin-removed">
          <button type="button" className="plugin-fold" aria-expanded={removedOpen} onClick={onToggleRemoved}>
            <span>{t("pages.plugins.removedGroup", { count: removed.length })}</span>
            <span className="muted" aria-hidden="true">
              {removedOpen ? "▾" : "▸"}
            </span>
          </button>
          {removedOpen && <div className="plugin-list">{removed.map(row)}</div>}
        </div>
      )}
    </>
  );
}

function PluginRow({ plugin: p, all, web, busy, onAct }: { plugin: PluginInfo; all: readonly PluginInfo[]; web: readonly string[]; busy: string | undefined; onAct: PluginListProps["onAct"] }) {
  const working = busy === p.name;
  const disabled = busy !== undefined;
  const canEnable = p.cannotEnable === undefined;
  const button = (kind: "disable" | "enable" | "remove", label: string, primary = false) => (
    <button key={kind} type="button" className={`btn ${primary ? "primary" : "ghost"} small`} disabled={disabled} onClick={() => onAct(kind, p)}>
      {label}
    </button>
  );
  const actions =
    p.state === "running"
      ? [button("disable", t("pages.plugins.action.disable")), button("remove", t("pages.plugins.action.remove"))]
      : p.state === "removed"
        ? canEnable
          ? [button("enable", t("pages.plugins.action.restore"), true)]
          : []
        : [
            ...(canEnable ? [button("enable", t("pages.plugins.action.enable"), true)] : []),
            ...(p.state === "skipped" ? [button("disable", t("pages.plugins.action.disable"))] : []),
            button("remove", t("pages.plugins.action.remove")),
          ];
  return (
    <div className={`plugin-row plugin-${p.state}`} data-plugin={p.name}>
      <div className="plugin-head">
        <span className="plugin-name">{p.title}</span>
        <span className={STATE_CHIP[p.state]}>{pluginStateText(p.state, p.missing)}</span>
      </div>
      {p.summary && <div className="plugin-summary">{p.summary}</div>}
      {/* 外部组件没装（315 号票）：那一句本身就写着没装什么、怎么装，不再套"没装上：" */}
      {p.problem !== undefined && <div className="field-error">{p.missing ? p.problem : t("pages.plugins.problem", { reason: p.problem })}</div>}
      {p.cannotEnable !== undefined && p.state !== "skipped" && <div className="field-error">{t("pages.plugins.cannotEnable", { reason: p.cannotEnable })}</div>}
      <ul className="plugin-brings">
        {pluginLines(p, all, web).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="plugin-actions">{working ? <span className="muted">{t("pages.plugins.working")}</span> : actions}</div>
    </div>
  );
}

export interface PluginConfirmProps {
  confirming: PluginConfirming;
  plugins: readonly PluginInfo[];
  busy: boolean;
  onPurgeChange(purge: boolean): void;
  onCancel(): void;
  onConfirm(): void;
}

/** 确认框：停用、启用（一起开的）、移除（带"连它的数据一起彻底删除"的勾选），勾了以后第二步写明删哪些、删不掉哪些 */
export function PluginConfirm({ confirming: c, plugins, busy, onPurgeChange, onCancel, onConfirm }: PluginConfirmProps) {
  const text = confirmText(c, plugins);
  const removal = c.plugin.removal;
  return (
    <Sheet title={text.title} onClose={onCancel} center>
      <div className="modal-body plugin-confirm">
        {text.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {c.kind === "remove" && removal && (
          <label className="check-row plugin-purge">
            <input type="checkbox" checked={c.purge} onChange={(e) => onPurgeChange(e.target.checked)} />
            <span>{t("pages.plugins.confirm.purgeBox")}</span>
          </label>
        )}
        {c.kind === "purge" && removal && (
          <>
            <p>{t("pages.plugins.confirm.deletes")}</p>
            <ul className="plain-list">
              {removal.deletes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>{t("pages.plugins.confirm.keeps")}</p>
            <ul className="plain-list">
              {removal.keeps.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="plugin-final">{t("pages.plugins.confirm.final")}</p>
          </>
        )}
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("pages.plugins.confirm.cancel")}
        </button>
        <button type="button" className={`btn ${text.danger ? "danger" : "primary"}`} disabled={busy} onClick={onConfirm}>
          {c.kind === "remove" && c.purge ? t("pages.plugins.confirm.next") : text.ok}
        </button>
      </div>
    </Sheet>
  );
}

export function PluginsPage() {
  const { http, ui } = useStore();
  const webPlugins = usePlugins();
  const revision = ui.locale?.revision;
  // 插件的状况变了（这台设备上或者别处停用、启用、移除的）：重取一次
  const statusKey = (ui.pluginStatus?.plugins ?? []).map((p) => `${p.name}:${p.state}`).join(",");
  const [plugins, setPlugins] = useState<PluginInfo[]>();
  const [loadFailed, setLoadFailed] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [note, setNote] = useState<string>();
  const [confirming, setConfirming] = useState<PluginConfirming>();
  const [removedOpen, setRemovedOpen] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps, react/exhaustive-effect-dependencies -- statusKey、revision 只用来在状况、语言变了时重取
  useEffect(() => {
    let cancelled = false;
    http.plugins().then(
      (view) => {
        if (cancelled) return;
        setPlugins(view.plugins);
        setLoadFailed(undefined);
      },
      (err: unknown) => {
        if (!cancelled) setLoadFailed(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [http, statusKey, revision]);

  const web = (name: string): readonly string[] => webPlugins.plugins.find((p) => p.name === name)?.brings ?? [];
  const all = plugins ?? [];

  const run = (action: PluginAction, plugin: PluginInfo, purgeData: boolean) => {
    setConfirming(undefined);
    setBusy(plugin.name);
    setFailed(undefined);
    setNote(undefined);
    http
      .pluginAction(plugin.name, { action, ...(purgeData ? { purgeData } : {}), idempotencyKey: newKey() })
      .then(
        (result) => {
          setPlugins(result.plugins);
          setNote(doneText(action, plugin, result, all));
        },
        (err: unknown) => setFailed(t("pages.plugins.failed", { reason: err instanceof Error ? err.message : String(err) })),
      )
      .finally(() => setBusy(undefined));
  };

  const onAct = (kind: "disable" | "enable" | "remove", plugin: PluginInfo) => {
    // 启用时没有要一起开的：直接启用；别的先确认
    if (kind === "enable" && plugin.startsWith.length === 0) return run("enable", plugin, false);
    setConfirming({ kind, plugin, purge: false });
  };

  const onConfirm = () => {
    if (!confirming) return;
    const { kind, plugin, purge } = confirming;
    // 勾了连数据删：再确认一次
    if (kind === "remove" && purge) return setConfirming({ kind: "purge", plugin, purge: true });
    run(kind === "purge" ? "remove" : kind, plugin, kind === "purge");
  };

  return (
    <div className="plugins-page">
      <Section title={t("pages.plugins.listTitle")}>
        <span className="muted">{t("pages.plugins.intro")}</span>
        {!plugins && !loadFailed && <div className="muted">{t("pages.plugins.loading")}</div>}
        {loadFailed && (
          <div className="field-error" role="alert">
            {t("pages.plugins.loadFailed", { reason: loadFailed })}
          </div>
        )}
        {plugins && <PluginList plugins={plugins} web={web} busy={busy} removedOpen={removedOpen} onToggleRemoved={() => setRemovedOpen((open) => !open)} onAct={onAct} />}
        {failed && (
          <div className="field-error" role="alert">
            {failed}
          </div>
        )}
        {note && (
          <div className="hint" role="status">
            {note}
          </div>
        )}
      </Section>
      {confirming && (
        <PluginConfirm
          confirming={confirming}
          plugins={all}
          busy={busy !== undefined}
          onPurgeChange={(purge) => setConfirming((c) => (c ? { ...c, purge } : c))}
          onCancel={() => setConfirming(undefined)}
          onConfirm={onConfirm}
        />
      )}
    </div>
  );
}
