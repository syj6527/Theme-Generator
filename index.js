/* 🌧️ 테마 생성기 (Theme Generator) — SillyTavern extension  v0.1.0-beta
 *
 * Mood Mode: 무드 축(온도/습도/밝기/채도/대비/환상) → 결정론적 엔진 → 12슬롯 팔레트.
 * AI는 옵션(텍스트 → 축 추출만). 색은 항상 엔진이 계산.
 * Object Mode: 소재 = 색상 범위 → 추출 → 밴드 하모나이저 → 무드 판정 → 형광펜 4타입. 다이스로 매번 다른 서사.
 *
 * ⚠ ST API 경로/호출은 버전에 따라 다를 수 있음. 아래 [VERIFY] 주석 지점만 확인하면 됨.
 */

// [VERIFY] third-party 경로 기준 import. 안 잡히면 ../ 갯수만 조정.
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const MODULE = "themeGen";
const VERSION = "0.2.0-beta";

const defaultSettings = {
  enabled: true,
  profile: "",          // 연결 프로필 id (AI 추출용)
  aiInPanel: false,     // 탭 내 AI 연결 토글
  library: [],          // 저장된 팔레트
};

function settings() {
  if (!extension_settings[MODULE]) extension_settings[MODULE] = structuredClone(defaultSettings);
  for (const k in defaultSettings) if (extension_settings[MODULE][k] === undefined) extension_settings[MODULE][k] = defaultSettings[k];
  return extension_settings[MODULE];
}
const save = () => saveSettingsDebounced();

/* ───────── 색 유틸 ───────── */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
function parseColor(str) {
  str = (str || "").trim();
  if (str[0] === "#") { let h = str.slice(1); if (h.length === 3) h = h.split("").map(c => c + c).join(""); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }; }
  const m = str.match(/rgba?\(([^)]+)\)/i);
  if (m) { const p = m[1].split(",").map(s => parseFloat(s.trim())); return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p[3] == null ? 1 : p[3] }; }
  return { r: 0, g: 0, b: 0, a: 1 };
}
const toRgba = c => `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${(+(c.a == null ? 1 : c.a)).toFixed(2).replace(/\.?0+$/, "") || "1"})`;
function toHex(c) { const p = parseColor(c); const h = x => ("0" + clamp(Math.round(x), 0, 255).toString(16)).slice(-2); return "#" + h(p.r) + h(p.g) + h(p.b); }
const fmtVal = v => { const p = parseColor(v); return (p.a == null || p.a >= 1) ? toHex(v) : toRgba(p); };
function rgbToHsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h, s, l = (mx + mn) / 2; if (mx === mn) { h = s = 0; } else { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); switch (mx) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4; } h /= 6; } return { h, s, l }; }
function hslToRgb(h, s, l) { let r, g, b; if (s === 0) { r = g = b = l; } else { const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }; const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); } return { r: r * 255, g: g * 255, b: b * 255 }; }
function relLum(c) { const a = [c.r, c.g, c.b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; }
function contrast(c1, c2) { const L1 = relLum(c1), L2 = relLum(c2); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); }
function H(hueDeg, s, l, a) { const rgb = hslToRgb(((hueDeg % 360) + 360) % 360 / 360, clamp(s, 0, 1), clamp(l, 0, 1)); return toRgba({ ...rgb, a: a == null ? 1 : a }); }
function flatten(fg, bg) { const f = parseColor(fg), b = parseColor(bg); const a = f.a == null ? 1 : f.a; return toRgba({ r: f.r * a + b.r * (1 - a), g: f.g * a + b.g * (1 - a), b: f.b * a + b.b * (1 - a), a: 1 }); }

/* ───────── 엔진: 무드 축 → 12슬롯 ───────── */
function engine(d, lockBlue) {
  const humid = d.humid / 100, bright = d.bright / 100, sat = d.sat / 100, contrast = d.contrast / 100, fant = d.fantasy / 100;
  const tempC = (d.temp - 50) / 50;
  const light = d.bright >= 45;
  let baseHue = tempC >= 0 ? (45 - tempC * 30) : (205 + (-tempC) * 30);
  baseHue = lerp(baseHue, 285, fant * 0.5);

  const bgL = light ? lerp(0.93, 0.985, bright) : lerp(0.10, 0.20, bright);
  const bgS = clamp(0.03 + humid * 0.05, 0, 0.12);
  const chatBg = H(baseHue, bgS, bgL);
  const uiBg = H(baseHue, bgS * 1.15, light ? bgL - 0.02 : bgL + 0.025);
  const uiBorder = H(baseHue, clamp(sat * 0.35 + 0.08, 0, 0.4), light ? lerp(0.66, 0.82, bright) : lerp(0.28, 0.4, bright));

  const mainL = light ? lerp(0.34, 0.16, contrast) : lerp(0.74, 0.92, contrast);
  const mainS = clamp(0.05 + (1 - humid) * 0.06, 0, 0.16);
  const mainText = H(baseHue, mainS, mainL);

  const aSat = clamp(lerp(0.18, 0.62, sat) * lerp(1, 0.72, humid) + fant * 0.12, 0, 0.85);
  const aLgt = light ? lerp(0.70, 0.56, contrast) : lerp(0.58, 0.72, contrast);
  const sigHue = baseHue + 22 + fant * 14;                          // 같은 세계관 내 약한 시프트 (보색 아님)
  const italicsText = H(sigHue, aSat, aLgt);
  const underlineText = H(baseHue + 34, aSat * 0.62, aLgt * 0.97);
  const quoteText = lockBlue ? H(212, 0.30, 0.64) : H(baseHue + 170, aSat * 0.7, aLgt);

  const shadow = toRgba({ r: 14, g: 14, b: 18, a: lerp(0.25, 0.6, contrast) });
  const userMesTint = H(baseHue + 8, clamp(0.18 + sat * 0.14, 0, 0.42), light ? 0.95 : 0.32, 0.5);
  const aiMesTint = H(baseHue - 30, clamp(0.20 + sat * 0.14, 0, 0.42), light ? 0.965 : 0.28, 0.5);

  const dialogueColor = H(baseHue, clamp(mainS + 0.07, 0, 0.22), light ? 0.20 : 0.86);
  // 형광펜 = 보색 아님. 시그니처에서 명도+ 채도- → 같은 무드의 '가장 밝은 색'
  const quoteHighlight = H(sigHue, clamp(aSat - 0.30, 0.08, 0.5), clamp(aLgt + 0.20, 0, 0.92), 0.4);

  return guard({ mainText, italicsText, underlineText, quoteText, shadow, chatBg, uiBg, uiBorder, userMesTint, aiMesTint, dialogueColor, quoteHighlight });
}
function liftToLum(c, t) { let { h, s, l } = rgbToHsl(c.r, c.g, c.b); let rgb = { ...c }, g = 0; while (relLum(rgb) < t && l < 0.95 && g < 60) { l += 0.015; rgb = { ...hslToRgb(h, s, l), a: c.a }; g++; } return rgb; }
function guard(c) {
  const out = { ...c }; const bg = parseColor(out.chatBg); const light = relLum(bg) > 0.5;
  ["italicsText", "underlineText", "quoteText"].forEach(k => { const p = parseColor(out[k]); const { s } = rgbToHsl(p.r, p.g, p.b); if (light && s > 0.40 && relLum(p) < 0.28) out[k] = toRgba({ ...liftToLum(p, 0.28), a: p.a }); });
  let mc = parseColor(out.mainText); let g = 0; while (contrast(mc, bg) < 6 && g < 60) { let { h, s, l } = rgbToHsl(mc.r, mc.g, mc.b); l = light ? Math.max(0, l - 0.02) : Math.min(1, l + 0.02); mc = { ...hslToRgb(h, s, l), a: mc.a }; g++; } out.mainText = toRgba(mc);
  ["userMesTint", "aiMesTint"].forEach(k => { const p = parseColor(out[k]); if (p.a > 0.45) p.a = 0.45; out[k] = toRgba(p); });
  return out;
}

/* ───────── Object 모드: 소재 범위 → 추출 → 하모나이저 → 무드 → 형광펜 ───────── */
const RANGES = {
  "말차":{hue:[78,98],sat:[.20,.40],light:[.55,.72]},"녹차":{hue:[78,98],sat:[.20,.40],light:[.55,.72]},
  "딸기":{hue:[342,358],sat:[.45,.68],light:[.60,.74]},"베리":{hue:[330,350],sat:[.40,.62],light:[.45,.62]},
  "크림":{hue:[36,48],sat:[.18,.34],light:[.88,.96]},"우유":{hue:[40,60],sat:[.06,.16],light:[.90,.97]},
  "블루베리":{hue:[225,250],sat:[.28,.46],light:[.45,.62]},
  "라벤더":{hue:[255,278],sat:[.25,.45],light:[.62,.78]},"보라":{hue:[265,290],sat:[.30,.52],light:[.50,.68]},
  "복숭아":{hue:[14,30],sat:[.45,.68],light:[.70,.84]},"코랄":{hue:[8,22],sat:[.55,.75],light:[.62,.74]},
  "레몬":{hue:[48,58],sat:[.45,.70],light:[.60,.78]},"버터":{hue:[42,52],sat:[.30,.50],light:[.72,.86]},"꿀":{hue:[34,44],sat:[.45,.65],light:[.55,.70]},
  "민트":{hue:[140,165],sat:[.22,.42],light:[.66,.80]},"세이지":{hue:[80,105],sat:[.14,.30],light:[.62,.76]},
  "갈색":{hue:[22,38],sat:[.30,.55],light:[.26,.42]},"우드":{hue:[24,40],sat:[.28,.48],light:[.34,.50]},"초콜릿":{hue:[18,32],sat:[.30,.50],light:[.18,.30]},
  "남색":{hue:[210,230],sat:[.40,.65],light:[.24,.40]},"네이비":{hue:[210,230],sat:[.40,.65],light:[.24,.40]},"바다":{hue:[190,215],sat:[.35,.55],light:[.36,.52]},
  "잔디":{hue:[95,120],sat:[.35,.55],light:[.36,.52]},"잔디색":{hue:[95,120],sat:[.35,.55],light:[.36,.52]},"숲":{hue:[110,140],sat:[.30,.50],light:[.28,.44]},"녹색":{hue:[100,130],sat:[.35,.55],light:[.38,.55]},
  "노을":{hue:[8,38],sat:[.45,.78],light:[.52,.72]},"하늘":{hue:[200,220],sat:[.30,.50],light:[.66,.82]},"서리":{hue:[195,225],sat:[.06,.18],light:[.80,.92]},
  "장미":{hue:[340,355],sat:[.40,.62],light:[.45,.62]},"와인":{hue:[338,352],sat:[.40,.60],light:[.26,.40]},
  "먹구름":{hue:[205,255],sat:[.10,.32],light:[.32,.62]},
  "달빛":{hue:[250,275],sat:[.20,.38],light:[.66,.82]},"밤":{hue:[230,255],sat:[.25,.45],light:[.20,.34]},
};
const ALIAS = {matcha:"말차",strawberry:"딸기",cream:"크림",milk:"우유",blueberry:"블루베리",lavender:"라벤더",peach:"복숭아",lemon:"레몬",mint:"민트",brown:"갈색",navy:"남색",grass:"잔디",sunset:"노을",rose:"장미",moonlight:"달빛"};
const rnd = (a, b) => a + Math.random() * (b - a);
const sampleRange = r => ({ h: rnd(r.hue[0], r.hue[1]), s: rnd(r.sat[0], r.sat[1]), l: rnd(r.light[0], r.light[1]) });
const tokenize = str => str.split(/[\s,/]+/).map(t => t.trim()).filter(Boolean);

// 밴드 하모나이저: 채도=좁은 밴드(톤 통일), 명도=순위보존 밴드(개성 유지, 한 점 수렴 금지)
function harmonizeBand(hexes, strength) {
  const S = strength / 100, C = 0.35, Hf = 0.05, Lmin = 0.50, Lmax = 0.80;
  const hsl = hexes.map(hx => { const p = parseColor(hx); return rgbToHsl(p.r, p.g, p.b); });
  const order = hsl.map((c, i) => ({ i, l: c.l })).sort((a, b) => a.l - b.l);
  const rk = {}; order.forEach((o, idx) => rk[o.i] = hsl.length > 1 ? idx / (hsl.length - 1) : 0.5);
  return hsl.map((c, i) => {
    const st = clamp(c.s, C - Hf, C + Hf);
    return { h: c.h * 360, s: lerp(c.s, st, S), l: lerp(c.l, lerp(Lmin, Lmax, rk[i]), S) };
  });
}
// 가중 역할 배정 (고정 X, 조화로운 방향으로 순환)
function assignRoles(srcs) {
  const jit = () => rnd(-0.06, 0.06);
  const bgS = srcs.map(c => c.l + jit()), txtS = srcs.map(c => (1 - c.l) + jit()), ptS = srcs.map(c => c.s + jit());
  const bg = bgS.indexOf(Math.max(...bgS));
  let txt = txtS.indexOf(Math.max(...txtS)); if (txt === bg) { const t = [...txtS]; t[bg] = -9; txt = t.indexOf(Math.max(...t)); }
  let pt = ptS.indexOf(Math.max(...ptS)); if (pt === bg || pt === txt) { const t = [...ptS]; t[bg] = -9; t[txt] = -9; pt = t.indexOf(Math.max(...t)); }
  const used = new Set([bg, txt, pt]); let second = srcs.findIndex((_, i) => !used.has(i)); if (second < 0) second = txt;
  return { bg, txt, pt, second };
}
// 무드 판정 → 형광펜 타입 + 폰트 (색 분포 기반, AI 없이). 다이스마다 재판정 = 다양성.
function judgeMood(srcs) {
  const avgS = srcs.reduce((a, c) => a + c.s, 0) / srcs.length;
  const avgL = srcs.reduce((a, c) => a + c.l, 0) / srcs.length;
  const maxS = Math.max(...srcs.map(c => c.s));
  const warm = srcs.filter(c => c.h < 60 || c.h > 330).length / srcs.length;
  const cool = srcs.filter(c => c.h >= 180 && c.h <= 285).length / srcs.length;
  if (avgS > 0.55 || (maxS > 0.75 && avgL < 0.6)) return { mood: "Neon", hl: "Neon", font: "cyber" };
  if (warm >= 0.5 && avgS >= 0.30 && avgS <= 0.55 && avgL >= 0.42 && avgL <= 0.66) return { mood: "Vintage", hl: "Vintage", font: "literary" };
  if (cool >= 0.4 || avgL < 0.5) return { mood: "Melancholy", hl: "Dialogue", font: "literary" };
  return { mood: "Cozy", hl: "Romantic", font: "cozy" };
}
// 형광펜 4타입: 진한 씨앗색을 배경에 타되, 타입마다 배경비율·글자 다름
function makeHighlight(type, point, mainHex, bgHex) {
  const seed = hslToRgb(((point.h % 360) + 360) % 360 / 360, Math.max(point.s, 0.5), 0.55), bg = parseColor(bgHex);
  const mixc = w => toRgba({ r: seed.r * w + bg.r * (1 - w), g: seed.g * w + bg.g * (1 - w), b: seed.b * w + bg.b * (1 - w), a: 0.72 });
  switch (type) {
    case "Dialogue": return { bg: mixc(0.20), txt: mainHex };
    case "Vintage": return { bg: mixc(0.15), txt: H(point.h, point.s * 0.7, 0.30) };
    case "Neon": return { bg: mixc(0.38), txt: H(point.h, Math.min(point.s + 0.2, 1), 0.28) };
    default: return { bg: mixc(0.18), txt: H(point.h, point.s, 0.40) }; // Romantic
  }
}
// 무드별 폰트 tag → FONTS 매핑
function fontByTag(tag) { return FONTS.find(f => f.tag === tag) || FONTS[3]; }

// Object 상태
let objTokens = [], objSources = [], objRoles = null, objMood = { mood: "Cozy", hl: "Romantic", font: "cozy" };

async function objResolve(tokens) {
  const out = [], missing = [];
  for (const t of tokens) {
    const key = ALIAS[t.toLowerCase()] || t;
    if (RANGES[key]) out.push({ token: t, range: RANGES[key], from: "사전" });
    else if (/^#?[0-9a-f]{3,6}$/i.test(t)) { const p = parseColor(t[0] === "#" ? t : "#" + t); const c = rgbToHsl(p.r, p.g, p.b); out.push({ token: t, range: { hue: [c.h * 360, c.h * 360], sat: [c.s, c.s], light: [c.l, c.l] }, from: "직접" }); }
    else { out.push({ token: t, range: null, from: "AI" }); missing.push(t); }
  }
  if (missing.length && settings().aiInPanel) {
    try {
      const prompt = `각 소재를 색 하나가 아니라 '색상 범위'로. 같은 소재도 상황 따라 다르니 hue(0-360)/sat(0-1)/light(0-1)를 [min,max]로.
소재: ${missing.join(", ")}
JSON만: {"소재명":{"hue":[min,max],"sat":[min,max],"light":[min,max]}, ...}`;
      const text = await callAI(prompt);
      const j = JSON.parse(String(text).replace(/```json|```/g, "").trim());
      out.forEach(o => { if (!o.range && j[o.token]) o.range = j[o.token]; });
    } catch (e) { toast("AI 추출 실패: " + e.message); }
  }
  out.forEach(o => { if (!o.range) o.range = { hue: [40, 50], sat: [.05, .12], light: [.55, .65] }; });
  return out;
}

// 🎲 한 판: 범위 추출 + 역할 + 무드 재판정 (다이스/생성이 호출)
function objRoll() {
  if (!objTokens.length) return;
  objSources = objTokens.map(tk => { const c = sampleRange(tk.range); return { token: tk.token, from: tk.from, h: c.h, s: c.s, l: c.l, hex: H(c.h, c.s, c.l) }; });
  objRoles = assignRoles(objSources);
  objMood = judgeMood(objSources);
  curFont = fontByTag(objMood.font);     // 무드 → 폰트 자동
  objRenderSources();
  objBuildPalette();
}

// 하모나이저(추출색만) + 역할 고정 → 12슬롯. 슬라이더가 이걸 재호출(역할 안 바뀜).
function objBuildPalette() {
  if (!objSources.length || !objRoles) return;
  const strength = +(document.getElementById("tg-harm")?.value ?? 85);
  const harm = harmonizeBand(objSources.map(s => s.hex), strength);
  const lightest = harm[objRoles.bg], deepest = harm[objRoles.txt], point = harm[objRoles.pt], second = harm[objRoles.second];

  const chatBg = H(lightest.h, clamp(lightest.s * 0.4, 0, 0.10), 0.975);
  const uiBg = H(lightest.h, clamp(lightest.s * 0.45, 0, 0.12), 0.955);
  const uiBorder = H(second.h, clamp(second.s * 0.5, 0.1, 0.3), 0.78);
  const baseMain = H(deepest.h, clamp(deepest.s * 0.4, 0.04, 0.18), 0.22);
  const italicsText = H(point.h, point.s, point.l);
  const underlineText = H(second.h, second.s * 0.8, point.l * 0.97);
  const quoteText = H(212, 0.30, 0.64);
  const hl = makeHighlight(objMood.hl, point, baseMain, chatBg);
  const quoteHighlight = hl.bg;
  const dialogueColor = hl.txt;
  const shadow = "rgba(14,14,18,0.45)";
  const userMesTint = H(point.h, 0.20, 0.95, 0.4);
  const aiMesTint = H(lightest.h, 0.22, 0.97, 0.4);

  let c = { mainText: baseMain, italicsText, underlineText, quoteText, shadow, chatBg, uiBg, uiBorder, userMesTint, aiMesTint, dialogueColor, quoteHighlight };
  let mc = parseColor(c.mainText), bg = parseColor(c.chatBg), g = 0;
  while (contrast(mc, bg) < 6 && g < 60) { const h = rgbToHsl(mc.r, mc.g, mc.b); mc = { ...hslToRgb(h.h, h.s, Math.max(0, h.l - 0.02)), a: 1 }; g++; }
  c.mainText = toRgba(mc);
  curName = `🍵 ${objTokens.map(t => t.token).join(" ")} · ${objMood.mood}`;
  const badge = document.getElementById("tg-obj-badge"); if (badge) badge.textContent = `Mood: ${objMood.mood} · 형광펜 ${objMood.hl} · 폰트 ${objMood.font}`;
  render(c);
}
function objRenderSources() {
  const box = document.getElementById("tg-obj-sources"); if (!box) return; box.innerHTML = "";
  objSources.forEach(s => { const el = document.createElement("div"); el.className = "tg-src"; el.innerHTML = `<span class="tg-srcdot" style="background:${s.hex}"></span>${s.token} <span class="tg-srcfrom">${s.from}</span>`; box.appendChild(el); });
}
async function objBuild() {
  const tokens = tokenize(document.getElementById("tg-obj-input").value);
  if (!tokens.length) return;
  toast("소스 색 확보 중…");
  objTokens = await objResolve(tokens);
  objRoll();
  const ai = objTokens.filter(t => t.from === "AI").length;
  toast(`완료 · 소재 ${objTokens.length}개 (사전 ${objTokens.filter(t => t.from === "사전").length}, AI ${ai}) · 🎲로 다른 서사`);
}

/* ───────── 메타데이터 ───────── */
const ROLES = [["mainText", "주요 텍스트"], ["italicsText", "이탤릭체"], ["underlineText", "밑줄"], ["quoteText", "인용"], ["shadow", "그림자"], ["chatBg", "채팅 배경"], ["uiBg", "UI 배경"], ["uiBorder", "UI 테두리"], ["userMesTint", "사용자 틴트"], ["aiMesTint", "AI 틴트"]];
const EXTRAS = [["dialogueColor", "대사색 (커스텀 CSS)"], ["quoteHighlight", "형광펜 (커스텀 CSS)"]];
const tintKeys = ["userMesTint", "aiMesTint", "quoteHighlight"];

// ST 테마 색상 피커 매핑 (네이티브 10슬롯)
const PICKER_MAP = {
  mainText: "main-text-color-picker",
  italicsText: "italics-color-picker",
  underlineText: "underline-color-picker",
  quoteText: "quote-color-picker",
  shadow: "shadow-color-picker",
  chatBg: "chat-tint-color-picker",
  uiBg: "blur-tint-color-picker",
  uiBorder: "border-color-picker",
  userMesTint: "user-mes-blur-tint-color-picker",
  aiMesTint: "bot-mes-blur-tint-color-picker",
};

const FONTS = [
  { n: "📖 문학·습함", tag: "literary", css: "'EB Garamond','Nanum Myeongjo',serif" },
  { n: "🏰 고전 판타지", tag: "fantasy", css: "'Cinzel','Marcellus','Nanum Myeongjo',serif" },
  { n: "🌃 기계·네온", tag: "cyber", css: "'Orbitron','Rajdhani',sans-serif" },
  { n: "☕ 코지", tag: "cozy", css: "'Noto Sans KR',sans-serif" },
];
const PRESETS = [
  { n: "🍓 딸기우유", c: { mainText: "#4A4043", italicsText: "#D8A2AF", underlineText: "#B88A96", quoteText: "#8FA6C4", shadow: "#101010", chatBg: "#FFF9FA", uiBg: "#FFF4F6", uiBorder: "#D9BCC4", userMesTint: "rgba(255,247,248,0.5)", aiMesTint: "rgba(255,253,253,0.5)", dialogueColor: "#3A3033", quoteHighlight: "rgba(233,204,214,0.4)" } },
  { n: "🍋 레몬 파운드", c: { mainText: "#494233", italicsText: "#D6B85E", underlineText: "#C7B04A", quoteText: "#8DA8C5", shadow: "#101010", chatBg: "#FFFDF4", uiBg: "#FFF9E9", uiBorder: "#E4D79C", userMesTint: "rgba(255,249,233,0.5)", aiMesTint: "rgba(255,253,244,0.5)", dialogueColor: "#3A3320", quoteHighlight: "rgba(255,232,135,0.35)" } },
  { n: "☕ 티라미수", c: { mainText: "#46372F", italicsText: "#B9967A", underlineText: "#8E6F5D", quoteText: "#8DA8C5", shadow: "#101010", chatBg: "#FAF6F1", uiBg: "#F2EBE4", uiBorder: "#CBB6A5", userMesTint: "rgba(242,235,228,0.5)", aiMesTint: "rgba(250,246,241,0.5)", dialogueColor: "#2F231C", quoteHighlight: "rgba(220,180,135,0.3)" } },
  { n: "🍵 말차딸기", c: { mainText: "#3F433E", italicsText: "#D6A3AF", underlineText: "#B58C97", quoteText: "#8CA5BF", shadow: "#101010", chatBg: "#FCFCF8", uiBg: "#F7F8F2", uiBorder: "#B9C5B0", userMesTint: "rgba(244,248,240,0.5)", aiMesTint: "rgba(255,248,250,0.5)", dialogueColor: "#2F372D", quoteHighlight: "rgba(233,204,214,0.4)" } },
  { n: "🫐 블루베리 요거트", c: { mainText: "#3F4252", italicsText: "#A9A3D8", underlineText: "#8F97C4", quoteText: "#8F97C4", shadow: "#101010", chatBg: "#FBFBFD", uiBg: "#F3F4FA", uiBorder: "#C4C8DD", userMesTint: "rgba(243,244,250,0.5)", aiMesTint: "rgba(251,251,253,0.5)", dialogueColor: "#262838", quoteHighlight: "rgba(170,182,217,0.35)" } },
];

/* ───────── 상태 ───────── */
let curColors = null, curName = "무드 축", curFont = FONTS[0], lockBlue = true;
function readDNA() { const d = {}; document.querySelectorAll("#tg-axes input").forEach(i => d[i.dataset.k] = +i.value); return d; }
function recompute() { curName = "무드 축"; render(engine(readDNA(), lockBlue)); }

/* ───────── AI: 텍스트 → 축 ───────── */
async function callAI(prompt) {
  const ctx = getContext();
  const id = settings().profile;
  // [VERIFY] 연결 프로필 사용. 버전에 따라 서비스 이름이 다를 수 있음.
  try {
    if (id && ctx.ConnectionManagerRequestService?.sendRequest) {
      const r = await ctx.ConnectionManagerRequestService.sendRequest(id, prompt, 400);
      return typeof r === "string" ? r : (r?.content ?? "");
    }
  } catch (e) { console.warn("[theme-gen] profile request failed, falling back:", e); }
  // 폴백: 현재 API로 quiet 생성
  return await ctx.generateQuietPrompt(prompt, false, false);
}
async function extractAxes(mood) {
  const prompt = `다음 장면/무드를 색이 아니라 '무드 축' 6개로 분해해라. 각 0~100 정수.
- temperature: 0=차갑다 ~ 100=따뜻하다
- humidity: 0=건조/또렷 ~ 100=습하고 뿌옇다
- brightness: 0=어둡다(다크) ~ 100=밝다(라이트)
- saturation: 0=차분 ~ 100=선명
- contrast: 0=부드럽다 ~ 100=또렷하다
- fantasy: 0=현실 ~ 100=환상(보랏빛/비현실)
장면: "${mood}"
JSON만: {"temperature":..,"humidity":..,"brightness":..,"saturation":..,"contrast":..,"fantasy":..}`;
  const text = await callAI(prompt);
  const j = JSON.parse(String(text).replace(/```json|```/g, "").trim());
  const map = { temp: j.temperature, humid: j.humidity, bright: j.brightness, sat: j.saturation, contrast: j.contrast, fantasy: j.fantasy };
  document.querySelectorAll("#tg-axes input").forEach(i => { if (map[i.dataset.k] != null) i.value = clamp(map[i.dataset.k], 0, 100); });
  updateEnds(); recompute();
  toast(`축 추출됨 · 온${j.temperature} 습${j.humidity} 명${j.brightness} 채${j.saturation} 대${j.contrast} 환${j.fantasy}`);
}

/* ───────── 적용(주입) ───────── */
function applyToST(c) {
  // 네이티브 10슬롯 → 테마 색상 피커
  for (const [k, id] of Object.entries(PICKER_MAP)) {
    const picker = document.getElementById(id);
    if (!picker) continue;
    const rgba = fmtVal(c[k]).startsWith("#") ? toRgba(parseColor(c[k])) : c[k]; // 피커는 rgba 권장
    try { picker.color = rgba; } catch (e) { }
    picker.dispatchEvent(new CustomEvent("change", { detail: { rgba } }));
  }
  // 커스텀: 대사색 + 형광펜 + 폰트
  let css = `.mes_text q{ color:${fmtVal(c.dialogueColor)} !important; background:${fmtVal(c.quoteHighlight)} !important; border-radius:6px; padding:0 6px; }`;
  if (curFont) css += `\n#chat .mes_text, #chat .mes .ch_name{ font-family:${curFont.css} !important; }`;
  let st = document.getElementById("theme-gen-custom-style");
  if (!st) { st = document.createElement("style"); st.id = "theme-gen-custom-style"; document.head.appendChild(st); }
  st.textContent = css;
  toast("ST에 적용됨.");
}

/* ───────── 렌더 ───────── */
function render(c) { curColors = c; buildGrid(c); paintPreview(c); }
function buildGrid(c) {
  const grid = document.getElementById("tg-grid"); if (!grid) return; grid.innerHTML = "";
  const mk = (k, label, custom) => {
    const v = c[k] || "rgba(0,0,0,0)";
    const el = document.createElement("div"); el.className = "tg-swatch" + (custom ? " tg-custom" : "");
    if (tintKeys.includes(k)) el.innerHTML = `<span class="tg-chip"><i style="background:${flatten(v, c.chatBg)}"></i></span><span class="tg-meta"><div class="tg-role">${label}</div><input class="tg-val" data-k="${k}" value="${fmtVal(v)}"></span>`;
    else el.innerHTML = `<input type="color" class="tg-chipc" data-k="${k}" value="${toHex(v)}"><span class="tg-meta"><div class="tg-role">${label}</div><input class="tg-val" data-k="${k}" value="${fmtVal(v)}"></span>`;
    grid.appendChild(el);
  };
  ROLES.forEach(([k, l]) => mk(k, l, false));
  const sep = document.createElement("div"); sep.className = "tg-sep"; sep.textContent = "↓ 커스텀 CSS (네이티브 슬롯 아님)"; grid.appendChild(sep);
  EXTRAS.forEach(([k, l]) => mk(k, l, true));
}
function paintPreview(c) {
  const pv = document.getElementById("tg-pv"); if (!pv) return;
  pv.style.background = c.chatBg;
  pv.querySelector(".tg-ai").style.background = c.aiMesTint;
  pv.querySelector(".tg-user").style.background = c.userMesTint;
  pv.querySelectorAll(".tg-name,.tg-time,.tg-p").forEach(el => { el.style.color = c.mainText; el.style.textShadow = `0 1px 2px ${c.shadow}`; el.style.fontFamily = curFont.css; });
  pv.querySelectorAll(".tg-div").forEach(d => d.style.background = c.uiBorder);
  pv.querySelectorAll(".tg-em").forEach(e => e.style.color = c.italicsText);
  pv.querySelectorAll(".tg-u").forEach(u => u.style.color = c.underlineText);
  pv.querySelectorAll(".tg-q").forEach(q => { q.style.color = c.dialogueColor; q.style.background = c.quoteHighlight; q.style.fontFamily = curFont.css; });
}

const AXES = [["temp", "차가움", "따뜻함", 65], ["humid", "건조", "습함", 35], ["bright", "어두움", "밝음", 90], ["sat", "차분", "선명", 45], ["contrast", "부드러움", "또렷함", 50], ["fantasy", "현실", "환상", 20]];
function updateEnds() { document.querySelectorAll("#tg-axes .tg-axis").forEach(ax => { const v = +ax.querySelector("input").value; ax.querySelector(".lo").classList.toggle("on", v < 45); ax.querySelector(".hi").classList.toggle("on", v > 55); }); }

let toastTimer;
function toast(msg) { const t = document.getElementById("tg-status"); if (!t) return; t.textContent = msg; clearTimeout(toastTimer); }

/* ───────── 라이브러리 ───────── */
function saveToLibrary() {
  if (!curColors) return;
  settings().library.unshift({ id: Date.now(), name: curName, font: curFont.tag, colors: { ...curColors } });
  save(); renderLibrary(); toast("라이브러리에 저장됨.");
}
function renderLibrary() {
  const list = document.getElementById("tg-lib"); if (!list) return;
  const lib = settings().library;
  document.getElementById("tg-lib-count").textContent = lib.length;
  if (!lib.length) { list.innerHTML = `<div class="tg-empty">팔레트를 💾로 저장하면 여기 쌓여.</div>`; return; }
  const STRIP = ["chatBg", "mainText", "italicsText", "quoteText", "uiBorder", "quoteHighlight"];
  list.innerHTML = "";
  lib.forEach(bm => {
    const cells = STRIP.map(k => `<span style="background:${flatten(bm.colors[k] || "transparent", bm.colors.chatBg || "#fff")}"></span>`).join("");
    const item = document.createElement("div"); item.className = "tg-libitem";
    item.innerHTML = `<div class="tg-strip">${cells}</div><div class="tg-libname">${bm.name}<small> · ${bm.font || ""}</small></div><button class="tg-lbtn apply">적용</button><button class="tg-lbtn load">불러오기</button><button class="tg-lbtn x">✕</button>`;
    item.querySelector(".apply").addEventListener("click", () => { applyToST(bm.colors); });
    item.querySelector(".load").addEventListener("click", () => { curName = bm.name; const f = FONTS.find(x => x.tag === bm.font); if (f) curFont = f; render(bm.colors); toast(`불러옴 · ${bm.name}`); });
    item.querySelector(".x").addEventListener("click", () => { const i = lib.findIndex(b => b.id === bm.id); if (i > -1) lib.splice(i, 1); save(); renderLibrary(); });
    list.appendChild(item);
  });
}

/* ───────── 패널 UI ───────── */
function panelHTML() {
  const axes = AXES.map(([k, lo, hi, v]) => `<div class="tg-axis"><div class="tg-ends"><span class="lo">${lo}</span><span class="hi">${hi}</span></div><input type="range" min="0" max="100" value="${v}" data-k="${k}"></div>`).join("");
  const fonts = FONTS.map((f, i) => `<button class="tg-pill" data-font="${i}">${f.n}</button>`).join("");
  const presets = PRESETS.map((p, i) => `<button class="tg-pill" data-preset="${i}">${p.n}</button>`).join("");
  const OBJ_RECIPES = ["먹구름 노을 서리", "말차 딸기 크림", "블루베리 우유 크림", "라벤더 달빛 밤", "복숭아 크림 하늘", "레몬 버터 꿀", "와인 먹구름 서리", "갈색 남색 잔디"];
  const objChips = OBJ_RECIPES.map(r => `<button class="tg-pill" data-objrecipe="${r}">${r}</button>`).join("");
  return `
  <div id="tg-panel-inner">
    <div class="tg-bar"><b>🌧️ 테마 생성기</b> <span class="tg-ver">v${VERSION}</span> <span id="tg-close">✕</span></div>

    <div class="tg-tabs">
      <button class="tg-tab on" data-tab="mood">🌧️ Mood</button>
      <button class="tg-tab" data-tab="object">🍵 Object</button>
    </div>

    <div class="tg-pane" data-pane="mood">
      <label class="tg-sw"><input type="checkbox" id="tg-ai-toggle"><span class="tg-track"></span><span>AI 연결 (텍스트 → 축 추출)</span></label>
      <div id="tg-ai-row" class="tg-airow tg-hidden">
        <input id="tg-mood" placeholder="장면을 적어 (예: 비 온 뒤 저녁, 젖은 도로)">
        <button id="tg-extract">추출</button>
      </div>

      <p class="tg-label">디저트 프리셋</p>
      <div class="tg-pills">${presets}</div>

      <p class="tg-label">글꼴 (무드)</p>
      <div class="tg-pills">${fonts}</div>

      <p class="tg-label">무드 축</p>
      <div id="tg-axes">${axes}</div>
      <label class="tg-sw"><input type="checkbox" id="tg-lockblue" checked><span class="tg-track"></span><span>인용 = 차가운 블루</span></label>
    </div>

    <div class="tg-pane tg-hidden" data-pane="object">
      <p class="tg-label">소재 / 색 (띄어쓰기로)</p>
      <div class="tg-objrow">
        <input id="tg-obj-input" placeholder="예: 먹구름 노을 서리 / 말차 딸기 크림" value="먹구름 노을 서리">
        <button id="tg-obj-build">생성</button>
      </div>
      <p class="tg-hint">소재 = 색상 범위. 매번 다르게 추출돼서 같은 입력도 다른 서사. 🎲로 다시 굴려.</p>

      <p class="tg-label" style="display:flex;align-items:center;gap:8px">소스 색 <button id="tg-obj-dice">🎲 다시 뽑기</button> <span id="tg-obj-badge" class="tg-objbadge"></span></p>
      <div class="tg-sources" id="tg-obj-sources"></div>

      <div class="tg-harm">
        <div class="tg-harmtop"><span>어우러짐 강도</span><span id="tg-harm-v">85</span></div>
        <input type="range" id="tg-harm" min="0" max="100" value="85">
        <div class="tg-harmend"><span>날것</span><span>한 가족</span></div>
      </div>
      <div class="tg-objchips">${objChips}</div>
    </div>

    <div id="tg-status" class="tg-status">　</div>

    <div class="tg-preview" id="tg-pv">
      <div class="tg-mes tg-ai"><div class="tg-name">캐릭터</div><div class="tg-time">미리보기</div><div class="tg-div"></div>
        <div class="tg-body"><p class="tg-p">시저는 몸을 일으켜 미소 지었다. <span class="tg-em">젖은 셔츠가 등에 달라붙었다.</span></p><p class="tg-q">"미안, 태클인 줄 알았어."</p><p class="tg-p"><span class="tg-u">공기가 팽팽해졌다.</span></p></div></div>
      <div class="tg-mes tg-user"><div class="tg-name">나</div><div class="tg-div"></div><div class="tg-body"><p class="tg-p">진정해, 아직 1쿼터야.</p></div></div>
    </div>

    <p class="tg-label">팔레트 — 색칩/값 직접 수정</p>
    <div class="tg-grid" id="tg-grid"></div>

    <div class="tg-actions">
      <button id="tg-apply" class="tg-primary">ST에 적용</button>
      <button id="tg-save">💾 저장</button>
      <button id="tg-copy">JSON</button>
      <button id="tg-copycss">CSS</button>
    </div>

    <p class="tg-label">저장된 팔레트 <span class="count" id="tg-lib-count">0</span></p>
    <div id="tg-lib"></div>
  </div>`;
}

function wirePanel() {
  const p = document.getElementById("theme-gen-panel");
  p.querySelector("#tg-close").addEventListener("click", () => p.classList.add("tg-hidden"));

  // AI 토글
  const aiToggle = p.querySelector("#tg-ai-toggle");
  aiToggle.checked = settings().aiInPanel;
  p.querySelector("#tg-ai-row").classList.toggle("tg-hidden", !aiToggle.checked);
  aiToggle.addEventListener("change", () => { settings().aiInPanel = aiToggle.checked; save(); p.querySelector("#tg-ai-row").classList.toggle("tg-hidden", !aiToggle.checked); });
  p.querySelector("#tg-extract").addEventListener("click", async () => {
    const m = p.querySelector("#tg-mood").value.trim(); if (!m) return;
    p.querySelector("#tg-extract").disabled = true; toast("축 추출 중…");
    try { await extractAxes(m); } catch (e) { toast("실패: " + e.message); } finally { p.querySelector("#tg-extract").disabled = false; }
  });

  // 프리셋 / 폰트
  p.querySelectorAll("[data-preset]").forEach(b => b.addEventListener("click", () => { const pr = PRESETS[+b.dataset.preset]; render(pr.c); curName = pr.n; toast(`프리셋 · ${pr.n}`); }));
  p.querySelectorAll("[data-font]").forEach(b => b.addEventListener("click", () => { curFont = FONTS[+b.dataset.font]; paintPreview(curColors); toast(`글꼴 · ${curFont.tag}`); }));

  // 축 / 블루
  p.querySelector("#tg-axes").addEventListener("input", () => { updateEnds(); recompute(); });
  p.querySelector("#tg-lockblue").addEventListener("change", e => { lockBlue = e.target.checked; recompute(); });

  // 탭 전환
  p.querySelectorAll(".tg-tab").forEach(t => t.addEventListener("click", () => {
    p.querySelectorAll(".tg-tab").forEach(x => x.classList.toggle("on", x === t));
    const tab = t.dataset.tab;
    p.querySelectorAll(".tg-pane").forEach(pane => pane.classList.toggle("tg-hidden", pane.dataset.pane !== tab));
    if (tab === "object" && !objTokens.length) objBuild();   // 첫 진입 시 자동 생성(랜덤)
  }));

  // Object 모드
  p.querySelector("#tg-obj-build").addEventListener("click", objBuild);
  p.querySelector("#tg-obj-input").addEventListener("keydown", e => { if (e.key === "Enter") objBuild(); });
  p.querySelector("#tg-obj-dice").addEventListener("click", objRoll);
  p.querySelector("#tg-harm").addEventListener("input", e => { p.querySelector("#tg-harm-v").textContent = e.target.value; if (objSources.length) objBuildPalette(); });
  p.querySelectorAll("[data-objrecipe]").forEach(b => b.addEventListener("click", () => { p.querySelector("#tg-obj-input").value = b.dataset.objrecipe; objBuild(); }));

  // 수동 편집
  const grid = p.querySelector("#tg-grid");
  grid.addEventListener("input", e => {
    if (!e.target.classList.contains("tg-chipc") || !curColors) return;
    const k = e.target.dataset.k; const a = parseColor(curColors[k]).a ?? 1;
    curColors[k] = toRgba({ ...parseColor(e.target.value), a });
    e.target.closest(".tg-swatch").querySelector(".tg-val").value = fmtVal(curColors[k]);
    if (curName === "무드 축") curName = "수동 편집"; paintPreview(curColors);
  });
  grid.addEventListener("change", e => {
    if (!e.target.classList.contains("tg-val") || !curColors) return;
    const k = e.target.dataset.k; curColors[k] = e.target.value.trim(); e.target.value = fmtVal(curColors[k]);
    const row = e.target.closest(".tg-swatch"); const ci = row.querySelector(".tg-chipc"); if (ci) ci.value = toHex(curColors[k]);
    const ti = row.querySelector(".tg-chip i"); if (ti) ti.style.background = flatten(curColors[k], curColors.chatBg);
    if (curName === "무드 축") curName = "수동 편집"; paintPreview(curColors);
  });

  // 액션
  p.querySelector("#tg-apply").addEventListener("click", () => curColors && applyToST(curColors));
  p.querySelector("#tg-save").addEventListener("click", saveToLibrary);
  p.querySelector("#tg-copy").addEventListener("click", () => { if (!curColors) return; const o = {}; Object.keys(curColors).forEach(k => o[k] = fmtVal(curColors[k])); navigator.clipboard.writeText(JSON.stringify(o, null, 2)); toast("JSON 복사됨."); });
  p.querySelector("#tg-copycss").addEventListener("click", () => { if (!curColors) return; navigator.clipboard.writeText(`.mes_text q{ color:${fmtVal(curColors.dialogueColor)} !important; background:${fmtVal(curColors.quoteHighlight)} !important; }`); toast("커스텀 CSS 복사됨."); });

  updateEnds(); recompute(); renderLibrary();
}

function openPanel() {
  let p = document.getElementById("theme-gen-panel");
  if (!p) { p = document.createElement("div"); p.id = "theme-gen-panel"; p.innerHTML = panelHTML(); document.body.appendChild(p); wirePanel(); }
  p.classList.remove("tg-hidden");
}

/* ───────── 설정창 (연결 프로필 + 활성화만) ───────── */
function buildSettings() {
  const s = settings();
  const profiles = (() => { try { return extension_settings.connectionManager?.profiles || []; } catch { return []; } })();
  const opts = `<option value="">(기본 / 현재 API)</option>` + profiles.map(pr => `<option value="${pr.id}" ${pr.id === s.profile ? "selected" : ""}>${pr.name || pr.id}</option>`).join("");
  const html = `
  <div class="theme-gen-settings">
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>🌧️ 테마 생성기</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label class="checkbox_label" for="tg-enabled">
          <input type="checkbox" id="tg-enabled" ${s.enabled ? "checked" : ""}>
          <span>테마 생성기 활성화</span>
        </label>
        <label for="tg-profile">연결 프로필 (AI 추출용)</label>
        <select id="tg-profile" class="text_pole">${opts}</select>
        <div style="margin-top:8px"><button id="tg-open" class="menu_button">🎨 테마 생성기 열기</button></div>
      </div>
    </div>
  </div>`;
  $("#extensions_settings").append(html);

  $("#tg-enabled").on("change", function () { s.enabled = this.checked; save(); });
  $("#tg-profile").on("change", function () { s.profile = this.value; save(); });
  $("#tg-open").on("click", openPanel);
}

/* ───────── 부트 ───────── */
jQuery(async () => {
  settings();
  buildSettings();
  // 확장 메뉴(마법봉)에도 런처 추가
  const launcher = $(`<div id="tg-launch" class="list-group-item flex-container flexGap5" title="테마 생성기"><div class="fa-solid fa-palette extensionsMenuExtensionButton"></div><span>테마 생성기</span></div>`);
  launcher.on("click", openPanel);
  $("#extensionsMenu").append(launcher);
  console.log(`[theme-gen] v${VERSION} loaded`);
});
