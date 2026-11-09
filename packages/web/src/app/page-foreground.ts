// 页面回到前台（450）在页面上的那一半：交给 WebSocket 连接（ws-connection.ts 的 onForeground），它据此探一下连接还通不通。
// 单独一个文件：ws-connection.ts 不碰 document、window，在 Node 里测。
// - 又看得见了（visibilitychange）、解冻了（resume：页面生命周期的冻结之后）、从往返缓存回来（pageshow）：这三样只在看得见时算；
// - 网回来了（online）：总算。
// 鸿蒙 App 的 ArkWeb 里，App 回到前台时页面照样报 visibilitychange（不一定马上，见 page-update.ts）。

/** 接上；返回退订 */
export function pageForeground(wake: () => void): () => void {
  const onShown = () => {
    if (document.visibilityState === "visible") wake();
  };
  document.addEventListener("visibilitychange", onShown);
  document.addEventListener("resume", onShown);
  window.addEventListener("pageshow", onShown);
  window.addEventListener("online", wake);
  return () => {
    document.removeEventListener("visibilitychange", onShown);
    document.removeEventListener("resume", onShown);
    window.removeEventListener("pageshow", onShown);
    window.removeEventListener("online", wake);
  };
}
