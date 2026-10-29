// 找文件、看图两个工具（134、145 号票的 find_files、view_files，147 号票从页面助手里挪出来，149 号票起页面助手不再有）：秘书（浏览侧边栏、悬浮按钮那一轮替
// 上传框找文件）共用同一份做法——
// - find_files：在素材（发过的附件、交付的产出）和授权的文件夹里按关键词、时间、种类找，列出的每个文件给一个编号（ref-…），
//   结果后面附子文件夹概况（145 号票）；
// - view_files：把 find_files 找到的图缩成长边 VIEW_FILES_EDGE 左右的小图交给模型看（一次最多 VIEW_FILES_MAX 张）。
// 编号记在调用方给的一份 refs 里（秘书一份，留最近的 SECRETARY_REFS_MAX 个），交文件的工具只认这里面的编号。
// gate：秘书那边每次调用先看"这一轮是不是从浏览侧边栏、悬浮按钮发的，浏览器还开着"，不让用就回原因。
// @i18n-ignore-file model：工具的说明、参数说明和结果给秘书（模型）看（174 号票）；工具的名字走 t()
import { type LocalFoldersView, t, Type } from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolCall, type HostToolOutput } from "../agent-manager/host-tools.ts";
import type { Materials } from "../materials/index.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { ThumbnailRequest, ThumbnailResult } from "../runtime/index.ts";
import { type CaptureTimeCache, FILE_KINDS, folderOverviewText, type FoundFile, searchFolders, searchMaterialFiles } from "./find-files.ts";

export const FIND_FILES_TOOL = "find_files";
/** 看图（145 号票）：秘书一直有，看不了图时回原因 */
export const VIEW_FILES_TOOL = "view_files";

/** view_files 一次最多看几张 */
export const VIEW_FILES_MAX = 12;
/** 给模型看的小图长边多少像素 */
export const VIEW_FILES_EDGE = 384;
/** 多大的图不看（解码太费时、多半不是照片） */
export const VIEW_FILE_MAX_BYTES = 40 * 1024 * 1024;

/** 没找到、又没授权文件夹时告诉用户的那句（138 号票） */
export const AUTHORIZE_FOLDERS_HINT = "在聊天里跟二狗说一声授权哪个文件夹，或者在设置 · 浏览与填框里加";

/** find_files 一次最多列几个 */
const FIND_LIMIT_DEFAULT = 30;
const FIND_LIMIT_MAX = 60;

/** 文件编号的写法 */
export const FILE_REF = "^ref-[0-9a-f]{8}$";

export function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const WHEN_LABEL: Readonly<Record<FoundFile["whenKind"], string>> = { taken: "拍摄", modified: "修改", sent: "发来" };

const FindParams = Type.Object(
  {
    keywords: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 6, description: "文件夹名、文件名、附件说明里要出现的词（都要出现），比如地点、事情；不写就不按词筛" })),
    from: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "从哪天起（本地日期 YYYY-MM-DD，含这天）：照片按拍摄时间，别的按修改或发来的时间" })),
    to: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "到哪天为止（含这天）" })),
    kind: Type.Optional(Type.Enum(FILE_KINDS, { description: "image 照片和图片、video 视频、document 文档、any 都行（默认）" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FIND_LIMIT_MAX, description: `最多列几个，默认 ${FIND_LIMIT_DEFAULT}` })),
  },
  { additionalProperties: false },
);

const ViewParams = Type.Object(
  {
    refs: Type.Array(Type.String({ pattern: FILE_REF }), { minItems: 1, maxItems: VIEW_FILES_MAX, description: `要看的图片编号（${FIND_FILES_TOOL} 列出的 ref-…），一次最多 ${VIEW_FILES_MAX} 个` }),
  },
  { additionalProperties: false },
);

export interface FileToolsDeps {
  materials: Pick<Materials, "searchKeyword" | "searchSemantic">;
  media: Pick<MediaStore, "info" | "filePath">;
  /** 授权的文件夹（每次现读） */
  folders: () => LocalFoldersView;
  timeZone: string;
  /** 照片的拍摄时间记着（同一个文件下次不再读） */
  cache: CaptureTimeCache;
  /** 把几张图缩成小图（AgentManager.thumbnails） */
  thumbnails: (request: ThumbnailRequest) => Promise<ThumbnailResult>;
  log: (line: string) => void;
}

/** 列过的文件：编号 → 文件；max 是最多记几个（多了丢最早的） */
export class FileRefs {
  private readonly refs = new Map<string, FoundFile>();
  private readonly max: number;

  constructor(max = Number.POSITIVE_INFINITY) {
    this.max = max;
  }

  get(ref: string): FoundFile | undefined {
    return this.refs.get(ref);
  }

  /** 这个文件的编号：列过的照旧用原来的，没列过的给一个新的 */
  refOf(file: FoundFile): string {
    const known = [...this.refs.entries()].find(([, v]) => v.path === file.path)?.[0];
    if (known) {
      // 又用到了：挪到最后（丢的时候丢最早没再用的）
      this.refs.delete(known);
      this.refs.set(known, file);
      return known;
    }
    const ref = `ref-${(this.refs.size + 1).toString(16).padStart(4, "0").slice(-4)}${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;
    if (this.refs.has(ref)) return this.refOf(file);
    this.refs.set(ref, file);
    while (this.refs.size > this.max) this.refs.delete(this.refs.keys().next().value!);
    return ref;
  }

  /** 按编号认出列过的文件（去重）；有不认得的回它 */
  lookup(list: readonly string[] | undefined): { files: FoundFile[] } | { unknown: string } {
    const files: FoundFile[] = [];
    for (const ref of list ?? []) {
      const file = this.refs.get(ref);
      if (!file) return { unknown: ref };
      if (!files.includes(file)) files.push(file);
    }
    return { files };
  }
}

/** 调用之前看一眼让不让用（不让用回原因）；不给就都让用 */
export type ToolGate = (call: HostToolCall) => string | undefined;

/** 找文件；handOff 是找到以后交给哪个工具（工具说明里写） */
export function findFilesTool(deps: FileToolsDeps, refs: FileRefs, options: { handOff: string; gate?: ToolGate }): HostTool {
  return defineHostTool({
    name: FIND_FILES_TOOL,
    title: t("browsing.tool.findFiles"),
    description: `在用户的素材（发过的附件、交付的产出）和授权的文件夹里找文件：按关键词、时间、种类。列出的每个文件有编号（ref-…），交给 ${options.handOff}。只读。`,
    parameters: FindParams,
    readOnlyOrIdempotent: true,
    nature: "look",
    async run(args, call): Promise<HostToolOutput> {
      const refused = options.gate?.(call);
      if (refused) return { text: refused, isError: true };
      const query = { keywords: args.keywords ?? [], ...(args.from ? { from: args.from } : {}), ...(args.to ? { to: args.to } : {}), kind: args.kind ?? "any", limit: args.limit ?? FIND_LIMIT_DEFAULT };
      const folders = deps.folders().folders.map((f) => f.path);
      const [inFolders, inMaterials] = await Promise.all([
        searchFolders(folders, query, { timeZone: deps.timeZone, cache: deps.cache }),
        searchMaterialFiles(deps.materials, deps.media, query, deps.timeZone),
      ]);
      const all = [...inFolders.files, ...inMaterials].toSorted((a, b) => b.when.localeCompare(a.when));
      const shown = all.slice(0, query.limit);
      const lines = shown.map((f) => `- ${refs.refOf(f)} · ${f.name} · ${WHEN_LABEL[f.whenKind]} ${f.when} · ${sizeText(f.size)} · ${f.where}`);
      const note = [
        folders.length === 0 ? `（还没有授权的文件夹，只找了素材；没找到要的就告诉用户：${AUTHORIZE_FOLDERS_HINT}）` : "",
        inFolders.truncated ? "（文件夹太大，只看了前面一部分）" : "",
        all.length > shown.length ? `（一共 ${all.length} 个，只列了最近的 ${shown.length} 个）` : "",
      ].filter(Boolean);
      // 子文件夹概况（145 号票）：结果只列最近的几十个，按它知道还有哪些文件夹，按文件夹名再找
      const overview = folderOverviewText(inFolders.overview, query.kind);
      if (lines.length === 0) return { text: ["没找到符合的文件。", ...note, ...overview].join("\n") };
      return { text: [`找到 ${shown.length} 个：`, ...lines, ...note, ...overview].join("\n") };
    },
  });
}

/** 看图；needVision：调用时模型看不了图就回原因 */
export function viewFilesTool(deps: FileToolsDeps, refs: FileRefs, options: { gate?: ToolGate; needVision?: boolean } = {}): HostTool {
  return defineHostTool({
    name: VIEW_FILES_TOOL,
    title: t("browsing.tool.viewFiles"),
    description: `看 ${FIND_FILES_TOOL} 找到的图片：给编号（一次最多 ${VIEW_FILES_MAX} 个），每张缩成长边 ${VIEW_FILES_EDGE} 左右的小图交给你看，按列出的顺序跟在文字后面。要挑的和图里的内容有关（有人脸、风景、某个人、某种东西）时用。视频、文档看不了。只读。`,
    parameters: ViewParams,
    readOnlyOrIdempotent: true,
    nature: "look",
    async run(args, call): Promise<HostToolOutput> {
      const refused = options.gate?.(call);
      if (refused) return { text: refused, isError: true };
      if (options.needVision && call.vision !== true) return { text: "你现在的模型看不了图：按文件名、文件夹名、时间挑，拿不准就给候选让用户挑。", isError: true };
      const skipped: string[] = [];
      const toView: Array<{ ref: string; file: FoundFile }> = [];
      for (const ref of new Set(args.refs)) {
        const file = refs.get(ref);
        if (!file) skipped.push(`- ${ref}：没有这个编号（只能看 ${FIND_FILES_TOOL} 列出来的）`);
        else if (!file.mime.startsWith("image/")) skipped.push(`- ${ref} · ${file.name}：不是图片，看不了`);
        else if (file.size > VIEW_FILE_MAX_BYTES) skipped.push(`- ${ref} · ${file.name}：太大（${sizeText(file.size)}），跳过`);
        else toView.push({ ref, file });
      }
      let thumbs: ThumbnailResult["thumbs"] = [];
      if (toView.length > 0) {
        try {
          ({ thumbs } = await deps.thumbnails({ files: toView.map((v) => ({ path: v.file.path, mime: v.file.mime })), maxEdge: VIEW_FILES_EDGE }));
        } catch (err) {
          deps.log(`看图时缩小图片出错：${err instanceof Error ? err.message : String(err)}`);
          thumbs = toView.map(() => ({ ok: false, reason: "缩小图片出错了" }));
        }
      }
      const viewed: string[] = [];
      const images: Array<{ mime: string; data: string }> = [];
      toView.forEach((v, i) => {
        const thumb = thumbs[i];
        if (thumb?.ok) {
          images.push({ mime: thumb.mime, data: thumb.data });
          viewed.push(`${images.length}. ${v.ref} · ${v.file.name}（${v.file.where}）`);
        } else {
          skipped.push(`- ${v.ref} · ${v.file.name}：${thumb ? thumb.reason : "没缩出来"}，跳过`);
        }
      });
      const text = [viewed.length > 0 ? `看了 ${viewed.length} 张（下面的图按这个顺序）：` : "一张都没看成。", ...viewed, ...(skipped.length > 0 ? ["没看的：", ...skipped] : [])].join("\n");
      return { text, ...(images.length > 0 ? { images } : {}) };
    },
  });
}
