// 个人助理的名字（43 号票，规格第 19 节"名称"）：用户给秘书起的名字，存在守护进程（各设备一样），改了经名字频道推来。
// 界面上凡是说到它的地方都用这个名字（带底色的小标签，ui/assistant-name.tsx）；守护进程生成的话里提到秘书的写名字占位，
// 按现在的名字显示（splitAssistantName / fillAssistantName），所以改名后旧的话也跟着变。改名走 HTTP（守护进程改完推一条事件）。
// 43 号票之前存下的事件里写死了"秘书""待我处理"的那几句固定的话，显示前按协议包的对照表 LEGACY_WORDING 换成现在的说法。
import { type AssistantNameSegment, currentWording, DEFAULT_ASSISTANT_NAME, fillAssistantName, splitAssistantName } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 现在的名字；没收到过名字事件就是默认的"个人助理" */
export function assistantNameOf(state: UiState): string {
  return state.assistantName ?? DEFAULT_ASSISTANT_NAME;
}

/**
 * 名字的第一个字（40 号票：暖纸手帐的圆形字头像画它）。取的是第一个字素簇（Intl.Segmenter）：国旗、用零宽连接符拼成的
 * 组合表情、带组合附加符号的字母都算一个字，不拆开；没有 Intl.Segmenter 的环境退回按码点取（这几种会只取到第一个码点）。
 * 前后的空白不算；名字是空的给空字符串。写成 CSS 字符串在界面层（ui/conversation/conversation-root.ts）
 */
export function assistantInitial(name: string): string {
  const text = name.trim();
  if (typeof Intl.Segmenter === "function") return new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text).containing(0)?.segment ?? "";
  return Array.from(text)[0] ?? "";
}

/** 守护进程写的一段话拆成文字和名字两种段（界面上名字那一段画成名字标签）：旧说法先换成现在的 */
export function daemonTextSegments(text: string): AssistantNameSegment[] {
  return splitAssistantName(currentWording(text));
}

/** 守护进程写的一段话放在纯文字的地方（title、aria-label、浏览器通知）：旧说法换成现在的，名字占位换成名字 */
export function daemonTextPlain(text: string, name: string): string {
  return fillAssistantName(currentWording(text), name);
}
