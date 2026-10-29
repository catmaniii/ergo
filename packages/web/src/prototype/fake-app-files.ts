// 原型：内置浏览器里渲染文件（160 号票）用的几份编的样例——转发的服务"周报小站"（/apps/demo/…）里的说明、填写指南、表格、配置、
// 运行记录、脚本。直接打开 #/apps/demo/README.md 看渲染层，里面的链接点了换着看（原型里没有真的服务，网页那一页打不开）。
import type { FileTextResult } from "../state/index.ts";

const README = `# 周报小站

这是项目「周报小站」的说明。它每周五把各组的进展汇总成一页，发到群里。

## 怎么用

1. 先看 [填写指南](guide.md)，每一栏写什么都在里面；
2. 各组的数据导成 [data.csv](data.csv)，汇总的口径在 [config.json](config.json)；
3. 每次汇总的记录在 [run.log](run.log)，汇总脚本是 [main.py](main.py)。

## 本周进展

| 小组 | 完成 | 进行中 | 风险 |
| --- | ---: | ---: | --- |
| 前端 | 12 | 3 | 无 |
| 后端 | 9 | 5 | 接口评审推迟一天 |
| 测试 | 21 | 2 | 真机少一台，借用中 |

> 数据截至 10 月 17 日 18:00，下周一上午更新。

![本周走势](trend.png)

手动跑一次：

\`\`\`bash
python main.py --week 42 --send
\`\`\`

更多说明见 [项目主页](https://example.com/weekly)。
`;

const GUIDE = `# 填写指南

- **完成**：本周关掉的票数，不含转给别组的；
- **进行中**：已经开工、还没合并的；
- **风险**：一句话说清楚卡在哪、要谁帮忙，没有写"无"。

写完回到 [说明](README.md)。
`;

const CSV = `小组,负责人,完成,进行中,风险
前端,王敏,12,3,无
后端,李强,9,5,"接口评审推迟一天，周一补"
测试,赵磊,21,2,"真机少一台，""借用中"""
运维,孙婷,6,1,无
`;

const CONFIG = '{"week":42,"sendTo":"周报群","groups":["前端","后端","测试","运维"],"rules":{"countReopened":false,"deadline":"周五 18:00"}}';

const LOG = `2026-10-17 18:00:02 开始汇总第 42 周
2026-10-17 18:00:03 读入 data.csv：4 个小组
2026-10-17 18:00:03 后端：风险一栏有内容，标黄
2026-10-17 18:00:04 生成周报：周报-第42周.md（2.1 KB）
2026-10-17 18:00:05 发到「周报群」：成功
`;

const SCRIPT = `import csv
import sys

def summarize(path):
    with open(path, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    done = sum(int(r["完成"]) for r in rows)
    return f"本周共完成 {done} 张票，{len(rows)} 个小组"

if __name__ == "__main__":
    print(summarize(sys.argv[1] if len(sys.argv) > 1 else "data.csv"))
`;

/** 服务里的路径（/apps/ 后面那一段）→ 内容和类型 */
const FILES: Readonly<Record<string, { text: string; mime: string }>> = {
  "demo/README.md": { text: README, mime: "text/markdown" },
  "demo/guide.md": { text: GUIDE, mime: "text/markdown" },
  "demo/data.csv": { text: CSV, mime: "text/csv" },
  "demo/config.json": { text: CONFIG, mime: "application/json" },
  "demo/run.log": { text: LOG, mime: "text/plain" },
  "demo/main.py": { text: SCRIPT, mime: "text/x-python" },
};

/** 原型里取一个转发服务里的文件：有样例的给内容，别的说原型里没有 */
export function fakeAppFileText(url: string): FileTextResult {
  const path = /\/apps\/([^?#]*)/.exec(url)?.[1] ?? "";
  const file = FILES[decodeURIComponent(path)];
  if (!file) return { status: "error", title: "原型里没有这个文件", detail: "真的二狗在这里取守护进程转发的服务里的文件。" };
  return { status: "text", mime: file.mime, text: file.text, bytes: new TextEncoder().encode(file.text).length, truncated: false };
}
