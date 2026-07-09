/**
 * math-ocr.js
 * ------------------------------------------------------------------
 * "수식 의심" 글리프 클러스터(pdf-text.js의 clusterMathItems 결과)를
 * 페이지 캔버스에서 잘라 확대한 뒤, 영문/숫자 전용 Tesseract 워커로
 * 실제 문자를 복원해 Obsidian 인라인 수식 `$...$`으로 돌려준다.
 *
 * 같은 글리프 조합(cluster.key, 예: 동일한 사설영역 코드 시퀀스)이
 * 문서 안에서 다시 나오면 캐시를 재사용해 중복 OCR을 피한다.
 * ------------------------------------------------------------------
 */
import { ensureTesseract } from './lib-loader.js';

let _worker = null;

/** 수식 인식 전용 Tesseract 워커(영문 전용, 문자 화이트리스트 + 단일 라인 모드) */
async function getMathWorker() {
  if (_worker) return _worker;
  const Tesseract = ensureTesseract();
  _worker = await Tesseract.createWorker(['eng'], 1, {});
  await _worker.setParameters({
    tessedit_char_whitelist:
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=+-/.,()<>',
    tessedit_pageseg_mode: '7', // PSM.SINGLE_LINE: 한 줄짜리 짧은 텍스트로 취급
  });
  return _worker;
}

/** 클러스터 영역을 페이지 캔버스에서 잘라 확대한 새 캔버스를 만든다. */
function cropCluster(pageCanvas, bbox, padRatio = 0.4, targetHeight = 100) {
  const w = bbox.x1 - bbox.x0, h = bbox.y1 - bbox.y0;
  if (w <= 0 || h <= 0) return null;
  const padX = Math.max(4, w * padRatio);
  const padY = Math.max(4, h * padRatio);
  const sx = Math.max(0, bbox.x0 - padX);
  const sy = Math.max(0, bbox.y0 - padY);
  const sw = Math.min(pageCanvas.width - sx, w + padX * 2);
  const sh = Math.min(pageCanvas.height - sy, h + padY * 2);
  if (sw <= 0 || sh <= 0) return null;

  const scale = Math.max(1, targetHeight / sh);
  const outW = Math.max(1, Math.round(sw * scale));
  const outH = Math.max(1, Math.round(sh * scale));

  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, outW, outH);
  return out;
}

/** OCR 결과 후처리(불필요한 공백 제거, 흔한 오인식 보정) */
function cleanOcrText(text) {
  return (text || '')
    .replace(/\s+/g, '')
    .replace(/\|/g, '1')
    .trim();
}

/** 분수 a/b → \frac{a}{b} 로 변환 */
function toFraction(text) {
  return text.replace(/(\d+)\s*\/\s*(\d+)/g, '\\frac{$1}{$2}');
}

/**
 * 클러스터 배열을 인식해 각 클러스터 객체 → '$...$' 매핑(Map)을 반환한다.
 * @param {Array} clusters       pdf-text.js clusterMathItems() 결과
 * @param {HTMLCanvasElement} pageCanvas  이 페이지의 렌더링 캔버스
 * @param {Map<string,string>} cache      문서 전체에서 공유하는 캐시(같은 key 재사용)
 * @param {function} [onProgress]  (done:number,total:number)=>void
 * @returns {Promise<Map<object,string>>}
 */
export async function recognizeMathClusters(clusters, pageCanvas, cache, onProgress) {
  const results = new Map();
  if (!clusters.length) return results;

  const uniqueKeys = [...new Set(clusters.map((c) => c.key))];
  const toRecognize = uniqueKeys.filter((k) => !cache.has(k));

  if (toRecognize.length) {
    const worker = await getMathWorker();
    for (let i = 0; i < toRecognize.length; i++) {
      const key = toRecognize[i];
      const cluster = clusters.find((c) => c.key === key);
      let value = '$?$';
      try {
        const crop = cropCluster(pageCanvas, cluster.bbox);
        if (crop) {
          const { data } = await worker.recognize(crop);
          const cleaned = cleanOcrText(data.text);
          value = cleaned ? `$${toFraction(cleaned)}$` : '$?$';
        }
      } catch (e) {
        value = '$?$';
      }
      cache.set(key, value);
      if (onProgress) onProgress(i + 1, toRecognize.length);
    }
  }

  for (const c of clusters) results.set(c, cache.get(c.key));
  return results;
}

/**
 * 인식 결과를 각 라인의 text에 되돌려 넣는다.
 * 클러스터의 첫 아이템 위치에 인식된 `$...$`를 삽입하고, 나머지 아이템은 비운다.
 * (같은 클러스터가 두 줄에 걸쳐 있을 수도 있어 라인별로 모아서 처리한다.)
 * @param {Array} clusters
 * @param {Map<object,string>} recognizedMap
 */
export function substituteMathIntoLines(clusters, recognizedMap) {
  for (const cluster of clusters) {
    const recognized = recognizedMap.get(cluster) || '';
    const sorted = [...cluster.items].sort((a, b) => {
      if (a.lineRef !== b.lineRef) return a.top - b.top;
      return a.lineTextIndex - b.lineTextIndex;
    });
    sorted.forEach((it, idx) => { it.__mathReplacement = idx === 0 ? recognized : ''; });
  }

  const byLine = new Map();
  for (const cluster of clusters) {
    for (const it of cluster.items) {
      if (it.__mathReplacement === undefined) continue;
      const arr = byLine.get(it.lineRef) || [];
      arr.push(it);
      byLine.set(it.lineRef, arr);
    }
  }

  for (const [line, items] of byLine) {
    items.sort((a, b) => b.lineTextIndex - a.lineTextIndex); // 뒤에서부터 치환(앞 인덱스 보존)
    let text = line.text;
    for (const it of items) {
      const start = it.lineTextIndex;
      const end = start + it.str.length;
      text = text.slice(0, start) + it.__mathReplacement + text.slice(end);
    }
    line.text = text.replace(/\s+/g, ' ').trim();
  }
}

export async function terminateMathWorker() {
  if (_worker) {
    try { await _worker.terminate(); } catch (_) {}
    _worker = null;
  }
}
