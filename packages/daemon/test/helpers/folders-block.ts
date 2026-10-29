// 138 号票起秘书每次被唤起都带一块"授权的文件夹"（内核经 agent 贡献登记的上下文块，注入在那一条输入之前；新会话里
// faux 的回显把它排在系统提示前面）。只关心系统提示、对话先后的用例，比之前先把这块去掉（这块本身的内容见 authorized-folders.test.ts）。
import { secretaryFoldersBlock } from "../../src/folders/authorize-folders.ts";

/** 没有授权的文件夹时，秘书的回显里那一块（[user] 开头的一条上下文消息） */
export const NO_FOLDERS_BLOCK = `[user] ${secretaryFoldersBlock({ folders: [] })}`;

/** 去掉回显里"还没有授权的文件夹"那几块（连同隔开它的换行；压缩之后再注入的那块在最后） */
export function withoutFoldersBlock(echo: string): string {
  return echo.replaceAll(`${NO_FOLDERS_BLOCK}\n`, "").replaceAll(`\n${NO_FOLDERS_BLOCK}`, "").replaceAll(NO_FOLDERS_BLOCK, "");
}
