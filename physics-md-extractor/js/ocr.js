/**
 * ocr.js
 * ------------------------------------------------------------------
 * Tesseract.js(kor+eng) 기반 OCR 엔진 래퍼.
 *  - 워커를 한 번 생성해 여러 페이지에서 재사용(성능).
 *  - OCR 실패 시 1회 재시도.
 *  - 결과 라인을 pdf-text.js 와 동일한 line 구조로 반환해
 *    이후 처리(정렬·크롭)를 통일한다.
 * ------------------------------------------------------------------
 */
import { ensureTesseract } from './lib-loader.js';

export class OcrEngine {
  constructor(logger) {
    this.logger = logger || (() => {});
    this.worker = null;
  }

  async init() {
    if (this.worker) return;
    const Tesseract = ensureTesseract();
    // v5 API: createWorker(langs, oem, options)
    this.worker = await Tesseract.createWorker(['kor', 'eng'], 1, {
      logger: (m) => {
        if (m.status === 'recognizing text' && typeof m.progress === 'number') {
          this.logger({ type: 'progress', progress: m.progress });
        }
      },
    });
  }

  /**
   * 캔버스 1장을 OCR.
   * @param {HTMLCanvasElement} canvas
   * @returns {Promise<{lines:Array, rawText:string}>}
   */
  async recognize(canvas) {
    await this.init();
    let data;
    try {
      ({ data } = await this.worker.recognize(canvas));
    } catch (e) {
      // 1회 재시도(워커 재생성 후)
      this.logger({ type: 'warn', message: 'OCR 실패, 재시도합니다…' });
      await this.terminate();
      await this.init();
      ({ data } = await this.worker.recognize(canvas));
    }

    const lines = (data.lines || [])
      .map((ln) => {
        const b = ln.bbox || {};
        const text = (ln.text || '').replace(/\s+/g, ' ').trim();
        if (!text) return null;
        return {
          text,
          xLeft: b.x0 ?? 0,
          xRight: b.x1 ?? canvas.width,
          top: b.y0 ?? 0,
          bottom: b.y1 ?? 0,
          height: (b.y1 ?? 0) - (b.y0 ?? 0) || 14,
        };
      })
      .filter(Boolean);

    return { lines, rawText: data.text || '' };
  }

  async terminate() {
    if (this.worker) {
      try { await this.worker.terminate(); } catch (_) {}
      this.worker = null;
    }
  }
}
