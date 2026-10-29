// 起动前的两项检查（315 号票，preflight.ts）：只支持 Windows、Node 版本跟着 pi（ADR-0031，engines.node 写最低要求）。
// 入口（main.ts）在加载组合根之前做；不对就一句话、不启动。
import { describe, expect, it } from "vitest";
import { checkNodeVersion, enginesNode, platformProblem, preflight } from "../src/preflight.ts";

describe("起动前的检查", () => {
  it("只支持 Windows：别的系统一句话说明不支持（中英都有），Windows 上没问题", () => {
    expect(platformProblem("win32")).toBeUndefined();
    expect(platformProblem("darwin")).toBe("二狗现在只支持 Windows（10 / 11），这台电脑是 macOS，不启动（ergo only runs on Windows for now）。");
    expect(platformProblem("linux")).toContain("这台电脑是 Linux");
    expect(platformProblem("haiku")).toContain("这台电脑是 haiku");
  });

  it("Node 版本：比最低要求旧的不启动、说该装哪个；同一个大版本照常；更新的大版本照常启动、提醒一句", () => {
    const range = ">=22.19.0";
    expect(checkNodeVersion("v22.18.0", range).problem).toBe(
      "Node 版本不够：二狗要 Node 22.19.0 或更新的 22.x（大版本跟着 pi 走，见 ADR-0031），这台是 v22.18.0，不启动。装 Node 22 的最新版：https://nodejs.org/dist/latest-v22.x/（ergo needs Node >= 22.19.0）",
    );
    expect(checkNodeVersion("v20.11.1", range).problem).toContain("这台是 v20.11.1");
    expect(checkNodeVersion("v22.19.0", range)).toEqual({});
    expect(checkNodeVersion("v22.23.4", range)).toEqual({});
    const newer = checkNodeVersion("v24.1.0", range);
    expect(newer.problem).toBeUndefined();
    expect(newer.note).toContain("Node v24.1.0 比二狗测过的大版本（22）新：照常启动");
    expect(() => checkNodeVersion("v22.23.4", "^22")).toThrow(/engines\.node 的写法认不出/);
  });

  it("最低要求取自 packages/daemon/package.json 的 engines.node（ADR-0031：现在 ≥ 22.19）；跑测试的这一份 Node 过得了", () => {
    expect(enginesNode()).toBe(">=22.19.0");
    expect(preflight("win32", process.version).problem).toBeUndefined();
    // 不是 Windows 的先说系统
    expect(preflight("darwin", "v18.0.0").problem).toContain("只支持 Windows");
    expect(preflight("win32", "v22.0.0").problem).toContain("Node 版本不够");
    expect(preflight("win32", "v26.0.0").notes).toHaveLength(1);
  });
});
