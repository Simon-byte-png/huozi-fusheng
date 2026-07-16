const canvas = document.getElementById("artCanvas");
const ctx = canvas.getContext("2d");
const phraseEl = document.getElementById("phrase");
const paperToneEl = document.getElementById("paperTone");
const ratioEl = document.getElementById("ratio");
const coverageEl = document.getElementById("coverage");
const traceList = document.getElementById("traceList");
const explainText = document.getElementById("explainText");

const samples = ["云腾致雨", "露结为霜", "秋收冬藏", "天地玄黄", "活字复生"];
let glyphData;
let imageCache = new Map();

function charsOf(text) {
  return Array.from(text).filter((ch) => /[\u4e00-\u9fff]/.test(ch)).slice(0, 24);
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
  if (ratioEl.value === "story") {
    canvas.width = 1080;
    canvas.height = 1500;
  } else {
    canvas.width = 1200;
    canvas.height = 1200;
  }
}

function palette() {
  if (paperToneEl.value === "dark") {
    return { bg1: "#173d34", bg2: "#0e2823", ink: "#ead7aa", line: "rgba(231,205,150,.35)", seal: "#b83b2f" };
  }
  if (paperToneEl.value === "red") {
    return { bg1: "#f7ead4", bg2: "#e1c291", ink: "#9b2d25", line: "rgba(115,60,35,.22)", seal: "#173d34" };
  }
  return { bg1: "#f7eedb", bg2: "#dfc79e", ink: "#22231f", line: "rgba(71,50,25,.22)", seal: "#a43128" };
}

function drawPaper(p) {
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop(0, p.bg1);
  g.addColorStop(1, p.bg2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < 180; i++) {
    const a = seeded(i);
    ctx.globalAlpha = 0.045 + seeded(i + 7) * 0.08;
    ctx.fillStyle = i % 4 === 0 ? "#ffffff" : "#8a6f47";
    ctx.fillRect(seeded(i + 1) * canvas.width, seeded(i + 2) * canvas.height, 1 + seeded(i + 3) * 2, 24 + a * 110);
  }
  ctx.globalAlpha = 1;
}

function drawSeal(x, y, text, color, size = 86) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = "rgba(255,245,220,.72)";
  ctx.lineWidth = Math.max(3, size * 0.045);
  ctx.strokeRect(x + size * 0.1, y + size * 0.1, size * 0.8, size * 0.8);
  ctx.fillStyle = "#fff0d7";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.floor(size * 0.44)}px serif`;
  ctx.fillText(text, x + size / 2, y + size / 2 + 2);
  ctx.restore();
}

async function drawTitle(p) {
  ctx.save();
  ctx.fillStyle = p.ink;
  ctx.strokeStyle = p.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(62, 62, canvas.width - 124, canvas.height - 124);
  ctx.strokeRect(82, 82, canvas.width - 164, canvas.height - 164);
  ctx.restore();

  drawBrushText("活字复生", 122, 154, 62, p, 410);
}

async function drawGlyph(g, x, y, size, p, index) {
  const img = await loadImage(g.image);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((seeded(index + 13) - 0.5) * 0.09);
  const scaleX = 0.92 + seeded(index + 17) * 0.2;
  const scaleY = 0.94 + seeded(index + 19) * 0.26;
  ctx.globalAlpha = g.synthetic ? 0.54 : 0.96;
  ctx.shadowColor = "rgba(20,12,5,.18)";
  ctx.shadowBlur = 2;
  ctx.filter = paperToneEl.value === "dark" ? "sepia(1) saturate(1.7) brightness(1.75)" : "none";
  const ratio = img.width / img.height;
  const drawH = size * scaleY;
  const drawW = drawH * ratio * scaleX;
  ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
  if (paperToneEl.value === "warm") {
    ctx.globalAlpha = g.synthetic ? 0.22 : 0.36;
    ctx.drawImage(img, -drawW / 2 + 1, -drawH / 2 + 1, drawW, drawH);
  }
  if (paperToneEl.value !== "warm") {
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = p.ink;
    ctx.fillRect(-size, -size, size * 2, size * 2);
  }
  ctx.restore();
}

async function drawGlyphLine(text, x, y, size, p, seedOffset = 0) {
  const chars = charsOf(text);
  let cursor = x;
  for (let i = 0; i < chars.length; i++) {
    const g = glyphData.glyphs[chars[i]] || glyphData.glyphs["字"];
    const img = await loadImage(g.image);
    const ratio = img.width / img.height;
    const drawH = size * (0.9 + seeded(seedOffset + i + 3) * 0.18);
    const drawW = drawH * ratio;
    ctx.save();
    ctx.translate(cursor + drawW / 2, y);
    ctx.rotate((seeded(seedOffset + i + 9) - 0.5) * 0.06);
    ctx.globalAlpha = g.synthetic ? 0.62 : 0.9;
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.globalAlpha = g.synthetic ? 0.18 : 0.26;
    ctx.drawImage(img, -drawW / 2 + 1, -drawH / 2 + 1, drawW, drawH);
    ctx.restore();
    cursor += Math.max(size * 0.58, drawW * 0.78);
  }
}

function drawBrushText(text, x, y, size, p, seedOffset = 0) {
  ctx.save();
  ctx.fillStyle = p.ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(36, 24, 12, .16)";
  ctx.shadowBlur = 2;
  let cursor = x;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    ctx.save();
    ctx.translate(cursor, y + (seeded(seedOffset + i) - 0.5) * 6);
    ctx.rotate((seeded(seedOffset + i + 30) - 0.5) * 0.05);
    ctx.globalAlpha = 0.86;
    ctx.font = `900 ${size + (seeded(seedOffset + i + 60) - 0.5) * 8}px KaiTi, STKaiti, SimKai, serif`;
    ctx.fillText(chars[i], 0, 0);
    ctx.globalAlpha = 0.22;
    ctx.fillText(chars[i], 1.2, 1.2);
    ctx.restore();
    cursor += size * 0.92;
  }
  ctx.restore();
}

async function render() {
  if (!glyphData) return;
  resizeCanvas();
  const p = palette();
  drawPaper(p);
  await drawTitle(p);

  const chars = charsOf(phraseEl.value);
  const trueCount = chars.filter((ch) => glyphData.glyphs[ch] && !glyphData.glyphs[ch].synthetic).length;
  coverageEl.textContent = chars.length ? `${Math.round((trueCount / chars.length) * 100)}%` : "0%";

  const maxRows = ratioEl.value === "story" ? 6 : 5;
  const columns = Math.max(1, Math.ceil(chars.length / maxRows));
  const size = Math.min(ratioEl.value === "story" ? 220 : 245, Math.floor((canvas.width - 240) / Math.max(columns, 2)));
  const gapY = size * 0.88;
  const gapX = size * 0.82;
  const centerX = canvas.width / 2 + ((columns - 1) * gapX) / 2;
  const blockH = (Math.min(chars.length, maxRows) - 1) * gapY;
  const startY = canvas.height / 2 - blockH / 2 + 28;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const g = glyphData.glyphs[ch] || glyphData.glyphs["字"];
    const col = Math.floor(i / maxRows);
    const row = i % maxRows;
    await drawGlyph(g, centerX - col * gapX, startY + row * gapY, size, p, i);
  }

  drawBrushText("字出怀素", 122, canvas.height - 118, 32, p, 700);
  drawSeal(canvas.width - 178, canvas.height - 178, "复", p.seal, 78);
  renderTrace(chars);
}

function renderTrace(chars) {
  const seen = new Set();
  traceList.innerHTML = chars
    .map((ch) => {
      const g = glyphData.glyphs[ch];
      if (!g || seen.has(ch)) return "";
      seen.add(ch);
      return `<article class="trace-item">
        <img class="trace-thumb" alt="${ch}" src="./${g.image}" />
        <div class="trace-meta">
          <strong>${ch}</strong>
          <span>${g.synthetic ? "AI 补字占位" : "原帖真字"} · 第 ${g.pageNumber} 页 · 坐标 ${g.x},${g.y}</span>
        </div>
      </article>`;
    })
    .join("");
}

document.getElementById("randomBtn").addEventListener("click", () => {
  phraseEl.value = samples[Math.floor(Math.random() * samples.length)];
  render();
});

document.getElementById("downloadBtn").addEventListener("click", () => {
  const a = document.createElement("a");
  a.download = "活字复生-草书海报.png";
  a.href = canvas.toDataURL("image/png");
  a.click();
});

document.getElementById("explainBtn").addEventListener("click", async () => {
  explainText.textContent = "怀素正在书写，且待片刻。";
  try {
    const res = await fetch("./api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: phraseEl.value.trim(), mode: ratioEl.value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "讲解失败");
    explainText.textContent = data.answer;
  } catch (err) {
    explainText.textContent = `讲解暂时不可用：${err.message}`;
  }
});

[phraseEl, paperToneEl, ratioEl].forEach((el) => el.addEventListener("input", render));

fetch("./data/glyphs.json")
  .then((r) => r.json())
  .then((data) => {
    glyphData = data;
    render();
  });
