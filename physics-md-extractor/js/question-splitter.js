/**
 * question-splitter.js
 * ------------------------------------------------------------------
 * 페이지 경계를 넘나드는 전체 라인 목록에서
 *   1) 머리말/꼬리말/워터마크 등 노이즈 라인 제거
 *   2) 문항 번호(1. 2. … 20.)를 기준으로 문항 분리
 *   3) 페이지를 넘어가는 문항을 하나로 병합
 * 을 수행한다.
 *
 * 입력 라인 구조(각 페이지 처리 결과를 이어붙인 것):
 *   { text, pageIndex, box:{xLeft,xRight,top,bottom,height} }
 *
 * 출력 문항 구조:
 *   { number, lines:[{text,pageIndex,box}], textLines:[string] }
 * ------------------------------------------------------------------
 */

// 문항 시작: 줄 맨 앞의 "12." 형태. 소수점(0.8)과 구분하기 위해 뒤에 숫자가 오면 제외.
const Q_START_RE = /^\s*(\d{1,2})\s*[.．](?!\d)\s*/;

/** 머리말/꼬리말/워터마크 등 문항과 무관한 노이즈 라인인지 판정 */
export function isNoiseLine(text) {
  const t = text.trim();
  if (!t) return true;
  if (/^-{2,}.*of.*-{2,}$/i.test(t)) return true;               // -- 1 of 4 --
  if (/^\d{1,3}\s+\d{1,3}$/.test(t)) return true;               // "1 32" 쪽/문항 카운터
  if (/전국연합학력평가|학년도.*평가|문제지|채점|정답과\s*해설/.test(t)) return true;
  if (/과학탐구\s*영역/.test(t)) return true;
  if (/^제\s*\d+\s*교시/.test(t)) return true;
  if (/^(홀수형|짝수형)$/.test(t)) return true;
  if (/^성명|수험\s*번호|선택\s*과목/.test(t)) return true;
  if (/^\s*[물리학ⅠⅡ]\s*$/.test(t)) return true;                // 세로 워터마크 한 글자
  if (/^[A-Za-z가-힣]$/.test(t)) return true;                    // 낱글자 한 개
  if (/^\d{1,2}$/.test(t)) return true;                          // 페이지 번호 등 단독 숫자
  if (/^[\-–—·•∙]+$/.test(t)) return true;                       // 구분선 기호만
  return false;
}

/**
 * @param {Array} lines  전체 라인(페이지 순 + 각 페이지 읽기순으로 정렬된 상태)
 * @returns {{questions:Array, droppedNoise:number}}
 */
export function splitQuestions(lines) {
  // 1) 노이즈 제거
  let dropped = 0;
  const clean = lines.filter((l) => {
    if (isNoiseLine(l.text)) { dropped++; return false; }
    return true;
  });

  // 2) 시작 후보 수집
  const candidates = [];
  clean.forEach((l, i) => {
    const m = l.text.match(Q_START_RE);
    if (m) candidates.push({ i, num: parseInt(m[1], 10) });
  });

  // 3) 증가하는(대체로 연속) 번호 시퀀스만 시작점으로 채택
  const starts = [];
  let last = 0;
  for (const c of candidates) {
    if (starts.length === 0) {
      if (c.num >= 1 && c.num <= 3) { starts.push(c); last = c.num; }
      continue;
    }
    if (c.num > last && c.num <= last + 4) { starts.push(c); last = c.num; }
  }
  // 시작점이 하나도 없으면(감지 실패) 전체를 1문항으로
  if (starts.length === 0) {
    if (!clean.length) return { questions: [], droppedNoise: dropped };
    return {
      questions: [buildQuestion(1, clean)],
      droppedNoise: dropped,
    };
  }

  // 4) 시작점 사이 구간을 문항으로 묶기(첫 시작점 이전 라인은 표지/안내로 버림)
  const questions = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s].i;
    const to = s + 1 < starts.length ? starts[s + 1].i : clean.length;
    const segment = clean.slice(from, to);
    questions.push(buildQuestion(starts[s].num, segment));
  }

  return { questions, droppedNoise: dropped };
}

/** 세그먼트(라인들)를 문항 객체로 변환. 첫 라인의 "N." 접두어는 제거. */
function buildQuestion(number, segment) {
  const lines = segment.map((l, idx) => {
    let text = l.text;
    if (idx === 0) text = text.replace(Q_START_RE, '').trim();
    return { text, pageIndex: l.pageIndex, box: l.box };
  }).filter((l) => l.text.length > 0 || true); // 좌표 유지 위해 빈 텍스트도 보존 가능

  return {
    number,
    lines,
    textLines: lines.map((l) => l.text).filter((t) => t.length > 0),
  };
}
