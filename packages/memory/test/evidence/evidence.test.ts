import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Evidence } from "../../src/domain/types.ts";
import { canSupportUserClaims } from "../../src/evidence/boundary.ts";
import { SyntheticEventsSource } from "../../src/evidence/synthetic.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/weekend-events.json", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function writeTemp(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lab-ev-"));
  dirs.push(dir);
  const file = path.join(dir, "events.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

const event = (over: Record<string, unknown> = {}) => ({
  id: "ev-001",
  source_level: "self",
  mode: "say",
  kind: "utterance",
  text: "周末想休息",
  context: ["weekend"],
  event_time: "2026-10-01T20:10:00+08:00",
  observed_at: "2026-10-01T20:10:00+08:00",
  ...over,
});

const bad = (events: unknown[], extra: Record<string, unknown> = {}) => () => new SyntheticEventsSource({ version: 1, now: "2026-10-20T12:00:00+08:00", events, ...extra } as never);

describe("合成数据适配器（fixtures/events.json 的格式）", () => {
  it("读成证据草稿：字段换成驼峰、出处记事件 id、带上数据集的 now", () => {
    const source = SyntheticEventsSource.fromFile(FIXTURE);
    expect(source.name).toBe("synthetic");
    expect(source.now).toBe("2026-10-20T12:00:00+08:00");
    const drafts = source.read();
    expect(drafts).toHaveLength(5);
    expect(drafts[0]).toEqual({
      id: "ev-w01",
      sourceLevel: "self",
      mode: "say",
      kind: "utterance",
      text: "这周六的聚会我就不去了，最近周末想好好休息。",
      context: ["weekend", "social"],
      eventTime: "2026-10-01T20:10:00+08:00",
      observedAt: "2026-10-01T20:10:00+08:00",
      sourceRef: "fixture:ev-w01",
    });
    expect(drafts[4]).toMatchObject({ sourceLevel: "untrusted", eventTime: null });
  });

  it("event_time 可以不写（不知道什么时候发生）", () => {
    const source = new SyntheticEventsSource({ version: 1, now: "2026-10-20T12:00:00+08:00", events: [event({ event_time: undefined })] });
    expect(source.read()[0]!.eventTime).toBeNull();
  });

  it("格式不对时写明是哪条事件、哪个字段", () => {
    expect(bad([event()], { version: 2 })).toThrow(/version/);
    expect(bad([event()], { now: "今天" })).toThrow(/now/);
    expect(bad([event({ source_level: "friend" })])).toThrow(/ev-001.*source_level/);
    expect(bad([event({ kind: "rumor" })])).toThrow(/ev-001.*kind/);
    expect(bad([event({ mode: "think" })])).toThrow(/ev-001.*mode/);
    expect(bad([event({ text: 3 })])).toThrow(/ev-001.*text/);
    expect(bad([event({ context: "weekend" })])).toThrow(/ev-001.*context/);
    expect(bad([event({ observed_at: "2026-10-01" })])).toThrow(/ev-001.*observed_at/);
    expect(bad([event({ id: "e1" })])).toThrow(/e1.*id/);
    expect(bad([event(), event()])).toThrow(/ev-001.*重复/);
  });

  it("读文件：不存在、不是 JSON 都说清楚", () => {
    expect(() => SyntheticEventsSource.fromFile(path.join(os.tmpdir(), "no-such-events.json"))).toThrow(/读不了/);
    expect(() => SyntheticEventsSource.fromFile(writeTemp("{not json"))).toThrow(/JSON/);
    expect(SyntheticEventsSource.fromFile(writeTemp({ version: 1, now: "2026-10-20T12:00:00+08:00", events: [event()] })).read()).toHaveLength(1);
  });
});

const ev = (over: Partial<Evidence>): Evidence => ({
  id: "ev-1",
  sourceLevel: "self",
  mode: "say",
  kind: "utterance",
  text: "x",
  context: [],
  eventTime: null,
  observedAt: "2026-10-01T20:10:00+08:00",
  sourceRef: null,
  contentHash: "h",
  status: "active",
  ...over,
});

describe("只有本人的证据能当关于用户的依据", () => {
  it("本人、有效的才行", () => {
    expect(canSupportUserClaims(ev({}))).toBe(true);
    expect(canSupportUserClaims(ev({ mode: "do", kind: "action" }))).toBe(true);
  });

  it("别人转述的、agent 的、系统的只能当背景", () => {
    expect(canSupportUserClaims(ev({ sourceLevel: "untrusted" }))).toBe(false);
    expect(canSupportUserClaims(ev({ sourceLevel: "agent" }))).toBe(false);
    expect(canSupportUserClaims(ev({ sourceLevel: "system" }))).toBe(false);
  });

  it("被忘掉、被纠正的本人证据也不行", () => {
    expect(canSupportUserClaims(ev({ status: "forgotten", text: "" }))).toBe(false);
    expect(canSupportUserClaims(ev({ status: "corrected" }))).toBe(false);
  });
});
