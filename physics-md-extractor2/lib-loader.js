/**
 * lib-loader.js
 * ------------------------------------------------------------------
 * 외부 라이브러리(전역 UMD)를 준비/지연 로드하는 모듈.
 *
 *  - PDF.js, JSZip, Tesseract.js 는 index.html 에서 미리 로드된다.
 *    (전역: window.pdfjsLib / window.JSZip / window.Tesseract)
 *  - OpenCV.js 는 용량이 크므로(약 8MB) OCR 전처리가 실제로 필요할 때
 *    이 모듈이 <script> 를 주입해 지연 로드한다.
 *
 * 모든 함수는 필요한 전역이 준비되면 resolve 되는 Promise 를 돌려준다.
 * ------------------------------------------------------------------
 */

const OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js';

/** PDF.js 준비: 전역 pdfjsLib 확인 + worker 경로 설정 */
export function ensurePdfjs() {
  if (!window.pdfjsLib) {
    throw new Error('PDF.js 로드에 실패했습니다. 네트워크 연결을 확인하세요.');
  }
  // 워커 경로 설정(최초 1회)
  if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  return window.pdfjsLib;
}

/** JSZip 준비 */
export function ensureJSZip() {
  if (!window.JSZip) {
    throw new Error('JSZip 로드에 실패했습니다. 네트워크 연결을 확인하세요.');
  }
  return window.JSZip;
}

/** Tesseract 준비 */
export function ensureTesseract() {
  if (!window.Tesseract) {
    throw new Error('Tesseract.js 로드에 실패했습니다. 네트워크 연결을 확인하세요.');
  }
  return window.Tesseract;
}

let _opencvPromise = null;

/**
 * OpenCV.js 지연 로드.
 * cv 런타임 초기화(onRuntimeInitialized)까지 기다린 뒤 cv 객체를 resolve.
 * @returns {Promise<object>} 전역 cv 객체
 */
export function ensureOpenCV() {
  if (window.cv && window.cv.Mat) return Promise.resolve(window.cv);
  if (_opencvPromise) return _opencvPromise;

  _opencvPromise = new Promise((resolve, reject) => {
    // OpenCV 는 Module 를 통해 초기화 콜백을 받는다.
    const existing = document.querySelector(`script[data-opencv]`);
    const onReady = () => {
      // cv 가 Promise 형태로 준비되는 빌드도 있어 방어적으로 처리
      const cv = window.cv;
      if (cv && typeof cv.then === 'function') {
        cv.then((real) => { window.cv = real; resolve(real); });
      } else if (cv && cv.Mat) {
        resolve(cv);
      } else if (cv) {
        cv.onRuntimeInitialized = () => resolve(window.cv);
      } else {
        reject(new Error('OpenCV 초기화에 실패했습니다.'));
      }
    };

    if (existing) {
      // 이미 주입돼 로딩 중이면 준비될 때까지 폴링
      const timer = setInterval(() => {
        if (window.cv && window.cv.Mat) { clearInterval(timer); resolve(window.cv); }
      }, 120);
      return;
    }

    const script = document.createElement('script');
    script.src = OPENCV_URL;
    script.async = true;
    script.setAttribute('data-opencv', 'true');
    script.onload = onReady;
    script.onerror = () => reject(new Error('OpenCV.js 다운로드에 실패했습니다. 네트워크를 확인하세요.'));
    document.head.appendChild(script);
  });

  return _opencvPromise;
}
