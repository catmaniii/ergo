// 带类型的 bash 工具的"闸门"进程（runner.ts 拉起它）：先等守护进程把自己放进 Job 对象，再起真正要跑的程序。
// Node 起子进程时会先把它放进 libuv 私有、允许悄悄脱离的 Job；要是这时就起 Git Bash（bin/bash.exe 是个启动器，
// 一起来就再起 usr/bin/bash.exe），孙进程会在守护进程把它放进二狗的 Job 之前脱离出去。所以这里什么都不做，
// 直到 stdin 上来了"要跑什么"（守护进程放好 Job 之后才送），之后起的进程就都跑不出 Job 了。
//
// 要跑的程序的命令行上只有固定的东西（Git Bash 和脚本）；值（模型给的参数）从它的 stdin 送进去，每个值后面跟一个 NUL：
// Git Bash 是 MSYS 程序，命令行上的参数会被它的运行时当成通配符展开（`*.ts`）、当成响应文件读进来（`@secret.txt`）。
// 子进程的输出直接接到自己的 stdout / stderr（继承句柄，不经这里转手），退出码原样带回。
import { spawn } from "node:child_process";

interface RunSpec {
  file: string;
  /** 命令行：只放固定的参数 */
  args: string[];
  /** 经 stdin 送进去的值（每个后面跟一个 NUL） */
  input: string[];
}

let request = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  request += chunk;
});
process.stdin.on("end", () => {
  let spec: RunSpec;
  try {
    spec = JSON.parse(request) as RunSpec;
  } catch {
    process.stderr.write("闸门进程收到的不是要跑的命令\n");
    process.exit(126);
  }
  const child = spawn(spec.file, spec.args, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  child.on("error", (err) => {
    process.stderr.write(`起不来：${err.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
  // 脚本读完值之后，后面的命令再读 stdin 就是读到头了（和不给 stdin 一样，不会卡住等输入）
  child.stdin.on("error", () => {});
  child.stdin.end(spec.input.map((value) => `${value}\0`).join(""));
});
