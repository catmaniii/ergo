// 长按网页元素的圆钮：秘书这一轮要元素的内容、要下载时，设备这边怎么取（BrowseSide 收到 element_file、element_download 调这里）。
// 取内容的路子照试验定的（第 5 问），按先后试：
// - http、https：App 带登录状态和来源页取（页面里 fetch 跨站会被挡）。取回来是网页不是图的，当没取到；
// - data:、blob:、canvas：只有页面读得到，页面桥读好分段交来；
// - 都不成（防盗链也挡不住的、SVG、跨站的图画过的 canvas）：截这个元素的图，告诉秘书这是截图。
// 取到的传进媒体库（和聊天里发附件同一条路），交回媒体编号。链接指向网页的不取：秘书用 browse_open 打开再读。
// 下载：地址走 App 的下载（下完弹"保存到"、进下载记录）；没有地址的（data:、blob:、canvas、SVG）字节写进 App 的缓存再弹"保存到"。
// 这里不碰 DOM，测试在 Node 里跑。
// @i18n-ignore-file model：交回去的原因进秘书的工具结果（给模型看）
import type { AppElementFailure, NativeElementFiles, NativePageControl, PageElementChunk } from "../../app/native-browser.ts";
import { type BrowserOutcome, ELEMENT_FILE_MAX_BYTES, type ElementFile, type PickedElement, type UploadedMedia } from "../../state/index.ts";

export interface ElementFilesDeps {
  page: Pick<NativePageControl, "elementInfo" | "elementPrepare" | "elementChunk" | "elementRect" | "elementShotDone">;
  /** App 的这一组；旧版 App 没有 */
  files?: NativeElementFiles;
  /** 传进媒体库 */
  upload(bytes: Uint8Array, name: string, mime: string): Promise<UploadedMedia>;
  /** 等一会儿（藏起页面桥这一层后等它重画、等页面读 blob） */
  sleep(ms: number): Promise<void>;
}

const BRIDGE_GONE = "网页上的二狗页面桥不在（网页还没加载完，或者这一页没法装）";
const APP_TOO_OLD = "这台设备上的二狗 App 太旧，装新版才能取网页元素的内容、下载";
const TEXT_NO_FILE = "这个元素是文字，没有文件可取：文字已经写在消息里了";
const NO_ADDRESS = "这个元素没有能取的地址";
const PAGE_LINK = "这个链接指向的是网页，不是文件";

/** 藏起页面桥这一层后等多久再截（毫秒）：等它重画 */
const SHOT_SETTLE_MS = 150;
/** 等页面读 blob 时多久问一次、最多问几次（毫秒） */
const CHUNK_POLL_MS = 100;
const CHUNK_POLL_MAX = 100;

const isHtml = (mime: string) => /^(text\/html|application\/xhtml\+xml)/i.test(mime);

/** App 没取成，写给秘书看的原因 */
export function failureText(failure: AppElementFailure): string {
  switch (failure.code) {
    case "too-large":
      return "文件太大";
    case "http":
      return `网站回了错误（HTTP ${failure.status ?? "?"}）`;
    case "network":
      return "连不上这个地址（设备断网了，或者网站不通）";
    case "bad-url":
      return "地址不是 http、https";
    case "shot":
      return "截图没截成";
    case "no-web":
      return "「浏览」里的网页不在了";
    case "old":
      return APP_TOO_OLD;
    default:
      return `App 没办成（${failure.code}）`;
  }
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** 没有地址的元素（data:、blob:、canvas、截图）起个名字：说明文字、不然按种类，加上类型的后缀 */
export function elementFileName(element: PickedElement, mime: string): string {
  const base = (element.label ?? "").replace(/[\\/:*?"<>|\s]+/g, " ").trim().slice(0, 40) || element.kind;
  const ext = EXTENSIONS[mime.split(";")[0]!.trim().toLowerCase()];
  return ext ? `${base}.${ext}` : base;
}

function bytesOfBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 要取的地址：图、视频是它的地址；链接是它指向的 */
const addressOf = (element: PickedElement): string | undefined => element.src ?? (element.kind === "link" ? element.href : undefined);

export class ElementFiles {
  private readonly deps: ElementFilesDeps;

  constructor(deps: ElementFilesDeps) {
    this.deps = deps;
  }

  /** 找到这个元素（还是那一页、还在） */
  private async find(id: string, url: string): Promise<{ element: PickedElement } | { reason: string }> {
    const found = await this.deps.page.elementInfo(id, url);
    if (found === "old") return { reason: APP_TOO_OLD };
    if (!found) return { reason: BRIDGE_GONE };
    return found.ok ? { element: found.element } : { reason: found.reason };
  }

  /** 页面桥读好的字节和类型；读不了是原因 */
  private async fromPage(id: string, url: string): Promise<{ bytes: Uint8Array; mime: string } | { reason: string }> {
    const began = await this.deps.page.elementPrepare(id, url);
    if (!began.ok) return { reason: began.reason ?? BRIDGE_GONE };
    const parts: Uint8Array[] = [];
    let mime = "application/octet-stream";
    let size = 0;
    let waited = 0;
    for (;;) {
      const chunk: PageElementChunk = await this.deps.page.elementChunk(id, size);
      if (!chunk.ok) return { reason: chunk.reason };
      if (!chunk.ready) {
        if (++waited > CHUNK_POLL_MAX) return { reason: "页面里读了太久没读出来" };
        await this.deps.sleep(CHUNK_POLL_MS);
        continue;
      }
      if (chunk.total > ELEMENT_FILE_MAX_BYTES) return { reason: "文件太大" };
      const bytes = bytesOfBase64(chunk.base64);
      parts.push(bytes);
      size += bytes.length;
      mime = chunk.mime;
      if (chunk.done) break;
      if (bytes.length === 0) return { reason: "页面里读出来的内容不全" };
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    return { bytes: all, mime };
  }

  /** 截这个元素的图进 App 的缓存；截不成是原因 */
  private async shoot(files: NativeElementFiles, id: string, url: string): Promise<{ id: string; size: number; partial: boolean } | { reason: string }> {
    const rect = await this.deps.page.elementRect(id, url);
    if (!rect.ok) return { reason: rect.reason };
    try {
      await this.deps.sleep(SHOT_SETTLE_MS);
      const shot = await files.shot({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      return shot.ok ? { id: shot.id, size: shot.size, partial: rect.partial } : { reason: failureText(shot) };
    } finally {
      this.deps.page.elementShotDone();
    }
  }

  /** App 缓存里的一份读出来 */
  private async fromApp(files: NativeElementFiles, id: string, size: number): Promise<Uint8Array | { reason: string }> {
    const all = new Uint8Array(size);
    let at = 0;
    for (;;) {
      const part = await files.read(id, at);
      if (!part.ok) return { reason: failureText(part) };
      const bytes = bytesOfBase64(part.base64);
      if (at + bytes.length > size) return { reason: "读出来的比 App 说的大" };
      all.set(bytes, at);
      at += bytes.length;
      if (part.done) return at === size ? all : all.slice(0, at);
      if (bytes.length === 0) return { reason: "读出来的内容不全" };
    }
  }

  /** 传进媒体库，交回给守护进程的结果 */
  private async deliver(bytes: Uint8Array, name: string, mime: string, via: ElementFile["via"], partial: boolean): Promise<BrowserOutcome> {
    const stored = await this.deps.upload(bytes, name, mime);
    const file: ElementFile = { mediaId: stored.mediaId, name: stored.name.slice(0, 255), mime: stored.mime.slice(0, 200), size: stored.size, via, ...(partial ? { partial: true as const } : {}) };
    return { ok: true, file };
  }

  /** 取元素的内容传进媒体库：地址 → 页面读 → 截图（链接只取地址，不截图） */
  async file(id: string, url: string): Promise<BrowserOutcome> {
    const found = await this.find(id, url);
    if ("reason" in found) return { ok: false, reason: found.reason };
    const { element } = found;
    if (element.kind === "text") return { ok: false, reason: TEXT_NO_FILE };
    const { files } = this.deps;
    if (!files) return { ok: false, reason: APP_TOO_OLD };
    const notes: string[] = [];
    const address = addressOf(element);
    if (address) {
      const got = await files.fetch(address, ELEMENT_FILE_MAX_BYTES);
      if (got.ok) {
        const html = isHtml(got.mime);
        if (!html) {
          const bytes = await this.fromApp(files, got.id, got.size);
          files.drop(got.id);
          if (!("reason" in bytes)) return this.deliver(bytes, got.name || elementFileName(element, got.mime), got.mime || "application/octet-stream", "original", false);
          notes.push(bytes.reason);
        } else {
          files.drop(got.id);
          if (element.kind === "link") return { ok: false, reason: PAGE_LINK };
          notes.push("这个地址回的是网页，不是图");
        }
      } else {
        notes.push(failureText(got));
      }
      if (element.kind === "link") return { ok: false, reason: notes.join("；") };
    } else if (element.source === "data" || element.source === "blob" || element.source === "canvas") {
      const read = await this.fromPage(id, url);
      if (!("reason" in read)) return this.deliver(read.bytes, elementFileName(element, read.mime), read.mime, "original", false);
      notes.push(read.reason);
    } else if (element.kind === "link") {
      return { ok: false, reason: NO_ADDRESS };
    }
    const shot = await this.shoot(files, id, url);
    if ("reason" in shot) return { ok: false, reason: [...notes, `截图也没截成：${shot.reason}`].join("；") };
    const bytes = await this.fromApp(files, shot.id, shot.size);
    files.drop(shot.id);
    if ("reason" in bytes) return { ok: false, reason: bytes.reason };
    return this.deliver(bytes, elementFileName(element, "image/png"), "image/png", "screenshot", shot.partial);
  }

  /** 在设备上把元素下载下来：有地址的走 App 的下载；没有的字节写进 App 的缓存再弹"保存到"，再不行存截的图 */
  async download(id: string, url: string): Promise<BrowserOutcome> {
    const found = await this.find(id, url);
    if ("reason" in found) return { ok: false, reason: found.reason };
    const { element } = found;
    if (element.kind === "text") return { ok: false, reason: TEXT_NO_FILE };
    const { files } = this.deps;
    if (!files) return { ok: false, reason: APP_TOO_OLD };
    const address = addressOf(element);
    if (address) {
      const started = await files.download(address);
      return started.ok ? { ok: true } : { ok: false, reason: failureText(started) };
    }
    if (element.kind === "link") return { ok: false, reason: NO_ADDRESS };
    if (element.source === "data" || element.source === "blob" || element.source === "canvas") {
      const read = await this.fromPage(id, url);
      if (!("reason" in read)) return this.saveBytes(files, read.bytes, elementFileName(element, read.mime), read.mime);
    }
    const shot = await this.shoot(files, id, url);
    if ("reason" in shot) return { ok: false, reason: shot.reason };
    const saved = await files.save(shot.id, elementFileName(element, "image/png"), "image/png");
    return saved.ok ? { ok: true } : { ok: false, reason: failureText(saved) };
  }

  /** 字节分段写进 App 的缓存、弹"保存到" */
  private async saveBytes(files: NativeElementFiles, bytes: Uint8Array, name: string, mime: string): Promise<BrowserOutcome> {
    let cached = "";
    for (let at = 0; at === 0 || at < bytes.length; at += WRITE_BYTES) {
      const part = bytes.subarray(at, at + WRITE_BYTES);
      let binary = "";
      for (let i = 0; i < part.length; i += 0x8000) binary += String.fromCharCode(...part.subarray(i, i + 0x8000));
      const wrote = await files.write(cached, btoa(binary));
      if (!wrote.ok) return { ok: false, reason: failureText(wrote) };
      cached = wrote.id;
    }
    const saved = await files.save(cached, name, mime);
    return saved.ok ? { ok: true } : { ok: false, reason: failureText(saved) };
  }
}

/** 分段写进 App 时一段多少字节（base64 之后约 512 KB） */
const WRITE_BYTES = 384 * 1024;
