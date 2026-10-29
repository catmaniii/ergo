// 给用户看的编号写成"编号「简短描述」"（159 号票加名字，163 号票统一成仓库里原来的 t-3「标题」写法）：写法、描述截短、维护者的描述、删掉了的说明。
import { describe, expect, test } from "vitest";
import { deletedIdLabel, ID_DESCRIPTION_MAX, idLabel, maintainerDescription, maintainerIdLabel, namedIdLabel, shortDescription } from "../src/index.ts";

const LONG = "把记账本的导出功能重写一遍并且补上导入说明和示例数据";

describe("编号「简短描述」", () => {
  test("编号后面紧跟「」括起来的描述，中间不空格", () => {
    expect(idLabel("t-3", "给记账本加周报")).toBe("t-3「给记账本加周报」");
    expect(idLabel("wo-2", "加一个导出\n说明")).toBe("wo-2「加一个导出 说明」");
  });

  test("空的描述只写编号", () => {
    expect(idLabel("t-3", "  ")).toBe("t-3");
  });

  test("删掉了、取不到的：编号后面写（已删除）", () => {
    expect(deletedIdLabel("t-3")).toBe("t-3（已删除）");
  });

  test("名字压成一行、太长的截短加省略号", () => {
    expect(shortDescription("  每天早上\n出简报  ")).toBe("每天早上 出简报");
    expect(LONG.length).toBeGreaterThan(ID_DESCRIPTION_MAX);
    expect(shortDescription(LONG)).toBe(`${LONG.slice(0, ID_DESCRIPTION_MAX)}…`);
    expect(namedIdLabel("t-9", LONG)).toBe(`t-9「${LONG.slice(0, ID_DESCRIPTION_MAX)}…」`);
    expect(namedIdLabel("p-1", "记账本")).toBe("p-1「记账本」");
  });

  test("维护者的描述：属于哪个任务、项目（名字截短，后缀照写）", () => {
    expect(maintainerDescription({ kind: "task", name: "记账本" })).toBe("记账本的任务维护者");
    expect(maintainerDescription({ kind: "project", name: "记账本" })).toBe("记账本的项目维护者");
    expect(maintainerDescription({ kind: "job", name: "每天备份" })).toBe("每天备份的维护者");
    expect(maintainerIdLabel("tm-2", { kind: "task", name: "记账本" })).toBe("tm-2「记账本的任务维护者」");
    expect(maintainerIdLabel("pm-1", { kind: "project", name: LONG })).toBe(`pm-1「${LONG.slice(0, ID_DESCRIPTION_MAX)}…的项目维护者」`);
  });
});
