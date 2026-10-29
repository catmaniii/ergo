// 候选文件预备好（149 号票，用户 2026-10-18："选了图片以后，提交的时间也很长……最好在选定图片前，提交图片到上传框的脚本就已经写好了，
// 这样选中的瞬间就可以开始提交"）：选完之后慢在点了"交"才开始取整张图（手机经隧道回家里取）、再分段交给 App。现在——
// - 候选一出来就预备（prefetch）：这台设备上有给这个浏览器、这一页的网页候选卡时（page-pick.ts 管），马上在后台凭取件码取回字节、
//   交给 App 暂存（putFile）。推荐的先取，其余的依次取，一次一个（不把带宽占满）；预备的加起来最多 PREFETCH_MAX_BYTES，超了的等点了再取；
// - 点了就交（take）：已经暂存好的直接用；正在取的等它取完；没取的现取（不排在预备的队后面）。拿到的交给调用方 deliver 进框——
//   App 交进框之后自己删掉暂存的文件，所以拿走的就从这里去掉（再交一次要重新取）；
// - 用不上了就放掉（release）：候选卡处理完、过期、换了网页，这张卡预备的、别的卡也没用着的，告诉 App 丢掉（NativePageControl.discard），
//   还在排队的不再取，正在取的取完就丢；
// - 记时间：每次交文件记一条（点"交"→ 字节到手 → 交给 App → 交进框各多少毫秒、用上了几个预备好的），经原生桥的 log 进 hilog。
// 不碰浏览器的全局变量（取字节、交给 App、丢掉、记日志、时钟都由参数给），测试在 Node 里跑。
import { PAGE_FILES_TOTAL_MAX_BYTES, type PageCommandFile, t } from "../../state/index.ts";
import type { StagedFile } from "../../app/native-browser.ts";

/** 预备的加起来最多多少字节（和一次能交的总量一样），超了的等点了"交"再取 */
export const PREFETCH_MAX_BYTES = PAGE_FILES_TOTAL_MAX_BYTES;

export interface PageStageDeps {
  /** 凭取件码取回字节（同源请求，带设备凭证） */
  fetch(token: string): Promise<Uint8Array>;
  /** 把一个文件的字节交给 App 暂存（分段）；交不了是 false */
  put(id: string, bytes: Uint8Array): Promise<boolean>;
  /** 放掉交给 App 暂存、没用上的文件（旧版 App 没有这个方法就什么都不做，App 下次起来时清） */
  discard(ids: readonly string[]): void;
  /** 记一条日志（经原生桥进 hilog） */
  log(line: string): void;
  now(): number;
}

/** 一个文件走到哪了：排队、在取、暂存好了、没取成 */
type EntryState = "queued" | "fetching" | "staged" | "failed";

interface Entry {
  file: PageCommandFile;
  state: EntryState;
  /** 交给 App 时的编号（暂存好了才有） */
  id?: string;
  /** 字节到手、交给 App 的时刻 */
  bytesAt?: number;
  putAt?: number;
  /** 取的那一趟（取完回暂存的文件，没成回原因） */
  ready?: Promise<StagedFile | string>;
  /** 哪几张卡要它（都放掉了就丢） */
  owners: Set<string>;
  /** 是不是预备的（点了"交"现取的不算） */
  prefetched: boolean;
  /** 点了"交"拿走了（取完不丢） */
  taken?: boolean;
}

/** 交文件用到的：暂存好的文件（按要的先后），用上了几个预备好的，字节到手、交给 App 各花了多少毫秒 */
export interface Taken {
  readonly files: readonly StagedFile[];
  readonly prestaged: number;
  readonly bytesMs: number;
  readonly putMs: number;
}

export class PageStage {
  private readonly deps: PageStageDeps;
  private readonly entries = new Map<string, Entry>();
  /** 预备的队（取件码，先推荐的） */
  private readonly queue: string[] = [];
  private running = false;
  private seq = 0;

  constructor(deps: PageStageDeps) {
    this.deps = deps;
  }

  /** 已经预备、在预备、排着的加起来多大 */
  private budgetUsed(): number {
    let sum = 0;
    for (const e of this.entries.values()) if (e.prefetched && e.state !== "failed") sum += e.file.size;
    return sum;
  }

  /** 候选一出来就预备（owner 是候选卡的编号；files 按先后——推荐的放前面）；已经有的只记上这张卡也要它 */
  prefetch(owner: string, files: readonly PageCommandFile[]): void {
    for (const file of files) {
      const had = this.entries.get(file.token);
      if (had) {
        had.owners.add(owner);
        continue;
      }
      if (this.budgetUsed() + file.size > PREFETCH_MAX_BYTES) continue;
      this.entries.set(file.token, { file, state: "queued", owners: new Set([owner]), prefetched: true });
      this.queue.push(file.token);
    }
    void this.pump();
  }

  /** 一次取一个 */
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let token = this.queue.shift(); token !== undefined; token = this.queue.shift()) {
        const entry = this.entries.get(token);
        if (entry?.state !== "queued") continue;
        await this.start(entry);
      }
    } finally {
      this.running = false;
    }
  }

  /** 取一个文件、交给 App 暂存；已经在取的回那一趟 */
  private start(entry: Entry): Promise<StagedFile | string> {
    if (entry.ready) return entry.ready;
    entry.state = "fetching";
    entry.ready = (async () => {
      try {
        const bytes = await this.deps.fetch(entry.file.token);
        entry.bytesAt = this.deps.now();
        const id = `pk${this.deps.now().toString(36)}${++this.seq}`;
        if (!(await this.deps.put(id, bytes))) throw new Error(t("app.pageStage.putFailed", { name: entry.file.name }));
        entry.putAt = this.deps.now();
        entry.id = id;
        // 取的时候没人要了（卡处理完了）：丢掉
        if (!entry.taken && this.entries.get(entry.file.token) !== entry) {
          this.deps.discard([id]);
          return t("app.pageStage.unwanted");
        }
        entry.state = "staged";
        return { id, name: entry.file.name, mime: entry.file.mime };
      } catch (err) {
        entry.state = "failed";
        entry.ready = undefined;
        return err instanceof Error ? err.message : String(err);
      }
    })();
    return entry.ready;
  }

  /**
   * 点了"交"：这几个文件暂存好了交出来（按给的先后）——暂存好的直接用、在取的等它、没取的现取。拿走的从这里去掉（App 交进框后自己删）；
   * 有一个没取成就抛错（原因是给人看的话），已经拿到的告诉 App 丢掉
   */
  async take(files: readonly PageCommandFile[]): Promise<Taken> {
    const began = this.deps.now();
    const used = files.map((file) => {
      const had = this.entries.get(file.token);
      const prestaged = had?.state === "staged";
      const entry: Entry = had && had.state !== "failed" ? had : { file, state: "queued", owners: new Set(), prefetched: false };
      return { entry, prestaged };
    });
    // 都从这里拿走：之后放掉别的卡时不会丢它们
    for (const { entry } of used) {
      entry.taken = true;
      this.entries.delete(entry.file.token);
    }
    const results = await Promise.all(used.map(({ entry }) => this.start(entry)));
    const staged = results.filter((r): r is StagedFile => typeof r !== "string");
    const failure = results.find((r): r is string => typeof r === "string");
    if (failure !== undefined) {
      if (staged.length > 0) this.deps.discard(staged.map((f) => f.id));
      throw new Error(failure);
    }
    const after = (at: number | undefined) => Math.max(0, (at ?? began) - began);
    return {
      files: staged,
      prestaged: used.filter((u) => u.prestaged).length,
      bytesMs: Math.max(0, ...used.map((u) => after(u.entry.bytesAt))),
      putMs: Math.max(0, ...used.map((u) => after(u.entry.putAt) - after(u.entry.bytesAt))),
    };
  }

  /** 这张卡用不上了：它预备的、别的卡也没要的放掉（排着的不取，在取的取完丢，暂存好的告诉 App 丢掉） */
  release(owner: string): void {
    const drop: string[] = [];
    for (const [token, entry] of this.entries) {
      if (!entry.owners.delete(owner) || entry.owners.size > 0) continue;
      this.entries.delete(token);
      if (entry.state === "staged" && entry.id) drop.push(entry.id);
    }
    if (drop.length > 0) this.deps.discard(drop);
  }

  /** 现在为哪几张卡预备着（测试、日志用） */
  owners(): string[] {
    return [...new Set([...this.entries.values()].flatMap((e) => [...e.owners]))];
  }

  /** 交文件的耗时记一条（经原生桥进 hilog） */
  logDelivery(how: string, taken: Taken, deliverMs: number, total: number): void {
    this.deps.log(`交文件（${how}）${taken.files.length} 个，用上预备好的 ${taken.prestaged} 个：点"交"→字节到手 ${taken.bytesMs}ms → 交给 App ${taken.putMs}ms → 交进框 ${deliverMs}ms，共 ${total}ms`);
  }
}
