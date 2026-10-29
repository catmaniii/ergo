// 鸿蒙 App 和网页之间的名字（312 号票从 ergou* 换成了 ergo*）：原生桥 window.ergoNative、侧边栏的 window.ergoSide 这些 App 挂给网页的对象，
// window.__ergoBack、__ergoInsets、__ergoVoice、__ergoBrowser、__ergoNotifyOpen、__ergoSide 这些网页挂给 App 调的函数。
// 旧 App（还没装上新包）挂的、调的是旧名字，网页照样能用：
// - App 挂给网页的对象：新名字的优先，没有就用旧名字的（appObject）；
// - 网页挂给 App 调的函数：新旧两个名字都挂，撤的时候一起撤（exposeToApp）。
// 旧名字照协议包的 oldNameOf 从新名字推出来，这里不写旧的拼法。
import { oldNameOf } from "@ergo/protocol";

/** App 挂在页面全局对象上的对象：新名字的优先，没有就用旧名字的 */
export function appObject(scope: object, name: string): unknown {
  const s = scope as Record<string, unknown>;
  return s[name] ?? s[oldNameOf(name)];
}

/** 网页挂给 App 调的函数：新旧两个名字都挂上；返回撤掉（还是这一个时才撤，别的地方换过的不动） */
export function exposeToApp(scope: object, name: string, fn: unknown): () => void {
  const s = scope as Record<string, unknown>;
  const names = [name, oldNameOf(name)];
  for (const n of names) s[n] = fn;
  return () => {
    for (const n of names) if (s[n] === fn) delete s[n];
  };
}
