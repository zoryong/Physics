/**
 * pdf-text.js
 * ------------------------------------------------------------------
 * PDF.js 텍스트 레이어 추출 + 라인 재구성 + 추출 품질 판정.
 *
 * 핵심 산출물은 "라인(line)" 배열이며, 각 라인은 렌더링 캔버스와
 * 동일한 픽셀 좌표계(y는 아래로 증가)를 사용한다. 이 좌표계는
 * 이후 그림 크롭(render.js)에서 텍스트 영역을 제외하는 데 쓰인다.
 *
 * line 구조:
 *   { text, xLeft, xRight, top, bottom, height }
 * ------------------------------------------------------------------
 */

const HANGUL_RE = /[\uAC00-\uD7A3\u3130-\u318F]/;

// 시험지 수식은 전용 수식 폰트(HyhwpEQ 등)의 "사설 사용 영역(PUA)" 글리프로
// 저장되어 유니코드 텍스트로는 읽히지 않는다. 이런 글리프는 수식 조각으로 보고
// 위치(bbox)만 뽑아 이미지로 잘라 쓴다.  U+E000–U+F8FF: PUA, U+FFFD: 대체문자.
const PUA_RE = /[\uE000-\uF8FF\uFFFD]/;
// 라인 텍스트에 삽입되는 수식 자리표시자(⟦EQ:키⟧). 이후 단계에서 그대로 운반되다가
// main 에서 이미지 링크(![[...]]) 또는 LaTeX($...$)로 치환된다.
export const EQ_PLACEHOLDER_RE = /\u27E6EQ:([A-Za-z0-9_]+)\u27E7/g;

/**
 * 한 페이지의 텍스트를 추출해 라인 배열과 품질 지표를 반환한다.
 * @param {object} page   PDF.js page proxy
 * @param {number} scale  렌더링에 사용한 배율(캔버스 좌표계와 일치시키기 위함)
 * @returns {Promise<{lines:Array, metrics:object, formulas:Array}>}
 */
export async function extractPageText(page, scale, twoColumn = true) {
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent();
  const Util = window.pdfjsLib.Util;

  /** @type {Array<{str:string,x:number,y:number,w:number,h:number,top:number,bottom:number,formula:boolean}>} */
  const items = [];

  for (const it of content.items) {
    const str = it.str || '';
    const formula = PUA_RE.test(str);
    if (!formula && !str.trim()) continue;   // 순수 공백/빈 텍스트는 버림
    // 텍스트 변환행렬을 뷰포트(디바이스) 좌표로 합성
    const tm = Util.transform(viewport.transform, it.transform);
    const x = tm[4];
    const y = tm[5]; // baseline y (아래로 증가)
    const h = Math.hypot(tm[2], tm[3]) || (it.height * scale) || 10;
    const w = (it.width || 0) * scale;
    items.push({ str, x, y, w, h, top: y - h, bottom: y, formula });
  }

  // 수식 글리프들을 인접성으로 묶어 하나의 수식 덩어리(그룹)로 만들고,
  // 각 그룹을 자리표시자 문자열을 가진 가짜 아이템으로 대체한다. 그러면
  // 라인 재구성 시 수식이 원래 위치(x 순서)에 자연스럽게 끼워진다.
  const formulaGroups = clusterFormulas(items.filter((it) => it.formula));
  const textItems = items.filter((it) => !it.formula);
  const pseudoItems = formulaGroups.map((g, idx) => ({
    str: `\u27E6EQ:L${idx}\u27E7`,
    x: g.x0, y: g.y1, w: Math.max(1, g.x1 - g.x0), h: Math.max(1, g.y1 - g.y0),
    top: g.y0, bottom: g.y1, formula: true,
  }));

  const lines = reconstructLines(textItems.concat(pseudoItems), viewport.width, twoColumn);
  const metrics = computeQuality(lines);
  const formulas = formulaGroups.map((g) => ({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 }));
  return { lines, metrics, formulas, viewportWidth: viewport.width, viewportHeight: viewport.height };
}

/**
 * 수식 글리프(PUA) 아이템들을 인접성으로 묶어 수식 덩어리로 만든다.
 * 분수의 분자/분모처럼 y가 다르더라도 x가 겹치면 하나로 합쳐지고,
 * 사이에 일반 텍스트가 끼어 x간격이 크게 벌어지면 서로 다른 수식으로 분리된다.
 * @returns {Array<{x0,y0,x1,y1}>}
 */
function clusterFormulas(fitems) {
  if (!fitems.length) return [];
  const items = fitems.map((it) => ({
    x0: it.x, y0: it.top, x1: it.x + Math.max(it.w, 1), y1: it.bottom, h: it.h || (it.bottom - it.top) || 10,
  }));
  items.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);

  const groups = [];
  for (const it of items) {
    let g = null;
    for (let k = groups.length - 1; k >= 0; k--) {
      const G = groups[k];
      const hRef = Math.max(it.h, G.y1 - G.y0, 8);
      const gapX = it.x0 - G.x1;                                  // 수평 간격(겹치면 음수)
      const vOverlap = Math.min(it.y1, G.y1) - Math.max(it.y0, G.y0);
      // 세로: 같은 줄(겹침) 또는 분수 위/아래(작은 간격)만 병합.
      //   허용치를 크게 잡으면 아랫줄 수식까지 하나로 묶여 줄이 합쳐진다.
      if (gapX <= hRef * 0.9 && vOverlap > -hRef * 0.5) { g = G; break; }
    }
    if (!g) {
      groups.push({ x0: it.x0, y0: it.y0, x1: it.x1, y1: it.y1 });
    } else {
      g.x0 = Math.min(g.x0, it.x0); g.y0 = Math.min(g.y0, it.y0);
      g.x1 = Math.max(g.x1, it.x1); g.y1 = Math.max(g.y1, it.y1);
    }
  }
  return groups;
}

/**
 * 단어 단위 아이템들을 라인으로 재구성한다.
 *
 * ⚠️ 중요: 2단 편집에서는 좌측 단과 우측 단의 글자가 "같은 baseline(y)"을
 * 공유하는 경우가 많다. y좌표만으로 묶으면 좌·우 두 단이 한 줄로 합쳐져
 * 우측 단의 문항 번호(4. 5. 9. 10. …)가 줄 중간에 파묻혀 인식되지 않는다.
 * 따라서 먼저 아이템을 단(column)으로 분리한 뒤 단별로 라인을 묶는다.
 */
function reconstructLines(items, pageWidth, twoColumn) {
  const cols = twoColumn ? detectColumns(items, pageWidth) : [[0, pageWidth]];
  let lines = [];
  for (const [cx0, cx1] of cols) {
    const colItems = items.filter((it) => {
      const c = it.x + it.w / 2;
      return c >= cx0 && c < cx1;
    });
    lines = lines.concat(groupItemsIntoLines(colItems));
  }
  return lines;
}

/**
 * 아이템 분포로 단(column) 경계를 추정한다. (1단 또는 2단만 지원)
 * 가운데(midline)를 가로지르는 단어가 거의 없으면(=가운데 여백/거터 존재)
 * 2단으로 판단하고 [0,mid],[mid,width] 로 나눈다.
 */
function detectColumns(items, pageWidth) {
  if (items.length < 10) return [[0, pageWidth]];
  const mid = pageWidth / 2;
  let straddle = 0, left = 0, right = 0;
  for (const it of items) {
    const xL = it.x, xR = it.x + it.w;
    if (xL <= mid && xR >= mid) straddle++;        // 미드라인을 관통하는 단어
    if ((xL + xR) / 2 < mid) left++; else right++;
  }
  const twoCol = straddle < items.length * 0.03
    && left > items.length * 0.15
    && right > items.length * 0.15;
  return twoCol ? [[0, mid], [mid, pageWidth]] : [[0, pageWidth]];
}

/** 텍스트 아이템들을 라인으로 묶는다(수직 근접 + 수평 정렬 + 공백 보정). */
function groupItemsIntoLines(items) {
  if (!items.length) return [];
  // 위 → 아래
  items.sort((a, b) => a.top - b.top || a.x - b.x);

  const rows = [];
  for (const it of items) {
    const cy = (it.top + it.bottom) / 2;
    // 같은 줄로 볼 수 있는 기존 row 찾기(수직 중심이 글자 높이의 60% 이내)
    let row = null;
    for (let i = rows.length - 1; i >= 0 && i >= rows.length - 4; i--) {
      const r = rows[i];
      const rcy = (r.top + r.bottom) / 2;
      if (Math.abs(rcy - cy) <= Math.max(it.h, r.height) * 0.6) { row = r; break; }
    }
    if (!row) {
      row = { items: [], top: it.top, bottom: it.bottom, height: it.h };
      rows.push(row);
    }
    row.items.push(it);
    row.top = Math.min(row.top, it.top);
    row.bottom = Math.max(row.bottom, it.bottom);
    row.height = Math.max(row.height, it.h);
  }

  // 각 row 내부 정렬 + 문자열 합성(간격이 크면 공백 삽입)
  const lines = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prev = null;
    let xLeft = Infinity, xRight = -Infinity;
    for (const it of r.items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        // 이미 공백으로 끝났으면 추가하지 않음
        const endsWithSpace = /\s$/.test(text);
        if (gap > r.height * 0.28 && !endsWithSpace && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
      xLeft = Math.min(xLeft, it.x);
      xRight = Math.max(xRight, it.x + it.w);
      prev = it;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push({ text, xLeft, xRight, top: r.top, bottom: r.bottom, height: r.height, words: r.items });
  }

  lines.sort((a, b) => a.top - b.top || a.xLeft - b.xLeft);
  return lines;
}

/** 추출 텍스트 품질 지표 계산 */
function computeQuality(lines) {
  let chars = 0, hangul = 0, spaces = 0;
  for (const l of lines) {
    for (const ch of l.text) {
      chars++;
      if (ch === ' ') spaces++;
      else if (HANGUL_RE.test(ch)) hangul++;
    }
  }
  const nonSpace = chars - spaces;
  return {
    chars,
    hangul,
    lineCount: lines.length,
    hangulRatio: nonSpace ? hangul / nonSpace : 0,
    spaceRatio: chars ? spaces / chars : 0,
  };
}

/**
 * 페이지 텍스트가 "정상 추출"인지 판정한다.
 * 글자 수가 너무 적거나 한글 비율이 지나치게 낮으면 OCR 대상으로 본다.
 */
export function isTextReliable(metrics) {
  if (!metrics) return false;
  if (metrics.chars < 40) return false;          // 거의 빈 페이지 → 스캔 가능성
  if (metrics.hangulRatio < 0.15) return false;  // 한글이 거의 없음 → 깨짐/스캔
  return true;
}

/**
 * 페이지가 2단 편집인지 판정한다.
 * 가운데 경계를 가로지르는 라인이 적으면 2단으로 본다.
 */
export function detectTwoColumn(lines, pageWidth) {
  if (lines.length < 6) return false;
  const mid = pageWidth / 2;
  const crossing = lines.filter(l => l.xLeft < mid - pageWidth * 0.06 && l.xRight > mid + pageWidth * 0.06);
  return crossing.length <= lines.length * 0.28;
}

/**
 * 라인들을 읽기 순서로 정렬한다. 2단 편집이면 좌측 단 전체 → 우측 단 전체.
 * @param {Array} lines        line 배열(픽셀 좌표)
 * @param {number} pageWidth   페이지 폭(px)
 * @param {boolean} twoColumn  2단 인식 사용 여부
 */
export function orderLines(lines, pageWidth, twoColumn = true) {
  if (!lines.length) return [];
  const byTopAll = (a, b) => a.top - b.top || a.xLeft - b.xLeft;
  if (!twoColumn || !detectTwoColumn(lines, pageWidth)) {
    return [...lines].sort(byTopAll);
  }

  const mid = pageWidth / 2;
  const left = [], right = [];
  for (const l of lines) {
    const cx = (l.xLeft + l.xRight) / 2;
    (cx < mid ? left : right).push(l);
  }
  left.sort(byTopAll); right.sort(byTopAll);
  return [...left, ...right];
}
