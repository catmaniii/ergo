// 手机插件在设置 · 数据源里画的两块（299 号票，dataSources 插槽）和 App 开着时同步手机日历的后台部件（background 插槽）：
// - "手机 · 通讯录选人"下面：在鸿蒙 App 里是"从手机通讯录挑人"（系统的选人界面，不要通讯录权限），挑好交给守护进程，
//   回一句交给了档案候选的是谁、"去核对"（那张候选核对卡）；不在 App 里（电脑、手机浏览器、旧版 App）写明要到 App 里挑；
// - "手机 · 日历"下面：在 App 里没连着是"连上手机日历"（系统的授权框），连着是"现在同步"和手机上的授权怎么样；不在 App 里写明；
//   306 号票起连着但授权没给着时点"现在同步"也再要一次授权（拒过、撤回了的拉起系统的二次授权），还是没给写明；
// - 后台部件：只在 App 里（有读本机这一组方法）跑——开场、回到前台（距上次超过 5 分钟）、每 30 分钟同步一次（calendar-sync.ts），
//   没连着、插件没启用、导入关着都不做。
// 纯渲染的几块（ContactsPanelView、CalendarPanelView）测试在 Node 里直接渲染。
import { useEffect, useState } from "react";
import type { NativeCalendarState, NativePhone } from "../../app/native-phone.ts";
import { pageNativeApp } from "../../app/page-native.ts";
import { toHash } from "../../app/route.ts";
import { useStore } from "../../app/store.tsx";
import { type DataSourcesView, type DataSourceView, formatList, PHONE_CALENDAR_SYNC_EVERY_MS, PHONE_CONTACTS_SOURCE, type PhoneContactsReply, t } from "../../state/index.ts";
import { type PhoneCalendarSyncOutcome, syncPhoneCalendar } from "./calendar-sync.ts";

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
export function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 回到前台时距上次同步至少多久才再同步 */
export const RESUME_GAP_MS = 5 * 60_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 挑完交过去之后那一句：交给了档案候选的是谁（有卡的带"去核对"） */
export interface ContactsNote {
  text: string;
  cardId?: string;
  error?: boolean;
}

/** 挑人那一块（纯渲染）：不在 App 里写明；在 App 里一个按钮，下面是上一次的结果 */
export function ContactsPanelView({ inApp, busy, note, onPick }: { inApp: boolean; busy: boolean; note: ContactsNote | undefined; onPick(): void }) {
  if (!inApp) return <div className="muted">{t("ui.plugins.phone.contacts.notInApp")}</div>;
  return (
    <div className="phone-panel">
      <div className="plugin-actions">
        <button type="button" className="btn primary small" disabled={busy} onClick={onPick} data-phone="pick-contacts">
          {busy ? t("ui.plugins.phone.contacts.picking") : t("ui.plugins.phone.contacts.pick")}
        </button>
      </div>
      <div className="muted">{t("ui.plugins.phone.contacts.hint")}</div>
      {note && (
        <div className={note.error ? "field-error" : "hint"} role="status">
          {note.text}
          {note.cardId !== undefined && (
            <>
              {" "}
              <a className="link" href={toHash({ tab: "card", cardId: note.cardId })}>
                {t("ui.plugins.phone.contacts.review")}
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 挑人交过去之后说一句 */
export function contactsNote(reply: PhoneContactsReply | undefined, names: readonly string[]): ContactsNote {
  const who = formatList(reply?.names ?? names);
  return reply?.cardId === undefined ? { text: t("ui.plugins.phone.contacts.nothingNew", { names: who }) } : { text: t("ui.plugins.phone.contacts.sent", { names: who }), cardId: reply.cardId };
}

export function ContactsPanel({ onView }: { source: DataSourceView; onView(view: DataSourcesView): void }) {
  const { http } = useStore();
  const phone = pageNativeApp()?.phone;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ContactsNote>();
  const pick = () => {
    if (!phone) return;
    setBusy(true);
    setNote(undefined);
    void (async () => {
      try {
        const picked = await phone.pickContacts();
        if (!picked.ok) {
          if (picked.reason === "failed") setNote({ text: t("ui.plugins.phone.contacts.failed", { reason: picked.message ?? t("ui.plugins.phone.unknownReason") }), error: true });
          return;
        }
        const result = await http.dataSourcePush(PHONE_CONTACTS_SOURCE, { data: { ...(picked.device === undefined ? {} : { device: picked.device }), contacts: picked.contacts }, idempotencyKey: newKey() });
        onView(result.view);
        setNote(
          result.error !== undefined
            ? { text: t("ui.plugins.phone.contacts.failed", { reason: result.error }), error: true }
            : contactsNote(result.reply as PhoneContactsReply | undefined, picked.contacts.map((c) => c.name)),
        );
      } catch (err) {
        setNote({ text: t("ui.plugins.phone.contacts.failed", { reason: errorText(err) }), error: true });
      } finally {
        setBusy(false);
      }
    })();
  };
  return <ContactsPanelView inApp={phone !== undefined} busy={busy} note={note} onPick={pick} />;
}

/** 手机上读日历的授权那一句 */
export function calendarStateText(state: NativeCalendarState | undefined): string {
  if (!state) return t("ui.plugins.phone.calendar.stateUnknown");
  if (state.granted) return t("ui.plugins.phone.calendar.granted");
  return t(state.asked ? "ui.plugins.phone.calendar.denied" : "ui.plugins.phone.calendar.notAsked");
}

/** 同步一次之后说一句 */
export function calendarOutcomeText(outcome: PhoneCalendarSyncOutcome): { text: string; error?: boolean } {
  switch (outcome.kind) {
    case "skipped":
      return { text: t(`ui.plugins.phone.calendar.skipped.${outcome.why}`) };
    case "denied":
      return { text: t(outcome.again ? "ui.plugins.phone.calendar.deniedSync" : "ui.plugins.phone.calendar.deniedNow"), error: true };
    case "unreadable":
      return { text: t("ui.plugins.phone.calendar.unreadable", { reason: outcome.message ?? t("ui.plugins.phone.unknownReason") }), error: true };
    case "pushed":
      if (outcome.result.error !== undefined) return { text: t("ui.plugins.phone.calendar.failed", { reason: outcome.result.error }), error: true };
      return { text: outcome.result.summary ?? t("ui.plugins.phone.calendar.synced"), ...(outcome.state === "granted" ? {} : { error: true }) };
  }
}

/** 手机日历那一块（纯渲染）：不在 App 里写明；在 App 里没连着"连上"，连着"现在同步"，下面写手机上的授权和上一次的结果 */
export function CalendarPanelView({
  inApp,
  linked,
  state,
  busy,
  note,
  onLink,
  onSync,
}: {
  inApp: boolean;
  linked: boolean;
  state: NativeCalendarState | undefined;
  busy: boolean;
  note: { text: string; error?: boolean } | undefined;
  onLink(): void;
  onSync(): void;
}) {
  if (!inApp) return <div className="muted">{t("ui.plugins.phone.calendar.notInApp")}</div>;
  return (
    <div className="phone-panel">
      <div className="plugin-actions">
        {linked ? (
          <button type="button" className="btn primary small" disabled={busy} onClick={onSync} data-phone="sync-calendar">
            {busy ? t("ui.plugins.phone.calendar.syncing") : t("ui.plugins.phone.calendar.sync")}
          </button>
        ) : (
          <button type="button" className="btn primary small" disabled={busy} onClick={onLink} data-phone="link-calendar">
            {busy ? t("ui.plugins.phone.calendar.linking") : t("ui.plugins.phone.calendar.link")}
          </button>
        )}
      </div>
      <div className="muted">{t("ui.plugins.phone.calendar.onPhone", { state: calendarStateText(state) })}</div>
      <div className="muted">{t("ui.plugins.phone.calendar.hint")}</div>
      {note && (
        <div className={note.error ? "field-error" : "hint"} role="status">
          {note.text}
        </div>
      )}
    </div>
  );
}

export function CalendarPanel({ source, onView }: { source: DataSourceView; onView(view: DataSourcesView): void }) {
  const { http } = useStore();
  const phone = pageNativeApp()?.phone;
  const [state, setState] = useState(() => phone?.calendarState());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean }>();
  const run = (link: boolean) => {
    if (!phone) return;
    setBusy(true);
    setNote(undefined);
    void (async () => {
      try {
        // 点"现在同步"：授权没给着时再要一次（306 号票）
        const outcome = await syncPhoneCalendar({ phone, http, now: () => new Date(), newKey }, link ? { link } : { userAction: true });
        if (outcome.kind === "pushed") onView(outcome.result.view);
        setNote(calendarOutcomeText(outcome));
      } catch (err) {
        setNote({ text: t("ui.plugins.phone.calendar.failed", { reason: errorText(err) }), error: true });
      } finally {
        setState(phone.calendarState());
        setBusy(false);
      }
    })();
  };
  return <CalendarPanelView inApp={phone !== undefined} linked={source.connection !== "not_connected"} state={state} busy={busy} note={note} onLink={() => run(true)} onSync={() => run(false)} />;
}

/** 后台同步手机日历（只在 App 里有读本机这一组方法时跑）：开场、每 30 分钟、回到前台距上次超过 5 分钟 */
export function startCalendarSync(phone: NativePhone, deps: Omit<Parameters<typeof syncPhoneCalendar>[0], "phone">, scope: { addEventListener: Document["addEventListener"]; removeEventListener: Document["removeEventListener"]; visibilityState?: string }, log: (line: string) => void): () => void {
  let last = 0;
  let running = false;
  const once = () => {
    if (running) return;
    running = true;
    last = deps.now().getTime();
    syncPhoneCalendar({ phone, ...deps })
      .then((outcome) => {
        if (outcome.kind === "pushed") log(`phone calendar synced: ${outcome.state} ${outcome.result.summary ?? ""}`);
      })
      .catch((err: unknown) => log(`phone calendar sync failed: ${errorText(err)}`))
      .finally(() => {
        running = false;
      });
  };
  once();
  const timer = setInterval(once, PHONE_CALENDAR_SYNC_EVERY_MS);
  const onVisible = () => {
    if (scope.visibilityState === "visible" && deps.now().getTime() - last >= RESUME_GAP_MS) once();
  };
  scope.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(timer);
    scope.removeEventListener("visibilitychange", onVisible);
  };
}

/** 后台部件：在 App 里才跑 */
export function PhoneCalendarSync() {
  const { http } = useStore();
  useEffect(() => {
    const app = pageNativeApp();
    if (!app?.phone) return;
    return startCalendarSync(app.phone, { http, now: () => new Date(), newKey }, document, (line) => app.log(line));
  }, [http]);
  return null;
}
