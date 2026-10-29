// 关于页的更新日志（124 号票）：构建时把仓库根目录的 CHANGELOG.md 打进页面，取当前版本那一节显示，以前的版本能展开。
// 拿仓库里真的 CHANGELOG.md 和手写的几种写法核对。
import fs from "node:fs";
import { describe, expect, test } from "vitest";
import { ASSISTANT_NAME_MARK, changelogFor, changelogSections, changelogWithName } from "../../src/state/index.ts";

const REPO_CHANGELOG = fs.readFileSync(new URL("../../../../CHANGELOG.md", import.meta.url), "utf8");
const REPO_VERSION = (JSON.parse(fs.readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as { version: string }).version;

const SAMPLE = [
  "# 更新日志",
  "",
  "说明的段落，不属于哪一版。",
  "",
  "## [未发布]",
  "",
  "- 还没发的",
  "",
  "## [0.3.0] - 2026-11-01",
  "",
  "### 新增",
  "",
  "- 甲",
  "",
  "```md",
  "## 代码块里的标题不算",
  "```",
  "",
  "## 0.2.1",
  "",
  "- 乙",
  "",
  "## [0.2.0] - 2026-10-12",
  "",
  "- 丙",
  "",
].join("\n");

describe("更新日志按版本分节", () => {
  test("每个二级标题一节：版本号、日期（有的话）、正文；开头的说明不算；代码块里的 ## 不算", () => {
    expect(changelogSections(SAMPLE)).toEqual([
      { version: "未发布", body: "- 还没发的" },
      { version: "0.3.0", date: "2026-11-01", body: "### 新增\n\n- 甲\n\n```md\n## 代码块里的标题不算\n```" },
      { version: "0.2.1", body: "- 乙" },
      { version: "0.2.0", date: "2026-10-12", body: "- 丙" },
    ]);
  });

  test("当前版本那一节，和它之后（更早）的几版；比它新的（未发布）不算以前的", () => {
    const { current, earlier } = changelogFor(SAMPLE, "0.3.0");
    expect(current?.version).toBe("0.3.0");
    expect(earlier.map((s) => s.version)).toEqual(["0.2.1", "0.2.0"]);
  });

  test("日志里没有当前版本（忘了写）：没有这一版那一节，以前的版本照列（只列比文件里第一个正式版本旧的全部）", () => {
    expect(changelogFor(SAMPLE, "9.9.9")).toEqual({ current: undefined, earlier: changelogSections(SAMPLE).filter((s) => s.version !== "未发布") });
    expect(changelogFor("", "0.2.1")).toEqual({ current: undefined, earlier: [] });
  });

  test("仓库里真的 CHANGELOG.md：取得到根 package.json 的版本那一节，正文有内容，以前的版本里有 0.2.0", () => {
    const { current, earlier } = changelogFor(REPO_CHANGELOG, REPO_VERSION);
    expect(current?.version).toBe(REPO_VERSION);
    expect(current?.body).toContain("### ");
    expect(earlier.map((s) => s.version)).toContain("0.2.0");
  });
});

describe("更新日志里的名字占位填上用户起的名字（124 号票，主会话 2026-10-14 定；占位是构建时从“秘书”换来的，见 build.test.ts）", () => {
  const M = ASSISTANT_NAME_MARK;

  test("每个占位都换成现在的名字，别的不动", () => {
    expect(changelogWithName(`- **${M}**：负责听懂你。${M}再转告你，\`tell_secretary\` 不动。`, "小王")).toBe("- **小王**：负责听懂你。小王再转告你，`tell_secretary` 不动。");
    expect(changelogWithName("没有要换的", "小王")).toBe("没有要换的");
  });

  test("名字里带“秘书”、带 $ 这类替换记号：名字原样放进去", () => {
    expect(changelogWithName(`${M}和${M}`, "秘书小王")).toBe("秘书小王和秘书小王");
    expect(changelogWithName(`问${M}`, "$&$1$$")).toBe("问$&$1$$");
  });
});
