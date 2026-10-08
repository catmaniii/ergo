// 假的语音识别进程（测试里替换 recognizer.py，不加载模型、不占显卡）：node fake-recognizer.mjs <记录文件>
// 和 src/voice/recognizer.py 说同样的 JSON 行（第一行 init，之后 transcribe / exit）。
// 识别结果由"录音"文件里的指令决定（helpers/voice.ts 的 fakeRecording 生成）：文件开头是 WebM 的 EBML 头，
// 后面一行"FAKE-ASR <JSON>"：
//   text        识别原文（按标点切成分段）
//   language    识别出的语言，默认 zh
//   seconds     音频时长（秒），默认 3
//   fallback    给了就当作显卡不可用、退回了 init 里的 fallback，这是原因
//   error       这次识别出错（不是致命的）
//   errorUnless 这个文件不在时识别出错（测"重新识别"：先失败，测试放上文件后再识别就成功）
//   fatal       模型加载失败（致命）：回完就退出
//   crash       不回就退出（退出码 3），stderr 里留一句
//   holdFile    等这个文件出现了再回（测试控制"识别中"停多久）
//   noise       回之前先往 stdout 打这一行（不是协议的行，守护进程该忽略它）
// 每件事往记录文件追加一行 JSON：start（pid、环境变量名、当前目录）、init、transcribe（音频路径、语言、提示）、exit。
import fs from "node:fs";
import readline from "node:readline";

const logFile = process.argv[2];
const record = (entry) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

record({ event: "start", pid: process.pid, cwd: process.cwd(), env: Object.keys(process.env) });

let init;
const queue = [];
let busy = false;

function directiveOf(path) {
  const text = fs.readFileSync(path).toString("latin1");
  const at = text.indexOf("FAKE-ASR ");
  if (at < 0) return { text: "" };
  const line = text.slice(at + "FAKE-ASR ".length).split("\n")[0];
  return JSON.parse(Buffer.from(line, "latin1").toString("utf8"));
}

async function transcribe(request) {
  record({ event: "transcribe", path: request.path, language: request.language, initialPrompt: request.initialPrompt });
  const d = directiveOf(request.path);
  if (d.holdFile) while (!fs.existsSync(d.holdFile)) await sleep(20);
  if (d.noise) process.stdout.write(`${d.noise}\n`);
  if (d.crash) {
    process.stderr.write(`${d.crash}\n`);
    process.exit(3);
  }
  if (d.fatal) {
    // 先等这一行写出去再退出
    process.stdout.write(`${JSON.stringify({ id: request.id, error: `模型加载失败：${d.fatal}`, fatal: true })}\n`, () => process.exit(0));
    return;
  }
  if (d.error) return reply({ id: request.id, error: `识别出错：${d.error}` });
  if (d.errorUnless && !fs.existsSync(d.errorUnless)) return reply({ id: request.id, error: "识别出错：听不清" });
  const spec = d.fallback ? init.fallback : init.primary;
  const seconds = d.seconds ?? 3;
  const pieces = (d.text ?? "").split(/(?<=[，。？！,.?!])/).filter((p) => p.trim());
  const step = pieces.length > 0 ? seconds / pieces.length : 0;
  reply({
    id: request.id,
    result: {
      text: d.text ?? "",
      language: d.language ?? "zh",
      segments: pieces.map((p, i) => ({ start: Math.round(i * step * 100) / 100, end: Math.round((i + 1) * step * 100) / 100, text: p })),
      duration: seconds,
      model: spec.model,
      device: spec.device,
      computeType: spec.computeType,
      ...(d.fallback ? { fallbackReason: d.fallback } : {}),
    },
  });
}

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length > 0) await transcribe(queue.shift());
  busy = false;
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "init") {
    init = message;
    record({ event: "init", primary: message.primary, fallback: message.fallback });
  } else if (message.type === "transcribe") {
    queue.push(message);
    void drain();
  } else if (message.type === "exit") {
    record({ event: "exit" });
    process.exit(0);
  }
});
