# 二狗的语音识别进程（31 号票）：守护进程按需拉起，用 faster-whisper 识别语音消息的录音。
# 守护进程那一侧见 recognizer.ts。两边走 stdin / stdout 的 JSON 行，一次处理一条：
#   守护进程 → 这里：{"type": "init", "primary": {...}, "fallback": {...} | null}（拉起后第一行）
#                     {"id": 1, "type": "load"}（45 号票：紧接着设置，让它加载模型）
#                     {"id": 2, "type": "transcribe", "path": "...", "language": "zh", "initialPrompt": "..."}
#                     {"type": "exit"}
#   这里 → 守护进程：{"id": 1, "result": {"model", "device", "computeType", "loadMs", "fallbackReason"?}}（加载好了）
#                     {"id": 2, "result": {"text", "language", "segments", "duration", "model", "device", "computeType", "fallbackReason"?}}
#                     {"id": 2, "error": "...", "fatal": true?}（fatal：模型没加载起来，这个进程不能再用；加载出错一律是 fatal）
# - 守护进程拉起后马上让它加载模型（预热，45 号票），之后一直留在内存里（守护进程默认让它常驻；配了闲置退出的，闲置后让它退出）；
#   没收到"加载"就来了识别的，识别时再加载；
# - 先用 primary（默认显卡上的 large-v3、int8_float16）；显卡不可用、加载失败（比如显存不够），或者识别时显卡出错，
#   退回 fallback（默认 CPU 上的 small），结果里记下实际用的和退回的原因；
# - 模型从 Hugging Face 的本机缓存加载，守护进程设了 HF_HUB_OFFLINE=1：不联网下载；
# - stdout 只留给协议：库打到 stdout 上的东西（包括 C 扩展直接写文件描述符 1 的）一律改到 stderr；
# - Windows 上 ctranslate2 要靠 CUDA_PATH 才找得到 cuBLAS（PATH 里有 CUDA 的 bin 目录也不够），而守护进程
#   按白名单传环境变量、不带 CUDA_PATH：开头从 PATH 里找放 cublas64_*.dll 的 bin 目录，推出 CUDA_PATH。
#
# 250 号票：同一条脚本也是 LSM 托管的那条服务（`python -s recognizer.py --serve --port 8091`，见
# deploy/lsm/ergo-asr.example.yaml）。不带参数时照旧是 stdin / stdout 那套（守护进程自己拉起的那条路、测试、手工调试，
# 一行都不变）；带了 --serve 就只听 127.0.0.1、不带 token（和 audio.cpp 一样），接口：
#   GET  /health        → 模型状态 {"ok", "loaded", "model", "device", "computeType", "loadMs"?, "fallbackReason"?, "error"?}
#                         模型没加载好 ok / loaded 都是 false，不 5xx（LSM 的探活得答得上、208 号票也得看得懂）；
#                         加载失败（fatal 的那种）写在 error 里。加载着时不带 error，ok 是 false
#   GET  /v1/models     → 同一份模型状态（给人和调试看；二狗这一侧不用它）
#   POST /v1/warmup     → 开始加载模型，异步，马上回上面那份状态（已经在加载、已经加载好就马上回；失败过的再试一次）。
#                         正文可以带和 stdio 那行 init 一样的 {"primary": {...}, "fallback": {...} | null}：
#                         所以两种接法用哪个模型还是守护进程的配置说了算；不带就用下面的默认值
#   POST /v1/transcribe → 正文 {"audio": "<base64 的录音>", "language"?, "initialPrompt"?}（字段名和 stdio 那套一样，
#                         audio 是那段录音本身：webm / ogg / wav 都行，按内容认格式，语音不超过 60 秒）；
#                         回 {"text", "language", "segments", "duration", "model", "device", "computeType", "fallbackReason"?}，
#                         出错回 {"error": "...", "fatal"?: true}（文字沿用 stdio 那套；fatal 是模型加载不了，
#                         服务本身还在，下次预热还能再试）
# 请求和应答的字段、错误码的文字都沿用 stdio 那套，怎么变成给用户看的话是 TypeScript 那边的事（recognizer-client.ts）。
# 加载和识别各一把锁，一次一件（和 stdio 一次处理一条一样）；/health 只读状态、不排队，所以探活不会被识别挡住。
import argparse
import base64
import glob
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 协议用的输出：先复制一份原来的 stdout，再把文件描述符 1 指到 stderr
_protocol = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
os.dup2(2, 1)
sys.stdout = sys.stderr


def reply(message):
    _protocol.write(json.dumps(message, ensure_ascii=True) + "\n")
    _protocol.flush()


def log(text):
    sys.stderr.write(text + "\n")
    sys.stderr.flush()


def ensure_cuda_path():
    """没有 CUDA_PATH 时，从 PATH 里放着 cuBLAS 的 bin 目录推出来（只在 Windows 上）"""
    if sys.platform != "win32" or os.environ.get("CUDA_PATH"):
        return
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        folder = os.path.normpath(entry) if entry else ""
        if folder and os.path.basename(folder).lower() == "bin" and glob.glob(os.path.join(folder, "cublas64_*.dll")):
            os.environ["CUDA_PATH"] = os.path.dirname(folder)
            log("从 PATH 推出 CUDA_PATH=%s" % os.environ["CUDA_PATH"])
            return


class Engine:
    """加载好的模型和它用的设置（primary 或 fallback）"""

    def __init__(self, init):
        self.primary = init.get("primary")
        self.fallback = init.get("fallback")
        self.model = None
        self.spec = None
        self.fallback_reason = None
        # 加载模型用了多久（毫秒；先试显卡、退回 CPU 的，连试的时间一起算）
        self.load_ms = None

    def _load(self, spec):
        from faster_whisper import WhisperModel  # 用到时才导入：没装时报"加载失败"而不是起不来

        started = time.time()
        model = WhisperModel(spec["model"], device=spec["device"], compute_type=spec["computeType"])
        log("加载 %s（%s，%s）用了 %.1f 秒" % (spec["model"], spec["device"], spec["computeType"], time.time() - started))
        return model

    def _cuda_unavailable(self, spec):
        """要用显卡、但没有能用的显卡时给出原因"""
        if spec["device"] not in ("cuda", "auto"):
            return None
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() == 0:
                return "没有可用的显卡"
        except Exception as err:  # noqa: BLE001
            return "查不了显卡：%s" % err
        return None

    def ensure(self):
        if self.model is not None:
            return
        started = time.time()
        try:
            self._ensure()
        finally:
            if self.model is not None:
                self.load_ms = int(round((time.time() - started) * 1000))

    def _ensure(self):
        reason = self._cuda_unavailable(self.primary)
        if reason is None:
            try:
                self.model = self._load(self.primary)
                self.spec = self.primary
                return
            except Exception as err:  # noqa: BLE001
                reason = "%s 加载失败：%s" % (self.primary["model"], err)
                if self.fallback is None:
                    raise
        if self.fallback is None:
            raise RuntimeError(reason)
        log("退回 %s（%s）：%s" % (self.fallback["model"], self.fallback["device"], reason))
        self.use_fallback(reason)

    def use_fallback(self, reason):
        self.model = None
        self.model = self._load(self.fallback)
        self.spec = self.fallback
        self.fallback_reason = reason

    def loaded(self):
        """加载好的模型：用的模型、设备、计算精度、加载耗时、退回的原因"""
        return {
            "model": self.spec["model"],
            "device": self.spec["device"],
            "computeType": self.spec["computeType"],
            "loadMs": self.load_ms or 0,
            **({"fallbackReason": self.fallback_reason} if self.fallback_reason else {}),
        }

    def transcribe(self, request):
        kwargs = {
            "beam_size": 5,
            # 静音段先切掉：短语音里的静音最容易让 Whisper 编出"谢谢观看"之类的话
            "vad_filter": True,
            "condition_on_previous_text": False,
        }
        if request.get("language"):
            kwargs["language"] = request["language"]
        if request.get("initialPrompt"):
            kwargs["initial_prompt"] = request["initialPrompt"]
        segments, info = self.model.transcribe(request["path"], **kwargs)
        # segments 是生成器：真正的识别在遍历时做
        parts = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
        return {
            "text": "".join(p["text"] for p in parts).strip() if (info.language or "").startswith("zh") else " ".join(p["text"] for p in parts).strip(),
            "language": info.language or "",
            "segments": parts,
            "duration": round(float(info.duration or 0), 2),
            "model": self.spec["model"],
            "device": self.spec["device"],
            "computeType": self.spec["computeType"],
            **({"fallbackReason": self.fallback_reason} if self.fallback_reason else {}),
        }


def ensure_loaded(engine, request):
    """确保模型加载好；加载失败是致命的：回一条 fatal 的错误，返回 False（之后这个进程退出）"""
    error = load_error(engine)
    if error is None:
        return True
    reply({"id": request["id"], "error": error, "fatal": True})
    return False


def load_error(engine):
    """确保模型加载好；加载不了时给原因（致命：这个进程不能再用），好了给 None"""
    try:
        engine.ensure()
    except Exception as err:  # noqa: BLE001
        return "模型加载失败：%s" % err
    return None


def transcribe_error(engine, request):
    """识别一段：返回 (result, error)。显卡上出错（比如显存不够）就退回 CPU 再识别一次"""
    try:
        return engine.transcribe(request), None
    except Exception as err:  # noqa: BLE001
        if engine.spec is engine.primary and engine.fallback is not None and engine.primary["device"] != engine.fallback["device"]:
            reason = "用 %s 识别时出错：%s" % (engine.primary["device"], err)
            log("退回 %s（%s）：%s" % (engine.fallback["model"], engine.fallback["device"], reason))
            try:
                engine.use_fallback(reason)
                return engine.transcribe(request), None
            except Exception as again:  # noqa: BLE001
                return None, "识别出错：%s" % again
        return None, "识别出错：%s" % err


def handle_load(engine, request):
    """加载模型（预热）：加载好了回报用的哪个"""
    if not ensure_loaded(engine, request):
        return False
    reply({"id": request["id"], "result": engine.loaded()})
    return True


def handle(engine, request):
    if not ensure_loaded(engine, request):
        return False
    result, error = transcribe_error(engine, request)
    if error is not None:
        reply({"id": request["id"], "error": error})
        return True
    reply({"id": request["id"], "result": result})
    return True


def run_stdio():
    """不带参数时的那条路（守护进程自己拉起）：stdin / stdout 的 JSON 行，一次一条"""
    ensure_cuda_path()
    engine = None
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8").strip()
        if not line:
            continue
        message = json.loads(line)
        kind = message.get("type")
        if kind == "init":
            engine = Engine(message)
        elif kind in ("load", "transcribe"):
            if engine is None:
                reply({"id": message["id"], "error": "还没收到设置", "fatal": True})
                return
            if not (handle_load if kind == "load" else handle)(engine, message):
                return
        elif kind == "exit":
            return


# ───────────── --serve：LSM 托管的那条（250 号票） ─────────────

DEFAULT_SERVE_PORT = 8091

# 不带设置手动跑（curl 试试）时用这套：和守护进程配置里的默认值一样（显卡上的 large-v3、退回 CPU 的 small）。
# 正式跑的时候守护进程会在 /v1/warmup 里带上配置，以它为准
DEFAULT_INIT = {
    "primary": {"device": "cuda", "model": "large-v3", "computeType": "int8_float16"},
    "fallback": {"device": "cpu", "model": "small", "computeType": "int8"},
}


class Service:
    """一条服务的一生：一份模型状态、一次加载、一次一条识别（和 stdio 那条一次处理一条一样）。

    模型加载放在后台线程里做（一次 44–58 秒，不能让 /v1/warmup 挂住）；/health 和 /v1/models 只读状态、不排队，
    所以 LSM 的探活、208 号票问"还正不正常"一句都答得上，不会被一次识别挡在后面。
    """

    def __init__(self):
        self._init = DEFAULT_INIT
        self._engine = None
        self._work_lock = threading.Lock()  # 识别一次一条
        self._load_lock = threading.Lock()  # 加载一次一次：识别也要经由它确认模型好了
        self._loading = False
        self._error = None

    def configure(self, body):
        """第一次收到设置时建引擎：字段和 stdio 那行 init 一样（primary、fallback；fallback 写 null 就是不退回）。
        之后再来的设置不改（要换就重启服务，LSM 会这么做）"""
        if not isinstance(body, dict):
            return
        primary = body.get("primary")
        fallback = body.get("fallback", DEFAULT_INIT["fallback"])
        init = {
            "primary": primary if isinstance(primary, dict) else DEFAULT_INIT["primary"],
            "fallback": fallback if fallback is None or isinstance(fallback, dict) else DEFAULT_INIT["fallback"],
        }
        with self._load_lock:
            if self._engine is not None:
                return
            self._init = init
            self._engine = Engine(init)

    def status(self):
        """模型现在怎么样：/health、/v1/models、/v1/warmup 回的是同一份"""
        engine = self._engine
        loaded = engine is not None and engine.model is not None
        spec = engine.spec if loaded else self._init["primary"]
        status = {
            "ok": loaded and self._error is None,
            "loaded": loaded,
            "model": spec["model"],
            "device": spec["device"],
            "computeType": spec["computeType"],
        }
        if loaded:
            info = engine.loaded()
            status["loadMs"] = info["loadMs"]
            if info.get("fallbackReason"):
                status["fallbackReason"] = info["fallbackReason"]
        if self._error:
            status["error"] = self._error
        return status

    def warmup(self, body):
        """开始加载模型（异步），马上回状态：已在加载、已加载好不再重复；加载失败过的重新试一次
        （LSM 里的服务是常驻的，显存腾出来以后不该一直坏着）"""
        self.configure(body)
        with self._load_lock:
            if self._engine.model is not None:
                return self.status()
            if not self._loading:
                self._error = None
                self._loading = True
                threading.Thread(target=self._load, name="ergo-asr-warmup", daemon=True).start()
        return self.status()

    def _load(self):
        try:
            with self._load_lock:
                self._engine.ensure()
        except Exception as err:  # noqa: BLE001
            self._error = "模型加载失败：%s" % err
            log(self._error)
        finally:
            self._loading = False

    def transcribe(self, request):
        """识别一段：先把模型弄好（没加载过的在这里加载），再一次识别一条。返回 (result, error, fatal)"""
        with self._work_lock:
            if self._engine is None:
                self.configure({})
            try:
                with self._load_lock:
                    self._engine.ensure()
            except Exception as err:  # noqa: BLE001
                self._error = "模型加载失败：%s" % err
                log(self._error)
                return None, self._error, True
            self._error = None
            result, error = transcribe_error(self._engine, request)
            return result, error, False


def audio_file(request):
    """请求里的录音（base64，webm / ogg / wav 都行）落到临时文件：faster-whisper 按文件内容认格式、按文件读"""
    raw = request.get("audio")
    if not isinstance(raw, str) or not raw:
        raise ValueError("audio 要给 base64 编好的录音")
    data = base64.b64decode(raw)
    fd, path = tempfile.mkstemp(prefix="ergo-asr-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
    except Exception:
        os.unlink(path)
        raise
    return path


def serve_transcribe(service, request):
    """一段识别：返回 (HTTP 状态码, 应答)。错误文字沿用 stdio 那套，fatal 的是模型加载不了（503）"""
    try:
        path = audio_file(request)
    except Exception as err:  # noqa: BLE001
        return 400, {"error": "识别出错：%s" % err}
    try:
        # 交给 engine 的请求和 stdio 那套一样，只是 path 换成解出来的临时文件（language、initialPrompt 原样）
        result, error, fatal = service.transcribe(dict(request, path=path))
    finally:
        os.unlink(path)
    if error is not None:
        return (503 if fatal else 500), {"error": error, **({"fatal": True} if fatal else {})}
    return 200, result


def serve(port):
    """只听 127.0.0.1（和 audio.cpp 一样不带 token）：LSM 按 /health 探活、管它的生死，空闲时卸载模型也是它自己的事"""
    ensure_cuda_path()
    service = Service()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            log("%s %s" % (self.address_string(), fmt % args))

        def _reply(self, status, payload):
            body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            """请求的正文（JSON 对象）；没给是 None，写坏了抛 ValueError"""
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            if not raw:
                return None
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except Exception as err:  # noqa: BLE001
                raise ValueError("正文不是 JSON：%s" % err)
            return parsed if isinstance(parsed, dict) else None

        def do_GET(self):
            if self.path in ("/health", "/v1/models"):
                self._reply(200, service.status())
            else:
                self._reply(404, {"error": "不认得这个地址：%s" % self.path})

        def do_POST(self):
            if self.path not in ("/v1/warmup", "/v1/transcribe"):
                self._reply(404, {"error": "不认得这个地址：%s" % self.path})
                return
            try:
                body = self._body()
            except ValueError as err:
                self._reply(400, {"error": str(err)})
                return
            if self.path == "/v1/warmup":
                self._reply(200, service.warmup(body or {}))
                return
            if body is None:
                self._reply(400, {"error": "没有 audio（base64 编好的录音）"})
                return
            status, payload = serve_transcribe(service, body)
            self._reply(status, payload)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    log("语音识别服务在 http://127.0.0.1:%s（/health、/v1/warmup、/v1/transcribe、/v1/models）" % server.server_address[1])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main(argv):
    if "--serve" in argv:
        parser = argparse.ArgumentParser(description="二狗的语音识别服务（--serve）；不带参数时是 stdin / stdout 的识别进程")
        parser.add_argument("--serve", action="store_true", help="开 HTTP 服务（LSM 托管的那条）")
        parser.add_argument("--port", type=int, default=DEFAULT_SERVE_PORT, help="端口（默认 %d，只绑 127.0.0.1；0 是系统挑一个）" % DEFAULT_SERVE_PORT)
        args = parser.parse_args(argv)
        serve(args.port)
        return
    if argv:
        # 不认识的参数宁可报错，也不要悄悄退回 stdin / stdout：守护进程会一直等不到应答
        log("不认得的参数：%s（不带参数是 stdio 的识别进程，--serve 是 HTTP 服务）" % " ".join(argv))
        sys.exit(2)
    run_stdio()


if __name__ == "__main__":
    main(sys.argv[1:])
