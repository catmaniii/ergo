// ergo 命令里几处共用的说法（318 号票）
import { t } from "@ergo/protocol";
import { DownloadError } from "../components/downloader.ts";

/** 下载、取索引出错时给人看的一句（原因附在后面） */
export function fetchErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof DownloadError) return t(`cli.download.${err.kind}`, { detail: message });
  return message;
}

/** 字节数写成 MB / GB */
export function sizeText(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0, Math.round(bytes / 1e6))} MB`;
}
