/**
 * download.js
 * ------------------------------------------------------------------
 * 결과 저장 기능.
 *   1) 전체 physics.md
 *   2) ZIP (physics.md + question*.png 그림)
 *   3) 문항별 .md 묶음 ZIP
 *
 * question 객체 형태(main 에서 구성):
 *   { number, mdName, markdown, figures:[{name, canvas}] }
 * ------------------------------------------------------------------
 */
import { ensureJSZip } from './lib-loader.js';
import { canvasToBlob } from './render.js';

const SEPARATOR = '\n\n------\n\n';

/** 전체 문항을 하나의 마크다운으로 이어붙임 */
export function buildCombinedMarkdown(questions) {
  return questions.map((q) => q.markdown).join(SEPARATOR) + '\n';
}

/** 브라우저 다운로드 트리거 */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** 전체 physics.md 저장 */
export function saveCombined(questions, filename = 'physics.md') {
  const text = buildCombinedMarkdown(questions);
  triggerDownload(new Blob([text], { type: 'text/markdown;charset=utf-8' }), filename);
}

/** ZIP: physics.md + 모든 그림 */
export async function saveFullZip(questions, filename = 'physics.zip') {
  const JSZip = ensureJSZip();
  const zip = new JSZip();
  zip.file('physics.md', buildCombinedMarkdown(questions));

  for (const q of questions) {
    for (const fig of q.figures || []) {
      const blob = await canvasToBlob(fig.canvas);
      if (blob) zip.file(fig.name, blob);
    }
  }
  const out = await zip.generateAsync({ type: 'blob' });
  triggerDownload(out, filename);
}

/** ZIP: 문항별 .md 파일 묶음 */
export async function saveEachZip(questions, filename = 'physics-questions.zip') {
  const JSZip = ensureJSZip();
  const zip = new JSZip();
  for (const q of questions) {
    zip.file(q.mdName, q.markdown + '\n');
  }
  const out = await zip.generateAsync({ type: 'blob' });
  triggerDownload(out, filename);
}
