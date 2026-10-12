// 工具包里"给秘书发消息"那个开关（102 号票）：开着时维护者（和它派的子 agent、阶段验收的评审）能用 tell_secretary 给秘书发一条消息，
// 由秘书在主线里转告用户；关掉了它们都没有这个工具。默认开着（工具包里不写），关掉了写 false（协议包的 canTellSecretary、tellSecretaryField）。
// 开没开、拨一下之后的工具包、开关的名字和旁边的说明：真项目真任务的工具包区（ToolkitPanel）、原型的工具包区、计划卡上的工具包共用。纯函数。
// 名字和说明里提到秘书的写名字占位（43 号票），界面上用 NamedText 显示用户起的名字。
import { ASSISTANT_NAME_MARK, canTellSecretary, TELL_SECRETARY_CAPABILITY, tellSecretaryField } from "./protocol.ts";

/** 开关的名字（和工具包变更里的说法同一个） */
export const TELL_SECRETARY_LABEL = TELL_SECRETARY_CAPABILITY;

/** 开关旁边的说明 */
export const TELL_SECRETARY_HINT = `开着时维护者和它派的子 agent、验收的评审有你该知道的事（做到一半的发现、项目内部的事做完了），能给${ASSISTANT_NAME_MARK}发一条消息，由${ASSISTANT_NAME_MARK}在对话里转告你（每个 10 分钟最多 3 条）；关掉它们就都没有这个工具`;

/** 开着没有：工具包里不写是开着 */
export function tellSecretaryOn(toolkit: { readonly tellSecretary?: boolean | undefined }): boolean {
  return canTellSecretary(toolkit);
}

/** 拨一下之后的工具包：开着不写这一项（和之前存下的一样），关掉了写 false；别的几样原样 */
export function withTellSecretary<T extends { tellSecretary?: boolean | undefined }>(toolkit: T, on: boolean): T {
  const { tellSecretary: _was, ...rest } = toolkit;
  return { ...rest, ...tellSecretaryField(on) } as T;
}
