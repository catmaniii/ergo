// 工具包里"发附件"那个开关（117 号票）：开着时任务和项目的维护者能把工作目录里的文件作为附件发进它的会话（send_attachment），
// 给秘书发消息时也能带上附件；关掉了它们都没有（子 agent、评审一直没有）。默认开着（工具包里不写），关掉了写 false
// （协议包的 canSendAttachment、sendAttachmentField）。开没开、拨一下之后的工具包、开关的名字和旁边的说明：真项目真任务的工具包区
// （ToolkitPanel）、原型的工具包区、计划卡上的工具包共用。纯函数。说明里提到秘书的写名字占位（43 号票）。
import { ASSISTANT_NAME_MARK, canSendAttachment, sendAttachmentField, t } from "./protocol.ts";

/** 开关的名字（和工具包变更里的说法同一个）：协议包里跟着当前语言的常量，原样转出（转出的是活的绑定；在这里取一份的话取的时候还没装上语言，172 号票） */
export { SEND_ATTACHMENT_CAPABILITY as SEND_ATTACHMENT_LABEL } from "./protocol.ts";

/** 开关旁边的说明（170 号票起按当前语言现取） */
export function sendAttachmentHint(): string {
  return t("state.sendAttachment.hint", { name: ASSISTANT_NAME_MARK });
}

/** 开着没有：工具包里不写是开着 */
export function sendAttachmentOn(toolkit: { readonly sendAttachment?: boolean | undefined }): boolean {
  return canSendAttachment(toolkit);
}

/** 拨一下之后的工具包：开着不写这一项（和之前存下的一样），关掉了写 false；别的几样原样 */
export function withSendAttachment<T extends { sendAttachment?: boolean | undefined }>(toolkit: T, on: boolean): T {
  const { sendAttachment: _was, ...rest } = toolkit;
  return { ...rest, ...sendAttachmentField(on) } as T;
}
