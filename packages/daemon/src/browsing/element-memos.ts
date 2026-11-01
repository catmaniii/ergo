// 这一轮取回来的元素文件（"这张图记下来还是尽量可以下载吧"）：秘书记东西时（remember_memory 的 file）只认这里记着的。
// - browse_element_content 取到一个文件就记一笔：文件编号（ref-…）、文件、哪一轮、哪次工具调用；没取到记下原因；
// - 记的时候：编号要是这一轮取回来的（以前几轮的、find_files 列的、编出来的都不认，路径在参数校验那一步就过不去），文件还在媒体库里，大小在附件的上限之内（超了照实说）；
//   连同来源网页和元素的地址（只留 http、https 的）一起交给记忆插件。不带编号时，这一轮要是长按的文件类元素，也带上来源，并说清为什么只记了文字；
// - 不按意图分类：这里只回答"这个编号能不能带、这一轮是什么样"，要不要记、带不带由秘书判断。
// 只在内存里：一轮之内的事，守护进程重启后这一轮也没了，秘书重新取就是。
// @i18n-ignore-file model：拒绝的原因、说明都是给秘书（模型）看的
import type { BrowsingMark, ElementFile, PickedElement, RememberedFile, RememberedOrigin } from "@ergo/protocol";
import type { HostToolCall } from "../agent-manager/host-tools.ts";
import type { MediaInfo, MediaStore } from "../media/media-store.ts";
import { sizeLabel } from "../media/file-types.ts";
import { elementText } from "./texts.ts";

/** 最多记几笔（一轮里取不了几次；多了丢最早的） */
const MEMOS_MAX = 50;

type TurnCall = Pick<HostToolCall, "inputMessageId" | "moreInputMessageIds">;

/** 记东西时能带上的：refused 是编号不认（整条不记），note 是文件没带上的原因（只记文字） */
export type ElementToRemember = { refused: string } | { file?: RememberedFile; origin?: RememberedOrigin; note?: string };

export interface ElementMemos {
  /** 取到了一个文件 */
  fetched(call: Pick<HostToolCall, "inputMessageId" | "moreInputMessageIds" | "toolCallId">, ref: string, file: ElementFile): void;
  /** 这一轮没取到 */
  failed(call: TurnCall, reason: string): void;
  /** 这一次记东西能带上什么；ref 是秘书写的文件编号 */
  toRemember(ref: string | undefined, call: TurnCall): ElementToRemember;
}

/** 这一轮：一起交出的一批看最后一条（和网页工具的准入同一个认法） */
const turnOf = (call: TurnCall): string | undefined => [call.inputMessageId, ...(call.moreInputMessageIds ?? [])].filter((id): id is string => id !== undefined).at(-1);

const isHttp = (url: string | undefined): url is string => url !== undefined && /^https?:\/\//i.test(url);

/** 来源：网页的标题和地址，元素自己的地址（图片、视频的地址，没有就是链接的）；只留 http、https 的 */
function originOf(mark: BrowsingMark, element: PickedElement): RememberedOrigin | undefined {
  const address = [element.src, element.href].find(isHttp);
  const page = isHttp(mark.url) ? { title: mark.title, url: mark.url } : undefined;
  if (page === undefined && address === undefined) return undefined;
  return { ...(page === undefined ? {} : { page }), ...(address === undefined ? {} : { address }) };
}

function rememberedFile(file: ElementFile, info: MediaInfo, fetchCallId: string): RememberedFile {
  const image = info.image;
  return {
    mediaId: file.mediaId,
    kind: image ? "image" : "file",
    name: file.name,
    mime: image?.mime ?? file.mime,
    size: info.size,
    ...(image?.width === undefined ? {} : { width: image.width }),
    ...(image?.height === undefined ? {} : { height: image.height }),
    via: file.via,
    ...(file.partial ? { partial: true as const } : {}),
    fetchCallId,
  };
}

/** 多了丢最早记的 */
function trimmed<V>(map: Map<string, V>): void {
  while (map.size > MEMOS_MAX) map.delete(map.keys().next().value!);
}

export function createElementMemos(deps: {
  /** 这条消息上记的网页和元素（侧边栏、悬浮按钮、圆钮发的用户消息才有） */
  markOf(messageId: string): BrowsingMark | undefined;
  media: Pick<MediaStore, "info" | "maxUploadBytes">;
}): ElementMemos {
  const fetched = new Map<string, { turn: string; file: ElementFile; fetchCallId: string }>();
  const failures = new Map<string, string>();

  return {
    fetched(call, ref, file) {
      const turn = turnOf(call);
      if (turn === undefined) return;
      // 同一个文件的编号不变（FileRefs 按路径认）：又取了一次就算这一轮的
      fetched.delete(ref);
      fetched.set(ref, { turn, file, fetchCallId: call.toolCallId });
      trimmed(fetched);
    },
    failed(call, reason) {
      const turn = turnOf(call);
      if (turn === undefined) return;
      failures.set(turn, reason);
      trimmed(failures);
    },
    toRemember(ref, call): ElementToRemember {
      const turn = turnOf(call);
      const mark = turn === undefined ? undefined : deps.markOf(turn);
      const element = mark?.element;
      const origin = mark && element ? originOf(mark, element) : undefined;
      const withOrigin: { origin?: RememberedOrigin } = origin === undefined ? {} : { origin };
      if (ref !== undefined) {
        const memo = fetched.get(ref);
        if (memo === undefined || memo.turn !== turn) return { refused: elementText.rememberNotThisTurn(ref) };
        const info = deps.media.info(memo.file.mediaId);
        if (!info) return { ...withOrigin, note: elementText.rememberGone };
        if (info.size > deps.media.maxUploadBytes) return { ...withOrigin, note: elementText.rememberTooLarge(sizeLabel(info.size), sizeLabel(deps.media.maxUploadBytes)) };
        return { ...withOrigin, file: rememberedFile(memo.file, info, memo.fetchCallId) };
      }
      // 没带文件：这一轮长按的是文件类的元素才说明；文字元素、不是圆钮那一轮的和平常一样
      if (turn === undefined || !element || element.kind === "text") return {};
      const failure = failures.get(turn);
      return { ...withOrigin, note: failure === undefined ? elementText.rememberNoFile : elementText.rememberFetchFailed(failure) };
    },
  };
}
