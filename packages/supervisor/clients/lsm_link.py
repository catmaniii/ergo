"""
本地服务管理器 · 接入层客户端（Python）
协议：docs/link-protocol.md v1

── 铁律 ──────────────────────────────────────────────────────────────
没有 LSM_* 环境变量、连不上、协议不匹配 —— 一律静默降级为「不接入」，
服务照常独立运行。接入层**绝不能**成为你的启动依赖，否则没人敢接入。
本模块任何路径都不会向调用方抛异常。
─────────────────────────────────────────────────────────────────────

依赖：websockets。装不上就自动降级为不接入。

用法（在服务启动完成、开始监听之后）：

    from lsm_link import link

    lsm = link(
        port=8080,
        version=__version__,
        logs=["logs"],
        # 「现在中断会造成损失吗」——由你定义。管理器据此提供「等空闲再停」。
        busy=lambda: (True, f"{n} 个任务进行中") if n else (False, None),
        health=lambda: "ok",
        # 有它才会声明 stop 能力；没有就别传，管理器会如实在 WebUI 上灰显。
        on_shutdown=my_graceful_shutdown,   # 可以是同步或 async
    )
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import threading
import time
from typing import Any, Callable, Optional

PROTOCOL = 1
RECONNECT_MIN = 1.0
RECONNECT_MAX = 30.0
HEARTBEAT_S = 5.0


class _Link:
    def __init__(self, url, service_id, token, opts):
        self.url, self.service_id, self.token, self.o = url, service_id, token, opts
        self.enabled = True
        self._closed = False
        self._ws = None
        self._pending_idle = None
        self._loop = None
        self._thread = None

    # ---- 由调用方定义的两个「领域知识」入口，任何异常都不许冒出去 ----
    def _busy(self):
        try:
            b = self.o.get("busy")
            if not b:
                return False, None
            v = b()
            if isinstance(v, tuple):
                return bool(v[0]), (v[1] if len(v) > 1 else None)
            if isinstance(v, dict):
                return bool(v.get("busy")), v.get("reason")
            return bool(v), None
        except Exception:
            return False, None

    def _health(self):
        try:
            h = self.o.get("health")
            return (h() if h else "ok") or "ok"
        except Exception:
            return "degraded"

    def _log(self, msg):
        try:
            (self.o.get("log") or (lambda m: print(f"[lsm] {m}", file=sys.stderr)))(msg)
        except Exception:
            pass

    def _capabilities(self):
        caps = ["busy"]
        if self.o.get("on_shutdown"):
            caps += ["stop", "restart"]
        if self.o.get("health"):
            caps.append("health")
        return caps

    async def _send(self, msg):
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.send(json.dumps(msg, ensure_ascii=False))

    async def _shutdown(self):
        cb = self.o.get("on_shutdown")
        if cb:
            try:
                r = cb()
                if asyncio.iscoroutine(r):
                    await r
            except Exception as e:  # 停机回调出错也要把 bye 发出去，别让管理器空等
                self._log(f"on_shutdown 出错：{e}")
        await self._send({"type": "bye", "reason": "shutdown-complete"})
        await asyncio.sleep(0.2)
        os._exit(0)

    async def _handle(self, msg):
        t = msg.get("type")
        if t == "conflict":
            # 同一个 serviceId 已有活跃会话 = 你被重复启动了。立刻退，别抢端口。
            self._log(f"管理器拒绝接入：{msg.get('reason')}。本实例退出，避免抢占端口。")
            self._closed = True
            os._exit(1)
        elif t == "ping":
            await self._send({"type": "ack", "id": msg.get("id"), "ok": True})
        elif t == "cancel":
            # 撤销挂起的「等空闲再停」——管理器取消了，服务这边也必须撤
            if self._pending_idle:
                self._log("挂起的停机已取消")
            self._pending_idle = None
            await self._send({"type": "ack", "id": msg.get("id"), "ok": True})
        elif t in ("stop", "restart"):
            if not self.o.get("on_shutdown"):
                await self._send({"type": "ack", "id": msg.get("id"), "ok": False, "error": "本服务未实现停机回调"})
                return
            busy, reason = self._busy()
            if msg.get("mode") == "when-idle" and busy:
                await self._send({"type": "ack", "id": msg.get("id"), "ok": True})
                self._log(f"收到「等空闲再停」，当前忙碌：{reason or '未说明'}——挂起等待")
                self._pending_idle = msg
                return
            await self._send({"type": "ack", "id": msg.get("id"), "ok": True})
            await self._shutdown()

    async def _session(self, connect):
        async with connect(self.url, additional_headers={"Authorization": f"Bearer {self.token}"}) as ws:
            self._ws = ws
            await self._send({
                "type": "hello", "serviceId": self.service_id, "protocol": PROTOCOL,
                "pid": os.getpid(), "port": self.o.get("port"),
                "version": self.o.get("version", ""), "capabilities": self._capabilities(),
                "logs": self.o.get("logs", []),
            })
            self._log(f"已接入管理器（{self.service_id}）")

            async def beat():
                while not self._closed:
                    busy, reason = self._busy()
                    await self._send({
                        "type": "heartbeat", "ts": int(time.time() * 1000),
                        "health": self._health(), "busy": busy, "busyReason": reason,
                    })
                    if self._pending_idle and not busy:
                        self._pending_idle = None
                        await self._shutdown()
                    await asyncio.sleep(HEARTBEAT_S)

            task = asyncio.ensure_future(beat())
            try:
                async for raw in ws:
                    with contextlib.suppress(Exception):
                        await self._handle(json.loads(raw))
            finally:
                task.cancel()
                self._ws = None

    async def _run(self):
        try:
            from websockets.asyncio.client import connect          # websockets >= 12
        except Exception:
            try:
                from websockets.client import connect              # 老版本
            except Exception:
                self._log("没装 websockets，不接入（服务照常运行）")
                return
        backoff = RECONNECT_MIN
        while not self._closed:
            try:
                await self._session(connect)
                backoff = RECONNECT_MIN
            except Exception:
                pass                                               # 铁律：连不上就是不接入
            if self._closed:
                break
            await asyncio.sleep(backoff)                           # 管理器重启时自己爬回来
            backoff = min(backoff * 2, RECONNECT_MAX)

    def start(self):
        def runner():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            with contextlib.suppress(Exception):
                self._loop.run_until_complete(self._run())

        # 独立线程 + 独立事件循环：不去碰宿主服务自己的循环（宿主多半有自己的一套）
        self._thread = threading.Thread(target=runner, name="lsm-link", daemon=True)
        self._thread.start()
        return self

    def close(self):
        self._closed = True


class _Noop:
    enabled = False
    service_id = None

    def close(self):
        pass


def link(**opts) -> Any:
    """没有身份注入就返回一个什么都不做的对象——调用方不需要写任何 if。"""
    url = os.environ.get("LSM_URL")
    sid = os.environ.get("LSM_SERVICE_ID")
    token = os.environ.get("LSM_TOKEN")
    proto = os.environ.get("LSM_PROTOCOL")
    if not (url and sid and token) or proto != str(PROTOCOL):
        return _Noop()
    return _Link(url, sid, token, opts).start()
