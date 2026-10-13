// 返回栈在页面上的那一半（62 号票，照搬 AgentSense 的返回键）：弹窗、选择器、详情页、标题栏的"返回"各自挂上一层，
// 带着自己的关法；按返回键（鸿蒙 App 调 window.__ergouBack）时运行该退的那一层的关法。先退哪一层由状态层定（state/back-stack.ts）。
// 这里不碰 React 和浏览器的全局变量，测试在 Node 里跑；React 钩子 useBackLayer 和页面上的那一份在 page-back.ts。
import { type BackKind, type BackStack, backTarget, canGoBack, closeBackLayer, openBackLayer, overlayOpen } from "../state/index.ts";

export interface BackRegistry {
  /** 挂上一层；handler 是按返回键时怎么关它（关了、离开了要调返回的函数拿下） */
  open(kind: BackKind, handler: () => void): () => void;
  /** 按返回键：运行该退的那一层的关法，返回 true；没有可退的返回 false（交给系统） */
  back(): boolean;
  /** 现在还能不能在网页里返回 */
  canGoBack(): boolean;
  /** 开着弹窗、选择器、详情页、抽屉这些吗（116 号票） */
  overlayOpen(): boolean;
  /** 挂上、拿下时通知；返回退订 */
  subscribe(listener: () => void): () => void;
}

export function createBackRegistry(): BackRegistry {
  let stack: BackStack = [];
  let nextId = 1;
  const handlers = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    open(kind, handler) {
      const id = nextId++;
      handlers.set(id, handler);
      stack = openBackLayer(stack, { id, kind });
      changed();
      return () => {
        if (!handlers.delete(id)) return;
        stack = closeBackLayer(stack, id);
        changed();
      };
    },
    back() {
      const target = backTarget(stack);
      if (!target) return false;
      handlers.get(target.id)?.();
      return true;
    },
    canGoBack: () => canGoBack(stack),
    overlayOpen: () => overlayOpen(stack),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
