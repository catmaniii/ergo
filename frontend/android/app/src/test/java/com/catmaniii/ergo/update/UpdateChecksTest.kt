package com.catmaniii.ergo.update

import android.content.pm.PackageInstaller
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateChecksTest {
    private val installed = PackageFacts("com.catmaniii.ergo", 1002, setOf("aa"))

    @Test
    fun `包名一样、版本更高、签名一样的能装`() {
        assertNull(archiveProblem(PackageFacts("com.catmaniii.ergo", 1003, setOf("aa")), installed))
    }

    @Test
    fun `读不出来、包名不一样的不是二狗的包`() {
        assertEquals(UpdateFailure.PACKAGE, archiveProblem(null, installed))
        assertEquals(UpdateFailure.PACKAGE, archiveProblem(PackageFacts("com.example.other", 2000, setOf("aa")), installed))
    }

    @Test
    fun `版本号不比装着的高不装`() {
        assertEquals(UpdateFailure.VERSION, archiveProblem(PackageFacts("com.catmaniii.ergo", 1002, setOf("aa")), installed))
        assertEquals(UpdateFailure.VERSION, archiveProblem(PackageFacts("com.catmaniii.ergo", 1001, setOf("aa")), installed))
    }

    @Test
    fun `签名不一样、读不出签名的不装`() {
        assertEquals(UpdateFailure.SIGNATURE, archiveProblem(PackageFacts("com.catmaniii.ergo", 1003, setOf("bb")), installed))
        assertEquals(UpdateFailure.SIGNATURE, archiveProblem(PackageFacts("com.catmaniii.ergo", 1003, emptySet()), installed))
        assertEquals(UpdateFailure.SIGNATURE, archiveProblem(PackageFacts("com.catmaniii.ergo", 1003, setOf("aa", "bb")), installed))
    }

    @Test
    fun `校验值大小写不论，期望的写法不对算不对`() {
        val sha = "ab".repeat(32)
        assertTrue(sameSha256(sha.uppercase(), sha))
        assertFalse(sameSha256(sha, "cd".repeat(32)))
        assertFalse(sameSha256("", ""))
        assertFalse(sameSha256("xyz", "xyz"))
    }

    @Test
    fun `证书的 SHA-256 是小写十六进制`() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", certDigest(ByteArray(0)))
        assertEquals("00ff10", hexOf(byteArrayOf(0, -1, 16)))
    }

    @Test
    fun `系统的结果码对到页面上的原因`() {
        assertEquals(UpdateFailure.CANCELLED, failureOfStatus(InstallStatus.FAILURE_ABORTED))
        assertEquals(UpdateFailure.STORAGE, failureOfStatus(InstallStatus.FAILURE_STORAGE))
        assertEquals(UpdateFailure.PACKAGE, failureOfStatus(InstallStatus.FAILURE_INVALID))
        assertEquals(UpdateFailure.SIGNATURE, failureOfStatus(InstallStatus.FAILURE_CONFLICT))
        assertEquals(UpdateFailure.FAILED, failureOfStatus(InstallStatus.FAILURE_BLOCKED))
        assertEquals(UpdateFailure.FAILED, failureOfStatus(InstallStatus.FAILURE))
    }

    @Test
    fun `结果码和系统的一样`() {
        // 系统的这几个是编译期常量，JVM 单测里也拿得到
        assertEquals(PackageInstaller.STATUS_PENDING_USER_ACTION, InstallStatus.PENDING_USER_ACTION)
        assertEquals(PackageInstaller.STATUS_SUCCESS, InstallStatus.SUCCESS)
        assertEquals(PackageInstaller.STATUS_FAILURE, InstallStatus.FAILURE)
        assertEquals(PackageInstaller.STATUS_FAILURE_BLOCKED, InstallStatus.FAILURE_BLOCKED)
        assertEquals(PackageInstaller.STATUS_FAILURE_ABORTED, InstallStatus.FAILURE_ABORTED)
        assertEquals(PackageInstaller.STATUS_FAILURE_INVALID, InstallStatus.FAILURE_INVALID)
        assertEquals(PackageInstaller.STATUS_FAILURE_CONFLICT, InstallStatus.FAILURE_CONFLICT)
        assertEquals(PackageInstaller.STATUS_FAILURE_STORAGE, InstallStatus.FAILURE_STORAGE)
        assertEquals(PackageInstaller.STATUS_FAILURE_INCOMPATIBLE, InstallStatus.FAILURE_INCOMPATIBLE)
        assertEquals(PackageInstaller.STATUS_FAILURE_TIMEOUT, InstallStatus.FAILURE_TIMEOUT)
    }

    @Test
    fun `下载进度`() {
        assertEquals(0, percentOf(0, 100))
        assertEquals(37, percentOf(370, 1000))
        assertEquals(100, percentOf(2000, 1000))
        assertNull(percentOf(10, 0))
    }

    @Test
    fun `空间不够认得出来`() {
        assertTrue(isNoSpace("write failed: ENOSPC (No space left on device)"))
        assertFalse(isNoSpace("HTTP 500"))
        assertFalse(isNoSpace(null))
    }

    @Test
    fun `只从配好的二狗来源下载`() {
        assertTrue(updateUrlAllowed("https://ergo.example.com/api/app-update/android.apk", "https://ergo.example.com"))
        assertFalse(updateUrlAllowed("https://evil.example.com/api/app-update/android.apk", "https://ergo.example.com"))
        assertFalse(updateUrlAllowed("https://ergo.example.com/api/app-update/android.apk", ""))
        assertFalse(updateUrlAllowed("file:///sdcard/x.apk", "https://ergo.example.com"))
    }
}
