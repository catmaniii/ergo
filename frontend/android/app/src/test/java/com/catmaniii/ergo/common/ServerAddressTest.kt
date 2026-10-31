package com.catmaniii.ergo.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 二狗地址的规矩和鸿蒙 common/ServerAddress.ets 一样：原生桥的白名单就是这里算出来的来源，算错了是安全问题 */
class ServerAddressTest {
    private fun errorOf(input: String) = checkServerAddress(input).errorKey

    @Test
    fun httpsAddressKeepsPathAndDropsHash() {
        val address = checkServerAddress("https://ergo.example.com/a/b?x=1#/inbox").address!!
        assertEquals("https://ergo.example.com/a/b?x=1", address.href)
        assertEquals("https://ergo.example.com", address.origin)
        assertEquals("https", address.scheme)
        assertEquals("ergo.example.com", address.host)
        assertEquals("", address.port)
    }

    @Test
    fun missingSchemeBecomesHttps() {
        assertEquals("https://ergo.example.com/", checkServerAddress("  ergo.example.com ").address!!.href)
    }

    @Test
    fun hostIsLowercasedAndDefaultPortDropped() {
        assertEquals("https://ergo.example.com", checkServerAddress("HTTPS://ERGO.Example.com:443/").address!!.origin)
        assertEquals("https://ergo.example.com:8443", checkServerAddress("https://ergo.example.com:8443").address!!.origin)
    }

    @Test
    fun onlyLocalHostsMayUseHttp() {
        assertEquals("http://127.0.0.1:8810", checkServerAddress("http://127.0.0.1:8810").address!!.origin)
        assertEquals("http://localhost:8810", checkServerAddress("http://localhost:8810/").address!!.origin)
        assertEquals("harmony.address.httpsOnly", errorOf("http://example.com"))
        assertEquals("harmony.address.httpsOnly", errorOf("http://10.0.2.2:8810"))
        // 看着像本机、其实是别的主机
        assertEquals("harmony.address.httpsOnly", errorOf("http://127.0.0.1.evil.example/"))
        assertEquals("harmony.address.httpsOnly", errorOf("http://localhost.evil.example/"))
    }

    @Test
    fun rejectsBadInput() {
        assertEquals("harmony.address.empty", errorOf("   "))
        assertEquals("harmony.address.malformed", errorOf("ftp://example.com"))
        assertEquals("harmony.address.malformed", errorOf("https://exa mple.com"))
        assertEquals("harmony.address.malformed", errorOf("https://example.com:99999"))
        assertEquals("harmony.address.malformed", errorOf("https://example.com:port"))
        assertEquals("harmony.address.noHost", errorOf("https:///path"))
        assertEquals("harmony.address.credentials", errorOf("https://user:pass@example.com"))
    }

    /** 网址里藏主机名的写法：反斜杠、@。来源要和浏览器算的一样，不能被骗成二狗的来源 */
    @Test
    fun trickyUrlsDoNotBecomeTheServerOrigin() {
        val server = "https://ergo.example.com"
        assertEquals("", originOf("https://evil.example\\@ergo.example.com/"))
        assertEquals("https://evil.example", originOf("https://ergo.example.com@evil.example/"))
        assertFalse(originOf("https://ergo.example.com.evil.example/") == server)
        assertFalse(originOf("https://ergo.example.com:444/") == server)
        assertFalse(originOf("http://ergo.example.com/") == server)
        assertEquals(server, originOf("https://ergo.example.com/#/inbox"))
    }

    @Test
    fun originOfAndIsWebUrl() {
        assertEquals("", originOf("about:blank"))
        assertEquals("", originOf("javascript:alert(1)"))
        assertEquals("", originOf("data:text/html,x"))
        assertEquals("", originOf("file:///etc/hosts"))
        assertEquals("http://[::1]:8810", originOf("http://[::1]:8810/"))
        assertEquals("https://my_host.example", originOf("https://my_host.example/"))
        assertTrue(isWebUrl("https://example.com"))
        assertFalse(isWebUrl("mailto:a@example.com"))
        assertNull(checkServerAddress("about:blank").address)
    }

    @Test
    fun withoutHashDropsTheFragmentOnly() {
        assertEquals("https://a.example/x?y=1", withoutHash("https://a.example/x?y=1#/z"))
        assertEquals("https://a.example/", withoutHash("https://a.example/"))
    }
}
