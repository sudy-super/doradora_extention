// content.js の純粋ロジックを、ブラウザ API をスタブして実行する確認スクリプト。 node check.js
const fs = require('fs');
const src = fs.readFileSync(`${__dirname}/content.js`, 'utf8');

function harness(propsObj) {
  const noop = () => {};
  const propsEl = { textContent: JSON.stringify(propsObj) };
  const stub = {
    AudioContext: class {
      resume() {}
      createOscillator() { return { connect: () => ({ connect: noop }), start: noop, stop: noop, frequency: {} }; }
      createGain() { return { connect: () => ({ connect: noop }), gain: { setValueAtTime: noop, linearRampToValueAtTime: noop } }; }
      get currentTime() { return 0; }
    },
    MutationObserver: class { observe() {} },
    PerformanceObserver: class { observe() {} },
    document: {
      createElement: () => ({ style: {}, hidden: false, appendChild: noop }),
      body: { appendChild: noop },
      documentElement: {},
      querySelector: (sel) => (sel.includes('js-react-on-rails-component') ? propsEl : null),
    },
    Node: { ELEMENT_NODE: 1 },
    performance: { now: () => 0 },
    addEventListener: noop,
    setInterval: noop,
    indexedDB: {},
  };
  const body = `${src}
    ;return {
      untilNextQuiz, untilNextRecognition, untilNextImageLog, parseDetailLog, foldDetailLogs, mmss,
      setLogs: (rowsOldestFirst) => { logState = foldDetailLogs([...rowsOldestFirst].reverse()); },
      bump: () => { recognitionCount += 1; },
    };`;
  const keys = Object.keys(stub);
  return new Function(...keys, body)(...keys.map((k) => stub[k]));
}

let failed = 0;
function eq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok ' : 'NG '} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (期待 ${JSON.stringify(expected)})`}`);
}

const api = harness({ video: { recgCount: 3 }, quizAttributes: { 300: [], 900: [] } });

eq('mmss(0)', api.mmss(0), '0:00');
eq('mmss(59.4)', api.mmss(59.4), '0:59');
eq('mmss(-3) は 0 に丸める', api.mmss(-3), '0:00');
eq('mmss(3102.766)', api.mmss(3102.766), '51:43');

eq('小テスト cur=0', api.untilNextQuiz(0), 300);
eq('小テスト cur=500', api.untilNextQuiz(500), 400);
eq('小テスト cur=950 は残りなし', api.untilNextQuiz(950), null);

// 詳細ログの行形式は utils/log.ts の recordDetailLog / recordEventLog
const t = (hms) => `2026-09-05 ${hms}`;
const ms = (hms) => new Date(`2026-09-05T${hms}`).getTime();
const ev = (time, type, detail = '{}') => ({ time, level: 'info', body: JSON.stringify({ logtime: 0, event_type: type, event_detail: detail }) });
const iv = (time, sec) => ({ time, level: 'info', body: `useImageLogTimer - setNextTarget : interval: ${sec}` });
const noise = (time) => ({ time, level: 'info', body: 'useVideoSeekMonitor : currentSec: 1, elapsedSec: 1' });

eq('interval 行', api.parseDetailLog(iv(t('10:00:00.000'), 51)), { time: ms('10:00:00.000'), kind: 'interval', value: 51 });
eq('630 行から next_sec', api.parseDetailLog(ev(t('10:00:00.000'), 630, '{"next_sec":776,"_executionID":"ab"}')), { time: ms('10:00:00.000'), kind: 'next_sec', value: 776 });
eq('視聴開始は rearm', api.parseDetailLog(ev(t('10:00:00.000'), 110)).kind, 'rearm');
eq('無関係な行は null', api.parseDetailLog(noise(t('10:00:00.000'))), null);
eq('壊れた行は null', api.parseDetailLog({ time: t('10:00:00.000'), body: '{' }), null);

// 実際に観測された「2回目の撮影が9秒早い」ケース:
// 10:00:00 マウント (ログなし) → 10:00:09 視聴開始 → 10:01:09 初回撮影で interval = 60-9 = 51 が記録される
api.setLogs([ev(t('10:00:09.000'), 110), noise(t('10:00:10.000'))]);
eq('初回は視聴開始 + 60秒', api.untilNextImageLog(ms('10:00:19.000')), 50);
api.setLogs([ev(t('10:00:09.000'), 110), noise(t('10:00:10.000')), iv(t('10:01:09.000'), 51), noise(t('10:01:10.000'))]);
eq('2回目は記録された 51秒 後 (前回+60 ではない)', api.untilNextImageLog(ms('10:01:19.000')), 41);

// 小テスト中はタイマーが止まり、終了時に前回の間隔で張り直される
api.setLogs([ev(t('10:00:09.000'), 110), iv(t('10:01:09.000'), 51), ev(t('10:01:30.000'), 850), ev(t('10:02:30.000'), 860)]);
eq('小テスト終了時刻 + 前回の間隔', api.untilNextImageLog(ms('10:02:40.000')), 41);

// 本人確認は最新の 630 を採用し、rearm や interval は影響しない
api.setLogs([ev(t('10:00:09.000'), 110), ev(t('10:00:09.100'), 630, '{"next_sec":776}'), iv(t('10:01:09.000'), 51), ev(t('10:15:00.000'), 530), ev(t('10:15:00.100'), 630, '{"next_sec":1552}')]);
eq('本人確認は最新の next_sec', api.untilNextRecognition(1000), 552);
eq('本人確認成功で撮影タイマーも張り直し', api.untilNextImageLog(ms('10:15:10.000')), 41);
api.setLogs([]);
eq('ログなしは撮影 null', api.untilNextImageLog(ms('10:00:00.000')), null);
eq('ログなしは本人確認 undefined', api.untilNextRecognition(100), undefined);
api.bump(); api.bump(); api.bump();
eq('本人確認 3回終えたら null', api.untilNextRecognition(100), null);

console.log(failed === 0 ? 'すべて OK' : `失敗 ${failed} 件`);
process.exit(failed === 0 ? 0 : 1);
