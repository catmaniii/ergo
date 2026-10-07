// 拼附件 part 的小工具（守护进程和 Web 共用；不引用 TypeBox）。
import type { MessagePart } from "./schema.ts";

export type ImagePartValue = Extract<MessagePart, { type: "image" }>;
export type FilePartValue = Extract<MessagePart, { type: "file" }>;

/** 图片 part：宽高有就带上，没有就不写这两个字段 */
export function imagePartFrom(image: { mediaId: string; name: string; mime: string; width?: number | undefined; height?: number | undefined }): ImagePartValue {
  return {
    type: "image",
    mediaId: image.mediaId,
    name: image.name,
    mime: image.mime,
    ...(image.width === undefined ? {} : { width: image.width }),
    ...(image.height === undefined ? {} : { height: image.height }),
  };
}

/** 入库后的媒体（收尾响应 UploadedMedia 的形状）→ 消息里的 part：服务端认出是图片的发图片 part，其余发文件 part */
export function attachmentPartFrom(media: {
  mediaId: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  width?: number | undefined;
  height?: number | undefined;
}): ImagePartValue | FilePartValue {
  if (media.kind === "image") return imagePartFrom(media);
  return { type: "file", mediaId: media.mediaId, name: media.name, mime: media.mime, size: media.size };
}

/**
 * 引用一条消息时每个 part 的说法（给人看的地方用，比如系统说明里引用用户的消息）：文字原样，图片、文件写文件名，
 * 其余不出现。发给模型的投影有自己冻结在版本里的写法，不用这个。
 */
export function partLabel(part: MessagePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      return `[图片：${part.name}]`;
    case "file":
      return `[附件：${part.name}]`;
    default:
      return "";
  }
}
