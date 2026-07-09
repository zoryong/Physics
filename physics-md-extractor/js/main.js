/**
 * main.js — 애플리케이션 진입점 / 오케스트레이션
 * ------------------------------------------------------------------
 * 파이프라인:
 *   PDF 로드 → (페이지별) 렌더 + 텍스트추출/OCR → 라인 정렬
 *   → 문항 분리 → 그림 크롭 → 구조 분석 → 마크다운 조립 → UI/다운로드
 *
 * 각 단계는 별도 모듈로 분리되어 있고, 이 파일은 이를 연결하고
 * 진행 상황/오류/미리보기/편집/다운로드를 담당한다.
 * ------------------------------------------------------------------
 */
import { ensurePdfjs } from './lib-loader.js';
import { extractPageText, isTextReliable, orderLines, detectTwoColumn } from './pdf-text.js';
import { renderPage, extractFigures, cropRegion } from './render.js';
import { preprocessForOCR } from './preprocess.js';
import { OcrEngine } from './ocr.js';
import { splitQuestions } from './question-splitter.js';
import { parseQuestion } from './structure-parser.js';
import { assembleMarkdown, figureName } from './markdown.js';
import { recognizeLatex } from './ai-math.js';
import { saveCombined, saveFullZip, saveEachZip, buildCombinedMarkdown } from './download.js';

/* ------------------------------ DOM ------------------------------ */
const $ = (id) => document.getElementById(id);
const dom = {
  dropzone: $('dropzone'), fileInput: $('fileInput'), fileInfo: $('fileInfo'),
  ocrMode: $('ocrMode'), renderScale: $('renderScale'),
  optLatex: $('optLatex'), optFigures: $('optFigures'), optTwoCol: $('optTwoCol'),
  optAI: $('optAI'), aiFields: $('aiFields'), aiProvider: $('aiProvider'),
  aiBase: $('aiBase'), aiModel: $('aiModel'), aiKey: $('aiKey'),
  aiAppId: $('aiAppId'), aiAppKey: $('aiAppKey'),
  convertBtn: $('convertBtn'),
  status: $('status'), statusText: $('statusText'),
  progressTrack: $('progressTrack'), progressFill: $('progressFill'),
  logBox: $('logBox'), errBox: $('errBox'),
  qCount: $('qCount'), resultToolbar: $('resultToolbar'), copyAllBtn: $('copyAllBtn'),
  tabbar: $('tabbar'), emptyHint: $('emptyHint'),
  tabCards: $('tabCards'), tabCombined: $('tabCombined'), combinedText: $('combinedText'),
  downloadPanel: $('downloadPanel'),
  dlCombinedBtn: $('dlCombinedBtn'), dlZipBtn: $('dlZipBtn'), dlEachBtn: $('dlEachBtn'),
  guidePanel: $('guidePanel'), guideToggle: $('guideToggle'),
  toast: $('toast'),
};

/* ---------------------------- 상태 ------------------------------- */
let currentFile = null;
let questions = [];   // 최종 문항 결과 [{number, mdName, markdown, figures, source}]

/* --------------------------- UI 유틸 ----------------------------- */
function toast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => dom.toast.classList.remove('show'), 1800);
}
function setStatus(text, show = true) {
  dom.statusText.textContent = text;
  dom.status.classList.toggle('show', show);
}
function setProgress(ratio) {
  dom.progressTrack.classList.add('show');
  dom.progressFill.style.width = `${Math.round(ratio * 100)}%`;
}
function log(msg, level = '') {
  dom.logBox.classList.add('show');
  const cls = level ? ` class="lg-${level}"` : '';
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  dom.logBox.insertAdjacentHTML('beforeend', `<div${cls}>[${time}] ${escapeHtml(msg)}</div>`);
  dom.logBox.scrollTop = dom.logBox.scrollHeight;
}
function showError(msg) {
  dom.errBox.textContent = msg;
  dom.errBox.classList.add('show');
}
function clearError() { dom.errBox.classList.remove('show'); dom.errBox.textContent = ''; }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------- 파일 선택 ----------------------------- */
function handleFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
    showError('PDF 파일만 업로드할 수 있습니다.');
    return;
  }
  clearError();
  currentFile = file;
  const kb = file.size / 1024;
  const sizeStr = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`;
  dom.fileInfo.innerHTML =
    `<div class="file-item"><span class="fname">${escapeHtml(file.name)}</span>` +
    `<span class="fmeta">${sizeStr}</span>` +
    `<button class="rm" type="button" title="제거" id="rmFile">✕</button></div>`;
  $('rmFile').addEventListener('click', clearFile);
  dom.convertBtn.disabled = false;
}
function clearFile() {
  currentFile = null;
  dom.fileInput.value = '';
  dom.fileInfo.innerHTML = '';
  dom.convertBtn.disabled = true;
}

/* ----------------------- 핵심 파이프라인 ------------------------- */
async function convert() {
  if (!currentFile) return;
  clearError();
  dom.logBox.innerHTML = '';
  questions = [];
  renderResults();
  dom.convertBtn.disabled = true;
  dom.status.querySelector('.spinner')?.style.removeProperty('display');

  const scale = parseFloat(dom.renderScale.value) || 2;
  const mode = dom.ocrMode.value;            // auto | text | ocr
  const useLatex = dom.optLatex.checked;
  const useFigures = dom.optFigures.checked;
  const useTwoCol = dom.optTwoCol.checked;
  const aiCfg = readAiConfig();              // null 이면 오프라인(수식=이미지)
  if (dom.optAI.checked && !aiCfg) log('AI 수식 인식이 켜져 있으나 키가 비어 있어 이미지로 대체합니다.', 'warn');

  // 수식 자리표시자(⟦EQ:키⟧) → {pageIndex, box} 등록부
  const formulaMap = new Map();

  const ocr = new OcrEngine((m) => {
    if (m.type === 'warn') log(m.message, 'warn');
  });

  try {
    setStatus('PDF 여는 중…');
    setProgress(0.02);
    const pdfjsLib = ensurePdfjs();
    const buf = await currentFile.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const numPages = pdf.numPages;
    log(`총 ${numPages}페이지 PDF 로드 완료`, 'ok');

    const pages = [];            // {pageIndex, canvas, width, height, lines(all), twoCol}
    let ocrPages = 0;

    for (let p = 1; p <= numPages; p++) {
      setStatus(`페이지 처리 중 (${p}/${numPages})…`);
      const page = await pdf.getPage(p);

      // 1) 렌더링(그림 크롭·OCR 공용)
      const { canvas, width, height } = await renderPage(page, scale);

      // 2) 텍스트 추출 + 품질 판정 (2단 인식 옵션 반영)
      const { lines: textLines, metrics, formulas } = await extractPageText(page, scale, useTwoCol);
      const reliable = isTextReliable(metrics);

      let useOcr = false;
      if (mode === 'ocr') useOcr = true;
      else if (mode === 'auto') useOcr = !reliable;
      // mode === 'text' → 항상 텍스트

      let pageLines;
      if (useOcr) {
        ocrPages++;
        log(`p.${p}: 텍스트 부족(글자 ${metrics.chars}자) → OCR 수행`, 'warn');
        setStatus(`페이지 ${p} OCR 중… (스캔본은 시간이 걸립니다)`);
        const pre = await preprocessForOCR(canvas);
        const { lines: ocrLines } = await ocr.recognize(pre);
        pageLines = ocrLines;
      } else {
        pageLines = textLines;
        log(`p.${p}: 텍스트 추출 (글자 ${metrics.chars}자, 라인 ${metrics.lineCount}개)`);
        // 페이지별 수식 자리표시자를 전역 고유 키로 바꾸고 위치를 등록한다.
        if (formulas && formulas.length) {
          const pi = p - 1;
          for (const ln of pageLines) {
            if (ln.text.indexOf('\u27E6EQ:L') === -1) continue;
            ln.text = ln.text.replace(/\u27E6EQ:L(\d+)\u27E7/g, (_, i) => `\u27E6EQ:p${pi}e${i}\u27E7`);
          }
          formulas.forEach((f, i) => formulaMap.set(`p${pi}e${i}`, { pageIndex: pi, box: f }));
          log(`p.${p}: 인라인 수식 ${formulas.length}개 감지`);
        }
      }

      const twoCol = useTwoCol && detectTwoColumn(pageLines, width);
      const ordered = orderLines(pageLines, width, useTwoCol);

      pages.push({ pageIndex: p - 1, canvas, width, height, lines: ordered, twoCol });
      setProgress(0.05 + 0.75 * (p / numPages));
      await tick();
    }

    // 3) 전역 라인 목록 구성
    const globalLines = [];
    for (const pg of pages) {
      for (const ln of pg.lines) {
        globalLines.push({ text: ln.text, pageIndex: pg.pageIndex, box: ln });
      }
    }

    // 4) 문항 분리
    setStatus('문항 분리 중…');
    const { questions: rawQs, droppedNoise } = splitQuestions(globalLines);
    log(`문항 ${rawQs.length}개 감지 (노이즈 ${droppedNoise}줄 제외)`, 'ok');
    if (!rawQs.length) throw new Error('문항을 찾지 못했습니다. 번호(1., 2., …)를 인식하지 못했을 수 있습니다.');

    // 5) 문항별: 그림 크롭 + 구조 분석 + 마크다운
    setStatus('그림 추출 및 마크다운 생성 중…');
    for (let i = 0; i < rawQs.length; i++) {
      const q = rawQs[i];

      // 5-1) 그림 크롭
      const figures = [];
      if (useFigures) {
        const regions = questionRegions(q, pages);
        for (const reg of regions) {
          const pg = pages[reg.pageIndex];
          const figs = extractFigures(pg.canvas, pg.lines, reg);
          for (const f of figs) { f.pageIndex = reg.pageIndex; figures.push(f); }
        }
      }
      const figNames = figures.map((_, idx) => figureName(q.number, idx));
      figures.forEach((f, idx) => { f.name = figNames[idx]; });

      // 5-2) 구조 분석 + 조립
      const parsed = parseQuestion(q);
      let markdown = assembleMarkdown(parsed, figNames, useLatex);

      // 5-3) 인라인 수식 처리: 자리표시자 → LaTeX(AI) 또는 이미지 크롭
      markdown = await resolveFormulas(markdown, q.number, pages, formulaMap, figures, aiCfg);

      questions.push({
        number: q.number,
        mdName: `question${String(q.number).padStart(2, '0')}.md`,
        markdown,
        figures,
      });
      setProgress(0.8 + 0.2 * ((i + 1) / rawQs.length));
      await tick();
    }

    setProgress(1);
    setStatus(`완료! 문항 ${questions.length}개 변환${ocrPages ? ` (OCR ${ocrPages}p)` : ''}`, true);
    dom.status.querySelector('.spinner')?.style.setProperty('display', 'none');
    log('변환 완료', 'ok');
    renderResults();
    toast(`문항 ${questions.length}개 변환 완료`);
  } catch (err) {
    console.error(err);
    showError('변환 중 오류가 발생했습니다.\n' + (err && err.message ? err.message : err));
    log('오류: ' + (err && err.message ? err.message : err), 'err');
    setStatus('오류로 중단됨', false);
  } finally {
    await ocr.terminate();
    dom.convertBtn.disabled = false;
    setTimeout(() => dom.progressTrack.classList.remove('show'), 1200);
  }
}

/** 다음 프레임까지 양보(UI 업데이트가 반영되도록) */
function tick() { return new Promise((r) => setTimeout(r, 0)); }

/**
 * 문항이 차지하는 페이지별 크롭 영역 계산.
 * 2단 페이지면 해당 문항이 속한 단으로 x범위를 제한한다.
 */
function questionRegions(q, pages) {
  const byPage = new Map();
  for (const ln of q.lines) {
    const arr = byPage.get(ln.pageIndex) || [];
    arr.push(ln.box);
    byPage.set(ln.pageIndex, arr);
  }
  const regions = [];
  for (const [pi, boxes] of byPage) {
    const page = pages[pi];
    if (!page) continue;
    let top = Infinity, bottom = -Infinity, cxSum = 0;
    for (const b of boxes) {
      top = Math.min(top, b.top);
      bottom = Math.max(bottom, b.bottom);
      cxSum += (b.xLeft + b.xRight) / 2;
    }
    const cx = cxSum / boxes.length;
    let x0 = 0, x1 = page.width;
    if (page.twoCol) {
      const mid = page.width / 2;
      if (cx < mid) { x0 = 0; x1 = mid + page.width * 0.02; }
      else { x0 = mid - page.width * 0.02; x1 = page.width; }
    }
    regions.push({ pageIndex: pi, x0, y0: top - 6, x1, y1: bottom + 6 });
  }
  return regions;
}

/**
 * 마크다운 안의 수식 자리표시자(⟦EQ:키⟧)를 등장 순서대로 해소한다.
 *  - AI 설정이 있으면 잘라낸 수식 이미지를 LaTeX 로 변환해 $...$ 로 치환
 *  - 실패하거나 오프라인이면 이미지로 잘라 ![[questionNN_eqK.png]] 로 삽입
 * @returns {Promise<string>} 치환된 마크다운
 */
async function resolveFormulas(markdown, number, pages, formulaMap, figures, aiCfg) {
  const keys = [];
  markdown.replace(/\u27E6EQ:([A-Za-z0-9_]+)\u27E7/g, (_, k) => { keys.push(k); return _; });
  if (!keys.length) return markdown;

  // 이미 그림으로 잘린 영역(다이어그램) 안의 수식은 인라인에서 제외한다.
  const figBoxes = figures.filter((f) => f.box).map((f) => ({ ...f.box, pageIndex: f.pageIndex }));
  const insideFigure = (b, pageIndex) => {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return figBoxes.some((r) => r.pageIndex === pageIndex &&
      cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1);
  };

  const pad = String(number).padStart(2, '0');
  let eqIdx = 0;
  for (const key of keys) {
    const token = `\u27E6EQ:${key}\u27E7`;
    const info = formulaMap.get(key);
    if (!info) { markdown = markdown.replace(token, ''); continue; }
    const pg = pages[info.pageIndex];
    if (!pg) { markdown = markdown.replace(token, ''); continue; }
    if (insideFigure(info.box, info.pageIndex)) { markdown = markdown.replace(token, ''); continue; }

    eqIdx++;
    const crop = cropRegion(pg.canvas, info.box, 4);
    const name = `question${pad}_eq${eqIdx}.png`;

    let replacement = '';
    if (aiCfg) {
      const latex = await recognizeLatex(crop.dataURL, aiCfg, log);
      if (latex) replacement = `$${latex}$`;
    }
    if (!replacement) {
      // 오프라인/실패 → 이미지 삽입(그림 목록에 추가해 ZIP·썸네일에 포함)
      crop.name = name;
      figures.push(crop);
      replacement = `![[${name}]]`;
    }
    markdown = markdown.replace(token, replacement);
    await tick();
  }
  return markdown;
}

/** AI 수식 인식 설정을 읽는다. 비활성/키 미입력이면 null. */
function readAiConfig() {
  if (!dom.optAI || !dom.optAI.checked) return null;
  const provider = dom.aiProvider.value;
  if (provider === 'mathpix') {
    const appId = dom.aiAppId.value.trim();
    const appKey = dom.aiAppKey.value.trim();
    if (!appId || !appKey) return null;
    return { provider, appId, appKey };
  }
  const base = dom.aiBase.value.trim().replace(/\/+$/, '');
  const model = dom.aiModel.value.trim();
  const key = dom.aiKey.value.trim();
  if (!base || !key) return null;
  return { provider: 'openai', base, model, key };
}

/* --------------------------- 결과 UI ----------------------------- */
function renderResults() {
  const has = questions.length > 0;
  dom.emptyHint.style.display = has ? 'none' : 'block';
  dom.tabbar.style.display = has ? 'flex' : 'none';
  dom.resultToolbar.style.display = has ? 'flex' : 'none';
  dom.downloadPanel.style.display = has ? 'block' : 'none';
  dom.qCount.textContent = has ? `${questions.length}문항` : '';

  // 문항별 카드
  dom.tabCards.innerHTML = '';
  for (const q of questions) {
    dom.tabCards.appendChild(buildCard(q));
  }
  updateCombined();
  // 기본 탭: 카드
  activateTab('cards');
}

function buildCard(q) {
  const card = document.createElement('div');
  card.className = 'q-card';

  const titleText = firstSentence(q.markdown);
  const head = document.createElement('div');
  head.className = 'q-card-head';
  head.innerHTML =
    `<span class="q-badge">${q.number}번</span>` +
    `<span class="q-title">${escapeHtml(titleText)}</span>` +
    `<span class="q-flags">${q.figures.length ? `🖼 ${q.figures.length}` : ''}</span>`;
  card.appendChild(head);

  // 그림 썸네일
  const thumbs = document.createElement('div');
  thumbs.className = 'q-thumbs';
  if (q.figures.length) {
    for (const f of q.figures) {
      const img = document.createElement('img');
      img.src = f.dataURL;
      img.alt = f.name;
      img.title = f.name;
      thumbs.appendChild(img);
    }
  } else {
    thumbs.innerHTML = '<span class="no-fig">추출된 그림 없음</span>';
  }
  card.appendChild(thumbs);

  // 마크다운(편집 가능)
  const ta = document.createElement('textarea');
  ta.className = 'q-md';
  ta.spellcheck = false;
  ta.value = q.markdown;
  ta.addEventListener('input', () => { q.markdown = ta.value; updateCombined(); });
  card.appendChild(ta);

  // 액션
  const actions = document.createElement('div');
  actions.className = 'q-actions';
  const copyBtn = mkBtn('복사', 'btn ghost sm', () => copyText(ta.value));
  const dlBtn = mkBtn('.md 저장', 'btn ghost sm', () => {
    const blob = new Blob([ta.value + '\n'], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = q.mdName;
    document.body.appendChild(a); a.click(); a.remove();
  });
  actions.append(copyBtn, dlBtn);
  card.appendChild(actions);

  return card;
}

function mkBtn(label, className, onClick) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = className; b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function firstSentence(md) {
  // [발문] 다음 줄을 카드 제목으로
  const lines = md.split('\n');
  const idx = lines.indexOf('[발문]');
  const t = (idx >= 0 && lines[idx + 1]) ? lines[idx + 1] : (lines[2] || '');
  return t.length > 46 ? t.slice(0, 46) + '…' : (t || '(발문 없음)');
}

function updateCombined() {
  dom.combinedText.value = questions.length ? buildCombinedMarkdown(questions) : '';
}

/* ----------------------------- 탭 -------------------------------- */
function activateTab(name) {
  dom.tabCards.style.display = name === 'cards' ? 'flex' : 'none';
  dom.tabCombined.style.display = name === 'combined' ? 'block' : 'none';
  for (const btn of dom.tabbar.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
}

/* --------------------------- 복사 유틸 --------------------------- */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('클립보드에 복사했습니다');
  } catch (_) {
    // 폴백
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    toast('클립보드에 복사했습니다');
  }
}

/* ------------------------- 이벤트 연결 --------------------------- */
function bindEvents() {
  // 드롭존
  dom.dropzone.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
  ['dragenter', 'dragover'].forEach((ev) =>
    dom.dropzone.addEventListener(ev, (e) => { e.preventDefault(); dom.dropzone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dom.dropzone.addEventListener(ev, (e) => { e.preventDefault(); dom.dropzone.classList.remove('drag'); }));
  dom.dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  // 변환
  dom.convertBtn.addEventListener('click', convert);

  // 탭
  dom.tabbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) activateTab(btn.dataset.tab);
  });

  // 복사 / 다운로드
  dom.copyAllBtn.addEventListener('click', () => copyText(buildCombinedMarkdown(questions)));
  dom.dlCombinedBtn.addEventListener('click', () => { saveCombined(questions); toast('physics.md 저장'); });
  dom.dlZipBtn.addEventListener('click', async () => {
    dom.dlZipBtn.disabled = true; dom.dlZipBtn.textContent = '압축 중…';
    try { await saveFullZip(questions); toast('ZIP 저장 완료'); }
    catch (e) { showError('ZIP 생성 실패: ' + e.message); }
    finally { dom.dlZipBtn.disabled = false; dom.dlZipBtn.textContent = '📦 ZIP (md + 그림)'; }
  });
  dom.dlEachBtn.addEventListener('click', async () => {
    try { await saveEachZip(questions); toast('문항별 .md ZIP 저장'); }
    catch (e) { showError('ZIP 생성 실패: ' + e.message); }
  });

  // 사용 방법 토글
  dom.guideToggle.addEventListener('click', () => dom.guidePanel.classList.toggle('open'));

  // AI 수식 인식 옵션 토글
  if (dom.optAI) {
    dom.optAI.addEventListener('change', () => {
      dom.aiFields.style.display = dom.optAI.checked ? 'grid' : 'none';
    });
  }
  if (dom.aiProvider) {
    dom.aiProvider.addEventListener('change', updateAiProviderFields);
    updateAiProviderFields();
  }
}

/** 선택한 AI 제공자에 맞는 입력 필드만 표시 */
function updateAiProviderFields() {
  const prov = dom.aiProvider.value;
  for (const el of dom.aiFields.querySelectorAll('[data-prov]')) {
    el.style.display = el.dataset.prov === prov ? '' : 'none';
  }
}

bindEvents();
