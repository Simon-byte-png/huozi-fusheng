#!/usr/bin/env python3
"""狂草猜猜猜 —— 实时草书识字竞技游戏后端。

复用怀素《大草千字文》真迹字模：出示一个草书字，四选一猜楷书。
- 单人闯关升段
- 双人实时匹配竞赛（快速匹配 / 房间码 / bot 兜底）
- 字源溯源、mimo 毒舌评语（无 key 时用本地毒舌池）
纯标准库实现，内存态 + 惰性计算 bot 进度，HTTP 轮询同步。
"""
import json
import math
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

# ---------- 载入字库 ----------
GLYPHS = json.loads((ROOT / "data" / "glyphs.json").read_text(encoding="utf-8"))["glyphs"]
# 题目池：真帖清晰字（非合成、非损毁）
TARGET_POOL = [c for c, v in GLYPHS.items() if not v.get("synthetic") and not v.get("unrecoverable")]
# 干扰项池：同为真帖字，避免生僻
DISTRACT_POOL = list(TARGET_POOL)

RANKS = ["识草小白", "识草学徒", "临帖秀才", "草书举人", "狂草高手", "怀素门生", "草圣传人"]

# ---------- 全局状态 ----------
LOCK = threading.RLock()
ANSWER_KEY = {}      # qid -> 正确字
QUESTION_META = {}   # qid -> {image,page,x,y}
QUEUE = []           # 快速匹配等待的 pid
ROOMS = {}           # roomId -> room
PLAYERS = {}         # pid -> {name, roomId}
CODES = {}           # code -> roomId

ROAST_GOOD = [
    "眼力毒辣，怀素见了都要点头。",
    "这都认得出来？下一轮加大难度。",
    "手感在线，草圣传人预定。",
    "稳，稳得像一千年的墨。",
    "行家一出手，就知有没有。",
]
ROAST_BAD = [
    "这字虽狂，可没狂到让你瞎猜的地步。",
    "怀素落笔如飞，你落选也如飞。",
    "再看仔细点，别辜负了这一纸狂草。",
    "猜错不可怕，可怕的是猜得这么自信。",
    "别急，这只是你和草圣的第一道鸿沟。",
]


def make_question():
    target = random.choice(TARGET_POOL)
    g = GLYPHS[target]
    pool = [c for c in DISTRACT_POOL if c != target]
    distractors = random.sample(pool, 3)
    options = [target] + distractors
    random.shuffle(options)
    qid = uuid.uuid4().hex[:12]
    with LOCK:
        ANSWER_KEY[qid] = target
        QUESTION_META[qid] = {
            "image": g["image"],
            "page": g.get("pageNumber"),
            "x": g.get("x"),
            "y": g.get("y"),
        }
        # 控制内存
        if len(ANSWER_KEY) > 8000:
            for k in list(ANSWER_KEY)[:2000]:
                ANSWER_KEY.pop(k, None)
                QUESTION_META.pop(k, None)
    return {
        "qid": qid,
        "image": g["image"],
        "options": options,
        "page": g.get("pageNumber"),
        "x": g.get("x"),
        "y": g.get("y"),
    }


def score_for(correct, time_ms, combo):
    if not correct:
        return 0
    base = 100
    speed = max(0, int(120 - time_ms / 40))   # 越快加分越多，最多 +120
    combo_bonus = min(combo, 8) * 25
    return base + speed + combo_bonus


def now_ms():
    return int(time.time() * 1000)


def gen_questions(n):
    return [make_question() for _ in range(n)]


def public_question(q):
    return {k: q[k] for k in ("qid", "image", "options", "page", "x", "y")}


def new_room(mode, n=10):
    rid = uuid.uuid4().hex[:10]
    room = {
        "id": rid,
        "mode": mode,
        "questions": gen_questions(n),
        "players": {},          # pid -> player state
        "order": [],            # pid 顺序
        "state": "waiting",     # waiting | playing | finished
        "startAt": None,
        "createdAt": now_ms(),
        "code": None,
    }
    ROOMS[rid] = room
    return room


def add_player(room, name, is_bot=False):
    pid = ("bot_" if is_bot else "p_") + uuid.uuid4().hex[:10]
    p = {
        "pid": pid,
        "name": name,
        "score": 0,
        "combo": 0,
        "progress": 0,       # 已答题数
        "answered": {},      # qid -> choice
        "done": False,
        "isBot": is_bot,
    }
    if is_bot:
        p["botAcc"] = 0.62
        p["botInterval"] = random.randint(2600, 4200)
        p["botSeed"] = random.random()
    room["players"][pid] = p
    room["order"].append(pid)
    if not is_bot:
        PLAYERS[pid] = {"name": name, "roomId": room["id"]}
    return pid


def start_room(room):
    room["state"] = "playing"
    room["startAt"] = now_ms() + 3200   # 3 秒倒计时


def bot_state(room, p):
    """惰性根据经过时间计算 bot 的进度与分数（无需后台线程）。"""
    if room["startAt"] is None:
        return
    elapsed = now_ms() - room["startAt"]
    if elapsed <= 0:
        return
    n = len(room["questions"])
    prog = min(n, int(elapsed // p["botInterval"]))
    if prog <= p["progress"]:
        return
    rng = random.Random(hash((p["botSeed"], p["progress"])) & 0xffffffff)
    for i in range(p["progress"], prog):
        correct = rng.random() < p["botAcc"]
        if correct:
            p["combo"] += 1
            p["score"] += score_for(True, rng.randint(1200, 3200), p["combo"])
        else:
            p["combo"] = 0
    p["progress"] = prog
    if prog >= n:
        p["done"] = True


def room_view(room, pid):
    # 结算 bot
    for q_pid, p in room["players"].items():
        if p["isBot"]:
            bot_state(room, p)
    if room["state"] == "playing" and all(p["done"] for p in room["players"].values()):
        room["state"] = "finished"
    me = room["players"].get(pid)
    opp = None
    for q_pid, p in room["players"].items():
        if q_pid != pid:
            opp = p
            break
    winner = None
    if room["state"] == "finished":
        ranked = sorted(room["players"].values(), key=lambda x: -x["score"])
        if len(ranked) >= 2 and ranked[0]["score"] == ranked[1]["score"]:
            winner = "tie"
        elif ranked:
            winner = ranked[0]["pid"]
    return {
        "state": room["state"],
        "startAt": room["startAt"],
        "count": len(room["questions"]),
        "questions": [public_question(q) for q in room["questions"]] if room["state"] != "waiting" else [],
        "me": None if not me else {"score": me["score"], "combo": me["combo"], "progress": me["progress"], "done": me["done"]},
        "opp": None if not opp else {
            "name": opp["name"], "score": opp["score"], "progress": opp["progress"],
            "done": opp["done"], "isBot": opp["isBot"],
        },
        "winner": winner,
    }


def cleanup():
    cut = now_ms() - 20 * 60 * 1000
    for rid in list(ROOMS):
        if ROOMS[rid]["createdAt"] < cut:
            r = ROOMS.pop(rid)
            if r.get("code"):
                CODES.pop(r["code"], None)


def mimo_roast(char, correct, streak, mode):
    key = os.environ.get("MIMO_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    base = os.environ.get("MIMO_BASE_URL") or os.environ.get("ANTHROPIC_BASE_URL") or "https://token-plan-cn.xiaomimimo.com/anthropic"
    model = os.environ.get("MIMO_MODEL", "mimo-v2.5")
    if not key:
        raise RuntimeError("no key")
    verdict = "猜对了" if correct else "猜错了"
    prompt = (
        "你是懂书法又毒舌的解说。用简体中文，针对怀素《大草千字文》里的草书字给玩家一句点评。"
        f"这个字是「{char}」，玩家{verdict}，当前连击 {streak}。"
        "要求：先一句极简草法/字形特点（20字内），再一句毒舌但不低俗的评语（30字内）。共两短句，别超过60字，不要编造史实。"
    )
    body = {"model": model, "max_tokens": 400, "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    parts = [it["text"] for it in data.get("content", []) if it.get("type") == "text" and it.get("text")]
    return "\n".join(parts).strip()


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            return {}

    # ---- POST ----
    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        body = self._body()
        try:
            if path == "/api/answer":
                return self._answer(body)
            if path == "/api/roast":
                return self._roast(body)
            if path == "/api/questions":
                return self._json(200, {"questions": gen_questions(int(body.get("n", 10)))})
            if path == "/api/mp/quick":
                return self._mp_quick(body)
            if path == "/api/mp/bot":
                return self._mp_bot(body)
            if path == "/api/mp/create":
                return self._mp_create(body)
            if path == "/api/mp/join":
                return self._mp_join(body)
            if path == "/api/mp/answer":
                return self._mp_answer(body)
            if path == "/api/mp/leave":
                return self._mp_leave(body)
            return self._json(404, {"error": "not found"})
        except Exception as exc:
            return self._json(500, {"error": str(exc)})

    def _answer(self, body):
        qid = str(body.get("qid", ""))
        choice = str(body.get("choice", ""))
        with LOCK:
            ans = ANSWER_KEY.get(qid)
            meta = QUESTION_META.get(qid, {})
        if ans is None:
            return self._json(400, {"error": "题目已过期"})
        return self._json(200, {
            "correct": choice == ans, "answer": ans,
            "page": meta.get("page"), "x": meta.get("x"), "y": meta.get("y"),
        })

    def _roast(self, body):
        char = str(body.get("char", ""))
        correct = bool(body.get("correct"))
        streak = int(body.get("streak", 0))
        mode = str(body.get("mode", ""))
        try:
            text = mimo_roast(char, correct, streak, mode)
            if text:
                return self._json(200, {"text": text, "source": "mimo"})
        except Exception:
            pass
        pool = ROAST_GOOD if correct else ROAST_BAD
        return self._json(200, {"text": random.choice(pool), "source": "local"})

    def _mp_quick(self, body):
        name = str(body.get("name", "无名剑客"))[:16] or "无名剑客"
        with LOCK:
            cleanup()
            # 找一个仍在等待的对手，并入它的房间
            while QUEUE:
                other_pid = QUEUE.pop(0)
                info = PLAYERS.get(other_pid)
                room = ROOMS.get(info["roomId"]) if info and info.get("roomId") else None
                if room and room["state"] == "waiting" and len(room["players"]) == 1:
                    pid = add_player(room, name)
                    start_room(room)
                    return self._json(200, {"pid": pid, "roomId": room["id"], "matched": True})
            # 无人等待：自己建房挂起、进队列
            room = new_room("versus")
            pid = add_player(room, name)
            QUEUE.append(pid)
            return self._json(200, {"pid": pid, "roomId": room["id"], "matched": False})

    def _mp_bot(self, body):
        pid = str(body.get("pid", ""))
        with LOCK:
            if pid in QUEUE:
                QUEUE.remove(pid)
            info = PLAYERS.get(pid)
            if not info or not ROOMS.get(info.get("roomId")):
                return self._json(400, {"error": "会话失效"})
            room = ROOMS[info["roomId"]]
            if len(room["players"]) < 2:
                add_player(room, random.choice(["墨小侠", "临池客", "狂草生", "笔痴", "砚台君"]), is_bot=True)
            if room["state"] == "waiting":
                start_room(room)
            return self._json(200, {"roomId": room["id"], "matched": True})

    def _mp_create(self, body):
        name = str(body.get("name", "房主"))[:16] or "房主"
        with LOCK:
            cleanup()
            room = new_room("versus")
            code = "".join(random.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(4))
            room["code"] = code
            CODES[code] = room["id"]
            pid = add_player(room, name)
            return self._json(200, {"pid": pid, "roomId": room["id"], "code": code})

    def _mp_join(self, body):
        name = str(body.get("name", "挑战者"))[:16] or "挑战者"
        code = str(body.get("code", "")).upper().strip()
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

    def _mp_answer(self, body):
        rid = str(body.get("roomId", ""))
        pid = str(body.get("pid", ""))
        qid = str(body.get("qid", ""))
        choice = str(body.get("choice", ""))
        time_ms = int(body.get("timeMs", 3000))
        with LOCK:
            room = ROOMS.get(rid)
            if not room or pid not in room["players"]:
                return self._json(400, {"error": "房间失效"})
            p = room["players"][pid]
            ans = ANSWER_KEY.get(qid)
            if ans is None:
                return self._json(400, {"error": "题目过期"})
            if qid in p["answered"]:
                return self._json(200, {"correct": p["answered"][qid] == ans, "answer": ans, "dup": True})
            correct = choice == ans
            p["answered"][qid] = choice
            p["progress"] += 1
            if correct:
                p["combo"] += 1
                p["score"] += score_for(True, time_ms, p["combo"])
            else:
                p["combo"] = 0
            if p["progress"] >= len(room["questions"]):
                p["done"] = True
            meta = QUESTION_META.get(qid, {})
            return self._json(200, {
                "correct": correct, "answer": ans, "score": p["score"], "combo": p["combo"],
                "page": meta.get("page"), "x": meta.get("x"), "y": meta.get("y"),
            })

    def _mp_leave(self, body):
        pid = str(body.get("pid", ""))
        with LOCK:
            if pid in QUEUE:
                QUEUE.remove(pid)
        return self._json(200, {"ok": True})

    # ---- GET ----
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        qs = {}
        if "?" in self.path:
            for kv in self.path.split("?", 1)[1].split("&"):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    qs[k] = urllib.parse.unquote(v)
        if path == "/health":
            return self._json(200, {"ok": True, "pool": len(TARGET_POOL)})
        if path == "/api/mp/status":
            pid = qs.get("pid", "")
            with LOCK:
                info = PLAYERS.get(pid)
                room = ROOMS.get(info["roomId"]) if info and info.get("roomId") else None
                matched = bool(room and len(room["players"]) >= 2 and room["state"] != "waiting")
                return self._json(200, {"matched": matched, "roomId": room["id"] if room else None})
        if path == "/api/mp/room":
            rid = qs.get("roomId", "")
            pid = qs.get("pid", "")
            with LOCK:
                room = ROOMS.get(rid)
                if not room:
                    return self._json(404, {"error": "房间不存在"})
                return self._json(200, room_view(room, pid))
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
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


def load_dotenv():
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


if __name__ == "__main__":
    load_dotenv()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    print(f"狂草猜猜猜 on {host}:{port}  题库 {len(TARGET_POOL)} 字")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
