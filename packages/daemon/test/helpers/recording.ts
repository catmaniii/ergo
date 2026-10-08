// 把主切面里模拟前端收到的事件流录下来，给 Web 包的前端状态层回放测试用
// （packages/web/test/state/recordings/<名字>.json，回放测试在 recorded.test.ts）。
//
// - 重新录：设环境变量 ERGOU_RECORD_EVENTS=1 跑录制的测试，文件被覆盖（id、时间、增量的切分每次都不一样，所以录好的文件入库）；
// - 平时：不写文件，只核对录好的文件和这次收到的事件流"骨架"一致（落盘事件的频道、序号、类型、发言方，本地动作和连接状态的先后）。
//   守护进程的事件改了形状或顺序，这里先红，提示重新录。
// - 录制文件入库，不能带本机的路径：保存时把临时目录、用户主目录换成占位符（<临时目录>、<用户主目录>），
//   正斜杠、反斜杠、8.3 短名、真实路径几种写法都换（test/recordings-privacy.test.ts 检查录好的文件里没有本机用户主目录）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isEphemeralEventType } from "@ergou/protocol";
import { expect } from "vitest";
import type { RecordedInput } from "./frontend.ts";

export const RECORDINGS_DIR = path.resolve(import.meta.dirname, "../../../web/test/state/recordings");

export const RECORDING_ENV = "ERGOU_RECORD_EVENTS";

/**
 * 录下来或核对。perChannel：秘书、维护者、用户的动作各走各的，几个频道之间谁先到每次不一样（比如维护者交计划和秘书的回复），
 * 只核对每个频道里的先后和本地动作的先后（12 号票起的任务流程）
 */
export function saveOrCheckRecording(name: string, inputs: readonly RecordedInput[], options: { perChannel?: boolean } = {}): void {
  const file = path.join(RECORDINGS_DIR, `${name}.json`);
  if (process.env[RECORDING_ENV] === "1") {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(withoutLocalPaths(inputs), null, 2)}\n`);
    return;
  }
  if (!fs.existsSync(file)) throw new Error(`还没有录好的事件流 ${file}：设 ${RECORDING_ENV}=1 再跑一次这个测试`);
  const recorded = JSON.parse(fs.readFileSync(file, "utf8")) as RecordedInput[];
  const shape = options.perChannel ? byChannel : skeleton;
  expect(shape(inputs), `事件流和录好的 ${name}.json 对不上：确认改动是有意的，就设 ${RECORDING_ENV}=1 重新录`).toEqual(shape(recorded));
}

const bucket = (input: RecordedInput) => (input.kind === "frame" ? input.frame.channel : "~本地");

/** 骨架按频道分开（每个频道里的先后不变），本地动作和连接状态放在一起 */
function byChannel(inputs: readonly RecordedInput[]): string[] {
  return inputs
    .flatMap((input) => skeleton([input]).map((line) => ({ key: bucket(input), line })))
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => `${x.key} | ${x.line}`);
}

/** 一个目录的几种写法：原样、真实路径（展开 8.3 短名），各自的正斜杠写法和 JSON 转义过的写法（反斜杠成双，28 号票的结构化结果）；长的在前 */
function pathForms(dir: string): string[] {
  const forms = [dir];
  try {
    forms.push(fs.realpathSync.native(dir));
  } catch {
    // 不存在就只用原样
  }
  const all = new Set(forms.flatMap((f) => [f, f.replaceAll("\\", "/"), f.replaceAll("\\", "\\\\")]));
  return [...all].filter((f) => f.length > 3).toSorted((a, b) => b.length - a.length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 本机路径的几种写法（临时目录在用户主目录里面，排在前面） → 占位符 */
export function localPathPatterns(): Array<{ pattern: RegExp; placeholder: string }> {
  // 临时目录常是用户主目录的 8.3 短名写法（C:/Users/ABCDEF~1/AppData/Local/Temp）：从它推出主目录的短名写法
  const shortHome = /^(.*)[\\/]AppData[\\/]Local[\\/]Temp$/i.exec(os.tmpdir())?.[1];
  const homes = [...pathForms(os.homedir()), ...(shortHome === undefined ? [] : pathForms(shortHome))].toSorted((a, b) => b.length - a.length);
  return [
    ...pathForms(os.tmpdir()).map((p) => ({ pattern: new RegExp(escapeRegExp(p), "gi"), placeholder: "<临时目录>" })),
    ...homes.map((p) => ({ pattern: new RegExp(escapeRegExp(p), "gi"), placeholder: "<用户主目录>" })),
  ];
}

/** 守护进程截短一行文字时用的省略号（util/text.ts 的 oneLine） */
const CUT_MARK = "…";

/**
 * 被截短的本机路径：守护进程截短结果摘要时可能正好截在路径中间（`C:\Users\x\AppData\Lo…`），完整路径的写法匹配不上。
 * 路径的任何一段开头（至少盘符加分隔符）紧跟着省略号的，也换成占位符——和先换路径再截短的结果一样，
 * 不依赖临时目录在用户主目录下面（那样的话主目录那一段才碰巧换掉）
 */
function cutPathPattern({ pattern, placeholder }: { pattern: RegExp; placeholder: string }): { pattern: RegExp; placeholder: string } {
  const form = pattern.source.replace(/\\(.)/g, "$1");
  const prefixes: string[] = [];
  for (let length = form.length - 1; length >= 3; length--) prefixes.push(escapeRegExp(form.slice(0, length)));
  return { pattern: new RegExp(`(?:${prefixes.join("|")})${CUT_MARK}`, "gi"), placeholder: `${placeholder}${CUT_MARK}` };
}

/** 一段文字里的本机路径换成占位符：按占位符分组（临时目录在前），每组先换完整的、再换被截短的 */
export function scrubLocalPaths(text: string): string {
  const patterns = localPathPatterns();
  const groups = [...new Set(patterns.map((p) => p.placeholder))].flatMap((placeholder) => {
    const full = patterns.filter((p) => p.placeholder === placeholder);
    return [...full, ...full.map(cutPathPattern)];
  });
  return groups.reduce((s, { pattern, placeholder }) => s.replace(pattern, placeholder), text);
}

/** 录制里所有的字符串，本机路径换成占位符 */
function withoutLocalPaths<T>(value: T): T {
  if (typeof value === "string") return scrubLocalPaths(value) as T;
  if (Array.isArray(value)) return value.map(withoutLocalPaths) as T;
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, withoutLocalPaths(x)])) as T;
  return value;
}

/** 事件流的骨架：去掉每次都不一样的 id、时间、增量的切分 */
function skeleton(inputs: readonly RecordedInput[]): string[] {
  return inputs.flatMap((input): string[] => {
    switch (input.kind) {
      case "frame": {
        const { frame } = input;
        if (isEphemeralEventType(frame.type)) return [];
        const speaker = (frame.payload as { message?: { speaker?: string } }).message?.speaker;
        return [`frame ${frame.channel}#${frame.seq} ${frame.type}${speaker ? ` ${speaker}` : ""}`];
      }
      case "send_message":
        return [`send_message ${input.conversation}`];
      case "request_failed":
        return [`request_failed ${input.error}`];
      case "connection":
        return [`connection ${input.status}`];
      case "resync":
        return [`resync ${input.channel}`];
      case "card_action":
        return [`card_action ${input.action}`];
      // 界面自己的输入（提示过一条通知、一个被拒的请求、引用一张卡），模拟前端不产生
      case "alert_seen":
      case "failure_seen":
      case "quote_card":
      case "unquote_card":
        return [input.kind];
      case "history_page": {
        const seqs = input.page.messages.map((m) => m.seq);
        // 落在这一页里的时间线记录（25 号票起）：序号和类型
        const records = (input.page.records ?? []).map((r) => ` ${r.type}#${r.seq}`).join("");
        return [`history_page ${input.conversation} ${seqs[0] ?? "-"}..${seqs.at(-1) ?? "-"} (${seqs.length})${input.page.hasMore ? " more" : ""}${records}`];
      }
    }
  });
}
