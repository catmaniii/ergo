import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { AppSettings, DOMAIN, TAG } from './AppSettings';

/**
 * App 原生的字（175 号票）：地址页、出错页、"这不是二狗？"、下载和保存的提示、系统通知的默认标题、交回网页的原因（录音、"浏览"的 ⋮ 菜单、
 * 交文件、渲染文件）。句子不写在 .ets 里，都在共享协议包的 locales/<语言>/harmony.json（key 是 harmony.*）：
 * - npm run build:harmony 把自带的每种语言的 harmony.json 收进 rawfile/harmony-texts.json（{ 语言代码: { key: 句子 } }，不进仓库），
 *   App 起来时读一次（EntryAbility.onCreate）；
 * - 连上之后二狗的网页经原生桥 setTexts 交来当前语言的这几句（网页按二狗的全局语言 t() 取好，~/.ergo/locales 里加的语言、改的译法也在里面），
 *   换语言时再交；交来了就用交来的，并记在 App 的偏好里（用户 2026-10-19 定：记住上次的语言）。App 重开时先用记下的那份，
 *   地址页、出错页一开场就是二狗的语言；从没交来过（第一次装、还没连上过二狗）用英文（用户定：没选过默认英文），没打包英文才用中文；
 * - 找不到的句子依次退到自带的同一种语言、自带的中文，都没有回 key 本身（没跑 npm run build:harmony 打包时）。
 * 插值 {name}；App 里的句子不分单复数（英文写成不用单复数的说法），句子里有数字的照原样插进去。
 */

/** 打包进 App 的自带语言（npm run build:harmony 生成） */
const BUNDLED_FILE = 'harmony-texts.json';
/** 缺句子时退到的语言 */
const DEFAULT_LANGUAGE = 'zh-CN';
/** 从没连上过二狗时用的语言（用户 2026-10-19 定：没选过默认英文） */
const FIRST_LANGUAGE = 'en';
/** 网页交来的：只收 harmony.* 的 key，一句最长、一共最多几句（网页是可信的，这里只防写错） */
const KEY_PREFIX = 'harmony.';
const TEXT_MAX = 1000;
const TEXTS_MAX = 500;

/** 网页经原生桥 setTexts 交来的（JSON） */
interface TextsMessage {
  /** 二狗现在用的语言代码（zh-CN、en、用户加的……） */
  language?: string;
  /** key → 当前语言的句子 */
  texts?: Record<string, string>;
}

/** 不带参数（ArkTS 的对象字面量不能对着可选的联合类型写，参数写成 Record<string, string>，数字自己 String() 一下） */
const NO_PARAMS: Record<string, string> = {};

/** {name} 换成参数；没给的参数原样留着 */
function fill(text: string, params: Record<string, string>): string {
  let out = text;
  for (const name of Object.keys(params)) {
    out = out.split(`{${name}}`).join(params[name]);
  }
  return out;
}

/** 网页交来的一份（或记下的那份）认不认得：认得就回语言代码和只留 harmony.* 的句子，认不得回 undefined */
function parseTexts(json: string): TextsMessage | undefined {
  let message: TextsMessage;
  try {
    message = JSON.parse(json) as TextsMessage;
  } catch (e) {
    return undefined;
  }
  if (message === null || typeof message !== 'object' || typeof message.language !== 'string' || message.language.length === 0 ||
    message.texts === undefined || message.texts === null || typeof message.texts !== 'object') {
    return undefined;
  }
  const texts = message.texts;
  const kept: Record<string, string> = {};
  for (const key of Object.keys(texts).slice(0, TEXTS_MAX)) {
    const text = texts[key];
    if (key.startsWith(KEY_PREFIX) && typeof text === 'string' && text.length > 0) {
      kept[key] = text.substring(0, TEXT_MAX);
    }
  }
  const parsed: TextsMessage = { language: message.language, texts: kept };
  return parsed;
}

/** Record 换成 Map */
function mapOf(texts: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const key of Object.keys(texts)) {
    map.set(key, texts[key]);
  }
  return map;
}

class AppTexts {
  /** 自带的几种语言：语言代码 → (key → 句子) */
  private bundled: Map<string, Map<string, string>> = new Map<string, Map<string, string>>();
  /** 现在用的语言：开场按系统语言挑的，网页交来之后是二狗的语言 */
  private language: string = DEFAULT_LANGUAGE;
  /** 网页交来的；还没交来是空的 */
  private fromWeb: Map<string, string> = new Map<string, string>();
  /** 换了字（网页交来了不一样的）时通知（Index.ets 让原生的几页重画） */
  private listener: (() => void) | undefined = undefined;
  /** 记住上次网页交来的那份（App 的偏好）；load 之前没有 */
  private settings: AppSettings | undefined = undefined;

  /** App 起来时读 rawfile 里的自带语言；记得上次网页交来的就用它，没有就用英文 */
  load(context: common.Context): void {
    try {
      const bytes = context.resourceManager.getRawFileContentSync(BUNDLED_FILE);
      const all = JSON.parse(util.TextDecoder.create('utf-8').decodeToString(bytes)) as Record<string, Record<string, string>>;
      for (const language of Object.keys(all)) {
        const messages = all[language];
        const map = new Map<string, string>();
        for (const key of Object.keys(messages)) {
          const text = messages[key];
          if (typeof text === 'string') {
            map.set(key, text);
          }
        }
        this.bundled.set(language, map);
      }
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'app texts missing (run npm run build:harmony): %{public}s', JSON.stringify(e));
    }
    this.language = this.bundled.has(FIRST_LANGUAGE) ? FIRST_LANGUAGE : DEFAULT_LANGUAGE;
    try {
      this.settings = new AppSettings(context);
      const remembered = parseTexts(this.settings.appTexts());
      if (remembered !== undefined && remembered.language !== undefined && remembered.texts !== undefined) {
        this.language = remembered.language;
        this.fromWeb = mapOf(remembered.texts);
      }
    } catch (e) {
      hilog.warn(DOMAIN, TAG, 'read remembered app texts failed: %{public}s', JSON.stringify(e));
    }
    hilog.info(DOMAIN, TAG, 'app texts: %{public}d bundled languages, using %{public}s', this.bundled.size, this.language);
  }

  /** 取一句，{name} 换成参数 */
  get(key: string, params: Record<string, string>): string {
    const text = this.fromWeb.get(key) ?? this.bundled.get(this.language)?.get(key) ?? this.bundled.get(DEFAULT_LANGUAGE)?.get(key) ?? key;
    return fill(text, params);
  }

  /** 二狗的网页交来当前语言的这几句（原生桥 setTexts）：认得出来就整份换上（没交的那几句退回自带的），回 true */
  setFromWeb(json: string): boolean {
    const message = parseTexts(json);
    if (message === undefined || message.language === undefined || message.texts === undefined) {
      hilog.warn(DOMAIN, TAG, 'app texts from web ignored: bad shape');
      return false;
    }
    const next = mapOf(message.texts);
    const changed = message.language !== this.language || next.size !== this.fromWeb.size ||
      Array.from(next.keys()).some((key: string) => next.get(key) !== this.fromWeb.get(key));
    this.language = message.language;
    this.fromWeb = next;
    if (changed) {
      hilog.info(DOMAIN, TAG, 'app texts from web: %{public}s, %{public}d texts', this.language, next.size);
      // 记下来：App 重开时地址页、出错页一开场就是这种语言（只记收拾过的那份）
      this.settings?.setAppTexts(JSON.stringify(message));
      this.listener?.();
    }
    return true;
  }

  /** 换了字时调它（只有一个：Index.ets） */
  listen(listener: (() => void) | undefined): void {
    this.listener = listener;
  }
}

/** 整个 App 一份 */
export const appTexts: AppTexts = new AppTexts();

/** 取 App 原生的一句（key 是 harmony.*，句子在共享协议包的 locales/<语言>/harmony.json） */
export function t(key: string, params: Record<string, string> = NO_PARAMS): string {
  return appTexts.get(key, params);
}
