package com.catmaniii.ergo.common

import java.io.FileNotFoundException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * 扫码之后测连不连得上（364 号票，对应鸿蒙 common/ConnectCheck.ets）：这个文件只有判断，不碰网络、不碰界面的字，好在 JVM 上测；
 * 两边的判断结果和文案键一模一样，frontend/test/connect.test.ts 和 ConnectCheckTest 拿同一份例子（frontend/test/connect-vectors.tsv）核对。
 */

/** 连不上的原因：键是 harmony.connect.reason.<key> */
enum class ConnectFailure(val key: String) {
    DNS("dns"),
    TIMEOUT("timeout"),
    CERT("cert"),
    REFUSED("refused"),
    NOT_ERGO("notErgo"),
    OTHER("other"),
}

/** 请求抛的异常归到哪一种 */
fun classifyConnectFailure(error: Throwable): ConnectFailure {
    var cause: Throwable? = error
    while (cause != null) {
        when (cause) {
            is UnknownHostException -> return ConnectFailure.DNS
            is SocketTimeoutException -> return ConnectFailure.TIMEOUT
            is SSLException -> return ConnectFailure.CERT
            is ConnectException, is NoRouteToHostException, is SocketException -> return ConnectFailure.REFUSED
            is FileNotFoundException -> return ConnectFailure.NOT_ERGO
        }
        cause = cause.cause
    }
    return ConnectFailure.OTHER
}

/** 二狗回"我有没有被信任"的样子（gateway.ts 的 /api/access，两个端口都有、不需要凭证）：{ "access": "none" | "device" | "local", ... } */
private val ERGO_ACCESS = Regex("^\\s*\\{.*\"access\"\\s*:\\s*\"(none|device|local)\".*\\}\\s*$", RegexOption.DOT_MATCHES_ALL)

/** 对面是不是二狗：200 且回的是这个样子。别的网站（网页、404、跳到登录页）都不是 */
fun isErgoAccess(status: Int, body: String): Boolean = status == 200 && ERGO_ACCESS.matches(body)

/** 看得出是 tailnet 的主机：.ts.net、带 tail / tailnet / headscale 这段的域名（服务管家的 tailnet 入口常这么起名）、100.64.0.0/10 的地址 */
fun isTailnetHost(host: String): Boolean {
    val name = host.lowercase()
    if (name.endsWith(".ts.net") || name.endsWith(".tailscale.net")) return true
    val v4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.\\d{1,3}\\.\\d{1,3}$").matchEntire(name)
    if (v4 != null) {
        val second = v4.groupValues[2].toInt()
        return v4.groupValues[1] == "100" && second in 64..127
    }
    return name.split('.').dropLast(2).any { it == "tail" || it == "tailnet" || it == "headscale" }
}

/** 提醒检查什么，先后按这个地址最可能的原因：看得出是 tailnet 的把 tailnet 那条排最前。键是 harmony.connect.check.<key> */
fun connectChecklist(host: String): List<String> =
    if (isTailnetHost(host)) listOf("tailnet", "computer", "remote") else listOf("computer", "remote", "tailnet")
