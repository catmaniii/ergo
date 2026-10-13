// 有新版本的提示（116 号票）：服务端的页面更新了，内容区最上面一条"二狗有新版本 · 刷新 · 等会儿"，不会自动收起。
// 点"刷新"重新加载页面（输入框里打的字先存下、刷新后放回）；点"等会儿"收起，切回前台、或者又来了新的一版时再出。
// 什么时候出、什么时候直接刷新（在后台时来的、回到前台时页面上没有会丢的东西）见 app/page-update.ts 和 state/page-update.ts。
// 主框架里一份（App.tsx 的 Shell），不出提示时也挂着：切前后台、问服务端都在它里面。
import { usePageUpdate } from "../app/page-update.ts";

export function PageUpdateBar() {
  const { prompt, refresh, later } = usePageUpdate();
  if (!prompt) return null;
  return (
    <div className="update-bar" role="status">
      <span className="update-bar-text">二狗有新版本</span>
      <span className="update-bar-acts">
        <button type="button" className="btn primary small" onClick={refresh}>
          刷新
        </button>
        <button type="button" className="btn ghost small" title="先收起，切回前台或者又有新版本时再提示" onClick={later}>
          等会儿
        </button>
      </span>
    </div>
  );
}
