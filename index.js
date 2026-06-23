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
const VERSION = "0.3.0-beta";

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

/* ───────── 🌫️ Scene 엔진: 키워드/장면 → 7축 → 색 생성 → 배치 ─────────
 * 철학: AI는 '장면'과 '7축 선택'만(색 절대 안 만짐). 색은 100% 엔진(결정론적).
 * "먹구름"은 태그가 아니라 차가움+습함+흐림+저채도의 조합. 분해해야 무한 조합.
 * 다이스 3단: 🎲장면(전부새로) / 🎲색상(축고정 색만) / 🎲분배(색고정 배치만).
 */
const rnd = (a, b) => a + Math.random() * (b - a);

// 1층 대분류 (7축)
const AX_TEMP = { "차가움": [200, 225], "서늘함": [180, 205], "중립": [150, 210], "따뜻함": [28, 46], "뜨거움": [8, 28] };
const AX_SUN = { "새벽": { dh: +30, baseL: .70 }, "아침": { dh: +8, baseL: .78 }, "정오": { dh: 0, baseL: .82 }, "황혼": { dh: -10, baseL: .55 }, "노을": { dh: -18, baseL: .60 }, "달빛": { dh: +22, baseL: .74 } };
const AX_LAMP = { "없음": { dh: 0, dS: 0, dL: 0 }, "백열등": { dh: -6, dS: +.10, dL: +.04 }, "형광등": { dh: +14, dS: -.08, dL: +.08 }, "네온": { dh: +35, dS: +.30, dL: -.02 } };
const AX_HUM = { "건조": { sM: 1.0, gray: 0, dL: +.02 }, "산뜻": { sM: 1.05, gray: 0, dL: +.04 }, "촉촉": { sM: .78, gray: .10, dL: +.04 }, "습함": { sM: .62, gray: .18, dL: +.02 }, "축축": { sM: .50, gray: .26, dL: 0 } };
const AX_AIR = { "맑음": { gray: 0, dL: +.04 }, "안개": { gray: .20, dL: +.08 }, "먼지": { gray: .16, dL: -.02 }, "연무": { gray: .14, dL: +.05 }, "흐림": { gray: .22, dL: -.02 }, "먹구름": { gray: .24, dL: -.06 } };
const AX_SAT = { "무채": [0, .06], "저채도": [.08, .20], "중채도": [.22, .42], "고채도": [.5, .72], "형광": [.7, .95] };
const AX_MOOD = { "고요": { dS: -.04, dL: +.03 }, "낭만": { dS: +.04, dL: +.02 }, "몽환": { dh: +12, dS: +.02 }, "외로움": { dS: -.06, dL: -.03 }, "포근": { dS: +.02, dL: +.05 }, "물기": { dL: +.06, gray: .05 }, "투명": { dL: +.10, gray: .04 }, "신비": { dh: +18, dS: +.04 }, "불안": { dS: -.05, dL: -.05 }, "활기": { dS: +.12, dL: 0 } };

// 2층 소분류 = 1층 조합 별명 (장면 어휘 + 프리셋). 네 전용 포함.
const SCENE_PRESET = {
  "비온뒤": { 온도: "서늘함", 자연광: "노을", 인공조명: "없음", 습도: "습함", 공기: "흐림", 채도: "저채도", 무드: ["고요"] },
  "새벽냉기": { 온도: "차가움", 자연광: "새벽", 인공조명: "없음", 습도: "촉촉", 공기: "안개", 채도: "저채도", 무드: ["고요", "투명"] },
  "새벽냉장고": { 온도: "차가움", 자연광: "새벽", 인공조명: "형광등", 습도: "촉촉", 공기: "연무", 채도: "저채도", 무드: ["투명", "고요"] },
  "도서관": { 온도: "따뜻함", 자연광: "황혼", 인공조명: "백열등", 습도: "건조", 공기: "먼지", 채도: "중채도", 무드: ["포근"] },
  "젖은아스팔트": { 온도: "차가움", 자연광: "달빛", 인공조명: "백열등", 습도: "축축", 공기: "흐림", 채도: "저채도", 무드: ["외로움"] },
  "먹구름": { 온도: "차가움", 자연광: "황혼", 인공조명: "없음", 습도: "습함", 공기: "먹구름", 채도: "저채도", 무드: ["고요"] },
  "먼지낀유리": { 온도: "중립", 자연광: "정오", 인공조명: "없음", 습도: "건조", 공기: "먼지", 채도: "저채도", 무드: ["외로움"] },
  "흐린하늘": { 온도: "서늘함", 자연광: "정오", 인공조명: "없음", 습도: "촉촉", 공기: "흐림", 채도: "저채도", 무드: ["고요"] },
  "습한저녁": { 온도: "따뜻함", 자연광: "노을", 인공조명: "백열등", 습도: "습함", 공기: "연무", 채도: "중채도", 무드: ["낭만"] },
  "창문물방울": { 온도: "차가움", 자연광: "아침", 인공조명: "없음", 습도: "축축", 공기: "흐림", 채도: "저채도", 무드: ["물기", "고요"] },
  "네온골목": { 온도: "차가움", 자연광: "달빛", 인공조명: "네온", 습도: "촉촉", 공기: "연무", 채도: "고채도", 무드: ["신비"] },
  "숲그늘": { 온도: "서늘함", 자연광: "정오", 인공조명: "없음", 습도: "촉촉", 공기: "맑음", 채도: "중채도", 무드: ["고요"] },
  "카페창가": { 온도: "따뜻함", 자연광: "아침", 인공조명: "백열등", 습도: "건조", 공기: "맑음", 채도: "중채도", 무드: ["포근"] },
  "포도밭오후": { 온도: "뜨거움", 자연광: "정오", 인공조명: "없음", 습도: "건조", 공기: "맑음", 채도: "고채도", 무드: ["활기"] },
  "겨울새벽": { 온도: "차가움", 자연광: "새벽", 인공조명: "없음", 습도: "건조", 공기: "안개", 채도: "저채도", 무드: ["외로움", "투명"] },
  "달빛호수": { 온도: "차가움", 자연광: "달빛", 인공조명: "없음", 습도: "촉촉", 공기: "맑음", 채도: "저채도", 무드: ["신비", "고요"] },
};

// 키워드 본연색 (포인트 전용 — 형광펜/이탤릭). 장면이 색을 지배하고 키워드는 점으로만.
const KW_HUE = { "청포도": [82, 96], "포도": [275, 290], "레몬": [48, 58], "딸기": [344, 358], "민트": [150, 165], "라벤더": [258, 275], "장미": [340, 354], "복숭아": [14, 28], "바다": [195, 215], "숲": [110, 135], "노을": [12, 28], "와인": [340, 352], "꿀": [36, 46], "초콜릿": [20, 32], "하늘": [200, 218], "벚꽃": [344, 356] };
function kwPoint(token) {
  const k = Object.keys(KW_HUE).find(x => token.includes(x));
  const hr = k ? KW_HUE[k] : null;
  const h = hr ? rnd(hr[0], hr[1]) : (Array.from(token).reduce((a, c) => a + c.charCodeAt(0), 0) * 37) % 360;
  const s = rnd(0.34, 0.5), l = rnd(0.62, 0.74);
  return { h, s, l, hex: H(h, s, l), name: colorName(h, s, l), key: token };
}

// 색 이름 풀 (엔진 자산)
function rndName(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function colorName(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const lightT = l >= 0.7, mid = l >= 0.4 && l < 0.7;
  if (s < 0.12) return lightT ? rndName(["얼음 화이트", "유리", "실버", "안개 회색"]) : mid ? rndName(["젖은 콘크리트", "무채 그레이", "흐린 은"]) : rndName(["새벽 그림자", "먹빛 회색", "재"]);
  if (h < 20 || h >= 345) return lightT ? rndName(["연한 코랄", "분홍 안개"]) : mid ? rndName(["노을 코랄", "장미"]) : rndName(["와인", "마른 장미"]);
  if (h < 45) return lightT ? rndName(["햇빛 크림", "살구", "모래"]) : mid ? rndName(["노을 살구", "구운 빵", "황동"]) : rndName(["마른 흙", "갈색 점토"]);
  if (h < 70) return lightT ? rndName(["레몬 아이보리", "버터"]) : mid ? rndName(["꿀", "금빛"]) : rndName(["올리브", "이끼 갈색"]);
  if (h < 100) return lightT ? rndName(["청포도 과육", "연둣빛"]) : mid ? rndName(["풀잎", "청포도 잎"]) : rndName(["깊은 숲", "이끼"]);
  if (h < 160) return lightT ? rndName(["민트", "박하"]) : mid ? rndName(["청록", "에메랄드"]) : rndName(["전나무", "젖은 숲"]);
  if (h < 200) return lightT ? rndName(["하늘 유리", "물안개"]) : mid ? rndName(["바다", "청록 그늘"]) : rndName(["심해", "짙은 청록"]);
  if (h < 240) return lightT ? rndName(["냉장고 블루", "서리 블루", "달빛 은"]) : mid ? rndName(["겨울 유리", "찬 강물", "푸른 밤빛"]) : rndName(["남색", "한밤"]);
  if (h < 285) return lightT ? rndName(["새벽 라벤더", "여명 보라", "라일락"]) : mid ? rndName(["물안개 보라", "몽환 보라"]) : rndName(["짙은 보라", "밤보라"]);
  return lightT ? rndName(["분홍 보라", "연자주"]) : mid ? rndName(["자주", "포도"]) : rndName(["깊은 자주"]);
}

// 한 색 생성 (7축 → hsl). adv = 고급 슬라이더 델타 {dL,dS,dContrast,dFant}
function sceneGenColor(o, adv) {
  let hue = rnd(...(AX_TEMP[o.온도] || AX_TEMP["중립"]));
  const NL = AX_SUN[o.자연광] || AX_SUN["정오"]; hue += NL.dh;
  let l = NL.baseL + rnd(-0.18, 0.14);
  const AL = AX_LAMP[o.인공조명] || AX_LAMP["없음"]; hue += AL.dh; l = clamp(l + AL.dL, .16, .94);
  const hum = AX_HUM[o.습도] || AX_HUM["산뜻"], air = AX_AIR[o.공기] || AX_AIR["맑음"];
  let s = rnd(...(AX_SAT[o.채도] || AX_SAT["중채도"])) * hum.sM + AL.dS;
  let gray = Math.max(hum.gray, air.gray);
  l = clamp(l + hum.dL + air.dL, .16, .94);
  (o.무드 || []).forEach(v => { const d = AX_MOOD[v]; if (!d) return; if (d.dh) hue += d.dh; if (d.dS) s = clamp(s + d.dS, 0, 1); if (d.dL) l = clamp(l + d.dL, .16, .94); if (d.gray) gray = Math.max(gray, d.gray); });
  if (adv) { l = clamp(l + (adv.dL || 0), .12, .96); s = clamp(s + (adv.dS || 0), 0, 1); if (adv.dFant) hue += adv.dFant; }
  s = clamp(s * (1 - gray * .6), 0, 1);
  hue = ((hue % 360) + 360) % 360;
  return { h: hue, s, l, hex: H(hue, s, l), name: colorName(hue, s, l) };
}

// 무드 → 형광펜 타입 + 폰트 (장면 무드축 기반)
function sceneHL(axes) {
  const m = axes.무드 || [];
  if (axes.인공조명 === "네온" || axes.채도 === "형광" || axes.채도 === "고채도") return { hl: "Neon", font: "cyber" };
  if (m.includes("포근") || axes.공기 === "먼지" || (axes.인공조명 === "백열등" && axes.온도 === "따뜻함")) return { hl: "Vintage", font: "literary" };
  if (m.includes("외로움") || m.includes("고요") || axes.온도 === "차가움") return { hl: "Dialogue", font: "literary" };
  return { hl: "Romantic", font: "cozy" };
}
function makeHL(type, point, mainHex, bgHex) {
  const seed = hslToRgb(((point.h % 360) + 360) % 360 / 360, Math.max(point.s, 0.5), 0.55), bg = parseColor(bgHex);
  const mix = w => toRgba({ r: seed.r * w + bg.r * (1 - w), g: seed.g * w + bg.g * (1 - w), b: seed.b * w + bg.b * (1 - w), a: 0.72 });
  switch (type) {
    case "Dialogue": return { bg: mix(0.20), txt: mainHex };
    case "Vintage": return { bg: mix(0.15), txt: H(point.h, point.s * 0.7, 0.30) };
    case "Neon": return { bg: mix(0.38), txt: H(point.h, Math.min(point.s + 0.2, 1), 0.28) };
    default: return { bg: mix(0.18), txt: H(point.h, point.s, 0.40) };
  }
}
const fontByTag = tag => FONTS.find(f => f.tag === tag) || FONTS[3];

// 밴드 하모나이저 (톤 통일, 명도 순위보존)
function harmonizeBand(cols, strength) {
  const S = strength / 100, C = 0.30, Hf = 0.06, Lmin = 0.30, Lmax = 0.88;
  const order = cols.map((c, i) => ({ i, l: c.l })).sort((a, b) => a.l - b.l);
  const rk = {}; order.forEach((o, idx) => rk[o.i] = cols.length > 1 ? idx / (cols.length - 1) : 0.5);
  return cols.map((c, i) => { const st = clamp(c.s, C - Hf, C + Hf); return { h: c.h, s: lerp(c.s, st, S), l: lerp(c.l, lerp(Lmin, Lmax, rk[i]), S), name: c.name }; });
}

/* ── 상태 + 다이스 3단 ── */
let sc = { keywords: "", axes: null, scene: "", sources: [], point: null, roleMap: null, adv: {}, hl: "Romantic", font: "cozy" };

// 키워드/장면 → 축 확보 (AI 또는 프리셋 폴백)
async function sceneResolve(useAI) {
  const kws = (sc.keywords || "").split(/[\s,/]+/).filter(Boolean);
  if (useAI && settings().aiInPanel) {
    try {
      // 1) 장면 생성 (색 금지)
      if (!sc.scene) {
        const sp = `키워드들이 동시에 존재하는 '하나의 장면'을 1~2문장으로 그려라. 색/hex 언급 절대 금지. 온도·습도·빛·공기·시간대가 느껴지게.
키워드: ${kws.join(", ")}
장면만 출력(따옴표 없이):`;
        sc.scene = String(await callAI(sp)).trim().replace(/^["']|["']$/g, "");
      }
      // 2) 장면 → 7축 선택
      const ap = `다음 장면을 7개 축으로 분류해라. 각 축에서 정확히 하나(무드는 1~2개) 골라 JSON만.
온도:[차가움,서늘함,중립,따뜻함,뜨거움] 자연광:[새벽,아침,정오,황혼,노을,달빛] 인공조명:[없음,백열등,형광등,네온] 습도:[건조,산뜻,촉촉,습함,축축] 공기:[맑음,안개,먼지,연무,흐림,먹구름] 채도:[무채,저채도,중채도,고채도,형광] 무드:[고요,낭만,몽환,외로움,포근,물기,투명,신비,불안,활기]
또 키워드 중 '포인트색'으로 쓸 단어 하나(point).
장면: "${sc.scene}"
JSON만: {"온도":"","자연광":"","인공조명":"","습도":"","공기":"","채도":"","무드":[""],"point":""}`;
        const t = String(await callAI(ap)); const m = t.match(/\{[\s\S]*\}/);
        const j = JSON.parse(m ? m[0] : t.replace(/```json|```/g, "").trim());
        sc.axes = { 온도: j.온도, 자연광: j.자연광, 인공조명: j.인공조명, 습도: j.습도, 공기: j.공기, 채도: j.채도, 무드: Array.isArray(j.무드) ? j.무드 : [j.무드].filter(Boolean) };
        sc._pointKw = j.point || kws[kws.length - 1] || "";
        return;
    } catch (e) { console.warn("[theme-gen] Scene AI 실패, 프리셋 폴백:", e); toast("AI 실패 — 기본 장면으로"); }
  }
  // 폴백: 키워드가 프리셋명에 매칭되면 그걸로, 아니면 첫 키워드 해시로 프리셋 랜덤
  const presetKeys = Object.keys(SCENE_PRESET);
  let hit = kws.map(k => presetKeys.find(p => p.includes(k) || k.includes(p))).find(Boolean);
  if (!hit) hit = presetKeys[(kws.join("").length || 1) % presetKeys.length];
  sc.axes = { ...SCENE_PRESET[hit] };
  if (!sc.scene) sc.scene = `${hit} (키워드: ${kws.join(", ") || "랜덤"})`;
  sc._pointKw = kws[kws.length - 1] || "";
}

// 🎲 색상: 축 고정, 색만 다시
function diceColor() {
  if (!sc.axes) return;
  const n = 5;
  sc.sources = Array.from({ length: n }, () => sceneGenColor(sc.axes, sc.adv));
  sc.point = kwPoint(sc._pointKw || "");
  const hf = sceneHL(sc.axes); sc.hl = hf.hl; sc.font = hf.font; curFont = fontByTag(sc.font);
  diceDist();
}
// 🎲 분배: 색 고정, 배치만 다시
function diceDist() {
  if (!sc.sources.length) return;
  const harm = harmonizeBand(sc.sources, +(document.getElementById("sc-harm")?.value ?? 80));
  const jit = () => rnd(-0.05, 0.05);
  const idx = harm.map((_, i) => i);
  const bg = idx.slice().sort((a, b) => (harm[b].l + jit()) - (harm[a].l + jit()))[0];
  const txt = idx.slice().sort((a, b) => (harm[a].l + jit()) - (harm[b].l + jit()))[0];
  let ui = idx.find(i => i !== bg && i !== txt); if (ui == null) ui = bg;
  let border = idx.slice().reverse().find(i => i !== bg && i !== txt && i !== ui); if (border == null) border = ui;
  sc.roleMap = { bg, txt, ui, border, harm };
  scenePaint();
}
// 색 → 12슬롯 배치 + 미리보기
function scenePaint() {
  const { harm, bg, txt, ui, border } = sc.roleMap;
  const lightest = harm[bg], deepest = harm[txt], uiC = harm[ui], borderC = harm[border];
  const point = sc.point;
  const chatBg = H(lightest.h, clamp(lightest.s * 0.5, 0, 0.12), clamp(lightest.l + 0.12, 0.93, 0.985));
  const uiBg = H(uiC.h, clamp(uiC.s * 0.5, 0, 0.14), 0.955);
  const uiBorder = H(borderC.h, clamp(borderC.s * 0.6, 0.08, 0.32), clamp(borderC.l, 0.66, 0.82));
  const mainText = H(deepest.h, clamp(deepest.s * 0.5, 0.04, 0.20), clamp(deepest.l - 0.2, 0.18, 0.34));
  const italicsText = H(point.h, clamp(point.s * 0.7, 0.18, 0.5), clamp(point.l - 0.06, 0.42, 0.62));
  const underlineText = H(borderC.h, clamp(borderC.s * 0.7, 0.1, 0.4), clamp(borderC.l - 0.1, 0.4, 0.58));
  const quoteText = H(212, 0.26, 0.60);
  const hl = makeHL(sc.hl, point, mainText, chatBg);
  const quoteHighlight = hl.bg, dialogueColor = hl.txt;
  const shadow = "rgba(14,14,18,0.42)";
  const userMesTint = H(point.h, 0.18, 0.95, 0.4);
  const aiMesTint = H(lightest.h, 0.20, 0.97, 0.4);
  let c = { mainText, italicsText, underlineText, quoteText, shadow, chatBg, uiBg, uiBorder, userMesTint, aiMesTint, dialogueColor, quoteHighlight };
  // 가독성 guard
  let mc = parseColor(c.mainText), b = parseColor(c.chatBg), g = 0;
  while (contrast(mc, b) < 6 && g < 60) { const h = rgbToHsl(mc.r, mc.g, mc.b); mc = { ...hslToRgb(h.h, h.s, Math.max(0, h.l - 0.02)), a: 1 }; g++; }
  c.mainText = toRgba(mc);
  // 색이름 메타 보존
  sc.names = { chatBg: lightest.name, mainText: deepest.name, italicsText: point.name, uiBorder: borderC.name, point: point.name };
  curName = `🌫️ ${sc.keywords || sc.scene.slice(0, 12)} · ${sc.axes.온도}/${sc.axes.자연광}`;
  const badge = document.getElementById("sc-badge");
  if (badge) badge.textContent = `${sc.axes.온도}·${sc.axes.자연광}·${sc.axes.인공조명}·${sc.axes.공기} · 형광펜 ${sc.hl} · 폰트 ${sc.font}`;
  render(c);
  sceneShowSources();
}
function sceneShowSources() {
  const box = document.getElementById("sc-sources"); if (!box) return; box.innerHTML = "";
  sc.sources.forEach(s => { const el = document.createElement("div"); el.className = "tg-src"; el.innerHTML = `<span class="tg-srcdot" style="background:${s.hex}"></span>${s.name}`; box.appendChild(el); });
  if (sc.point) { const el = document.createElement("div"); el.className = "tg-src"; el.innerHTML = `<span class="tg-srcdot" style="background:${sc.point.hex}"></span>${sc.point.name} <span class="tg-srcfrom">포인트</span>`; box.appendChild(el); }
}

// 🎲 장면: 전부 새로
async function diceScene() {
  sc.scene = "";              // 장면 비우면 resolve가 새로 생성
  await sceneResolve(true);
  const sb = document.getElementById("sc-scene"); if (sb) sb.value = sc.scene;
  diceColor();
}
// [생성] 키워드 입력 → 장면+색
async function sceneBuild() {
  sc.keywords = (document.getElementById("sc-keywords")?.value || "").trim();
  sc.scene = "";
  toast("장면 그리는 중…");
  await sceneResolve(true);
  const sb = document.getElementById("sc-scene"); if (sb) sb.value = sc.scene;
  diceColor();
  toast(`완료 · ${sc.axes.온도}/${sc.axes.자연광}/${sc.axes.공기} · 🎲로 다른 장면`);
}
// [이 장면으로] 유저가 장면칸 수정 후 색만 재생성 (장면→축 재추출)
async function sceneFromText() {
  sc.scene = (document.getElementById("sc-scene")?.value || "").trim();
  if (!sc.scene) return;
  toast("이 장면으로 색 뽑는 중…");
  // 장면 고정한 채 축만 다시 (AI 있으면 장면→축, 없으면 기존 축 유지)
  if (settings().aiInPanel) { const kw = sc.keywords; await sceneResolve(true); }
  diceColor();
  toast("재생성 완료");
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
  const SC_PRESETS = Object.keys(SCENE_PRESET);
  const objChips = SC_PRESETS.map(r => `<button class="tg-pill" data-scpreset="${r}">${r}</button>`).join("");
  return `
  <div id="tg-panel-inner">
    <div class="tg-bar"><b>🌧️ 테마 생성기</b> <span class="tg-ver">v${VERSION}</span> <span id="tg-close">✕</span></div>

    <div class="tg-tabs">
      <button class="tg-tab on" data-tab="mood">🌧️ Mood</button>
      <button class="tg-tab" data-tab="object">🌫️ Scene</button>
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
      <p class="tg-label">키워드 (띄어쓰기로)</p>
      <div class="tg-objrow">
        <input id="sc-keywords" placeholder="예: 청포도 여름 얼음 / 레몬 홍차 도서관" value="청포도 여름 얼음">
        <button id="sc-build">생성</button>
      </div>
      <p class="tg-hint">키워드 → AI가 '장면'을 그리고 → 그 공기의 색을 엔진이 뽑음. 청포도여도 장면 따라 완전 다른 테마.</p>

      <p class="tg-label">장면 <span class="tg-hint" style="margin:0">— 직접 고쳐도 됨</span></p>
      <textarea id="sc-scene" class="tg-scene" rows="2" placeholder="키워드 없이 장면만 써도 됨 (예: 비 온 뒤 흐린 하늘)"></textarea>

      <div class="tg-dicerow">
        <button id="sc-dice-scene">🎲 새 장면</button>
        <button id="sc-from-text">🎨 이 장면으로</button>
      </div>

      <p class="tg-label" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">색 <button id="sc-dice-color">🎲 색상</button> <button id="sc-dice-dist">🎲 분배</button></p>
      <div id="sc-badge" class="tg-objbadge" style="margin:0 2px 8px"></div>
      <div class="tg-sources" id="sc-sources"></div>

      <div class="tg-harm">
        <div class="tg-harmtop"><span>어우러짐 강도</span><span id="sc-harm-v">80</span></div>
        <input type="range" id="sc-harm" min="0" max="100" value="80">
        <div class="tg-harmend"><span>날것</span><span>한 가족</span></div>
      </div>

      <details class="tg-adv">
        <summary>고급 — 미세 조정</summary>
        <div class="tg-axis"><div class="tg-ends"><span>어두움</span><span>밝음</span></div><input type="range" id="sc-adv-l" min="-20" max="20" value="0"></div>
        <div class="tg-axis"><div class="tg-ends"><span>차분</span><span>선명</span></div><input type="range" id="sc-adv-s" min="-20" max="20" value="0"></div>
        <div class="tg-axis"><div class="tg-ends"><span>현실</span><span>몽환</span></div><input type="range" id="sc-adv-f" min="0" max="40" value="0"></div>
      </details>

      <div class="tg-objchips" id="sc-presets">${objChips}</div>
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
    if (tab === "object" && !sc.sources.length) sceneBuild();   // 첫 진입 시 자동 생성
  }));

  // Scene 모드
  const readAdv = () => { sc.adv = { dL: (+p.querySelector("#sc-adv-l").value) / 100, dS: (+p.querySelector("#sc-adv-s").value) / 100, dFant: +p.querySelector("#sc-adv-f").value }; };
  p.querySelector("#sc-build").addEventListener("click", () => { readAdv(); sceneBuild(); });
  p.querySelector("#sc-keywords").addEventListener("keydown", e => { if (e.key === "Enter") { readAdv(); sceneBuild(); } });
  p.querySelector("#sc-dice-scene").addEventListener("click", () => { readAdv(); diceScene(); });
  p.querySelector("#sc-from-text").addEventListener("click", () => { readAdv(); sceneFromText(); });
  p.querySelector("#sc-dice-color").addEventListener("click", () => { readAdv(); diceColor(); });
  p.querySelector("#sc-dice-dist").addEventListener("click", diceDist);
  p.querySelector("#sc-harm").addEventListener("input", e => { p.querySelector("#sc-harm-v").textContent = e.target.value; if (sc.sources.length) diceDist(); });
  p.querySelectorAll("#sc-adv-l,#sc-adv-s,#sc-adv-f").forEach(s => s.addEventListener("input", () => { readAdv(); if (sc.axes) diceColor(); }));
  p.querySelectorAll("[data-scpreset]").forEach(b => b.addEventListener("click", () => { sc.keywords = b.dataset.scpreset; sc.scene = ""; sc.axes = { ...SCENE_PRESET[b.dataset.scpreset] }; sc._pointKw = ""; p.querySelector("#sc-keywords").value = b.dataset.scpreset; readAdv(); diceColor(); const sb = p.querySelector("#sc-scene"); if (sb) sb.value = b.dataset.scpreset; }));

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
