/**
 * ai-math.js
 * ------------------------------------------------------------------
 * (선택) 잘라낸 수식 이미지를 외부 AI에 보내 LaTeX 문자열로 변환한다.
 * 사용자가 API 키를 입력했을 때만 동작하며, 미사용 시에는 수식이
 * 이미지로 삽입된다(오프라인 기본 동작). 키·이미지는 사용자가 지정한
 * 제공자에게 직접 전송된다.
 *
 * 지원 제공자:
 *   - openai : OpenAI 호환 Chat Completions Vision 엔드포인트
 *              (OpenAI gpt-4o / gpt-4o-mini, 호환 게이트웨이 등)
 *   - mathpix: Mathpix v3/text (수식 특화 OCR, 정확도 높음)
 * ------------------------------------------------------------------
 */

/**
 * 수식 이미지(dataURL)를 LaTeX 로 변환. 실패 시 빈 문자열 반환.
 * @param {string} dataURL  PNG data URL
 * @param {object} cfg      readAiConfig() 결과
 * @param {function} [log]  로그 콜백
 * @returns {Promise<string>} LaTeX(구분자 제외) 또는 ''
 */
export async function recognizeLatex(dataURL, cfg, log) {
  try {
    const raw = cfg.provider === 'mathpix'
      ? await viaMathpix(dataURL, cfg)
      : await viaOpenAI(dataURL, cfg);
    return cleanLatex(raw);
  } catch (e) {
    if (log) log('AI 수식 인식 실패: ' + (e && e.message ? e.message : e), 'warn');
    return '';
  }
}

/** OpenAI 호환 Vision 채팅 완성 호출 */
async function viaOpenAI(dataURL, cfg) {
  const url = `${cfg.base}/chat/completions`;
  const body = {
    model: cfg.model || 'gpt-4o-mini',
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              '이 이미지는 물리 시험지의 수식 조각이다. 내용을 LaTeX 로만 변환해 출력하라. ' +
              '설명·따옴표·$ 기호·코드블록 없이 순수 LaTeX 식만 한 줄로 출력하라. ' +
              '예: t=\\frac{5}{6}t_0',
          },
          { type: 'image_url', image_url: { url: dataURL } },
        ],
      },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await safeText(res)}`);
  const json = await res.json();
  return json?.choices?.[0]?.message?.content || '';
}

/** Mathpix v3/text 호출 */
async function viaMathpix(dataURL, cfg) {
  const res = await fetch('https://api.mathpix.com/v3/text', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      app_id: cfg.appId,
      app_key: cfg.appKey,
    },
    body: JSON.stringify({
      src: dataURL,
      formats: ['latex_styled'],
      math_inline_delimiters: ['', ''],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await safeText(res)}`);
  const json = await res.json();
  return json?.latex_styled || json?.text || '';
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 120); } catch { return ''; }
}

/** 모델이 붙일 수 있는 구분자($, \(...\), 코드펜스 등)를 제거해 순수 식만 남긴다. */
function cleanLatex(s) {
  if (!s) return '';
  let t = String(s).trim();
  t = t.replace(/^```(?:latex|math)?\s*/i, '').replace(/```$/i, '').trim();
  t = t.replace(/^\\\[|\\\]$/g, '').replace(/^\\\(|\\\)$/g, '').trim();
  // 앞뒤 $ 또는 $$ 제거
  t = t.replace(/^\${1,2}/, '').replace(/\${1,2}$/, '').trim();
  // 여러 줄이면 공백으로 합침
  t = t.replace(/\s*\n\s*/g, ' ').trim();
  return t;
}
