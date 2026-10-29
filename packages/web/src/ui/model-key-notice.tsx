/**
 * 还没配模型（315 号票，给第一次装二狗的人）：模型的 key 没配时，会话输入框上面一条小栏——"还没配模型：<名字>现在回不了话（没有 DeepSeek 的 API Key）。
 * 去配置"，点了去设置 · 模型（那一页写着 key 从哪来、怎么配；319 号票的设置向导做好后指向向导）。守护进程照常起来、网页照常能开，
 * 只是回话前先说清楚。key 配没配经 GET /api/model-settings/key 现取（不查模型目录、马上回），连上（重连上）时取一次：
 * 319 号票起 key 能在网页上填了（保存后下一个新会话起用新的），填好之后回到会话页、重连上时这条栏自己就没了。
 * 和"不在时念的语音"（missed-voices.tsx）、"等你处理"栏一个底色、一样占一行，几条都在时上下排着。
 */
import { useEffect, useState } from "react";
import { toHash } from "../app/route-hash.ts";
import { useStore } from "../app/store.tsx";
import { type ModelKeyView, t } from "../state/index.ts";
import { AssistantName } from "./assistant-name.tsx";
import { T } from "./i18n.tsx";

/** 模型的 key 配没配：连上时取一次；还没取到、取不到（老版本的守护进程没有这个接口）是 undefined */
export function useModelKey(): ModelKeyView | undefined {
  const { http, ui } = useStore();
  const online = ui.connection === "online";
  const [view, setView] = useState<ModelKeyView>();
  useEffect(() => {
    if (!online) return;
    let alive = true;
    http.modelKey().then(
      (next) => {
        if (alive) setView(next);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [http, online]);
  return view;
}

/** 小栏本身（纯渲染：key 配着时什么都不画） */
export function ModelKeyNotice({ view }: { view: ModelKeyView | undefined }) {
  if (!view || view.apiKey.configured) return null;
  return (
    <div className="model-key-notice" role="status">
      <span className="model-key-notice-text">
        <T k="ui.modelKeyNotice.text" params={{ name: <AssistantName />, provider: view.provider.label }} />
      </span>
      <a className="link model-key-notice-go" href={toHash({ tab: "more", page: "models" })}>
        {t("ui.modelKeyNotice.go")}
      </a>
    </div>
  );
}
