/**
 * preprocess.js
 * ------------------------------------------------------------------
 * OpenCV.js 기반 OCR 전처리.
 *   - 흑백화(grayscale)
 *   - 노이즈 제거(median blur)
 *   - 대비 향상(CLAHE)
 *   - 이진화(Otsu)
 *   - 기울기 보정(deskew)
 *
 * OpenCV 초기화/연산 실패 시 원본 캔버스를 그대로 돌려줘서
 * OCR 자체는 계속 진행되도록 한다(방어적 설계).
 * ------------------------------------------------------------------
 */
import { ensureOpenCV } from './lib-loader.js';

/**
 * @param {HTMLCanvasElement} srcCanvas
 * @returns {Promise<HTMLCanvasElement>} 전처리된(동일 크기) 캔버스
 */
export async function preprocessForOCR(srcCanvas) {
  let cv;
  try {
    cv = await ensureOpenCV();
  } catch (e) {
    console.warn('[preprocess] OpenCV 로드 실패, 원본으로 OCR 진행:', e);
    return srcCanvas;
  }

  const mats = [];
  const track = (m) => { mats.push(m); return m; };
  try {
    const src = track(cv.imread(srcCanvas));
    const gray = track(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // 노이즈 제거
    const den = track(new cv.Mat());
    cv.medianBlur(gray, den, 3);

    // 대비 향상(CLAHE)
    const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    const enh = track(new cv.Mat());
    clahe.apply(den, enh);
    clahe.delete();

    // 이진화(Otsu)
    const bin = track(new cv.Mat());
    cv.threshold(enh, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

    // 기울기 보정
    const deskewed = deskew(cv, bin, track);

    // 출력 캔버스(동일 크기)
    const out = document.createElement('canvas');
    out.width = srcCanvas.width;
    out.height = srcCanvas.height;
    cv.imshow(out, deskewed);
    return out;
  } catch (e) {
    console.warn('[preprocess] 전처리 중 오류, 원본으로 OCR 진행:', e);
    return srcCanvas;
  } finally {
    for (const m of mats) { try { m.delete(); } catch (_) {} }
  }
}

/**
 * 이진 이미지의 텍스트 기울기를 추정해 수평으로 보정한다.
 * 기울기가 매우 작거나 추정 실패 시 원본을 반환.
 */
function deskew(cv, bin, track) {
  try {
    // 글자가 흰색이 되도록 반전
    const inv = track(new cv.Mat());
    cv.bitwise_not(bin, inv);

    const pts = new cv.Mat();
    cv.findNonZero(inv, pts);
    if (pts.rows < 50) { pts.delete(); return bin; }

    const rect = cv.minAreaRect(pts);
    pts.delete();

    let angle = rect.angle;
    if (angle < -45) angle += 90;
    if (Math.abs(angle) < 0.4 || Math.abs(angle) > 15) return bin; // 보정 불필요/과도

    const center = new cv.Point(bin.cols / 2, bin.rows / 2);
    const M = track(cv.getRotationMatrix2D(center, angle, 1));
    const rot = track(new cv.Mat());
    cv.warpAffine(
      bin, rot, M, new cv.Size(bin.cols, bin.rows),
      cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255)
    );
    return rot;
  } catch (e) {
    console.warn('[preprocess] deskew 실패:', e);
    return bin;
  }
}
