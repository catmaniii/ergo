// 再定位一次（369 号票）：地址已经是 …/at/<卡片> 了，再点一次标题上的"等你……"地址不变、页面收不到变化，用户可能已经滚走了。
// 点的地方说一声，开着这个地址的会话再滚过去、闪一下。
const listeners = new Set<(at: string) => void>();

export function revealAgain(at: string): void {
  for (const listener of listeners) listener(at);
}

/** 返回取消登记的函数 */
export function onRevealAgain(listener: (at: string) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
