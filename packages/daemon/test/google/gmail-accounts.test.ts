// Gmail 的几个账号（344 号票）：密钥区里怎么存，老配置怎么转过来（真的密钥区文件，临时目录）：
// - 转过来：老的两个键变成一条账号，备份在同一格里，老键没了；再转一次什么都不动；
// - 中途失败：在每一步上模拟写失败——老键还在，到了备份那一步之后备份也在；没转成时照样读得出这一条；再跑一次结果和一次成功的一样；
// - 新装的、老配置不全的不转；上次断在删老键中间的删干净；
// - 回退到老版本（备份写回老键）再升级：老键里新填的密码算数；
// - 断开一个账号：只删它自己的，备份跟着它走；最后一个断开时文件都没了；
// - 备份不在备份区：密钥区（整个不进备份）之外没有一个文件里有密码。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DataSourceSecrets } from "../../src/data-sources/api.ts";
import { createDataSourceSecrets } from "../../src/data-sources/secrets.ts";
import { accountIdOf, accountsIn, legacyOwnerOf, migrateGmailSecrets, removeAccount, saveAccount, setAccountEnabled } from "../../src/google/gmail-accounts.ts";

const SOURCE = "google-gmail";
const OLD = { address: "Old.User@example.com", password: "oldpasswordabcdef" };
const OTHER = { address: "other.user@example.com", password: "otherpassword1234" };
const ID = accountIdOf(OLD.address);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ergo-gmail-accounts-"));
  dirs.push(dir);
  const store = createDataSourceSecrets({ dir, log: () => {} });
  const secrets = store.forSource(SOURCE);
  const file = path.join(dir, `${SOURCE}.json`);
  const values = () => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { values: Record<string, string> }).values : undefined);
  return { dir, file, store, secrets, values };
}

/** 老配置（298 号票写的样子） */
function oldConfig(secrets: DataSourceSecrets) {
  secrets.set("address", OLD.address);
  secrets.set("password", OLD.password);
}

/** 第 n 次写（set、delete）时失败，模拟磁盘满、文件被占着 */
function failingAt(secrets: DataSourceSecrets, n: number): { secrets: DataSourceSecrets; writes: () => number } {
  let count = 0;
  const step = () => {
    count += 1;
    if (count === n) throw new Error("模拟：写不了文件");
  };
  return {
    writes: () => count,
    secrets: {
      get: (name) => secrets.get(name),
      has: (name) => secrets.has(name),
      set(name, value) {
        step();
        secrets.set(name, value);
      },
      delete(name) {
        step();
        secrets.delete(name);
      },
    },
  };
}

const MIGRATED = {
  accounts: ID,
  [`account.${ID}.address`]: OLD.address,
  [`account.${ID}.password`]: OLD.password,
  [`account.${ID}.enabled`]: "on",
  "legacy.account": ID,
  "backup.pre-344.address": OLD.address,
  "backup.pre-344.password": OLD.password,
  "backup.pre-344.at": expect.any(String),
};

describe("老配置转成一条账号", () => {
  it("转过来：一条账号，备份在同一格里，老键没了，老记录归它；再转一次什么都不动", () => {
    const { secrets, values } = open();
    oldConfig(secrets);
    expect(migrateGmailSecrets(secrets)).toBe("migrated");
    expect(values()).toEqual(MIGRATED);
    expect(accountsIn(secrets)).toEqual([{ id: ID, address: OLD.address, password: OLD.password, enabled: true }]);
    expect(legacyOwnerOf(secrets)).toBe(ID);
    const before = values();
    expect(migrateGmailSecrets(secrets)).toBe("skipped");
    expect(values()).toEqual(before);
  });

  it("转过来以后再加一条：第二条不碰第一条；再跑一次迁移不重复", () => {
    const { secrets } = open();
    oldConfig(secrets);
    migrateGmailSecrets(secrets);
    saveAccount(secrets, OTHER);
    expect(migrateGmailSecrets(secrets)).toBe("skipped");
    expect(accountsIn(secrets).map((a) => [a.address, a.password])).toEqual([
      [OLD.address, OLD.password],
      [OTHER.address, OTHER.password],
    ]);
  });

  it("新装的不转；老配置本来就不全的（老版本写到一半）不动", () => {
    const fresh = open();
    expect(migrateGmailSecrets(fresh.secrets)).toBe("skipped");
    expect(fresh.values()).toBeUndefined();
    const half = open();
    half.secrets.set("address", OLD.address);
    expect(migrateGmailSecrets(half.secrets)).toBe("skipped");
    expect(half.values()).toEqual({ address: OLD.address });
    expect(accountsIn(half.secrets)).toEqual([]);
  });

  it("在每一步上写失败：老键还在、照样读得出这一条；过了备份那几步备份也在；再跑一次和一次成功的一样", () => {
    const steps = (() => {
      const { secrets } = open();
      oldConfig(secrets);
      const counted = failingAt(secrets, Number.POSITIVE_INFINITY);
      migrateGmailSecrets(counted.secrets);
      return counted.writes();
    })();
    expect(steps).toBeGreaterThanOrEqual(8);
    for (let n = 1; n <= steps; n++) {
      const { secrets, values } = open();
      oldConfig(secrets);
      expect(() => migrateGmailSecrets(failingAt(secrets, n).secrets)).toThrow("模拟：写不了文件");
      const now = values()!;
      // 删老键之前（前面几步）：两个老键都在；备份写完之后（前两步写地址和密码）备份也在
      const oldKeys = n < steps - 1 ? { address: OLD.address, password: OLD.password } : {};
      const backup = n > 2 ? { "backup.pre-344.address": OLD.address, "backup.pre-344.password": OLD.password } : {};
      expect(now).toMatchObject({ ...oldKeys, ...backup });
      // 断在哪一步都读得出这一条（密码对）
      expect(accountsIn(secrets).map((a) => [a.id, a.address, a.password, a.enabled])).toEqual([[ID, OLD.address, OLD.password, true]]);
      expect(legacyOwnerOf(secrets)).toBe(ID);
      // 下次启动再跑：结果和一次成功的一样
      migrateGmailSecrets(secrets);
      expect(values()).toEqual(MIGRATED);
      expect(migrateGmailSecrets(secrets)).toBe("skipped");
    }
  });

  it("出错信息里没有地址和密码", () => {
    const { secrets } = open();
    oldConfig(secrets);
    let message = "";
    try {
      migrateGmailSecrets(failingAt(secrets, 3).secrets);
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain("模拟");
    expect(message).not.toContain(OLD.password);
    expect(message).not.toContain(OLD.address);
  });

  it("回退到老版本（备份写回老键）：老版本读得到；在老版本里换过密码再升级，新填的算数，不多出一条", () => {
    const { file, secrets, values } = open();
    oldConfig(secrets);
    migrateGmailSecrets(secrets);
    // 回退办法：只把备份写回 address、password
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { format: 1; values: Record<string, string> };
    stored.values.address = stored.values["backup.pre-344.address"]!;
    stored.values.password = stored.values["backup.pre-344.password"]!;
    fs.writeFileSync(file, JSON.stringify(stored));
    expect(secrets.get("address")).toBe(OLD.address);
    expect(secrets.get("password")).toBe(OLD.password);
    // 老版本里换了密码
    secrets.set("password", "changedinoldversion");
    expect(migrateGmailSecrets(secrets)).toBe("migrated");
    expect(accountsIn(secrets).map((a) => a.password)).toEqual(["changedinoldversion"]);
    expect(values()).toMatchObject({ accounts: ID, "backup.pre-344.password": "changedinoldversion" });
    expect(values()!.address).toBeUndefined();
  });

  it("备份只在密钥区：目录里只有这一格文件", () => {
    const { dir, secrets } = open();
    oldConfig(secrets);
    migrateGmailSecrets(secrets);
    expect(fs.readdirSync(dir)).toEqual([`${SOURCE}.json`]);
  });
});

describe("账号的存法", () => {
  it("同一个地址（不分大小写）是同一条：换密码不多一条，开关不变，备份里的旧密码跟着换", () => {
    const { secrets, values } = open();
    oldConfig(secrets);
    migrateGmailSecrets(secrets);
    setAccountEnabled(secrets, ID, false);
    saveAccount(secrets, { address: OLD.address.toLowerCase(), password: "newpassword123456" });
    expect(accountsIn(secrets).map((a) => [a.id, a.address, a.password, a.enabled])).toEqual([[ID, OLD.address.toLowerCase(), "newpassword123456", false]]);
    expect(values()!["backup.pre-344.password"]).toBe("newpassword123456");
    expect(JSON.stringify(values())).not.toContain(OLD.password);
  });

  it("迁移没成时换了密码：下次转过来不会被老键盖回去", () => {
    const { secrets } = open();
    oldConfig(secrets);
    saveAccount(secrets, { address: OLD.address, password: "newpassword123456" });
    migrateGmailSecrets(secrets);
    expect(accountsIn(secrets).map((a) => a.password)).toEqual(["newpassword123456"]);
  });

  it("断开一个：只删它的，另一个一个字不动；转过来的那一条断开时备份和老记录的归属一起删；最后一个断开文件没了", () => {
    const { file, secrets, values } = open();
    oldConfig(secrets);
    migrateGmailSecrets(secrets);
    const other = saveAccount(secrets, OTHER);
    // 断开后加的：备份还在、老账号不动
    removeAccount(secrets, other.id);
    expect(values()).toEqual(MIGRATED);
    saveAccount(secrets, OTHER);
    // 断开转过来的：密码哪儿都不剩
    removeAccount(secrets, ID);
    expect(values()).toEqual({ accounts: other.id, [`account.${other.id}.address`]: OTHER.address, [`account.${other.id}.password`]: OTHER.password, [`account.${other.id}.enabled`]: "on" });
    expect(fs.readFileSync(file, "utf8")).not.toContain(OLD.password);
    expect(legacyOwnerOf(secrets)).toBeUndefined();
    removeAccount(secrets, other.id);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("迁移没成时断开这一条：老键也删掉（再启动不会又转回来）", () => {
    const { file, secrets } = open();
    oldConfig(secrets);
    expect(() => migrateGmailSecrets(failingAt(secrets, 3).secrets)).toThrow("模拟：写不了文件");
    removeAccount(secrets, ID);
    expect(accountsIn(secrets)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("上次断在删老键中间：下次启动删干净，账号还在", () => {
    const { secrets, values } = open();
    oldConfig(secrets);
    migrateGmailSecrets(secrets);
    secrets.set("address", OLD.address);
    expect(migrateGmailSecrets(secrets)).toBe("migrated");
    expect(values()).toEqual(MIGRATED);
  });

  it("写的时候读不了文件（被占着）：不当作空的盖掉，抛出去；读的时候当作空的", () => {
    const { dir, secrets } = open();
    // 目录占着那个文件名：读的时候 EISDIR，和文件被占着一样是读不出来
    fs.mkdirSync(path.join(dir, `${SOURCE}.json`));
    expect(secrets.get("address")).toBeUndefined();
    expect(() => secrets.set("address", OLD.address)).toThrow("EISDIR");
    expect(() => secrets.delete("address")).toThrow("EISDIR");
    expect(fs.readdirSync(dir)).toEqual([`${SOURCE}.json`]);
  });

  it("读写的值都留给内核换 ***：每个地址、密码各占一格（不拼成一段）", () => {
    const { store, secrets } = open();
    saveAccount(secrets, OLD);
    saveAccount(secrets, OTHER);
    const values = store.valuesOf(SOURCE);
    for (const secret of [OLD.address, OLD.password, OTHER.address, OTHER.password]) expect(values).toContain(secret);
    // 开关的值短到不会把普通字换成 ***
    expect(values.filter((v) => v === "on").length).toBe(2);
  });
});
