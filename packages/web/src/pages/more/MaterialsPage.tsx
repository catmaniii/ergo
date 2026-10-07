// 设置 · 删除素材：按会话或按时间段删。三种删法：忘掉（默认）、彻底删除、别推断。
import { useState } from "react";
import { FAKE_SESSIONS } from "../../prototype/fake-data.ts";
import { useToast } from "../../ui/toast.tsx";
import { Section, Segmented, Sheet } from "../../ui/common.tsx";

type By = "session" | "range";
type Mode = "forget" | "purge" | "no_infer";

const MODES: Record<Mode, { label: string; note: string }> = {
  forget: { label: "忘掉", note: "从素材库删掉；聊天记录里仍看得到原话。" },
  purge: { label: "彻底删除", note: "连会话原文一起删：事件日志和会话文件里的原文改写成删除标记，不可恢复。" },
  no_infer: { label: "别推断", note: "素材保留，但标记为不参与推断。" },
};

export function MaterialsPage() {
  const toast = useToast();
  const [by, setBy] = useState<By>("session");
  const [session, setSession] = useState(FAKE_SESSIONS[0]!);
  const [from, setFrom] = useState("2026-09-01T00:00");
  const [to, setTo] = useState("2026-09-30T23:59");
  const [mode, setMode] = useState<Mode>("forget");
  const [confirming, setConfirming] = useState(false);
  // 原型：按选择粗算一个"大约多少条"
  const estimate = by === "session" ? 120 + FAKE_SESSIONS.indexOf(session) * 37 : Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) * 9);
  const scope = by === "session" ? `会话「${session}」` : `${from.replace("T", " ")} 到 ${to.replace("T", " ")}`;
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
            <select value={session} onChange={(e) => setSession(e.target.value)}>
              {FAKE_SESSIONS.map((s) => (
                <option key={s}>{s}</option>
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
        {(Object.keys(MODES) as Mode[]).map((m) => (
          <label key={m} className="check-row radio-row">
            <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
            <span>
              <b>{MODES[m].label}</b>
              {m === "forget" && <span className="muted">（默认）</span>}
              <div className="muted">{MODES[m].note}</div>
            </span>
          </label>
        ))}
      </Section>
      <div className="add-row">
        <span className="muted">大约 {estimate} 条素材</span>
        <button type="button" className={`btn ${mode === "purge" ? "danger" : "primary"}`} disabled={estimate === 0} onClick={() => setConfirming(true)}>
          {MODES[mode].label}
        </button>
      </div>
      {confirming && (
        <Sheet title={`${MODES[mode].label}：${scope}？`} onClose={() => setConfirming(false)} center>
          <div className="modal-body">
            <p>大约 {estimate} 条素材。{MODES[mode].note}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
              取消
            </button>
            <button
              type="button"
              className={`btn ${mode === "purge" ? "danger" : "primary"}`}
              onClick={() => {
                setConfirming(false);
                toast(`已${MODES[mode].label} ${estimate} 条素材（原型，没有真的删）`);
              }}
            >
              确认{MODES[mode].label}
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
