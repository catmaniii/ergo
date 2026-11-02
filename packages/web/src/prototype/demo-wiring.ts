// 演示页的一整套假东西（App.tsx 只从这里拿）：假连接、假 HTTP、假装已配对的访问信息、配对页的假接口、?demo-debug、看板的假数据。
// App.tsx 只在 `import.meta.env.MODE === "demo"` 的分支里调它，安装版这个分支在构建时摇掉，这一串模块都不进产物。
import type { Connection } from "../app/connection.ts";
import type { DaemonHttp } from "../app/daemon-http.ts";
import type { PairingApi } from "../app/pairing-flow.ts";
import type { AccessInfo } from "../state/index.ts";
import { startDemoDebug } from "./demo-debug.ts";
import { localized, localizedFake } from "./fake-content.ts";
import { FakeConnection } from "./fake-connection.ts";
import { FAKE_ACCESS } from "./fake-data.ts";
import { FakeDaemonHttp } from "./fake-http.ts";
import { previewPairingApi } from "./preview-pairing.ts";
import { ProtoProvider } from "./proto-store.tsx";

export interface DemoWiring {
  readonly connection: Connection;
  readonly http: DaemonHttp;
  /** 假装是从已配对的一台手机上打开的：设置 · 已配对设备里标"就是这台" */
  access(): AccessInfo;
  pairingApi(): PairingApi;
  startDebug(): void;
  readonly ProtoProvider: typeof ProtoProvider;
}

export function demoWiring(): DemoWiring {
  const fake = new FakeConnection();
  return {
    connection: localizedFake(fake),
    // 原型的改工作日历交给假连接推事件
    http: localizedFake(new FakeDaemonHttp(fake)),
    access: () => localized(FAKE_ACCESS),
    pairingApi: () => localizedFake(previewPairingApi(navigator.userAgent)),
    startDebug: startDemoDebug,
    ProtoProvider,
  };
}
