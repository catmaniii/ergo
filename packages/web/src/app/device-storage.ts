// 记在这台设备浏览器里的东西（localStorage）用到的那部分：本设备已被吊销的记号（revoked-mark.ts）、外观（theme.ts）、
// 自动播放 agent 语音的开关（voice-autoplay-setting.ts）、宽屏阶段栏收起还是展开（stage-side-setting.ts，88 号票）。
// 测试换成假的。隐私模式、禁用了站点数据时一取就抛错，用的地方都按"没记过"处理、写不进去也不抛错。
export type DeviceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
