// 我的名字（249 号票，用户 2026-10-22："另外可以加一个我的名字的设置，让 agent 可以叫我的名字"）：
// 用户**自己**的名字，和 43 号票"个人助理的名字"是两回事——那是用户给秘书起的，这是用户自己的，agent 的系统提示里
// 知道该称呼用户什么，界面上能用则用。不引用 TypeBox（配置文件、设置接口的 schema 在 user-name-schema.ts）。
//
// 规矩照个人助理的名字（assistant-name.ts 的 checkAssistantName）：去掉首尾空白后 1–8 个字（按 Unicode 码点数），
// 不能有换行（LF、CR、NEL、U+2028/2029）和控制字符，不能含名字占位的括号"⟦""⟧"。不合规的原因就用那几句
// （"名字不能是空的""名字最多 8 个字……"），设置里两个输入框的说法一样，不另造一套。
import { type AssistantNameCheck, ASSISTANT_NAME_MAX, checkAssistantName } from "./assistant-name.ts";

/** 名字最多几个字（和用户给助理起的名字同一条规矩） */
export const USER_NAME_MAX = ASSISTANT_NAME_MAX;

export type UserNameCheck = AssistantNameCheck;

/** 用户自己的名字合不合规（规矩就是 checkAssistantName 的规矩）；合规时给出要存的名字（去掉了首尾空白） */
export function checkUserName(raw: string): UserNameCheck {
  return checkAssistantName(raw);
}
