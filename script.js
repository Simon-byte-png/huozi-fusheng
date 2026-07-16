/* ============================================================
   活字·复生 — 交互 & 海报渲染
   ============================================================ */

const canvas = document.getElementById("artCanvas");
const ctx = canvas.getContext("2d");
const phraseEl = document.getElementById("phrase");
const coverageEl = document.getElementById("coverage");
const traceList = document.getElementById("traceList");
const explainText = document.getElementById("explainText");
const artwork = document.querySelector(".artwork");

const state = { tone: "warm", ratio: "square" };
const samples = [
  "云腾致雨",
  "露结为霜",
  "秋收冬藏",
  "天地玄黄",
  "活字复生",
  "闲云野鹤",
  "笔走龙蛇",
];

let glyphData;
const imageCache = new Map();
let renderToken = 0;

function charsOf(text) {
  return Array.from(text)
    .filter((ch) => /[一-鿿]/.test(ch))
    .slice(0, 24);
}

function loadImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
  imageCache.set(src, promise);
  return promise;
}

function seeded(n) {
  const x = Math.sin(n * 999) * 10000;
  return x - Math.floor(x);
}

function resizeCanvas() {
  if (state.ratio === "story") {
    canvas.width = 1080;
    canvas.height = 1500;
  } else {
    canvas.width = 1200;
    canvas.height = 1200;
  }
}

function palette() {
  if (state.tone === "dark") {
    return { bg1: "#1b463c", bg2: "#0c221d", ink: "#ecd8ac", line: "rgba(231,205,150,.32)", seal: "#c2402f", accent: "#e8d3a3" };
  }
  if (state.tone === "red") {
    return { bg1: "#f6e6cf", bg2: "#dbb98a", ink: "#9a2b23", line: "rgba(115,60,35,.24)", seal: "#1b463c", accent: "#7a2019" };
  }
  return { bg1: "#f6ecd7", bg2: "#dcc296", ink: "#231f18", line: "rgba(71,50,25,.22)", seal: "#b3392c", accent: "#5a4a2c" };
}

function drawPaper(p) {
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop(0, p.bg1);
  g.addColorStop(1, p.bg2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 柔和的中心提亮，让主体更聚焦
  const glow = ctx.createRadialGradient(
    canvas.width / 2,
    canvas.height * 0.42,
    0,
    canvas.width / 2,
    canvas.height * 0.42,
    canvas.width * 0.7
  );
  glow.addColorStop(0, "rgba(255,248,232,.18)");
  glow.addColorStop(1, "rgba(255,248,232,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 纸纤维纹理
  for (let i = 0; i < 190; i++) {
    const a = seeded(i);
    ctx.globalAlpha = 0.04 + seeded(i + 7) * 0.07;
    ctx.fillStyle = i % 4 === 0 ? "#ffffff" : "#8a6f47";
    ctx.fillRect(
      seeded(i + 1) * canvas.width,
      seeded(i + 2) * canvas.height,
      1 + seeded(i + 3) * 2,
      24 + a * 110
    );
  }
  ctx.globalAlpha = 1;
}

function drawFrame(p) {
  ctx.save();
  ctx.strokeStyle = p.line;
  ctx.lineWidth = 2.4;
  ctx.strokeRect(60, 60, canvas.width - 120, canvas.height - 120);
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1;
  ctx.strokeRect(78, 78, canvas.width - 156, canvas.height - 156);
  ctx.restore();
}

function drawSeal(x, y, text, color, size = 82) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.25)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = color;
  roundRect(x, y, size, size, 10);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255,245,220,.7)";
  ctx.lineWidth = Math.max(3, size * 0.045);
  roundRect(x + size * 0.11, y + size * 0.11, size * 0.78, size * 0.78, 6);
  ctx.stroke();
  ctx.fillStyle = "#fff0d7";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.floor(size * 0.46)}px ${cnFont()}`;
  ctx.fillText(text, x + size / 2, y + size / 2 + 2);
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function cnFont() {
  return '"Noto Serif SC","Songti SC","STSong","SimSun",serif';
}

function drawGlyph(img, x, y, size, p, index, synthetic) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((seeded(index + 13) - 0.5) * 0.09);
  const scaleX = 0.92 + seeded(index + 17) * 0.2;
  const scaleY = 0.94 + seeded(index + 19) * 0.26;
  ctx.globalAlpha = synthetic ? 0.5 : 0.96;
  ctx.shadowColor = "rgba(20,12,5,.18)";
  ctx.shadowBlur = 2;
  ctx.filter = state.tone === "dark" ? "sepia(1) saturate(1.7) brightness(1.75)" : "none";
  const ratio = img.width / img.height;
  const drawH = size * scaleY;
  const drawW = drawH * ratio * scaleX;
  ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  if (state.tone === "warm") {
    ctx.globalAlpha = synthetic ? 0.2 : 0.34;
    ctx.drawImage(img, -drawW / 2 + 1, -drawH / 2 + 1, drawW, drawH);
  }
  if (state.tone === "red") {
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = p.ink;
    ctx.fillRect(-size, -size, size * 2, size * 2);
  }
  ctx.restore();
}

/* 缺字 / 扫描损毁字：用墨色书法字体兜底，避免黑块 */
function drawFontGlyph(ch, x, y, size, p, index) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((seeded(index + 13) - 0.5) * 0.05);
  ctx.fillStyle = p.ink;
  ctx.globalAlpha = 0.82;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(20,12,5,.18)";
  ctx.shadowBlur = 2;
  ctx.font = `700 ${Math.floor(size * 0.92)}px "Ma Shan Zheng", "KaiTi", "STKaiti", "SimKai", serif`;
  ctx.fillText(ch, 0, 0);
  ctx.globalAlpha = 0.22;
  ctx.fillText(ch, 1.2, 1.4);
  ctx.restore();
}

function drawCaption(text, x, y, size, p, alpha = 0.72, vertical = false) {
  ctx.save();
  ctx.fillStyle = p.accent;
  ctx.globalAlpha = alpha;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `${size}px ${cnFont()}`;
  if (vertical) {
    const chars = Array.from(text);
    let cy = y;
    chars.forEach((c) => {
      ctx.fillText(c, x, cy);
      cy += size * 1.06;
    });
  } else {
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

async function render() {
  if (!glyphData) return;
  const token = ++renderToken;

  resizeCanvas();
  const p = palette();
  drawPaper(p);
  drawFrame(p);

  const chars = charsOf(phraseEl.value);
  const trueCount = chars.filter((ch) => {
    const g = glyphData.glyphs[ch];
    return g && !g.synthetic && !g.unrecoverable;
  }).length;
  coverageEl.textContent = chars.length
    ? `${Math.round((trueCount / chars.length) * 100)}%`
    : "0%";

  // 竖排标题条（右上）
  drawCaption("活字复生", canvas.width - 120, 150, 34, p, 0.7, true);

  const maxRows = state.ratio === "story" ? 6 : 5;
  const columns = Math.max(1, Math.ceil(chars.length / maxRows));
  const size = Math.min(
    state.ratio === "story" ? 220 : 245,
    Math.floor((canvas.width - 300) / Math.max(columns, 2))
  );
  const gapY = size * 0.88;
  const gapX = size * 0.82;
  const centerX = canvas.width / 2 + ((columns - 1) * gapX) / 2 - 20;
  const blockH = (Math.min(chars.length, maxRows) - 1) * gapY;
  const startY = canvas.height / 2 - blockH / 2 + 24;

  // 判定每个字：可用真迹字模 vs 字体兜底（缺字/扫描损毁）
  const entries = chars.map((ch) => {
    const g = glyphData.glyphs[ch];
    const usable = g && !g.unrecoverable;
    return { ch, g, usable };
  });
  const imgs = await Promise.all(
    entries.map((e) => (e.usable ? loadImage(e.g.image).catch(() => null) : Promise.resolve(null)))
  );
  if (token !== renderToken) return; // 已有新的渲染请求

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const col = Math.floor(i / maxRows);
    const row = i % maxRows;
    const gx = centerX - col * gapX;
    const gy = startY + row * gapY;
    if (e.usable && imgs[i]) {
      drawGlyph(imgs[i], gx, gy, size, p, i, e.g.synthetic);
    } else {
      drawFontGlyph(e.ch, gx, gy, size, p, i);
    }
  }

  drawCaption("字出怀素·大草千字文", 122, canvas.height - 116, 26, p, 0.66);
  drawSeal(canvas.width - 172, canvas.height - 172, "复生", p.seal, 78);
  renderTrace(chars);
}

/* 切换时的交叉淡入 */
function renderWithSwap() {
  if (!glyphData) return;
  artwork.classList.add("is-swapping");
  window.clearTimeout(renderWithSwap._t);
  renderWithSwap._t = window.setTimeout(async () => {
    await render();
    artwork.classList.remove("is-swapping");
  }, 180);
}

function renderTrace(chars) {
  const seen = new Set();
  const items = chars
    .map((ch) => {
      if (seen.has(ch)) return "";
      seen.add(ch);
      const g = glyphData.glyphs[ch];
      if (!g || g.unrecoverable) {
        return `<article class="trace-item">
          <div class="trace-thumb trace-thumb--font">${ch}</div>
          <div class="trace-meta">
            <strong>${ch}</strong>
            <span class="is-synthetic">${g ? "原帖此字扫描损毁" : "帖中暂缺"} · 书法字体占位</span>
          </div>
        </article>`;
      }
      const tag = g.synthetic ? "AI 补字占位" : "原帖真字";
      const cls = g.synthetic ? "is-synthetic" : "";
      return `<article class="trace-item">
        <img class="trace-thumb" alt="${ch}" src="./${g.image}" loading="lazy" />
        <div class="trace-meta">
          <strong>${ch}</strong>
          <span class="${cls}">${tag} · 第 ${g.pageNumber} 页 · 坐标 ${g.x},${g.y}</span>
        </div>
      </article>`;
    })
    .join("");
  traceList.innerHTML = items || `<p class="trace-empty">请输入汉字，这里会列出每个字的帖内出处。</p>`;
}

/* ---------- 控件交互 ---------- */
document.querySelectorAll(".seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    const track = btn.parentElement;
    track.querySelectorAll(".seg").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    if (btn.dataset.tone) state.tone = btn.dataset.tone;
    if (btn.dataset.ratio) state.ratio = btn.dataset.ratio;
    renderWithSwap();
  });
});

phraseEl.addEventListener("input", render);

document.getElementById("randomBtn").addEventListener("click", () => {
  let next = phraseEl.value;
  while (next === phraseEl.value && samples.length > 1) {
    next = samples[Math.floor(seeded(renderToken + performance.now()) * samples.length)];
  }
  phraseEl.value = next;
  renderWithSwap();
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  const btn = document.getElementById("downloadBtn");
  btn.animate(
    [{ transform: "scale(1)" }, { transform: "scale(.96)" }, { transform: "scale(1)" }],
    { duration: 220, easing: "ease" }
  );
  const a = document.createElement("a");
  a.download = `活字复生-${phraseEl.value || "草书海报"}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
});

/* ---------- 抽屉 ---------- */
const drawer = document.getElementById("drawer");
const scrim = document.getElementById("scrim");
function openDrawer() {
  drawer.classList.add("is-open");
  scrim.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
}
function closeDrawer() {
  drawer.classList.remove("is-open");
  scrim.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
}
document.getElementById("drawerToggle").addEventListener("click", openDrawer);
document.getElementById("drawerClose").addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

document.getElementById("explainBtn").addEventListener("click", async () => {
  openDrawer();
  explainText.textContent = "怀素正在书写，且待片刻…";
  try {
    const res = await fetch("./api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: phraseEl.value.trim(), mode: state.ratio }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "题解失败");
    explainText.textContent = data.answer;
  } catch (err) {
    explainText.textContent = `题解暂时不可用：${err.message}`;
  }
});

/* ---------- 启动 ---------- */
fetch("./data/glyphs.json")
  .then((r) => r.json())
  .then((data) => {
    glyphData = data;
    render();
  })
  .catch(() => {
    coverageEl.textContent = "—";
  });

// 字体加载完成后重绘，保证标题/印章用到正确字形
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => glyphData && render());
}
