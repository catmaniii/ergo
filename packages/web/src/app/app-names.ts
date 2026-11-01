// App 和网页之间的名字：原生桥 window.ergoNative、侧边栏的 window.ergoSide 这些 App 挂给网页的对象，
// window.__ergoBack、__ergoInsets、__ergoVoice、__ergoBrowser、__ergoNotifyOpen、__ergoSide 这些网页挂给 App 调的函数。

/** App 挂在页面全局对象上的对象 */
export function appObject(scope: object, name: string): unknown {
  return (scope as Record<string, unknown>)[name];
}

/** 网页挂给 App 调的函数：挂上；返回撤掉（还是这一个时才撤，别的地方换过的不动） */
export function exposeToApp(scope: object, name: string, fn: unknown): () => void {
  const s = scope as Record<string, unknown>;
  s[name] = fn;
  return () => {
    if (s[name] === fn) delete s[name];
  };
}
