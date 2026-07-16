/* ============================================================
   狂草猜猜猜 —— 游戏逻辑 + 古风音效 + 分享卡
   ============================================================ */
const el = (id) => document.getElementById(id);
const RANKS = ["识草小白", "识草学徒", "临帖秀才", "草书举人", "狂草高手", "怀素门生", "草圣传人"];
const XP_TIERS = [0, 600, 1500, 3000, 5200, 8000, 12000];
const TIME_BY_RANK = [13, 12, 11, 10, 9, 8, 7];
const CIRC = 2 * Math.PI * 19;

const store = {
  get xp() { return +localStorage.getItem("kc_xp") || 0; },
  set xp(v) { localStorage.setItem("kc_xp", Math.max(0, Math.round(v))); },
  get name() { return localStorage.getItem("kc_name") || ""; },
  set name(v) { localStorage.setItem("kc_name", v); },
  get muted() { return localStorage.getItem("kc_muted") === "1"; },
  set muted(v) { localStorage.setItem("kc_muted", v ? "1" : "0"); },
};
const rankIndexOf = (xp) => {
  let i = 0;
  for (let k = 0; k < XP_TIERS.length; k++) if (xp >= XP_TIERS[k]) i = k;
  return i;
};

/* ---------------- 音频引擎（Web Audio，古琴五声 + 音效） ---------------- */
class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.bgmGain = null;
    this.bgmTimer = null;
    this.muted = store.muted;
    this.step = 0;
    // 五声音阶（宫商角徵羽）Hz，C 宫
    this.penta = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];
    this.melody = [0, 2, 4, 3, 2, 4, 5, 4, 3, 2, 1, 0, 2, 3, 2, 0];
  }
  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);
    this.bgmGain = this.ctx.createGain();
    this.bgmGain.gain.value = 0.16;
    this.bgmGain.connect(this.master);
  }
  resume() { if (this.ctx && this.ctx.state === "suspended") this.ctx.resume(); }
  setMuted(m) {
    this.muted = m;
    store.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }
  // 拨弦音：三角波 + 快速衰减
  pluck(freq, t, dur = 0.9, gain = 0.5, dest = null, type = "triangle") {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    const o2 = this.ctx.createOscillator();
    o2.type = "sine";
    o2.frequency.value = freq * 2.01;
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.25;
    o.connect(g); o2.connect(g2); g2.connect(g);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(dest || this.master);
    o.start(t); o2.start(t); o.stop(t + dur); o2.stop(t + dur);
  }
  startBGM() {
    this.ensure();
    if (!this.ctx || this.bgmTimer) return;
    const beat = 0.46;
    const tick = () => {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + 0.05;
      const n = this.melody[this.step % this.melody.length];
      this.pluck(this.penta[n], t, 1.4, 0.5, this.bgmGain);
      if (this.step % 4 === 0) this.pluck(this.penta[0] / 2, t, 1.8, 0.7, this.bgmGain, "sine"); // 低音
      if (this.step % 8 === 6) this.pluck(this.penta[n + 2] || this.penta[n], t + beat / 2, 1.0, 0.3, this.bgmGain);
      this.step++;
    };
    tick();
    this.bgmTimer = setInterval(tick, beat * 1000);
  }
  stopBGM() { if (this.bgmTimer) { clearInterval(this.bgmTimer); this.bgmTimer = null; } }
  // 音效
  correct() {
    this.ensure(); if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((f, i) => this.pluck(f, t + i * 0.07, 0.6, 0.5));
  }
  wrong() {
    this.ensure(); if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.pluck(180, t, 0.35, 0.5, null, "sawtooth");
    this.pluck(150, t + 0.08, 0.4, 0.4, null, "sawtooth");
  }
  comboHit(n) {
    this.ensure(); if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const base = 523.25 * Math.pow(2, Math.min(n, 6) / 12);
    this.pluck(base, t, 0.5, 0.45);
    this.pluck(base * 1.5, t + 0.05, 0.5, 0.3);
  }
  tick() {
    this.ensure(); if (!this.ctx) return;
    this.pluck(660, this.ctx.currentTime, 0.08, 0.18, null, "square");
  }
  match() {
    this.ensure(); if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [392, 523, 659, 784].forEach((f, i) => this.pluck(f, t + i * 0.1, 0.7, 0.5));
  }
  fanfare(win) {
    this.ensure(); if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const seq = win ? [523, 659, 784, 1046] : [440, 392, 330, 262];
    seq.forEach((f, i) => this.pluck(f, t + i * 0.16, 1.0, 0.5));
  }
  click() {
    this.ensure(); if (!this.ctx) return;
    this.pluck(440, this.ctx.currentTime, 0.1, 0.22);
  }
}
const snd = new Sound();

/* ---------------- 屏幕导航 ---------------- */
function nav(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("is-active"));
  el(id).classList.add("is-active");
}

/* ---------------- 段位卡 ---------------- */
function refreshRankCard() {
  const xp = store.xp;
  const idx = rankIndexOf(xp);
  el("homeRankBadge").textContent = RANKS[idx];
  const cur = XP_TIERS[idx];
  const next = XP_TIERS[idx + 1];
  el("homeRankXp").textContent = `${xp} XP`;
  if (next) {
    const pct = Math.min(100, ((xp - cur) / (next - cur)) * 100);
    el("homeRankFill").style.width = pct + "%";
    el("homeRankNext").textContent = `距 ${RANKS[idx + 1]} ${next - xp}`;
  } else {
    el("homeRankFill").style.width = "100%";
    el("homeRankNext").textContent = "已臻化境";
  }
}

/* ---------------- 通用答题引擎 ---------------- */
const game = {
  mode: "solo", // solo | versus
  questions: [],
  idx: 0,
  score: 0,
  combo: 0,
  bestCombo: 0,
  correctCount: 0,
  timePerQ: 12,
  timerStart: 0,
  timerId: null,
  answered: false,
  lastGlyphImg: "",
  // versus
  roomId: null,
  pid: null,
  pollId: null,
  oppName: "对手",
};

function setTimerRing(frac) {
  el("timerFill").style.strokeDashoffset = CIRC * (1 - frac);
}

function startTimer() {
  game.timerStart = performance.now();
  const total = game.timePerQ * 1000;
  el("timer").classList.remove("low");
  let lastSec = -1;
  const loop = () => {
    const elapsed = performance.now() - game.timerStart;
    const frac = Math.max(0, 1 - elapsed / total);
    setTimerRing(frac);
    const secLeft = Math.ceil((total - elapsed) / 1000);
    if (secLeft !== lastSec) {
      lastSec = secLeft;
      el("timerNum").textContent = Math.max(0, secLeft);
      if (secLeft <= 3 && secLeft > 0) { el("timer").classList.add("low"); if (!snd.muted) snd.tick(); }
    }
    if (elapsed >= total) { onChoose(null, null); return; }
    game.timerId = requestAnimationFrame(loop);
  };
  game.timerId = requestAnimationFrame(loop);
}
function stopTimer() { if (game.timerId) cancelAnimationFrame(game.timerId); game.timerId = null; }

function showQuestion() {
  game.answered = false;
  const q = game.questions[game.idx];
  game.lastGlyphImg = q.image;
  el("qIndex").textContent = game.idx + 1;
  el("qTotal").textContent = game.questions.length;
  el("verdict").hidden = true;
  el("sourceInfo").hidden = true;
  const card = el("glyphCard");
  card.classList.remove("correct", "wrong");
  el("glyphImg").src = "./" + q.image;
  // 选项
  const box = el("options");
  box.innerHTML = "";
  q.options.forEach((ch) => {
    const b = document.createElement("button");
    b.className = "opt";
    b.textContent = ch;
    b.onclick = () => onChoose(ch, b);
    box.appendChild(b);
  });
  el("timerNum").textContent = game.timePerQ;
  setTimerRing(1);
  startTimer();
}

async function onChoose(choice, btn) {
  if (game.answered) return;
  game.answered = true;
  stopTimer();
  const q = game.questions[game.idx];
  const timeMs = performance.now() - game.timerStart;
  document.querySelectorAll(".opt").forEach((o) => (o.disabled = true));

  let res;
  try {
    if (game.mode === "versus") {
      res = await api("POST", "/api/mp/answer", { roomId: game.roomId, pid: game.pid, qid: q.qid, choice: choice || "", timeMs: Math.round(timeMs) });
    } else {
      res = await api("POST", "/api/answer", { qid: q.qid, choice: choice || "" });
    }
  } catch (e) {
    res = { correct: false, answer: "?", page: q.page, x: q.x, y: q.y };
  }

  const correct = !!res.correct;
  const card = el("glyphCard");
  card.classList.add(correct ? "correct" : "wrong");

  // 高亮选项
  document.querySelectorAll(".opt").forEach((o) => {
    if (o.textContent === res.answer) o.classList.add("is-correct");
    else if (btn && o === btn) o.classList.add("is-wrong");
    else o.classList.add("dim");
  });

  // 计分
  if (correct) {
    game.combo += 1;
    game.correctCount += 1;
    game.bestCombo = Math.max(game.bestCombo, game.combo);
    if (game.mode === "versus" && typeof res.score === "number") game.score = res.score;
    else {
      const speed = Math.max(0, Math.round(120 - timeMs / 40));
      const gained = 100 + speed + Math.min(game.combo, 8) * 25;
      game.score += gained;
      floatScore("+" + gained, btn);
    }
    game.combo >= 2 ? snd.comboHit(game.combo) : snd.correct();
  } else {
    game.combo = 0;
    if (game.mode === "versus" && typeof res.score === "number") game.score = res.score;
    snd.wrong();
  }
  updateHud();

  // 判定卡
  el("verdictHead").textContent = correct ? (game.combo >= 3 ? `连击 ×${game.combo}！` : "认得出，好眼力") : (choice ? "差之毫厘" : "时间到");
  el("verdictHead").className = "verdict__head " + (correct ? "ok" : "no");
  el("verdictRoast").textContent = "怀素正在落评…";
  el("sourceInfo").hidden = true;
  el("sourceInfo").textContent = `出自《大草千字文》第 ${res.page} 页 · 坐标 (${res.x}, ${res.y})`;
  el("sourceBtn").onclick = () => { el("sourceInfo").hidden = false; snd.click(); };
  el("nextBtn").textContent = game.idx + 1 >= game.questions.length ? "查看战绩 →" : "下一题 →";
  el("nextBtn").onclick = nextQuestion;
  el("verdict").hidden = false;

  // 毒舌评语（异步）
  api("POST", "/api/roast", { char: res.answer, correct, streak: game.combo, mode: game.mode })
    .then((r) => { el("verdictRoast").textContent = r.text || ""; })
    .catch(() => { el("verdictRoast").textContent = correct ? "认得出，是把好眼。" : "再练练吧，草圣不等人。"; });
}

function nextQuestion() {
  snd.click();
  game.idx += 1;
  if (game.idx >= game.questions.length) {
    finishGame();
  } else {
    showQuestion();
  }
}

function updateHud() {
  el("score").textContent = game.score;
  const c = el("combo");
  c.textContent = game.combo > 0 ? `连击 ×${game.combo}` : "";
  c.classList.remove("pop"); void c.offsetWidth; if (game.combo > 1) c.classList.add("pop");
  if (game.mode === "versus") updateVersusBar();
}

function floatScore(text, btn) {
  const f = document.createElement("div");
  f.className = "floatscore";
  f.textContent = text;
  f.style.color = "#e6c98a";
  const r = (btn || el("score")).getBoundingClientRect();
  f.style.left = r.left + r.width / 2 - 20 + "px";
  f.style.top = r.top + "px";
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 900);
}

/* ---------------- 单人 ---------------- */
async function startSolo() {
  snd.startBGM();
  game.mode = "solo";
  game.idx = 0; game.score = 0; game.combo = 0; game.bestCombo = 0; game.correctCount = 0;
  const idx = rankIndexOf(store.xp);
  game.timePerQ = TIME_BY_RANK[idx];
  el("playRank").textContent = RANKS[idx];
  el("versusbar").hidden = true;
  try {
    const r = await api("POST", "/api/questions", { n: 10 });
    game.questions = r.questions;
  } catch (e) { alert("题目加载失败，请重试"); return; }
  nav("play");
  showQuestion();
}

/* ---------------- 双人 ---------------- */
function startVersusFlow(kind) {
  snd.startBGM();
  const name = getName();
  if (kind === "quick") {
    api("POST", "/api/mp/quick", { name }).then((r) => {
      game.pid = r.pid; game.roomId = r.roomId;
      enterWaiting(false);
      if (r.matched) enterRoom();
      else pollMatch();
    });
  } else if (kind === "create") {
    api("POST", "/api/mp/create", { name }).then((r) => {
      game.pid = r.pid; game.roomId = r.roomId;
      enterWaiting(true, r.code);
      pollMatch();
    });
  } else if (kind === "join") {
    const code = (el("joinCode").value || "").toUpperCase().trim();
    if (code.length < 4) { alert("请输入 4 位房间码"); return; }
    api("POST", "/api/mp/join", { name, code }).then((r) => {
      if (r.error) { alert(r.error); return; }
      game.pid = r.pid; game.roomId = r.roomId;
      enterWaiting(false);
      enterRoom();
    }).catch(() => alert("加入失败"));
  }
}

function enterWaiting(isHost, code) {
  nav("waiting");
  el("waitTitle").textContent = isHost ? "等待好友加入…" : "正在寻找对手…";
  el("waitDesc").textContent = isHost ? "把房间码发给朋友" : "同一片墨海，正为你寻一位对手";
  el("waitCode").hidden = !isHost;
  el("playBot").hidden = isHost; // 房主等好友；快速匹配才给 bot
  if (isHost) el("waitCodeVal").textContent = code;
  if (!isHost) setTimeout(() => { el("playBot").hidden = false; }, 7000);
}

function pollMatch() {
  clearInterval(game.pollId);
  game.pollId = setInterval(async () => {
    try {
      const r = await api("GET", `/api/mp/status?pid=${game.pid}`);
      if (r.matched) { clearInterval(game.pollId); enterRoom(); }
    } catch (e) {}
  }, 1200);
}

let roomStarted = false;
function enterRoom() {
  clearInterval(game.pollId);
  roomStarted = false;
  game.mode = "versus";
  game.idx = 0; game.score = 0; game.combo = 0; game.bestCombo = 0; game.correctCount = 0;
  el("versusbar").hidden = false;
  el("playRank").textContent = "实时竞赛";
  snd.match();
  // 轮询房间，等 startAt 后开赛
  game.pollId = setInterval(pollRoom, 1000);
  pollRoom();
}

async function pollRoom() {
  let r;
  try { r = await api("GET", `/api/mp/room?roomId=${game.roomId}&pid=${game.pid}`); }
  catch (e) { return; }
  game._room = r;
  if (r.opp) { game.oppName = r.opp.name; el("oppName").textContent = r.opp.name + (r.opp.isBot ? " · AI" : ""); }
  updateVersusBar();

  if (!roomStarted && r.state === "playing" && r.questions && r.questions.length) {
    const wait = r.startAt - Date.now();
    if (wait > 0) { showCountdown(wait, r.questions); }
    else beginVersus(r.questions);
  }
  if (r.state === "finished" && roomStarted) {
    clearInterval(game.pollId);
    finishVersus(r);
  }
}

function showCountdown(ms, questions) {
  if (roomStarted) return;
  roomStarted = true;
  nav("play");
  el("options").innerHTML = "";
  el("verdict").hidden = true;
  el("glyphImg").removeAttribute("src");
  let n = Math.ceil(ms / 1000);
  el("glyphCard").innerHTML = `<div style="font-family:var(--font-brush);font-size:96px;color:#8a2a20" id="cd">${n}</div>`;
  snd.tick();
  const iv = setInterval(() => {
    n -= 1;
    const cd = document.getElementById("cd");
    if (n > 0) { if (cd) cd.textContent = n; snd.tick(); }
    else {
      clearInterval(iv);
      el("glyphCard").innerHTML = `<img id="glyphImg" alt="狂草字" />`;
      beginVersus(questions);
    }
  }, 1000);
}

function beginVersus(questions) {
  game.questions = questions;
  game.idx = 0;
  const idx = rankIndexOf(store.xp);
  game.timePerQ = Math.max(8, TIME_BY_RANK[idx]);
  showQuestion();
}

function updateVersusBar() {
  const r = game._room;
  if (!r) return;
  const total = r.count || 10;
  const meProg = (r.me ? r.me.progress : game.idx) / total * 100;
  const oppProg = (r.opp ? r.opp.progress : 0) / total * 100;
  el("meFill").style.width = meProg + "%";
  el("oppFill").style.width = oppProg + "%";
  el("meScore").textContent = game.score;
  el("oppScore").textContent = r.opp ? r.opp.score : 0;
}

/* ---------------- 结算 ---------------- */
function finishGame() {
  if (game.mode === "versus") {
    // 我答完了，但要等对手/房间 finished：继续轮询
    el("options").innerHTML = "";
    el("verdict").hidden = true;
    el("glyphCard").classList.remove("correct", "wrong");
    el("glyphCard").innerHTML = `<div style="text-align:center;color:#6b5f4a;font-size:15px;padding:20px">已答完，等对手收笔…</div>`;
    if (!game.pollId) { game.pollId = setInterval(pollRoom, 1000); }
  } else {
    finishSolo();
  }
}

function finishSolo() {
  snd.stopBGM();
  const before = rankIndexOf(store.xp);
  store.xp = store.xp + game.score;
  const after = rankIndexOf(store.xp);
  const promoted = after > before;
  snd.fanfare(true);
  refreshRankCard();
  drawSoloCard(after, promoted);
  nav("result");
  el("againBtn").onclick = () => { snd.click(); startSolo(); };
}

function finishVersus(r) {
  snd.stopBGM();
  const win = r.winner === game.pid;
  const tie = r.winner === "tie";
  snd.fanfare(win || tie);
  drawVersusCard(r, win, tie);
  nav("result");
  el("againBtn").onclick = () => { snd.click(); nav("lobby"); };
}

/* ---------------- 分享卡（Canvas） ---------------- */
function cardBase(ctx, W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#211b14"); g.addColorStop(1, "#120f0b");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(200,168,106,.35)"; ctx.lineWidth = 3;
  ctx.strokeRect(40, 40, W - 80, H - 80);
  ctx.strokeStyle = "rgba(200,168,106,.18)"; ctx.lineWidth = 1;
  ctx.strokeRect(56, 56, W - 112, H - 112);
  // 印章
  ctx.fillStyle = "#c53b2c";
  roundRect(ctx, W - 168, H - 168, 96, 96, 14); ctx.fill();
  ctx.fillStyle = "#fbeed6"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = '700 52px "Ma Shan Zheng","Noto Serif SC",serif';
  ctx.fillText("草", W - 120, H - 118);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawGlyphOnCard(ctx, cb) {
  if (!game.lastGlyphImg) { cb(); return; }
  const img = new Image();
  img.onload = () => cb(img);
  img.onerror = () => cb();
  img.src = "./" + game.lastGlyphImg;
}
function drawSoloCard(rankIdx, promoted) {
  const c = el("shareCanvas"), ctx = c.getContext("2d");
  const W = c.width, H = c.height;
  cardBase(ctx, W, H);
  ctx.textAlign = "center";
  ctx.fillStyle = "#c8a86a"; ctx.font = 'italic 30px "Cormorant Garamond",serif';
  ctx.fillText("CURSIVE · GUESS", W / 2, 130);
  ctx.fillStyle = "#ece3d1"; ctx.font = '900 68px "Noto Serif SC",serif';
  ctx.fillText("狂草猜猜猜", W / 2, 210);

  drawGlyphOnCard(ctx, (img) => {
    if (img) {
      const s = 300, ratio = img.width / img.height;
      const dw = s * ratio, dh = s;
      ctx.save(); ctx.globalAlpha = 0.9;
      // 纸底
      ctx.fillStyle = "#efe6d4"; roundRect(ctx, W / 2 - 190, 270, 380, 380, 24); ctx.fill();
      ctx.drawImage(img, W / 2 - dw / 2, 300 + (320 - dh) / 2, dw, dh);
      ctx.restore();
    }
    // 段位
    ctx.textAlign = "center";
    ctx.fillStyle = "#e6c98a"; ctx.font = '700 30px "Noto Serif SC",serif';
    ctx.fillText(promoted ? "★ 晋段 ★" : "本局段位", W / 2, 730);
    ctx.fillStyle = "#fbeed6"; ctx.font = '900 76px "Noto Serif SC",serif';
    ctx.fillText(RANKS[rankIdx], W / 2, 812);
    // 数据
    ctx.fillStyle = "#c8a86a"; ctx.font = '600 120px "Cormorant Garamond",serif';
    ctx.fillText(String(game.score), W / 2, 960);
    ctx.fillStyle = "#b3a892"; ctx.font = '400 28px "Noto Serif SC",serif';
    ctx.fillText(`本局得分`, W / 2, 1000);
    ctx.font = '400 30px "Noto Serif SC",serif';
    ctx.fillStyle = "#ece3d1";
    ctx.fillText(`答对 ${game.correctCount}/${game.questions.length}   最高连击 ×${game.bestCombo}`, W / 2, 1080);
    ctx.fillStyle = "#7d7461"; ctx.font = '400 24px "Noto Serif SC",serif';
    ctx.fillText("怀素《大草千字文》· 集字挑战", W / 2, 1200);
  });
}
function drawVersusCard(r, win, tie) {
  const c = el("shareCanvas"), ctx = c.getContext("2d");
  const W = c.width, H = c.height;
  cardBase(ctx, W, H);
  ctx.textAlign = "center";
  ctx.fillStyle = "#c8a86a"; ctx.font = 'italic 30px "Cormorant Garamond",serif';
  ctx.fillText("REAL-TIME DUEL", W / 2, 130);
  ctx.fillStyle = "#ece3d1"; ctx.font = '900 64px "Noto Serif SC",serif';
  ctx.fillText("狂草对决", W / 2, 208);

  ctx.font = '900 120px "Noto Serif SC",serif';
  ctx.fillStyle = tie ? "#c8a86a" : win ? "#5fae7f" : "#d15a48";
  ctx.fillText(tie ? "平 局" : win ? "胜" : "负", W / 2, 420);

  const me = r.me ? game.score : game.score;
  const opp = r.opp ? r.opp.score : 0;
  ctx.fillStyle = "#efe6d4"; roundRect(ctx, 120, 520, W - 240, 300, 24); ctx.fill();
  ctx.fillStyle = "#231f18"; ctx.font = '700 40px "Noto Serif SC",serif';
  ctx.textAlign = "left"; ctx.fillText("我", 180, 610);
  ctx.textAlign = "right"; ctx.fillText(r.opp ? r.opp.name : "对手", W - 180, 610);
  ctx.textAlign = "center"; ctx.fillStyle = "#8a6f47"; ctx.font = '600 30px "Noto Serif SC",serif';
  ctx.fillText("VS", W / 2, 690);
  ctx.fillStyle = win || tie ? "#b3392c" : "#231f18"; ctx.font = '700 96px "Cormorant Garamond",serif';
  ctx.textAlign = "left"; ctx.fillText(String(game.score), 180, 760);
  ctx.textAlign = "right"; ctx.fillText(String(opp), W - 180, 760);

  ctx.textAlign = "center";
  ctx.fillStyle = "#ece3d1"; ctx.font = '400 30px "Noto Serif SC",serif';
  ctx.fillText(`最高连击 ×${game.bestCombo} · 答对 ${game.correctCount}`, W / 2, 950);
  ctx.fillStyle = "#7d7461"; ctx.font = '400 24px "Noto Serif SC",serif';
  ctx.fillText("狂草猜猜猜 · 怀素真迹识字竞技", W / 2, 1200);
}

/* ---------------- 网络 ---------------- */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
function getName() {
  const v = (el("playerName").value || "").trim().slice(0, 12);
  const name = v || "无名剑客";
  store.name = name;
  return name;
}

/* ---------------- 事件绑定 ---------------- */
function initSound() { snd.ensure(); snd.resume(); }
document.addEventListener("pointerdown", initSound, { once: true });

el("soundToggle").addEventListener("click", () => {
  const m = !snd.muted;
  snd.setMuted(m);
  el("soundToggle").classList.toggle("is-muted", m);
  if (!m) { snd.ensure(); snd.resume(); }
});

document.querySelectorAll("[data-go]").forEach((b) => {
  b.addEventListener("click", () => {
    snd.click();
    const go = b.dataset.go;
    if (go === "solo") startSolo();
    else nav(go);
    if (go === "home") { snd.stopBGM(); refreshRankCard(); }
  });
});
document.querySelectorAll("[data-mp]").forEach((b) => {
  b.addEventListener("click", () => { snd.click(); startVersusFlow(b.dataset.mp); });
});
el("playBot").addEventListener("click", () => {
  snd.click();
  api("POST", "/api/mp/bot", { pid: game.pid }).then(() => { clearInterval(game.pollId); enterRoom(); });
});
el("copyCode").addEventListener("click", () => {
  const t = el("waitCodeVal").textContent;
  navigator.clipboard && navigator.clipboard.writeText(t);
  el("copyCode").textContent = "已复制";
  setTimeout(() => (el("copyCode").textContent = "复制"), 1500);
});
el("saveCard").addEventListener("click", () => {
  snd.click();
  const a = document.createElement("a");
  a.download = "狂草猜猜猜-战绩.png";
  a.href = el("shareCanvas").toDataURL("image/png");
  a.click();
});

/* ---------------- 启动 ---------------- */
el("playerName").value = store.name;
el("soundToggle").classList.toggle("is-muted", store.muted);
refreshRankCard();
