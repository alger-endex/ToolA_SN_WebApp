/* Tool A SN station - Web Serial
 * Scanner (QR, USB-COM or keyboard mode) -> SN -> Tool A fixture (USB CDC) -> test result -> records / CSV
 * Fixture protocol: ToolsA_EbikeDrv/App/Inc/pc_link.h
 */
'use strict';

const FIXTURE_ID = { usbVendorId: 0x0483, usbProductId: 0x5740 };
const LS_SETTINGS = 'toola_settings';
const LS_RECORDS = 'toola_records';
const LS_SCANNER = 'toola_scanner_id';

const STATE_NAMES = {
  0: '開機中', 1: '待機 IDLE', 2: '測試中', 3: '測試中', 4: '測試中', 5: '測試中',
  6: '寫入客戶參數', 7: '寫入 SN', 8: '寫入治具參數', 15: '錯誤'
};
const RESULT_TEXT = {
  PASS: '測試合格，參數與 SN 已寫入',
  E1: '無速度', E2: '無電流 / 無扭力電壓', E3: '油門測試錯誤', E4: '未停止 (S26 煞車)',
  E5: '燈控測試錯誤', E6: '充電測試錯誤', E7: '電池鎖測試錯誤', E8: 'Hub Lock CAN 錯誤', E9: '電池 CAN 錯誤',
  W1: '寫治具參數：SIG 錯誤', W2: '寫治具參數：寫入錯誤', W5: '寫治具參數：通訊錯誤',
  P1: '寫客戶參數：SIG 錯誤', P2: '寫客戶參數：寫入錯誤', P5: '寫客戶參數：通訊錯誤',
  S2: '寫 SN：寫入錯誤', S5: '寫 SN：通訊錯誤'
};

const $ = (id) => document.getElementById(id);

/* ---------------- settings / records ---------------- */
function loadJSON(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; }
}
function saveJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { log('!! 瀏覽器儲存失敗: ' + e.message); }
}

const settings = Object.assign({ station: '', regex: '', allow5: false, dup: true }, loadJSON(LS_SETTINGS, {}));
let records = loadJSON(LS_RECORDS, []);
let passedSN = new Set(records.filter(r => r.code === 'PASS').map(r => r.sn));

/* ---------------- log / UI helpers ---------------- */
function ts(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function log(s) {
  const el = $('log');
  el.textContent += `${ts().slice(11)} ${s}\n`;
  if (el.textContent.length > 40000) el.textContent = el.textContent.slice(-30000);
  el.scrollTop = el.scrollHeight;
}
function showMsg(kind, text) {
  const el = $('msg');
  el.className = 'msg ' + (kind || '');
  el.textContent = text;
  phoneSend(`MSG,${kind || 'info'},${text}`);      // mirror to the phone (BLE)
}
function showResult(kind, code, desc, sn) {
  $('result').className = 'result ' + kind;
  $('resCode').textContent = code;
  $('resDesc').textContent = desc;
  $('resSN').textContent = sn || '';
}

/* ---------------- sound ---------------- */
let audioCtx = null;
function beep(kind) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const seq = kind === 'ok' ? [[1200, 0.08]] : kind === 'pass' ? [[880, 0.12], [1320, 0.2]] : [[300, 0.25], [0, 0.08], [300, 0.25]];
    let t = audioCtx.currentTime;
    for (const [f, d] of seq) {
      if (f) {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = f; o.type = 'square'; g.gain.value = 0.08;
        o.connect(g); g.connect(audioCtx.destination);
        o.start(t); o.stop(t + d);
      }
      t += d;
    }
  } catch (e) { /* no audio */ }
}

/* ---------------- serial line port ---------------- */
class LinePort {
  constructor(name, onLine, onChange) {
    this.name = name; this.onLine = onLine; this.onChange = onChange;
    this.port = null; this.reader = null; this.writer = null; this.keep = false;
  }
  get isOpen() { return !!this.port && this.keep; }
  async open(port) {
    await this.close();
    await port.open({ baudRate: 115200 });
    this.port = port; this.keep = true;
    this.writer = port.writable.getWriter();
    this.onChange();
    this.readLoop();
  }
  async readLoop() {
    const dec = new TextDecoder();
    let buf = '';
    while (this.keep && this.port && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.search(/[\r\n]/)) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) this.onLine(line);
          }
          if (buf.length > 1024) buf = '';
        }
      } catch (e) {
        if (this.keep) log(`!! ${this.name} 讀取錯誤: ${e.message}`);
        break;
      } finally {
        try { this.reader.releaseLock(); } catch (e) { /* ignore */ }
        this.reader = null;
      }
    }
    if (this.keep) await this.close();
  }
  async write(s) {
    if (!this.writer) return false;
    try { await this.writer.write(new TextEncoder().encode(s)); return true; }
    catch (e) { log(`!! ${this.name} 寫入錯誤: ${e.message}`); return false; }
  }
  async close() {
    const wasOpen = !!this.port;
    this.keep = false;
    try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
    try { if (this.writer) this.writer.releaseLock(); } catch (e) { /* ignore */ }
    try { if (this.port) await this.port.close(); } catch (e) { /* ignore */ }
    this.port = null; this.writer = null; this.reader = null;
    if (wasOpen) this.onChange();
  }
}

const fixture = new LinePort('治具', onFixtureLine, updateConnUI);
const scanner = new LinePort('掃描器', (line) => { log('掃描器 > ' + line); handleScan(line); }, updateConnUI);

function sameId(info, id) {
  return info && id && info.usbVendorId === id.usbVendorId && info.usbProductId === id.usbProductId;
}
function hex4(n) { return (n || 0).toString(16).toUpperCase().padStart(4, '0'); }

/* ---------------- fixture state ---------------- */
let cur = null;          // { sn, raw, extra, short, state: pending|accepted|testing|rejected, lastTry }
let fxState = null;
let lastRx = 0;
let lastStPoll = 0;

function updateConnUI() {
  const fxOk = fixture.isOpen;
  const alive = fxOk && Date.now() - lastRx < 5000;
  $('fxDot').className = 'dot ' + (alive ? 'on' : fxOk ? 'warn' : '');
  $('fxInfo').textContent = !fxOk ? '未連接' : alive ? '已連接' : '已開啟，等待治具回應…';
  $('fxState').textContent = fxOk && fxState ? `${STATE_NAMES[fxState.s] || '狀態 ' + fxState.s} (${fxState.mode})` : '-';
  $('fxConnect').disabled = fxOk;
  $('fxDisconnect').disabled = !fxOk;

  const scOk = scanner.isOpen;
  $('scDot').className = 'dot ' + (scOk ? 'on' : '');
  if (scOk) {
    const i = scanner.port.getInfo();
    $('scInfo').textContent = `COM 模式已連接 (VID ${hex4(i.usbVendorId)} / PID ${hex4(i.usbProductId)})`;
  } else {
    $('scInfo').textContent = '未連接 COM（鍵盤模式也可直接掃描）';
  }
  $('scConnect').disabled = scOk;
  $('scDisconnect').disabled = !scOk;

  $('phDot').className = 'dot ' + (phone.connected ? 'on' : phone.device ? 'warn' : '');
  $('phInfo').textContent = phone.connected ? `已連線：${phone.device.name || '手機'}`
    : phone.device ? `${phone.device.name || '手機'} 斷線，自動重連中…` : '未連線（手機開啟 ToolA 掃描 App）';
  $('phConnect').disabled = !navigator.bluetooth || phone.connected;
  $('phDisconnect').disabled = !phone.device;
}

function setCurrent(c) {
  cur = c;
  $('curSN').textContent = c ? c.sn : '請掃描 QR code';
  const ex = c && c.extra ? Object.entries(c.extra).filter(([k]) => k !== 'SN').map(([k, v]) => `${k}=${v}`).join('  ') : '';
  $('curExtra').textContent = ex;
}

async function sendSN() {
  if (!cur || cur.state !== 'pending') return;
  if (!fixture.isOpen) { showMsg('warn', `已掃描 ${cur.sn}，請先連接治具`); return; }
  cur.lastTry = Date.now();
  log('PC > SN=' + cur.sn);
  await fixture.write(`SN=${cur.sn}\r\n`);
}

function snMatches(fxSN) {
  if (!cur) return false;
  return cur.short ? fxSN.slice(-5) === cur.sn : fxSN === cur.sn;
}

function onFixtureLine(line) {
  lastRx = Date.now();
  const p = line.split(',');
  if (p[0] === 'OK' && p[1] === 'ST') {
    fxState = { s: Number(p[2]), sub: Number(p[3]), mode: p[4] || '' };
    if (fxState.s === 0 && cur && cur.state === 'accepted') {   // fixture rebooted: SN lost, send again
      cur.state = 'pending';
      showMsg('warn', '治具重新開機，重送 SN…');
    }
    updateConnUI();
    return;                                // do not flood the log with polling
  }
  log('治具 > ' + line);

  if (p[0] === 'OK' && p[1] === 'SN') {
    if (cur && cur.state === 'pending' && snMatches(p[2] || '')) {
      cur.state = 'accepted';
      showMsg('ok', `治具已接受 SN，請按 SW1 開始`);
      showResult('idle', '—', '等待測試', p[2]);
      beep('ok');
    }
  } else if (p[0] === 'NG' && p[1] === 'SN') {
    if (p[2] === 'BUSY') {
      showMsg('warn', '治具忙碌中（不在待機），回到待機後自動重送');
    } else {
      if (cur) cur.state = 'rejected';
      showMsg('err', '治具拒絕此 SN（格式錯誤）');
      beep('err');
    }
  } else if (p[0] === 'EV' && p[1] === 'START') {
    const sn = p[2] || '';
    showResult('testing', '測試中', '', sn);
    if (!cur) {
      showMsg('err', `未掃描就開始測試！治具使用 SN ${sn}`);
      beep('err');
    } else if (!snMatches(sn)) {
      showMsg('err', `治具 SN ${sn} 與掃描 ${cur.sn} 不符！`);
      beep('err');
    } else {
      cur.state = 'testing';
      showMsg('warn', '測試中…');
    }
  } else if (p[0] === 'RES') {
    onResult(p[1] || '', p[2] || '');
  }
}

function onResult(sn, code) {
  const rec = {
    time: ts(), station: settings.station, sn, code,
    desc: RESULT_TEXT[code] || '',
    scanned: cur ? cur.sn : '',
    match: cur ? snMatches(sn) : false,
    raw: cur ? cur.raw : ''
  };
  records.push(rec);
  saveJSON(LS_RECORDS, records);
  if (code === 'PASS') passedSN.add(sn);
  appendFile(rec);
  renderRecords();

  const pass = code === 'PASS';
  showResult(pass ? 'pass' : 'fail', pass ? 'PASS' : code, rec.desc || code, sn);
  phoneSend(`RES,${code},${rec.desc},${sn}`);
  if (!rec.match) showMsg('err', `結果已記錄，但治具 SN 與掃描 SN 不符，請檢查！`);
  else showMsg(pass ? 'ok' : 'err', pass ? '完成，請掃描下一台' : '測試失敗，修復後請重新掃描');
  beep(pass ? 'pass' : 'err');
  setCurrent(null);                        // every unit needs a fresh scan
}

/* ---------------- QR / SN parsing ---------------- */
function parseSN(raw) {
  let s = raw.replace(/^\][A-Za-z][0-9A-Za-z]/, '').trim();     // AIM symbology id, e.g. ]Q1
  const extra = {};
  let sn = null;

  if (s.startsWith('{')) {                                       // JSON
    try {
      const o = JSON.parse(s);
      for (const k of Object.keys(o)) extra[k.toUpperCase()] = String(o[k]);
      sn = extra.SN ?? null;
    } catch (e) { /* not JSON */ }
  }
  if (sn === null && /^https?:\/\//i.test(s)) {                  // URL ...?sn=xxx
    try {
      new URL(s).searchParams.forEach((v, k) => { extra[k.toUpperCase()] = v; });
      sn = extra.SN ?? null;
    } catch (e) { /* bad URL */ }
  }
  if (sn === null && /[=:]/.test(s)) {                           // SN=xxx;PN=yyy
    for (const part of s.split(/[;,&|\t\r\n]+/)) {
      const m = part.match(/^\s*([A-Za-z_]+)\s*[=:]\s*(.*?)\s*$/);
      if (m) extra[m[1].toUpperCase()] = m[2];
    }
    sn = extra.SN ?? null;
  }
  if (sn === null) sn = s;                                       // plain SN
  sn = sn.trim();

  if (/^\d{5}$/.test(sn)) {
    return settings.allow5 ? { ok: true, sn, short: true, extra } : { ok: false, err: '只有 5 碼流水號（設定中未允許）' };
  }
  if (sn.length !== 16) return { ok: false, err: `SN 長度 ${sn.length} 字，需要 16 字：「${sn}」` };
  if (!/^[\x20-\x2B\x2D-\x7E]{11}\d{5}$/.test(sn)) {
    return { ok: false, err: 'SN 必須是英數字（不可有逗號），且最後 5 碼為數字' };
  }
  if (settings.regex) {
    try {
      if (!new RegExp(settings.regex).test(sn)) return { ok: false, err: `SN 不符合規則 ${settings.regex}：「${sn}」` };
    } catch (e) { log('!! SN 規則不是有效的正規表示式'); }
  }
  return { ok: true, sn, short: false, extra };
}

function handleScan(raw) {
  const r = parseSN(raw);
  if (!r.ok) { showMsg('err', r.err); beep('err'); return; }
  if (cur && cur.state === 'testing') {
    showMsg('err', '治具測試中，請等結果出來再掃描下一台');
    beep('err');
    return;
  }
  if (settings.dup && !r.short && passedSN.has(r.sn)) {
    beep('err');
    if (!confirm(`SN ${r.sn} 已經 PASS 過！\n確定要再送出嗎？`)) {
      showMsg('err', `重複 SN：${r.sn}（已取消）`);
      return;
    }
  }
  setCurrent({ sn: r.sn, raw, extra: r.extra, short: r.short, state: 'pending', lastTry: 0 });
  showMsg('warn', '傳送 SN 到治具…');
  showResult('idle', '—', '等待治具接受 SN', '');
  sendSN();
}

/* keyboard-mode scanner: catch fast typing anywhere on the page (except setting fields) */
let kbBuf = '', kbLast = 0;
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;   // manual field has its own form
  const now = Date.now();
  if (now - kbLast > 80) kbBuf = '';
  kbLast = now;
  if (e.key === 'Enter') {
    if (kbBuf.length >= 4) { e.preventDefault(); log('鍵盤掃描 > ' + kbBuf); handleScan(kbBuf); }
    kbBuf = '';
  } else if (e.key.length === 1) {
    kbBuf += e.key;
  }
});

/* a scanner's Enter must not "click" the last focused button */
document.addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') e.target.blur(); });

/* ---------------- records / CSV ---------------- */
const CSV_HEAD = ['時間', '站別', '治具SN', '結果', '說明', '掃描SN', 'SN相符', '條碼原文'];
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvLine(r) {
  return [r.time, r.station, r.sn, r.code, r.desc, r.scanned, r.match ? 'Y' : 'N', r.raw].map(csvCell).join(',') + '\r\n';
}

function renderRecords() {
  const today = ts().slice(0, 10);
  let pass = 0, fail = 0;
  for (const r of records) {
    if (r.time.startsWith(today)) { if (r.code === 'PASS') pass++; else fail++; }
  }
  $('stPass').textContent = pass;
  $('stFail').textContent = fail;
  $('stTotal').textContent = records.length;

  const body = $('recBody');
  body.textContent = '';
  for (const r of records.slice(-300).reverse()) {
    const tr = document.createElement('tr');
    tr.className = (r.code === 'PASS' ? 'pass' : 'fail') + (r.match ? '' : ' mismatch');
    const cells = [[r.time.slice(5), ''], [r.sn, 'mono'], [r.code, 'r'], [r.desc, ''], [r.scanned, 'mono']];
    for (const [v, c] of cells) {
      const td = document.createElement('td');
      td.textContent = v; td.className = c;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

$('exportBtn').onclick = () => {
  const text = '﻿' + CSV_HEAD.join(',') + '\r\n' + records.map(csvLine).join('');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = `ToolA_${ts().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

$('clearBtn').onclick = () => {
  if (!confirm('確定清除瀏覽器內所有紀錄？（CSV 檔不受影響）\n建議先匯出 CSV。')) return;
  records = []; passedSN = new Set();
  saveJSON(LS_RECORDS, records);
  renderRecords();
};

/* CSV file mirror (File System Access API), handle kept in IndexedDB */
let fileHandle = null;
function idb() {
  return new Promise((res, rej) => {
    const q = indexedDB.open('toola', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kv');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
}

async function filePermitted(h, ask) {
  const o = { mode: 'readwrite' };
  if ((await h.queryPermission(o)) === 'granted') return true;
  return ask ? (await h.requestPermission(o)) === 'granted' : false;
}
function updateFileUI(needAuth) {
  if (!fileHandle) { $('fileInfo').textContent = '未設定（只存在瀏覽器）'; $('fileBtn').textContent = '選擇 CSV 紀錄檔'; return; }
  $('fileInfo').textContent = needAuth ? `${fileHandle.name}（需重新授權）` : `寫入中：${fileHandle.name}`;
  $('fileBtn').textContent = needAuth ? '重新授權紀錄檔' : '更換紀錄檔';
}
$('fileBtn').onclick = async () => {
  if (!window.showSaveFilePicker) { alert('此瀏覽器不支援直接寫檔，請用「匯出 CSV」。'); return; }
  try {
    if (fileHandle && !(await filePermitted(fileHandle, false))) {
      if (await filePermitted(fileHandle, true)) { updateFileUI(false); return; }
    }
    const h = await window.showSaveFilePicker({
      suggestedName: `ToolA_${ts().slice(0, 10)}.csv`,
      types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }]
    });
    const f = await h.getFile();
    if (f.size === 0) {
      const w = await h.createWritable();
      await w.write('﻿' + CSV_HEAD.join(',') + '\r\n');
      await w.close();
    }
    fileHandle = h;
    await idbSet('csv', h);
    updateFileUI(false);
  } catch (e) { if (e.name !== 'AbortError') log('!! 紀錄檔: ' + e.message); }
};
async function appendFile(rec) {
  if (!fileHandle) return;
  try {
    if (!(await filePermitted(fileHandle, false))) { updateFileUI(true); showMsg('err', 'CSV 紀錄檔未授權，請按「重新授權紀錄檔」（本筆已存在瀏覽器）'); return; }
    const f = await fileHandle.getFile();
    const w = await fileHandle.createWritable({ keepExistingData: true });
    await w.seek(f.size);
    await w.write(csvLine(rec));
    await w.close();
  } catch (e) {
    log('!! 寫入 CSV 失敗: ' + e.message);
    showMsg('err', 'CSV 寫入失敗（檔案可能被 Excel 開著），本筆已存在瀏覽器');
  }
}

/* ---------------- connect buttons ---------------- */
async function openFixture(port) {
  try {
    await fixture.open(port);
    log('治具已連接');
    lastStPoll = 0;
    if (cur && cur.state === 'accepted') cur.state = 'pending';   // reconnected: make sure the fixture has our SN
  }
  catch (e) { log('!! 治具開啟失敗: ' + e.message); showMsg('err', '治具 COM 開啟失敗（可能被其他程式占用）'); }
}
async function openScanner(port) {
  try {
    await scanner.open(port);
    saveJSON(LS_SCANNER, port.getInfo());
    log('掃描器已連接');
  } catch (e) { log('!! 掃描器開啟失敗: ' + e.message); showMsg('err', '掃描器 COM 開啟失敗（可能被其他程式占用）'); }
}

$('fxConnect').onclick = async () => {
  try { await openFixture(await navigator.serial.requestPort({ filters: [FIXTURE_ID] })); }
  catch (e) { if (e.name !== 'NotFoundError') log('!! ' + e.message); else showMsg('warn', '找不到治具：確認 USB 已接上，且開機時沒有按住 SW1（隨身碟模式）'); }
};
$('fxDisconnect').onclick = () => fixture.close();
$('scConnect').onclick = async () => {
  try {
    const port = await navigator.serial.requestPort();
    if (sameId(port.getInfo(), FIXTURE_ID)) { showMsg('err', '這是治具的 COM，請選掃描器'); return; }
    await openScanner(port);
  } catch (e) { if (e.name !== 'NotFoundError') log('!! ' + e.message); }
};
$('scDisconnect').onclick = () => scanner.close();

/* ---------------- phone scanner over BLE (Web Bluetooth) ----------------
 * The browser can only be a BLE central: the phone App (ToolA_ScanApp_Android) advertises
 * this service, the PC connects. UUIDs must match BlePeripheral.java.
 *   TX notify  phone -> PC : "QR,<content>\n"
 *   RX write   PC -> phone : "HELLO,<station>\n" "MSG,<kind>,<text>\n" "RES,<code>,<desc>,<sn>\n"
 * Lines are UTF-8, sent in 20-byte chunks, re-assembled at '\n'. */
const BLE_SVC = '7a0b1000-0d6b-4a43-9a8e-3f1c2b5d0a01';
const BLE_TX = '7a0b1001-0d6b-4a43-9a8e-3f1c2b5d0a01';
const BLE_RX = '7a0b1002-0d6b-4a43-9a8e-3f1c2b5d0a01';
const LS_PHONE = 'toola_phone_id';
const phone = { device: null, rx: null, tx: null, connected: false, bytes: [], wq: Promise.resolve(), manual: false, timer: null, lastMsg: '' };

function phoneSend(line) {
  if (!phone.connected || !phone.rx) return;
  if (line.startsWith('MSG,')) {                 // do not repeat the same message (e.g. BUSY every second)
    if (line === phone.lastMsg) return;
    phone.lastMsg = line;
  }
  const data = new TextEncoder().encode(line.replace(/[\r\n]/g, ' ') + '\n');
  phone.wq = phone.wq.then(async () => {
    for (let i = 0; i < data.length; i += 20) {
      if (!phone.connected) return;
      const part = data.slice(i, i + 20);
      if (phone.rx.writeValueWithResponse) await phone.rx.writeValueWithResponse(part);
      else await phone.rx.writeValue(part);
    }
  }).catch((e) => log('!! 手機傳送失敗: ' + e.message));
}

function onPhoneData(e) {
  const dv = e.target.value;
  const v = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  for (const b of v) {
    if (b === 10) {
      const line = new TextDecoder().decode(new Uint8Array(phone.bytes)).trim();
      phone.bytes = [];
      if (line) {
        log('手機 > ' + line);
        if (line.startsWith('QR,')) handleScan(line.slice(3));
      }
    } else if (b !== 13 && phone.bytes.length < 2048) {
      phone.bytes.push(b);
    }
  }
}

async function phoneConnect(device) {
  phone.device = device;
  phone.manual = false;
  device.removeEventListener('gattserverdisconnected', onPhoneDisconnected);
  device.addEventListener('gattserverdisconnected', onPhoneDisconnected);
  updateConnUI();
  const server = await device.gatt.connect();
  const svc = await server.getPrimaryService(BLE_SVC);
  phone.tx = await svc.getCharacteristic(BLE_TX);
  phone.rx = await svc.getCharacteristic(BLE_RX);
  phone.tx.removeEventListener('characteristicvaluechanged', onPhoneData);
  phone.tx.addEventListener('characteristicvaluechanged', onPhoneData);
  await phone.tx.startNotifications();
  phone.bytes = [];
  phone.lastMsg = '';
  phone.connected = true;
  try { localStorage.setItem(LS_PHONE, device.id); } catch (e) { /* ignore */ }
  log('手機已連線: ' + (device.name || device.id));
  updateConnUI();
  phoneSend('HELLO,' + (settings.station || '-'));
  phoneSend(`MSG,${$('msg').className.replace('msg', '').trim() || 'info'},${$('msg').textContent}`);
}

function onPhoneDisconnected() {
  phone.connected = false;
  updateConnUI();
  if (phone.manual) return;
  log('手機已斷線，自動重連中…');
  showMsg('warn', '手機 BLE 已斷線，自動重連中');
  phoneRetry();
}

/* Android rotates its BLE advertising address (and changes it when the App restarts),
 * so silent reconnect only works for short drops: give up after ~30 s and ask for a manual connect. */
function phoneRetry(count = 0) {
  clearTimeout(phone.timer);
  if (count >= 10) {
    showMsg('err', '手機無法自動重連，請按「連接手機」重新選擇');
    beep('err');
    phone.device = null;
    updateConnUI();
    return;
  }
  phone.timer = setTimeout(async () => {
    if (phone.connected || phone.manual || !phone.device) return;
    try { await phoneConnect(phone.device); }
    catch (e) { phoneRetry(count + 1); }
  }, 3000);
}

$('phConnect').onclick = async () => {
  try {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SVC] }] });
    await phoneConnect(device);
  } catch (e) {
    if (e.name === 'NotFoundError') return;           // chooser cancelled
    log('!! 手機連線失敗: ' + e.message);
    showMsg('err', '手機連線失敗：確認手機已開啟 ToolA 掃描 App 且藍牙開啟');
    if (phone.device) phoneRetry();
  }
};
$('phDisconnect').onclick = () => {
  phone.manual = true;
  clearTimeout(phone.timer);
  if (phone.device && phone.device.gatt.connected) phone.device.gatt.disconnect();
  phone.device = null;
  phone.connected = false;
  updateConnUI();
};

async function phoneAutoReconnect() {           // only when the browser supports getDevices()
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  let id = null;
  try { id = localStorage.getItem(LS_PHONE); } catch (e) { /* ignore */ }
  if (!id) return;
  try {
    const dev = (await navigator.bluetooth.getDevices()).find((d) => d.id === id);
    if (dev) { phone.device = dev; phone.manual = false; dev.addEventListener('gattserverdisconnected', onPhoneDisconnected); phoneRetry(); }
  } catch (e) { /* not supported */ }
}

$('manualForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('manualInput').value.trim();
  $('manualInput').value = '';
  if (v) { log('手動輸入 > ' + v); handleScan(v); }
};

/* ---------------- settings UI ---------------- */
function bindSettings() {
  $('setStation').value = settings.station;
  $('setRegex').value = settings.regex;
  $('setAllow5').checked = settings.allow5;
  $('setDup').checked = settings.dup;
  $('stationLabel').textContent = settings.station || '-';
  const save = () => {
    settings.station = $('setStation').value.trim();
    settings.regex = $('setRegex').value.trim();
    settings.allow5 = $('setAllow5').checked;
    settings.dup = $('setDup').checked;
    $('stationLabel').textContent = settings.station || '-';
    saveJSON(LS_SETTINGS, settings);
  };
  for (const id of ['setStation', 'setRegex', 'setAllow5', 'setDup']) $(id).addEventListener('change', save);
}

/* ---------------- periodic ---------------- */
setInterval(() => {
  const now = Date.now();
  if (fixture.isOpen) {
    if (cur && cur.state === 'pending' && now - cur.lastTry > 1000) sendSN();
    else if (now - lastStPoll > 1500) { lastStPoll = now; fixture.write('ST?\r\n'); }
  }
  updateConnUI();
}, 250);

/* ---------------- start ---------------- */
async function autoOpen() {
  const scId = loadJSON(LS_SCANNER, null);
  for (const port of await navigator.serial.getPorts()) {
    const info = port.getInfo();
    if (!fixture.isOpen && sameId(info, FIXTURE_ID)) await openFixture(port);
    else if (!scanner.isOpen && sameId(info, scId)) await openScanner(port);
  }
}

async function init() {
  bindSettings();
  renderRecords();
  updateConnUI();
  try {
    fileHandle = (await idbGet('csv')) || null;
    if (fileHandle) updateFileUI(!(await filePermitted(fileHandle, false)));
  } catch (e) { fileHandle = null; }

  if (navigator.bluetooth) phoneAutoReconnect();
  else $('phInfo').textContent = '此瀏覽器不支援 Web Bluetooth（請用 Chrome / Edge）';

  if (!('serial' in navigator)) {
    $('noSerial').hidden = false;
    for (const id of ['fxConnect', 'scConnect']) $(id).disabled = true;
    return;
  }
  navigator.serial.addEventListener('connect', () => autoOpen());       // re-plugged / fixture rebooted
  navigator.serial.addEventListener('disconnect', (e) => {
    if (fixture.port === e.target) { fixture.close(); fxState = null; showMsg('err', '治具 USB 已中斷'); beep('err'); }
    if (scanner.port === e.target) { scanner.close(); showMsg('warn', '掃描器已中斷'); }
  });
  await autoOpen();
}
init();
