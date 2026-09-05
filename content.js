// 放置すると受講が中断されるものを検知してアラームを鳴らす。

const VOLUME = 0.25;
const REPEAT_MS = 1500;
// 操作がこの時間以上ない場合を「席を外している」とみなす
const IDLE_MS = 5000;

const HOLD = '.toastr.recognition-toastr, .toastr.rrt-error';
const NOTIFY = '.toastr.rrt-warning';
const QUIZ_BAR = '.progress.progress-sm';
const QUIZ_MSG = '1分以内に回答がない場合';

const audio = new AudioContext();
let lastAlarmAt = 0;
let lastInputAt = 0;
let recognitionCount = 0;

function beep(freq, offsetSec, durSec) {
  const t0 = audio.currentTime + offsetSec;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  // 矩形波のブツ切りはクリックノイズになるので前後をなだらかにする
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(VOLUME, t0 + 0.01);
  gain.gain.setValueAtTime(VOLUME, t0 + durSec - 0.02);
  gain.gain.linearRampToValueAtTime(0, t0 + durSec);
  osc.connect(gain).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + durSec + 0.02);
}

function alarm(urgent) {
  const now = Date.now();
  if (now - lastAlarmAt < 800) return;
  lastAlarmAt = now;
  audio.resume();
  if (urgent) {
    // 対応必須: 高音の4連
    beep(1319, 0.0, 0.09);
    beep(1568, 0.12, 0.09);
    beep(1319, 0.24, 0.09);
    beep(1568, 0.36, 0.09);
  } else {
    // 通知: 低めの2連
    beep(880, 0.0, 0.12);
    beep(1175, 0.16, 0.12);
  }
}

// 小テストの「問題」画面が出ているか。解答表示画面には注意文がないので除外される
function isQuizQuestionOpen() {
  const bar = document.querySelector(QUIZ_BAR);
  return !!bar && bar.parentElement.textContent.includes(QUIZ_MSG);
}

const seen = new WeakSet();

function scan(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const found = node.matches('.toastr') ? [node] : [];
  found.push(...node.querySelectorAll('.toastr'));
  for (const el of found) {
    if (seen.has(el)) continue;
    seen.add(el);
    // 本人確認の要請回数 = 済んだ顔認証の回数。次回予測に使う
    if (el.classList.contains('recognition-toastr')) recognitionCount += 1;
    if (el.matches(HOLD)) alarm(true);
    else if (el.matches(NOTIFY)) alarm(false);
  }
}

new MutationObserver((records) => {
  for (const r of records) r.addedNodes.forEach(scan);
}).observe(document.documentElement, { childList: true, subtree: true });

setInterval(() => {
  if (document.querySelector(HOLD)) alarm(true);
  else if (isQuizQuestionOpen() && Date.now() - lastInputAt > IDLE_MS) alarm(true);
}, REPEAT_MS);

for (const type of ['mousemove', 'mousedown', 'wheel', 'keydown']) {
  addEventListener(type, () => {
    lastInputAt = Date.now();
    // 動画開始前は AudioContext が suspended なので最初の操作で起こす
    audio.resume();
  }, { capture: true, passive: true });
}

// 音量確認用: Ctrl+Alt+Shift+B で対応必須音、Ctrl+Alt+Shift+N で通知音
addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.altKey && e.shiftKey)) return;
  if (e.code === 'KeyB') alarm(true);
  if (e.code === 'KeyN') alarm(false);
}, { capture: true });

//-----------------------------------------------------------------------------
// 左上に動画の残り時間と、次に対応が必要になるものまでの時間を表示する。
// 動画は react-player 経由の <video> 要素なので currentTime / duration をそのまま読む。
// フルスクリーン対象が document.documentElement なので position:fixed で重ねられる。
// 操作を邪魔しないよう pointer-events は無効にしておく。
//
// 各項目の取得方法:
//   小テスト … Rails から渡る props の quizAttributes のキーが出題位置(秒)
//   本人確認 … 次回の位置(秒)は乱数で決まるが、決まった瞬間に SYSTEM_SET_RECOGNITION_TIMER
//              (event_type 630) が IndexedDB に記録される。その next_sec を読む
//   撮影     … useImageLogTimer は「タイマーを張った時刻 + 間隔」で次を撮る。
//              間隔は setNextTarget のたびに詳細ログに書かれ、タイマーは
//              setNextTarget 直後 / 動画開始 / 本人確認成功 / 小テスト終了 の時点で張り直される。
//              なので「それらの最新時刻 + 最新の間隔」が次回。単純な前回+60秒だと
//              初回だけマウント起点のグリッドに寄せられて短くなり、画面遷移でもずれる
// いずれもアプリが IndexedDB (mfdsolDatabase / attendanceDetailLog) に自分で書くログを
// 読み取り専用で走査するだけで、ページの DOM や fetch には触らない。

const HUD_INTERVAL_MS = 500;
const LOG_DB = 'mfdsolDatabase';
const LOG_STORE = 'attendanceDetailLog';
const LOG_POLL_MS = 2000;
const IMAGE_LOG_INTERVAL_S = 60;
const IMAGE_LOG_INTERVAL_PREFIX = 'useImageLogTimer - setNextTarget : interval: ';
const EVENT_SET_RECOGNITION_TIMER = 630;
// 画面が動画に戻ってタイマーが張り直されるイベント: 視聴開始 / デバッグ視聴開始 / 本人確認成功 / 小テスト終了
const EVENT_REARM = new Set([110, 170, 530, 860]);

const hud = document.createElement('div');
hud.style.cssText = [
  'position:fixed', 'top:8px', 'left:8px', 'z-index:2147483647',
  'pointer-events:none', 'padding:6px 10px', 'border-radius:6px',
  'background:rgba(0,0,0,0.6)', 'color:#fff',
  'font:600 14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
  'font-variant-numeric:tabular-nums', 'white-space:nowrap',
  'display:grid', 'grid-template-columns:auto auto', 'column-gap:1em',
].join(';');
document.body.appendChild(hud);

// 1行目は残り時間、以降は「ラベル | 値 (右揃え)」の2列
const hudRows = {};
function addHudRow(key, label) {
  const value = document.createElement('span');
  if (label === null) {
    value.style.gridColumn = '1 / -1';
  } else {
    const name = document.createElement('span');
    name.textContent = label;
    hud.appendChild(name);
    value.style.textAlign = 'right';
  }
  hud.appendChild(value);
  hudRows[key] = value;
}
addHudRow('time', null);
addHudRow('quiz', '小テスト');
addHudRow('recognition', '本人確認');
addHudRow('shot', '撮影');

function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Rails から React に渡される受講情報。動画の長さ、顔認証の回数、小テストの出題位置が入っている
let props;
function attendanceProps() {
  if (props === undefined) {
    const el = document.querySelector(
      'script.js-react-on-rails-component[data-component-name="Attendance"]',
    );
    try {
      props = el ? JSON.parse(el.textContent) : null;
    } catch {
      props = null;
    }
  }
  return props;
}

// 詳細ログ1行を分類する。time は 'YYYY-MM-DD HH:mm:ss.SSS' のローカル時刻
function parseDetailLog(row) {
  if (!row || typeof row.body !== 'string') return null;
  const time = new Date(row.time.replace(' ', 'T')).getTime();
  if (!Number.isFinite(time)) return null;

  if (row.body.startsWith(IMAGE_LOG_INTERVAL_PREFIX)) {
    const sec = Number(row.body.slice(IMAGE_LOG_INTERVAL_PREFIX.length));
    return Number.isFinite(sec) ? { time, kind: 'interval', value: sec } : null;
  }
  if (!row.body.startsWith('{')) return null;
  try {
    const event = JSON.parse(row.body);
    if (event.event_type === EVENT_SET_RECOGNITION_TIMER) {
      const sec = JSON.parse(event.event_detail).next_sec;
      return Number.isFinite(sec) ? { time, kind: 'next_sec', value: sec } : null;
    }
    if (EVENT_REARM.has(event.event_type)) return { time, kind: 'rearm' };
  } catch {
    return null;
  }
  return null;
}

// 詳細ログを新しい順に畳み込んで、表示に必要な値を集める
function foldDetailLogs(rowsNewestFirst) {
  const result = { armAt: null, intervalSec: IMAGE_LOG_INTERVAL_S, nextRecognitionSec: null };
  let foundInterval = false;
  for (const row of rowsNewestFirst) {
    const e = parseDetailLog(row);
    if (!e) continue;
    if (result.armAt === null && (e.kind === 'interval' || e.kind === 'rearm')) result.armAt = e.time;
    if (e.kind === 'interval' && !foundInterval) {
      result.intervalSec = e.value;
      foundInterval = true;
    }
    if (e.kind === 'next_sec' && result.nextRecognitionSec === null) result.nextRecognitionSec = e.value;
    if (foundInterval && result.nextRecognitionSec !== null) break;
  }
  return result;
}

// DB が無いときに open すると空の DB を作ってしまいアプリ側の初期化を壊すので、存在確認してから開く
let logState = foldDetailLogs([]);
async function pollDetailLogs() {
  const dbs = await indexedDB.databases();
  if (!dbs.some((d) => d.name === LOG_DB)) return;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(LOG_DB);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    if (!db.objectStoreNames.contains(LOG_STORE)) return;
    const store = db.transaction(LOG_STORE, 'readonly').objectStore(LOG_STORE);
    const rows = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    logState = foldDetailLogs(rows.reverse());
  } finally {
    db.close();
  }
}
setInterval(() => pollDetailLogs().catch(() => {}), LOG_POLL_MS);

// 次の小テストまでの秒数
function untilNextQuiz(currentSec) {
  const p = attendanceProps();
  if (!p) return null;
  const positions = Object.keys(p.quizAttributes || {})
    .map(Number)
    .filter((sec) => sec > currentSec);
  return positions.length ? Math.min(...positions) - currentSec : null;
}

// 次の本人確認までの秒数。全回数を終えていれば null、タイマー未設定なら undefined
function untilNextRecognition(currentSec) {
  const p = attendanceProps();
  if (!p || !p.video || recognitionCount >= p.video.recgCount) return null;
  if (logState.nextRecognitionSec === null) return undefined;
  return logState.nextRecognitionSec - currentSec;
}

// 次のパッシブ撮影までの秒数。タイマー未設定なら null
function untilNextImageLog(nowMs) {
  if (logState.armAt === null) return null;
  return (logState.armAt + logState.intervalSec * 1000 - nowMs) / 1000;
}

setInterval(() => {
  const video = document.querySelector('video');
  // 動画がない画面 (ログイン、学科一覧など)や長さ未取得のときは出さない
  if (!video || !Number.isFinite(video.duration)) {
    hud.hidden = true;
    return;
  }
  hud.hidden = false;

  const current = video.currentTime;
  const quiz = untilNextQuiz(current);
  const recognition = untilNextRecognition(current);
  const shot = untilNextImageLog(Date.now());

  hudRows.time.textContent = `${mmss(video.duration - current)} / ${mmss(video.duration)}`;
  hudRows.quiz.textContent = quiz === null ? 'N/A' : `${mmss(quiz)}後`;
  hudRows.recognition.textContent =
    recognition === null ? 'N/A' : recognition === undefined ? '--' : `${mmss(recognition)}後`;
  hudRows.shot.textContent = shot === null ? '--' : `${mmss(shot)}後`;
}, HUD_INTERVAL_MS);
