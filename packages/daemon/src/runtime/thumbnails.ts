// 守护进程这一侧调用"缩小成小图"（145 号票的 view_files 把找到的几张图缩小了给模型看，149 号票起是秘书在用）：拉起一次性子进程
// agent-child/thumbnails-main.ts，stdin 送一行请求（几张图的路径、类型和长边上限）、stdout 读一行结果，等它退出。
// 缩小用的是 pi 自带的图片缩放（pi 的 read 工具读图时用的那个，Rust/WASM，不加图片库），pi 只能出现在子进程里（ADR-0001、ADR-0004），
// 所以和模型探查一样经一次性子进程做；守护进程只转手。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "@ergo/protocol";
import { type RunOneShotOptions, runOneShotChild } from "./one-shot-child.ts";

const ownExt = path.extname(fileURLToPath(import.meta.url));
const THUMBNAILS_ENTRY = fileURLToPath(new URL(`./agent-child/thumbnails-main${ownExt}`, import.meta.url));

/** 最多等多久：十来张手机照片解码、缩小几秒就够 */
export const THUMBNAILS_TIMEOUT_MS = 60_000;

/** 要缩小的几张图（本机路径、类型）和长边上限（像素） */
export interface ThumbnailRequest {
  files: Array<{ path: string; mime: string }>;
  maxEdge: number;
}

/** 一张图缩小的结果：成了是小图（base64）、类型和尺寸；不成是原因（给人看的，"读不了""解不开"） */
export type ThumbnailOutcome = { ok: true; data: string; mime: string; width: number; height: number } | { ok: false; reason: string };

/** 结果按请求里的顺序，一张一个 */
export interface ThumbnailResult {
  thumbs: ThumbnailOutcome[];
}

export type RunThumbnailsOptions = RunOneShotOptions;

/** 缩小一批图；子进程出错、超时抛错（单张读不了、解不开不算出错，结果里写原因） */
export function runThumbnails(request: ThumbnailRequest, options: RunThumbnailsOptions): Promise<ThumbnailResult> {
  return runOneShotChild<ThumbnailResult>(THUMBNAILS_ENTRY, request, t("runtime.thumbnailsLabel"), THUMBNAILS_TIMEOUT_MS, options);
}
