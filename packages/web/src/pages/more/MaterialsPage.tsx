// 设置 · 删除素材（21 号票）：按会话或按时间段删。三种删法：忘掉（默认）、彻底删除、别推断。
// 范围里有几条素材、有素材的会话都问守护进程（HTTP）；确认后对范围内的全部素材执行，同一次确认重发只执行一次。
// 彻底删除另外连带范围里没有素材的语音（没识别出文字的，31 号票）：它们的消息和录音一起删，范围里只有它们时也能删。
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { conversationLabel } from "../../model/labels.ts";
import { CHANNELS, type MaterialScope, MEMORY_COMMAND_LABEL, MEMORY_DELETE_MODE_INFO, MEMORY_DELETE_MODES, type MemoryDeleteMode } from "../../state/index.ts";
import { nowIso } from "../../util/time.ts";
import { useToast } from "../../ui/toast.tsx";
import { Section, Segmented, Sheet } from "../../ui/common.tsx";

type By = "session" | "range";

/** datetime-local 的值（本地时间，到分钟）→ 协议的时间；"到"取那一分钟的最后一刻，两头都算 */
function rangeIso(value: string, end: boolean): string {
  const ms = new Date(value).getTime();
  return nowIso(new Date(end ? ms + 59_999 : ms));
}

/** 幂等键。file:// 打开时 crypto.randomUUID 可能不可用，退回时间加随机数 */
function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function MaterialsPage() {
  const toast = useToast();
  const { http } = useStore();
  const [by, setBy] = useState<By>("session");
  const [conversation, setConversation] = useState<string>(CHANNELS.secretary);
  const [from, setFrom] = useState(() => nowIso(new Date(Date.now() - 7 * 86_400_000)).slice(0, 16));
  const [to, setTo] = useState(() => nowIso().slice(0, 16));
  const [mode, setMode] = useState<MemoryDeleteMode>("forget");
  /** 守护进程数出来的：哪个范围（scopeKey）里有几条，有素材的会话 */
  const [summary, setSummary] = useState<{ key: string; count: number; conversations: Array<{ conversation: string; count: number }>; voices?: number }>();
  /** 确认框开着时带着这次确认的幂等键 */
  const [confirming, setConfirming] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const scope = useMemo<MaterialScope | undefined>(() => {
    if (by === "session") return { kind: "conversation", conversation };
    if (!from || !to) return undefined;
    return { kind: "time_range", from: rangeIso(from, false), to: rangeIso(to, true) };
  }, [by, conversation, from, to]);

  // 有素材的会话（下拉框），以及范围里有几条；删过之后（refresh）重新数
  const scopeKey = `${JSON.stringify(scope ?? null)}#${refresh}`;
  useEffect(() => {
    let live = true;
    http
      .materialScope(scope)
      .then((s) => {
        if (live) setSummary({ key: scopeKey, ...s });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [http, scope, scopeKey]);
  const count = summary?.key === scopeKey ? summary.count : undefined;
  /** 范围里没有素材的语音（没识别出文字的）：只有彻底删除管它们 */
  const voices = mode === "purge" && summary?.key === scopeKey ? (summary.voices ?? 0) : 0;
  const voicesText = voices > 0 ? `，另有 ${voices} 条没识别出文字的语音（连同录音一起删）` : "";
  const conversations = summary?.conversations ?? [];

  const choices = conversations.some((c) => c.conversation === CHANNELS.secretary) ? conversations : [{ conversation: CHANNELS.secretary, count: 0 }, ...conversations];
  const scopeText = by === "session" ? `会话「${conversationLabel(conversation)}」` : `${from.replace("T", " ")} 到 ${to.replace("T", " ")}`;
  const label = MEMORY_COMMAND_LABEL[mode];

  const run = (key: string) => {
    if (!scope) return;
    setBusy(true);
    http
      .deleteMaterials(scope, mode, key)
      .then(({ count: done }) => {
        setConfirming(undefined);
        toast(mode === "no_infer" ? `已把 ${done} 条素材标记为不参与推断` : `已${label} ${done} 条素材${voices > 0 ? `和 ${voices} 条语音` : ""}`);
        setRefresh((n) => n + 1);
      })
      .catch((err: unknown) => toast(`没删成：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="muted">素材是二狗用来理解你的原始输入：你说过的话、对产出和审批的反应等。对话里说"忘掉……"也能删，那是秘书出一张记忆删除卡给你核对。</div>
      <Segmented<By>
        value={by}
        onChange={setBy}
        options={[
          { value: "session", label: "按会话" },
          { value: "range", label: "按时间段" },
        ]}
      />
      <Section title="范围">
        {by === "session" ? (
          <label className="field">
            <span>会话</span>
            <select value={conversation} onChange={(e) => setConversation(e.target.value)}>
              {choices.map((c) => (
                <option key={c.conversation} value={c.conversation}>
                  {conversationLabel(c.conversation)}（{c.count} 条）
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="range-row">
            <label className="field">
              <span>从</span>
              <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field">
              <span>到</span>
              <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
        )}
      </Section>
      <Section title="删法">
        {MEMORY_DELETE_MODES.map((m) => (
          <label key={m} className="check-row radio-row">
            <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
            <span>
              <b>{MEMORY_COMMAND_LABEL[m]}</b>
              {m === "forget" && <span className="muted">（默认）</span>}
              <div className="muted">{MEMORY_DELETE_MODE_INFO[m].note}</div>
            </span>
          </label>
        ))}
      </Section>
      <div className="add-row">
        <span className="muted">{count === undefined ? "正在数…" : `范围里有 ${count} 条素材${voicesText}`}</span>
        <button type="button" className={`btn ${mode === "purge" ? "danger" : "primary"}`} disabled={!count && voices === 0} onClick={() => setConfirming(newKey())}>
          {label}
        </button>
      </div>
      {confirming !== undefined && (
        <Sheet title={`${label}：${scopeText}？`} onClose={() => setConfirming(undefined)} center>
          <div className="modal-body">
            <p>
              范围里有 {count ?? 0} 条素材{voicesText}。{MEMORY_DELETE_MODE_INFO[mode].note}
            </p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirming(undefined)}>
              取消
            </button>
            <button type="button" className={`btn ${mode === "purge" ? "danger" : "primary"}`} disabled={busy} onClick={() => run(confirming)}>
              {busy ? "处理中…" : `确认${label}`}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
