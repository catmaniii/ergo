// Debug 工具集的语音组（124 号票）：测麦克风、识别、合成通不通、多快，都不经会话（不进<名字>的上下文）。
// - 录 3 秒再回放：App 里用原生录音（63 号票），浏览器里用页面录音，录完马上放；
// - 录 3 秒送识别：交给守护进程的识别进程（POST /api/debug/recognize），显示识别出的文字、守护进程那边的耗时和整个往返
//   （180 号票：剔掉了模型自带的串词时补一句剔了几个字，整条只有串词的写"已丢弃"）；
// - 合成念一句：用当前参考音色合成（POST /api/debug/speak），显示合成耗时并播放。
import { useState } from "react";
import { blobOfBase64, type DebugTake, playBlob, recordSeconds } from "../../app/debug-page.ts";
import { useStore } from "../../app/store.tsx";
import { t } from "../../state/index.ts";
import { useAssistantName } from "../../ui/assistant-name.tsx";
import { DebugCard, DebugRow } from "./debug-parts.tsx";

/** 录几秒 */
const RECORD_SECONDS = 3;

/** 录到的一段的说明：走的哪条、多长、什么格式、多大 */
function takeText(take: DebugTake): string {
  const { recording, backend } = take;
  return t(recording.silent ? "pages.debugVoice.takeSilent" : "pages.debugVoice.take", {
    backend: t(backend === "native" ? "pages.debugVoice.backend.native" : "pages.debugVoice.backend.page"),
    mime: recording.mime || t("pages.debugVoice.unknownFormat"),
    size: (recording.blob.size / 1024).toFixed(1),
  });
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 180 号票：守护进程剔掉了模型自带的串词时补一句（整条只有串词的写"已丢弃"），不显示被剔的原文 */
function strippedNote(result: { text: string; strippedChars?: number }): string {
  if (!result.strippedChars) return "";
  return t(result.text ? "pages.debugVoice.recognize.strippedNote" : "pages.debugVoice.recognize.onlyFiller", { chars: result.strippedChars });
}

export function DebugVoice() {
  const { http } = useStore();
  const name = useAssistantName();
  const [busy, setBusy] = useState<"playback" | "recognize" | "speak">();
  const [playback, setPlayback] = useState<string>();
  const [recognized, setRecognized] = useState<string>();
  const [spoken, setSpoken] = useState<string>();

  const run = async (what: "playback" | "recognize" | "speak", step: () => Promise<void>) => {
    setBusy(what);
    try {
      await step();
    } finally {
      setBusy(undefined);
    }
  };

  const recordAndPlay = () =>
    run("playback", async () => {
      setPlayback(t("pages.debugVoice.playback.recording", { seconds: RECORD_SECONDS }));
      try {
        const take = await recordSeconds(RECORD_SECONDS);
        setPlayback(t("pages.debugVoice.playback.playing", { take: takeText(take) }));
        await playBlob(take.recording.blob);
        setPlayback(t("pages.debugVoice.playback.done", { take: takeText(take) }));
      } catch (err) {
        setPlayback(t("pages.debugVoice.failed", { reason: errorText(err) }));
      }
    });

  const recordAndRecognize = () =>
    run("recognize", async () => {
      setRecognized(t("pages.debugVoice.recognize.recording", { seconds: RECORD_SECONDS }));
      try {
        const take = await recordSeconds(RECORD_SECONDS);
        setRecognized(t("pages.debugVoice.recognize.sending", { take: takeText(take) }));
        const started = performance.now();
        const result = await http.debugRecognize(take.recording.blob);
        const total = Math.round(performance.now() - started);
        setRecognized(
          result.ok
            ? t("pages.debugVoice.recognize.result", { text: result.text || t("pages.debugVoice.recognize.noText"), ms: result.ms, model: result.model, device: result.device, total }) + strippedNote(result)
            : t("pages.debugVoice.recognize.cant", { reason: result.reason, ms: result.ms }),
        );
      } catch (err) {
        setRecognized(t("pages.debugVoice.failed", { reason: errorText(err) }));
      }
    });

  const speak = () =>
    run("speak", async () => {
      setSpoken(t("pages.debugVoice.speak.busy"));
      try {
        const started = performance.now();
        const result = await http.debugSpeak(t("pages.debugVoice.speak.sentence", { name }));
        const total = Math.round(performance.now() - started);
        if (!result.ok) {
          setSpoken(t("pages.debugVoice.speak.cant", { reason: result.reason, ms: result.ms }));
          return;
        }
        const text = t("pages.debugVoice.speak.result", { ms: result.ms, model: result.model, voice: result.voiceName, total });
        setSpoken(t("pages.debugVoice.speak.playing", { text }));
        await playBlob(blobOfBase64(result.audioBase64, result.mime));
        setSpoken(text);
      } catch (err) {
        setSpoken(t("pages.debugVoice.failed", { reason: errorText(err) }));
      }
    });

  return (
    <DebugCard title={t("pages.debugVoice.title")}>
      <DebugRow label={t("pages.debugVoice.playback.label", { seconds: RECORD_SECONDS })}>
        <button type="button" className="btn ghost small" disabled={busy !== undefined} onClick={() => void recordAndPlay()}>
          {busy === "playback" ? t("pages.debugVoice.playback.busy") : t("pages.debugVoice.start")}
        </button>
      </DebugRow>
      {playback && <div className="debug-status">{playback}</div>}
      <DebugRow label={t("pages.debugVoice.recognize.label", { seconds: RECORD_SECONDS })}>
        <button type="button" className="btn ghost small" disabled={busy !== undefined} onClick={() => void recordAndRecognize()}>
          {busy === "recognize" ? t("pages.debugVoice.recognize.busy") : t("pages.debugVoice.start")}
        </button>
      </DebugRow>
      {recognized && <div className="debug-status">{recognized}</div>}
      <DebugRow label={t("pages.debugVoice.speak.label")}>
        <button type="button" className="btn ghost small" disabled={busy !== undefined} onClick={() => void speak()}>
          {busy === "speak" ? t("pages.debugVoice.speak.busy") : t("pages.debugVoice.start")}
        </button>
      </DebugRow>
      {spoken && <div className="debug-status">{spoken}</div>}
      <div className="hint">{t("pages.debugVoice.hint")}</div>
    </DebugCard>
  );
}
