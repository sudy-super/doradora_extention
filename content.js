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
// 左上に「残り時間 / 全体の長さ」を表示する。
// 動画は react-player 経由の <video> 要素なので currentTime / duration をそのまま読む。
// フルスクリーン対象が document.documentElement なので position:fixed で重ねられる。
// 操作を邪魔しないよう pointer-events は無効にしておく。

const HUD_INTERVAL_MS = 500;

const hud = document.createElement('div');
hud.style.cssText = [
  'position:fixed', 'top:8px', 'left:8px', 'z-index:2147483647',
  'pointer-events:none', 'padding:4px 10px', 'border-radius:6px',
  'background:rgba(0,0,0,0.6)', 'color:#fff',
  'font:600 14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
  'font-variant-numeric:tabular-nums', 'white-space:nowrap',
].join(';');
document.body.appendChild(hud);

function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

setInterval(() => {
  const video = document.querySelector('video');
  // 動画がない画面 (ログイン、学科一覧など)や長さ未取得のときは出さない
  if (!video || !Number.isFinite(video.duration)) {
    hud.hidden = true;
    return;
  }
  hud.hidden = false;
  hud.textContent = `${mmss(video.duration - video.currentTime)} / ${mmss(video.duration)}`;
}, HUD_INTERVAL_MS);
