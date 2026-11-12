package com.catmaniii.ergo.common

import java.net.IDN

/**
 * 用户配好的二狗地址（对应鸿蒙 common/ServerAddress.ets）。App 只加载它；原生桥、麦克风只对它的来源开放。
 * 地址存在应用本地（AppSettings），不写进仓库、不写死在代码里。
 */
data class ServerAddress(
    /** WebView 加载的地址（去掉了 # 后面的部分） */
    val href: String,
    /** 来源：scheme://host[:port]，原生桥、麦克风、页面跳转都按它核对 */
    val origin: String,
    /** https，或本机调试时的 http */
    val scheme: String,
    /** 主机名，不带端口 */
    val host: String,
    /** 写了端口才有（默认端口是空的） */
    val port: String,
)

/** 校验结果：address 和 error 二选一；error 是 harmony.address.* 的 key，这个文件不碰界面的字，好在 JVM 上测 */
data class AddressCheck(val address: ServerAddress? = null, val errorKey: String = "")

/** 为了本机调试，这两个主机可以用 http */
private val LOCAL_HOSTS = setOf("127.0.0.1", "localhost")

/** 拆开的网址 */
private class WebUrl(val scheme: String, val userInfo: String, val host: String, val port: String, val rest: String)

private val WEB_URL = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^#]*)(#.*)?$")
private val PORT = Regex("^[0-9]{1,5}$")
/** 主机名像样：字母数字、点、横线、下划线；IPv6 带方括号 */
private val HOST = Regex("^(\\[[0-9a-f:.]+]|[a-z0-9_.-]{1,253})$")

/** 拆开网址；不是 http、https 或写法不对返回 null。自己拆不用 java.net.URI：它不认带下划线的主机名，和 WebView 的说法对不上 */
private fun parseWeb(text: String): WebUrl? {
    if (text.any { it <= ' ' || it == '\\' }) return null
    val match = WEB_URL.matchEntire(text) ?: return null
    val scheme = match.groupValues[1].lowercase()
    if (scheme != "http" && scheme != "https") return null
    val authority = match.groupValues[2]
    val at = authority.lastIndexOf('@')
    val userInfo = if (at >= 0) authority.substring(0, at) else ""
    val hostPort = if (at >= 0) authority.substring(at + 1) else authority
    val colon = if (hostPort.startsWith("[")) hostPort.indexOf(':', hostPort.indexOf(']').coerceAtLeast(0)) else hostPort.lastIndexOf(':')
    val rawHost = if (colon >= 0) hostPort.substring(0, colon) else hostPort
    var port = if (colon >= 0) hostPort.substring(colon + 1) else ""
    if (port.isNotEmpty() && (!PORT.matches(port) || port.toInt() > 65535)) return null
    // 默认端口写了等于没写（和浏览器算来源一样）
    if ((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) port = ""
    val host = try {
        if (rawHost.startsWith("[")) rawHost.lowercase() else IDN.toASCII(rawHost, IDN.ALLOW_UNASSIGNED).lowercase()
    } catch (_: IllegalArgumentException) {
        return null
    }
    if (host.isNotEmpty() && !HOST.matches(host)) return null
    return WebUrl(scheme, userInfo, host, port, match.groupValues[3])
}

private fun originOfParsed(url: WebUrl): String =
    if (url.port.isNotEmpty()) "${url.scheme}://${url.host}:${url.port}" else "${url.scheme}://${url.host}"

/** 任意网址的来源（scheme://host[:port]）；不是 http、https 或解析不了返回空串 */
fun originOf(href: String): String {
    val parsed = parseWeb(href) ?: return ""
    return if (parsed.host.isEmpty()) "" else originOfParsed(parsed)
}

/** 只开 http、https（别的协议交给系统） */
fun isWebUrl(url: String): Boolean = originOf(url).isNotEmpty()

/** 能交给系统浏览器的地址（原生桥的 openSystemBrowser，票 386）：只收 https，要有主机名，不带用户名密码 */
fun isHttpsUrl(url: String): Boolean {
    val parsed = parseWeb(url) ?: return false
    return parsed.scheme == "https" && parsed.host.isNotEmpty() && parsed.userInfo.isEmpty()
}

/**
 * 用户填的地址：必须是 https；本机调试时 http://127.0.0.1、http://localhost 例外（端口随意）。
 * 没写 scheme 的按 https 补上。地址里不能带用户名密码。规矩和鸿蒙的 checkServerAddress 一字不差
 */
fun checkServerAddress(input: String): AddressCheck {
    val text = input.trim()
    if (text.isEmpty()) return AddressCheck(errorKey = "harmony.address.empty")
    val withScheme = if (text.contains("://")) text else "https://$text"
    val parsed = parseWeb(withScheme) ?: return AddressCheck(errorKey = "harmony.address.malformed")
    if (parsed.host.isEmpty()) return AddressCheck(errorKey = "harmony.address.noHost")
    if (parsed.userInfo.isNotEmpty()) return AddressCheck(errorKey = "harmony.address.credentials")
    if (parsed.scheme == "http" && parsed.host !in LOCAL_HOSTS) return AddressCheck(errorKey = "harmony.address.httpsOnly")
    val origin = originOfParsed(parsed)
    val rest = if (parsed.rest.isEmpty() || !parsed.rest.startsWith("/")) "/${parsed.rest}" else parsed.rest
    return AddressCheck(ServerAddress("$origin$rest", origin, parsed.scheme, parsed.host, parsed.port))
}

/** 去掉 # 后面的部分：单页应用换 # 地址不算换了文档 */
fun withoutHash(href: String): String {
    val at = href.indexOf('#')
    return if (at < 0) href else href.substring(0, at)
}
