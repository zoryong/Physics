/**
 * render.js
 * ------------------------------------------------------------------
 * 1) PDF 페이지를 캔버스로 렌더링(renderPage)
 * 2) 문항 영역에서 그림/표/수식을 이미지로 자동 크롭(extractFigures)
 *
 * 크롭 전략(휴리스틱):
 *   - 텍스트 라인이 차지하는 영역을 "잉크 마스크"에서 지운다.
 *   - 남은 잉크(=텍스트가 아닌 그림·표·수식)를 행/열 투영으로 뭉쳐
 *     사각형으로 잘라낸다.
 *   시험지의 수식은 대부분 벡터 이미지라 텍스트 레이어에 없으므로
 *   이 방식으로 함께 보존된다.
 * ------------------------------------------------------------------
 */

/**
 * 페이지를 캔버스로 렌더링.
 * @returns {Promise<{canvas:HTMLCanvasElement,width:number,height:number}>}
 */
export async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, width: canvas.width, height: canvas.height };
}

/** 캔버스를 PNG Blob 으로 변환 */
export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

/**
 * 문항 영역에서 그림들을 잘라낸다.
 * @param {HTMLCanvasElement} pageCanvas  페이지 전체 캔버스
 * @param {Array} textBoxes  페이지의 텍스트 라인 박스들 [{xLeft,top,xRight,bottom,height}]
 * @param {{x0:number,y0:number,x1:number,y1:number}} region  탐색 영역(문항×단 범위)
 * @returns {Array<{canvas:HTMLCanvasElement,dataURL:string,w:number,h:number}>}
 */
export function extractFigures(pageCanvas, textBoxes, region) {
  const x0 = Math.max(0, Math.floor(region.x0));
  const y0 = Math.max(0, Math.floor(region.y0));
  const x1 = Math.min(pageCanvas.width, Math.ceil(region.x1));
  const y1 = Math.min(pageCanvas.height, Math.ceil(region.y1));
  const w = x1 - x0, h = y1 - y0;
  if (w < 20 || h < 16) return [];

  const ctx = pageCanvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(x0, y0, w, h);
  const data = img.data;

  // 1) 잉크 마스크 만들기 (어두운 픽셀 = 1)
  const ink = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    ink[p] = luma < 185 ? 1 : 0;
  }

  // 2) 텍스트 박스 영역을 마스크에서 제거(약간의 패딩 포함)
  for (const b of textBoxes) {
    const pad = Math.max(2, (b.height || 12) * 0.18);
    const bx0 = Math.max(x0, Math.floor(b.xLeft - pad));
    const by0 = Math.max(y0, Math.floor(b.top - pad));
    const bx1 = Math.min(x1, Math.ceil(b.xRight + pad));
    const by1 = Math.min(y1, Math.ceil(b.bottom + pad));
    for (let yy = by0; yy < by1; yy++) {
      const rowStart = (yy - y0) * w;
      for (let xx = bx0; xx < bx1; xx++) ink[rowStart + (xx - x0)] = 0;
    }
  }

  // 3) 행 투영 → 세로 방향 콘텐츠 구간 찾기
  const rowInk = new Int32Array(h);
  for (let yy = 0; yy < h; yy++) {
    let c = 0; const s = yy * w;
    for (let xx = 0; xx < w; xx++) c += ink[s + xx];
    rowInk[yy] = c;
  }
  const minRowInk = Math.max(2, Math.round(w * 0.004));
  const rowGapMerge = Math.round(h * 0.02) + 8;   // 이 정도 빈 줄은 하나로 병합
  const bands = findRuns(rowInk, minRowInk, rowGapMerge, 14);

  // 4) 각 세로 구간에서 열 투영으로 좌우 범위 확정 → 크롭
  const figures = [];
  for (const [ry0, ry1] of bands) {
    const bh = ry1 - ry0;
    const colInk = new Int32Array(w);
    for (let yy = ry0; yy < ry1; yy++) {
      const s = yy * w;
      for (let xx = 0; xx < w; xx++) colInk[xx] += ink[s + xx];
    }
    const colGapMerge = Math.round(w * 0.03) + 10;
    const colRuns = findRuns(colInk, 1, colGapMerge, 12);
    if (!colRuns.length) continue;
    // 가장 넓은 열 구간(그림 본체)만 사용하되, 좌우 전체를 감싸도록 병합
    let cx0 = w, cx1 = 0;
    for (const [a, b] of colRuns) { cx0 = Math.min(cx0, a); cx1 = Math.max(cx1, b); }
    const bw = cx1 - cx0;

    // 노이즈/구분선 제거: 너무 작거나 지나치게 납작한 것 제외
    if (bw < 26 || bh < 16) continue;
    if (bh <= 5) continue;

    const pad = 6;
    const gx0 = Math.max(0, cx0 - pad), gy0 = Math.max(0, ry0 - pad);
    const gx1 = Math.min(w, cx1 + pad), gy1 = Math.min(h, ry1 + pad);
    const cw = gx1 - gx0, ch = gy1 - gy0;
    if (cw < 26 || ch < 16) continue;

    const crop = document.createElement('canvas');
    crop.width = cw; crop.height = ch;
    const cctx = crop.getContext('2d');
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, cw, ch);
    cctx.drawImage(pageCanvas, x0 + gx0, y0 + gy0, cw, ch, 0, 0, cw, ch);

    figures.push({ canvas: crop, dataURL: crop.toDataURL('image/png'), w: cw, h: ch });
  }

  return figures;
}

/**
 * 1차원 배열에서 값이 임계 이상인 연속 구간(run)을 찾는다.
 * 작은 간격(gapMerge)은 하나로 병합하고, 최소 길이(minLen) 미만은 버린다.
 * @returns {Array<[start,end]>}
 */
function findRuns(arr, threshold, gapMerge, minLen) {
  const runs = [];
  let start = -1, gap = 0;
  for (let i = 0; i < arr.length; i++) {
    const on = arr[i] >= threshold;
    if (on) {
      if (start < 0) start = i;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap > gapMerge) { runs.push([start, i - gap + 1]); start = -1; gap = 0; }
    }
  }
  if (start >= 0) runs.push([start, arr.length - gap]);
  return runs.filter(([a, b]) => (b - a) >= minLen);
}
