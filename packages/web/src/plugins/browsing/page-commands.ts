// 网页上下指令（134 号票第二部分）在二狗网页这一侧：接 App 转过来的页面桥的话（悬浮按钮点了、长按说话、气泡上点了什么）和
// App 拦下的选文件对话框，管"面板"的样子（PagePanel，146 号票起画在悬浮按钮旁边的小气泡里：app/page-bubble.ts 换成气泡的样子交给页面桥）。
// 149 号票（用户 2026-10-18："干脆悬浮按钮的二狗和秘书的二狗是一个实体好了"）起悬浮按钮背后就是秘书本人，不再有一次性的页面助手：
// - 点一下悬浮按钮：气泡里打字，点发送（页面桥报 bubble send，带着按钮所在的框和框里这一刻的内容）——这句话作为一条消息发进秘书的
//   主会话（和浏览侧边栏发的同一种：BrowsingContext，via: "button"，按钮所在的框就是这一轮的目标框），秘书页、侧边栏里都看得到；
// - 长按悬浮按钮：按下就让 App 备好录音器，按够了开始录，录着的时候每 80 毫秒取一次音量（气泡里画实时的波形），松手先送识别
//   （POST /api/page-command/voice），认出来的字先在气泡里显示，再发进秘书的主会话（标着是说的）；上滑或划开后松手取消；
//   209 号票：按下那一刻起算开始语音输入（deps.capture，页面上接到播放器的 setCapturing：二狗正在播的语音暂停、排着的等说完），
//   松手、取消、收起、录不了、短按开打字框都算说完；按下了却没开始录也没开打字框的（手势被系统收走，页面桥什么都不报）
//   过 PRESS_CAPTURE_MS 自己算说完；
// - 网页弹出选文件对话框（App 拦下了）：气泡问"让二狗选 / 自己选"，让二狗选的接着打字（这一轮的目标是这个对话框），自己选的交给系统的选择器；
// - 发出去以后气泡里"二狗在想……"；秘书正忙着一轮时这句排在队里（144 号票），气泡里写"二狗正忙，排在后面，这一轮说完就看"；
//   秘书这一轮说完了，它最后说的那句显示在气泡里（同时是秘书会话里一条普通的秘书消息）。走到哪了从秘书会话的权威事件里认
//   （state/page-button.ts 的 buttonTurnOf，页面上的 React 层每次状态变了交过来：secretaryChanged）；
// - 填字、找文件、交文件、给候选都是秘书在这一轮用网页工具做的（守护进程转给这台设备的浏览侧边栏那一份办，browse-side.ts）；
//   候选画在固定位置的挑图片窗口里（page-pick.ts），不在气泡里；
// - 收起（点 ×、点气泡外面的网页、按返回、框被滚出屏幕、浏览器开始加载别的网页）：正在等二狗回话时也能收起——不再等这一轮的回话，
//   这句话照样在秘书的会话里办完、回话照样在会话里。
// 这里不碰 DOM 和浏览器的全局变量（录音、计时、发消息都由参数给），测试在 Node 里跑。
import type { PageBridgeEvent, PageBubbleAction, PageInfo } from "../../page-bridge/protocol.ts";
import { type BrowsingContext, type ButtonTurn, PAGE_COMMAND_TEXT_MAX, type PageField, type PageVoiceResult, pageUrlForModel, t } from "../../state/index.ts";
import type { ChooserRequest, NativeBrowserEvent, NativePageControl } from "../../app/native-browser.ts";
import { isRecordingCancelled, micErrorOf, type VoiceCaptureBackend } from "../../app/voice-recorder.ts";

/** 指令作用于谁：页面信息和框的列表，悬浮按钮所在的框（带着框里的内容），或拦下的选文件对话框 */
export interface CommandTarget {
  readonly page: PageInfo;
  readonly fields: readonly PageField[];
  /** 悬浮按钮所在的框；拦下的对话框认出了是哪个框时也有 */
  readonly field?: PageField;
  readonly chooser?: ChooserRequest;
}

/** 在办的那一句走到哪了：hearing 在认说了什么、thinking 秘书在办、queued 秘书正忙，排在后面（149 号票） */
export type BusyNote = "hearing" | "thinking" | "queued";

/** 面板的样子 */
export type PagePanel =
  | { readonly kind: "idle" }
  | { readonly kind: "chooser"; readonly chooser: ChooserRequest }
  | { readonly kind: "bar"; readonly target: CommandTarget }
  /** levels：录着的时候的音量（0–1，新的在后，最近 LEVELS_KEPT 个；气泡里画波形） */
  | { readonly kind: "listening"; readonly target: CommandTarget; readonly levels: readonly number[] }
  | { readonly kind: "busy"; readonly target: CommandTarget; readonly said?: string; readonly note: BusyNote }
  | { readonly kind: "reply"; readonly target: CommandTarget; readonly text: string; readonly said?: string; readonly failed: boolean };

export const IDLE_PANEL: PagePanel = { kind: "idle" };

/** 录的一段：音频的 base64 和类型；整段是静音、没录下来是 undefined（reason 是给人看的话） */
export type PageTake = { ok: true; base64: string; mime: string } | { ok: false; reason: string };

/** 录音（App 的原生录音器；page-browse.ts 接上） */
export interface PageVoice {
  /** 现在的音量（0–1；不在录是 0） */
  level(): number;
  /** 备好录音器（不录）；userAction：按下引起的（被拒过权限时 App 再问一次）。备不好不抛错，start 时再说 */
  prepare(userAction: boolean): void;
  /** 开始录（等备好）；录不了抛错（message 是给人看的话） */
  start(): Promise<void>;
  stop(): Promise<PageTake>;
  cancel(): void;
  /** 放掉录音器 */
  release(): void;
}

/** 发进秘书的主会话（页面上的 React 层接上 store 后给：store.sendMessage），回这次发送请求的幂等键 */
export interface PageCommandsLink {
  say(text: string, browsing: BrowsingContext): string;
}

export interface PageCommandsDeps {
  page: NativePageControl;
  /** 悬浮按钮上说的一段送识别（POST /api/page-command/voice） */
  recognize(audio: { base64: string; mime: string }): Promise<PageVoiceResult>;
  voice: PageVoice;
  /** 浏览器现在的地址和标题（页面桥不在、拦下对话框时用） */
  browserPage(): PageInfo;
  /** 这台设备上这一页二狗网页的浏览器编号（浏览侧边栏那一份，browse-side.ts）；旧版 App 没有浏览侧边栏是 undefined */
  browserId(): string | undefined;
  /** 开始 / 说完语音输入（209 号票；页面上接到播放器的 setCapturing：二狗正在播的语音暂停、排着的等说完）。不给不管 */
  capture?(on: boolean): void;
}

/** 成了的回话过多久收起（毫秒）；没成的不收 */
export const REPLY_HIDE_MS = 6000;
/** 录着的时候多久取一次音量（毫秒）；留最近几个（气泡里的波形用得上的） */
export const LEVEL_MS = 80;
export const LEVELS_KEPT = 40;
/** 悬浮按钮收起后多久放掉录音器（毫秒）：焦点在框之间换来换去时不反复备 */
const RELEASE_AFTER_MS = 20_000;
/** 最长录多久（毫秒）：到了自己发，和语音消息一样 60 秒 */
export const LISTEN_MAX_MS = 60_000;
/**
 * 按下了多久还没开始录、也没开打字框，就算说完（毫秒，209 号票）：页面桥按够 350 毫秒报开始录、短按松手报开打字框，
 * 手势被系统收走时什么都不报；留足余量
 */
export const PRESS_CAPTURE_MS = 2_000;

/** 面板上说这个指令作用于谁："「标题」这个框""这个上传框""选文件" */
export function targetName(target: CommandTarget): string {
  const field = target.field;
  const name = field ? field.label || field.placeholder || "" : "";
  if (target.chooser && !name) return t("app.pageCommands.target.chooser");
  if (!field) return t("app.pageCommands.target.field");
  if (name) return t("app.pageCommands.target.named", { name });
  return t(field.kind === "file" ? "app.pageCommands.target.upload" : "app.pageCommands.target.field");
}

/** 指令要的是文件（上传框、拦下的对话框）还是字 */
export function wantsFiles(target: CommandTarget): boolean {
  return target.chooser !== undefined || target.field?.kind === "file";
}

/** 文件大小写成人看的 */
export function fileSizeText(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 悬浮按钮上发的这一句的网页上下文（149 号票）：按钮所在的框就是这一轮的目标框（带着框里的内容），拦下的对话框另写 */
export function buttonContext(browser: string, target: CommandTarget, spoken: boolean): BrowsingContext {
  return {
    browser,
    page: { title: target.page.title.slice(0, 300), url: pageUrlForModel(target.page.url).slice(0, 2048) },
    ...(target.field ? { selected: target.field } : {}),
    via: "button",
    ...(spoken ? { spoken: true as const } : {}),
    ...(target.chooser ? { chooser: { accept: [...target.chooser.accept], multiple: target.chooser.multiple } } : {}),
  };
}

export class PageCommands {
  private readonly deps: PageCommandsDeps;
  private panel: PagePanel = IDLE_PANEL;
  private readonly listeners = new Set<() => void>();
  /** 正在录的那一段的开始（stop 要等它） */
  private starting: Promise<void> | undefined;
  /** 拦下的对话框还等着结果 */
  private chooserPending = false;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  /** 浏览器在加载（state 推过来的）：从不在加载变成在加载就是开始开别的网页了 */
  private loading = false;
  /** 每次指令一个号：用户关了面板、开了新的，旧的结果回来就不管了 */
  private run = 0;
  /** 发进秘书主会话的那一头（页面上的 React 层接上） */
  private link: PageCommandsLink | undefined;
  /** 现在认得出悬浮按钮上发的那句走到哪了（React 层每次状态变了交过来） */
  private turnOf: ((key: string) => ButtonTurn) | undefined;
  /** 正在等秘书回的那一句：发消息的幂等键、在哪、说了什么、哪一次指令 */
  private waiting: { key: string; target: CommandTarget; said: string; run: number } | undefined;
  /** 正在语音输入（按下了、在录）：告诉过播放器了（209 号票） */
  private capturing = false;
  /** 按下了还没开始录：过一会儿自己算说完 */
  private pressTimer: ReturnType<typeof setTimeout> | undefined;
  /** 能不能说话（214 号票：语音插件在不在，setVoice）；不能时长按不录，写一句"语音插件没启用"，点一下照常打字 */
  private voiceOn = true;

  constructor(deps: PageCommandsDeps) {
    this.deps = deps;
  }

  readonly snapshot = (): PagePanel => this.panel;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** 接上发消息的那一头（页面上的 React 层，store 建好之后） */
  connect(link: PageCommandsLink): void {
    this.link = link;
  }

  /**
   * 语音插件在不在（212、214 号票：浏览插件挂在主框架里的那一个看输入框的语音插槽有没有东西，变了告诉这里）。停用时正录着的马上取消、
   * 放掉录音器；之后长按不录（页面桥自己先换成"在听"，这里改回平常、写一句没启用）
   */
  setVoice(on: boolean): void {
    if (on === this.voiceOn) return;
    this.voiceOn = on;
    if (on) return;
    if (this.panel.kind === "listening") this.cancelListening();
    if (this.releaseTimer !== undefined) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    this.deps.voice.release();
  }

  /** 秘书会话变了（页面上的 React 层每次状态变了交过来）：看看等着的那一句走到哪了 */
  secretaryChanged(turnOf: (key: string) => ButtonTurn): void {
    this.turnOf = turnOf;
    this.track();
  }

  private set(next: PagePanel): void {
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    if (this.levelTimer !== undefined && next.kind !== "listening") {
      clearInterval(this.levelTimer);
      this.levelTimer = undefined;
    }
    // 不录了（松手、取消、收起、录不了……）：语音输入说完了（209 号票）
    if (this.panel.kind === "listening" && next.kind !== "listening") this.capture(false);
    this.panel = next;
    for (const listener of this.listeners) listener();
  }

  /** 开始 / 说完语音输入：变了才告诉播放器；按下的计时一并清掉 */
  private capture(on: boolean): void {
    if (this.pressTimer !== undefined) clearTimeout(this.pressTimer);
    this.pressTimer = undefined;
    if (this.capturing === on) return;
    this.capturing = on;
    this.deps.capture?.(on);
  }

  /** 在录、在认、在等秘书回话：悬浮按钮上再点、再按都不接（页面桥那边按钮也是"在办"的样子） */
  private busy(): boolean {
    const k = this.panel.kind;
    return k === "listening" || k === "busy";
  }

  /**
   * App 推过来的（native-browser.ts 的 NativeBrowserEvent）：page 页面桥的话、chooser 拦下的选文件对话框、bubble-close 返回手势收起气泡、
   * state 浏览器开始加载别的网页时收起（气泡跟着的框不在了）
   */
  handle(event: NativeBrowserEvent): void {
    if (event.type === "page") this.pageEvent(event.event);
    else if (event.type === "chooser") this.chooser(event.chooser);
    else if (event.type === "bubble-close") this.dismiss();
    else if (event.type === "state") {
      const started = event.state.loading && !this.loading;
      this.loading = event.state.loading;
      if (started && this.panel.kind !== "idle") this.dismiss();
    }
  }

  private pageEvent(event: PageBridgeEvent): void {
    if (event.type === "field") {
      // 悬浮按钮出来了：先备好录音器（不录），长按时按下就能录；收起来一阵子没再出来就放掉
      if (this.releaseTimer !== undefined) clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
      if (!this.voiceOn) return;
      if (event.field) this.deps.voice.prepare(false);
      else if (!this.busy()) this.releaseTimer = setTimeout(() => this.deps.voice.release(), RELEASE_AFTER_MS);
      return;
    }
    // 选中的框（147 号票）由浏览侧边栏管（browse-side.ts）；挑图片窗口（149 号票）由 page-pick.ts 管
    if (event.type === "chooser-field" || event.type === "selected" || event.type === "pick") return;
    if (event.type === "bubble") {
      this.bubbleAction(event);
      return;
    }
    const target: CommandTarget = { page: event.page, fields: event.fields, field: event.field };
    if (event.type === "open") {
      // 短按（松手开打字框）：按下时算的语音输入说完了
      if (this.panel.kind !== "listening") this.capture(false);
      if (!this.busy()) this.openBar(target);
      return;
    }
    if (!this.voiceOn) {
      // 语音插件没启用（214 号票）：不录。页面桥按够了自己换成"在听"、松手自己换成"在办"，每次都改回平常；按够了时写一句
      if (this.busy()) return;
      if (event.phase === "start") this.fail(target, t("app.pageCommands.voiceOff"));
      else if (event.phase !== "press") this.markIdle(target);
      return;
    }
    if (event.phase === "press") {
      if (this.busy()) return;
      this.deps.voice.prepare(true);
      // 按下那一刻就算开始语音输入（209 号票）：二狗正在播的语音暂停，不等录音器；没接着开始录的过一会儿自己算说完
      this.capture(true);
      this.pressTimer = setTimeout(() => {
        this.pressTimer = undefined;
        if (this.panel.kind !== "listening") this.capture(false);
      }, PRESS_CAPTURE_MS);
    } else if (event.phase === "start") {
      if (!this.busy()) this.listen(target);
    } else if (event.phase === "stop") {
      // 松手那一刻页面桥给的框带着框里这一刻的内容
      if (this.panel.kind === "listening") void this.finishListening(this.panel.target.field?.id === event.field.id ? { ...this.panel.target, page: event.page, field: event.field } : this.panel.target);
    } else if (this.panel.kind === "listening") {
      this.cancelListening();
    }
  }

  /** 气泡上点的（146 号票） */
  private bubbleAction(action: PageBubbleAction): void {
    switch (action.action) {
      case "send":
        this.sendText(action.text, action.field);
        return;
      case "close":
      // 回话太长、去侧边栏看（147 号票）：气泡收起，侧边栏由浏览侧边栏打开（browse-side.ts）
      case "sidebar":
        this.dismiss();
        return;
      case "ergo":
        void this.chooseByErgo();
        return;
      case "system":
        this.chooseBySystem();
        return;
    }
  }

  private openBar(target: CommandTarget): void {
    this.dropChooser(target);
    this.stopWaiting();
    this.set({ kind: "bar", target });
  }

  /** 换了指令对象：之前拦下的对话框没用了，告诉 App 取消 */
  private dropChooser(next: CommandTarget | undefined): void {
    if (this.chooserPending && next?.chooser === undefined) {
      this.chooserPending = false;
      void this.deps.page.chooser("cancel");
    }
  }

  /** 网页弹出选文件对话框、App 拦下了：问"让二狗选 / 自己选" */
  private chooser(chooser: ChooserRequest): void {
    this.run++;
    this.stopWaiting();
    if (this.panel.kind === "listening") this.deps.voice.cancel();
    this.chooserPending = true;
    this.set({ kind: "chooser", chooser });
  }

  /** 让二狗选：开输入条（页面信息和框的列表现问页面桥；页面桥不在就只有地址和标题） */
  async chooseByErgo(): Promise<void> {
    if (this.panel.kind !== "chooser") return;
    const chooser = this.panel.chooser;
    const run = ++this.run;
    const listed = await this.deps.page.fields();
    if (run !== this.run || this.panel.kind !== "chooser") return;
    const page = listed?.page ?? this.deps.browserPage();
    const fields = listed?.fields ?? [];
    const field = chooser.fieldId ? fields.find((f) => f.id === chooser.fieldId) : undefined;
    this.set({ kind: "bar", target: { page, fields, chooser, ...(field ? { field } : {}) } });
  }

  /** 自己选：交给系统的选择器（App 弹） */
  chooseBySystem(): void {
    if (!this.chooserPending) return;
    this.chooserPending = false;
    this.run++;
    this.stopWaiting();
    void this.deps.page.chooser("system");
    this.set(IDLE_PANEL);
  }

  /** 不再等秘书回那一句（按钮回到平常；那一句照样在秘书的会话里办完） */
  private stopWaiting(): void {
    const w = this.waiting;
    this.waiting = undefined;
    if (w) this.markIdle(w.target);
  }

  /**
   * 收起（正在录的丢掉）。正在等二狗回话时也能收起：不再等这一轮的回话（这句照样在秘书的会话里办完）。
   * 拦下的对话框：还没发出去就收起的告诉 App 取消；已经交给秘书了的留着（秘书交文件、候选卡交进去时还要用它）
   */
  dismiss(): void {
    const p = this.panel;
    this.run++;
    if (p.kind === "listening") this.deps.voice.cancel();
    const waited = this.waiting !== undefined;
    this.stopWaiting();
    if (!waited && (p.kind === "listening" || p.kind === "busy")) this.markIdle(p.target);
    if (p.kind === "chooser" || p.kind === "bar" || p.kind === "listening") this.dropChooser(undefined);
    this.set(IDLE_PANEL);
  }

  /** 气泡里点发送：打的字交出去；field 是页面桥给的按钮所在的框（带着框里这一刻的内容） */
  sendText(text: string, field?: PageField): void {
    const said = text.trim();
    if (this.panel.kind !== "bar" || !said) return;
    const target = this.panel.target;
    const fresh = field && target.field?.id === field.id ? { ...target, field } : target;
    void this.send(fresh, said.slice(0, PAGE_COMMAND_TEXT_MAX), false);
  }

  private listen(target: CommandTarget): void {
    const run = ++this.run;
    this.dropChooser(target);
    this.stopWaiting();
    this.set({ kind: "listening", target, levels: [] });
    // 开始录（没报过按下的旧版页面桥也算开始语音输入）
    this.capture(true);
    // 录着的时候取音量（气泡里的实时波形）
    this.levelTimer = setInterval(() => {
      const p = this.panel;
      if (p.kind !== "listening") return;
      this.set({ ...p, levels: [...p.levels, this.deps.voice.level()].slice(-LEVELS_KEPT) });
    }, LEVEL_MS);
    setTimeout(() => {
      if (this.run === run && this.panel.kind === "listening") void this.finishListening(this.panel.target);
    }, LISTEN_MAX_MS);
    const starting = this.deps.voice.start();
    this.starting = starting;
    starting.catch((err: unknown) => {
      if (this.starting !== starting || this.panel.kind !== "listening") return;
      this.starting = undefined;
      this.markIdle(target);
      this.set({ kind: "reply", target, text: err instanceof Error ? err.message : String(err), failed: true });
    });
  }

  private cancelListening(): void {
    const target = this.panel.kind === "listening" ? this.panel.target : undefined;
    this.starting = undefined;
    this.deps.voice.cancel();
    if (target) this.markIdle(target);
    this.set(target?.chooser ? { kind: "bar", target } : IDLE_PANEL);
  }

  /** 松手：录下来的送识别，认出来的字先显示，再发进秘书的主会话 */
  private async finishListening(target: CommandTarget): Promise<void> {
    if (this.panel.kind !== "listening") return;
    const starting = this.starting;
    this.starting = undefined;
    const run = ++this.run;
    this.set({ kind: "busy", target, note: "hearing" });
    if (target.field && !target.chooser) this.deps.page.mark(target.field.id, "busy");
    let take: PageTake;
    try {
      if (starting) await starting;
      take = await this.deps.voice.stop();
    } catch (err) {
      take = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (run !== this.run) return;
    if (!take.ok) return this.fail(target, take.reason);
    let heard: PageVoiceResult;
    try {
      heard = await this.deps.recognize({ base64: take.base64, mime: take.mime });
    } catch (err) {
      heard = { ok: false, reason: t("app.pageCommands.notDelivered", { reason: err instanceof Error ? err.message : String(err) }) };
    }
    if (run !== this.run) return;
    if (!heard.ok) return this.fail(target, heard.reason);
    await this.send(target, heard.text, true, run);
  }

  private fail(target: CommandTarget, reason: string, said?: string): void {
    this.markIdle(target);
    this.set({ kind: "reply", target, text: reason, failed: true, ...(said ? { said } : {}) });
  }

  /** 发进秘书的主会话（带网页上下文），等秘书这一轮回话 */
  private async send(target: CommandTarget, said: string, spoken: boolean, run = ++this.run): Promise<void> {
    const browser = this.deps.browserId();
    if (!browser) return this.fail(target, t("app.pageCommands.appTooOld"), said);
    if (!this.link) return this.fail(target, t("app.pageCommands.notConnected"), said);
    let key: string;
    try {
      key = this.link.say(said, buttonContext(browser, target, spoken));
    } catch (err) {
      return this.fail(target, t("app.pageCommands.notDelivered", { reason: err instanceof Error ? err.message : String(err) }), said);
    }
    if (run !== this.run) return;
    this.waiting = { key, target, said, run };
    if (target.field && !target.chooser) this.deps.page.mark(target.field.id, "busy");
    this.set({ kind: "busy", target, said, note: "thinking" });
    this.track();
  }

  /** 等着的那一句走到哪了：排着、在办、说完了、没发出去 */
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
      if (this.panel.kind !== "busy" || this.panel.note !== note) this.set({ kind: "busy", target: w.target, said: w.said, note });
      return;
    }
    this.waiting = undefined;
    this.markIdle(w.target);
    if (turn.phase === "failed") {
      this.set({ kind: "reply", target: w.target, text: turn.reason, failed: true, said: w.said });
      return;
    }
    this.set({ kind: "reply", target: w.target, text: turn.text, failed: false, said: w.said });
    if (!w.target.chooser) this.hideLater();
  }

  private markIdle(target: CommandTarget): void {
    if (target.field && !target.chooser) this.deps.page.mark(target.field.id, "idle");
  }

  private hideLater(ms = REPLY_HIDE_MS): void {
    const shown = this.panel;
    this.hideTimer = setTimeout(() => {
      if (this.panel === shown) this.set(IDLE_PANEL);
    }, ms);
  }

  /** "浏览"页签藏起来了：正在录的丢掉，放掉录音器 */
  hidden(): void {
    if (this.panel.kind === "listening") this.cancelListening();
    this.deps.voice.release();
  }
}

/** Blob 的 base64（分段转，长录音也不爆调用栈） */
async function base64OfBlob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * 录音接到"按住说话"的同一套后端上（App 里是原生录音器 NativeVoiceRecorder，浏览器里是 VoiceRecorder；create 第一次用到时才建）：
 * prepare 备好（不录）、start 等备好了开始、stop 交出这一段（整段是静音的不发）
 */
export function pageVoiceOver(create: () => VoiceCaptureBackend, now: () => number): PageVoice {
  let backend: VoiceCaptureBackend | undefined;
  let opening: Promise<void> | undefined;
  let failure: string | undefined;
  const get = (): VoiceCaptureBackend => (backend ??= create());
  const prepare = (userAction: boolean) => {
    const b = get();
    if (b.warm) return;
    if (opening && !userAction) return;
    failure = undefined;
    const o = b.open(userAction ? "press" : "enter", { userAction }).catch((err: unknown) => {
      if (!isRecordingCancelled(err)) failure = micErrorOf(err).text;
    });
    opening = o;
    void o.finally(() => {
      if (opening === o) opening = undefined;
    });
  };
  return {
    prepare,
    async start() {
      const b = get();
      const pressedAt = now();
      const prewarmed = b.warm;
      if (!b.warm) {
        if (!opening) prepare(true);
        await opening;
      }
      if (!b.warm) throw new Error(failure ?? t("app.pageCommands.recorderNotReady"));
      b.begin({ pressedAt, prewarmed });
    },
    async stop() {
      const recording = await get().stop();
      if (recording.silent) return { ok: false, reason: t("app.pageCommands.silent") };
      return { ok: true, base64: await base64OfBlob(recording.blob), mime: recording.mime };
    },
    level: () => backend?.level() ?? 0,
    cancel: () => backend?.cancel(),
    release() {
      opening = undefined;
      backend?.close("leave");
    },
  };
}
