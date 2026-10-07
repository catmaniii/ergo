// 下载语义检索用的向量模型（量化版 bge-m3，约 570 MB）到数据目录的模型区（规格第 15、21 节）。
// 模型文件不随仓库分发、守护进程也不自动下载：守护进程发现模型不在时，提示用户运行这条命令。在仓库目录：
//   npm run download-model                          # 数据目录取 ERGOU_DATA_DIR，没设就是用户主目录下的 .ergou
//   npm run download-model -- --data-dir "D:\…"     # 指定数据目录（守护进程的提示里会写好）
// 连不上 Hugging Face 时，设环境变量 HF_ENDPOINT 指向镜像（比如 https://hf-mirror.com）。
// 下载完不用重启守护进程：它每隔几分钟看一次，模型就位后自己补算缺的向量。
import os from "node:os";
import { parseArgs } from "node:util";
import { DATA_DIR_ENV, loadConfig } from "./config/config.ts";
import { downloadBgeM3 } from "./materials/index.ts";

const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
const env = values["data-dir"] ? { ...process.env, [DATA_DIR_ENV]: values["data-dir"] } : process.env;
const { dataDir } = loadConfig({ env, homeDir: os.homedir() });

try {
  await downloadBgeM3({ dataDir, endpoint: process.env.HF_ENDPOINT ?? "https://huggingface.co", log: (line) => console.log(line) });
  console.log("模型文件已就位。守护进程在运行的话，几分钟内会自己补算向量，不用重启。");
} catch (err) {
  console.error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
  console.error("可以重跑这条命令：已经下好的文件会跳过。");
  process.exit(1);
}
