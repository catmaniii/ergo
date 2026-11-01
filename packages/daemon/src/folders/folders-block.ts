// 授权的文件夹给 agent 的那一块：秘书以外的 agent（任务和项目的负责人、定时作业、子 agent、评审）被唤起时带上现在授权了哪几个文件夹，
// 这些文件夹里的文件可以直接读、不用问。还没有授权的文件夹时没有这一块。秘书的那一块多写了聊天里怎么提议授权（authorize-folders.ts 的 secretaryFoldersBlock）。
// 单独一个文件、不依赖快速动作：子 agent、评审这些一次性子进程的模块也用它。
import type { LocalFoldersView } from "@ergo/protocol";

/** 设置里在哪看、在哪改（agent 的上下文、工具说明里说这一句，给模型的照旧中文；卡上给用户看的走 t()） */
export const AUTHORIZED_FOLDERS_SETTING = "设置 · 授权的文件夹"; // @i18n-ignore model：上下文和工具说明里用

/** 上下文块"授权的文件夹"的 id（内核给的，不带插件名的前缀，不会和插件的重） */
export const AUTHORIZED_FOLDERS_BLOCK_ID = "authorized-folders";

/** 能直接读的那一句：秘书和别的 agent 共用 */
// @i18n-ignore-next model：agent 的上下文块
export const AUTHORIZED_FOLDERS_READ_NOTE = "这些文件夹里的文件可以直接读，不用问用户。只放开了读：写、删、覆盖照原来的规矩，.env、私钥这类密钥文件也照原来的规矩；用完整路径读，cd 进去、跑里面的脚本不算读。";

/** 秘书以外的 agent 被唤起时带的那一块；还没有授权的文件夹时没有 */
export function agentFoldersBlock(view: LocalFoldersView): string | undefined {
  if (view.folders.length === 0) return undefined;
  // @i18n-ignore-start model：agent 的上下文块
  return [
    "授权的文件夹（用户授权的，你自己改不了；要改请用户去" + AUTHORIZED_FOLDERS_SETTING + "）：",
    ...view.folders.map((f) => `- ${f.path}${f.exists ? "" : "（现在找不到了）"}`),
    AUTHORIZED_FOLDERS_READ_NOTE,
  ].join("\n");
  // @i18n-ignore-end
}

/** 一次性子进程（子 agent、评审）的拉起参数里那一块：没有就什么都不加 */
export function foldersContribution(block: (() => string | undefined) | undefined): { contributions?: { contextBlocks: { id: string; text: string }[]; hooks: [] } } {
  const text = block?.();
  return text ? { contributions: { contextBlocks: [{ id: AUTHORIZED_FOLDERS_BLOCK_ID, text }], hooks: [] } } : {};
}
