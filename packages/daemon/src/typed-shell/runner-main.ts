// 带类型的 bash 工具的"闸门"进程（runner.ts 拉起它）：先等守护进程把自己放进 Job 对象，再起真正要跑的程序。
// Node 起子进程时会先把它放进 libuv 私有、允许悄悄脱离的 Job；要是这时就起 Git Bash（bin/bash.exe 是个启动器，
// 一起来就再起 usr/bin/bash.exe），孙进程会在守护进程把它放进二狗的 Job 之前脱离出去。所以这里什么都不做，
// 直到 stdin 上来了一行"要跑什么"（守护进程放好 Job 之后才送），之后起的进程就都跑不出 Job 了。
// 子进程的输出直接接到自己的 stdout / stderr（继承句柄，不经这里转手），退出码原样带回。
import { spawn } from "node:child_process";

interface RunSpec {
  file: string;
  args: string[];
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let spec: RunSpec;
  try {
    spec = JSON.parse(input) as RunSpec;
  } catch {
    process.stderr.write("闸门进程收到的不是要跑的命令\n");
    process.exit(126);
  }
  const child = spawn(spec.file, spec.args, { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  child.on("error", (err) => {
    process.stderr.write(`起不来：${err.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
});
