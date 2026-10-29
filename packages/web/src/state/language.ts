// 设置 · 语言（168 号票）：语言列表每一行写什么、读语言文件出的问题怎么说（纯函数，文字按当前语言现取）。
// 全局一个语言，存在守护进程（各设备一样）；换了以后守护进程在语言频道上推 language 和临时事件 locale，开着的页面重取词典
// （app/locale.ts），不刷新就换过来。
import { DEFAULT_LANGUAGE, type LocaleListView, type LocaleProblemView, type LocaleSummary, t } from "./protocol.ts";

/**
 * 设置列表里这一项、语言页的标题：永远中英两种写着（选错了语言也找得回来），不进语言文件
 */
export const LANGUAGE_SETTING_TITLE = "语言 / Language"; // @i18n-ignore fixed：中英并列，选错了语言也找得回来

/** 语言列表里的一行 */
export interface LanguageRow {
  id: string;
  /** 本地名（"English"、"中文"），不翻 */
  nativeName: string;
  /** 正在用的那种 */
  current: boolean;
  /** 设置里选的那种（选的不在了时它不在列表里） */
  selected: boolean;
  /** 小字：自带、来自哪个目录、改了几句、缺几句 */
  notes: string[];
}

function notesOf(summary: LocaleSummary, userDir: string): string[] {
  const notes: string[] = [];
  if (summary.source === "builtin") notes.push(t("shell.language.builtin"));
  else if (summary.source === "user") notes.push(t("shell.language.user", { dir: userDir }));
  else notes.push(t("shell.language.overridden", { count: summary.overridden, dir: userDir }));
  if (summary.missing > 0) notes.push(t("shell.language.missing", { count: summary.missing }));
  return notes;
}

/** 语言列表：按守护进程给的顺序（中文、自带的、用户加的） */
export function languageRows(view: LocaleListView): LanguageRow[] {
  return view.languages.map((summary) => ({
    id: summary.id,
    nativeName: summary.nativeName,
    current: summary.id === view.effective,
    selected: summary.id === view.language,
    notes: notesOf(summary, view.userDir),
  }));
}

/** 选的语言不在了（~/.ergo/locales 里删了），实际先用中文：写一句；没这回事是 undefined */
export function languageGoneText(view: LocaleListView): string | undefined {
  if (view.language === view.effective || view.effective !== DEFAULT_LANGUAGE) return undefined;
  return t("shell.language.gone", { id: view.language, dir: view.userDir });
}

/** 读语言文件出的一个问题：哪个文件、哪里错 */
export function localeProblemText(problem: LocaleProblemView): string {
  return t(`shell.language.problem.${problem.code}`, { detail: problem.detail ?? "", key: problem.key ?? "" });
}
