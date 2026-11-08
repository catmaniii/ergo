// 地图右下角的二狗悬浮按钮（444）背后的那一套：照"浏览"里网页上的悬浮按钮（443，plugins/browsing/page-commands.ts 的 PageCommands）——
// 按钮背后就是秘书本人：
// - 点一下：按钮上方的气泡里打字，点发送——这句话作为一条消息发进秘书的主会话，带地图上下文（MapContext，via: "button"），
//   秘书页、右边的聊天窗里都看得到；
// - 按住：按下就备好录音器、算开始语音输入（二狗正在播的语音暂停），按够 0.35 秒开始录（气泡里画实时的波形），松手送识别
//   （内核的 POST /api/talk-voice：和浏览的悬浮按钮同一段识别，只依赖语音插件、不经浏览插件），认出来的字发进秘书的主会话（标着是说的）；上滑或划开后松手取消；
//   语音插件没启用时不录，写一句"语音插件没启用：点一下按钮打字"；
// - 发出去以后气泡里"二狗在想……"，秘书正忙时"排在后面"；这一轮说完了，它最后说的那句显示在气泡里（state/page-button.ts 的
//   buttonTurnOf 从秘书会话的权威事件里认）；成了的过一会儿收起；
// - 收起（×、点"展开到右边"、打开右边的聊天窗、离开地图页）：正在等回话时也能收——这句照样在秘书的会话里办完。
// 地图上没有"选中的框"，按钮只有一个地方（右下角）；录音、时长、气泡里的话和浏览的悬浮按钮共用（app/talk-button.ts）。
// 不碰 DOM 和浏览器的全局变量（录音、识别、地图上下文、发消息都由参数给），测试在 Node 里跑；画在 MapFab.tsx。
import { type BusyNote, LEVEL_MS, LEVELS_KEPT, LISTEN_MAX_MS, type PageTake, type PageVoice, PRESS_CAPTURE_MS, REPLY_HIDE_MS } from "../../app/talk-button.ts";
import { type ButtonTurn, type MapContext, PAGE_COMMAND_TEXT_MAX, type PageVoiceResult, t } from "../../state/index.ts";

/** 气泡的样子：收着、打字、在听（音量、在不在"松开取消"里）、在办、回话 */
export type MapTalkPanel =
  | { readonly kind: "idle" }
  | { readonly kind: "bar" }
  | { readonly kind: "listening"; readonly levels: readonly number[]; readonly cancel: boolean }
  | { readonly kind: "busy"; readonly said?: string; readonly note: BusyNote }
  | { readonly kind: "reply"; readonly text: string; readonly said?: string; readonly failed: boolean };

export const MAP_TALK_IDLE: MapTalkPanel = { kind: "idle" };

/** 发进秘书的主会话（地图页接上 store 后给：store.sendMessage），回这次发送请求的幂等键 */
export interface MapTalkLink {
  say(text: string, map: MapContext): string;
}

export interface MapTalkDeps {
  voice: PageVoice;
  /** 按住说的一段送识别（POST /api/talk-voice） */
  recognize(audio: { base64: string; mime: string }): Promise<PageVoiceResult>;
  /** 这一刻地图看的是哪里（发的时候现取；spoken 是按住说的）：via 由这里补上 */
  context(): Omit<MapContext, "via" | "spoken">;
  /** 开始 / 说完语音输入（页面上接到播放器的 setCapturing）。不给不管 */
  capture?(on: boolean): void;
}

export class MapTalk {
  private readonly deps: MapTalkDeps;
  private panel: MapTalkPanel = MAP_TALK_IDLE;
  private readonly listeners = new Set<() => void>();
  private link: MapTalkLink | undefined;
  private turnOf: ((key: string) => ButtonTurn) | undefined;
  /** 正在等秘书回的那一句：发消息的幂等键、说了什么、哪一次 */
  private waiting: { key: string; said: string; run: number } | undefined;
  /** 每次一个号：收起了、开了新的，旧的结果回来就不管了 */
  private run = 0;
  private starting: Promise<void> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private pressTimer: ReturnType<typeof setTimeout> | undefined;
  private capturing = false;
  private voiceOn = true;
  private context: MapTalkDeps["context"];

  constructor(deps: MapTalkDeps) {
    this.deps = deps;
    this.context = deps.context;
  }

  /** 换上取地图上下文的那个函数（地图页每次渲染换上最新的） */
  setContext(context: MapTalkDeps["context"]): void {
    this.context = context;
  }

  readonly snapshot = (): MapTalkPanel => this.panel;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** 接上发消息的那一头（地图页，store 建好之后） */
  connect(link: MapTalkLink | undefined): void {
    this.link = link;
  }

  /** 能不能说话（语音插件在不在）：停用时正录着的取消、放掉录音器，之后长按不录 */
  setVoice(on: boolean): void {
    if (on === this.voiceOn) return;
    this.voiceOn = on;
    if (on) return;
    if (this.panel.kind === "listening") this.cancelListening();
    this.deps.voice.release();
  }

  /** 只能打字（按钮的说明不说"按住说话"） */
  get typeOnly(): boolean {
    return !this.voiceOn;
  }

  /** 秘书会话变了（地图页每次状态变了交过来）：看看等着的那一句走到哪了 */
  secretaryChanged(turnOf: (key: string) => ButtonTurn): void {
    this.turnOf = turnOf;
    this.track();
  }

  /** 在录、在认、在等回话：按钮上再点、再按都不接 */
  get busy(): boolean {
    return this.panel.kind === "listening" || this.panel.kind === "busy";
  }

  private set(next: MapTalkPanel): void {
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    if (this.levelTimer !== undefined && next.kind !== "listening") {
      clearInterval(this.levelTimer);
      this.levelTimer = undefined;
    }
    if (this.panel.kind === "listening" && next.kind !== "listening") this.capture(false);
    this.panel = next;
    for (const listener of this.listeners) listener();
  }

  private capture(on: boolean): void {
    if (this.pressTimer !== undefined) clearTimeout(this.pressTimer);
    this.pressTimer = undefined;
    if (this.capturing === on) return;
    this.capturing = on;
    this.deps.capture?.(on);
  }

  /** 点了一下：气泡里打字（在办的时候不接） */
  open(): void {
    if (this.panel.kind !== "listening") this.capture(false);
    if (this.busy) return;
    this.stopWaiting();
    this.run++;
    this.set({ kind: "bar" });
  }

  /** 按下：备好录音器、算开始语音输入（二狗正在播的语音暂停）；过一会儿没开始录也没开打字框的自己算说完 */
  press(): void {
    if (this.busy || !this.voiceOn) return;
    this.deps.voice.prepare(true);
    this.capture(true);
    this.pressTimer = setTimeout(() => {
      this.pressTimer = undefined;
      if (this.panel.kind !== "listening") this.capture(false);
    }, PRESS_CAPTURE_MS);
  }

  /** 按够了：开始录（语音插件没启用时写一句） */
  listen(): void {
    if (this.busy) return;
    if (!this.voiceOn) {
      this.set({ kind: "reply", text: t("app.pageCommands.voiceOff"), failed: true });
      return;
    }
    const run = ++this.run;
    this.stopWaiting();
    this.set({ kind: "listening", levels: [], cancel: false });
    this.capture(true);
    this.levelTimer = setInterval(() => {
      const p = this.panel;
      if (p.kind !== "listening") return;
      this.set({ ...p, levels: [...p.levels, this.deps.voice.level()].slice(-LEVELS_KEPT) });
    }, LEVEL_MS);
    setTimeout(() => {
      if (this.run === run && this.panel.kind === "listening") void this.finish();
    }, LISTEN_MAX_MS);
    const starting = this.deps.voice.start();
    this.starting = starting;
    starting.catch((err: unknown) => {
      if (this.starting !== starting || this.panel.kind !== "listening") return;
      this.starting = undefined;
      this.set({ kind: "reply", text: err instanceof Error ? err.message : String(err), failed: true });
    });
  }

  /** 按着说话时手指在不在"松开取消"里 */
  setCancelZone(on: boolean): void {
    const p = this.panel;
    if (p.kind !== "listening" || p.cancel === on) return;
    this.set({ ...p, cancel: on });
  }

  /** 松手：在"松开取消"里就取消，不然送识别 */
  release(): void {
    const p = this.panel;
    if (p.kind !== "listening") return;
    if (p.cancel) this.cancelListening();
    else void this.finish();
  }

  /** 取消正在录的（手势被系统收走、上滑松手） */
  cancelListening(): void {
    if (this.panel.kind !== "listening") return;
    this.run++;
    this.starting = undefined;
    this.deps.voice.cancel();
    this.set(MAP_TALK_IDLE);
  }

  private async finish(): Promise<void> {
    if (this.panel.kind !== "listening") return;
    const starting = this.starting;
    this.starting = undefined;
    const run = ++this.run;
    this.set({ kind: "busy", note: "hearing" });
    let take: PageTake;
    try {
      if (starting) await starting;
      take = await this.deps.voice.stop();
    } catch (err) {
      take = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (run !== this.run) return;
    if (!take.ok) return this.fail(take.reason);
    let heard: PageVoiceResult;
    try {
      heard = await this.deps.recognize({ base64: take.base64, mime: take.mime });
    } catch (err) {
      heard = { ok: false, reason: t("app.pageCommands.notDelivered", { reason: err instanceof Error ? err.message : String(err) }) };
    }
    if (run !== this.run) return;
    if (!heard.ok) return this.fail(heard.reason);
    this.send(heard.text, true, run);
  }

  /** 气泡里点发送 */
  sendText(text: string): void {
    const said = text.trim();
    if (this.panel.kind !== "bar" || !said) return;
    this.send(said.slice(0, PAGE_COMMAND_TEXT_MAX), false, ++this.run);
  }

  private fail(reason: string, said?: string): void {
    this.set({ kind: "reply", text: reason, failed: true, ...(said ? { said } : {}) });
  }

  private send(said: string, spoken: boolean, run: number): void {
    if (!this.link) return this.fail(t("app.pageCommands.notConnected"), said);
    let key: string;
    try {
      key = this.link.say(said, { ...this.context(), via: "button", ...(spoken ? { spoken: true as const } : {}) });
    } catch (err) {
      return this.fail(t("app.pageCommands.notDelivered", { reason: err instanceof Error ? err.message : String(err) }), said);
    }
    if (run !== this.run) return;
    this.waiting = { key, said, run };
    this.set({ kind: "busy", said, note: "thinking" });
    this.track();
  }

  private track(): void {
    const w = this.waiting;
    if (!w || !this.turnOf) return;
    if (w.run !== this.run) {
      this.waiting = undefined;
      return;
    }
    const turn = this.turnOf(w.key);
    if (turn.phase === "sending" || turn.phase === "thinking" || turn.phase === "queued") {
      const note: BusyNote = turn.phase === "queued" ? "queued" : "thinking";
      if (this.panel.kind !== "busy" || this.panel.note !== note) this.set({ kind: "busy", said: w.said, note });
      return;
    }
    this.waiting = undefined;
    if (turn.phase === "failed") return this.set({ kind: "reply", text: turn.reason, failed: true, said: w.said });
    this.set({ kind: "reply", text: turn.text, failed: false, said: w.said });
    const shown = this.panel;
    this.hideTimer = setTimeout(() => {
      if (this.panel === shown) this.set(MAP_TALK_IDLE);
    }, REPLY_HIDE_MS);
  }

  private stopWaiting(): void {
    this.waiting = undefined;
  }

  /** 收起（正在录的丢掉；正在等回话也收——这句照样在秘书的会话里办完） */
  dismiss(): void {
    if (this.panel.kind === "idle") return;
    this.run++;
    if (this.panel.kind === "listening") this.deps.voice.cancel();
    this.starting = undefined;
    this.stopWaiting();
    this.set(MAP_TALK_IDLE);
  }

  /** 离开地图页：收起，放掉录音器 */
  hidden(): void {
    this.dismiss();
    this.capture(false);
    this.deps.voice.release();
  }
}
