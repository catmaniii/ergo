import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { geoLocationManager } from '@kit.LocationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';
import { closeQuietly, errorText } from './PhoneCommon';

/**
 * 读本机：坐标转地名（308 号票；用户 2026-10-26 选了"系统转地名 + 常去地起名"）。照片的拍摄地点、位置点交给网页之前，用鸿蒙系统的
 * 坐标转地址（geoLocationManager.getAddressesFromLocation：官方文档没写要不要联网，大概率走华为的地图服务，坐标会发给华为，用户接受）
 * 转成地名——街道或地标、区县、城市（addressOf），和坐标一起交；守护进程那边按"起了名的 > 系统地名 > 坐标"写进摘要。
 * - 不反复重试、不耗电：系统说转不了（isGeocoderAvailable 为假，查一次记 5 分钟）就不调；一次同步最多调 20 次；一次没转成（没网、系统
 *   出错、8 秒没回）这一次就停下，25 分钟里不再试（App 开着时每 30 分钟同步一次，下一次再试一下）；转不了的只交坐标；
 * - 同一片地方不重复转：转过的（转出来没有地名的也记着）存在 App 自己的文件里（filesDir/phone-geocode.json，最多 500 处，满了丢最早的），
 *   200 米以内的直接用；
 * - "常去的地方"手动加一处：按地名找（getAddressesFromLocationName，系统的地址转坐标，find）；现在在哪（定一次位再转地名）在 PhoneLocation.here。
 */

/** 交给网页的地名：街道或地标、区县、城市（转不出的那段没有） */
export interface PhoneAddress {
  spot?: string;
  district?: string;
  city?: string;
}

/** 要转地名的一处 */
export class GeoSpot {
  lat: number = 0;
  lon: number = 0;
}

/** 转过的一处（存进 phone-geocode.json）：坐标、什么时候转的、转出来的地名（都没有是转出来没有地名） */
class CachedAddress {
  lat: number = 0;
  lon: number = 0;
  at: number = 0;
  spot?: string;
  district?: string;
  city?: string;
}

class ReverseResult {
  failed: boolean = false;
  address?: PhoneAddress;
}

/** 按地名找、现在在哪交给网页的：{"ok": true, "lat", "lon", "address"?}；{"ok": false, "state": "denied" | "not_found" | "unavailable", "message"?} */
export class PlaceFixResult {
  ok: boolean = false;
  state?: string;
  message?: string;
  lat?: number;
  lon?: number;
  address?: PhoneAddress;
}

const CACHE_FILE = 'phone-geocode.json';
/** 缓存最多几处 */
const CACHE_MAX = 500;
/** 这么近（米）以内转过的直接用 */
const SAME_SPOT_M = 200;
/** 一次最多调几次系统的转地址 */
const CALLS_PER_BATCH = 20;
/** 一次没转成以后多久不再试（毫秒） */
const PAUSE_MS = 25 * 60 * 1000;
/** 调一次最多等多久（毫秒） */
const CALL_TIMEOUT_MS = 8000;
/** 系统能不能转地名查一次记多久（毫秒） */
const AVAILABLE_TTL_MS = 5 * 60 * 1000;

/**
 * 系统的坐标转地址给的一条 → 交给网页的地名：城市取 locality（市），没有的退到 subAdministrativeArea、administrativeArea；区县取 subLocality；
 * 街道或地标取 roadName（街道，同一片地方稳定），没有的取 premises（门牌、楼）、subRoadName、descriptions 的第一条、详细地址 placeName
 * 去掉开头的国家省市区县剩下的（模拟器上的系统只给省市区县和 placeName）。每段去掉多余空白、
 * 最多 30 个字（和守护进程那边 PHONE_ADDRESS_PART_MAX 一样）；一段都没有回 undefined。
 * 不引用模块里别的东西（frontend/test/harmony.test.ts 把这个函数单拿出来跑）
 */
function addressOf(geo: geoLocationManager.GeoAddress): PhoneAddress | undefined {
  const clean = (value: string | undefined): string => {
    if (typeof value !== 'string') {
      return '';
    }
    const s = value.replace(/\s+/g, ' ').trim();
    return s.length > 30 ? s.substring(0, 30) : s;
  };
  const first = (values: string[]): string => {
    for (const v of values) {
      if (v !== '') {
        return v;
      }
    }
    return '';
  };
  const descriptions = geo.descriptions;
  const described = descriptions !== undefined && descriptions.length > 0 ? clean(descriptions[0]) : '';
  // 详细地址（placeName）去掉开头的国家、省、市、区县，剩下的当街道或地标（有的系统只给这几样，没有 roadName）
  let detail = typeof geo.placeName === 'string' ? geo.placeName.replace(/\s+/g, '') : '';
  let stripped = true;
  while (stripped && detail !== '') {
    stripped = false;
    for (const area of [geo.countryName, geo.administrativeArea, geo.subAdministrativeArea, geo.locality, geo.subLocality]) {
      const prefix = typeof area === 'string' ? area.replace(/\s+/g, '') : '';
      if (prefix !== '' && detail.startsWith(prefix)) {
        detail = detail.substring(prefix.length);
        stripped = true;
      }
    }
  }
  const city = first([clean(geo.locality), clean(geo.subAdministrativeArea), clean(geo.administrativeArea)]);
  const district = clean(geo.subLocality);
  const spot = first([clean(geo.roadName), clean(geo.premises), clean(geo.subRoadName), described, clean(detail)]);
  const out: PhoneAddress = {};
  if (spot !== '') {
    out.spot = spot;
  }
  if (district !== '') {
    out.district = district;
  }
  if (city !== '') {
    out.city = city;
  }
  return spot === '' && district === '' && city === '' ? undefined : out;
}

/**
 * 缓存里离 (lat, lon) 最近、又在 maxM 米以内的那一条的下标；没有回 -1（球面距离）。
 * 不引用模块里别的东西（frontend/test/harmony.test.ts 把这个函数单拿出来跑）
 */
function nearestIndex(cache: CachedAddress[], lat: number, lon: number, maxM: number): number {
  const rad = Math.PI / 180;
  let best = -1;
  let bestD = maxM;
  for (let i = 0; i < cache.length; i++) {
    const c = cache[i];
    const dLat = (c.lat - lat) * rad;
    const dLon = (c.lon - lon) * rad;
    const s1 = Math.sin(dLat / 2);
    const s2 = Math.sin(dLon / 2);
    const h = s1 * s1 + Math.cos(lat * rad) * Math.cos(c.lat * rad) * s2 * s2;
    const d = 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** 缓存里的一条 → 地名（转出来没有地名的是 undefined） */
function cachedAddress(c: CachedAddress): PhoneAddress | undefined {
  if (c.spot === undefined && c.district === undefined && c.city === undefined) {
    return undefined;
  }
  const out: PhoneAddress = {};
  if (c.spot !== undefined) {
    out.spot = c.spot;
  }
  if (c.district !== undefined) {
    out.district = c.district;
  }
  if (c.city !== undefined) {
    out.city = c.city;
  }
  return out;
}

/** 按地名找时先在最近一次定到的位置周围多少度以内找（约 50 公里） */
const NEAR_DEGREES = 0.5;

/** 系统记着的最近一次定位（没有、没授权是 undefined） */
function lastLocation(): geoLocationManager.Location | undefined {
  try {
    return geoLocationManager.getLastLocation();
  } catch (e) {
    return undefined;
  }
}

/** 系统给的地址里哪几项有值（只写项名、不写内容，记日志看系统给了什么） */
function filledFields(geo: geoLocationManager.GeoAddress): string {
  const names: string[] = [];
  const add = (name: string, value: string | undefined) => {
    if (typeof value === 'string' && value.trim() !== '') {
      names.push(name);
    }
  };
  add('administrativeArea', geo.administrativeArea);
  add('subAdministrativeArea', geo.subAdministrativeArea);
  add('locality', geo.locality);
  add('subLocality', geo.subLocality);
  add('roadName', geo.roadName);
  add('subRoadName', geo.subRoadName);
  add('premises', geo.premises);
  add('placeName', geo.placeName);
  if (geo.descriptions !== undefined && geo.descriptions.length > 0) {
    names.push(`descriptions*${geo.descriptions.length}`);
  }
  return names.join(',');
}

/** 等一个 Promise 最多 ms 毫秒，超时当出错 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
    promise.then((value: T) => {
      clearTimeout(timer);
      resolve(value);
    }, (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export class PhoneGeocoder {
  private context: common.UIAbilityContext;
  private cache: CachedAddress[] = [];
  private loaded: boolean = false;
  /** 一次没转成以后，这之前不再试 */
  private pausedUntil: number = 0;
  /** 系统能不能转地名（查过的结果、什么时候查的） */
  private availableAt: number = 0;
  private availableValue: boolean = false;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  /** 系统能不能把坐标转成地名（模拟器、没有地图服务的系统上是假）；查一次记 5 分钟 */
  available(): boolean {
    const now = Date.now();
    if (this.availableAt > 0 && now - this.availableAt < AVAILABLE_TTL_MS) {
      return this.availableValue;
    }
    let value = false;
    try {
      value = geoLocationManager.isGeocoderAvailable();
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'check geocoder failed: %{public}s', JSON.stringify(e));
      value = false;
    }
    this.availableAt = now;
    this.availableValue = value;
    return value;
  }

  /**
   * 现在转得了地名没有（状态里报给网页，"常去的地方"那一块写一句）：系统说能转、又不在没转成以后的暂停里。
   * 模拟器上 isGeocoderAvailable 为真、调起来却回 3301300（308 号票在 Pura 90 模拟器上看到的），所以要算上暂停
   */
  usable(): boolean {
    return Date.now() >= this.pausedUntil && this.available();
  }

  /**
   * 一组坐标的地名（和 spots 一一对应，转不了的是 undefined）：200 米以内转过的直接用；没有的调系统转，这一次最多 20 次，
   * 一次没转成就停下、25 分钟里不再试
   */
  async addressesOf(spots: GeoSpot[]): Promise<Array<PhoneAddress | undefined>> {
    this.load();
    const out: Array<PhoneAddress | undefined> = [];
    let calls = 0;
    let hits = 0;
    let named = 0;
    let changed = false;
    let stopped = spots.length === 0 || !this.canCall();
    for (const spot of spots) {
      const hit = nearestIndex(this.cache, spot.lat, spot.lon, SAME_SPOT_M);
      if (hit >= 0) {
        hits += 1;
        const known = cachedAddress(this.cache[hit]);
        if (known !== undefined) {
          named += 1;
        }
        out.push(known);
        continue;
      }
      if (stopped || calls >= CALLS_PER_BATCH) {
        out.push(undefined);
        continue;
      }
      calls += 1;
      const result = await this.reverse(spot.lat, spot.lon);
      if (result.failed) {
        stopped = true;
        out.push(undefined);
        continue;
      }
      this.remember(spot.lat, spot.lon, result.address);
      changed = true;
      if (result.address !== undefined) {
        named += 1;
      }
      out.push(result.address);
    }
    if (changed) {
      this.save();
    }
    if (spots.length > 0) {
      hilog.info(DOMAIN, TAG, 'geocode: %{public}d spots, %{public}d named (cache %{public}d, calls %{public}d, available %{public}s, paused %{public}s)',
        spots.length, named, hits, calls, String(this.available()), String(Date.now() < this.pausedUntil));
    }
    return out;
  }

  /** 一处的地名（现在在哪用）：200 米以内转过的直接用；用户自己点的，25 分钟的暂停不算，照样试一次 */
  async addressAt(lat: number, lon: number): Promise<PhoneAddress | undefined> {
    this.load();
    const hit = nearestIndex(this.cache, lat, lon, SAME_SPOT_M);
    if (hit >= 0) {
      return cachedAddress(this.cache[hit]);
    }
    if (!this.available()) {
      return undefined;
    }
    const result = await this.reverse(lat, lon);
    if (!result.failed) {
      this.remember(lat, lon, result.address);
      this.save();
    }
    return result.address;
  }

  /** 按地名找（系统的地址转坐标，取第一个）：{"ok": true, "lat", "lon", "address"?}；没找到 not_found；系统转不了、出错 unavailable */
  async find(text: string): Promise<string> {
    const result = new PlaceFixResult();
    const query = text.trim().substring(0, 100);
    if (query === '') {
      result.state = 'not_found';
      return JSON.stringify(result);
    }
    if (!this.available()) {
      result.state = 'unavailable';
      result.message = t('harmony.phone.geocoderOff');
      return JSON.stringify(result);
    }
    try {
      // 先在手机最近一次定到的位置附近（约 50 公里）找，没有再不限范围找：只写"西湖"时别找到别的省的同名地方
      // （308 号票在模拟器上不限范围找"西湖"找到的是苗栗县西湖乡）
      let found: geoLocationManager.GeoAddress[] = [];
      const near = lastLocation();
      if (near !== undefined) {
        const bounded: geoLocationManager.GeoCodeRequest = {
          description: query, maxItems: 1, locale: 'zh',
          minLatitude: near.latitude - NEAR_DEGREES, maxLatitude: near.latitude + NEAR_DEGREES,
          minLongitude: near.longitude - NEAR_DEGREES, maxLongitude: near.longitude + NEAR_DEGREES
        };
        try {
          found = await withTimeout(geoLocationManager.getAddressesFromLocationName(bounded), CALL_TIMEOUT_MS);
        } catch (e) {
          // 附近没有时系统回 3301400 而不是空的（308 号票在模拟器上看到的）：当作附近没有，接着不限范围找
          hilog.info(DOMAIN, TAG, 'find place nearby: none (%{public}s)', JSON.stringify(e));
          found = [];
        }
      }
      if (!found.some((g: geoLocationManager.GeoAddress) => typeof g.latitude === 'number' && typeof g.longitude === 'number')) {
        const request: geoLocationManager.GeoCodeRequest = { description: query, maxItems: 1, locale: 'zh' };
        found = await withTimeout(geoLocationManager.getAddressesFromLocationName(request), CALL_TIMEOUT_MS);
      }
      const hit = found.find((g: geoLocationManager.GeoAddress) => typeof g.latitude === 'number' && typeof g.longitude === 'number');
      if (hit === undefined || hit.latitude === undefined || hit.longitude === undefined) {
        result.state = 'not_found';
        hilog.info(DOMAIN, TAG, 'find place: not found');
        return JSON.stringify(result);
      }
      result.ok = true;
      result.lat = hit.latitude;
      result.lon = hit.longitude;
      const address = addressOf(hit);
      if (address !== undefined) {
        result.address = address;
      }
      this.load();
      this.remember(hit.latitude, hit.longitude, address);
      this.save();
      hilog.info(DOMAIN, TAG, 'find place: found (near %{public}s, fields %{public}s)', String(near !== undefined), filledFields(hit));
    } catch (e) {
      const err = e as BusinessError;
      hilog.warn(DOMAIN, TAG, 'find place failed: %{public}s', JSON.stringify(e));
      result.state = 'unavailable';
      result.message = t('harmony.phone.findFailed', { 'error': errorText(err) });
    }
    return JSON.stringify(result);
  }

  private canCall(): boolean {
    return Date.now() >= this.pausedUntil && this.available();
  }

  /** 调一次系统的坐标转地址；没转成（出错、超时）记下暂停 */
  private async reverse(lat: number, lon: number): Promise<ReverseResult> {
    const result = new ReverseResult();
    try {
      const request: geoLocationManager.ReverseGeoCodeRequest = { latitude: lat, longitude: lon, maxItems: 1, locale: 'zh' };
      const found = await withTimeout(geoLocationManager.getAddressesFromLocation(request), CALL_TIMEOUT_MS);
      if (found.length > 0) {
        const address = addressOf(found[0]);
        if (address !== undefined) {
          result.address = address;
        }
        hilog.info(DOMAIN, TAG, 'geocode ok (fields %{public}s)', filledFields(found[0]));
      }
    } catch (e) {
      result.failed = true;
      this.pausedUntil = Date.now() + PAUSE_MS;
      hilog.warn(DOMAIN, TAG, 'geocode failed, pause %{public}d min: %{public}s', PAUSE_MS / 60000, JSON.stringify(e));
    }
    return result;
  }

  private remember(lat: number, lon: number, address: PhoneAddress | undefined): void {
    const entry = new CachedAddress();
    entry.lat = Math.round(lat * 100000) / 100000;
    entry.lon = Math.round(lon * 100000) / 100000;
    entry.at = Date.now();
    if (address !== undefined) {
      entry.spot = address.spot;
      entry.district = address.district;
      entry.city = address.city;
    }
    this.cache.push(entry);
    while (this.cache.length > CACHE_MAX) {
      this.cache.shift();
    }
  }

  private path(): string {
    return `${this.context.filesDir}/${CACHE_FILE}`;
  }

  /** 第一次用时把缓存读进来；读不了当没有 */
  private load(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const path = this.path();
      if (fs.accessSync(path)) {
        const value = JSON.parse(fs.readTextSync(path)) as CachedAddress[];
        if (Array.isArray(value)) {
          this.cache = value.filter((c: CachedAddress) => c !== null && typeof c === 'object' && typeof c.lat === 'number' &&
            typeof c.lon === 'number' && typeof c.at === 'number').slice(-CACHE_MAX);
        }
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'read geocode cache failed: %{public}s', JSON.stringify(e));
    }
  }

  private save(): void {
    let file: fs.File | undefined = undefined;
    try {
      file = fs.openSync(this.path(), fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, JSON.stringify(this.cache));
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'write geocode cache failed: %{public}s', JSON.stringify(e));
    } finally {
      closeQuietly(file);
    }
  }
}
