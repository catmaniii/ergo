// 这个页面凭什么被信任（规格第 6 节）：本机端口自动信任；外网端口上要带着有效凭证的已配对设备，否则显示配对等待页。
// App 启动时问一次（/api/access），结果放在这里给页面用（比如设置里的已配对设备标出"就是这台"）。
import { createContext, type ReactNode, useContext } from "react";
import type { AccessInfo } from "../state/index.ts";

const AccessContext = createContext<AccessInfo | undefined>(undefined);

export function AccessProvider({ access, children }: { access: AccessInfo | undefined; children: ReactNode }) {
  return <AccessContext.Provider value={access}>{children}</AccessContext.Provider>;
}

/** 这个页面的信任来源；直接打开构建产物（原型，没有守护进程）时是 undefined */
export function useAccess(): AccessInfo | undefined {
  return useContext(AccessContext);
}
