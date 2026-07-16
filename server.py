#!/usr/bin/env python3
import json
import mimetypes
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
# 优先使用构建产物 dist/，否则直接以项目根目录作为静态根（部署时无需单独构建）
STATIC_ROOT = ROOT / "dist" if (ROOT / "dist" / "index.html").exists() else ROOT
# 禁止对外暴露的路径前缀与后缀
BLOCKED_PREFIXES = (".git", ".zaocode", ".env", "tools/", "server.py")
BLOCKED_SUFFIXES = (".py", ".md")


def load_dotenv():
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def mimo_explain(text, mode):
    key = os.environ.get("MIMO_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")
    base = os.environ.get("MIMO_BASE_URL") or os.environ.get("ANTHROPIC_BASE_URL") or "https://token-plan-cn.xiaomimimo.com/anthropic"
    model = os.environ.get("MIMO_MODEL", "mimo-v2.5")
    if not key:
        raise RuntimeError("服务端缺少 MIMO_API_KEY")

    prompt = (
        "你是书法展览策展人与中国书法老师。请用简体中文，围绕怀素《大草千字文》AI集字作品做讲解。"
        "要求：1）先讲这句话的审美气质；2）讲怀素狂草的笔势特点；3）讲AI集字和字源溯源的文化价值；"
        "4）给一个适合路演现场说的金句。控制在180字以内，不要编造具体不存在的历史事实。"
    )
    body = {
        "model": model,
        "max_tokens": 900,
        "messages": [
            {"role": "user", "content": f"{prompt}\n\n作品文字：{text}\n当前模式：{mode}"}
        ],
    }
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    parts = []
    for item in data.get("content", []):
        if item.get("type") == "text" and item.get("text"):
            parts.append(item["text"])
    return "\n".join(parts).strip() or "mimo-v2.5 已返回，但没有生成可展示文本。"


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path.rstrip("/") != "/api/explain":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            text = str(payload.get("text", ""))[:120]
            mode = str(payload.get("mode", "poster"))[:32]
            answer = mimo_explain(text, mode)
            self.send_json(200, {"answer": answer})
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "ignore")
            self.send_json(502, {"error": f"mimo API HTTP {exc.code}: {detail[:300]}"})
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self.send_json(200, {"ok": True})
            return
        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/")
        blocked = rel.startswith(BLOCKED_PREFIXES) or rel.endswith(BLOCKED_SUFFIXES)
        target = (STATIC_ROOT / rel).resolve()
        if (
            blocked
            or not str(target).startswith(str(STATIC_ROOT.resolve()))
            or not target.exists()
            or target.is_dir()
        ):
            target = STATIC_ROOT / "index.html"
        data = target.read_bytes()
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".js":
            ctype = "application/javascript"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    load_dotenv()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    ThreadingHTTPServer((host, port), Handler).serve_forever()
