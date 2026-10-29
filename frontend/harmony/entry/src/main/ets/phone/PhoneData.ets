import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { calendarManager } from '@kit.CalendarKit';
import { contact } from '@kit.ContactsKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppSettings, DOMAIN, TAG } from '../common/AppSettings';
import { t } from '../common/AppTexts';
import { deviceName, errorText, permissionGranted } from './PhoneCommon';
import { PhoneGeocoder } from './PhoneGeocode';
import { PhoneLocation } from './PhoneLocation';
import { PhonePhotos } from './PhonePhotos';

/**
 * 读本机（299 号票）：二狗的网页经原生桥调（NativeBridge.ets 的 phone* 几个方法），读到的交回网页，网页再交给用户自己的守护进程
 * （POST /api/data-sources/<id>/push）；App 自己不存、不另外发到别处。网页一侧的包装在 packages/web/src/app/native-phone.ts。
 * - 通讯录选人：系统的选人界面（contact.selectContacts，不用通讯录权限、不批量读整个通讯录），只取用户挑的人的称呼、电话、生日、地址；
 * - 手机日历：READ_WHOLE_CALENDAR（读全部日历账户的日程；只有 READ_CALENDAR 读不到别的应用、系统日历里建的），用到时弹系统的授权框，
 *   拒过的只有用户自己点（userAction）才拉起二次授权（requestPermissionOnSetting）；只读 [from, to) 里的，重复的展开成每一次
 *   （queryEventInstances），只取标题、开始结束、全天、地点、哪个日历。
 * 300 号票：照片的时间地点（PhonePhotos.ets）、位置（PhoneLocation.ets）也挂在这里（photos、location），共用的在 PhoneCommon.ets。
 * 308 号票：两者共用一个坐标转地名（PhoneGeocode.ets，geocoder：缓存、暂停一处管），"常去的地方"按地名找也经它。
 */

/** 读全部日历的权限（受限权限：调试包走自动签名，上架要审核，见 docs/research/39） */
const READ_CALENDAR: Permissions = 'ohos.permission.READ_WHOLE_CALENDAR';
/** 一次最多挑几个人（和守护进程那边 PHONE_CONTACTS_MAX 一样） */
const CONTACTS_MAX = 20;
/** 一次最多交几条日程（和守护进程那边 PHONE_CALENDAR_EVENTS_MAX 一样） */
const EVENTS_MAX = 2000;

class PickedContact {
  name: string = '';
  phones: string[] = [];
  birthday?: string;
  addresses: string[] = [];
}

class ContactsPickResult {
  ok: boolean = false;
  reason?: string;
  message?: string;
  device?: string;
  contacts?: PickedContact[];
}

class CalendarStateResult {
  granted: boolean = false;
  asked: boolean = false;
  device?: string;
}

class PhoneEvent {
  key: string = '';
  title: string = '';
  start: number = 0;
  end?: number;
  allDay: boolean = false;
  location?: string;
  calendar?: string;
}

class CalendarReadResult {
  ok: boolean = false;
  state?: string;
  message?: string;
  events?: PhoneEvent[];
}

/** 一段字去掉首尾空白；空的、不是字的是空串 */
function clean(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 选人界面交回的联系人里的生日（304 号票在 HarmonyOS 6.1.1 模拟器上核对过）：系统通讯录存的 labelId 和 SDK 的 contact.Event 常量对不上——
 * 通讯录里的"生日"是 1、"农历生日"是 2、"周年纪念"是 3（SDK 里 1 是 EVENT_ANNIVERSARY、3 是 EVENT_BIRTHDAY），vCard 导入的生日也是 1，
 * 照 SDK 常量取会把周年纪念当成生日、真的生日漏掉。所以先认系统写的 labelName（"生日"、"Birthday"），没写 labelName 的按通讯录的 1 认；
 * 农历生日不要：eventDate 是那一年农历那天对应的公历，年年不一样，档案里的生日是按公历每年提醒的。
 * 不引用模块里别的东西（frontend/test/harmony.test.ts 把这个函数单拿出来跑）
 */
function birthdayOf(events: contact.Event[] | undefined): string | undefined {
  let fallback: string | undefined = undefined;
  for (const e of events ?? []) {
    const date = typeof e.eventDate === 'string' ? e.eventDate.trim() : '';
    const label = typeof e.labelName === 'string' ? e.labelName.trim().toLowerCase() : '';
    if (date === '' || /农历|農曆|阴历|陰曆|lunar/.test(label)) { // @i18n-ignore data：认系统通讯录写的标签
      continue;
    }
    if (/生日|birthday/.test(label)) { // @i18n-ignore data：认系统通讯录写的标签
      return date;
    }
    if (label === '' && e.labelId === 1 && fallback === undefined) {
      fallback = date;
    }
  }
  return fallback;
}

/**
 * 全天日程的开始、结束换成本机时区那一天的零点（304 号票在模拟器上核对过）：系统日历把全天日程按 UTC 零点存，日历界面建的、导入的都一样
 * （10-28 全天 = 10-28T00:00Z ~ 10-29T00:00Z）；东八区的 UTC 零点是早上 8 点，结束落在第二天里，二狗按本地日子算就多出一天。
 * 不是 UTC 零点的原样不动。不引用模块里别的东西（frontend/test/harmony.test.ts 把这个函数单拿出来跑）
 */
function localDayStart(ms: number): number {
  if (ms % 86400000 !== 0) {
    return ms;
  }
  const utc = new Date(ms);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate()).getTime();
}

export class PhoneData {
  private context: common.UIAbilityContext;
  private settings: AppSettings;
  /** 照片的时间地点（300 号票） */
  readonly photos: PhonePhotos;
  /** 位置（300 号票） */
  readonly location: PhoneLocation;
  /** 坐标转地名（308 号票，照片、位置共用；"常去的地方"按地名找） */
  readonly geocoder: PhoneGeocoder;

  constructor(context: common.UIAbilityContext, settings: AppSettings) {
    this.context = context;
    this.settings = settings;
    this.geocoder = new PhoneGeocoder(context);
    this.photos = new PhonePhotos(context, settings, this.geocoder);
    this.location = new PhoneLocation(context, settings, this.geocoder);
  }

  /** App 到前台、退到后台（Index.ets 的 onPageShow / onPageHide）：位置按它重新订 */
  setForeground(flag: boolean): void {
    this.location.setForeground(flag);
  }

  /** 拉起系统的选人界面（多选），交回挑的人：{"ok": true, "device", "contacts": [...]}；取消了 {"ok": false, "reason": "cancelled"} */
  async pickContacts(): Promise<string> {
    const result = new ContactsPickResult();
    try {
      const options: contact.ContactSelectionOptions = { isMultiSelect: true, maxSelectable: CONTACTS_MAX };
      const picked: contact.Contact[] = await contact.selectContacts(options);
      const contacts: PickedContact[] = [];
      for (const c of picked) {
        const one = new PickedContact();
        one.name = clean(c.name?.fullName);
        if (one.name === '') {
          continue;
        }
        for (const p of c.phoneNumbers ?? []) {
          const number = clean(p.phoneNumber);
          if (number !== '') {
            one.phones.push(number);
          }
        }
        const birthday = birthdayOf(c.events);
        if (birthday !== undefined) {
          one.birthday = birthday;
        }
        for (const a of c.postalAddresses ?? []) {
          const address = clean(a.postalAddress);
          if (address !== '') {
            one.addresses.push(address);
          }
        }
        contacts.push(one);
      }
      hilog.info(DOMAIN, TAG, 'contacts picked: %{public}d (with phone %{public}d, birthday %{public}d, address %{public}d)', contacts.length,
        contacts.filter((c: PickedContact) => c.phones.length > 0).length, contacts.filter((c: PickedContact) => c.birthday !== undefined).length,
        contacts.filter((c: PickedContact) => c.addresses.length > 0).length);
      if (contacts.length === 0) {
        result.reason = 'cancelled';
        return JSON.stringify(result);
      }
      result.ok = true;
      const device = deviceName();
      if (device !== '') {
        result.device = device;
      }
      result.contacts = contacts.slice(0, CONTACTS_MAX);
      return JSON.stringify(result);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'select contacts failed: %{public}s', JSON.stringify(e));
      result.reason = 'failed';
      result.message = t('harmony.phone.contactsFailed', { 'error': errorText(e as BusinessError) });
      return JSON.stringify(result);
    }
  }

  /** 读手机日历的授权给没给、问没问过：{"granted", "asked", "device"} */
  calendarState(): string {
    return JSON.stringify(this.state());
  }

  /** 要读日历的授权（系统的授权框）；userAction 为真而用户拒过（系统不再弹）时拉起二次授权。回之后的状态 */
  async prepareCalendar(userAction: boolean): Promise<string> {
    if (this.granted()) {
      return JSON.stringify(this.state());
    }
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const asked = await atManager.requestPermissionsFromUser(this.context, [READ_CALENDAR]);
      this.settings.setCalendarAsked();
      const granted = asked.authResults.length > 0 && asked.authResults[0] === 0;
      const shownList = asked.dialogShownResults;
      const shown = shownList === undefined || shownList.length === 0 || shownList[0];
      if (!granted && userAction && !shown) {
        await atManager.requestPermissionOnSetting(this.context, [READ_CALENDAR]);
      }
      hilog.info(DOMAIN, TAG, 'calendar permission: %{public}s', this.granted() ? 'granted' : 'not granted');
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'request calendar permission failed: %{public}s', JSON.stringify(e));
    }
    return JSON.stringify(this.state());
  }

  /**
   * 只读 [from, to)（毫秒，字符串）里的日程，重复的展开成每一次：{"ok": true, "events": [...]}；
   * 没授权 {"ok": false, "state": "denied"}，读不了 {"ok": false, "state": "unavailable", "message"}
   */
  async readCalendar(fromMs: string, toMs: string): Promise<string> {
    const result = new CalendarReadResult();
    const from = Number(fromMs);
    const to = Number(toMs);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      result.state = 'unavailable';
      result.message = t('harmony.phone.badRange');
      return JSON.stringify(result);
    }
    if (!this.granted()) {
      result.state = 'denied';
      return JSON.stringify(result);
    }
    try {
      const manager = calendarManager.getCalendarManager(this.context);
      const calendars: calendarManager.Calendar[] = await manager.getAllCalendars();
      const events: PhoneEvent[] = [];
      for (const cal of calendars) {
        const account = cal.getAccount();
        const calendarName = clean(account.displayName) !== '' ? clean(account.displayName) : clean(account.name);
        const instances: calendarManager.Event[] = await cal.queryEventInstances(from, to);
        for (const e of instances) {
          if (events.length >= EVENTS_MAX) {
            break;
          }
          const instanceStart = e.instanceStartTime ?? e.startTime;
          const instanceEnd = e.instanceEndTime ?? e.endTime;
          const allDay = e.isAllDay === true;
          // 全天的系统按 UTC 零点存，换成本机那一天的零点；编号照旧用系统给的这一次的开始（以前交过的不算新的）
          const start = allDay ? localDayStart(instanceStart) : instanceStart;
          const end = allDay && typeof instanceEnd === 'number' ? localDayStart(instanceEnd) : instanceEnd;
          const one = new PhoneEvent();
          one.key = `${account.name}:${e.id ?? e.identifier ?? ''}@${instanceStart}`;
          one.title = clean(e.title);
          one.start = start;
          if (typeof end === 'number' && end >= start) {
            one.end = end;
          }
          one.allDay = allDay;
          const location = clean(e.location?.location);
          if (location !== '') {
            one.location = location;
          }
          if (calendarName !== '') {
            one.calendar = calendarName;
          }
          events.push(one);
        }
      }
      hilog.info(DOMAIN, TAG, 'calendar read: %{public}d calendars, %{public}d events', calendars.length, events.length);
      result.ok = true;
      result.events = events;
      return JSON.stringify(result);
    } catch (e) {
      const err = e as BusinessError;
      hilog.error(DOMAIN, TAG, 'read calendar failed: %{public}s', JSON.stringify(e));
      // 201：权限没了（读到一半被撤回）
      result.state = err.code === 201 ? 'denied' : 'unavailable';
      result.message = t('harmony.phone.calendarFailed', { 'error': errorText(err) });
      return JSON.stringify(result);
    }
  }

  private state(): CalendarStateResult {
    const state = new CalendarStateResult();
    state.granted = this.granted();
    state.asked = this.settings.calendarAsked();
    const device = deviceName();
    if (device !== '') {
      state.device = device;
    }
    return state;
  }

  private granted(): boolean {
    return permissionGranted(READ_CALENDAR);
  }
}
