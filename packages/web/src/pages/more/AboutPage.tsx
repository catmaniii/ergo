// 设置最下面的"关于二狗"（124 号票，用户 2026-10-14 提）：二狗图标、大字版本号（根 package.json 的 version，构建时写进页面），
// 下面一组小字——页面构建（116 号票的版本号）、守护进程的版本和已运行多久（daemon_info）、鸿蒙 App 的版本（只在 App 里）、
// 这台设备怎么连进来的（本机 / 经外网 · 设备名）；再下面是这一版的更新日志（根目录 CHANGELOG.md 里当前版本那一节，
// 用报告页同一套 Markdown 画；日志里的"秘书"换成用户起的名字），以前的版本能展开。
// 连点版本号 8 次打开 Debug 工具集（两次之间超过 2 秒重新数，第 4 次起底部提示还差几次；1 小时内有效，只在页面内存里）。
import { useEffect, useMemo, useState } from "react";
import { useAccess } from "../../app/access.tsx";
import { APP_VERSION, CHANGELOG, PAGE_WEB_VERSION } from "../../app/build-info.ts";
import { tapVersion, useDebugUnlock } from "../../app/page-debug.ts";
import { pageNativeApp } from "../../app/page-native.ts";
import { isPrototypePage } from "../../app/prototype-mode.ts";
import { useStore } from "../../app/store.tsx";
import ergoIcon from "../../assets/ergo-icon.webp";
import { type AccessInfo, changelogFor, changelogWithName, type DaemonInfo, t, uptimeText } from "../../state/index.ts";
import { useAssistantName } from "../../ui/assistant-name.tsx";
import { useToast } from "../../ui/toast.tsx";
import { MarkdownBody } from "../ReportPage.tsx";

/** 页面直接从构建产物打开、或者是在线演示页（原型，没有守护进程；app/prototype-mode.ts） */
export const PROTOTYPE = typeof window !== "undefined" && isPrototypePage(window.location.protocol, import.meta.env.MODE);

/** 这台设备怎么连进来的 */
export function connectionText(access: AccessInfo | undefined): string {
  if (access?.access === "local") return t("pages.about.connection.local");
  if (access?.access === "device") return t("pages.about.connection.device", { device: access.device.name });
  return PROTOTYPE ? t("pages.about.connection.prototype") : t("pages.about.connection.unknown");
}

/** 问到的守护进程的版本：连同问到时这台设备的钟（已运行多久按守护进程的钟往后推） */
export interface DaemonInfoState {
  readonly info?: DaemonInfo;
  readonly receivedAt?: number;
  readonly error?: string;
}

/** 打开时问一次守护进程的版本；连上（重连上）时再问。原型的假连接不报连上，直接问 */
export function useDaemonInfo(): DaemonInfoState {
  const { daemonInfo, ui } = useStore();
  const [state, setState] = useState<DaemonInfoState>({});
  const online = ui.connection === "online";
  useEffect(() => {
    if (!online && !PROTOTYPE) return;
    let live = true;
    daemonInfo().then(
      (info) => live && setState({ info, receivedAt: Date.now() }),
      (err: unknown) => live && setState({ error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [daemonInfo, online]);
  return state;
}

/** 守护进程那一行：版本 · 已运行多久；还在问、问不到的说一声 */
export function daemonText(state: DaemonInfoState, now: number): string {
  if (state.info && state.receivedAt !== undefined) {
    const up = Date.parse(state.info.now) - Date.parse(state.info.startedAt) + (now - state.receivedAt);
    return t("pages.about.daemonUp", { version: state.info.version, uptime: uptimeText(up) });
  }
  return state.error ? t("pages.about.daemonFailed", { reason: state.error }) : t("pages.about.daemonAsking");
}

/** 每 30 秒走一下的钟（已运行多久跟着变） */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function AboutPage({ onDebug }: { onDebug(): void }) {
  const toast = useToast();
  const access = useAccess();
  const daemon = useDaemonInfo();
  const now = useMinuteClock();
  const debug = useDebugUnlock();
  const app = pageNativeApp();
  const [earlierOpen, setEarlierOpen] = useState(false);
  // 日志里的"秘书"换成现在的名字（改名后跟着变）
  const name = useAssistantName();
  const productName = t("pages.about.productName");
  const { current, earlier } = useMemo(() => changelogFor(changelogWithName(CHANGELOG, name), APP_VERSION), [name]);

  const facts: [string, string][] = [
    [t("pages.about.fact.page"), PAGE_WEB_VERSION ?? t("pages.about.devServer")],
    [t("pages.about.fact.daemon"), daemonText(daemon, now)],
    ...(app ? ([[t("pages.about.fact.app"), app.version]] as [string, string][]) : []),
    [t("pages.about.fact.device"), connectionText(access)],
  ];

  return (
    <div className="about">
      <div className="about-head">
        <img className="about-icon" src={ergoIcon} alt="" width={72} height={72} />
        <div className="about-name">
          {/* 英文时产品名本身就是 Ergo，不再并排写一遍 */}
          {productName === "Ergo" ? productName : (
            <>
              {productName} <span className="about-name-en">Ergo</span>
            </>
          )}
        </div>
        <button
          type="button"
          className="about-version"
          aria-label={t("pages.about.version", { version: APP_VERSION })}
          onClick={() => {
            const hint = tapVersion();
            if (hint) toast(hint);
          }}
        >
          {APP_VERSION}
        </button>
        {debug.open && (
          <button type="button" className="link" onClick={onDebug}>
            {t("pages.about.debugOpen", { count: debug.minutesLeft })}
          </button>
        )}
      </div>
      <dl className="about-facts">
        {facts.map(([label, value]) => (
          <div key={label} className="about-fact">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <section className="sec about-log">
        <div className="sec-head">
          <h3>{t("pages.about.whatsNew")}</h3>
          {current?.date && <span className="muted">{current.date}</span>}
        </div>
        {current?.body ? <MarkdownBody text={current.body} /> : <div className="muted">{t("pages.about.noEntry", { version: APP_VERSION })}</div>}
        {earlier.length > 0 && (
          <>
            <button type="button" className="link about-earlier-toggle" aria-expanded={earlierOpen} onClick={() => setEarlierOpen((o) => !o)}>
              {earlierOpen ? t("pages.about.hideEarlier") : t("pages.about.earlier", { count: earlier.length })}
            </button>
            {earlierOpen &&
              earlier.map((section) => (
                <div key={section.version} className="about-earlier">
                  <div className="about-earlier-head">
                    <b>{section.version}</b>
                    {section.date && <span className="muted">{section.date}</span>}
                  </div>
                  <MarkdownBody text={section.body} />
                </div>
              ))}
          </>
        )}
      </section>
    </div>
  );
}
