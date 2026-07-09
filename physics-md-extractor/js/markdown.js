/**
 * markdown.js
 * ------------------------------------------------------------------
 * 1) 물리 표기를 LaTeX 로 변환(convertText)
 *      - 영문자 A,B,C,p,q,n,c … → $\mathrm{A}$
 *      - 단위 2kg → $2\,\mathrm{kg}$
 *      - 변수 0.8c → $0.8\mathrm{c}$
 *      - 관계식 n=2 → $\mathrm{n}=2$
 *      - 지수 m/s² → \mathrm{m/s^2}
 * 2) 파싱된 문항을 Obsidian 마크다운으로 조립(assembleMarkdown)
 *
 * 자동 변환은 휴리스틱이므로 결과는 사용자가 편집할 수 있게 한다.
 * ------------------------------------------------------------------
 */

// 단위 토큰(긴 것 우선). 정규식 alternation 에 그대로 사용.
const UNITS = [
  'kg', 'km', 'cm', 'mm', 'nm', 'μm', 'mol',
  'MeV', 'keV', 'eV', 'kHz', 'MHz', 'GHz', 'Hz',
  'kPa', 'MPa', 'Pa', 'kJ', 'kW', 'mA', 'Wb',
  'cd', 'lm', 'lx', 'rad', 'min',
  'N', 'J', 'W', 'V', 'A', 'T', 'K', 'C', 's', 'm', 'g', 'h', 'Ω', '℃',
].sort((a, b) => b.length - a.length);

const UNIT_ALT = UNITS.map(escapeRe).join('|');
const UNIT_TOKEN = `(?:${UNIT_ALT})(?:\\/(?:${UNIT_ALT}))?`;

const RE_NUM_UNIT = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_TOKEN})(\\^-?\\d+)?`, 'g');
const RE_NUM_VAR = /(\d+(?:\.\d+)?)([a-zA-Z])(?![a-zA-Z0-9])/g;
const RE_REL = /([a-zA-Z])\s*([=<>≤≥≠])\s*(-?\d+(?:\.\d+)?)/g;
const RE_STANDALONE = /(^|[^\w$\\{])([A-Za-z])(?![\w}])/g;

const SUP = { '⁰': '^0', '¹': '^1', '²': '^2', '³': '^3', '⁴': '^4', '⁵': '^5', '⁶': '^6', '⁷': '^7', '⁸': '^8', '⁹': '^9', 'ⁿ': '^n' };
const SUB = { '₀': '_0', '₁': '_1', '₂': '_2', '₃': '_3', '₄': '_4', '₅': '_5', '₆': '_6', '₇': '_7', '₈': '_8', '₉': '_9' };

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 이미 완성된 $...$ 를 임시 토큰으로 보호해 후속 규칙이 건드리지 못하게 함 */
function protectMath(text, store) {
  return text.replace(/\$[^$]*\$/g, (m) => {
    const key = `\uE000${store.length}\uE001`;
    store.push(m);
    return key;
  });
}

/** 수식 자리표시자(⟦EQ:키⟧)를 보호해 변환 규칙이 건드리지 못하게 함 */
function protectPlaceholders(text, store) {
  return text.replace(/\u27E6EQ:[A-Za-z0-9_]+\u27E7/g, (m) => {
    const key = `\uE000${store.length}\uE001`;
    store.push(m);
    return key;
  });
}
function restoreMath(text, store) {
  return text.replace(/\uE000(\d+)\uE001/g, (_, i) => store[+i]);
}

/**
 * 텍스트 조각을 물리 LaTeX 표기로 변환.
 * @param {string} text
 * @param {boolean} enable  false 면 원문 그대로 반환
 */
export function convertText(text, enable = true) {
  if (!text) return '';
  if (!enable) return text;

  let t = text;
  // 위/아래 첨자 정규화
  t = t.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ]/g, (c) => SUP[c] || c);
  t = t.replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => SUB[c] || c);

  const store = [];
  t = protectPlaceholders(t, store);   // 수식 자리표시자 먼저 보호
  t = protectMath(t, store);

  // 1) 숫자+단위 → $2\,\mathrm{kg}$
  t = t.replace(RE_NUM_UNIT, (_, num, unit, exp) => `$${num}\\,\\mathrm{${unit}${exp || ''}}$`);
  t = protectMath(t, store);

  // 2) 숫자+변수(단위 아님) → $0.8\mathrm{c}$
  t = t.replace(RE_NUM_VAR, (_, num, v) => `$${num}\\mathrm{${v}}$`);
  t = protectMath(t, store);

  // 3) 관계식 n=2 → $\mathrm{n}=2$
  t = t.replace(RE_REL, (_, v, op, num) => `$\\mathrm{${v}}${op}${num}$`);
  t = protectMath(t, store);

  // 4) 단독 영문자 → $\mathrm{A}$
  t = t.replace(RE_STANDALONE, (_, pre, v) => `${pre}$\\mathrm{${v}}$`);

  t = restoreMath(t, store);
  return t.trim();
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 문항 그림 파일명 규칙 (여러 개면 _2, _3 …) */
export function figureName(number, idx) {
  return `question${pad2(number)}${idx > 0 ? '_' + (idx + 1) : ''}.png`;
}

/**
 * 파싱 결과 + 그림 파일명으로 마크다운 조립.
 * @param {object} parsed  parseQuestion 결과
 * @param {string[]} figureNames  삽입할 그림 파일명 배열
 * @param {boolean} latex  LaTeX 자동 변환 여부
 * @returns {string}
 */
export function assembleMarkdown(parsed, figureNames, latex = true) {
  const conv = (s) => convertText(s, latex);
  const out = [];

  out.push('[문항번호]');
  out.push(String(parsed.number));

  out.push('[발문]');
  out.push(conv(parsed.intro) || '');

  if (figureNames && figureNames.length) {
    out.push('[그림]');
    for (const fn of figureNames) out.push(`![[${fn}]]`);
  }

  if (parsed.question2) {
    out.push('[발문2]');
    out.push(conv(parsed.question2));
  }

  if (parsed.hasBogi && parsed.bogi.length) {
    out.push('[보기]');
    for (const item of parsed.bogi) out.push(conv(item));
  }

  if (parsed.choices.length) {
    out.push('[선지]');
    for (const c of parsed.choices) out.push(conv(c));
  }

  return out.join('\n');
}
