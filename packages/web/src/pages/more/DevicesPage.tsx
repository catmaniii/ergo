// 设置 · 已配对设备：从外网用二狗的设备，可以随时延期、吊销、删除（吊销、删除后它开着的页面立刻被断开，回到配对页）。
// PC 本机直接用，不需要配对。列表来自前端状态层（已配对设备频道上的 device 事件）。
// 领到凭证、还没带着它来过的设备标"等待首次使用"（领取的响应可能丢了），到期还没用过就自动作废。
// 时长、位数都取共享协议包里的常量。
// 123 号票：多选管理，照待办的多选（90 号票）——
// - 标题栏"多选"、行的长按 / 右键菜单和行尾"⋯"是同一个菜单（延期…、吊销、删除、多选），贴着按的地方弹出；
// - 多选时点一行就是勾选，"已配对""已失效"两组都能勾，每组标题右边"全选 / 取消全选"；底部操作栏"已选 N 台 · 延期 · 吊销 · 删除 · 完成"，
//   按钮上写能对几台做，一台都不能做时灰掉；鸿蒙返回键先退出多选；
// - 延期先选时长（30 天、90 天、1 年，默认 1 年），吊销、删除先确认；选中里有"就是这台"时确认弹窗单独提示，做完走现有的
//   "本设备已被吊销"那一页。个数、跳过、确认的话都在 state/device-select.ts；跳过了几台、为什么在页面底部说一声。
// 157 号票：多选模式和看板、待办同一套（ui/select-mode.tsx）——标题栏的"多选"换成"退出多选"，操作栏右边"完成"换成"✕ 退出多选"，Esc 也能退出。
// 这一页自己排一栏（MorePage 不再替它包滚动区）：标题栏、滚动区、多选时的底部操作栏（和待办一样贴在一栏的底边）。
import { useRef, useState } from "react";
import { useAccess } from "../../app/access.tsx";
import { useStore } from "../../app/store.tsx";
import {
  DEFAULT_DEVICE_EXTEND_DAYS,
  DEVICE_ACTION_LABEL,
  DEVICE_BATCH_ACTIONS,
  DEVICE_CREDENTIAL_TTL_MS,
  DEVICE_EXTEND_CHOICES,
  DEVICE_FIRST_USE_WINDOW_MS,
  deviceSelfLine,
  type DeviceBatchAction,
  deviceActPrompt,
  deviceBatchCounts,
  deviceBatchSkip,
  deviceBatchTargets,
  deviceBatchToast,
  durationText,
  groupSelection,
  type InactiveReason,
  PAIRING_FINGERPRINT_HEX_DIGITS,
  PAIRING_REQUEST_TTL_MS,
  PAIRING_SHORT_CODE_DIGITS,
  type PairedDevice,
  pairedDevices,
  t,
  toggleSelected,
} from "../../state/index.ts";
import { Section, Segmented, Sheet, TopBar, useNow } from "../../ui/common.tsx";
import { useLongPress } from "../../ui/long-press.ts";
import { PopupMenu } from "../../ui/popup.tsx";
import { SelectExit, SelectToggle, useSelectingBack } from "../../ui/select-mode.tsx";
import { useToast } from "../../ui/toast.tsx";
import { timeLabel } from "../../util/time.ts";

const dateLabel = (iso: string) => iso.slice(0, 10);

/** 配对、最近使用、吊销的时间：今年的写月日时分，往年的写年月日（过期的设备最近一次使用总在一年多以前，不写年会看成今年） */
const whenLabel = (iso: string, now: number) => (iso.slice(0, 4) === String(new Date(now).getFullYear()) ? timeLabel(iso) : dateLabel(iso));

const DAY_MS = 24 * 3600_000;

/** 凭证还剩这么多天以内的，行上标"还有 N 天到期"（提醒延期） */
const SOON_DAYS = 30;

/** 有效的设备那一行的说明：等待首次使用的，和用过的；延期过的写上 */
function activeNote(d: PairedDevice, now: number): string {
  if (!d.activated) {
    if (d.extendedAt === undefined) return t("pages.devices.awaitingFirstUse", { duration: durationText(DEVICE_FIRST_USE_WINDOW_MS) });
    return t("pages.devices.awaitingFirstUseExtended", { date: dateLabel(d.expiresAt) });
  }
  return t(d.extendedAt === undefined ? "pages.devices.lastUsed" : "pages.devices.lastUsedExtended", { time: whenLabel(d.lastUsedAt, now), date: dateLabel(d.expiresAt) });
}

/** 失效的设备那一行的说明 */
function inactiveNote(d: PairedDevice, reason: InactiveReason, now: number): string {
  switch (reason) {
    case "revoked":
      return t("pages.devices.revokedAt", { time: whenLabel(d.revokedAt ?? d.lastUsedAt, now) });
    case "expired":
      if (d.extendedAt !== undefined) return t("pages.devices.expiredExtended", { date: dateLabel(d.expiresAt), time: whenLabel(d.lastUsedAt, now) });
      return t("pages.devices.expired", { duration: durationText(DEVICE_CREDENTIAL_TTL_MS), time: whenLabel(d.lastUsedAt, now) });
    case "never_used":
      if (d.extendedAt !== undefined) return t("pages.devices.neverUsedExtended", { date: dateLabel(d.expiresAt) });
      return t("pages.devices.neverUsed", { duration: durationText(DEVICE_FIRST_USE_WINDOW_MS) });
  }
}

/** 一台设备那一行要显示的 */
interface DeviceEntry {
  device: PairedDevice;
  note: string;
  /** 已失效的（淡掉、名字划线） */
  inactive: boolean;
  /** 配对于（有效的那一组写） */
  paired: string;
  /** 快到期：还剩几天 */
  soon?: number | undefined;
}

export function DevicesPage({ title, onBack, onPreviewPairing }: { title: string; onBack?: (() => void) | undefined; onPreviewPairing(): void }) {
  const { ui, deviceBatchAction } = useStore();
  const access = useAccess();
  const toast = useToast();
  const now = useNow(60_000);
  const { active, inactive } = pairedDevices(ui, now);
  const self = access?.access === "device" ? access.device.id : undefined;
  // 多选：勾上了哪几台
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  // 要确认的（延期是选时长）：做什么、对哪几台（单台的菜单就是那一台）
  const [asking, setAsking] = useState<{ action: DeviceBatchAction; devices: PairedDevice[] }>();
  const [busy, setBusy] = useState(false);
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  // 多选时返回键（鸿蒙）、Esc 先退出多选（157 号票）
  useSelectingBack(selecting, stopSelecting);

  const activeEntries: DeviceEntry[] = active.map((d) => {
    const left = Math.ceil((Date.parse(d.expiresAt) - now) / DAY_MS);
    // 还在等首次使用、没延期过的，说明里已经写了多久不用就作废，不再标
    const soon = left <= SOON_DAYS && (d.activated || d.extendedAt !== undefined) ? left : undefined;
    return { device: d, note: activeNote(d, now), paired: whenLabel(d.pairedAt, now), inactive: false, soon };
  });
  const inactiveEntries: DeviceEntry[] = inactive.map(({ device, reason }) => ({ device, note: inactiveNote(device, reason, now), paired: whenLabel(device.pairedAt, now), inactive: true }));
  const all = [...active, ...inactive.map((x) => x.device)];
  const chosen = all.filter((d) => picked.has(d.id));

  /** 交上去能做的那几台；跳过的（这边先剔掉的、守护进程回来说跳过的）在页面底部说 */
  const run = (action: DeviceBatchAction, devices: readonly PairedDevice[], days: number) => {
    const { ids, skips } = deviceBatchTargets(devices, action);
    if (ids.length === 0) return;
    setBusy(true);
    deviceBatchAction(ids, action, action === "extend" ? days : undefined)
      .then(
        (r) => {
          const text = deviceBatchToast(action, skips, r.results);
          if (text) toast(text);
        },
        // 整个被拒（比如守护进程还是旧版本）：页面底部已经提示了原因
        () => undefined,
      )
      .finally(() => setBusy(false));
  };

  const rows = (entries: readonly DeviceEntry[]) =>
    entries.map((e) => (
      <DeviceRow
        key={e.device.id}
        entry={e}
        self={e.device.id === self}
        selecting={selecting}
        checked={picked.has(e.device.id)}
        onToggle={() => setPicked((s) => toggleSelected(s, e.device.id))}
        onAct={(action) => setAsking({ action, devices: [e.device] })}
        onSelect={() => {
          setSelecting(true);
          setPicked(new Set([e.device.id]));
        }}
      />
    ));

  /** 一组标题右边的"全选 / 取消全选"（多选时） */
  const groupAll = (entries: readonly DeviceEntry[]) => {
    if (!selecting || entries.length === 0) return undefined;
    const ids = entries.map((e) => e.device.id);
    return (
      <button type="button" className="link sel-all" onClick={() => setPicked((s) => groupSelection(s, ids).next)}>
        {groupSelection(picked, ids).all ? t("pages.devices.unselectAll") : t("pages.devices.selectAll")}
      </button>
    );
  };

  return (
    <div className="chat-col">
      <TopBar title={title} onBack={onBack}>
        <SelectToggle selecting={selecting} onStart={() => setSelecting(true)} onStop={stopSelecting} disabled={!selecting && all.length === 0} />
      </TopBar>
      <div className={`scroll page-pad device-list${selecting ? " selecting" : ""}`}>
        <div className="card device-row device-local">
          <div>
            <b>
              {t("pages.devices.localComputer")}
              {access?.access === "local" && <span className="muted">{t("pages.devices.thisOne")}</span>}
            </b>
            <div className="muted">{t("pages.devices.localTrusted")}</div>
          </div>
        </div>
        <Section title={t("pages.devices.paired", { n: active.length })} extra={groupAll(activeEntries)}>
          {active.length === 0 && <div className="muted">{t("pages.devices.noneYet")}</div>}
          {rows(activeEntries)}
        </Section>
        {inactive.length > 0 && (
          <Section title={t("pages.devices.inactive", { n: inactive.length })} extra={groupAll(inactiveEntries)}>
            {rows(inactiveEntries)}
          </Section>
        )}
        <Section title={t("pages.devices.howToPair")}>
          <div className="muted">
            {t("pages.devices.howToPairText", { codeDigits: PAIRING_SHORT_CODE_DIGITS, fingerprintDigits: PAIRING_FINGERPRINT_HEX_DIGITS, duration: durationText(PAIRING_REQUEST_TTL_MS) })}
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={onPreviewPairing}>
              {t("pages.devices.previewPairing")}
            </button>
          </div>
        </Section>
      </div>
      {selecting && <DeviceSelectBar devices={chosen} busy={busy} onAct={(action) => setAsking({ action, devices: chosen })} onDone={stopSelecting} />}
      {asking && (
        <DeviceActDialog
          action={asking.action}
          devices={asking.devices}
          now={now}
          self={self}
          onCancel={() => setAsking(undefined)}
          onConfirm={(days) => {
            setAsking(undefined);
            run(asking.action, asking.devices, days);
          }}
        />
      )}
    </div>
  );
}

/**
 * 一台设备的一行：多选时点一下就是勾选；不多选时行尾"⋯"和长按 / 右键是同一个菜单（延期…、吊销、删除、多选），
 * 做不了的（吊销了的不能延期、不能再吊销）灰掉
 */
function DeviceRow({
  entry,
  self,
  selecting,
  checked,
  onToggle,
  onAct,
  onSelect,
}: {
  entry: DeviceEntry;
  self: boolean;
  selecting: boolean;
  checked: boolean;
  onToggle(): void;
  onAct(action: DeviceBatchAction): void;
  onSelect(): void;
}) {
  const { device: d, note, paired, inactive, soon } = entry;
  const rowRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<"row" | "more">();
  const press = useLongPress(() => setMenu("row"), { disabled: selecting });
  const act = (action: DeviceBatchAction) => {
    setMenu(undefined);
    onAct(action);
  };
  const body = (
    <>
      {selecting && (
        <span className={`bsel${checked ? " on" : ""}`} aria-hidden="true">
          {checked ? "✓" : ""}
        </span>
      )}
      <span className="device-text">
        <b>
          {d.name}
          {self && <span className="muted">{t("pages.devices.thisOne")}</span>}
        </b>
        <span className="muted">
          {inactive ? note : t("pages.devices.rowNote", { from: d.from, paired, note })}
          {soon !== undefined && <span className="device-soon"> · {t("pages.devices.expiresIn", { count: soon })}</span>}
        </span>
      </span>
    </>
  );
  return (
    <div ref={rowRef} className={`device-row${inactive ? " device-revoked" : ""}${checked ? " picked" : ""}`} {...press}>
      {selecting ? (
        <button type="button" className="device-main" aria-pressed={checked} onClick={onToggle}>
          {body}
        </button>
      ) : (
        <div className="device-main">{body}</div>
      )}
      {!selecting && (
        <button ref={moreRef} type="button" className="icon-btn" aria-label={t("pages.devices.moreActions")} aria-expanded={menu !== undefined} onClick={() => setMenu(menu ? undefined : "more")}>
          ⋯
        </button>
      )}
      {menu && (
        <PopupMenu anchor={menu === "row" ? rowRef : moreRef} align="end" className="row-menu" onClose={() => setMenu(undefined)}>
          <button type="button" role="menuitem" disabled={deviceBatchSkip(d, "extend") !== undefined} onClick={() => act("extend")}>
            {t("pages.devices.extend")}
          </button>
          <button type="button" role="menuitem" className="danger-text" disabled={deviceBatchSkip(d, "revoke") !== undefined} onClick={() => act("revoke")}>
            {t("pages.devices.revoke")}
          </button>
          <button type="button" role="menuitem" className="danger-text" onClick={() => act("delete")}>
            {t("pages.devices.delete")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(undefined);
              onSelect();
            }}
          >
            {t("pages.devices.select")}
          </button>
        </PopupMenu>
      )}
    </div>
  );
}

/** 多选的底部操作栏：每个按钮写能对几台做（一台都不能做时灰掉） */
function DeviceSelectBar({ devices, busy, onAct, onDone }: { devices: readonly PairedDevice[]; busy: boolean; onAct(action: DeviceBatchAction): void; onDone(): void }) {
  const counts = deviceBatchCounts(devices);
  return (
    <div className="sel-bar" role="toolbar" aria-label={t("pages.devices.selectActions")}>
      <span className="sel-n">{t("pages.devices.selected", { count: devices.length })}</span>
      <div className="sel-acts">
        {DEVICE_BATCH_ACTIONS.map((a) => (
          <button key={a} type="button" className={`btn small ghost${a === "extend" ? "" : " sel-danger"}`} disabled={busy || counts[a] === 0} onClick={() => onAct(a)}>
            {DEVICE_ACTION_LABEL[a]}
            {counts[a] > 0 && <span className="sel-count">{t("pages.devices.actionCount", { n: counts[a] })}</span>}
          </button>
        ))}
      </div>
      <SelectExit onExit={onDone} />
    </div>
  );
}

/** 延期（选时长）、吊销、删除之前的弹窗：说清对几台做、会怎样；"就是这台"那一句单独标出来 */
function DeviceActDialog({
  action,
  devices,
  now,
  self,
  onCancel,
  onConfirm,
}: {
  action: DeviceBatchAction;
  devices: readonly PairedDevice[];
  now: number;
  self: string | undefined;
  onCancel(): void;
  onConfirm(days: number): void;
}) {
  const [days, setDays] = useState<number>(DEFAULT_DEVICE_EXTEND_DAYS);
  const prompt = deviceActPrompt(devices, action, now, self, days);
  return (
    <Sheet title={prompt.title} onClose={onCancel} center>
      <div className="modal-body device-act">
        {action === "extend" && (
          <Segmented
            role="radio"
            label={t("pages.devices.extendHowLong")}
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={DEVICE_EXTEND_CHOICES.map((c) => ({ value: String(c.days), label: c.label }))}
          />
        )}
        {prompt.lines.map((line) => (
          <p key={line} className={line === deviceSelfLine() ? "device-self-warn" : undefined}>
            {line}
          </p>
        ))}
      </div>
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t("pages.devices.cancel")}
        </button>
        <button type="button" className={`btn ${action === "extend" ? "primary" : "danger"}`} onClick={() => onConfirm(days)}>
          {prompt.confirm}
        </button>
      </div>
    </Sheet>
  );
}
