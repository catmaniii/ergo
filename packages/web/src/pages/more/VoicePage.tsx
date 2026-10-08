// 设置 · 语音（32 号票）：参考音色。你发语音时 agent 用语音回复，照这里选的参考音色克隆（经本机 LSM 托管的 audio.cpp 合成）。
// 可以导入（一段干净的 WAV 加它的逐字稿，取个名字）、试听（参考录音本身）、选当前用哪一个、删除。
// 参考音色是个人数据，存在数据目录里；不列出 audio.cpp 自带的音色库，要用其中某个就在这里导入。
// 数据经 HTTP 取（/api/reference-voices，DaemonHttp）：页面由守护进程提供时是数据目录里的，直接打开构建产物时是原型的假数据。
import { useCallback, useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { toggleVoice, useVoicePlaying } from "../../app/page-voice.ts";
import { REFERENCE_VOICE_MAX_MS, REFERENCE_VOICE_MIN_MS, REFERENCE_VOICE_NAME_MAX, type ReferenceVoice, type ReferenceVoiceList } from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";
import { timeLabel } from "../../util/time.ts";

export function VoicePage() {
  const { http } = useStore();
  const toast = useToast();
  const [list, setList] = useState<ReferenceVoiceList>();
  const [error, setError] = useState<string>();
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    http.referenceVoices().then(
      (l) => {
        setList(l);
        setError(undefined);
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [http]);
  useEffect(load, [load]);

  const act = (what: string, run: () => Promise<ReferenceVoiceList>) =>
    run().then(
      (l) => {
        setList(l);
        toast(what);
      },
      (err: unknown) => toast(`没做成：${err instanceof Error ? err.message : String(err)}`),
    );

  return (
    <>
      <div className="add-row">
        <span className="muted">你发语音时，agent 用语音回复，照这里选的参考音色合成（经本机的 audio.cpp）。参考音色是你的个人数据，存在数据目录里。</span>
        <button type="button" className="btn primary small" onClick={() => setImporting(true)}>
          ＋ 导入参考音色
        </button>
      </div>
      <Section title="参考音色">
        {error && <div className="sys-note">读不到参考音色：{error}</div>}
        {list && list.voices.length === 0 && (
          <div className="page-placeholder">还没有参考音色：你发语音时 agent 只用文字回复。导入一段干净的人声录音和它的逐字稿就能用。</div>
        )}
        {list?.voices.map((voice) => (
          <VoiceRow
            key={voice.id}
            voice={voice}
            current={voice.id === list.currentId}
            onSelect={() => void act(`语音回复改用「${voice.name}」`, () => http.selectReferenceVoice(voice.id))}
            onRemove={() => void act(`已删掉参考音色「${voice.name}」`, () => http.removeReferenceVoice(voice.id))}
          />
        ))}
      </Section>
      <div className="hint">不列出 audio.cpp 自带的音色库；想用其中某个，就把它的录音和逐字稿在这里导入。合成服务没开、合成失败时，agent 退回只发文字。</div>
      {importing && (
        <ImportVoice
          onClose={() => setImporting(false)}
          onImported={(voice) => {
            setImporting(false);
            toast(`已导入参考音色「${voice.name}」`);
            load();
          }}
        />
      )}
    </>
  );
}

function VoiceRow({ voice, current, onSelect, onRemove }: { voice: ReferenceVoice; current: boolean; onSelect(): void; onRemove(): void }) {
  const { http } = useStore();
  const toast = useToast();
  const playKey = `reference-voice:${voice.id}`;
  const playing = useVoicePlaying(playKey);
  const [confirming, setConfirming] = useState(false);
  const play = () => {
    const url = http.referenceVoiceAudioUrl(voice.id);
    if (url) toggleVoice(playKey, url);
    else toast("原型里没有这段录音");
  };
  return (
    <div className="skill-row voice-ref-row">
      <div>
        <b>
          {voice.name}
          {current && <span className="chip chip-ok">当前</span>}
        </b>
        <div className="muted">
          {voice.durationMs > 0 ? `${(voice.durationMs / 1000).toFixed(1)} 秒` : "时长未知"}
          {voice.importedAt ? ` · ${timeLabel(voice.importedAt)} 导入` : ""}
        </div>
        <div className="muted voice-ref-text">逐字稿：{voice.referenceText}</div>
      </div>
      <div className="voice-ref-actions">
        <button type="button" className="btn ghost small" onClick={play}>
          {playing ? "停止" : "试听"}
        </button>
        {!current && (
          <button type="button" className="btn ghost small" onClick={onSelect}>
            用这个
          </button>
        )}
        {confirming ? (
          <button type="button" className="btn danger small" onClick={onRemove}>
            确认删除
          </button>
        ) : (
          <button type="button" className="link danger-text" onClick={() => setConfirming(true)}>
            删除
          </button>
        )}
      </div>
    </div>
  );
}

function ImportVoice({ onClose, onImported }: { onClose(): void; onImported(voice: ReferenceVoice): void }) {
  const { http } = useStore();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = name.trim() !== "" && text.trim() !== "" && file !== undefined && !busy;
  const submit = () => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    http.importReferenceVoice({ name: name.trim(), referenceText: text.trim(), audio: file }).then(onImported, (err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };
  return (
    <Sheet title="导入参考音色" onClose={onClose} center>
      <label className="field">
        <span>名字</span>
        <input value={name} maxLength={REFERENCE_VOICE_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="比如 示例音色" />
      </label>
      <label className="field">
        <span>参考录音（WAV）</span>
        <input type="file" accept=".wav,audio/wav,audio/x-wav" onChange={(e) => setFile(e.target.files?.[0])} />
      </label>
      <label className="field">
        <span>逐字稿</span>
        <textarea value={text} rows={3} onChange={(e) => setText(e.target.value)} placeholder="录音里说的原话，一字不差" />
      </label>
      <div className="hint">
        录音要 {REFERENCE_VOICE_MIN_MS / 1000}–{REFERENCE_VOICE_MAX_MS / 1000} 秒的 WAV，建议 5–15 秒、只有一个人说话、没有背景音乐和噪声；逐字稿要和录音里说的一致（声音克隆要两样同时给）。
      </div>
      {error && <div className="sys-note">{error}</div>}
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn primary" disabled={!ready} onClick={submit}>
          {busy ? "导入中…" : "导入"}
        </button>
      </div>
    </Sheet>
  );
}
