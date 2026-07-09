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
 *
 * ⚠️ 수식 글자 인식(math-ocr.js) 지원:
 * 시험지의 수식 편집기로 조판된 변수·기호(n, t, v0 …)는 실제로는 일반
 * 알파벳이 아니라 임베디드 폰트의 임의 코드(흔히 사설영역, Private Use
 * Area)로 인코딩되는 경우가 많다. 이 코드는 문서/폰트마다 임의로 배정되어
 * 그 자체로는 무슨 글자인지 알 수 없으므로, "본문과 다른 폰트를 쓴다"는
 * 신호만 잡아내고, 실제 글자는 해당 부분을 이미지로 잘라 OCR로 복원한다
 * (math-ocr.js가 담당). 이를 위해 각 텍스트 아이템에 fontName을 기록하고,
 * 라인 재구성 시 각 아이템이 최종 라인 텍스트의 몇 번째 위치에 들어갔는지
 * (lineRef/lineTextIndex)도 함께 기록해 나중에 정확히 치환할 수 있게 한다.
 * ------------------------------------------------------------------
 */

const HANGUL_RE = /[\uAC00-\uD7A3\u3130-\u318F]/;

/**
 * 한 페이지의 텍스트를 추출해 라인 배열과 품질 지표를 반환한다.
 * @param {object} page   PDF.js page proxy
 * @param {number} scale  렌더링에 사용한 배율(캔버스 좌표계와 일치시키기 위함)
 * @returns {Promise<{lines:Array, metrics:object, items:Array}>}
 */
export async function extractPageText(page, scale, twoColumn = true) {
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent();
  const Util = window.pdfjsLib.Util;

  /** @type {Array<{str:string,x:number,y:number,w:number,h:number,top:number,bottom:number,fontName:string}>} */
  const items = [];

  for (const it of content.items) {
    const str = it.str;
    if (!str) continue;
    // 텍스트 변환행렬을 뷰포트(디바이스) 좌표로 합성
    const tm = Util.transform(viewport.transform, it.transform);
    const x = tm[4];
    const y = tm[5]; // baseline y (아래로 증가)
    const h = Math.hypot(tm[2], tm[3]) || (it.height * scale) || 10;
    const w = (it.width || 0) * scale;
    items.push({ str, x, y, w, h, top: y - h, bottom: y, fontName: it.fontName });
  }

  const lines = reconstructLines(items, viewport.width, twoColumn);
  const metrics = computeQuality(lines);
  return { lines, metrics, items, viewportWidth: viewport.width, viewportHeight: viewport.height };
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

/**
 * 텍스트 아이템들을 라인으로 묶는다(수직 근접 + 수평 정렬 + 공백 보정).
 *
 * ⚠️ 각 아이템에 lineRef(최종 라인 객체)와 lineTextIndex(그 라인 text 안에서
 * 이 아이템 문자열이 시작하는 위치)를 함께 기록한다. 이후 math-ocr.js가
 * 수식 의심 구간을 인식된 텍스트로 정확히 치환하는 데 필요하다.
 * (내부 공백을 한 칸으로 축약하면 인덱스가 어긋나므로, 여기서는 앞뒤 공백만
 * 정리하고 축약분만큼 인덱스를 보정한다.)
 */
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

  // 각 row 내부 정렬 + 문자열 합성(간격이 크면 공백 삽입) + 아이템별 위치 기록
  const lines = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prev = null;
    let xLeft = Infinity, xRight = -Infinity;
    const lineObj = { text: '', xLeft: 0, xRight: 0, top: r.top, bottom: r.bottom, height: r.height };

    for (const it of r.items) {
      if (prev) {
        const gap = it.x - (prev.x + prev.w);
        // 이미 공백으로 끝났으면 추가하지 않음
        const endsWithSpace = /\s$/.test(text);
        if (gap > r.height * 0.28 && !endsWithSpace && !/^\s/.test(it.str)) text += ' ';
      }
      it.lineRef = lineObj;
      it.lineTextIndex = text.length;
      text += it.str;
      xLeft = Math.min(xLeft, it.x);
      xRight = Math.max(xRight, it.x + it.w);
      prev = it;
    }

    // 내부 공백은 축약하지 않고(인덱스 보존), 앞뒤 공백만 정리한다.
    const leftTrim = text.length - text.replace(/^\s+/, '').length;
    text = text.trim();
    if (leftTrim) {
      for (const it of r.items) it.lineTextIndex = Math.max(0, it.lineTextIndex - leftTrim);
    }
    if (!text) continue;

    lineObj.text = text;
    lineObj.xLeft = xLeft;
    lineObj.xRight = xRight;
    lines.push(lineObj);
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

/**
 * 본문과 다른 폰트를 쓰는 텍스트 아이템(수식일 가능성이 높음)을 찾아,
 * 같은 줄에서 서로 가까운 것끼리 묶어 "클러스터"로 반환한다.
 * (클러스터 하나 = 이미지로 잘라 OCR 한 번 돌릴 단위. 예: "t=5/6t_0" 전체를
 *  한 덩어리로 묶어야 문맥이 살아 인식률이 올라간다.)
 *
 * 각 클러스터 아이템은 groupItemsIntoLines() 가 채워 넣은 lineRef/lineTextIndex를
 * 그대로 가지고 있어야 하므로, 반드시 extractPageText() 로 얻은 items를 넘겨야 한다.
 *
 * @param {Array} items  extractPageText() 반환값의 items
 * @returns {Array<{key:string, bbox:{x0,y0,x1,y1}, items:Array}>}
 */
export function clusterMathItems(items) {
  if (!items || !items.length) return [];

  // 1) 본문 폰트 판정: 글자 수 기준으로 가장 많이 쓰인 폰트
  const counts = new Map();
  for (const it of items) {
    const n = (it.str || '').length;
    counts.set(it.fontName, (counts.get(it.fontName) || 0) + n);
  }
  let dominant = null, best = -1;
  for (const [font, n] of counts) {
    if (n > best) { best = n; dominant = font; }
  }
  if (dominant === null) return [];

  // 2) 의심 아이템: 본문과 폰트가 다르고, 공백/구두점만은 아닌 것
  const suspects = items.filter(
    (it) => it.fontName !== dominant && it.str && !/^[\s.,:;]+$/.test(it.str) && it.lineRef
  );
  if (!suspects.length) return [];

  // 3) 같은 줄(lineRef) 안에서 x좌표 순으로 정렬 후, 인접한 것끼리 묶기
  suspects.sort((a, b) => {
    if (a.lineRef !== b.lineRef) return a.top - b.top;
    return a.x - b.x;
  });

  const clusters = [];
  let current = null;
  for (const it of suspects) {
    if (current) {
      const last = current.items[current.items.length - 1];
      if (last.lineRef === it.lineRef) {
        const gap = it.x - (last.x + last.w);
        if (gap <= Math.max(last.h, it.h) * 1.2) {
          current.items.push(it);
          continue;
        }
      }
    }
    current = { items: [it] };
    clusters.push(current);
  }

  // 4) 각 클러스터의 bbox + 캐시 키(폰트+코드포인트 시퀀스) 계산
  for (const c of clusters) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const keyParts = [];
    for (const it of c.items) {
      x0 = Math.min(x0, it.x);
      y0 = Math.min(y0, it.top);
      x1 = Math.max(x1, it.x + it.w);
      y1 = Math.max(y1, it.bottom);
      keyParts.push(it.fontName + ':' + Array.from(it.str, (ch) => ch.codePointAt(0)).join('.'));
    }
    c.bbox = { x0, y0, x1, y1 };
    c.key = keyParts.join('|');
  }

  return clusters;
}
