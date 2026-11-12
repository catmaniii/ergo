// 装好以后还要接上的组件：组件服务（service.ts）只管下载、校验、换上、删；常驻服务要做的事（生成配置、经服务管家登记启动、
// 卸载时撤销）在这个接口后面。现在的实现是 audio.cpp 的（audiocpp-host.ts）；清单里没写 service / serve 的组件它都不管。
import type { ComponentServiceView } from "@ergo/protocol";
import type { ComponentManifest, ManifestComponent, ManifestVariant } from "./manifest.ts";

/** 组件服务交给接口后面的：清单、哪些装好了（文件都在） */
export interface ComponentHostContext {
  manifest: ComponentManifest;
  /** 装好了：装在哪、装的是哪一版；没装是 undefined */
  installed(id: string): { dir: string; variant: ManifestVariant } | undefined;
  /** 状态变了（页面下次取的时候看得到） */
  changed(): void;
}

export interface ComponentHost {
  attach(context: ComponentHostContext): void;
  /**
   * 这个组件不装在数据目录下时：装到哪个根目录下（清单的 target 相对它，下了一半的放它的 .staging/）、给人看的一句为什么。
   * 装在数据目录下是 undefined（351：数据目录的路径带中文时，audio.cpp 的程序和模型装到不带中文的地方）
   */
  relocated?(component: ManifestComponent): { root: string; note: string } | undefined;
  /** 这个组件现在不能装的原因 */
  blocked(component: ManifestComponent): string | undefined;
  /** 点安装时（下载之前）：已有用户自己配的、服务管家没接上的抛 RequestRejected */
  preflight(component: ManifestComponent): Promise<void>;
  /** 换上新文件之前：服务停下来（跑着的程序占着文件） */
  beforeReplace(component: ManifestComponent): Promise<void>;
  /** 文件换上了：后台接上服务（不抛错，结果看 service） */
  installed(component: ManifestComponent): void;
  /** 删文件之前：最后一个模型、或者程序本身要删时撤登记和名单；撤不掉的抛 RequestRejected，文件不删 */
  beforeRemove(component: ManifestComponent): Promise<void>;
  /** 文件删了：还有别的模型时后台重启服务 */
  removed(component: ManifestComponent): void;
  /** 启动（后台，马上回）、停止；不是这个组件的事抛 RequestRejected */
  control(component: ManifestComponent, action: "start" | "stop"): Promise<void>;
  /** 程序组件的运行状态（没装、不是程序组件是 undefined） */
  service(component: ManifestComponent): ComponentServiceView | undefined;
  /** 现看一眼（已有用户自己配的吗、自己的服务通不通）：页面取清单前调 */
  refresh(): Promise<void>;
  /** 后台的事都做完了（测试用） */
  whenIdle(): Promise<void>;
  /** 守护进程停下：不再接新的 */
  stop(): void;
}
