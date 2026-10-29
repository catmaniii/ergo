// 挑图片窗口（149 号票，用户 2026-10-18："挑图片的窗口不跟着悬浮按钮，固定弹在屏幕上让用户挑。二狗的聊天窗里也能看到、能挑"）
// 在二狗网页这一侧：秘书给这台设备上这个浏览器的网页候选卡（147 号票的 browse_pick，不管是悬浮按钮那一轮还是侧边栏那一轮给的），
// 这一页的网页上弹一个固定位置的挑图片窗口（页面桥画，page-bridge/pick.ts），会话里（秘书页、侧边栏）照旧有那张卡——
// - 两边只认第一次的选择：都是对同一张卡做动作（守护进程按版本先到先得）；卡在别处处理了（会话里交了、都不要了、过期了），
//   窗口写一句（"在会话里交好了"）跟着收起；窗口里点"交"没交进去，原因记在卡上（failed），会话里的卡也看得到；
// - 先取缩略图（守护进程缩好的小图，GET /api/page-files/<取件码>/thumb，马上显示出来），再在后台依次预备原图（page-stage.ts：
//   交给 App 暂存，推荐的先取）；原图只在交进框时用；
// - 窗口里点"交"：本机先核对（单张的框只选一个、加起来不太大），马上用预备好的文件交进框（没预备好的现取），不等守护进程，也不等
//   任何一次模型调用；交完再带着结果去卡上记一笔（confirm 的 done），会话里的卡跟着变成处理过；
// - 窗口能收起（×、返回手势）：收起后会话里的卡照样能挑（预备的文件留着，会话里点了"交"守护进程转回来的 attach 也先用它们）；
//   卡处理完、过期、换了网页，预备的文件放掉。
// 181 号票：标题里说到助理用用户起的名字（纯文字换好名字，另给按名字切开的几段，页面桥画成名字标签）；改名、换语言后
// 页面上的 React 层照样交来卡（cardsChanged），标题跟着重算、变了就重交。
// 184 号票：卡上记着编号（ref：秘书按编号指的上传框，不是选中的框）的，交的时候按编号交（页面桥再核对还是那一页、还是上传框）。
// 不碰 DOM 和浏览器的全局变量（页面桥、取缩略图、对卡做动作都由参数给），测试在 Node 里跑。
import type { PageBubbleFile, PagePickAction, PagePickView } from "../../page-bridge/protocol.ts";
import { PAGE_PICK_NONE } from "../../page-bridge/protocol.ts";
import { type BrowsePickConfirmInput, type BrowsePickView, DEFAULT_ASSISTANT_NAME, initialPick, PAGE_CHOOSER_TARGET, PAGE_FILES_TOTAL_MAX_BYTES, type PageCommandFile, pageUrlForModel, t, togglePick } from "../../state/index.ts";
import type { NativeBrowserEvent, NativePageControl } from "../../app/native-browser.ts";
import { namedText } from "./page-bubble.ts";
import type { PageStage } from "./page-stage.ts";

/** 交好了、别处处理了之后窗口过多久收起（毫秒） */
export const PICK_DONE_HIDE_MS = 1500;
/** 同时取几张缩略图 */
const THUMB_CONCURRENCY = 3;
/** 缩略图最多记多少张（多的先丢最早的） */
const THUMBS_KEPT = 80;

export interface PagePickDeps {
  page: Pick<NativePageControl, "pick" | "deliver">;
  stage: Pick<PageStage, "prefetch" | "release" | "take" | "logDelivery">;
  /** 对卡做动作（页面上的 React 层给：store.cardAction） */
  cardAction(cardId: string, action: "confirm" | "dismiss", input?: BrowsePickConfirmInput): void;
  /** 一张候选的缩略图（守护进程缩好的，base64）；不是图片、做不出来是 undefined */
  thumbnail(file: PageCommandFile): Promise<string | undefined>;
  /** 浏览器现在开着的网页地址（开场时问一次，之后跟着 App 推的浏览器样子；只认这一页的候选，还没打开网页是 undefined） */
  currentUrl(): string | undefined;
  now(): number;
  /** 助理现在的名字（181 号票；没给、undefined 是默认的） */
  assistantName?(): string | undefined;
}

/** 窗口里本机交文件那一下（交好了、没交进去） */
type Local = { cardId: string; phase: "sending" } | { cardId: string; phase: "done"; note: string } | { cardId: string; phase: "failed"; note: string };

const samePage = (a: string | undefined, b: string) => a !== undefined && pageUrlForModel(a) === pageUrlForModel(b);

/** 候选按先后预备：推荐的先取，其余的依次 */
function prefetchOrder(view: BrowsePickView): PageCommandFile[] {
  const { files, recommended } = view.payload;
  return [...files.filter((f) => recommended.includes(f.token)), ...files.filter((f) => !recommended.includes(f.token))];
}

export class PagePickSync {
  private readonly deps: PagePickDeps;
  private cards: readonly BrowsePickView[] = [];
  /** 在为哪几张卡预备着 */
  private readonly prefetching = new Set<string>();
  /** 窗口收起了的卡（会话里照样能挑） */
  private readonly hidden = new Set<string>();
  /** 每张卡窗口里选中的（取件码） */
  private readonly selection = new Map<string, string[]>();
  private local: Local | undefined;
  /** 窗口上正显示的卡；它在别处处理了时写一句再收起 */
  private shown: string | undefined;
  private finishing: { cardId: string; note: string; ok: boolean } | undefined;
  private finishTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly thumbs = new Map<string, string | null>();
  private readonly thumbLoading = new Set<string>();
  private readonly thumbQueue: PageCommandFile[] = [];
  private last = "";
  /** 浏览器现在开着的网页 */
  private url: string | undefined;

  constructor(deps: PagePickDeps) {
    this.deps = deps;
    this.url = deps.currentUrl();
    // 二狗的网页刚打开（App 里重新加载过）：浏览器里的网页上可能还留着上次的窗口，先收起
    this.push(PAGE_PICK_NONE, true);
  }

  /** 这台设备的浏览器的网页候选卡变了（页面上的 React 层每次状态变了交过来） */
  cardsChanged(cards: readonly BrowsePickView[]): void {
    this.cards = cards;
    this.refresh();
  }

  /** App 推过来的：窗口上点了什么、返回手势收起窗口、浏览器换了网页 */
  handle(event: NativeBrowserEvent): void {
    if (event.type === "pick-close") {
      if (this.shown) this.hidden.add(this.shown);
      this.push(PAGE_PICK_NONE, true);
      this.refresh();
    } else if (event.type === "state") {
      if (event.state.url === this.url) return;
      this.url = event.state.url || undefined;
      this.refresh();
    } else if (event.type === "page" && event.event.type === "pick") {
      const { type: _type, ...action } = event.event;
      this.act(action as PagePickAction);
    } else if (event.type === "page" && event.event.type === "selected") {
      // 页面桥刚装上（新的一页）会报一次没选中：这一页上该弹的窗口再交一遍
      this.last = "";
      this.refresh();
    }
  }

  /** 还能挑的卡：待处理、没过期、是这一页的 */
  private active(view: BrowsePickView): boolean {
    return view.card.status === "pending" && Date.parse(view.payload.expiresAt) > this.deps.now() && samePage(this.url, view.payload.page.url);
  }

  private refresh(): void {
    const active = this.cards.filter((c) => this.active(c));
    // 预备：新的卡先取缩略图，再预备原图；用不上了的放掉
    for (const view of active) {
      if (this.prefetching.has(view.card.id)) continue;
      this.prefetching.add(view.card.id);
      void this.loadThumbs(view.payload.files).then(() => {
        if (this.prefetching.has(view.card.id)) this.deps.stage.prefetch(view.card.id, prefetchOrder(view));
      });
    }
    for (const id of this.prefetching) {
      if (active.some((c) => c.card.id === id)) continue;
      this.prefetching.delete(id);
      this.deps.stage.release(id);
    }
    // 窗口上正显示的那张在别处处理了：写一句、过一会儿收起
    const shownView = this.shown ? this.cards.find((c) => c.card.id === this.shown) : undefined;
    const ownSend = this.local?.cardId === shownView?.card.id && this.local?.phase !== "failed";
    if (shownView && !this.active(shownView) && !ownSend && !this.finishing && !this.hidden.has(shownView.card.id)) {
      if (this.local?.cardId === shownView.card.id) this.local = undefined;
      const status = shownView.card.status;
      const delivered = shownView.payload.delivered;
      const note =
        status === "handled"
          ? delivered === undefined
            ? t("app.pagePick.handledInChat")
            : t("app.pagePick.handledInChatCount", { count: delivered })
          : status === "dismissed"
            ? t("app.pagePick.dismissed")
            : status === "expired"
              ? t("app.pagePick.expired")
              : t("app.pagePick.pageChanged");
      this.finish(shownView.card.id, note, status === "handled");
    }
    this.render();
  }

  private finish(cardId: string, note: string, ok: boolean): void {
    this.finishing = { cardId, note, ok };
    if (this.finishTimer !== undefined) clearTimeout(this.finishTimer);
    this.finishTimer = setTimeout(() => {
      this.finishTimer = undefined;
      this.finishing = undefined;
      if (this.local?.cardId === cardId) this.local = undefined;
      this.hidden.add(cardId);
      this.render();
    }, PICK_DONE_HIDE_MS);
  }

  /** 窗口上该显示哪张：最新的一张还能挑、没收起的；在收尾的那张先留着 */
  private target(): BrowsePickView | undefined {
    if (this.finishing) return this.cards.find((c) => c.card.id === this.finishing?.cardId);
    if (this.local && this.local.phase !== "failed") {
      const sending = this.cards.find((c) => c.card.id === this.local?.cardId);
      if (sending) return sending;
    }
    return this.cards.filter((c) => this.active(c) && !this.hidden.has(c.card.id)).at(-1);
  }

  private selectedOf(view: BrowsePickView): string[] {
    let chosen = this.selection.get(view.card.id);
    if (!chosen) {
      chosen = initialPick(view.payload);
      this.selection.set(view.card.id, chosen);
    }
    return chosen;
  }

  private render(): void {
    const view = this.target();
    this.shown = view?.card.id;
    if (!view) return this.push(PAGE_PICK_NONE);
    const p = view.payload;
    const chosen = this.selectedOf(view);
    const files: PageBubbleFile[] = p.files.map((f) => ({ token: f.token, name: f.name, image: f.image, thumb: f.image ? (this.thumbs.get(f.token) ?? "") : "", checked: (view.card.status === "handled" && p.picked ? p.picked : chosen).includes(f.token) }));
    const hint = t(p.multiple ? "app.pagePick.hintMultiple" : "app.pagePick.hintSingle");
    let phase: Extract<PagePickView, { kind: "pick" }>["phase"] = "choosing";
    let note = hint;
    if (this.finishing?.cardId === view.card.id) {
      phase = this.finishing.ok ? "done" : "failed";
      note = this.finishing.note;
    } else if (this.local?.cardId === view.card.id) {
      phase = this.local.phase;
      note = this.local.phase === "sending" ? t("app.pagePick.sending") : this.local.note;
    } else if (view.pending?.status === "sending") {
      phase = "sending";
      note = t("app.pagePick.sending");
    } else if (view.pending?.status === "failed") {
      phase = "failed";
      note = view.pending.error;
    } else if (p.failed) {
      phase = "failed";
      note = t("app.pagePick.failedRetry", { reason: p.failed });
    }
    const title = namedText("app.pagePick.title", this.deps.assistantName?.() ?? DEFAULT_ASSISTANT_NAME, { field: p.field, count: p.files.length });
    this.push({ kind: "pick", id: view.card.id, title: title.text, ...(title.parts ? { titleParts: title.parts } : {}), note, files, multiple: p.multiple, phase });
  }

  private push(view: PagePickView, force = false): void {
    const json = JSON.stringify(view);
    if (!force && json === this.last) return;
    this.last = json;
    void this.deps.page.pick(view);
  }

  /** 窗口上点的 */
  private act(action: PagePickAction): void {
    const view = this.cards.find((c) => c.card.id === action.id);
    if (!view) return;
    switch (action.action) {
      case "choose":
        if (!this.active(view) || this.local?.phase === "sending" || this.local?.phase === "done") return;
        // 没交进去之后再挑：重新来
        if (this.local?.phase === "failed") this.local = undefined;
        this.selection.set(view.card.id, togglePick(this.selectedOf(view), action.token, view.payload.multiple, view.payload.files.map((f) => f.token)));
        this.render();
        return;
      case "deliver":
        void this.deliver(view);
        return;
      case "dismiss":
        if (!this.active(view) || this.local?.phase === "sending") return;
        this.hidden.add(view.card.id);
        this.deps.cardAction(view.card.id, "dismiss");
        this.render();
        return;
      case "hide":
        this.hidden.add(view.card.id);
        this.render();
        return;
    }
  }

  /** 窗口里点"交"：本机先核对，用预备好的文件马上交进框（不等守护进程），交完再去卡上记一笔 */
  private async deliver(view: BrowsePickView): Promise<void> {
    if (!this.active(view) || this.local?.phase === "sending" || this.local?.phase === "done") return;
    const p = view.payload;
    const tokens = this.selectedOf(view);
    const chosen = p.files.filter((f) => tokens.includes(f.token));
    if (chosen.length === 0) return;
    if (chosen.length > 1 && !p.multiple) return this.failLocal(view, tokens, t("app.pagePick.onlyOne"), false);
    if (chosen.reduce((sum, f) => sum + f.size, 0) > PAGE_FILES_TOTAL_MAX_BYTES) return this.failLocal(view, tokens, t("app.pagePick.tooBig"), false);
    const began = this.deps.now();
    this.local = { cardId: view.card.id, phase: "sending" };
    this.render();
    let reason: string | undefined;
    let delivered = 0;
    try {
      const taken = await this.deps.stage.take(chosen);
      const putDone = this.deps.now();
      // 184 号票：秘书按编号指的上传框按编号交（页面桥核对还是那一页、编号认得、还是上传框）
      const target = p.ref ? { ref: p.ref, url: p.page.url } : p.fieldId === PAGE_CHOOSER_TARGET ? ("chooser" as const) : { fieldId: p.fieldId };
      const outcome = await this.deps.page.deliver(target, taken.files);
      this.deps.stage.logDelivery("挑图片窗口", taken, this.deps.now() - putDone, this.deps.now() - began); // @i18n-ignore log：日志里写的来路
      if (outcome.ok) delivered = outcome.count ?? taken.files.length;
      else reason = outcome.reason ?? t("app.pagePick.notDelivered");
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    if (reason !== undefined) return this.failLocal(view, tokens, reason, true);
    this.local = { cardId: view.card.id, phase: "done", note: t("app.pagePick.delivered", { count: delivered }) };
    // 卡上记一笔（会话里的卡跟着变成处理过）；预备了没用上的放掉
    this.deps.cardAction(view.card.id, "confirm", { tokens: [...tokens], done: { delivered } });
    this.prefetching.delete(view.card.id);
    this.deps.stage.release(view.card.id);
    this.finish(view.card.id, t("app.pagePick.delivered", { count: delivered }), true);
    this.render();
  }

  /** 没交进去：窗口上写原因、还能再点；tell 的话也记到卡上（会话里的卡也看得到） */
  private failLocal(view: BrowsePickView, tokens: readonly string[], reason: string, tell: boolean): void {
    this.local = { cardId: view.card.id, phase: "failed", note: t("app.pagePick.failedLocal", { reason }) };
    if (tell) this.deps.cardAction(view.card.id, "confirm", { tokens: [...tokens], done: { failed: reason.slice(0, 500) } });
    this.render();
  }

  /** 取缩略图（同一张只取一次，同时最多几张）；都取完了回 */
  private loadThumbs(files: readonly PageCommandFile[]): Promise<void> {
    const wanted = files.filter((f) => f.image && !this.thumbs.has(f.token));
    for (const file of wanted) if (!this.thumbLoading.has(file.token) && !this.thumbQueue.some((q) => q.token === file.token)) this.thumbQueue.push(file);
    const waits: Promise<void>[] = [];
    const next = (): Promise<void> => {
      const file = this.thumbQueue.shift();
      if (!file) return Promise.resolve();
      this.thumbLoading.add(file.token);
      return this.deps
        .thumbnail(file)
        .catch(() => undefined)
        .then((thumb) => {
          this.thumbLoading.delete(file.token);
          this.thumbs.set(file.token, thumb ?? null);
          while (this.thumbs.size > THUMBS_KEPT) this.thumbs.delete(this.thumbs.keys().next().value!);
          this.render();
          return next();
        });
    };
    for (let i = this.thumbLoading.size; i < THUMB_CONCURRENCY; i++) waits.push(next());
    return Promise.all(waits).then(() => undefined);
  }
}
