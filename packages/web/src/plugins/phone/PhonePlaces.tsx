// "手机 · 位置"下面的"常去的地方"（308 号票，用户 2026-10-26 选了"系统转地名 + 常去地起名"），跟在位置那一块后面（同一个 dataSources 插槽）。
// 数据是守护进程报在数据源上的 panel（协议包 phone.ts 的 PhonePlacesView），起名、改名、删、手动加一处经填设置（values.places）交给守护进程：
// - 起了名的几处：名字、地名（没有的写经纬度）、范围、最近待过几次；改名（名字、范围）、删（点两下）；
// - 最近常待的、还没起名的几处（守护进程按位置点聚的，待过两次以上）：地名、次数，"起名"；
// - 加一处：名字、在哪——在鸿蒙 App 里"用现在的位置"（定一次位、手机转好地名）或"按地名找"（系统的地址转坐标）；不在 App 里填经纬度；范围；
// - 起名、改名只影响往后的摘要（写明）；手机转不了地名时写一句（App 报的）。
// 组件本身是纯渲染（PlacesBlockView 不碰 HTTP、原生桥，测试在 Node 里直接渲染）；PlacesBlock 接上 HTTP 和原生桥。
import { type FormEvent, useState } from "react";
import type { NativePhonePlaces, NativePlaceFix } from "../../app/native-phone.ts";
import { pageNativeApp } from "../../app/page-native.ts";
import { useStore } from "../../app/store.tsx";
import {
  type DataSourcesView,
  type DataSourceView,
  isPhonePlacesView,
  PHONE_PLACE_NAME_MAX,
  PHONE_PLACE_RADII_M,
  PHONE_PLACE_RADIUS_DEFAULT_M,
  phoneAddressLabel,
  type PhonePlacesView,
  t,
} from "../../state/index.ts";
import { newKey } from "./PhonePanels.tsx";

/** 一处的位置：经纬度、系统地名（有的才有） */
export interface PlaceWhere {
  lat: number;
  lon: number;
  address?: string;
}

/** 正在填的表单：给聚出来的一处起名（suggestion）、改名（rename）、加一处（add） */
export type PlaceForm =
  | { mode: "suggestion"; key: string; where: PlaceWhere; name: string; radius: number }
  | { mode: "rename"; id: string; name: string; radius: number }
  | { mode: "add"; name: string; radius: number; where?: PlaceWhere; query: string; coords: string };

/** 一句结果：做成了、没做成 */
export interface PlaceNote {
  ok: boolean;
  text: string;
}

/** 经纬度给人看的写法："30.2800, 120.1000" */
export const coordsText = (w: { lat: number; lon: number }) => `${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}`;

/** 填的经纬度："30.27, 120.15"（逗号、中文逗号、空格隔开都行，纬度在前）；不对是 undefined */
export function parseCoords(text: string): { lat: number; lon: number } | undefined {
  // @i18n-ignore-next data：认用户填的中文逗号、分号
  const parts = text.trim().split(/[\s,，;；]+/).filter((p) => p !== "");
  if (parts.length !== 2) return undefined;
  const [lat, lon] = parts.map(Number) as [number, number];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return undefined;
  return { lat, lon };
}

/** 定位一次、按地名找的结果 → 表单里的"在哪"，或者没成的那一句 */
export function fixOutcome(fix: NativePlaceFix, kind: "here" | "find"): { where: PlaceWhere } | { note: PlaceNote } {
  if (fix.ok) {
    const address = phoneAddressLabel(fix.address);
    return { where: { lat: fix.lat, lon: fix.lon, ...(address === undefined ? {} : { address }) } };
  }
  if (fix.reason === "denied") return { note: { ok: false, text: t("ui.plugins.phone.places.err.hereDenied") } };
  if (fix.reason === "not_found") return { note: { ok: false, text: t("ui.plugins.phone.places.err.notFound") } };
  const reason = fix.message ?? t("ui.plugins.phone.unknownReason");
  return { note: { ok: false, text: t(kind === "here" ? "ui.plugins.phone.places.err.hereFailed" : "ui.plugins.phone.places.err.findFailed", { reason }) } };
}

/** 表单交给守护进程的值；还缺东西时交回没成的那一句 */
export function formValues(form: PlaceForm): { values: Record<string, string> } | { note: PlaceNote } {
  const name = form.name.replace(/\s+/g, " ").trim();
  if (name === "") return { note: { ok: false, text: t("ui.plugins.phone.places.err.noName") } };
  if ([...name].length > PHONE_PLACE_NAME_MAX) return { note: { ok: false, text: t("ui.plugins.phone.places.err.tooLong", { max: PHONE_PLACE_NAME_MAX }) } };
  const radius = String(form.radius);
  if (form.mode === "rename") return { values: { places: "rename", id: form.id, name, radius } };
  let where: PlaceWhere | undefined = form.where;
  if (form.mode === "add" && where === undefined && form.coords.trim() !== "") {
    const typed = parseCoords(form.coords);
    if (!typed) return { note: { ok: false, text: t("ui.plugins.phone.places.err.badCoords") } };
    where = typed;
  }
  if (!where) return { note: { ok: false, text: t("ui.plugins.phone.places.err.noWhere") } };
  return { values: { places: "add", name, lat: String(where.lat), lon: String(where.lon), radius, ...(where.address === undefined ? {} : { address: where.address }) } };
}

export interface PlacesBlockViewProps {
  view: PhonePlacesView;
  /** 在鸿蒙 App 里、有常去的地方这一组原生方法（能用现在的位置、按地名找） */
  inApp: boolean;
  /** App 报了系统转不了地名 */
  geocoderOff: boolean;
  busy: boolean;
  form: PlaceForm | undefined;
  /** 点了一下"删"、等第二下的那一处 */
  removing: string | undefined;
  note: PlaceNote | undefined;
  onForm(form: PlaceForm | undefined): void;
  onSave(): void;
  onRemove(id: string): void;
  onHere(): void;
  onFind(): void;
}

/** 名字、范围两样（起名、改名、加一处共用） */
function NameFields({ form, busy, onForm }: { form: PlaceForm; busy: boolean; onForm(form: PlaceForm): void }) {
  return (
    <div className="phone-place-fields">
      <label className="field">
        <span>{t("ui.plugins.phone.places.form.name")}</span>
        <input
          className="input"
          value={form.name}
          maxLength={PHONE_PLACE_NAME_MAX}
          placeholder={t("ui.plugins.phone.places.form.namePlaceholder")}
          disabled={busy}
          onChange={(e) => onForm({ ...form, name: e.currentTarget.value })}
          data-phone="place-name"
        />
      </label>
      <label className="field">
        <span>{t("ui.plugins.phone.places.form.radius")}</span>
        <select className="input" value={form.radius} disabled={busy} onChange={(e) => onForm({ ...form, radius: Number(e.currentTarget.value) })} data-phone="place-radius">
          {PHONE_PLACE_RADII_M.map((m) => (
            <option key={m} value={m}>
              {t("ui.plugins.phone.places.form.radiusOption", { m })}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** 保存、取消 */
function FormActions({ busy, onCancel }: { busy: boolean; onCancel(): void }) {
  return (
    <div className="plugin-actions">
      <button type="submit" className="btn primary small" disabled={busy} data-phone="place-save">
        {busy ? t("ui.plugins.phone.places.form.saving") : t("ui.plugins.phone.places.form.save")}
      </button>
      <button type="button" className="btn ghost small" disabled={busy} onClick={onCancel}>
        {t("ui.plugins.phone.places.form.cancel")}
      </button>
    </div>
  );
}

/** 纯渲染："常去的地方"那一块 */
export function PlacesBlockView({ view, inApp, geocoderOff, busy, form, removing, note, onForm, onSave, onRemove, onHere, onFind }: PlacesBlockViewProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave();
  };
  const close = () => onForm(undefined);
  const renameForm = form?.mode === "rename" ? form : undefined;
  const suggestionForm = form?.mode === "suggestion" ? form : undefined;
  const addForm = form?.mode === "add" ? form : undefined;
  return (
    <div className="phone-places" data-phone="places">
      <div className="looki-subtitle">{t("ui.plugins.phone.places.title")}</div>
      <div className="phone-places-intro">{t("ui.plugins.phone.places.intro")}</div>
      {inApp && geocoderOff && <div className="hint">{t("ui.plugins.phone.places.geocoderOff")}</div>}
      {view.places.length > 0 && (
        <ul className="gcal-feeds">
          {view.places.map((p) => (
            <li key={p.id} className="phone-place" data-place={p.id}>
              <div className="gcal-feed">
                <span className="gcal-feed-main">
                  <b>{p.name}</b>
                  <span className="muted">{t("ui.plugins.phone.places.placeMeta", { where: p.address ?? coordsText(p), radius: p.radius, visits: p.visits })}</span>
                </span>
                <button type="button" className="btn ghost small" disabled={busy} onClick={() => onForm({ mode: "rename", id: p.id, name: p.name, radius: p.radius })} data-phone="place-rename">
                  {t("ui.plugins.phone.places.rename")}
                </button>
                <button type="button" className={removing === p.id ? "btn danger small" : "btn ghost small"} disabled={busy} onClick={() => onRemove(p.id)} data-phone="place-remove">
                  {removing === p.id ? t("ui.plugins.phone.places.removeConfirm") : t("ui.plugins.phone.places.remove")}
                </button>
              </div>
              {renameForm?.id === p.id && (
                <form className="phone-place-form" onSubmit={submit}>
                  <NameFields form={renameForm} busy={busy} onForm={onForm} />
                  <FormActions busy={busy} onCancel={close} />
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="looki-subtitle">{t("ui.plugins.phone.places.suggestionsTitle")}</div>
      {view.suggestions.length > 0 ? (
        <ul className="gcal-feeds">
          {view.suggestions.map((s) => (
            <li key={s.key} className="phone-place" data-suggestion={s.key}>
              <div className="gcal-feed">
                <span className="gcal-feed-main">
                  <span>{s.label}</span>
                  <span className="muted">{t("ui.plugins.phone.places.suggestionMeta", { visits: s.visits, days: s.days })}</span>
                </span>
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={busy}
                  onClick={() => onForm({ mode: "suggestion", key: s.key, where: { lat: s.lat, lon: s.lon, ...(s.address === undefined ? {} : { address: s.address }) }, name: "", radius: PHONE_PLACE_RADIUS_DEFAULT_M })}
                  data-phone="place-name-it"
                >
                  {t("ui.plugins.phone.places.nameIt")}
                </button>
              </div>
              {suggestionForm?.key === s.key && (
                <form className="phone-place-form" onSubmit={submit}>
                  <NameFields form={suggestionForm} busy={busy} onForm={onForm} />
                  <FormActions busy={busy} onCancel={close} />
                </form>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted phone-places-empty">{view.days === 0 ? t("ui.plugins.phone.places.noPoints") : t("ui.plugins.phone.places.noSuggestions", { days: view.days })}</div>
      )}
      {addForm ? (
        <form className="phone-place-form" onSubmit={submit} data-phone="place-add-form">
          <div className="looki-subtitle">{t("ui.plugins.phone.places.addTitle")}</div>
          <NameFields form={addForm} busy={busy} onForm={onForm} />
          <div className="field">
            <span>{t("ui.plugins.phone.places.form.where")}</span>
            {addForm.where ? (
              <div className="phone-place-found">
                <span>{t("ui.plugins.phone.places.form.found", { where: addForm.where.address ?? coordsText(addForm.where) })}</span>
                <button type="button" className="btn ghost small" disabled={busy} onClick={() => onForm({ mode: "add", name: addForm.name, radius: addForm.radius, query: addForm.query, coords: addForm.coords })}>
                  {t("ui.plugins.phone.places.form.change")}
                </button>
              </div>
            ) : inApp ? (
              <>
                <div className="plugin-actions">
                  <button type="button" className="btn ghost small" disabled={busy} onClick={onHere} data-phone="place-here">
                    {t("ui.plugins.phone.places.form.here")}
                  </button>
                </div>
                <div className="phone-place-find">
                  <input className="input" value={addForm.query} placeholder={t("ui.plugins.phone.places.form.findPlaceholder")} disabled={busy} onChange={(e) => onForm({ ...addForm, query: e.currentTarget.value })} data-phone="place-query" />
                  <button type="button" className="btn ghost small" disabled={busy || addForm.query.trim() === ""} onClick={onFind} data-phone="place-find">
                    {t("ui.plugins.phone.places.form.find")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <input className="input" value={addForm.coords} placeholder={t("ui.plugins.phone.places.form.coordsPlaceholder")} disabled={busy} onChange={(e) => onForm({ ...addForm, coords: e.currentTarget.value })} data-phone="place-coords" />
                <small className="muted">{t("ui.plugins.phone.places.form.coordsHint")}</small>
              </>
            )}
          </div>
          <FormActions busy={busy} onCancel={close} />
        </form>
      ) : (
        <div className="plugin-actions">
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => onForm({ mode: "add", name: "", radius: PHONE_PLACE_RADIUS_DEFAULT_M, query: "", coords: "" })} data-phone="place-add">
            {t("ui.plugins.phone.places.add")}
          </button>
        </div>
      )}
      {note && (
        <div className={note.ok ? "hint" : "field-error"} role="status">
          {note.text}
        </div>
      )}
    </div>
  );
}

/** 交过去以后那一句：守护进程说没做成的写原因，做成了写一句 */
function afterSave(view: DataSourcesView, id: string, done: string): PlaceNote {
  const mine = view.sources.find((s) => s.id === id);
  const panel = mine && isPhonePlacesView(mine.panel) ? mine.panel : undefined;
  return panel?.refused === undefined ? { ok: true, text: done } : { ok: false, text: panel.refused };
}

/** 接上 HTTP、原生桥的那一块（跟在位置那一块后面） */
export function PlacesBlock({ source, onView, geocoderOff }: { source: DataSourceView; onView(view: DataSourcesView): void; geocoderOff: boolean }) {
  const { http } = useStore();
  const native: NativePhonePlaces | undefined = pageNativeApp()?.phone?.places;
  const [form, setForm] = useState<PlaceForm>();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [note, setNote] = useState<PlaceNote>();
  if (!isPhonePlacesView(source.panel)) return null;
  const view = source.panel;

  const send = (values: Record<string, string>, done: string) => {
    setBusy(true);
    setNote(undefined);
    http
      .dataSourceAction(source.id, { action: "configure", values, idempotencyKey: newKey() })
      .then(
        (res) => {
          onView(res.view);
          const outcome = afterSave(res.view, source.id, done);
          setNote(outcome);
          if (outcome.ok) setForm(undefined);
        },
        (err: unknown) => setNote({ ok: false, text: t("ui.plugins.phone.places.err.failed", { reason: err instanceof Error ? err.message : String(err) }) }),
      )
      .finally(() => {
        setBusy(false);
        setRemoving(undefined);
      });
  };

  const locate = (kind: "here" | "find") => {
    if (!native || form?.mode !== "add") return;
    const current = form;
    setBusy(true);
    setNote(undefined);
    void (kind === "here" ? native.here() : native.find(current.query.trim()))
      .then((fix) => {
        const outcome = fixOutcome(fix, kind);
        if ("where" in outcome) setForm({ ...current, where: outcome.where });
        else setNote(outcome.note);
      })
      .finally(() => setBusy(false));
  };

  return (
    <PlacesBlockView
      view={view}
      inApp={native !== undefined}
      geocoderOff={geocoderOff}
      busy={busy}
      form={form}
      removing={removing}
      note={note}
      onForm={(next) => {
        setForm(next);
        setNote(undefined);
        setRemoving(undefined);
      }}
      onSave={() => {
        if (!form) return;
        const outcome = formValues(form);
        if ("note" in outcome) return setNote(outcome.note);
        send(outcome.values, t(form.mode === "rename" ? "ui.plugins.phone.places.renamed" : "ui.plugins.phone.places.added"));
      }}
      onRemove={(id) => {
        // 点两下才删：第一下变成"确定删？"
        if (removing !== id) {
          setRemoving(id);
          setNote(undefined);
          return;
        }
        send({ places: "remove", id }, t("ui.plugins.phone.places.removed"));
      }}
      onHere={() => locate("here")}
      onFind={() => locate("find")}
    />
  );
}
