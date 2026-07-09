/**
 * structure-parser.js
 * ------------------------------------------------------------------
 * 한 문항의 텍스트 라인들을 의미 단위로 분해한다.
 *   [발문]   상황 서술 문장
 *   [발문2]  실제로 묻는 질문 문장(보통 "…고른 것은?" + (단, …) [3점])
 *   [보기]   <보기> 박스의 ㄱ/ㄴ/ㄷ 항목
 *   [선지]   ①~⑤ 선택지
 * 그림은 별도 크롭 후 main 에서 [발문]과 [발문2] 사이에 삽입한다.
 *
 * 모든 결과는 원문 텍스트(변환 전)이며, LaTeX 변환은 markdown.js 가 담당.
 * ------------------------------------------------------------------
 */

const CHOICE_RE = /[\u2460-\u2464]/;                 // ①~⑤
const CHOICE_SPLIT_RE = /([\u2460-\u2464])/;
const BOGI_ITEM_RE = /^[ㄱ-ㅎ]\s*[.．]/;             // "ㄱ." "ㄴ."
// 보기 박스 헤더: 그 줄 "전체"가 <보기>/<보 기>/[보기]/보기 인 경우만.
// (발문 속 "…<보기>에서…" 같은 표현을 헤더로 오인하지 않도록 라인 전체를 검사)
const BOGI_HEADER_LINE_RE = /^[<\[]?\s*보\s*기\s*[>\]]?$/;
const BOGI_HEADER_STRIP_RE = /^[<\[]?\s*보\s*기\s*[>\]]?/;
// 한국어 서술문 종결( …다. / …요. / …오. )
const SENT_END_RE = /(다|요|오|음)\s*[.．]/g;

/**
 * @param {{number:number, textLines:string[]}} question
 * @returns {{number, intro, question2, bogi:string[], choices:string[], hasBogi:boolean}}
 */
export function parseQuestion(question) {
  const lines = question.textLines.slice();

  // 1) 선지 시작 위치
  let choiceStart = lines.findIndex((t) => CHOICE_RE.test(t));
  if (choiceStart === -1) choiceStart = lines.length;

  // 2) 보기 시작 위치(선지 이전 범위에서)
  let bogiStart = -1;
  for (let i = 0; i < choiceStart; i++) {
    const tt = lines[i].trim();
    if (BOGI_HEADER_LINE_RE.test(tt) || BOGI_ITEM_RE.test(tt)) { bogiStart = i; break; }
  }
  const hasBogi = bogiStart !== -1;

  // 3) 구간 나누기
  const preEnd = hasBogi ? bogiStart : choiceStart;
  const preLines = lines.slice(0, preEnd);
  const bogiLines = hasBogi ? lines.slice(bogiStart, choiceStart) : [];
  const choiceLines = lines.slice(choiceStart);

  // 4) 발문 / 발문2 분리
  const { intro, question2 } = splitIntro(preLines.join(' ').replace(/\s+/g, ' ').trim());

  // 5) 보기 항목 파싱
  const bogi = parseBogi(bogiLines);

  // 6) 선지 파싱
  const choices = parseChoices(choiceLines.join(' '));

  return { number: question.number, intro, question2, bogi, choices, hasBogi };
}

/** 발문(상황) / 발문2(질문) 분리: 마지막 '?' 를 포함한 문장을 발문2로 본다. */
function splitIntro(preText) {
  if (!preText) return { intro: '', question2: '' };

  const qMark = preText.lastIndexOf('?');
  if (qMark === -1) {
    // 물음표가 없으면 전체를 발문으로
    return { intro: preText, question2: '' };
  }

  // '?' 이전에서 가장 마지막 서술 종결(…다.) 위치를 찾아 그 뒤를 발문2 시작으로
  let splitAt = 0;
  let m;
  SENT_END_RE.lastIndex = 0;
  while ((m = SENT_END_RE.exec(preText)) !== null) {
    if (m.index + m[0].length <= qMark) splitAt = m.index + m[0].length;
    else break;
  }

  const intro = preText.slice(0, splitAt).trim();
  const question2 = preText.slice(splitAt).trim();
  // 발문이 비면(질문만 있는 경우) 그대로 둔다.
  return { intro, question2 };
}

/** <보기> 박스의 ㄱ/ㄴ/ㄷ 항목을 병합해 배열로 반환 */
function parseBogi(bogiLines) {
  const items = [];
  let cur = null;
  for (let raw of bogiLines) {
    let t = raw.trim().replace(BOGI_HEADER_STRIP_RE, '').trim();   // 헤더 줄 제거
    if (!t) continue;
    if (BOGI_ITEM_RE.test(t)) {
      if (cur) items.push(cur.trim());
      cur = t;
    } else if (cur !== null) {
      cur += ' ' + t;                                  // 여러 줄에 걸친 항목 병합
    } else {
      // 헤더 다음의 선행 텍스트가 항목 없이 오면 무시
      cur = t;
    }
  }
  if (cur) items.push(cur.trim());
  // "ㄱ ." → "ㄱ." 정규화
  return items.map((s) => s.replace(/^([ㄱ-ㅎ])\s*[.．]\s*/, '$1. '));
}

/** ①~⑤ 선지를 분리 */
function parseChoices(choiceText) {
  const t = choiceText.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const parts = t.split(CHOICE_SPLIT_RE); // [앞쓰레기, '①', '내용', '②', '내용', ...]
  const choices = [];
  for (let i = 1; i < parts.length; i += 2) {
    const marker = parts[i];
    const body = (parts[i + 1] || '').trim();
    choices.push(`${marker} ${body}`.trim());
  }
  return choices;
}
