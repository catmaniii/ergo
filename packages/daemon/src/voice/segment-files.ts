// 分段合成的段的音频（38 号票）：前端边收边播用的临时文件，放在数据目录的临时区（tts-segments/<agent 语音 id>/<第几段>.wav），
// 不进媒体库（按内容哈希去重的媒体库里，同样的一段可能正好是别的语音的完整音频，删的时候会误删）。
// 一条语音有了结局（完整音频入库了，或者失败了），重播、下载用拼好的完整音频；它的段再留一阵（前端可能还在取最后一段）
// 才删（什么时候删由 voice-reply.ts 定），守护进程启动时全删（还在合成的从头重做）。临时区本身 7 天清一次，也兜着底。
import fs from "node:fs";
import path from "node:path";

/** agent 语音的 id 只认这样的（av- 加 UUID）：拼路径前先核对，免得 HTTP 请求里带 .. 跑出目录 */
const VOICE_ID = /^av-[0-9a-f-]{36}$/;

export interface SegmentFiles {
  /** 存下第 index 段 */
  write(voiceId: string, index: number, wav: Buffer): void;
  /** 第 index 段的文件；没有（不认得的 id、删掉了）是 undefined */
  file(voiceId: string, index: number): string | undefined;
  /** 删掉这一条语音的段 */
  remove(voiceId: string): void;
  /** 全删（守护进程启动时） */
  clear(): void;
}

const remove = (target: string) => fs.rmSync(target, { recursive: true, force: true });

export function openSegmentFiles(dir: string): SegmentFiles {
  const dirOf = (voiceId: string) => path.join(dir, voiceId);
  const fileOf = (voiceId: string, index: number) => path.join(dirOf(voiceId), `${index}.wav`);
  return {
    write(voiceId, index, wav) {
      if (!VOICE_ID.test(voiceId)) throw new Error(`不认得的 agent 语音 id：${voiceId}`); // @i18n-ignore log：编程错误
      fs.mkdirSync(dirOf(voiceId), { recursive: true });
      fs.writeFileSync(fileOf(voiceId, index), wav);
    },
    file(voiceId, index) {
      if (!VOICE_ID.test(voiceId) || !Number.isInteger(index) || index < 0) return undefined;
      const file = fileOf(voiceId, index);
      return fs.existsSync(file) ? file : undefined;
    },
    remove(voiceId) {
      if (VOICE_ID.test(voiceId)) remove(dirOf(voiceId));
    },
    clear() {
      remove(dir);
    },
  };
}
