// 把主切面里模拟前端收到的事件流录下来，给 Web 包的前端状态层回放测试用
// （packages/web/test/state/recordings/<名字>.json，回放测试在 recorded.test.ts）。
//
// - 重新录：设环境变量 ERGOU_RECORD_EVENTS=1 跑录制的测试，文件被覆盖（id、时间、增量的切分每次都不一样，所以录好的文件入库）；
// - 平时：不写文件，只核对录好的文件和这次收到的事件流"骨架"一致（落盘事件的频道、序号、类型、发言方，本地动作和连接状态的先后）。
//   守护进程的事件改了形状或顺序，这里先红，提示重新录。
import fs from "node:fs";
import { isEphemeralEventType } from "@ergou/protocol";
import path from "node:path";
import { expect } from "vitest";
import type { RecordedInput } from "./frontend.ts";

const RECORDINGS_DIR = path.resolve(import.meta.dirname, "../../../web/test/state/recordings");

export const RECORDING_ENV = "ERGOU_RECORD_EVENTS";

export function saveOrCheckRecording(name: string, inputs: readonly RecordedInput[]): void {
  const file = path.join(RECORDINGS_DIR, `${name}.json`);
  if (process.env[RECORDING_ENV] === "1") {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(inputs, null, 2)}\n`);
    return;
  }
  if (!fs.existsSync(file)) throw new Error(`还没有录好的事件流 ${file}：设 ${RECORDING_ENV}=1 再跑一次这个测试`);
  const recorded = JSON.parse(fs.readFileSync(file, "utf8")) as RecordedInput[];
  expect(skeleton(inputs), `事件流和录好的 ${name}.json 对不上：确认改动是有意的，就设 ${RECORDING_ENV}=1 重新录`).toEqual(skeleton(recorded));
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
      // 界面自己的输入（提示过一条通知、一个被拒的请求），模拟前端不产生
      case "alert_seen":
      case "failure_seen":
        return [input.kind];
    }
  });
}
