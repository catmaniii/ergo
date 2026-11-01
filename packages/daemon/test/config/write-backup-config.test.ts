// 设置 · 备份改配置：写配置文件只动 backup 这几个键，别的内容和格式按字节不变；文件被改坏了回明确的错、不覆盖。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeBackupConfig } from "../../src/config/config.ts";
import { editJsonSection } from "../../src/config/json-text-edit.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 故意写得不规整：顶层有手排的缩进、注释不了但能有中文和转义、数组挤在一行、CRLF 换行 */
const HAND_WRITTEN = [
  "{",
  '    "ports":   { "local": 18810,   "external": 18811 },',
  '    "note": "带 { 花括号 } 和 \\" 引号的字：备份 backup",',
  '    "backup": {',
  '        "time": "04:10",',
  '        "syncDir": "D:\\\\旧的\\\\ergo-backup",',
  '        "schedule": "internal",',
  '        "future": [1,  2,   3]',
  "    },",
  '    "plugins": {"disabled":["reminders"]}',
  "}",
  "",
].join("\r\n");

function setup(content?: string | Buffer) {
  const root = makeTempDir("ergo-config-");
  const dataDir = path.join(root, "data");
  const configFile = path.join(dataDir, "config", "ergo.json");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  if (content !== undefined) fs.writeFileSync(configFile, content);
  return { root, dataDir, configFile };
}

/** 整个文件里 backup 那一节以外的字节 */
function outsideBackup(text: string): [string, string] {
  const start = text.indexOf('"backup"');
  const end = text.indexOf('"plugins"');
  return [text.slice(0, start), text.slice(end)];
}

describe("改 JSON 文本里的一节（editJsonSection）", () => {
  it("改值只换值的那几个字节；改完和 JSON.parse 的结果一致", () => {
    const out = editJsonSection(HAND_WRITTEN, "backup", { time: "05:00" });
    expect(out).toBe(HAND_WRITTEN.replace('"time": "04:10"', '"time": "05:00"'));
  });

  it("去掉一个键：前后的逗号收拾好，第一个、中间、最后一个都行", () => {
    const first = editJsonSection(HAND_WRITTEN, "backup", { time: undefined });
    expect(JSON.parse(first).backup).toEqual({ syncDir: "D:\\旧的\\ergo-backup", schedule: "internal", future: [1, 2, 3] });
    const middle = editJsonSection(HAND_WRITTEN, "backup", { syncDir: undefined });
    expect(JSON.parse(middle).backup).toEqual({ time: "04:10", schedule: "internal", future: [1, 2, 3] });
    const last = editJsonSection(HAND_WRITTEN, "backup", { future: undefined });
    expect(JSON.parse(last).backup).toEqual({ time: "04:10", syncDir: "D:\\旧的\\ergo-backup", schedule: "internal" });
    // 别的键的写法一个字节不变
    expect(middle).toContain('"future": [1,  2,   3]');
  });

  it("加一个键：跟着这一节的缩进和换行", () => {
    const text = '{\r\n    "backup": {\r\n        "time": "04:10"\r\n    }\r\n}\r\n';
    expect(editJsonSection(text, "backup", { schedule: "external" })).toBe('{\r\n    "backup": {\r\n        "time": "04:10",\r\n        "schedule": "external"\r\n    }\r\n}\r\n');
  });

  it("写在一行里的节，加的键也在一行里；空的节、没有这一节也能加", () => {
    expect(editJsonSection('{ "backup": { "time": "04:10" } }', "backup", { schedule: "external" })).toBe('{ "backup": { "time": "04:10", "schedule": "external" } }');
    const empty = editJsonSection('{\n  "backup": {}\n}\n', "backup", { time: "04:10" });
    expect(empty).toBe('{\n  "backup": {\n    "time": "04:10"\n  }\n}\n');
    const absent = editJsonSection('{\n\t"ports": {"local": 1}\n}\n', "backup", { time: "04:10" });
    expect(absent).toBe('{\n\t"ports": {"local": 1},\n\t"backup": {\n\t\t"time": "04:10"\n\t}\n}\n');
    expect(editJsonSection("{}\n", "backup", { time: "04:10" })).toBe('{\n  "backup": {\n    "time": "04:10"\n  }\n}\n');
  });

  it("这一节只剩一个键时去掉它：留一个空的节；没有这一节、没有这个键的去掉什么都不动", () => {
    expect(editJsonSection('{\n  "backup": {\n    "syncDir": "D:\\\\x"\n  },\n  "a": 1\n}\n', "backup", { syncDir: undefined })).toBe('{\n  "backup": {},\n  "a": 1\n}\n');
    expect(editJsonSection('{"a":1}', "backup", { syncDir: undefined })).toBe('{"a":1}');
    expect(editJsonSection('{"backup":{"time":"04:10"}}', "backup", { syncDir: undefined })).toBe('{"backup":{"time":"04:10"}}');
  });

  it("同一个键写了两遍（JSON.parse 认最后一个）：改的就是最后那个，去掉时两个都去掉", () => {
    const dup = '{"backup":{"time":"01:00","time":"02:00"}}';
    expect(JSON.parse(editJsonSection(dup, "backup", { time: "03:00" })).backup.time).toBe("03:00");
    expect(JSON.parse(editJsonSection(dup, "backup", { time: undefined })).backup).toEqual({});
  });
});

describe("写进配置文件（writeBackupConfig）", () => {
  it("换另存的文件夹：这一项之外按字节不变（CRLF、缩进、别的节的写法）；回的是读回来的配置", () => {
    const { root, dataDir, configFile } = setup(HAND_WRITTEN);
    const target = path.join(root, "新的文件夹");
    const next = writeBackupConfig(configFile, dataDir, { syncDir: target });
    expect(next).toEqual({ time: "04:10", schedule: "internal", syncDir: target });
    const written = fs.readFileSync(configFile, "utf8");
    expect(written).toBe(HAND_WRITTEN.replace('"syncDir": "D:\\\\旧的\\\\ergo-backup"', `"syncDir": ${JSON.stringify(target)}`));
  });

  it("清掉：backup.syncDir 这一项去掉，backup 节以外按字节不变，节里别的键照旧", () => {
    const { dataDir, configFile } = setup(HAND_WRITTEN);
    const next = writeBackupConfig(configFile, dataDir, { syncDir: null });
    expect(next).toEqual({ time: "04:10", schedule: "internal" });
    const written = fs.readFileSync(configFile, "utf8");
    expect(outsideBackup(written)).toEqual(outsideBackup(HAND_WRITTEN));
    expect(JSON.parse(written).backup).toEqual({ time: "04:10", schedule: "internal", future: [1, 2, 3] });
  });

  it("改时刻、谁来定时；不变的不写（文件的修改时间不动）", () => {
    const { dataDir, configFile } = setup(HAND_WRITTEN);
    expect(writeBackupConfig(configFile, dataDir, { time: "02:15", schedule: "external" })).toMatchObject({ time: "02:15", schedule: "external" });
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(parsed.backup).toMatchObject({ time: "02:15", schedule: "external" });
    const past = new Date(2020, 0, 1);
    fs.utimesSync(configFile, past, past);
    writeBackupConfig(configFile, dataDir, { time: "02:15" });
    expect(fs.statSync(configFile).mtimeMs).toBe(past.getTime());
  });

  it("配置文件不在：新建一个只有 backup 的；清掉时不新建", () => {
    const { root, dataDir, configFile } = setup();
    writeBackupConfig(configFile, dataDir, { syncDir: null });
    expect(fs.existsSync(configFile)).toBe(false);
    const target = path.join(root, "x");
    writeBackupConfig(configFile, dataDir, { syncDir: target });
    expect(JSON.parse(fs.readFileSync(configFile, "utf8"))).toEqual({ backup: { syncDir: target } });
  });

  it("文件被改坏了（不是 JSON、顶层不对、backup 不是对象、里面的值不对、不是 UTF-8）：回明确的错，文件一个字节不动", () => {
    const bad: Array<[string | Buffer, RegExp]> = [
      ['{ "backup": { "time": "04:10", }', /不是合法的 JSON/],
      ["[1, 2]", /顶层/],
      ['{ "backup": "D:\\\\x" }', /backup 不是一个对象/],
      ['{ "backup": { "time": "晚上" } }', /backup\.time/],
      [Buffer.from([0x7b, 0x22, 0xc4, 0xe3, 0x22, 0x3a, 0x31, 0x7d]), /UTF-8/],
    ];
    for (const [content, message] of bad) {
      const { root, dataDir, configFile } = setup(content);
      const before = fs.readFileSync(configFile);
      expect(() => writeBackupConfig(configFile, dataDir, { syncDir: path.join(root, "x") })).toThrow(message);
      expect(fs.readFileSync(configFile).equals(before)).toBe(true);
    }
  });

  it("写的时候不留临时文件", () => {
    const { root, dataDir, configFile } = setup(HAND_WRITTEN);
    writeBackupConfig(configFile, dataDir, { syncDir: path.join(root, "x") });
    expect(fs.readdirSync(path.dirname(configFile))).toEqual(["ergo.json"]);
  });
});
