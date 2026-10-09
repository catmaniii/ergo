// 个人助理的名字（43 号票，规格第 19 节"名称"）：界面上凡是说到秘书的地方都用用户起的名字（设置里改，各设备一样），
// 显示成带底色的小标签，和普通文字分得开（颜色是 token --name-bg / --name-fg，39 号票的每套风格可以覆盖）。
// - 界面自己写的话：直接放 <AssistantName />；
// - 守护进程生成的话（会话里的系统说明、待我处理事项的标题和说明、卡片上的说明、通知……）里提到秘书的写名字占位，
//   用 <NamedText text={…} /> 显示：占位换成名字标签，所以改名后旧的话也跟着变（43 号票之前存下的旧说法也认，见
//   state/assistant-name.ts 的 daemonTextSegments）；
// - 只能放纯文字的地方（title、aria-label、输入框、浏览器通知）用 useNamedPlain() 换成名字本身。
import { Fragment, useCallback } from "react";
import { useStore } from "../app/store.tsx";
import { assistantNameOf, daemonTextPlain, daemonTextSegments } from "../state/index.ts";

/** 现在的名字（没起过名是默认的"个人助理"） */
export function useAssistantName(): string {
  return assistantNameOf(useStore().ui);
}

/** 名字本身：带底色的小标签 */
export function AssistantName() {
  return <span className="assistant-name">{useAssistantName()}</span>;
}

/** 一段话：名字占位（和旧数据里的旧说法）换成名字标签，其余原样 */
export function NamedText({ text }: { text: string }) {
  const segments = daemonTextSegments(text);
  return <>{segments.map((s, i) => ("name" in s ? <AssistantName key={i} /> : <Fragment key={i}>{s.text}</Fragment>))}</>;
}

/** 纯文字的地方：把名字占位换成名字本身（名字不变时是同一个函数） */
export function useNamedPlain(): (text: string) => string {
  const name = useAssistantName();
  return useCallback((text: string) => daemonTextPlain(text, name), [name]);
}
