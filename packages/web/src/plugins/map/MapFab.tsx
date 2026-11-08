// 地图右下角的二狗悬浮按钮和它上方的小气泡（444）：
// - 按钮本身和"浏览"里网页上的悬浮按钮是同一个（page-bridge/fab.ts 的 createFab、FAB_STYLE：白圈、二狗的图标、听 / 忙的圈），
//   放进自己的 shadow root；在哪照页面桥的规矩（page-bridge/rules.ts：fabSpot 地图上没有"选中的元素"——聊天窗关着在右下角、
//   开着不显示；placeCornerButton 离右边、底边 16，底下让开署名角标和手机上的抽屉）。缩放钮在右上不动，"回到我现在的位置"排在它上面
//   （照谷歌地图：二狗按钮在最右下）；
// - 点一下打字、按住说话（按够 0.35 秒开始录，上滑或划开松手取消；语音插件停用时只能打字），逻辑在 map-talk.ts；
// - 气泡在按钮上方、右边对齐（宽度照页面桥的 bubbleWidth：手机上屏宽减 32、最宽 360），用二狗网页自己的样式（跟着十一套风格、深浅），
//   顶上一行"对二狗说"（名字是用户起的，画成名字标签），右边"展开到右边"（收起气泡、打开右边的聊天窗）和收起。
import { type CSSProperties, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createFab, FAB_STYLE, type Fab } from "../../page-bridge/fab.ts";
import { BUBBLE_EDGE, BUBBLE_GAP, BUBBLE_MAX_HEIGHT, BUTTON_SIZE, bubbleWidth, fabSpot, inVoiceCancelZone, placeCornerButton, recordedText, waveBars } from "../../page-bridge/rules.ts";
import { BUSY_KEY, LONG_PRESS_MS, type NamedPart, namedText } from "../../app/talk-button.ts";
import { PAGE_COMMAND_TEXT_MAX, t } from "../../state/index.ts";
import { NameTag, useAssistantName } from "../../ui/assistant-name.tsx";
import { Icon } from "../../ui/icons.tsx";
import type { MapTalk, MapTalkPanel } from "./map-talk.ts";

/** 按钮底下让开署名角标（"© OpenStreetMap 贡献者"那一条，高德的标志也在左下右下）多少 */
export const MAP_FAB_ATTRIBUTION_ROOM = 20;

/** 气泡里的竖条有几格（照页面桥） */
const WAVE_BARS = 28;

/** 一句带名字的话：字是字，名字画成名字标签 */
function Named({ parts, text }: { parts: readonly NamedPart[] | undefined; text: string }) {
  if (!parts) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) => (typeof p === "string" ? <span key={i}>{p}</span> : <NameTag key={i} name={p.name} />))}
    </>
  );
}

/** 按钮这一刻在哪（地图那块里的坐标）：照页面桥右下角按钮的规矩 */
export function mapFabSpot(stage: { width: number; height: number }, dock: number): { x: number; y: number } {
  return placeCornerButton({ left: 0, top: 0, right: stage.width, bottom: stage.height }, MAP_FAB_ATTRIBUTION_ROOM + Math.max(0, dock));
}

/** 地图那块多大（跟着变） */
function useSize(ref: { readonly current: HTMLElement | null }): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** 手机上（手指点）回车换行，电脑上回车发送 */
const coarse = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

export function MapFab({ talk, chatOpen, stageRef, dock, onExpand }: { talk: MapTalk; chatOpen: boolean; stageRef: { readonly current: HTMLElement | null }; dock: number; onExpand(): void }) {
  const panel = useSyncExternalStore(talk.subscribe, talk.snapshot);
  const name = useAssistantName();
  const stage = useSize(stageRef);
  const hostRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<Fab | undefined>(undefined);
  // 地图上没有"选中的元素"：聊天窗关着在右下角，开着不显示
  const spot = fabSpot({ selected: false, sideOpen: chatOpen });
  const at = mapFabSpot(stage, dock);
  const shown = spot === "corner" && stage.width > 0;

  // 按下、挪、松手：短按打字，长按说话（拿最新的 talk 和"展开"）
  const press = useRef<{ x: number; y: number; id: number; timer: ReturnType<typeof setTimeout> | undefined; listening: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.replaceChildren();
    const style = document.createElement("style");
    // 页面桥的按钮是 position: fixed（摆在网页的视口里）；这里摆在地图那块里，跟着外面这个宿主走
    style.textContent = `${FAB_STYLE}\n.fab { position: absolute; }`;
    const fab = createFab(document, { decode: (b64) => atob(b64), makeBitmap: (blob) => createImageBitmap(blob), BlobCtor: Blob }, "");
    fab.el.classList.add("on");
    root.append(style, fab.el);
    fabRef.current = fab;
    const el = fab.el;
    const down = (e: PointerEvent) => {
      if (!e.isPrimary || talk.busy) return;
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // 拿不到就算了
      }
      talk.press();
      const p: NonNullable<typeof press.current> = { x: e.clientX, y: e.clientY, id: e.pointerId, listening: false, timer: undefined };
      p.timer = setTimeout(() => {
        p.timer = undefined;
        p.listening = true;
        talk.listen();
      }, LONG_PRESS_MS);
      press.current = p;
    };
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || p.id !== e.pointerId || !p.listening) return;
      talk.setCancelZone(inVoiceCancelZone(p, { x: e.clientX, y: e.clientY }));
    };
    const up = (e: PointerEvent, how: "release" | "cancel") => {
      const p = press.current;
      if (!p || p.id !== e.pointerId) return;
      press.current = undefined;
      if (p.timer !== undefined) clearTimeout(p.timer);
      if (p.listening) {
        if (how === "cancel") talk.cancelListening();
        else talk.release();
      } else if (how === "release") talk.open();
    };
    const release = (e: PointerEvent) => up(e, "release");
    const cancel = (e: PointerEvent) => up(e, "cancel");
    // 手机上长按别弹系统菜单
    const menu = (e: Event) => e.preventDefault();
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("contextmenu", menu);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", release);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("contextmenu", menu);
      const p = press.current;
      if (p?.timer !== undefined) clearTimeout(p.timer);
      press.current = undefined;
      fabRef.current = undefined;
    };
  }, [talk]);

  // 按钮的样子跟着气泡：在听、在办
  useEffect(() => {
    fabRef.current?.setMark(panel.kind === "listening" ? "listening" : panel.kind === "busy" ? "busy" : "idle");
  }, [panel.kind]);
  // 读屏说明：只能打字时不说"按住说话"
  const label = talk.typeOnly ? t("app.pageCommands.fabTypeOnly", { name }) : t("bridge.fab.label", { name });
  useEffect(() => {
    fabRef.current?.setLabel(label);
  }, [label]);

  // 聊天窗打开了：气泡收起
  useEffect(() => {
    if (!shown) talk.dismiss();
  }, [shown, talk]);

  const hostStyle: CSSProperties = { left: at.x, top: at.y, width: BUTTON_SIZE, height: BUTTON_SIZE };
  return (
    <>
      <div ref={hostRef} className="map-fab" hidden={!shown} style={hostStyle} data-mark={panel.kind === "listening" ? "listening" : panel.kind === "busy" ? "busy" : "idle"} />
      {shown && panel.kind !== "idle" && <MapTalkBubble talk={talk} panel={panel} name={name} stage={stage} at={at} onExpand={onExpand} />}
    </>
  );
}

/** 按钮上方的气泡 */
function MapTalkBubble({ talk, panel, name, stage, at, onExpand }: { talk: MapTalk; panel: Exclude<MapTalkPanel, { kind: "idle" }>; name: string; stage: { width: number; height: number }; at: { x: number; y: number }; onExpand(): void }) {
  const width = bubbleWidth(stage.width);
  const right = Math.max(BUBBLE_EDGE, stage.width - (at.x + BUTTON_SIZE));
  const bottom = stage.height - at.y + BUBBLE_GAP;
  const maxHeight = Math.max(0, Math.min(BUBBLE_MAX_HEIGHT, at.y - BUBBLE_GAP - BUBBLE_EDGE));
  // 小尖角指着按钮的中线
  const tail = Math.max(16, Math.min(width - 16, at.x + BUTTON_SIZE / 2 - (stage.width - right - width)));
  const listening = panel.kind === "listening";
  const talkTo = namedText("bridge.talkTo.ergo", name);
  const head = panel.kind === "bar" || listening ? <Named parts={talkTo.parts} text={talkTo.text} /> : <NameTag name={name} />;
  return (
    <div
      className="map-talk"
      role="dialog"
      aria-label={name}
      data-kind={panel.kind}
      data-cancel={listening && panel.cancel ? "" : undefined}
      style={{ right, bottom, width, maxHeight, ["--tail" as string]: `${tail}px` }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !listening) {
          e.preventDefault();
          talk.dismiss();
        }
      }}
    >
      <i className="map-talk-tail" aria-hidden="true" />
      <div className="map-talk-head">
        <span className="map-talk-label">{head}</span>
        {!listening && (
          <>
            <button
              type="button"
              className="icon-btn map-talk-expand"
              aria-label={t("ui.plugins.map.fab.expand")}
              title={t("ui.plugins.map.fab.expand")}
              onClick={() => {
                talk.dismiss();
                onExpand();
              }}
            >
              <Icon name="expand" />
            </button>
            <button type="button" className="icon-btn map-talk-close" aria-label={t("bridge.bubble.close")} title={t("bridge.bubble.close")} onClick={() => talk.dismiss()}>
              <Icon name="cross" />
            </button>
          </>
        )}
      </div>
      {panel.kind === "bar" && <TalkInput talk={talk} />}
      {listening && <TalkListening levels={panel.levels} cancel={panel.cancel} />}
      {panel.kind === "busy" && <TalkBusy said={panel.said} note={panel.note} name={name} />}
      {panel.kind === "reply" && (
        <div className="map-talk-body">
          {panel.said && <p className="map-talk-said">{panel.said}</p>}
          <p className="map-talk-text" data-failed={panel.failed ? "" : undefined}>
            {panel.text}
          </p>
        </div>
      )}
    </div>
  );
}

/** 打字框跟着字长高（最多五行） */
function fitInput(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(116, el.scrollHeight + el.offsetHeight - el.clientHeight)}px`;
}

/** 打字：点了按钮就聚焦（手机上要在点的这一下里聚焦，输入法才弹得出来） */
function TalkInput({ talk }: { talk: MapTalk }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  const send = () => {
    if (text.trim()) talk.sendText(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (e.ctrlKey || e.metaKey || (!e.shiftKey && !coarse())) {
      e.preventDefault();
      send();
    }
  };
  return (
    <div className="map-talk-foot">
      <textarea
        ref={ref}
        rows={1}
        maxLength={PAGE_COMMAND_TEXT_MAX}
        value={text}
        placeholder={t("ui.plugins.map.fab.placeholder")}
        aria-label={t("ui.plugins.map.fab.input")}
        enterKeyHint="send"
        onChange={(e) => {
          setText(e.currentTarget.value);
          fitInput(e.currentTarget);
        }}
        onKeyDown={onKey}
      />
      <button type="button" className="map-talk-send" aria-label={t("bridge.bubble.send")} title={t("bridge.bubble.send")} disabled={!text.trim()} onClick={send}>
        <Icon name="send" />
      </button>
    </div>
  );
}

/** 在听：实时的波形、录了多久、松开发送还是取消 */
function TalkListening({ levels, cancel }: { levels: readonly number[]; cancel: boolean }) {
  // 录了多久：每 0.2 秒走一下
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - start), 200);
    return () => clearInterval(timer);
  }, []);
  const heights = waveBars(levels, WAVE_BARS);
  return (
    <div className="map-talk-body">
      <div className="map-talk-wave" aria-hidden="true">
        {heights.map((h, i) => (
          <i key={i} style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className="map-talk-voice">
        <span className="map-talk-time">{recordedText(elapsed)}</span>
        <span className="map-talk-hint">{t(cancel ? "bridge.bubble.releaseToCancel" : "bridge.bubble.releaseToSend")}</span>
      </div>
    </div>
  );
}

/** 在认、在想、排在后面 */
function TalkBusy({ said, note, name }: { said: string | undefined; note: keyof typeof BUSY_KEY; name: string }) {
  const busy = namedText(BUSY_KEY[note], name);
  return (
    <div className="map-talk-body">
      {said && <p className="map-talk-said">{said}</p>}
      <p className="map-talk-thinking" role="status">
        <span>
          <Named parts={busy.parts} text={busy.text} />
        </span>
      </p>
    </div>
  );
}
