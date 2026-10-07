// 录好的事件流（packages/web/test/state/recordings/*.json）要入库：里面不能有本机的用户主目录（用户名就在路径里）。
// 录制工具保存时把临时目录、用户主目录换成占位符（helpers/recording.ts）；这里扫一遍录好的文件。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { localPathPatterns, RECORDINGS_DIR } from "./helpers/recording.ts";

describe("录好的事件流不带本机路径", () => {
  test("没有本机的用户主目录、临时目录（各种写法），也没有本机用户名所在的 Users 路径", () => {
    const user = path.basename(os.homedir());
    const userDir = new RegExp(`Users[\\\\/]+${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    const files = fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => {
      const text = fs.readFileSync(path.join(RECORDINGS_DIR, f), "utf8");
      // JSON 里的反斜杠是转义过的：还原成一个再比
      const plain = text.replaceAll("\\\\", "\\");
      return userDir.test(plain) || localPathPatterns().some(({ pattern }) => new RegExp(pattern.source, "i").test(plain));
    });
    expect(offenders).toEqual([]);
  });
});
