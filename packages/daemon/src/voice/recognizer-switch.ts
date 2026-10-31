// 换识别的接入方式（346 号票）：组件页装好语音识别模型以后，不用重启守护进程就改走新接入；删掉时换回去。
// 上层（识别、预热、Debug、参考音色）拿的都是这一个 Recognizer，里面现在接谁由 use 定：
// 老的那条关掉（它手头的请求以"语音识别已停止"结束，语音消息按 208 号票自动重试），之后的状态、一生里的事都看新的。
import type { VoiceModelState } from "@ergo/protocol";
import type { Recognizer, RecognizerLifecycleEvent } from "./recognizer.ts";

export interface SwitchableRecognizer extends Recognizer {
  /** 换成这一条（马上生效，状态变了会通知）；已经关了就把它也关掉 */
  use(next: Recognizer): void;
}

export function createSwitchableRecognizer(initial: Recognizer, log: (line: string) => void): SwitchableRecognizer {
  let current = initial;
  let closed = false;
  const listeners = new Set<(state: VoiceModelState) => void>();
  const lifecycle = new Set<(event: RecognizerLifecycleEvent) => void>();
  let unwatch: (() => void)[] = [];
  const watch = (recognizer: Recognizer) => {
    unwatch = [
      recognizer.onState((state) => {
        for (const listener of listeners) listener(state);
      }),
      recognizer.onLifecycle((event) => {
        for (const listener of lifecycle) listener(event);
      }),
    ];
  };
  watch(current);
  const closeQuietly = (recognizer: Recognizer) => void recognizer.close().catch((err: unknown) => log(`换语音识别的接入方式时，老的那条没关干净：${err instanceof Error ? err.message : String(err)}`));

  return {
    get running() {
      return current.running;
    },
    get state() {
      return current.state;
    },
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onLifecycle(listener) {
      lifecycle.add(listener);
      return () => lifecycle.delete(listener);
    },
    transcribe: (request, audioMs) => current.transcribe(request, audioMs),
    load: () => current.load(),
    check: () => current.check(),
    use(next) {
      if (closed) {
        closeQuietly(next);
        return;
      }
      for (const off of unwatch) off();
      const old = current;
      current = next;
      watch(next);
      closeQuietly(old);
      for (const listener of listeners) listener(next.state);
    },
    async close() {
      closed = true;
      for (const off of unwatch) off();
      unwatch = [];
      await current.close();
    },
  };
}
