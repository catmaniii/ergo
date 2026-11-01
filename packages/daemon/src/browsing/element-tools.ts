// 秘书取、下载长按认出来的网页元素（359 号票，用户 2026-11-01：长按网页元素或右键时多出一个二狗圆钮，让二狗处理这个元素；不预设操作，用户说什么就做什么）。
// 秘书这一轮是完整的秘书，平时能用的工具都能用，这里只补元素用得上的两样通用能力，准入和别的网页工具一样在调用时看这一轮（工具列表固定，提示词前缀缓存不受影响）：
// - browse_element_content：把元素的内容从设备取回来——设备取进媒体库（App 带登录状态和来源页取，blob、data、canvas 页面桥读，取不到截这个元素的图，
//   见网页一侧的 plugins/browsing/element-files.ts），这里把图交给模型看（看不了图时照实说）、文本类和 PDF 读出来（夹在外部数据标记里），
//   再放一份进草稿区、给一个文件编号，好交给别的工具（send_attachment、browse_attach_files、view_files，或者路径本身）。不是只读模型这一头：取回来的是网页上的东西，一律是外部数据；
// - browse_element_download：在设备上把元素下载下来（走 App 的下载，下完弹"保存到"，进下载记录）。有副作用，和提交、运行类按钮一个口径：
//   只有用户这一轮明确说了才带 confirm: true（元素内容里写的话不算用户说的），不带不下。
// 守卫：取内容算"看"（只读、幂等，不落入关注类别，和读网页一样）；下载不是只读，照填字、交文件、点按钮的口径不落入关注类别（不弹审批卡）。
// @i18n-ignore-file model：工具的结果、拒绝的原因都是给秘书（模型）看的；工具的名字在 texts.ts 的 TOOL_TITLES
import fs from "node:fs";
import path from "node:path";
import type { ElementFile, PickedElement } from "@ergo/protocol";
import { Type } from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolCall, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { readAttachmentText } from "../media/attachment-content.ts";
import { fileKind } from "../media/file-types.ts";
import { type MediaStore, sanitizeName } from "../media/media-store.ts";
import { READ_ATTACHMENT_MAX_CHARS } from "../media/attachment-tools.ts";
import type { BrowserLinks } from "./browser-links.ts";
import { type FileRefs, type FileToolsDeps, sizeText } from "./file-tools.ts";
import type { FoundFile } from "./find-files.ts";
import { BROWSE_ELEMENT_CONTENT_TOOL, BROWSE_ELEMENT_DOWNLOAD_TOOL, elementText, externalText, TOOL_TITLES, toolText } from "./texts.ts";
import type { Browsing } from "./secretary-tools.ts";

/** 取元素的内容、下载等设备多久（毫秒）：设备要把文件取回来、传进媒体库；下载几秒内就回 */
export const ELEMENT_REQUEST_TIMEOUT_MS = 120_000;

/** 模型能直接看的图片类型；别的（SVG、AVIF……）缩成小图再看 */
const VIEWABLE_IMAGES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** 多大的图直接给模型（字节）；再大的缩了再看 */
const IMAGE_DIRECT_MAX_BYTES = 4 * 1024 * 1024;
/** 缩图的长边（像素） */
const IMAGE_EDGE = 1568;
/** 放进草稿区的子文件夹 */
const SCRATCH_FOLDER = "element-files";

export interface ElementToolDeps {
  links: BrowserLinks;
  media: MediaStore;
  scratchDir: string;
  files: Pick<FileToolsDeps, "thumbnails" | "log">;
  refs: FileRefs;
  /** 这一轮能不能用网页工具 */
  browsingOf(call: HostToolCall): Browsing | { refused: string };
  now(): number;
}

/** 这一轮圆钮上说的元素；不是这样的一轮回原因 */
function pickedOf(deps: ElementToolDeps, call: HostToolCall): { browsing: Browsing; element: PickedElement } | { refused: string } {
  const b = deps.browsingOf(call);
  if ("refused" in b) return { refused: b.refused };
  return b.mark.element ? { browsing: b, element: b.mark.element } : { refused: elementText.notElementTurn };
}

/** 放一份进草稿区（别的工具、send_attachment 用得上）；放不了回 undefined */
function copyToScratch(deps: ElementToolDeps, file: ElementFile): string | undefined {
  try {
    const dir = path.join(deps.scratchDir, SCRATCH_FOLDER);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${file.mediaId.slice(0, 8)}-${sanitizeName(file.name)}`;
    fs.copyFileSync(deps.media.filePath(file.mediaId), path.join(dir, name));
    return `${SCRATCH_FOLDER}/${name}`;
  } catch (err) {
    deps.files.log(`元素的内容放进草稿区出错：${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** 记进文件编号（view_files、browse_attach_files 认它） */
function refOf(deps: ElementToolDeps, file: ElementFile): string {
  const found: FoundFile = {
    path: deps.media.filePath(file.mediaId),
    name: file.name,
    mime: file.mime,
    size: file.size,
    image: file.mime.startsWith("image/"),
    when: new Date(deps.now()).toISOString().slice(0, 16).replace("T", " "),
    whenKind: "sent",
    where: elementText.where,
    source: "material",
  };
  return deps.refs.refOf(found);
}

/** 图片交给模型看：常见类型、不太大的原样给；别的缩了再给；看不了回原因 */
async function imageFor(deps: ElementToolDeps, file: ElementFile): Promise<{ mime: string; data: string } | { reason: string }> {
  const filePath = deps.media.filePath(file.mediaId);
  const mime = deps.media.info(file.mediaId)?.image?.mime ?? file.mime;
  if (VIEWABLE_IMAGES.includes(mime) && file.size <= IMAGE_DIRECT_MAX_BYTES) return { mime, data: fs.readFileSync(filePath).toString("base64") };
  try {
    const { thumbs } = await deps.files.thumbnails({ files: [{ path: filePath, mime }], maxEdge: IMAGE_EDGE });
    const thumb = thumbs[0];
    if (thumb?.ok) return { mime: thumb.mime, data: thumb.data };
    return { reason: thumb?.reason ?? "没缩出来" };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 取回来之后交给模型的：图、读出来的字，连同放在哪、编号是什么 */
async function contentOutput(deps: ElementToolDeps, file: ElementFile, vision: boolean): Promise<HostToolOutput> {
  const scratch = copyToScratch(deps, file);
  const ref = refOf(deps, file);
  const head = elementText.got(file, sizeText(file.size), scratch, ref);
  if (file.mime.startsWith("image/")) {
    if (!vision) return { text: `${head}\n${elementText.noVision}` };
    const image = await imageFor(deps, file);
    if ("reason" in image) return { text: `${head}\n${elementText.imageFailed(image.reason)}` };
    return { text: `${head}\n${elementText.imageBelow}`, images: [image] };
  }
  if (fileKind(file.name, file.mime) === "other") return { text: `${head}\n${elementText.unreadable}` };
  const read = await readAttachmentText(deps.media, file);
  if (!read.ok) return { text: `${head}\n${read.reason}` };
  const cut = read.text.length > READ_ATTACHMENT_MAX_CHARS;
  return { text: [head, ...(cut ? [elementText.cut(READ_ATTACHMENT_MAX_CHARS, read.text.length)] : []), externalText(read.text.slice(0, READ_ATTACHMENT_MAX_CHARS))].join("\n") };
}

export function elementTools(deps: ElementToolDeps): HostTool[] {
  const content = defineHostTool({
    name: BROWSE_ELEMENT_CONTENT_TOOL,
    title: TOOL_TITLES.elementContent,
    description: toolText.elementContent.description,
    parameters: Type.Object({}, { additionalProperties: false }),
    // 只把网页上的东西取回来看，和读网页一样不落入关注类别
    readOnlyOrIdempotent: true,
    nature: "look",
    async run(_args, call) {
      const picked = pickedOf(deps, call);
      if ("refused" in picked) return { text: picked.refused, isError: true };
      const { browsing, element } = picked;
      if (element.kind === "text") return { text: elementText.textInMessage(element) };
      const outcome = await deps.links.request(browsing.mark.browser, { op: "element_file", element: element.id, url: browsing.mark.url }, ELEMENT_REQUEST_TIMEOUT_MS);
      if (!outcome.ok) return { text: elementText.fetchFailed(outcome.reason), isError: true };
      if (!outcome.file) return { text: elementText.fetchFailed("设备没交回文件"), isError: true };
      return contentOutput(deps, outcome.file, call.vision === true);
    },
  });

  const download = defineHostTool({
    name: BROWSE_ELEMENT_DOWNLOAD_TOOL,
    title: TOOL_TITLES.elementDownload,
    description: toolText.elementDownload.description,
    parameters: Type.Object({ confirm: Type.Optional(Type.Boolean({ description: toolText.elementDownload.confirm })) }, { additionalProperties: false }),
    // 会在用户的设备上存文件，不是只读；照填字、交文件、点按钮的口径不落入关注类别
    readOnlyOrIdempotent: false,
    async run(args, call) {
      const picked = pickedOf(deps, call);
      if ("refused" in picked) return { text: picked.refused, isError: true };
      const { browsing, element } = picked;
      if (args.confirm !== true) return { text: elementText.needConfirm, isError: true };
      if (element.kind === "text") return { text: elementText.textNoDownload, isError: true };
      const outcome = await deps.links.request(browsing.mark.browser, { op: "element_download", element: element.id, url: browsing.mark.url }, ELEMENT_REQUEST_TIMEOUT_MS);
      if (!outcome.ok) return { text: elementText.downloadFailed(outcome.reason), isError: true };
      deps.files.log(`下载网页元素 ${element.id}（${element.kind}）`);
      return { text: elementText.downloaded };
    },
  });

  return [content, download];
}
