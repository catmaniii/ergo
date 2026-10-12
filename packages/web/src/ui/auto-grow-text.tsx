// 随内容自动长高的多行文本框（105 号票）：卡片里"一条一条可改"的条目（计划卡的假设、提问卡上自己写的答案）原来是单行框，
// 长了看不全、也不好找到要改的地方。这里每条都整段显示，在任意位置改；改字、框变宽变窄（转屏、拖分栏）都重新量高度。
// 按回车照常换行（和普通多行框一样）；清空一条有什么意思由用它的地方定（假设：清空就是去掉这一条）。
import { type TextareaHTMLAttributes, useLayoutEffect, useRef } from "react";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "rows"> & {
  value: string;
  onChange(value: string): void;
};

/** 量一次：先缩到一行再按内容的高度撑开（加上上下边框，box-sizing 是 border-box） */
function fit(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  const border = el.offsetHeight - el.clientHeight;
  el.style.height = `${el.scrollHeight + border}px`;
}

export function AutoGrowText({ value, onChange, className, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // 内容变了（打字、外面改了这一条）：框里的字已经是新的，按它量
  useLayoutEffect(() => {
    if (ref.current?.value === value) fit(ref.current);
  }, [value]);
  // 宽度变了（转屏、拖分栏、卡片展开）：折行跟着变，重新量（只看宽度，免得自己改高度又触发）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <textarea ref={ref} rows={1} className={`auto-grow${className ? ` ${className}` : ""}`} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}
