// 交付统计的忽略规则（311 号票，294 号票端到端小测第 5 条）：秘书转告"交了几个文件"、任务卡"新建 N 个文件"、项目"最新交付件"
// 不算缓存和编译产物（__pycache__、*.pyc、node_modules、.pytest_cache 这类）。
import { describe, expect, it } from "vitest";
import { ignoredDeliveryDir, ignoredDeliveryFile, ignoredDeliveryPath } from "../../src/tasks/delivery-ignore.ts";

describe("交付统计不算的目录和文件（311 号票）", () => {
  it.each(["node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv", ".tox", ".git", "todo.egg-info", "Node_Modules"])("目录 %s 整个不算", (name) => {
    expect(ignoredDeliveryDir(name)).toBe(true);
  });

  it.each(["src", "dist", "build", "docs", "output", "pycache"])("目录 %s 照算", (name) => {
    expect(ignoredDeliveryDir(name)).toBe(false);
  });

  it.each(["todo.cpython-312.pyc", "x.pyo", "Main.class", "a.o", "tsconfig.tsbuildinfo", "Thumbs.db", "desktop.ini", ".DS_Store", "TODO.PYC"])("文件 %s 不算", (name) => {
    expect(ignoredDeliveryFile(name)).toBe(true);
  });

  it.each(["todo.py", "README.md", "report.pdf", "model.obj", "data.db", "app.exe"])("文件 %s 照算", (name) => {
    expect(ignoredDeliveryFile(name)).toBe(false);
  });

  it("路径：哪一层目录不算或者文件名不算就不算；正反斜杠、相对绝对都认", () => {
    expect(ignoredDeliveryPath("__pycache__/todo.cpython-312.pyc")).toBe(true);
    expect(ignoredDeliveryPath(String.raw`D:\work\todo\.pytest_cache\v\cache\lastfailed`)).toBe(true);
    expect(ignoredDeliveryPath("web/node_modules/left-pad/index.js")).toBe(true);
    expect(ignoredDeliveryPath("build/app.pyc")).toBe(true);
    expect(ignoredDeliveryPath("D:/work/todo/todo.py")).toBe(false);
    expect(ignoredDeliveryPath(String.raw`tests\test_todo.py`)).toBe(false);
  });
});
