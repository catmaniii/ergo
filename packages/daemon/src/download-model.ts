// 下载语义检索用的向量模型（量化版 bge-m3，约 570 MB）到数据目录的模型区（规格第 15、21 节）。
// 323 号票起和设置 · 组件里点"安装"是同一个下载器（components/）：几个下载地址（Hugging Face、hf-mirror、ModelScope）先探速、挑快的，
// 断了从下到的地方接着下，先下到组件区的临时目录、大小和 sha256 都对上了才换上；走系统代理。在仓库目录：
//   npm run download-model                          # 数据目录取 ERGO_DATA_DIR，没设就是用户主目录下的 .ergo
//   npm run download-model -- --data-dir "D:\…"     # 指定数据目录（守护进程的提示里会写好）
// 设了环境变量 HF_ENDPOINT（比如 https://hf-mirror.com）的，Hugging Face 的地址换成它、排在最前（以前的用法照旧）。
// 下载完不用重启守护进程：它每隔几分钟看一次，模型就位后自己补算缺的向量。守护进程正在下同一个组件时这里会说"另一个程序在下"。
// @i18n-ignore-file log：命令行工具的输出
import "./i18n/boot.ts";
import os from "node:os";
import { parseArgs } from "node:util";
import { componentTransport, createComponents, loadManifest } from "./components/index.ts";
import { DATA_DIR_ENV, loadConfig } from "./config/config.ts";
import { dataDirLayout } from "./config/data-dir.ts";
import { sizeLabel } from "./media/file-types.ts";

const { values } = parseArgs({ options: { "data-dir": { type: "string" } } });
const env = values["data-dir"] ? { ...process.env, [DATA_DIR_ENV]: values["data-dir"] } : process.env;
const { dataDir } = loadConfig({ env, homeDir: os.homedir() });
const layout = dataDirLayout(dataDir);

const components = createComponents({
  root: layout.root,
  componentsDir: layout.components,
  manifest: loadManifest(),
  // 向量模型只有一版、没有"别处有"的说法：检测用不着
  probes: { gpu: () => "none", detect: () => undefined, provided: () => undefined },
  transport: componentTransport(process.env, "ergo-download-model"),
  hfEndpoint: process.env.HF_ENDPOINT,
  log: (line) => console.log(line),
});

const ID = "bge-m3";
let reported = -1;
components.onChange(() => {
  const view = components.view().components.find((c) => c.id === ID);
  const p = view?.progress;
  if (!p || p.total === 0) return;
  // 每 10% 报一次进度
  const percent = Math.floor((p.done / p.total) * 10) * 10;
  if (percent > reported && percent < 100) {
    reported = percent;
    const speed = p.speed === undefined ? "" : `，${sizeLabel(p.speed)}/s`;
    console.log(`${percent}%（${sizeLabel(p.done)} / ${sizeLabel(p.total)}${speed}${p.source ? `，从 ${p.source}` : ""}）`);
  }
});

const before = components.view().components.find((c) => c.id === ID);
if (before?.state === "installed") {
  console.log(`模型文件已经在 ${before.location}，不用再下。`);
  process.exit(0);
}
console.log(`下载 ${before?.title ?? ID}（${sizeLabel(before?.size ?? 0)}）到 ${before?.location ?? layout.models}`);
await components.act(ID, "install");
await components.whenIdle(ID);
const after = components.view().components.find((c) => c.id === ID);
if (after?.state === "installed") {
  console.log("模型文件已就位。守护进程在运行的话，几分钟内会自己补算向量，不用重启。");
} else {
  console.error(`下载没成：${after?.error ?? after?.state ?? "不知道为什么"}`);
  console.error("可以重跑这条命令：已经下好的部分会接着用。");
  process.exit(1);
}
