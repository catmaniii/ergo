// 构建时写进页面的二狗版本和更新日志（124 号票，build/build-info-plugin.ts 提供这个虚拟模块）
declare module "virtual:ergo-build-info" {
  /** 二狗的版本（仓库根目录 package.json 的 version） */
  export const APP_VERSION: string;
  /** 仓库根目录 CHANGELOG.md 的原文，UTF-8 的 base64（没有这个文件是空串） */
  export const CHANGELOG_BASE64: string;
}
