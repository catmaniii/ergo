import { url } from '@kit.ArkTS';
import { t } from './AppTexts';

/**
 * 用户配好的二狗地址（62 号票）。App 只加载它；原生桥、麦克风只对它的来源开放。
 * 地址存在应用本地（AppSettings），不写进仓库、不写死在代码里。
 */
export class ServerAddress {
  /** WebView 加载的地址（去掉了 # 后面的部分） */
  readonly href: string;
  /** 来源：scheme://host[:port]，原生桥、麦克风、页面跳转都按它核对 */
  readonly origin: string;
  /** https，或本机调试时的 http */
  readonly scheme: string;
  /** 主机名，不带端口 */
  readonly host: string;
  /** 写了端口才有（默认端口是空的） */
  readonly port: string;

  constructor(href: string, origin: string, scheme: string, host: string, port: string) {
    this.href = href;
    this.origin = origin;
    this.scheme = scheme;
    this.host = host;
    this.port = port;
  }
}

/** 校验结果：address 和 error 二选一 */
export class AddressCheck {
  address: ServerAddress | undefined = undefined;
  error: string = '';
}

/** 为了本机调试，这两个主机可以用 http */
const LOCAL_HOSTS: string[] = ['127.0.0.1', 'localhost'];

function failed(error: string): AddressCheck {
  const check = new AddressCheck();
  check.error = error;
  return check;
}

/** 拆开网址；不是 http、https 或写法不对返回 undefined */
function parseWeb(text: string): url.URL | undefined {
  let parsed: url.URL;
  try {
    parsed = url.URL.parseURL(text);
  } catch (e) {
    return undefined;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'https:' && scheme !== 'http:') {
    return undefined;
  }
  return parsed;
}

function originOfParsed(parsed: url.URL): string {
  const scheme = parsed.protocol.toLowerCase().replace(':', '');
  const host = parsed.hostname.toLowerCase();
  return parsed.port.length > 0 ? `${scheme}://${host}:${parsed.port}` : `${scheme}://${host}`;
}

/** 任意网址的来源（scheme://host[:port]）；不是 http、https 或解析不了返回空串 */
export function originOf(href: string): string {
  const parsed = parseWeb(href);
  return parsed === undefined ? '' : originOfParsed(parsed);
}

/**
 * 用户填的地址：必须是 https；本机调试时 http://127.0.0.1、http://localhost 例外（端口随意）。
 * 没写 scheme 的按 https 补上。地址里不能带用户名密码。
 */
export function checkServerAddress(input: string): AddressCheck {
  const text = input.trim();
  if (text.length === 0) {
    return failed(t('harmony.address.empty'));
  }
  const withScheme = text.includes('://') ? text : `https://${text}`;
  const parsed = parseWeb(withScheme);
  if (parsed === undefined) {
    return failed(t('harmony.address.malformed'));
  }
  const scheme = parsed.protocol.toLowerCase().replace(':', '');
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) {
    return failed(t('harmony.address.noHost'));
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return failed(t('harmony.address.credentials'));
  }
  if (scheme === 'http' && !LOCAL_HOSTS.includes(host)) {
    return failed(t('harmony.address.httpsOnly'));
  }
  parsed.hash = '';
  const check = new AddressCheck();
  check.address = new ServerAddress(parsed.href, originOfParsed(parsed), scheme, host, parsed.port);
  return check;
}
