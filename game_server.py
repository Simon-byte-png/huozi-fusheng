#!/usr/bin/env python3
"""狂草猜猜猜 —— 实时草书识字竞技游戏后端。

复用怀素《大草千字文》真迹字模：出示草书字，四选一猜楷书。
- 固定题库（启动时用定种子生成，一次性下发，客户端预加载图片+本地判题，零延迟）
- 双人实时竞赛（快速匹配 / 房间码 / bot 兜底；客户端上报进度，服务端中转）
- 单人闯关升段；结算汇总评语（mimo 或本地池）+ 逐题字源溯源
纯标准库，内存态，HTTP 轮询同步。
"""
import json
import mimetypes
import os
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GLYPHS = json.loads((ROOT / "data" / "glyphs.json").read_text(encoding="utf-8"))["glyphs"]
# 题目池：真帖清晰字（非合成、非损毁）
TARGET_POOL = [c for c, v in GLYPHS.items() if not v.get("synthetic") and not v.get("unrecoverable")]

RANKS = ["识草小白", "识草学徒", "临帖秀才", "草书举人", "狂草高手", "怀素门生", "草圣传人"]

# ---------- 固定题库（定种子，写死；每次启动一致） ----------
BANK_SIZE = 160
def build_bank():
    rng = random.Random(20260716)
    chars = list(TARGET_POOL)
    rng.shuffle(chars)
    bank = []
    used = 0
    for ch in chars:
        if used >= BANK_SIZE:
            break
        g = GLYPHS[ch]
        pool = [c for c in TARGET_POOL if c != ch]
        distractors = rng.sample(pool, 3)
        options = [ch] + distractors
        rng.shuffle(options)
        bank.append({
            "qid": "q%03d" % used,
            "char": ch,
            "image": g["image"],
            "options": options,
            "answer": ch,
            "correctIndex": options.index(ch),
            "page": g.get("pageNumber"),
            "x": g.get("x"),
            "y": g.get("y"),
        })
        used += 1
    return bank

BANK = build_bank()
BANK_BY_QID = {q["qid"]: q for q in BANK}

# ---------- 全局状态 ----------
LOCK = threading.RLock()
QUEUE = []          # 快速匹配等待的 pid
ROOMS = {}          # roomId -> room
PLAYERS = {}        # pid -> {name, roomId}
CODES = {}          # code -> roomId

ROAST_TIERS = [
    # (最低正确率, 评语池)
    (0.95, ["满堂彩！这一纸狂草在你眼里如同楷书，草圣传人稳了。",
             "看穿了怀素的每一笔，这眼力该去博物馆坐镇。"]),
    (0.75, ["八九不离十，怀素的狂草也拦不住你几眼。",
             "好手感，再练两局就能跟草圣掰手腕了。"]),
    (0.5, ["一半靠眼力一半靠缘分，草书的门你已经推开一条缝。",
            "中规中矩，狂草认到这份上，朋友圈够炫了。"]),
    (0.25, ["狂草确实狂，你被甩了几条街，但比多数人强。",
             "别灰心，怀素当年也是从看不懂开始的。"]),
    (0.0, ["这一局怀素赢麻了，回去多临几张帖再来。",
            "四个选项像四道谜，你猜得比抛硬币还随缘。"]),
]


def now_ms():
    return int(time.time() * 1000)


def score_for(correct, time_ms, combo):
    if not correct:
        return 0
    return 100 + max(0, int(120 - time_ms / 40)) + min(combo, 8) * 25


# ---------- 房间 ----------
def new_room():
    rid = uuid.uuid4().hex[:10]
    qids = [q["qid"] for q in random.sample(BANK, 10)]
    room = {"id": rid, "qids": qids, "players": {}, "order": [],
            "state": "waiting", "startAt": None, "createdAt": now_ms(), "code": None}
    ROOMS[rid] = room
    return room


def add_player(room, name, is_bot=False):
    pid = ("bot_" if is_bot else "p_") + uuid.uuid4().hex[:10]
    p = {"pid": pid, "name": name, "score": 0, "progress": 0, "done": False, "isBot": is_bot}
    if is_bot:
        p["botAcc"] = 0.6
        p["botInterval"] = random.randint(2600, 4400)
        p["botSeed"] = random.random()
    room["players"][pid] = p
    room["order"].append(pid)
    if not is_bot:
        PLAYERS[pid] = {"name": name, "roomId": room["id"]}
    return pid


def start_room(room):
    room["state"] = "playing"
    room["startAt"] = now_ms() + 3200


def bot_tick(room, p):
    if room["startAt"] is None:
        return
    elapsed = now_ms() - room["startAt"]
    if elapsed <= 0:
        return
    n = len(room["qids"])
    prog = min(n, int(elapsed // p["botInterval"]))
    if prog <= p["progress"]:
        return
    rng = random.Random(int(p["botSeed"] * 1e9) + p["progress"])
    for _ in range(p["progress"], prog):
        if rng.random() < p["botAcc"]:
            p["score"] += score_for(True, rng.randint(1200, 3200), 0) + 40
    p["progress"] = prog
    if prog >= n:
        p["done"] = True


def room_view(room, pid):
    for p in room["players"].values():
        if p["isBot"]:
            bot_tick(room, p)
    if room["state"] == "playing" and room["players"] and all(p["done"] for p in room["players"].values()):
        room["state"] = "finished"
    me = room["players"].get(pid)
    opp = next((p for q, p in room["players"].items() if q != pid), None)
    winner = None
    if room["state"] == "finished":
        ranked = sorted(room["players"].values(), key=lambda x: -x["score"])
        if len(ranked) >= 2 and ranked[0]["score"] == ranked[1]["score"]:
            winner = "tie"
        elif ranked:
            winner = ranked[0]["pid"]
    return {
        "state": room["state"], "startAt": room["startAt"], "count": len(room["qids"]),
        "qids": room["qids"] if room["state"] != "waiting" else [],
        "me": None if not me else {"score": me["score"], "progress": me["progress"], "done": me["done"]},
        "opp": None if not opp else {"name": opp["name"], "score": opp["score"],
                                     "progress": opp["progress"], "done": opp["done"], "isBot": opp["isBot"]},
        "winner": winner,
    }


def cleanup():
    cut = now_ms() - 20 * 60 * 1000
    for rid in list(ROOMS):
        if ROOMS[rid]["createdAt"] < cut:
            r = ROOMS.pop(rid)
            if r.get("code"):
                CODES.pop(r["code"], None)


def mimo_summary(correct, total, best_combo, mode, win):
    key = os.environ.get("MIMO_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    base = os.environ.get("MIMO_BASE_URL") or os.environ.get("ANTHROPIC_BASE_URL") or "https://token-plan-cn.xiaomimimo.com/anthropic"
    model = os.environ.get("MIMO_MODEL", "mimo-v2.5")
    if not key:
        raise RuntimeError("no key")
    ctx = "双人对战" + ("获胜" if win else "落败") if mode == "versus" else "单人闯关"
    prompt = (
        "你是懂书法又毒舌的解说。用简体中文，为一局『怀素狂草识字』游戏写一句结算总评。"
        f"成绩：{ctx}，答对 {correct}/{total}，最高连击 {best_combo}。"
        "要求：一句话，40字以内，先夸或损，再点一句和怀素狂草有关的小结，别编史实。"
    )
    body = {"model": model, "max_tokens": 200, "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(base.rstrip("/") + "/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"},
        method="POST")
    with urllib.request.urlopen(req, timeout=18) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    parts = [it["text"] for it in data.get("content", []) if it.get("type") == "text" and it.get("text")]
    return " ".join(parts).strip()


def local_summary(correct, total):
    acc = correct / total if total else 0
    for thr, pool in ROAST_TIERS:
        if acc >= thr:
            return random.choice(pool)
    return random.choice(ROAST_TIERS[-1][1])


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length", "0") or "0")
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception:
            return {}

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        b = self._body()
        try:
            if path == "/api/summary":
                return self._summary(b)
            if path == "/api/mp/quick":
                return self._mp_quick(b)
            if path == "/api/mp/bot":
                return self._mp_bot(b)
            if path == "/api/mp/create":
                return self._mp_create(b)
            if path == "/api/mp/join":
                return self._mp_join(b)
            if path == "/api/mp/report":
                return self._mp_report(b)
            if path == "/api/mp/leave":
                return self._mp_leave(b)
            return self._json(404, {"error": "not found"})
        except Exception as exc:
            return self._json(500, {"error": str(exc)})

    def _summary(self, b):
        correct = int(b.get("correct", 0))
        total = int(b.get("total", 0)) or 1
        best = int(b.get("bestCombo", 0))
        mode = str(b.get("mode", "solo"))
        win = bool(b.get("win"))
        try:
            t = mimo_summary(correct, total, best, mode, win)
            if t:
                return self._json(200, {"text": t, "source": "mimo"})
        except Exception:
            pass
        return self._json(200, {"text": local_summary(correct, total), "source": "local"})

    def _mp_quick(self, b):
        name = str(b.get("name", "无名剑客"))[:16] or "无名剑客"
        with LOCK:
            cleanup()
            while QUEUE:
                other = QUEUE.pop(0)
                info = PLAYERS.get(other)
                room = ROOMS.get(info["roomId"]) if info and info.get("roomId") else None
                if room and room["state"] == "waiting" and len(room["players"]) == 1:
                    pid = add_player(room, name)
                    start_room(room)
                    return self._json(200, {"pid": pid, "roomId": room["id"], "matched": True})
            room = new_room()
            pid = add_player(room, name)
            QUEUE.append(pid)
            return self._json(200, {"pid": pid, "roomId": room["id"], "matched": False})

    def _mp_bot(self, b):
        pid = str(b.get("pid", ""))
        with LOCK:
            if pid in QUEUE:
                QUEUE.remove(pid)
            info = PLAYERS.get(pid)
            room = ROOMS.get(info["roomId"]) if info and info.get("roomId") else None
            if not room:
                return self._json(400, {"error": "会话失效"})
            if len(room["players"]) < 2:
                add_player(room, random.choice(["墨小侠", "临池客", "狂草生", "笔痴生", "砚台君"]), is_bot=True)
            if room["state"] == "waiting":
                start_room(room)
            return self._json(200, {"roomId": room["id"], "matched": True})

    def _mp_create(self, b):
        name = str(b.get("name", "房主"))[:16] or "房主"
        with LOCK:
            cleanup()
            room = new_room()
            code = "".join(random.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(4))
            room["code"] = code
            CODES[code] = room["id"]
            pid = add_player(room, name)
            return self._json(200, {"pid": pid, "roomId": room["id"], "code": code})

    def _mp_join(self, b):
        name = str(b.get("name", "挑战者"))[:16] or "挑战者"
        code = str(b.get("code", "")).upper().strip()
        with LOCK:
            rid = CODES.get(code)
            room = ROOMS.get(rid) if rid else None
            if not room:
                return self._json(404, {"error": "房间不存在或已过期"})
            if len(room["players"]) >= 2:
                return self._json(400, {"error": "房间已满"})
            pid = add_player(room, name)
            start_room(room)
            return self._json(200, {"pid": pid, "roomId": room["id"]})

    def _mp_report(self, b):
        rid = str(b.get("roomId", ""))
        pid = str(b.get("pid", ""))
        with LOCK:
            room = ROOMS.get(rid)
            if not room or pid not in room["players"]:
                return self._json(400, {"error": "房间失效"})
            p = room["players"][pid]
            p["score"] = max(p["score"], int(b.get("score", p["score"])))
            p["progress"] = max(p["progress"], int(b.get("progress", p["progress"])))
            if b.get("done"):
                p["done"] = True
            return self._json(200, {"ok": True})

    def _mp_leave(self, b):
        pid = str(b.get("pid", ""))
        with LOCK:
            if pid in QUEUE:
                QUEUE.remove(pid)
        return self._json(200, {"ok": True})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        qs = {}
        if "?" in self.path:
            for kv in self.path.split("?", 1)[1].split("&"):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    qs[k] = urllib.parse.unquote(v)
        if path == "/health":
            return self._json(200, {"ok": True, "bank": len(BANK)})
        if path == "/api/bank":
            return self._json(200, {"bank": BANK, "ranks": RANKS})
        if path == "/api/mp/status":
            pid = qs.get("pid", "")
            with LOCK:
                info = PLAYERS.get(pid)
                room = ROOMS.get(info["roomId"]) if info and info.get("roomId") else None
                matched = bool(room and len(room["players"]) >= 2 and room["state"] != "waiting")
                return self._json(200, {"matched": matched, "roomId": room["id"] if room else None})
        if path == "/api/mp/room":
            with LOCK:
                room = ROOMS.get(qs.get("roomId", ""))
                if not room:
                    return self._json(404, {"error": "房间不存在"})
                return self._json(200, room_view(room, qs.get("pid", "")))
        return self._serve_static(path)

    def _serve_static(self, path):
        if path == "/":
            path = "/game.html"
        rel = path.lstrip("/")
        if rel.startswith((".git", ".zaocode", ".env", "tools/")) or rel.endswith((".py", ".md")):
            rel = "game.html"
        target = (ROOT / rel).resolve()
        if not str(target).startswith(str(ROOT.resolve())) or not target.exists() or target.is_dir():
            target = ROOT / "game.html"
        data = target.read_bytes()
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix == ".js":
            ctype = "application/javascript"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400" if rel.startswith("assets/") else "no-cache")
        self.end_headers()
        self.wfile.write(data)


def load_dotenv():
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


if __name__ == "__main__":
    load_dotenv()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    print(f"狂草猜猜猜 on {host}:{port}  固定题库 {len(BANK)} 题")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
