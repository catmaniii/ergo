// 录好的事件流（packages/web/test/state/recordings/*.json）要入库：里面不能有本机的用户主目录（用户名就在路径里）。
// 录制工具保存时把临时目录、用户主目录换成占位符（helpers/recording.ts）；这里扫一遍录好的文件。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { localPathPatterns, RECORDINGS_DIR, scrubLocalPaths } from "./helpers/recording.ts";

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

  test("被截短在路径中间的本机路径（结果摘要截在省略号处）也换成占位符，和先换路径再截短一样；完整的照常换", () => {
    const tmp = os.tmpdir();
    const forms = [tmp, tmp.replaceAll("\\", "/"), tmp.replaceAll("\\", "\\\\")];
    for (const form of forms) {
      for (const length of [form.length - 1, Math.ceil(form.length * 0.8), 4]) {
        const cut = `结果：{"cwd":"${form.slice(0, length)}…`;
        expect({ form, length, scrubbed: scrubLocalPaths(cut) }).toEqual({ form, length, scrubbed: '结果：{"cwd":"<临时目录>…' });
      }
      expect(scrubLocalPaths(`${form}${path.sep === "\\" && !form.includes("/") ? "\\" : "/"}x 和别的`)).toMatch(/^<临时目录>[\\/]+x 和别的$/);
    }
    expect(scrubLocalPaths("D:…、普通的省略号…")).toBe("D:…、普通的省略号…");
  });
});
