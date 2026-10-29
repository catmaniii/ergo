// 工具包里"给秘书发消息"那个开关（102 号票）：开着时维护者（和它派的子 agent、阶段验收的评审）能用 tell_secretary 给秘书发一条消息，
// 由秘书在主线里转告用户；关掉了它们都没有这个工具。默认开着（工具包里不写），关掉了写 false（协议包的 canTellSecretary、tellSecretaryField）。
// 开没开、拨一下之后的工具包、开关的名字和旁边的说明：真项目真任务的工具包区（ToolkitPanel）、原型的工具包区、计划卡上的工具包共用。纯函数。
// 名字和说明里提到秘书的写名字占位（43 号票），界面上用 NamedText 显示用户起的名字。
import { ASSISTANT_NAME_MARK, canTellSecretary, t, tellSecretaryField } from "./protocol.ts";

/** 开关的名字（和工具包变更里的说法同一个）：协议包里跟着当前语言的常量，原样转出（转出的是活的绑定；在这里取一份的话取的时候还没装上语言，172 号票） */
export { TELL_SECRETARY_CAPABILITY as TELL_SECRETARY_LABEL } from "./protocol.ts";

/** 开关旁边的说明（170 号票起按当前语言现取） */
export function tellSecretaryHint(): string {
  return t("state.tellSecretary.hint", { name: ASSISTANT_NAME_MARK });
}

/** 开着没有：工具包里不写是开着 */
export function tellSecretaryOn(toolkit: { readonly tellSecretary?: boolean | undefined }): boolean {
  return canTellSecretary(toolkit);
}

/** 拨一下之后的工具包：开着不写这一项（和之前存下的一样），关掉了写 false；别的几样原样 */
export function withTellSecretary<T extends { tellSecretary?: boolean | undefined }>(toolkit: T, on: boolean): T {
  const { tellSecretary: _was, ...rest } = toolkit;
  return { ...rest, ...tellSecretaryField(on) } as T;
}
