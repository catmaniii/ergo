// 句子中间要放元素时（168 号票）：<T k="<区域>.<…>" params={{ name: <NameTag /> }} />——按当前语言取句子，{name} 换成给的元素。
// 只放文字的地方直接调 t()（state/index.ts 转出的）。换了语言整棵树重画（App 最外层的 useLocale），这里不用另外订阅。
import { Fragment, type ReactNode } from "react";
import { type MessageParams, tParts } from "../state/index.ts";

export function T({ k, params }: { k: string; params: MessageParams }) {
  return (
    <>
      {tParts(k, params).map((part, i) => (
        // 句子拆出来的几段顺序固定，按位置当 key
        <Fragment key={i}>{part as ReactNode}</Fragment>
      ))}
    </>
  );
}
