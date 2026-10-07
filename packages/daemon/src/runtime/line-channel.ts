// stdio 上按行分帧的 JSON：一条消息一行，LF 结尾。守护进程和子进程两边共用。
// 只按 LF 切分（行尾的 CR 去掉）；不用 node:readline，因为它会把 JSON 字符串里合法的
// U+2028 / U+2029 也当成换行（pi 的 RPC 文档特意提醒过这一点）。
import { StringDecoder } from "node:string_decoder";

export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** 把字节流切成完整的行；跨块的多字节 UTF-8 字符由 StringDecoder 接好。 */
export class LineDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  /** 喂一块数据，返回这块数据凑齐的完整行（不含行尾） */
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
      newline = this.buffer.indexOf("\n");
    }
    return lines;
  }

  /** 流结束：残留的不完整一行也交出去 */
  end(): string[] {
    const rest = this.buffer + this.decoder.end();
    this.buffer = "";
    return rest.trim().length > 0 ? [rest.replace(/\r$/, "")] : [];
  }
}

/** 逐行读一个流；流结束时先交出残留的最后一行，再调 onEnd */
export function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void, onEnd?: () => void): void {
  const decoder = new LineDecoder();
  stream.on("data", (chunk: Buffer | string) => decoder.push(chunk).forEach(onLine));
  stream.on("end", () => {
    decoder.end().forEach(onLine);
    onEnd?.();
  });
}

/** 逐行读 JSON 消息；解析不了的行交给 onInvalid */
export function readJsonLines<T>(
  stream: NodeJS.ReadableStream,
  onMessage: (message: T) => void,
  options: { onInvalid: (line: string) => void; onEnd?: () => void },
): void {
  readLines(
    stream,
    (line) => {
      let message: T;
      try {
        message = JSON.parse(line) as T;
      } catch {
        options.onInvalid(line);
        return;
      }
      onMessage(message);
    },
    options.onEnd,
  );
}
