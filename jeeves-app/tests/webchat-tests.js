// 웹 로그인형 공급자 시험(가짜 화면 사용): 질문 만들기, 답변 잘라내기, 로그인 필요 처리, 입력창 없음, 답 안정 대기, 한도 문구, 도구 호출 거부
const assert = require('assert');
const { askWebChat, buildPrompt, extractAnswer, callWebChat, setWebChatHost } = require('../src/models/webchat');
const { ModelRouter } = require('../src/models/router');
const results = [];
const t = async (name, fn) => { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } };
const sleep = async () => {};

// 가짜 탭: 스크립트 표식(/*JV:xxx*/)으로 동작을 흉내 낸다. region 글은 단계별로 바뀐다.
const fakeWc = ({ url = 'https://x.com/chat', hasInput = true, steps = [], sendHow = 'click' } = {}) => {
  let phase = 0, sent = '';
  return {
    sentText: () => sent, getURL: () => url, focus() {}, sendInputEvent() {},
    executeJavaScript: async s => {
      if (s.startsWith('/*JV:prepare*/')) return { ok: hasInput, url };
      if (s.startsWith('/*JV:fill*/')) { sent = JSON.parse(/const t = (".*?");/s.exec(s)[1]); return true; }
      if (s.startsWith('/*JV:send*/')) return sendHow;
      if (s.startsWith('/*JV:poll*/')) { const st = steps[Math.min(phase++, steps.length - 1)]; return { text: typeof st.text === 'function' ? st.text(sent) : st.text, busy: !!st.busy, url }; }
    }
  };
};
const Q = '1인 기업 사업 모델을 추천해줘';

(async () => {
  await t('질문 만들기: 마지막 사용자 글만, 시스템 지시는 앞에', () => {
    const p = buildPrompt({ system: '짧게', messages: [{ role: 'user', content: [{ type: 'text', text: '첫 질문' }] }, { role: 'assistant', content: [{ type: 'text', text: '답' }] }, { role: 'user', content: [{ type: 'text', text: '둘째 질문' }] }] });
    assert.strictEqual(p, '짧게\n\n둘째 질문');
  });

  await t('답변 자르기: 공백·줄바꿈이 달라도 질문 뒤 글만, 사이드바 글은 제외', () => {
    const page = `대화 기록\n오래된 대화 제목\n\nYou\n1인 기업   사업 모델을\n추천해줘\nAssistant\n첫째 안\n둘째 안`;
    assert.strictEqual(extractAnswer(page, Q), 'Assistant\n첫째 안\n둘째 안');
    assert.strictEqual(extractAnswer('아직 아무 글 없음', Q), '');
  });

  await t('답변 자르기: 따옴표·마크다운 모양이 바뀌어도 질문을 찾음', () => {
    const page = '메뉴\n\n짧게 답하세요.\n\n연결 테스트입니다. “OK”라고만 답하세요.\n\nOK';
    assert.strictEqual(extractAnswer(page, '짧게 답하세요.\n\n연결 테스트입니다. "OK"라고만 답하세요.'), 'OK');
  });

  await t('대화: 답이 스트리밍되다 멈추면(안정) 최종 답을 돌려줌', async () => {
    const wc = fakeWc({ steps: [{ text: s => `You\n${s}\n` }, { text: s => `You\n${s}\nA` , busy: true }, { text: s => `You\n${s}\nA B` , busy: true }, { text: s => `You\n${s}\nA B C` }, { text: s => `You\n${s}\nA B C` }, { text: s => `You\n${s}\nA B C` }, { text: s => `You\n${s}\nA B C` }, { text: s => `You\n${s}\nA B C` }] });
    const r = await askWebChat(wc, Q, { sleep });
    assert.strictEqual(r, 'A B C'); assert.strictEqual(wc.sentText(), Q);
  });

  await t('로그인 화면이면 auth 오류(로그인 요청 문구)', async () => {
    await assert.rejects(() => askWebChat(fakeWc({ url: 'https://www.magnumatics.com/signin' }), Q, { sleep }), e => e.kind === 'auth' && /로그인/.test(e.message));
    await assert.rejects(() => askWebChat(fakeWc({ hasInput: false }), Q, { sleep }), e => e.kind === 'auth' && /입력창/.test(e.message));
  });

  await t('화면이 늦게 그려져도(입력칸이 몇 초 뒤 나타남) 기다렸다가 진행', async () => {
    const wc = fakeWc({ steps: [{ text: s => `${s}\n답입니다` }] });
    const orig = wc.executeJavaScript; let n = 0;
    wc.executeJavaScript = async s => (s.startsWith('/*JV:prepare*/') && n++ < 3) ? { ok: false, url: 'https://x.com/chat' } : orig(s);
    const r = await askWebChat(wc, Q, { sleep, stableMs: 2000, pollMs: 1000 });
    assert.strictEqual(r, '답입니다'); assert.ok(n >= 4);
  });

  await t('시간 초과: 받은 부분이 있으면 돌려주고, 아무것도 없으면 오류', async () => {
    const a = await askWebChat(fakeWc({ steps: [{ text: s => `${s}\n조금`, busy: true }] }), Q, { sleep, timeoutMs: 5000, pollMs: 1000 });
    assert.strictEqual(a, '조금');
    await assert.rejects(() => askWebChat(fakeWc({ steps: [{ text: '빈 화면' }] }), Q, { sleep, timeoutMs: 3000, pollMs: 1000 }), /시간 안에/);
  });

  await t('공급자 호출: 도구 호출 거부, 한도 문구는 limit, 정보 등급 P 전용 관문, 비용 0', async () => {
    const p = { type: 'webchat', label: 'ExoLobe', baseUrl: 'https://www.magnumatics.com/chat', tier: 'free', maxGrade: 'P' };
    await assert.rejects(() => callWebChat(p, 'x', { messages: [], tools: [{ name: 'a' }] }), e => e.kind === 'none');
    setWebChatHost(async () => fakeWc({ steps: [{ text: s => `${s}\n사용 한도에 도달했습니다` }] }));
    const msg = [{ role: 'user', content: [{ type: 'text', text: Q }] }];
    p.timeoutMs = 3000; p.pollMs = 1; p.stableMs = 3;
    await assert.rejects(() => callWebChat(p, 'x', { messages: msg }), e => e.kind === 'limit');
    const cfg = { providers: { exolobe: p }, roles: {}, infoGrade: 'P' };
    const router = new ModelRouter(() => cfg, async () => { throw new Error('no fetch'); });
    await assert.rejects(() => router.callProvider('exolobe', 'web', { messages: msg, infoGrade: 'I' }), /정보 등급/);
  });

  let fail = 0;
  for (const [ok, name, err] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + err}`); }
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})();
