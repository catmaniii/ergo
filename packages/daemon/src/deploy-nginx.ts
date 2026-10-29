// 部署公网入口的 nginx 站点：用户在本机运行这条命令，运行即确认（规格第 6 节、第 21 节）。
//   npm run deploy:nginx              生成站点配置，ssh 上 VPS 放好，nginx -t 通过后 reload
//   npm run deploy:nginx -- --print   只打印生成的配置，不 ssh
// 读同一份配置（数据目录取 ERGO_DATA_DIR，不设就是用户主目录下的 .ergo）的 publicAccess：VPS 地址、ssh 私钥……
// 守护进程和任何 agent 都不会运行它，也不引用部署模块。
import os from "node:os";
import { runDeployCommand, spawnCommand } from "./deploy/deploy.ts";

process.exitCode = await runDeployCommand({
  argv: process.argv.slice(2),
  env: process.env,
  homeDir: os.homedir(),
  exec: spawnCommand,
  log: (line) => console.log(line),
});
