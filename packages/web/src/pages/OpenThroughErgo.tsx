// 安装版的页面被直接打开（双击安装目录里的 index.html，地址是 file://）时的那一页：没有守护进程可连，也不带假数据，
// 只说这个页面要经二狗打开、怎么打开。不连网络、不读状态层以外的东西（main.tsx 不让 App 起来）。样式借配对等待页的（也是一张居中的卡）。
import { t } from "../state/index.ts";
import { T } from "../ui/i18n.tsx";

/** 守护进程默认的本机地址（配置文件能改端口；改过的人知道自己改过） */
const LOCAL_ADDRESS = "http://127.0.0.1:8810";

export function OpenThroughErgo() {
  return (
    <div className="pair-page">
      <div className="card pair-card" data-testid="open-through-ergo">
        <div className="pair-brand">{t("shell.brand")}</div>
        <h2>{t("shell.openThroughErgo.title")}</h2>
        <p className="muted">
          <T
            k="shell.openThroughErgo.how"
            params={{
              command: <code>ergo start</code>,
              address: (
                <a className="link" href={LOCAL_ADDRESS}>
                  {LOCAL_ADDRESS}
                </a>
              ),
            }}
          />
        </p>
      </div>
    </div>
  );
}
