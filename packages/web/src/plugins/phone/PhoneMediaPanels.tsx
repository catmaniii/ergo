// 手机插件在设置 · 数据源里画的照片、位置两块（300 号票，dataSources 插槽）和 App 开着时同步它们的后台部件（background 插槽）：
// - "手机 · 照片的时间地点"下面：在鸿蒙 App 里没连着是"连上相册"（系统的授权框：读相册、读照片位置），连着是"现在同步"和手机上的
//   授权怎么样；不在 App 里（电脑、手机浏览器、旧版 App）写明要到 App 里连；
// - "手机 · 位置"下面：在 App 里没连着是"开始记位置"（系统的授权框：定位），连着是"现在同步"、"App 在后台也记"的开关、手机上的
//   授权和在不在记；不在 App 里写明；
// - 两块都写明耗电和隐私（数据源页上写明，用户 2026-10-25 的票要的）：在不在 App 里都写；
// - 后台部件：只在 App 里（有这两组方法）跑——开场、回到前台（距上次超过 5 分钟）、每 30 分钟各同步一次（media-sync.ts）；
// - 308 号票："手机 · 位置"那一块后面接"常去的地方"（PhonePlaces.tsx）。
// 纯渲染的几块（PhotosPanelView、LocationPanelView）测试在 Node 里直接渲染。
import { useEffect, useState } from "react";
import type { NativeLocationState, NativePhone, NativePhoneLocation, NativePhotosState } from "../../app/native-phone.ts";
import { pageNativeApp } from "../../app/page-native.ts";
import { useStore } from "../../app/store.tsx";
import { type DataSourcesView, type DataSourceView, PHONE_CALENDAR_SYNC_EVERY_MS, t } from "../../state/index.ts";
import { type PhoneMediaSyncDeps, type PhoneMediaSyncOutcome, syncPhoneLocation, syncPhonePhotos } from "./media-sync.ts";
import { newKey, RESUME_GAP_MS } from "./PhonePanels.tsx";
import { PlacesBlock } from "./PhonePlaces.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 一块下面那一句（上一次的结果） */
export interface MediaNote {
  text: string;
  error?: boolean;
}

/** 同步一次之后说一句（照片、位置共用，which 是 photos / location） */
export function mediaOutcomeText(which: "photos" | "location", outcome: PhoneMediaSyncOutcome): MediaNote {
  switch (outcome.kind) {
    case "skipped":
      return { text: t(`ui.plugins.phone.${which}.skipped.${outcome.why}`) };
    case "denied":
      return { text: t(`ui.plugins.phone.${which}.deniedNow`), error: true };
    case "unreadable":
      return { text: t(`ui.plugins.phone.${which}.unreadable`, { reason: outcome.message ?? t("ui.plugins.phone.unknownReason") }), error: true };
    case "pushed":
      if (outcome.result.error !== undefined) return { text: t("ui.plugins.phone.calendar.failed", { reason: outcome.result.error }), error: true };
      return { text: outcome.result.summary ?? t("ui.plugins.phone.calendar.synced"), ...(outcome.state === "granted" ? {} : { error: true }) };
  }
}

/** 手机上读相册的授权那一句 */
export function photosStateText(state: NativePhotosState | undefined): string {
  if (!state) return t("ui.plugins.phone.calendar.stateUnknown");
  if (!state.granted) return t(state.asked ? "ui.plugins.phone.photos.denied" : "ui.plugins.phone.calendar.notAsked");
  return t(state.location ? "ui.plugins.phone.photos.granted" : "ui.plugins.phone.photos.grantedNoLocation");
}

/** 手机上定位的授权、在不在记那一句 */
export function locationStateText(state: NativeLocationState | undefined): string {
  if (!state) return t("ui.plugins.phone.calendar.stateUnknown");
  if (!state.granted) return t(state.asked ? "ui.plugins.phone.location.denied" : "ui.plugins.phone.calendar.notAsked");
  const permission = t(state.precise ? "ui.plugins.phone.location.grantedPrecise" : "ui.plugins.phone.location.grantedApprox");
  const recording = !state.recording
    ? t("ui.plugins.phone.location.notRecording")
    : state.switchOff
      ? t("ui.plugins.phone.location.switchOff")
      : t(state.background ? "ui.plugins.phone.location.recordingBackground" : "ui.plugins.phone.location.recordingForeground");
  return t("ui.plugins.phone.location.stateLine", { permission, recording });
}

/** 耗电、隐私两句（在不在 App 里都写） */
function Notes({ which }: { which: "photos" | "location" }) {
  return (
    <ul className="source-notes phone-notes">
      <li>{t(`ui.plugins.phone.${which}.power`)}</li>
      <li>{t(`ui.plugins.phone.${which}.privacy`)}</li>
    </ul>
  );
}

function NoteLine({ note }: { note: MediaNote | undefined }) {
  if (!note) return null;
  return (
    <div className={note.error ? "field-error" : "hint"} role="status">
      {note.text}
    </div>
  );
}

export interface PhotosPanelViewProps {
  inApp: boolean;
  linked: boolean;
  state: NativePhotosState | undefined;
  busy: boolean;
  note: MediaNote | undefined;
  onLink(): void;
  onSync(): void;
}

/** 照片那一块（纯渲染）：不在 App 里写明；在 App 里没连着"连上相册"、连着"现在同步"，写手机上的授权；下面耗电、隐私 */
export function PhotosPanelView({ inApp, linked, state, busy, note, onLink, onSync }: PhotosPanelViewProps) {
  return (
    <div className="phone-panel">
      {inApp ? (
        <>
          <div className="plugin-actions">
            {linked ? (
              <button type="button" className="btn primary small" disabled={busy} onClick={onSync} data-phone="sync-photos">
                {busy ? t("ui.plugins.phone.calendar.syncing") : t("ui.plugins.phone.calendar.sync")}
              </button>
            ) : (
              <button type="button" className="btn primary small" disabled={busy} onClick={onLink} data-phone="link-photos">
                {busy ? t("ui.plugins.phone.calendar.linking") : t("ui.plugins.phone.photos.link")}
              </button>
            )}
          </div>
          <div className="muted">{t("ui.plugins.phone.calendar.onPhone", { state: photosStateText(state) })}</div>
        </>
      ) : (
        <div className="muted">{t("ui.plugins.phone.photos.notInApp")}</div>
      )}
      <Notes which="photos" />
      <NoteLine note={note} />
    </div>
  );
}

export interface LocationPanelViewProps {
  inApp: boolean;
  linked: boolean;
  state: NativeLocationState | undefined;
  busy: boolean;
  note: MediaNote | undefined;
  onLink(): void;
  onSync(): void;
  onBackground(on: boolean): void;
}

/** 位置那一块（纯渲染）：不在 App 里写明；在 App 里没连着"开始记位置"，连着"现在同步"和"后台也记"的开关，写手机上的授权和在不在记 */
export function LocationPanelView({ inApp, linked, state, busy, note, onLink, onSync, onBackground }: LocationPanelViewProps) {
  return (
    <div className="phone-panel">
      {inApp ? (
        <>
          <div className="plugin-actions">
            {linked ? (
              <button type="button" className="btn primary small" disabled={busy} onClick={onSync} data-phone="sync-location">
                {busy ? t("ui.plugins.phone.calendar.syncing") : t("ui.plugins.phone.calendar.sync")}
              </button>
            ) : (
              <button type="button" className="btn primary small" disabled={busy} onClick={onLink} data-phone="link-location">
                {busy ? t("ui.plugins.phone.calendar.linking") : t("ui.plugins.phone.location.link")}
              </button>
            )}
          </div>
          {linked && (
            <label className="menu-item source-usage" data-phone="location-background">
              <span className="menu-text">
                {t("ui.plugins.phone.location.background")}
                <small>{t("ui.plugins.phone.location.backgroundSub")}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="mem-setting-switch"
                aria-label={t("ui.plugins.phone.location.background")}
                checked={state?.background === true}
                disabled={busy || state?.granted !== true}
                onChange={(e) => onBackground(e.currentTarget.checked)}
              />
            </label>
          )}
          <div className="muted">{t("ui.plugins.phone.calendar.onPhone", { state: locationStateText(state) })}</div>
        </>
      ) : (
        <div className="muted">{t("ui.plugins.phone.location.notInApp")}</div>
      )}
      <Notes which="location" />
      <NoteLine note={note} />
    </div>
  );
}

export function PhotosPanel({ source, onView }: { source: DataSourceView; onView(view: DataSourcesView): void }) {
  const { http } = useStore();
  const photos = pageNativeApp()?.phone?.photos;
  const [state, setState] = useState(() => photos?.state());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<MediaNote>();
  const run = (link: boolean) => {
    if (!photos) return;
    setBusy(true);
    setNote(undefined);
    void (async () => {
      try {
        const outcome = await syncPhonePhotos({ photos, http, now: () => new Date(), newKey }, { link });
        if (outcome.kind === "pushed") onView(outcome.result.view);
        setNote(mediaOutcomeText("photos", outcome));
      } catch (err) {
        setNote({ text: t("ui.plugins.phone.calendar.failed", { reason: errorText(err) }), error: true });
      } finally {
        setState(photos.state());
        setBusy(false);
      }
    })();
  };
  return <PhotosPanelView inApp={photos !== undefined} linked={source.connection !== "not_connected"} state={state} busy={busy} note={note} onLink={() => run(true)} onSync={() => run(false)} />;
}

/**
 * "手机 · 位置"断开了（就在这一页点的"断开"，或者别处断开的）而 App 还在记：马上让它停下（手机上没交出去的点一起删、
 * 后台也记的通知跟着没了），不等下一次同步（304 号票在模拟器上看到断开以后那一行还写"正在记"）；交回之后的状态
 */
export async function stopIfDisconnected(location: NativePhoneLocation, connection: DataSourceView["connection"]): Promise<NativeLocationState | undefined> {
  const state = location.state();
  if (connection !== "not_connected" || state?.recording !== true) return state;
  return (await location.record(false, false)) ?? location.state();
}

export function LocationPanel({ source, onView }: { source: DataSourceView; onView(view: DataSourcesView): void }) {
  const { http } = useStore();
  const location = pageNativeApp()?.phone?.location;
  const [state, setState] = useState(() => location?.state());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<MediaNote>();
  const connection = source.connection;
  useEffect(() => {
    if (!location) return;
    let alive = true;
    void stopIfDisconnected(location, connection).then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [location, connection]);
  const run = (options: { link?: boolean; background?: boolean }) => {
    if (!location) return;
    setBusy(true);
    setNote(undefined);
    void (async () => {
      try {
        const outcome = await syncPhoneLocation({ location, http, now: () => new Date(), newKey }, options);
        if (outcome.kind === "pushed") onView(outcome.result.view);
        setNote(mediaOutcomeText("location", outcome));
      } catch (err) {
        setNote({ text: t("ui.plugins.phone.calendar.failed", { reason: errorText(err) }), error: true });
      } finally {
        setState(location.state());
        setBusy(false);
      }
    })();
  };
  return (
    <>
      <LocationPanelView
        inApp={location !== undefined}
        linked={source.connection !== "not_connected"}
        state={state}
        busy={busy}
        note={note}
        onLink={() => run({ link: true, background: false })}
        onSync={() => run({})}
        onBackground={(on) => run({ background: on })}
      />
      <PlacesBlock source={source} onView={onView} geocoderOff={state?.geocoder === false} />
    </>
  );
}

/** 后台同步照片、位置（只在 App 里有这两组方法时跑）：开场、每 30 分钟、回到前台距上次超过 5 分钟；先位置后照片 */
export function startMediaSync(phone: NativePhone, deps: PhoneMediaSyncDeps, scope: { addEventListener: Document["addEventListener"]; removeEventListener: Document["removeEventListener"]; visibilityState?: string }, log: (line: string) => void): () => void {
  const { photos, location } = phone;
  let last = 0;
  let running = false;
  const once = () => {
    if (running) return;
    running = true;
    last = deps.now().getTime();
    void (async () => {
      for (const [name, step] of [
        ["location", location ? () => syncPhoneLocation({ location, ...deps }) : undefined],
        ["photos", photos ? () => syncPhonePhotos({ photos, ...deps }) : undefined],
      ] as const) {
        if (!step) continue;
        try {
          const outcome = await step();
          if (outcome.kind === "pushed") log(`phone ${name} synced: ${outcome.state} ${outcome.result.summary ?? ""}`);
        } catch (err) {
          log(`phone ${name} sync failed: ${errorText(err)}`);
        }
      }
      running = false;
    })();
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

/** 后台部件：在 App 里、有照片或位置这一组时才跑 */
export function PhoneMediaSync() {
  const { http } = useStore();
  useEffect(() => {
    const app = pageNativeApp();
    if (!app?.phone || (!app.phone.photos && !app.phone.location)) return;
    return startMediaSync(app.phone, { http, now: () => new Date(), newKey }, document, (line) => app.log(line));
  }, [http]);
  return null;
}
