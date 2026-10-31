// Gmail 的几个账号（344 号票）：密钥区那一格（data-sources/google-gmail.json）里怎么存，和老配置（298 号票：只有一个账号）怎么转过来。
//
// 存法（照 Google 日历的 feeds，一个值一格，不把几个账号拼成一段 JSON：内核按"这一格里的每个值"把出错原因里的密钥换成 ***，拼起来就换不到了）：
// - accounts：几个账号的 id，逗号分开，按加的先后；
// - account.<id>.address、account.<id>.password、account.<id>.enabled（on / off：账号的开关，关着的不查、不导入、不再试）。
// id 是地址（小写）的哈希前 10 位：同一个地址断开了再加还是它，同步进度接得上；从 id 推不回地址，所以事件里记 id。
// 开关的值只有两三个字母：内核不换 4 个字以下的值（redactSecrets），不会把出错原因里的普通字换成 ***。
//
// 迁移（启动时内核叫，数据源的 migrate；规矩照 migrate/legacy-db.ts）：把老的 address、password 两个键转成一条账号。
// - 先备份后动手：backup.pre-344.address、.password、.at 写在**同一格**里——密钥区整个不进备份区（nonBackupEntries），断开时跟着删；
// - 一步一步写（每一步是一次原子的改名），accounts 里加上 id 才算转好，最后才删老键。任何一步失败都原样抛出去（内核记一条日志、照常启动）：
//   老键还在、备份在，下次启动从头再来一遍，结果一样（可重复执行）；转好以后老键没了，再启动什么都不做；
// - 没转成的时候照样能用：accountsIn 把老键当一条账号读出来（只在内存里），Gmail 不会因为迁移失败连不上；
// - 老键比什么都新（新代码从不写老键，老键还在就是没转完，或者回退到老版本以后又填过）：地址对得上已有账号时用老键的密码盖掉；
// - 老记录（legacy.account）：转之前导入的邮件和同步进度没写账号，归转过来的这一条（legacyOwnerOf）。
// 回退到老版本：老版本只认 address、password，把备份写回这两个键就行（docs/developer-guide.md 写了怎么做），新版本的键老版本不看；再升级时重新转一遍。
//
// 这个文件不写日志、不抛带值的错：地址、密码一个都不出去。
import { createHash } from "node:crypto";
import { nowIso } from "@ergo/protocol";
import type { DataSourceSecrets } from "../data-sources/api.ts";

const ACCOUNTS_KEY = "accounts";
const addressKey = (id: string) => `account.${id}.address`;
const passwordKey = (id: string) => `account.${id}.password`;
const enabledKey = (id: string) => `account.${id}.enabled`;
/** 老配置的两个键（298 号票） */
const OLD_ADDRESS_KEY = "address";
const OLD_PASSWORD_KEY = "password";
/** 迁移的备份（在密钥区同一格里） */
const BACKUP_ADDRESS_KEY = "backup.pre-344.address";
const BACKUP_PASSWORD_KEY = "backup.pre-344.password";
const BACKUP_AT_KEY = "backup.pre-344.at";
/** 转过来的是哪个账号：没写账号的老记录归它 */
const LEGACY_KEY = "legacy.account";

/** 一个账号（带密码，只在 gmail.ts 里用） */
export interface GmailAccount {
  readonly id: string;
  readonly address: string;
  readonly password: string;
  readonly enabled: boolean;
}

/** 地址 → 账号的 id（不分大小写：Gmail 地址不分） */
export const accountIdOf = (address: string): string => `a${createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 10)}`;

/** 列着的 id */
const listedIds = (secrets: Pick<DataSourceSecrets, "get">): string[] => (secrets.get(ACCOUNTS_KEY) ?? "").split(",").filter(Boolean);

/** 老键里的地址对应哪个账号（没有老键是 undefined） */
const accountOfKey = (secrets: Pick<DataSourceSecrets, "get">, key: string): string | undefined => {
  const address = secrets.get(key);
  return address ? accountIdOf(address) : undefined;
};

/** 密钥区里配着的几个账号（按加的先后）；老键还没转过来的（迁移失败了）当一条读出来，排在最前 */
export function accountsIn(secrets: Pick<DataSourceSecrets, "get">): GmailAccount[] {
  const listed = listedIds(secrets).flatMap((id): GmailAccount[] => {
    const address = secrets.get(addressKey(id));
    const password = secrets.get(passwordKey(id));
    return address && password ? [{ id, address, password, enabled: secrets.get(enabledKey(id)) !== "off" }] : [];
  });
  const oldAddress = secrets.get(OLD_ADDRESS_KEY);
  const oldPassword = secrets.get(OLD_PASSWORD_KEY);
  if (!oldAddress || !oldPassword) return listed;
  const id = accountIdOf(oldAddress);
  return listed.some((a) => a.id === id) ? listed : [{ id, address: oldAddress, password: oldPassword, enabled: true }, ...listed];
}

/** 把一个 id 排进账号列表（已经在的不动） */
function listAccount(secrets: DataSourceSecrets, id: string): void {
  const ids = listedIds(secrets);
  if (!ids.includes(id)) secrets.set(ACCOUNTS_KEY, [...ids, id].join(","));
}

/**
 * 存一个账号：加一条，或者换已有那一条的地址写法和密码（开关不动）。accounts 最后写：写到一半的不算数。
 * 老键、备份里要是同一个账号，密码跟着换：老键转过来时不盖掉新填的，换掉的旧密码也不留在备份里
 */
export function saveAccount(secrets: DataSourceSecrets, input: { address: string; password: string }): GmailAccount {
  const id = accountIdOf(input.address);
  secrets.set(addressKey(id), input.address);
  secrets.set(passwordKey(id), input.password);
  if (!secrets.has(enabledKey(id))) secrets.set(enabledKey(id), "on");
  if (accountOfKey(secrets, OLD_ADDRESS_KEY) === id) secrets.set(OLD_PASSWORD_KEY, input.password);
  if (accountOfKey(secrets, BACKUP_ADDRESS_KEY) === id) secrets.set(BACKUP_PASSWORD_KEY, input.password);
  listAccount(secrets, id);
  return { id, address: input.address, password: input.password, enabled: secrets.get(enabledKey(id)) !== "off" };
}

/** 开关一个账号 */
export function setAccountEnabled(secrets: DataSourceSecrets, id: string, enabled: boolean): void {
  secrets.set(enabledKey(id), enabled ? "on" : "off");
}

/** 断开一个账号：只删它自己的（老键、备份、老记录的归属是它的才删）；别的账号一个字不动。最后一个断开时这一格文件也没了 */
export function removeAccount(secrets: DataSourceSecrets, id: string): void {
  secrets.delete(passwordKey(id));
  secrets.delete(addressKey(id));
  secrets.delete(enabledKey(id));
  if (accountOfKey(secrets, OLD_ADDRESS_KEY) === id) {
    secrets.delete(OLD_PASSWORD_KEY);
    secrets.delete(OLD_ADDRESS_KEY);
  }
  if (accountOfKey(secrets, BACKUP_ADDRESS_KEY) === id) {
    secrets.delete(BACKUP_PASSWORD_KEY);
    secrets.delete(BACKUP_AT_KEY);
    secrets.delete(BACKUP_ADDRESS_KEY);
  }
  if (secrets.get(LEGACY_KEY) === id) secrets.delete(LEGACY_KEY);
  const rest = listedIds(secrets).filter((one) => one !== id);
  if (rest.length > 0) secrets.set(ACCOUNTS_KEY, rest.join(","));
  else secrets.delete(ACCOUNTS_KEY);
}

/** 没写账号的老记录归谁：转过来的那一条；还没转的是老键那个地址；都没有（老版本断开过）是 undefined，谁也不归 */
export function legacyOwnerOf(secrets: Pick<DataSourceSecrets, "get">): string | undefined {
  return secrets.get(LEGACY_KEY) ?? accountOfKey(secrets, OLD_ADDRESS_KEY);
}

export type GmailMigrationOutcome = "migrated" | "skipped";

/**
 * 把老的两个键转成一条账号；可重复执行。交回 migrated（这次动了）、skipped（新装的、已经转好的，或者老配置本来就不全）。
 * 转不成（写不了文件）原样抛出去，老键还在
 */
export function migrateGmailSecrets(secrets: DataSourceSecrets): GmailMigrationOutcome {
  const address = secrets.get(OLD_ADDRESS_KEY);
  const password = secrets.get(OLD_PASSWORD_KEY);
  if (address === undefined && password === undefined) return "skipped";
  if (!address || !password) {
    // 上次转好了、删老键时断在两个键中间：删干净。不是的（老版本写到一半就断了，本来就不算连着）不动，等用户重新填
    if (secrets.get(LEGACY_KEY) === undefined) return "skipped";
    secrets.delete(OLD_PASSWORD_KEY);
    secrets.delete(OLD_ADDRESS_KEY);
    return "migrated";
  }
  const id = accountIdOf(address);
  // 1. 先备份（在密钥区同一格里）
  secrets.set(BACKUP_ADDRESS_KEY, address);
  secrets.set(BACKUP_PASSWORD_KEY, password);
  secrets.set(BACKUP_AT_KEY, nowIso());
  // 2. 写这一条账号（开关不动：回退再升级的沿用）
  secrets.set(addressKey(id), address);
  secrets.set(passwordKey(id), password);
  if (!secrets.has(enabledKey(id))) secrets.set(enabledKey(id), "on");
  // 3. 没写账号的老记录归它
  secrets.set(LEGACY_KEY, id);
  // 4. 排进账号列表：到这里才算转好
  listAccount(secrets, id);
  // 5. 删老键（密码先删：断在中间时只剩一个地址，下次启动删干净）
  secrets.delete(OLD_PASSWORD_KEY);
  secrets.delete(OLD_ADDRESS_KEY);
  return "migrated";
}
