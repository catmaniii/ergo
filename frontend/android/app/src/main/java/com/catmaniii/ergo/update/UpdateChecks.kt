package com.catmaniii.ergo.update

import com.catmaniii.ergo.common.originOf
import java.security.MessageDigest

/**
 * 在 App 里更新 App（票 399）的判断，不碰系统：JVM 单测（app/src/test/.../update/UpdateChecksTest.kt）直接测。
 * 没装上的原因用这几个字（网页一侧 packages/web/src/app/native-app-update.ts 的 APP_UPDATE_FAILURES 认这些）。
 */
object UpdateFailure {
    const val NETWORK = "network"
    const val CHECKSUM = "checksum"
    const val PACKAGE = "package"
    const val VERSION = "version"
    const val SIGNATURE = "signature"
    const val CANCELLED = "cancelled"
    const val STORAGE = "storage"
    const val PERMISSION = "permission"
    const val BUSY = "busy"
    const val FAILED = "failed"
}

/** PackageInstaller 的结果码（系统的常量，写在这里 JVM 单测才用得上；值是安卓公开的，不会变） */
object InstallStatus {
    const val PENDING_USER_ACTION = -1
    const val SUCCESS = 0
    const val FAILURE = 1
    const val FAILURE_BLOCKED = 2
    const val FAILURE_ABORTED = 3
    const val FAILURE_INVALID = 4
    const val FAILURE_CONFLICT = 5
    const val FAILURE_STORAGE = 6
    const val FAILURE_INCOMPATIBLE = 7
    const val FAILURE_TIMEOUT = 8
}

/** 系统装失败的结果码对到页面上的原因：用户取消、空间不够、包不对、和装着的冲突（签名不一样）；别的看系统给的话 */
fun failureOfStatus(status: Int): String = when (status) {
    InstallStatus.FAILURE_ABORTED -> UpdateFailure.CANCELLED
    InstallStatus.FAILURE_STORAGE -> UpdateFailure.STORAGE
    InstallStatus.FAILURE_INVALID -> UpdateFailure.PACKAGE
    InstallStatus.FAILURE_CONFLICT -> UpdateFailure.SIGNATURE
    else -> UpdateFailure.FAILED
}

/** 一个包是什么：包名、versionCode、签名证书（每张证书的 SHA-256） */
data class PackageFacts(val packageName: String, val versionCode: Long, val signers: Set<String>)

/**
 * 下下来的安装包能不能装：读不出来、包名不一样是 package；versionCode 不比装着的高是 version；
 * 签名证书读不出来、和装着的不一样是 signature（系统也会拒，先拦下来说清楚）。能装回 null
 */
fun archiveProblem(archive: PackageFacts?, installed: PackageFacts): String? = when {
    archive == null || archive.packageName != installed.packageName -> UpdateFailure.PACKAGE
    archive.versionCode <= installed.versionCode -> UpdateFailure.VERSION
    archive.signers.isEmpty() || archive.signers != installed.signers -> UpdateFailure.SIGNATURE
    else -> null
}

/** 小写十六进制 */
fun hexOf(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

/** 一张证书（Signature.toByteArray()）的 SHA-256 */
fun certDigest(cert: ByteArray): String = hexOf(MessageDigest.getInstance("SHA-256").digest(cert))

/** 两个 SHA-256 是不是同一个：大小写不论；期望的不是 64 位十六进制算不对 */
fun sameSha256(expected: String, actual: String): Boolean =
    Regex("^[0-9a-fA-F]{64}$").matches(expected) && expected.equals(actual, ignoreCase = true)

/** 下载进度的百分比；不知道总长回 null */
fun percentOf(done: Long, total: Long): Int? = if (total <= 0) null else ((done.coerceAtLeast(0) * 100) / total).coerceIn(0, 100).toInt()

/** 写文件时的错是不是空间不够（ENOSPC） */
fun isNoSpace(message: String?): Boolean = message != null && (message.contains("ENOSPC") || message.contains("No space left", ignoreCase = true))

/** 下载的地址能不能用：只认配好的二狗来源（http、https），别的地址一律不下（设备凭证只给二狗） */
fun updateUrlAllowed(url: String, serverOrigin: String): Boolean =
    serverOrigin.isNotEmpty() && originOf(url) == serverOrigin
