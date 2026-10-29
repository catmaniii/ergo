// 页面桥测试用的 React 受控输入框（134 号票）：值在 React 的 state 里，旁边一行把 state 显示出来；表单提交了派一个 react-submitted 事件
// （测试页记一笔）。
// 不写 JSX（打包时不用配 JSX），用 createElement。
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

function Form() {
  const [title, setTitle] = useState("");
  return createElement(
    "form",
    {
      onSubmit: (e: Event) => {
        e.preventDefault();
        window.dispatchEvent(new Event("react-submitted"));
      },
    },
    createElement("label", { htmlFor: "react-title" }, "React 标题"),
    createElement("input", { id: "react-title", value: title, onChange: (e: { target: { value: string } }) => setTitle(e.target.value) }),
    createElement("output", { id: "react-state" }, title),
    createElement("button", { type: "submit" }, "提交"),
  );
}

createRoot(document.getElementById("react-root")!).render(createElement(Form));
