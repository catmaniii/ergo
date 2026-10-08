# 二狗的语音识别进程（31 号票）：守护进程按需拉起，用 faster-whisper 识别语音消息的录音。
# 守护进程那一侧见 recognizer.ts。两边走 stdin / stdout 的 JSON 行，一次处理一条：
#   守护进程 → 这里：{"type": "init", "primary": {...}, "fallback": {...} | null}（拉起后第一行）
#                     {"id": 1, "type": "transcribe", "path": "...", "language": "zh", "initialPrompt": "..."}
#                     {"type": "exit"}
#   这里 → 守护进程：{"id": 1, "result": {"text", "language", "segments", "duration", "model", "device", "computeType", "fallbackReason"?}}
#                     {"id": 1, "error": "...", "fatal": true?}（fatal：模型没加载起来，这个进程不能再用）
# - 模型在第一次识别时加载（冷启动），之后一直留在内存里，直到守护进程因为闲置让这个进程退出；
# - 先用 primary（默认显卡上的 large-v3、int8_float16）；显卡不可用、加载失败（比如显存不够），或者识别时显卡出错，
#   退回 fallback（默认 CPU 上的 small），结果里记下实际用的和退回的原因；
# - 模型从 Hugging Face 的本机缓存加载，守护进程设了 HF_HUB_OFFLINE=1：不联网下载；
# - stdout 只留给协议：库打到 stdout 上的东西（包括 C 扩展直接写文件描述符 1 的）一律改到 stderr。
import json
import os
import sys
import time

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


class Engine:
    """加载好的模型和它用的设置（primary 或 fallback）"""

    def __init__(self, init):
        self.primary = init.get("primary")
        self.fallback = init.get("fallback")
        self.model = None
        self.spec = None
        self.fallback_reason = None

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


def handle(engine, request):
    try:
        engine.ensure()
    except Exception as err:  # noqa: BLE001
        reply({"id": request["id"], "error": "模型加载失败：%s" % err, "fatal": True})
        return False
    try:
        result = engine.transcribe(request)
    except Exception as err:  # noqa: BLE001
        # 显卡上出错（比如显存不够）：退回 CPU 再识别一次
        if engine.spec is engine.primary and engine.fallback is not None and engine.primary["device"] != engine.fallback["device"]:
            reason = "用 %s 识别时出错：%s" % (engine.primary["device"], err)
            log("退回 %s（%s）：%s" % (engine.fallback["model"], engine.fallback["device"], reason))
            try:
                engine.use_fallback(reason)
                result = engine.transcribe(request)
            except Exception as again:  # noqa: BLE001
                reply({"id": request["id"], "error": "识别出错：%s" % again})
                return True
        else:
            reply({"id": request["id"], "error": "识别出错：%s" % err})
            return True
    reply({"id": request["id"], "result": result})
    return True


def main():
    engine = None
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8").strip()
        if not line:
            continue
        message = json.loads(line)
        kind = message.get("type")
        if kind == "init":
            engine = Engine(message)
        elif kind == "transcribe":
            if engine is None:
                reply({"id": message["id"], "error": "还没收到设置", "fatal": True})
                return
            if not handle(engine, message):
                return
        elif kind == "exit":
            return


if __name__ == "__main__":
    main()
