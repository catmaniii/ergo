// 设置 · 语音：分识别、合成、播放三块（45 号票定的排法）。
// - 识别：识别引擎显示成一个选项（单选），清单由守护进程给，现在只有 faster-whisper 一项、选中，选不了别的；旁边是识别模型的状态
//   （用的模型、设备、加载中 / 已就绪 / 出错……）。以后加引擎时再加切换和存储；
// - 合成：合成模型（本机 LSM 托管的 audio.cpp）的状态，和参考音色（32 号票）：你发语音时 agent 用语音回复，照这里选的参考音色克隆。
//   可以导入（一段干净的人声录音，取个名字）、试听（参考录音本身）、选当前用哪一个、删除。参考音色是个人数据，存在数据目录里；
//   230 号票起导入收 WAV、MP3、M4A、AAC、OPUS、OGG、FLAC、WebM 等常见音频（守护进程用本机 ffmpeg 转成 WAV），逐字稿不用自己写：
//   导入时自动识别，识别中显示"正在转换并识别逐字稿…"，成了直接列出来、失败显示原因；
//   不列出 audio.cpp 自带的音色库，要用其中某个就在这里导入；
// - 323 号票：语音识别、语音合成的组件没装（别处也没有）时，那一块写一行"要先装「X」· 去装 ›"，点了去设置 · 组件；
// - 播放："自动播放 agent 的语音"开关（36 号票做的，45 号票从外观下面挪到这里；行为不变）。
// - 每个 agent 的名字和音色（241 号票；248 号票起并成"角色"）：这一页不管了，挪到设置 · 角色与声音（pages/more/RolesPage.tsx）——
//   角色就是名字 + 音色，每个 agent 选一个角色（⚙ 面板顶上那一块是同一件事，ui/agent-roles.tsx）；这里只剩参考音色本身。
// 两个模型的状态：打开页面时经 HTTP 取一次（/api/voice-models，并进状态层），之后的变化经活动状态频道推来（UiState.voiceModels）。
// 参考音色经 HTTP 取（/api/reference-voices，DaemonHttp）：页面由守护进程提供时是数据目录里的，直接打开构建产物时是原型的假数据。
import { useCallback, useEffect, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { toggleVoice, useVoicePlaying } from "../../app/page-voice.ts";
import {
  COMPONENT_FEATURES,
  REFERENCE_VOICE_MAX_MS,
  REFERENCE_VOICE_MIN_MS,
  REFERENCE_VOICE_NAME_MAX,
  type ReferenceVoice,
  type ReferenceVoiceList,
  type VoiceModelState,
  type VoiceModelsView,
  t,
  voiceModelSummary,
} from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";
import { ComponentMissing, useComponentGate } from "../../ui/component-gate.tsx";
import { useToast } from "../../ui/toast.tsx";
import { timeLabel } from "../../util/time.ts";
import { AutoplaySwitch } from "./AutoplaySwitch.tsx";

export function VoicePage() {
  const { http, ui, loadVoiceModels } = useStore();
  const toast = useToast();
  const [list, setList] = useState<ReferenceVoiceList>();
  const [error, setError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [modelsError, setModelsError] = useState<string>();
  const models = ui.voiceModels;

  // 两个模型的状态：打开页面时取一次，之后的变化推来
  useEffect(() => {
    loadVoiceModels().then(
      () => setModelsError(undefined),
      (err: unknown) => setModelsError(err instanceof Error ? err.message : String(err)),
    );
  }, [loadVoiceModels]);

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
      (err: unknown) => toast(t("pages.voice.failed", { reason: err instanceof Error ? err.message : String(err) })),
    );

  // 323 号票：语音识别、语音合成的组件没装（别处也没有）时各写一行"要先装…· 去装 ›"
  const asrOff = useComponentGate(COMPONENT_FEATURES.voiceInput);
  const ttsOff = useComponentGate(COMPONENT_FEATURES.voiceReply);
  const modelsPending = !models && <div className="muted">{modelsError ? t("pages.voice.modelsFailed", { reason: modelsError }) : t("pages.voice.modelsLoading")}</div>;

  return (
    <>
      <Section title={t("pages.voice.recognition")}>
        <span className="muted">{t("pages.voice.recognitionHint")}</span>
        {asrOff && <ComponentMissing gate={asrOff} />}
        {models ? <RecognizerEngines models={models} /> : modelsPending}
      </Section>
      <Section
        title={t("pages.voice.synthesis")}
        extra={
          <button type="button" className="btn primary small" onClick={() => setImporting(true)}>
            {t("pages.voice.importButton")}
          </button>
        }
      >
        <span className="muted">{t("pages.voice.synthesisHint")}</span>
        {ttsOff && <ComponentMissing gate={ttsOff} />}
        {models ? (
          <div className="skill-row voice-model-row">
            <div>
              <b>audio.cpp</b>
              <ModelStatus state={models.speech} />
            </div>
          </div>
        ) : (
          modelsPending
        )}
        <div className="voice-sub-head">{t("pages.voice.referenceVoices")}</div>
        {error && <div className="sys-note">{t("pages.voice.referenceLoadFailed", { reason: error })}</div>}
        {list && list.voices.length === 0 && (
          <div className="page-placeholder">{t("pages.voice.noReference")}</div>
        )}
        {list?.voices.map((voice) => (
          <VoiceRow
            key={voice.id}
            voice={voice}
            current={voice.id === list.currentId}
            onSelect={() => void act(t("pages.voice.selected", { name: voice.name }), () => http.selectReferenceVoice(voice.id))}
            onRemove={() => void act(t("pages.voice.removed", { name: voice.name }), () => http.removeReferenceVoice(voice.id))}
          />
        ))}
        <div className="hint">{t("pages.voice.libraryHint")}</div>
      </Section>
      <Section title={t("pages.voice.playback")}>
        <AutoplaySwitch />
      </Section>
      {/* 每个 agent 用哪个角色（名字和音色）挪到设置 · 角色与声音（248 号票）了，这一页只管参考音色本身 */}
      {importing && (
        <ImportVoice
          onClose={() => setImporting(false)}
          onImported={(voice) => {
            setImporting(false);
            toast(t("pages.voice.imported", { name: voice.name }));
            load();
          }}
        />
      )}
    </>
  );
}

/** 识别引擎：单选，清单由守护进程给（现在只有 faster-whisper 一项）；选中的旁边是识别模型的状态 */
function RecognizerEngines({ models }: { models: VoiceModelsView }) {
  return (
    <div className="voice-engines" role="radiogroup" aria-label={t("pages.voice.engines")}>
      {models.recognizerEngines.map((engine) => (
        <label key={engine} className="check-row radio-row">
          <input type="radio" name="recognizer-engine" value={engine} checked={engine === models.recognizerEngine} readOnly />
          <span>
            <b>{engine}</b>
            {engine === models.recognizerEngine && <ModelStatus state={models.recognizer} />}
          </span>
        </label>
      ))}
      {models.recognizerEngines.length === 1 && <div className="muted">{t("pages.voice.onlyEngine")}</div>}
    </div>
  );
}

/** 小签的样子：已就绪绿、等待和加载中蓝、没开和出错红、已卸载灰 */
const TONE_CHIP = { ok: "chip-ok", pending: "chip-op", problem: "chip-no", idle: "chip-quiet" } as const;

/** 一个模型的状态：小签（加载中、已就绪……）加说明（用的模型、设备、加载耗时；没开、出错的原因） */
function ModelStatus({ state }: { state: VoiceModelState }) {
  const summary = voiceModelSummary(state);
  return (
    <div className="voice-model-status">
      <span className={`chip ${TONE_CHIP[summary.tone]}`}>{summary.label}</span>
      <span className="muted">{summary.detail}</span>
    </div>
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
    else toast(t("pages.voice.noAudioInPrototype"));
  };
  return (
    <div className="skill-row voice-ref-row">
      <div>
        <b>
          {voice.name}
          {current && <span className="chip chip-ok">{t("pages.voice.current")}</span>}
        </b>
        <div className="muted">
          {voice.durationMs > 0 ? t("pages.voice.seconds", { seconds: (voice.durationMs / 1000).toFixed(1) }) : t("pages.voice.durationUnknown")}
          {voice.importedAt ? ` · ${t("pages.voice.importedAt", { time: timeLabel(voice.importedAt) })}` : ""}
        </div>
        <div className="muted voice-ref-text">{t("pages.voice.transcriptLine", { text: voice.referenceText })}</div>
      </div>
      <div className="voice-ref-actions">
        <button type="button" className="btn ghost small" onClick={play}>
          {playing ? t("pages.voice.stop") : t("pages.voice.listen")}
        </button>
        {!current && (
          <button type="button" className="btn ghost small" onClick={onSelect}>
            {t("pages.voice.use")}
          </button>
        )}
        {confirming ? (
          <button type="button" className="btn danger small" onClick={onRemove}>
            {t("pages.voice.confirmDelete")}
          </button>
        ) : (
          <button type="button" className="link danger-text" onClick={() => setConfirming(true)}>
            {t("pages.voice.delete")}
          </button>
        )}
      </div>
    </div>
  );
}

function ImportVoice({ onClose, onImported }: { onClose(): void; onImported(voice: ReferenceVoice): void }) {
  const { http } = useStore();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // 230 号票：逐字稿不用自己写（导入时自动识别），名字和录音有就能导
  const ready = name.trim() !== "" && file !== undefined && !busy;
  const submit = () => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    http.importReferenceVoice({ name: name.trim(), audio: file }).then(onImported, (err: unknown) => {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  };
  return (
    <Sheet title={t("pages.voice.importTitle")} onClose={onClose} center>
      <label className="field">
        <span>{t("pages.voice.name")}</span>
        <input value={name} maxLength={REFERENCE_VOICE_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder={t("pages.voice.namePlaceholder")} />
      </label>
      <label className="field">
        <span>{t("pages.voice.audio")}</span>
        <input type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.opus,.ogg,.flac,.webm" onChange={(e) => setFile(e.target.files?.[0])} />
      </label>
      <div className="hint">
        {t("pages.voice.importHint", { min: REFERENCE_VOICE_MIN_MS / 1000, max: REFERENCE_VOICE_MAX_MS / 1000 })}
      </div>
      {error && <div className="sys-note">{error}</div>}
      <div className="auth-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {t("pages.voice.cancel")}
        </button>
        <button type="button" className="btn primary" disabled={!ready} onClick={submit}>
          {busy ? t("pages.voice.importing") : t("pages.voice.import")}
        </button>
      </div>
    </Sheet>
  );
}
