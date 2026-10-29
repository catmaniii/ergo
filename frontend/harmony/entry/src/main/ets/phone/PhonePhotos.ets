import { common, Permissions } from '@kit.AbilityKit';
import { dataSharePredicates } from '@kit.ArkData';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppSettings, DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';
import { closeQuietly, deviceName, errorText, permissionGranted, requestPermissions } from './PhoneCommon';
import { GeoSpot, PhoneAddress, PhoneGeocoder } from './PhoneGeocode';

/**
 * 读本机：照片的时间地点（300 号票）。二狗的网页经原生桥调（NativeBridge.ets 的 phonePhotos* 三个方法），读到的交回网页，网页再交给
 * 用户自己的守护进程（POST /api/data-sources/phone-photos/push）；App 自己不存、不另外发到别处。网页一侧的包装在 packages/web/src/app/native-phone.ts。
 * - 授权：READ_IMAGEVIDEO（读相册；受限权限，调试包走自动签名，上架要审核，docs/research/36、39）和 MEDIA_LOCATION（照片里的位置，
 *   没有它系统把照片的 GPS 信息去掉）一起要，用到时弹系统的授权框；拒过的只有用户自己点（userAction）才拉起二次授权；
 * - 只读 [from, to) 里拍的图片（不读视频）：相册给的拍摄时间（DATE_TAKEN_MS），有读照片位置的授权时再打开文件读 EXIF 里的经纬度
 *   （GPSLatitude / GPSLongitude 和南北东西）；不读、不交照片本身，交给网页的编号是相册里这张照片的地址（守护进程只存它的哈希）。
 *   读过的地点记在内存里（同一张照片下次不再打开文件）；
 * - 相册只在本机的照片读得到（API 26 起只存在云端的读不到）。
 * - 308 号票：有地点的照片交之前用系统的坐标转地址转成地名（PhoneGeocode.ets，200 米内转过的不再转，转不了的只交坐标），一起交。
 */

const READ_PHOTOS: Permissions = 'ohos.permission.READ_IMAGEVIDEO';
const PHOTO_LOCATION: Permissions = 'ohos.permission.MEDIA_LOCATION';
/** 一次最多交几张（和守护进程那边 PHONE_PHOTOS_MAX 一样） */
const PHOTOS_MAX = 3000;

class PhotoItem {
  key: string = '';
  takenAt: number = 0;
  lat?: number;
  lon?: number;
  /** 拍摄地点的系统地名（308 号票，转得了才有） */
  address?: PhoneAddress;
}

class PhotosStateResult {
  granted: boolean = false;
  location: boolean = false;
  asked: boolean = false;
  device?: string;
}

class PhotosReadResult {
  ok: boolean = false;
  state?: string;
  message?: string;
  location?: boolean;
  photos?: PhotoItem[];
}

/** 查相册的结果：按哪一列查的（拍摄时间毫秒 / 秒）、几倍换成毫秒；查到的图片；查不了的错 */
class Found {
  key: string = '';
  scale: number = 1;
  assets: photoAccessHelper.PhotoAsset[] = [];
  error?: BusinessError;
}

/** 读过的一张照片的地点（没有地点的也记，lat 是 NaN） */
class Place {
  lat: number = NaN;
  lon: number = NaN;
}

/** EXIF 里的一个有理数（"3240/100"）或小数 */
function rational(text: string): number {
  const parts = text.split('/');
  return parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(text);
}

/** EXIF 的经纬度："度,分,秒"三个有理数（"30/1,15/1,3240/100"）或小数（"30, 15, 32.4"），南纬西经取负；读不出是 NaN */
export function exifDegrees(value: string | null | undefined, ref: string | null | undefined): number {
  if (value === null || value === undefined) {
    return NaN;
  }
  const parts = value.split(/[,\s]+/).filter((p: string) => p !== '');
  if (parts.length === 0) {
    return NaN;
  }
  const nums = parts.map((p: string) => rational(p));
  if (nums.some((n: number) => !Number.isFinite(n))) {
    return NaN;
  }
  let degrees = nums[0] + (nums.length > 1 ? nums[1] / 60 : 0) + (nums.length > 2 ? nums[2] / 3600 : 0);
  const side = (ref ?? '').trim().toUpperCase();
  if (side === 'S' || side === 'W') {
    degrees = -degrees;
  }
  return degrees;
}

export class PhonePhotos {
  private context: common.UIAbilityContext;
  private settings: AppSettings;
  private geocoder: PhoneGeocoder;
  /** 读过的照片的地点（照片地址 → 地点） */
  private places: Map<string, Place> = new Map<string, Place>();

  constructor(context: common.UIAbilityContext, settings: AppSettings, geocoder: PhoneGeocoder) {
    this.context = context;
    this.settings = settings;
    this.geocoder = geocoder;
  }

  /** {"granted", "location", "asked", "device"} */
  state(): string {
    return JSON.stringify(this.current());
  }

  /** 要读相册、读照片位置的授权（系统的授权框）；userAction 为真而拒过时拉起二次授权；回之后的状态 */
  async prepare(userAction: boolean): Promise<string> {
    if (!(permissionGranted(READ_PHOTOS) && permissionGranted(PHOTO_LOCATION))) {
      await requestPermissions(this.context, [READ_PHOTOS, PHOTO_LOCATION], userAction);
      this.settings.setPhotosAsked();
    }
    hilog.info(DOMAIN, TAG, 'photos permission: %{public}s, location %{public}s', String(permissionGranted(READ_PHOTOS)), String(permissionGranted(PHOTO_LOCATION)));
    return JSON.stringify(this.current());
  }

  /**
   * 只读 [from, to)（毫秒，字符串）里拍的照片的时间地点：{"ok": true, "location", "photos": [...]}；
   * 没授权 {"ok": false, "state": "denied"}，读不了 {"ok": false, "state": "unavailable", "message"}
   */
  async read(fromMs: string, toMs: string): Promise<string> {
    const result = new PhotosReadResult();
    const from = Number(fromMs);
    const to = Number(toMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      result.state = 'unavailable';
      result.message = t('harmony.phone.badRange');
      return JSON.stringify(result);
    }
    if (!permissionGranted(READ_PHOTOS)) {
      result.state = 'denied';
      return JSON.stringify(result);
    }
    const location = permissionGranted(PHOTO_LOCATION);
    try {
      const helper = photoAccessHelper.getPhotoAccessHelper(this.context);
      const found = await this.query(helper, from, to);
      if (found.error !== undefined) {
        return this.failed(result, found.error);
      }
      const photos: PhotoItem[] = [];
      let located = 0;
      for (const asset of found.assets) {
        if (photos.length >= PHOTOS_MAX) {
          break;
        }
        const taken = Number(asset.get(found.key)) * found.scale;
        if (!Number.isFinite(taken) || taken < from || taken >= to) {
          continue;
        }
        const item = new PhotoItem();
        item.key = asset.uri;
        item.takenAt = taken;
        if (location) {
          const place = await this.placeOf(asset.uri);
          if (Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
            item.lat = place.lat;
            item.lon = place.lon;
            located += 1;
          }
        }
        photos.push(item);
      }
      // 有地点的转成地名（308 号票）：转不了的只交坐标
      const withPlace = photos.filter((p: PhotoItem) => p.lat !== undefined && p.lon !== undefined);
      const spots = withPlace.map((p: PhotoItem) => {
        const spot = new GeoSpot();
        spot.lat = p.lat as number;
        spot.lon = p.lon as number;
        return spot;
      });
      const names = await this.geocoder.addressesOf(spots);
      let named = 0;
      for (let i = 0; i < withPlace.length; i++) {
        const name = names[i];
        if (name !== undefined) {
          withPlace[i].address = name;
          named += 1;
        }
      }
      hilog.info(DOMAIN, TAG, 'photos read: %{public}d (with place %{public}d, named %{public}d, location permission %{public}s)', photos.length, located, named, String(location));
      result.ok = true;
      result.location = location;
      result.photos = photos;
      return JSON.stringify(result);
    } catch (e) {
      return this.failed(result, e as BusinessError);
    }
  }

  /** 读不了：201 是权限没了（读到一半被撤回），别的是读不了，带原因 */
  private failed(result: PhotosReadResult, err: BusinessError): string {
    hilog.error(DOMAIN, TAG, 'read photos failed: %{public}s', JSON.stringify(err));
    result.ok = false;
    result.state = err.code === 201 ? 'denied' : 'unavailable';
    result.message = t('harmony.phone.photosFailed', { 'error': errorText(err) });
    return JSON.stringify(result);
  }

  /** 相册里 [from, to) 拍的图片，新的在前；按毫秒的拍摄时间查不了的（旧一点的系统）退回按秒的 */
  private async query(helper: photoAccessHelper.PhotoAccessHelper, from: number, to: number): Promise<Found> {
    const byMs = await this.fetch(helper, photoAccessHelper.PhotoKeys.DATE_TAKEN_MS, 1, from, to);
    if (byMs.error === undefined) {
      return byMs;
    }
    hilog.warn(DOMAIN, TAG, 'query by date_taken_ms failed, fall back to seconds: %{public}s', JSON.stringify(byMs.error));
    return await this.fetch(helper, photoAccessHelper.PhotoKeys.DATE_TAKEN, 1000, Math.floor(from / 1000), Math.ceil(to / 1000));
  }

  /** 按 key 这一列（拍摄时间，scale 倍是毫秒）查 [from, to) 的图片；出错的写进 error */
  private async fetch(helper: photoAccessHelper.PhotoAccessHelper, key: string, scale: number, from: number, to: number): Promise<Found> {
    const out = new Found();
    out.key = key;
    out.scale = scale;
    let result: photoAccessHelper.FetchResult<photoAccessHelper.PhotoAsset> | undefined = undefined;
    try {
      const predicates = new dataSharePredicates.DataSharePredicates();
      predicates.equalTo(photoAccessHelper.PhotoKeys.PHOTO_TYPE, photoAccessHelper.PhotoType.IMAGE)
        .and()
        .greaterThanOrEqualTo(key, from)
        .and()
        .lessThan(key, to)
        .orderByDesc(key);
      const options: photoAccessHelper.FetchOptions = { fetchColumns: [key], predicates: predicates };
      result = await helper.getAssets(options);
      out.assets = await result.getAllObjects();
    } catch (e) {
      out.error = e as BusinessError;
    } finally {
      try {
        result?.close();
      } catch (e) {
        hilog.warn(DOMAIN, TAG, 'close fetch result failed: %{public}s', JSON.stringify(e));
      }
    }
    return out;
  }

  /** 一张照片的拍摄地点（EXIF 里的经纬度）；读过的直接给；没有地点、读不了的 lat 是 NaN */
  private async placeOf(uri: string): Promise<Place> {
    const known = this.places.get(uri);
    if (known !== undefined) {
      return known;
    }
    const place = new Place();
    let file: fs.File | undefined = undefined;
    let source: image.ImageSource | undefined = undefined;
    try {
      file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      source = image.createImageSource(file.fd);
      const props = await source.getImageProperties([image.PropertyKey.GPS_LATITUDE, image.PropertyKey.GPS_LATITUDE_REF,
        image.PropertyKey.GPS_LONGITUDE, image.PropertyKey.GPS_LONGITUDE_REF]);
      const lat = exifDegrees(props[image.PropertyKey.GPS_LATITUDE], props[image.PropertyKey.GPS_LATITUDE_REF]);
      const lon = exifDegrees(props[image.PropertyKey.GPS_LONGITUDE], props[image.PropertyKey.GPS_LONGITUDE_REF]);
      // 正好 (0, 0) 是没有地点（被去掉的位置有的写成 0）
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
        place.lat = lat;
        place.lon = lon;
      }
    } catch (e) {
      // 没有 GPS 信息的照片读属性会报错：当没有地点
      hilog.info(DOMAIN, TAG, 'photo has no readable place: %{public}s', JSON.stringify(e));
    } finally {
      if (source !== undefined) {
        try {
          await source.release();
        } catch (e) {
          hilog.warn(DOMAIN, TAG, 'release image source failed: %{public}s', JSON.stringify(e));
        }
      }
      closeQuietly(file);
    }
    this.places.set(uri, place);
    return place;
  }

  private current(): PhotosStateResult {
    const state = new PhotosStateResult();
    state.granted = permissionGranted(READ_PHOTOS);
    state.location = permissionGranted(PHOTO_LOCATION);
    state.asked = this.settings.photosAsked();
    const device = deviceName();
    if (device !== '') {
      state.device = device;
    }
    return state;
  }
}
