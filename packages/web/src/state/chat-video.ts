// 聊天里的视频附件：像图片一样直接显示第一帧、中间播放键、角上时长，点开大播放器（ui/conversation/parts.tsx 的 VideoView、
// ui/video-viewer.tsx）。这里是不碰 DOM 的判断：
// - 哪些文件附件在聊天里显示成视频：照协议包的 mediaPreviewOf（mp4、m4v、mov、mkv、webm，没有扩展名的看 part 上的 video/*），
//   和报告页给不给视频播放器是同一份判断；
// - 第一帧取到哪一步了：还没取到（没滚到附近不取，滚到了在取）、取到了（画面宽高、时长）、放不了（播放器报错，或者元数据里没有画面宽高——
//   只有声音、画面的编码浏览器解不了）。放不了的退回原来的文件卡片，卡片上写"网页里放不了，下载看"；
// - 角上的时长怎么写（0:07、12:30、1:02:03）。
// 第一帧在网页里取（<video preload="metadata">，地址带 #t=0.1 停在开头一帧），不在守护进程截图。
import type { FileCard } from "./attachments.ts";
import { type FilePartValue, mediaPreviewOf, t } from "./protocol.ts";

/** 这个文件附件在聊天里直接显示成视频（第一帧、播放键、时长），而不是文件卡片 */
export function isChatVideo(part: Pick<FilePartValue, "name" | "mime">): boolean {
  return mediaPreviewOf(part) === "video";
}

/** 气泡里的第一帧取到哪一步了 */
export type VideoThumb =
  /** 还没取到：没滚到附近不取，滚到了在取元数据和第一帧（先占一块 16:9 的底） */
  | { readonly kind: "idle" }
  /** 取到了：画面宽高（按它的比例画）、时长（秒；直播流这类读不出时长的没有） */
  | { readonly kind: "ready"; readonly width: number; readonly height: number; readonly duration: number | undefined }
  /** 放不了：退回文件卡片，提示下载 */
  | { readonly kind: "unplayable" };

export const VIDEO_THUMB_IDLE: VideoThumb = { kind: "idle" };
export const VIDEO_THUMB_UNPLAYABLE: VideoThumb = { kind: "unplayable" };

/** 播放器读到的元数据（HTMLVideoElement 上的同名字段） */
export interface VideoMetadata {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly duration: number;
}

/**
 * 读到元数据之后：有画面宽高的是 ready；宽高是 0 的是放不了——只有声音，或者画面的编码浏览器解不了、声音照放
 * （Chrome 遇到不支持的 HEVC 就是这样，不报错）
 */
export function videoThumbOf(meta: VideoMetadata): VideoThumb {
  if (!(meta.videoWidth > 0) || !(meta.videoHeight > 0)) return VIDEO_THUMB_UNPLAYABLE;
  const duration = Number.isFinite(meta.duration) && meta.duration > 0 ? meta.duration : undefined;
  return { kind: "ready", width: meta.videoWidth, height: meta.videoHeight, duration };
}

/** 取第一帧用的地址：带上媒体片段 #t=0.1，播放器停在开头那一帧上（手机上不带它常常是黑的）；地址本来带 # 的换掉 */
export const VIDEO_THUMB_AT = 0.1;
export function videoThumbSrc(src: string): string {
  const hash = src.indexOf("#");
  return `${hash >= 0 ? src.slice(0, hash) : src}#t=${VIDEO_THUMB_AT}`;
}

/** 角上的时长：不到一小时 m:ss（0:07、12:30），一小时以上 h:mm:ss；不到一秒的算 0:01，读不出来的不写 */
export function videoDurationLabel(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const total = Math.max(1, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * 放不了的视频退回的那张卡片：不给"预览"（报告页一样放不了），点图标就是下载、图标上写"仅下载"，
 * 卡片上多一行"网页里放不了，下载看"
 */
export function unplayableVideoCard(card: FileCard): FileCard {
  return {
    ...card,
    preview: undefined,
    iconAction: "download",
    iconHint: t("state.attachments.hint.videoUnplayable"),
    note: t("state.attachments.videoUnplayable"),
  };
}
