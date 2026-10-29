// 记忆的命令行（memory:rejudge、memory:build）单独跑时也要先装上自带的语言（同守护进程 main.ts 最先引 i18n/boot.ts）：
// 不装的话 t() 什么都查不到，个人档案摘要里的字段名成了 key（"protocol.personalFiles.field.selfPhone"），还报"没有这句"。
// 单元测试的 setupFiles 已经装好了语言，在这个进程里看不出来，所以另起一个 node 进程只引入命令行模块（不跑 main）再取字段名。
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const here = (rel: string) => pathToFileURL(fileURLToPath(new URL(rel, import.meta.url))).href;
const PROTOCOL = here("../../../protocol/src/index.ts");

function labelsAfterImport(cli: string): { stdout: string; stderr: string } {
  const code = [
    `await import(${JSON.stringify(here(cli))});`,
    `const { personalFieldLabel } = await import(${JSON.stringify(PROTOCOL)});`,
    `console.log(JSON.stringify([personalFieldLabel("self", "phone"), personalFieldLabel("self", "email")]));`,
  ].join("\n");
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 60_000 });
  return { stdout: r.stdout.trim().split("\n").at(-1) ?? "", stderr: r.stderr };
}

describe("记忆命令行装上自带的语言", () => {
  it.each(["./rejudge.ts", "./build.ts"])("%s：档案字段名是中文，不是 key，也不报缺句子", (cli) => {
    const { stdout, stderr } = labelsAfterImport(cli);
    expect(JSON.parse(stdout)).toEqual(["手机", "邮箱"]);
    expect(stderr).not.toContain("没有这句");
  });
});
