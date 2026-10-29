// 网页现在是哪一版（116 号票）：服务端更新了网页（npm run build:web 换了 index.html，守护进程不重启），开着的页面要知道，提示刷新。
// - 版本号是构建时写进 index.html <head> 开头的 <meta name="ergo-web-version">（构建产物内容的哈希，packages/web/build/web-version-plugin.ts），
//   从文件里取（协议包的 webVersionInHtml）；
// - 文件按修改时间和大小认变没变，变了才重新读。读的时候文件不在（正在重新构建：Vite 先清空 dist/ 再写）照旧是上一版；
//   新文件里没有版本号（这张票之前构建的）是不知道；
// - 每隔一会儿（默认 2 秒）看一眼，换成了另一个版本号就告诉网关（onChange），网关在活动状态频道上推给开着的页面——build:web 之后几秒内推到。
//   变成不知道、文件不在都不推。订阅的响应、GET /api/web-version 问的时候现看一眼（current），不等下一轮。
import fs from "node:fs";
import { webVersionInHtml } from "@ergo/protocol";

/** 默认多久看一眼 index.html 换没换 */
export const DEFAULT_WEB_VERSION_POLL_MS = 2000;

export interface WebVersionWatch {
  /** 现在是哪一版（现看一眼）；不知道是 undefined */
  current(): string | undefined;
  close(): void;
}

export function watchWebVersion(indexFile: string, options: { pollMs: number; onChange(version: string): void }): WebVersionWatch {
  /** 上次读的时候文件的修改时间和大小 */
  let stamp: string | undefined;
  let version: string | undefined;

  const current = (): string | undefined => {
    let stat: fs.Stats;
    let html: string;
    try {
      stat = fs.statSync(indexFile);
      const next = `${stat.mtimeMs}:${stat.size}`;
      if (next === stamp) return version;
      html = fs.readFileSync(indexFile, "utf8");
      stamp = next;
    } catch {
      // 文件不在（还没构建、正在重新构建）、读不了：照旧是上一版
      return version;
    }
    version = webVersionInHtml(html);
    return version;
  };

  // 开始时的这一版不推（连上的页面在订阅的响应里拿到）
  let pushed = current();
  const timer = setInterval(() => {
    const now = current();
    if (now === undefined || now === pushed) return;
    pushed = now;
    options.onChange(now);
  }, options.pollMs);
  timer.unref();

  return { current, close: () => clearInterval(timer) };
}
