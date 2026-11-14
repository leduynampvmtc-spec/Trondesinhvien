/* luyende.js — v2.2 — SINH VIÊN TỰ LUYỆN ĐỀ TOEIC (không cần máy chủ, không cần giáo viên tạo đề).
 * Sinh viên tự nạp bộ đề (từng bộ hoặc nhiều bộ một lúc) bằng js/booklet.js; trang đề, file nghe, đáp án
 * lưu ngay trên máy (IndexedDB "tuluyen"). Hai chế độ:
 *   - Thi thử : file nghe phát 1 lần, trang tự lật theo file nghe (ngay sau "Go on to the next page"),
 *               KHÔNG quay lại trang đã qua của phần Nghe; phần Đọc 75 phút, xem lại tự do.
 *   - Luyện tập: quay lại trang trước, tạm dừng / tua / nghe lại, xem đáp án từng trang.
 * Phần mềm: Lê Duy Nam — GV Trường CĐ Dầu khí */
(function () {
  'use strict';
  const { $, $$, esc, toast, LS, fmtSec, fmtTime } = QA;
  const LET = 'ABCD';
  const app = $('#app');
  const READ_MIN = 75;
  const LIM = () => S.st.limit || 0;

  /* ============================ lưu trữ trên máy ============================ */
  const DB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((res, rej) => {
        let rq;
        try { rq = indexedDB.open('tuluyen', 1); } catch (e) { rej(e); return; }
        rq.onupgradeneeded = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
          if (!db.objectStoreNames.contains('hist')) db.createObjectStore('hist', { keyPath: 'id' });
        };
        rq.onsuccess = () => { this._db = rq.result; res(this._db); };
        rq.onerror = () => rej(rq.error);
      });
    },
    async run(store, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode); let out;
        const r = fn(t.objectStore(store));
        if (r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => res(out);
        t.onerror = () => rej(t.error || new Error('Lỗi lưu trữ'));
        t.onabort = () => rej(t.error || new Error('Lỗi lưu trữ'));
      });
    },
    get(store, key) { return this.run(store, 'readonly', s => s.get(key)); },
    all(store) { return this.run(store, 'readonly', s => s.getAll()); },
    keys(store) { return this.run(store, 'readonly', s => s.getAllKeys()); },
    put(store, val, key) { return this.run(store, 'readwrite', s => { key === undefined ? s.put(val) : s.put(val, key); }); },
    del(store, key) { return this.run(store, 'readwrite', s => { s.delete(key); }); }
  };
  const blobIds = (set) => (set.book.pages || []).map(p => p.id).concat(Object.keys(set.audio || {}).map(k => set.audio[k].id)).filter(Boolean);
  const URLC = {};
  async function blobUrl(id) {
    if (URLC[id]) return URLC[id];
    const r = await DB.get('blobs', id);
    if (!r) throw new Error('Không thấy file trong máy');
    return (URLC[id] = URL.createObjectURL(r instanceof Blob ? r : new Blob([r.buf], { type: r.type || '' })));
  }
  function dropUrls() { Object.keys(URLC).forEach(k => { try { URL.revokeObjectURL(URLC[k]); } catch (e) { /* bỏ qua */ } delete URLC[k]; }); }
  /** Xóa file mồ côi (lần nạp trước bị dừng giữa chừng) — chỉ chạy lúc mở trang */
  async function gc() {
    try {
      const sets = await DB.all('sets'), used = new Set();
      sets.forEach(s => blobIds(s).forEach(i => used.add(i)));
      for (const k of await DB.keys('blobs')) if (!used.has(k)) await DB.del('blobs', k);
    } catch (e) { /* bỏ qua */ }
  }

  /* ===================== dò mốc lật trang từ file nghe (v2.2.1) =====================
   * File nghe liền từng Part (không phải file từng câu) không có sẵn mốc thời gian của từng câu.
   * Băng TOEIC luôn có quãng lặng sau mỗi câu (Part 1–2: ~5 giây, Part 3–4: ~8 giây) → dò các quãng lặng dài,
   * đếm TỪ CUỐI file (bỏ qua phần hướng dẫn đầu Part) để biết lúc băng bắt đầu đọc từng câu. */
  async function envelope(buf) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) throw new Error('máy không hỗ trợ');
    let ab = null;
    for (const sr of [8000, 22050, 44100]) {
      try { const c = new OAC(1, 1, sr); ab = await new Promise((res, rej) => { const pr = c.decodeAudioData(buf.slice(0), res, rej); if (pr && pr.catch) pr.catch(rej); }); break; }
      catch (e) { /* thử tần số lấy mẫu khác */ }
    }
    if (!ab) throw new Error('không đọc được file nghe');
    const sr = ab.sampleRate, W = Math.max(1, Math.round(sr * 0.05)), n = Math.floor(ab.length / W), e = new Float32Array(n);
    const chs = []; for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) chs.push(ab.getChannelData(c));
    for (let i = 0; i < n; i++) { let q = 0; for (const ch of chs) for (let j = i * W, m = j + W; j < m; j++) q += ch[j] * ch[j]; e[i] = Math.sqrt(q / (W * chs.length)); }
    return { e, dt: W / sr, dur: ab.duration };
  }
  /** Các quãng lặng dài ≥ minLen giây: [{a, b}] (giây); quãng lặng chạm cuối file có end = true */
  function silences(env, minLen) {
    const e = env.e, dt = env.dt, n = e.length, srt = Float32Array.from(e).sort(), p95 = srt[Math.floor(n * 0.95)] || 0;
    const thr = Math.max(p95 * 0.04, 0.0012), q = new Uint8Array(n), out = [];
    for (let i = 0; i < n; i++) q[i] = e[i] < thr ? 1 : 0;
    // tiếng lách tách rất ngắn (≤ 0,15 giây) nằm giữa quãng lặng vẫn coi là lặng
    for (let i = 1; i < n - 1; i++) if (!q[i] && q[i - 1]) { let m = i; while (m < n && !q[m] && m - i < 3) m++; if (m < n && q[m]) for (let x = i; x < m; x++) q[x] = 1; }
    for (let i = 0, a = -1; i <= n; i++) {
      if (i < n && q[i]) { if (a < 0) a = i; continue; }
      if (a >= 0) { const len = (i - a) * dt, end = i >= n; if (len >= minLen || (end && len >= 1.5)) out.push({ a: a * dt, b: i * dt, end }); a = -1; }
    }
    return out;
  }
  /** nums: số câu của Part (tăng dần). Trả về [{n, t}] hoặc null nếu không chắc */
  function marksFromEnv(env, k, nums) {
    const N = nums.length; if (N < 2) return null;
    const p34 = (i) => (k === '3' || k === '4') ? i : (k === 'all' ? i - 31 : -1); // vị trí trong chuỗi Part 3–4 (nhóm 3 câu)
    for (const minLen of (k === '3' || k === '4') ? [6, 5, 4, 3.5] : [3.5, 3, 2.5]) {
      const G = silences(env, minLen); let best = null;
      // 3 cách ghép: N quãng lặng cuối = sau câu 1..N; lùi 1 (có lời chào kết + lặng ở cuối); thiếu quãng lặng sau câu cuối
      for (const c of [{ j: G.length - N, n: N }, { j: G.length - N - 1, n: N }, { j: G.length - (N - 1), n: N - 1 }]) {
        if (c.j < 0 || c.n < 1) continue;
        let ok = 0, tot = 0;
        for (let i = 0; i < c.n; i++) {
          const g = G[c.j + i], prev = c.j + i > 0 ? G[c.j + i - 1].b : 0, sp = g.a - prev, q = p34(i);
          if (i === 0 || (k === 'all' && (i === 6 || i === 31 || i === 70))) continue; // sau phần hướng dẫn: dài ngắn tùy đề
          tot++;
          if (q >= 0) { if (q % 3 === 0 ? sp >= 12 : (sp >= 1 && sp <= 14)) ok++; }
          else if (sp >= 2.5 && sp <= 45) ok++;
        }
        const sc = tot ? ok / tot : 0;
        if (!best || sc > best.sc + 0.02) best = { sc, c };
      }
      if (best && best.sc >= 0.85) {
        const mk = [{ n: nums[0], t: 0 }];
        for (let i = 1; i < N; i++) { const g = G[best.c.j + i - 1]; if (!g) break; mk.push({ n: nums[i], t: Math.max(0, Math.round((g.b - 0.4) * 10) / 10) }); }
        if (mk.length === N) return mk;
      }
    }
    return null;
  }
  async function detectMarks(set, k) {
    const name = set.book.parts[k], ref = name && set.audio && set.audio[name]; if (!ref) return null;
    const r = await DB.get('blobs', ref.id); if (!r) return null;
    const buf = r instanceof Blob ? await r.arrayBuffer() : r.buf;
    const nums = set.questions.filter(q => q.skill === 'L' && (k === 'all' || String(q.part) === k)).map(q => +q.num).sort((a, b) => a - b);
    return marksFromEnv(await envelope(buf), k, nums);
  }
  window.__tl = { envelope, silences, marksFromEnv };

  /* ================================ cửa sổ ================================ */
  function modal(html) { $('#modalBody').innerHTML = html; $('#modal').classList.add('on'); }
  function closeModal() { $('#modal').classList.remove('on'); $('#modalBody').innerHTML = ''; }
  let editing = null, importing = false;
  const bookCtx = {
    modal,
    closeModal: () => { closeModal(); importing = false; if (!S) renderLib(); },
    needConn: () => true,
    putBlob: async (blob, name, kind) => {
      const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { await DB.put('blobs', { buf: await blob.arrayBuffer(), type: blob.type || (kind === 'page' ? 'image/jpeg' : 'audio/mpeg'), name }, id); }
      catch (e) { throw new Error(/quota/i.test(String(e && (e.name + e.message))) ? 'máy hết chỗ lưu — hãy xóa bớt bộ đề cũ' : 'không lưu được vào máy (' + (e && e.message || e) + ')'); }
      return id;
    },
    created: async (bank) => { await DB.put('sets', bank); },
    saveBanks: async () => { if (editing) { await DB.put('sets', editing); editing = null; renderLib(); } },
    audioPanel: () => '', bindAudioPanel: () => {}
  };

  /* ============================== danh sách bộ đề ============================== */
  const curKey = (id) => 'tl.cur.' + id;
  async function renderLib() {
    document.body.classList.remove('exam', 'bookmode');
    let sets = [], hist = [], err = '';
    try { sets = await DB.all('sets'); hist = await DB.all('hist'); } catch (e) { err = 'Trình duyệt này không cho lưu dữ liệu trên máy (đang ở chế độ riêng tư / ẩn danh?). Hãy mở bằng Safari hoặc Chrome thường.'; }
    sets.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
    let usage = '';
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); if (e.usage) usage = 'Đang dùng ' + (e.usage / 1048576).toFixed(0) + ' MB trên máy'; } } catch (e) { /* bỏ qua */ }
    const card = (s) => {
      const hs = hist.filter(h => h.setId === s.id).sort((a, b) => b.at - a.at);
      const best = hs.filter(h => h.toeic && h.toeic.LR != null && h.full).reduce((m, h) => Math.max(m, h.toeic.LR), 0);
      const cur = LS.get(curKey(s.id), null);
      const nL = s.questions.filter(q => q.skill === 'L').length, nR = s.questions.filter(q => q.skill === 'R').length;
      const pk = Object.keys(s.book.parts || {}), mk = Object.keys(s.book.marks || {});
      const noKey = s.questions.filter(q => !q.correct.length).length;
      const noPg = nL && !s.questions.some(q => q.skill === 'L' && q.page != null);
      const aud = !nL ? '' : !pk.length ? '<span class="pill bad">chưa có file nghe</span>' : mk.length ? '<span class="pill ok">tự lật trang theo từng câu nghe</span>' : '<span class="pill">file nghe ' + (pk.includes('all') ? 'liền 1 file' : pk.length + ' Part') + ' · dò mốc lật trang khi làm lần đầu</span>';
      return '<div class="card setc" data-set="' + s.id + '"><div class="row" style="align-items:flex-start"><div style="min-width:0;flex:1"><h3>' + esc(s.name) + '</h3>' +
        '<div class="hint">' + s.book.pages.length + ' trang đề · ' + (nL ? 'Nghe ' + nL + ' câu' : '') + (nL && nR ? ' · ' : '') + (nR ? 'Đọc ' + nR + ' câu' : '') + '</div>' +
        '<div class="tags">' + aud + (noPg ? '<span class="pill bad">phần Nghe chưa có “câu đầu mỗi trang” → không tự lật trang (bấm Sửa đáp án)</span>' : '') + (noKey ? '<span class="pill warn">' + noKey + ' câu chưa có đáp án</span>' : '') + (hs.length ? '<span class="pill">đã làm ' + hs.length + ' lần</span>' : '') + (best ? '<span class="pill ok">cao nhất ' + best + ' điểm TOEIC</span>' : '') + '</div></div></div>' +
        (cur ? '<button class="btn accent wide" data-act="resume">▶ Làm tiếp bài đang dở (' + (cur.mode === 'exam' ? 'Thi thử' : 'Luyện tập') + ')</button>' : '') +
        '<div class="acts"><button class="btn primary" data-act="exam">📝 Thi thử</button><button class="btn primary" data-act="practice">🎯 Luyện tập</button></div>' +
        '<div class="acts sm"><button class="btn sm" data-act="hist"' + (hs.length ? '' : ' disabled') + '>Lịch sử</button><button class="btn sm" data-act="edit">Sửa đáp án</button><button class="btn sm" data-act="rename">Đổi tên</button><button class="btn sm danger" data-act="del">Xóa</button></div></div>';
    };
    app.innerHTML = '<header class="topbar"><div class="wrap"><a class="brand" href="index.html" style="color:#fff;text-decoration:none;display:flex;align-items:center;gap:10px"><span class="logo">T</span><b style="white-space:nowrap">Luyện đề</b></a><span class="spacer"></span><a class="btn sm" href="tuvung/index.html">Từ vựng</a><a class="btn sm" href="huongdan.html">Hướng dẫn</a></div></header>' +
      '<main class="wrap" style="padding-top:18px;padding-bottom:30px">' +
      (err ? '<div class="msg bad">' + err + '</div>' : '') +
      '<div class="card addc"><div class="row"><div style="flex:1;min-width:220px"><h2 style="margin:0 0 4px">Bộ đề của em</h2><div class="hint" style="margin:0">Em tự nạp bộ đề TOEIC / ETS mình có (PDF đề + file nghe + đáp án). Bộ đề lưu ngay trên máy này, lần sau mở ra làm tiếp, không cần mạng.' + (usage ? ' <b>' + usage + '.</b>' : '') + '</div></div><button class="btn accent big" id="addSet">＋ Nạp bộ đề</button></div>' +
      '<details class="howto"><summary>Nạp thế nào? (1 bộ hoặc nhiều bộ một lúc)</summary><ul>' +
      '<li><b>Một bộ:</b> chọn file <b>.zip</b> của bộ đề, hoặc chọn cùng lúc các file: PDF đề (LC, RC), file nghe .mp3, file đáp án (PDF KEY, .docx, .txt hoặc ảnh chụp bảng đáp án) → <b>Bước tiếp: đọc file PDF đề</b> → <b>Lưu bộ đề vào máy</b>.</li>' +
      '<li><b>Nhiều bộ một lúc:</b> chọn file .zip có nhiều Test (Test 01, Test 02…) hoặc (trên máy tính) bấm <b>chọn cả một thư mục</b> → bấm <b>⚡ Nạp tất cả</b>. Để nguyên màn hình đến khi báo xong (khoảng 1–2 phút mỗi bộ).</li>' +
      '<li>File nghe <b>từng câu</b> (vd E26-T01-01.mp3…) giúp phần mềm lật trang đúng lúc băng đọc “Go on to the next page”. File nghe liền 1 Part thì trang chỉ tự lật khi sang Part mới.</li>' +
      '<li>Bộ đề lớn nên nạp trên máy tính; điện thoại nên nạp từng bộ khi có Wi‑Fi và máy còn nhiều chỗ trống.</li></ul></details></div>' +
      (sets.length ? '<div class="setgrid">' + sets.map(card).join('') + '</div>' : '<div class="card empty"><div class="big">📚</div><b>Chưa có bộ đề nào</b><div class="hint">Bấm <b>＋ Nạp bộ đề</b> để bắt đầu.</div></div>') +
      '<div style="margin-top:22px">' + QA.AUTHOR_HTML + '</div></main>';
    $('#addSet').onclick = () => { if (!window.QuizBook) return toast('Thiếu js/booklet.js', 'bad'); importing = true; if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); QuizBook.openImport(bookCtx); };
    $$('.setc').forEach(c => {
      const s = sets.find(x => x.id === c.dataset.set);
      $$('[data-act]', c).forEach(b => b.onclick = () => {
        const a = b.dataset.act;
        if (a === 'exam' || a === 'practice') askStart(s, a);
        else if (a === 'resume') resume(s);
        else if (a === 'hist') showHist(s);
        else if (a === 'edit') { editing = s; QuizBook.view(s, bookCtx); }
        else if (a === 'rename') { const n = prompt('Tên bộ đề:', s.name); if (n && n.trim()) { s.name = n.trim(); DB.put('sets', s).then(renderLib); } }
        else if (a === 'del') delSet(s);
      });
    });
  }
  async function delSet(s) {
    if (!confirm('Xóa bộ đề "' + s.name + '" khỏi máy này? (xóa cả trang đề, file nghe và lịch sử làm bài của bộ này)')) return;
    for (const id of blobIds(s)) await DB.del('blobs', id);
    for (const h of await DB.all('hist')) if (h.setId === s.id) await DB.del('hist', h.id);
    await DB.del('sets', s.id); LS.del(curKey(s.id));
    toast('Đã xóa bộ đề', 'ok'); renderLib();
  }
  function askStart(s, mode) {
    const hasL = s.questions.some(q => q.skill === 'L'), hasR = s.questions.some(q => q.skill === 'R');
    const cur = LS.get(curKey(s.id), null);
    const marks = Object.keys(s.book.marks || {}).length > 0;
    modal('<h2 style="margin-top:0">' + (mode === 'exam' ? '📝 Thi thử' : '🎯 Luyện tập') + ' — ' + esc(s.name) + '</h2>' +
      (mode === 'exam'
        ? '<ul class="rules"><li>File nghe phát <b>1 lần</b>, tự chuyển Part 1 → 4, không tạm dừng, không tua.</li>' +
          '<li>Trang đề <b>tự lật theo file nghe</b>' + (marks ? ' — ngay khi băng sang câu ở trang sau (sau câu “Go on to the next page”)' : ' — bộ này dùng file nghe liền từng Part nên lần đầu phần mềm sẽ dò mốc từng câu trong file nghe (mất khoảng nửa phút)') + '. <b>Không quay lại</b> trang đã qua của phần Nghe.</li>' +
          '<li>Hết phần Nghe tự sang phần Đọc, đồng hồ <b>đếm ngược</b> theo số phút em đặt bên dưới, hết giờ tự nộp. Trong phần Đọc em <b>xem lại, sửa đáp án tự do</b>; không quay lại phần Nghe.</li></ul>'
        : '<ul class="rules"><li><b>Quay lại trang trước</b> thoải mái, cả phần Nghe.</li><li>File nghe: tạm dừng, tua ±10 giây, nghe lại từng Part, đổi tốc độ.</li><li>Bấm <b>👁 Đáp án trang này</b> để kiểm tra ngay; muốn tính giờ thì đặt đồng hồ đếm ngược bên dưới.</li></ul>') +
      (hasL && hasR ? '<label>Làm phần nào?</label><div class="seg" id="segWhich"><button class="on" data-w="LR">Cả đề</button><button data-w="L">Chỉ Nghe</button><button data-w="R">Chỉ Đọc</button></div>' : '') +
      '<label style="margin-top:12px" id="limLab"></label><div class="row limrow"><input type="number" id="limMin" min="0" max="300" step="5" inputmode="numeric" style="width:96px"><span>phút</span><span class="chips" id="limChips"></span></div><div class="hint" id="limHint" style="margin-top:4px"></div>' +
      (cur ? '<div class="msg warn" style="margin-top:10px">Bộ đề này đang có bài làm dở. Bắt đầu mới sẽ <b>bỏ bài đang dở</b>.</div>' : '') +
      '<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" id="mNo">Để sau</button><button class="btn primary" id="mGo">Bắt đầu</button></div>');
    let which = hasL && hasR ? 'LR' : hasL ? 'L' : 'R';
    const hasAud = Object.keys(s.book.parts || {}).length > 0;
    // đồng hồ đếm ngược: Thi thử có file nghe → tính cho phần Đọc (phần Nghe chạy theo băng); còn lại tính cho cả bài
    const limAt = () => (mode === 'exam' && hasAud && which === 'LR' ? 'R' : 'start');
    const limOff = () => mode === 'exam' && hasAud && which === 'L';
    const limDef = () => { const sv = LS.get('tl.lim.' + mode + '.' + which, null); if (sv != null) return sv; return mode !== 'exam' ? 0 : which === 'R' || limAt() === 'R' ? READ_MIN : which === 'L' ? 45 : 120; };
    const limPaint = () => {
      const off = limOff();
      $('#limLab').textContent = off ? 'Đồng hồ: phần Nghe chạy theo file nghe' : limAt() === 'R' ? 'Đếm ngược phần Đọc (phần Nghe chạy theo file nghe)' : 'Đồng hồ đếm ngược cho cả bài';
      $('.limrow').classList.toggle('hide', off);
      $('#limMin').value = limDef();
      $('#limChips').innerHTML = (limAt() === 'R' || which === 'R' ? [75, 60, 45, 30] : which === 'L' ? [45, 30, 15] : [120, 90, 60, 30]).concat(mode === 'exam' ? [] : [0]).map(m => '<button class="chip" data-m="' + m + '">' + (m ? m : 'Không giới hạn') + '</button>').join('');
      $$('#limChips .chip').forEach(c => c.onclick = () => { $('#limMin').value = c.dataset.m; });
      $('#limHint').textContent = off ? '' : 'Hết giờ phần mềm tự nộp bài.' + (mode === 'exam' ? '' : ' Để 0 = không giới hạn (đồng hồ đếm lên).') + ' Thoát giữa chừng thì đồng hồ dừng, làm tiếp chạy tiếp.';
    };
    limPaint();
    $$('#segWhich button').forEach(b => b.onclick = () => { which = b.dataset.w; $$('#segWhich button').forEach(x => x.classList.toggle('on', x === b)); limPaint(); });
    $('#mNo').onclick = closeModal;
    $('#mGo').onclick = () => {
      let lim = limOff() ? 0 : Math.max(0, Math.min(300, Math.round(+$('#limMin').value || 0)));
      if (mode === 'exam' && !limOff() && !lim) lim = limDef() || READ_MIN;
      if (!limOff()) LS.set('tl.lim.' + mode + '.' + which, lim);
      closeModal();
      begin(s, { mode, which, limit: lim, limAt: limAt(), answers: {}, sec: null, page: null, lMax: null, inR: false, apos: null, played: {}, used: 0, rEnd: 0, reveal: {}, auto: true, zoom: 1, rate: 1, lDone: false });
    };
  }
  function resume(s) { const c = LS.get(curKey(s.id), null); if (c) begin(s, c); }

  /* ================================ làm bài ================================ */
  let S = null, tickH = null, wake = null;
  const A = { el: null, k: null, lastSave: 0, mark: '' };
  const EXAM = () => S.st.mode === 'exam', REVIEW = () => S.st.mode === 'review';
  const lIdx = (pi) => (S.secPages.L ? S.secPages.L.indexOf(pi) : -1);
  const partsOf = () => S.set.book.parts || {};
  const marksOf = (k) => (S.set.book.marks && S.set.book.marks[k] && S.set.book.marks[k].length ? S.set.book.marks[k] : null);
  function audSeq() {
    const ks = Object.keys(partsOf());
    if (ks.includes('all')) return ['all'];
    const have = new Set(S.items.filter(q => q.skill === 'L').map(q => String(q.part)));
    return ['1', '2', '3', '4'].filter(k => have.has(k) && partsOf()[k]);
  }
  function saveCur() {
    if (!S || REVIEW()) return;
    S.st.left = S.st.rEnd ? Math.max(0, Math.ceil((S.st.rEnd - Date.now()) / 1000)) : null;
    LS.set(curKey(S.set.id), S.st);
  }
  function pageAllowed(sec, pi) {
    if (sec !== 'L' || !EXAM()) return true;
    if (S.st.inR) return false;
    if (S.st.lMax != null && lIdx(pi) < S.st.lMax) return false;
    return true;
  }
  /** Thi thử, phần Nghe: có được tự bấm sang trang sau không? (đang phát Part có mốc từng câu → chỉ lật theo băng) */
  function canStepFwd() {
    if (!EXAM() || S.st.sec !== 'L' || !S.mapped.L) return '';
    const seq = audSeq(); if (!seq.length || S.st.lDone) return '';
    const k = A.k || (S.st.apos && S.st.apos.k);
    if (!k) return 'Bấm ▶ Bắt đầu phần nghe — trang đề sẽ tự lật theo file nghe.';
    if (marksOf(k) && !(S.set.book.mkAuto && S.set.book.mkAuto[k])) return 'Thi thử: trang tự lật ngay khi file nghe sang câu ở trang sau.';
    return '';
  }

  function begin(set, st) {
    S = { set, st };
    S.items = set.questions.filter(q => st.which === 'LR' || q.skill === st.which);
    S.secs = ['L', 'R'].filter(k => S.items.some(q => q.skill === k));
    const P = set.book.pages;
    S.secPages = {};
    S.secs.forEach(k => {
      const its = S.items.filter(q => q.skill === k && q.page != null).map(q => q.page);
      let list = P.map((p, i) => i).filter(i => P[i].sec === k || P[i].sec === 'LR' || !P[i].sec);
      if (its.length && P.some(p => p.sec === 'LR')) { const lo = Math.min.apply(null, its), hi = Math.max.apply(null, its); list = list.filter(i => P[i].sec !== 'LR' || (i >= lo - 1 && i <= hi)); }
      S.secPages[k] = list;
    });
    S.mapped = {}; S.secs.forEach(k => { S.mapped[k] = S.items.some(q => q.skill === k && q.page != null); });
    if (!st.sec || !S.secs.includes(st.sec)) st.sec = S.secs[0];
    if (st.page == null || !S.secPages[st.sec].includes(st.page)) st.page = S.secPages[st.sec][0];
    if (st.limit == null) { st.limit = st.mode === 'exam' ? READ_MIN : 0; st.limAt = 'R'; }   // bài dở của bản 2.2
    if (st.rEnd && st.left != null) st.rEnd = Date.now() + st.left * 1000;                      // làm tiếp: đồng hồ chạy tiếp từ chỗ dừng
    if (EXAM() && st.sec === 'R') st.inR = true;
    if (!REVIEW() && st.limit && !st.rEnd && (st.limAt === 'start' || st.sec === 'R')) st.rEnd = Date.now() + st.limit * 60000;
    document.body.classList.add('bookmode'); if (!REVIEW()) document.body.classList.add('exam');
    const rng = (k) => { const a = S.items.filter(q => q.skill === k).map(q => q.num); return a.length ? Math.min.apply(null, a) + '–' + Math.max.apply(null, a) : ''; };
    app.innerHTML = '<div class="qbar"><div class="wrap"><div class="tbox" id="tbox"><small id="tlab"></small><b id="tleft"></b></div>' +
      '<div style="min-width:0;flex:1"><div style="font-weight:700" id="qpos"></div><div class="muted ell" style="font-size:.84rem">' + (REVIEW() ? 'Xem lại bài làm' : EXAM() ? 'Thi thử' : 'Luyện tập') + ' · ' + esc(set.name) + '</div></div>' +
      '<button class="btn sm" id="barExit">' + (REVIEW() ? 'Đóng' : 'Thoát') + '</button>' + (REVIEW() ? '' : '<button class="btn sm primary" id="barSubmit">Nộp bài</button>') + '</div><div class="prog"><i id="progbar"></i></div></div>' +
      '<div class="wrap bkwrap">' +
      (S.secs.length > 1 ? '<div class="bktabs">' + S.secs.map(k => '<button class="bktab" data-sec="' + k + '">' + (k === 'L' ? '🎧 Listening · câu ' : '📖 Reading · câu ') + rng(k) + '</button>').join('') + '</div>' : '') +
      '<div class="card bkaud hide" id="bkAud"></div>' +
      '<div class="bkmain"><div class="card bkview"><div class="bkbar"><button class="btn sm" id="pgPrev">◀</button><select id="pgSel"></select><button class="btn sm" id="pgNext">▶</button><span class="spacer"></span><button class="btn sm" id="zOut" title="Thu nhỏ">−</button><button class="btn sm" id="zIn" title="Phóng to">+</button></div><div class="bkimg" id="bkImg"></div></div>' +
      '<div class="card bksheet"><div class="row" style="margin-bottom:6px"><b id="shTitle">Phiếu trả lời</b><span class="spacer"></span>' + (!EXAM() && !REVIEW() ? '<button class="btn sm" id="shKey">👁 Đáp án trang này</button>' : '') + '<button class="btn sm" id="shAll">Phiếu đầy đủ</button></div><div id="bkSheet"></div><div class="bknav"><button class="btn" id="pgPrev2">← Trang trước</button><button class="btn primary" id="pgNext2">Trang sau →</button></div></div></div>' +
      '<div class="card hide" id="palCard"><div class="row" style="margin-bottom:8px"><b>Phiếu trả lời đầy đủ</b><span class="spacer"></span><span class="hint" style="margin:0">' + (REVIEW() ? '<span class="lg ok"></span> đúng <span class="lg bad"></span> sai <span class="lg"></span> bỏ trống' : '<span class="lg ans"></span> đã chọn <span class="lg"></span> chưa chọn') + '</span></div><div class="pal bkpal" id="pal"></div></div>' +
      '<div style="max-width:860px;margin:16px auto 30px">' + QA.AUTHOR_HTML + '</div></div>';
    $('#barExit').onclick = exitAsk;
    if ($('#barSubmit')) $('#barSubmit').onclick = confirmSubmit;
    $$('.bktab').forEach(b => b.onclick = () => switchSec(b.dataset.sec));
    $('#pgPrev').onclick = $('#pgPrev2').onclick = () => stepPage(-1);
    $('#pgNext').onclick = $('#pgNext2').onclick = () => stepPage(1);
    $('#pgSel').onchange = (e) => { const pi = +e.target.value; if (EXAM() && S.st.sec === 'L' && lIdx(pi) > lIdx(S.st.page)) { const w = canStepFwd(); if (w) { toast(w); e.target.value = String(S.st.page); return; } } showPage(pi); };
    $('#zIn').onclick = () => { st.zoom = Math.min(3, (st.zoom || 1) + 0.5); applyZoom(); saveCur(); };
    $('#zOut').onclick = () => { st.zoom = Math.max(1, (st.zoom || 1) - 0.5); applyZoom(); saveCur(); };
    $('#shAll').onclick = () => { const c = $('#palCard'); c.classList.toggle('hide'); palette(); if (!c.classList.contains('hide')) c.scrollIntoView({ behavior: 'smooth' }); };
    if ($('#shKey')) $('#shKey').onclick = () => { st.reveal[st.page] = !st.reveal[st.page]; renderSheet(); saveCur(); };
    clearInterval(tickH); tickH = setInterval(tick, 1000);
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { wake = w; }).catch(() => {}); } catch (e) { /* bỏ qua */ }
    switchSec(st.sec, true);
    paintStatus(); paintTimer();
    window.scrollTo(0, 0);
    if (!REVIEW()) ensureMarks();
  }
  /** Bộ đề dùng file nghe liền Part: dò mốc từng câu (chỉ lần đầu, lưu lại trong bộ đề) để trang tự lật */
  async function ensureMarks() {
    const me = S, set = S.set, bk = set.book;
    if (!S.secs.includes('L') || !S.mapped.L) return;
    const todo = audSeq().filter(k => !marksOf(k) && !(bk.mkTry && bk.mkTry[k]));
    if (!todo.length) return;
    S.scan = { i: 0, n: todo.length }; paintAudio();
    for (const k of todo) {
      if (S !== me) return;
      S.scan.i++; paintAudio();
      let mk = null; try { mk = await detectMarks(set, k); } catch (e) { mk = null; }
      (bk.mkTry = bk.mkTry || {})[k] = mk ? 'ok' : 'no';
      if (mk) { (bk.marks = bk.marks || {})[k] = mk; (bk.mkAuto = bk.mkAuto || {})[k] = true; }
      try { await DB.put('sets', set); } catch (e) { /* bỏ qua */ }
    }
    if (S !== me) return;
    S.scan = null; paintAudio();
    const bad = todo.filter(k => bk.mkTry[k] !== 'ok');
    toast(bad.length ? 'Không dò được mốc lật trang của ' + bad.map(k => (k === 'all' ? 'file nghe' : 'Part ' + k)).join(', ') + ' — phần đó em tự bấm Trang sau.' : 'Đã dò xong mốc lật trang từ file nghe.', bad.length ? '' : 'ok');
  }
  function tick() {
    if (!S) return;
    if (!REVIEW() && !document.hidden) S.st.used = (S.st.used || 0) + 1;
    paintTimer();
    if (S && !REVIEW() && (S.st.used || 0) % 10 === 0) saveCur();
  }
  function paintTimer() {
    if (!S) return;
    const st = S.st, lab = $('#tlab'), tl = $('#tleft'); if (!tl) return;
    if (REVIEW()) { lab.textContent = 'Điểm'; tl.textContent = S.res ? (S.res.toeic && S.res.toeic.LR != null && S.res.full ? S.res.toeic.LR : S.res.c + '/' + S.res.n) : ''; return; }
    if (st.rEnd) {
      const left = Math.ceil((st.rEnd - Date.now()) / 1000);
      lab.textContent = st.limAt === 'R' ? 'Đọc còn' : 'Còn lại'; tl.textContent = fmtSec(Math.max(0, left));
      $('#tbox').classList.toggle('low', left <= 300);
      if (left <= 0) { submit('Hết giờ (' + st.limit + ' phút' + (st.limAt === 'R' ? ' phần Đọc' : '') + ')'); return; }
    } else { lab.textContent = EXAM() && st.sec === 'L' ? 'Phần Nghe' : 'Đã làm'; tl.textContent = fmtSec(st.used || 0); }
  }
  function stopAudio() { if (A.el) { try { A.el.pause(); A.el.removeAttribute('src'); A.el.load(); } catch (e) { /* bỏ qua */ } } A.k = null; A.mark = ''; }
  function leave() {
    stopAudio(); clearInterval(tickH); tickH = null; S = null; dropUrls();
    try { if (wake) wake.release(); } catch (e) { /* bỏ qua */ } wake = null;
    document.body.classList.remove('exam', 'bookmode');
  }
  function exitAsk() {
    if (REVIEW()) { const r = S.res, set = S.set; leave(); showResult(set, r); return; }
    modal('<h2 style="margin-top:0">Thoát bài đang làm?</h2><p>Bài làm được <b>giữ lại trên máy</b> — lần sau bấm <b>▶ Làm tiếp</b> ở bộ đề này.' + (EXAM() ? ' File nghe sẽ dừng; khi làm tiếp em nghe tiếp từ chỗ dừng.' : '') + '</p><div class="row" style="justify-content:flex-end"><button class="btn" id="mNo">Ở lại làm bài</button><button class="btn danger" id="mDrop">Bỏ bài này</button><button class="btn primary" id="mYes">Lưu &amp; thoát</button></div>');
    $('#mNo').onclick = closeModal;
    $('#mYes').onclick = () => { closeModal(); saveCur(); leave(); renderLib(); };
    $('#mDrop').onclick = () => { closeModal(); LS.del(curKey(S.set.id)); leave(); renderLib(); };
  }

  /* ----------------------------- chuyển phần / trang ----------------------------- */
  function enterReading(auto) {
    const st = S.st;
    stopAudio(); st.apos = null; st.inR = true;
    if (LIM() && !st.rEnd) st.rEnd = Date.now() + LIM() * 60000;
    switchSec('R', false, true); window.scrollTo({ top: 0 });
    if (auto) toast('Hết phần Nghe — sang phần Đọc' + (LIM() ? ' (' + LIM() + ' phút)' : ''), 'ok');
  }
  function switchSec(k, keepPage, ok) {
    const st = S.st;
    if (k === 'L' && EXAM() && st.inR) { toast('Thi thử: đã sang phần Đọc — không quay lại phần Nghe.'); return; }
    if (k === 'R' && !keepPage && !ok && EXAM() && !st.inR && S.secs.includes('L')) {
      modal('<h2 style="margin-top:0">Sang phần Đọc?</h2><p>Thi thử: sau khi sang phần <b>Reading</b>, em <b>không quay lại</b> phần Listening được nữa (file nghe dừng)' + (LIM() && !st.rEnd ? ' và đồng hồ <b>' + LIM() + ' phút</b> bắt đầu đếm ngược' : '') + '.</p><div class="row" style="justify-content:flex-end"><button class="btn" id="mNo">Ở lại phần Nghe</button><button class="btn primary" id="mYes">Sang phần Đọc</button></div>');
      $('#mNo').onclick = closeModal;
      $('#mYes').onclick = () => { closeModal(); enterReading(false); };
      return;
    }
    if (k === 'R' && EXAM()) st.inR = true;
    if (k === 'R' && LIM() && !st.rEnd && !REVIEW()) st.rEnd = Date.now() + LIM() * 60000;
    st.sec = k;
    $$('.bktab').forEach(b => { b.classList.toggle('on', b.dataset.sec === k); b.disabled = b.dataset.sec === 'L' && EXAM() && !!st.inR; });
    const pages = S.secPages[k];
    $('#pgSel').innerHTML = pages.map((pi, j) => '<option value="' + pi + '">Trang ' + (j + 1) + ' / ' + pages.length + pageLabel(pi) + '</option>').join('');
    paintAudio(); paintTimer();
    showPage(keepPage && pages.includes(st.page) ? st.page : (st['p' + k] != null && pages.includes(st['p' + k]) ? st['p' + k] : pages[0]));
  }
  function pageLabel(pi) {
    const ns = S.items.filter(q => q.page === pi && q.skill === S.st.sec).map(q => q.num);
    return ns.length ? ' · câu ' + Math.min.apply(null, ns) + (ns.length > 1 ? '–' + Math.max.apply(null, ns) : '') : '';
  }
  function stepPage(d) {
    const st = S.st, pages = S.secPages[st.sec], j = pages.indexOf(st.page) + d;
    if (d > 0) { const w = canStepFwd(); if (w) { toast(w); return; } }
    if (j >= 0 && j < pages.length) { showPage(pages[j]); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (d > 0 && S.secs.indexOf(st.sec) < S.secs.length - 1) { switchSec(S.secs[S.secs.indexOf(st.sec) + 1]); }
    else if (d > 0 && !REVIEW()) confirmSubmit();
    else if (d < 0 && st.sec === 'R' && S.secs[0] === 'L' && !EXAM()) { switchSec('L'); }
  }
  function applyZoom() { const img = $('#bkImg img'); if (img) img.style.width = ((S.st.zoom || 1) * 100) + '%'; }
  function showPage(pi) {
    const st = S.st;
    if (!pageAllowed(st.sec, pi)) { const back = S.secPages.L[st.lMax]; toast('Thi thử: không quay lại trang đã qua của phần Nghe.'); if (back == null || back === pi) return; pi = back; }
    if (st.sec === 'L') { const j = lIdx(pi); if (j >= 0 && (st.lMax == null || j > st.lMax)) st.lMax = j; }
    st.page = pi; st['p' + st.sec] = pi;
    const pg = S.set.book.pages[pi];
    $('#pgSel').value = String(pi);
    const box = $('#bkImg');
    box.innerHTML = '<img alt="Trang đề" draggable="false">';
    const img = box.querySelector('img');
    blobUrl(pg.id).then(u => { if (S && S.st.page === pi) img.src = u; }).catch(() => { box.innerHTML = '<div class="msg bad">Không mở được trang đề này (dữ liệu trên máy đã bị xóa?). Hãy nạp lại bộ đề.</div>'; });
    applyZoom(); box.scrollTop = 0;
    const pages = S.secPages[st.sec], at = pages.indexOf(pi);
    const nx = pages[at + 1]; if (nx != null) blobUrl(S.set.book.pages[nx].id).catch(() => {});
    const lockBack = st.sec === 'L' && EXAM();
    $('#pgPrev').disabled = $('#pgPrev2').disabled = lockBack || (at <= 0 && (S.secs.indexOf(st.sec) === 0 || EXAM()));
    $$('#pgSel option').forEach(o => { o.disabled = !pageAllowed(st.sec, +o.value); });
    const last = at === pages.length - 1 && S.secs.indexOf(st.sec) === S.secs.length - 1;
    $('#pgNext2').textContent = at === pages.length - 1 ? (last ? (REVIEW() ? 'Hết' : 'Nộp bài ✓') : 'Sang phần Đọc →') : 'Trang sau →';
    $('#pgNext2').disabled = $('#pgNext').disabled = last && REVIEW();
    $('#pgPrev2').textContent = lockBack ? '🔒 Không quay lại' : '← Trang trước';
    renderSheet(); saveCur();
  }

  /* -------------------------------- phiếu trả lời -------------------------------- */
  function rowHtml(q, show) {
    const a = S.st.answers[q.num], lock = REVIEW();
    return '<div class="arow' + (a != null ? ' done' : '') + '" data-n="' + q.num + '"><b>' + q.num + '</b>' + q.options.map((_, d) => {
      let c = a === d ? ' sel' : '';
      if (show && q.correct.length) { if (q.correct.includes(d)) c += ' ok'; else if (a === d) c += ' bad'; }
      return '<button class="ab' + c + '" data-n="' + q.num + '" data-d="' + d + '"' + (lock ? ' disabled' : '') + '>' + LET[d] + '</button>';
    }).join('') + (show && a == null ? '<span class="hint" style="margin:0">bỏ trống</span>' : '') + '</div>';
  }
  function renderSheet(focusN) {
    const st = S.st, sec = st.sec, pi = st.page, show = REVIEW() || (!EXAM() && !!st.reveal[pi]);
    const rows = (list) => list.map(q => rowHtml(q, show)).join('');
    const list = S.items.filter(q => q.skill === sec && q.page === pi);
    let html, title;
    if (list.length) { title = 'Phiếu trả lời trang này'; html = rows(list); }
    else if (!S.mapped[sec]) {
      title = 'Phiếu trả lời · ' + (sec === 'L' ? 'Listening' : 'Reading');
      const all = S.items.filter(q => q.skill === sec);
      html = Array.from(new Set(all.map(q => q.part))).map(p => '<div class="shpart">Part ' + p + '</div>' + rows(all.filter(q => q.part === p))).join('');
    } else {
      const pages = S.secPages[sec], nx = pages.slice(pages.indexOf(pi) + 1).find(p2 => S.items.some(q => q.skill === sec && q.page === p2));
      const nl = nx == null || (sec === 'L' && EXAM()) ? [] : S.items.filter(q => q.skill === sec && q.page === nx);
      title = nl.length ? 'Câu hỏi ở trang sau' : 'Phiếu trả lời';
      html = nl.length ? '<div class="hint" style="margin:0 0 6px">Trang này là đoạn văn / hình — câu hỏi in ở trang sau, em có thể chọn đáp án ngay tại đây.</div>' + rows(nl) : '<div class="msg info">Trang này không có câu hỏi' + (sec === 'L' && EXAM() ? ' — trang sẽ tự lật theo file nghe.' : ' — bấm <b>Trang sau →</b>.') + '</div>';
    }
    $('#shTitle').textContent = title;
    if ($('#shKey')) $('#shKey').textContent = st.reveal[pi] ? '🙈 Ẩn đáp án' : '👁 Đáp án trang này';
    const sh = $('#bkSheet'); sh.innerHTML = html;
    $$('.ab', sh).forEach(b => b.onclick = () => {
      const n = +b.dataset.n, d = +b.dataset.d;
      if (st.answers[n] === d) delete st.answers[n]; else st.answers[n] = d;
      if (show) { renderSheet(); } else {
        const row = b.closest('.arow');
        $$('.ab', row).forEach(x => x.classList.toggle('sel', st.answers[n] === +x.dataset.d));
        row.classList.toggle('done', st.answers[n] != null);
      }
      saveCur(); paintStatus();
      if (!$('#palCard').classList.contains('hide')) palette();
    });
    if (focusN != null) { const r = sh.querySelector('[data-n="' + focusN + '"]'); if (r) { r.classList.add('focus'); r.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => r.classList.remove('focus'), 1800); } }
  }
  function paintStatus() {
    const n = S.items.length, c = S.items.filter(q => S.st.answers[q.num] != null).length;
    $('#qpos').textContent = 'Đã chọn ' + c + '/' + n;
    $('#progbar').style.width = (n ? c / n * 100 : 0) + '%';
  }
  function palette() {
    const el = $('#pal'); if (!el) return;
    el.innerHTML = S.secs.map(sec => '<div class="shpart" style="grid-column:1/-1">' + (sec === 'L' ? 'Listening' : 'Reading') + '</div>' + S.items.filter(q => q.skill === sec).map(q => {
      const a = S.st.answers[q.num];
      const cls = REVIEW() ? (a == null ? '' : q.correct.includes(a) ? ' ok' : ' bad') : (a != null ? ' ans' : '');
      return '<button class="pb' + cls + '" data-n="' + q.num + '">' + q.num + (a != null ? '<small>' + LET[a] + '</small>' : '') + '</button>';
    }).join('')).join('');
    $$('.pb', el).forEach(b => b.onclick = () => {
      const q = S.items.find(x => x.num === +b.dataset.n);
      if (q.skill === 'L' && EXAM()) {
        if (S.st.inR) { toast('Thi thử: đã sang phần Đọc — không quay lại phần Nghe.'); return; }
        if (q.page !== S.st.page) { toast(q.page != null && lIdx(q.page) < lIdx(S.st.page) ? 'Thi thử: không quay lại trang đã qua của phần Nghe.' : 'Thi thử: trang phần Nghe lật theo file nghe.'); return; }
      }
      if (q.skill !== S.st.sec) { switchSec(q.skill); if (S.st.sec !== q.skill) return; }
      if (q.page != null && q.page !== S.st.page) showPage(q.page);
      renderSheet(q.num);
      $('.bkmain').scrollIntoView({ behavior: 'smooth' });
    });
  }

  /* -------------------------------- file nghe -------------------------------- */
  function audioEl() {
    if (A.el) return A.el;
    const el = A.el = new Audio(); el.preload = 'auto';
    el.addEventListener('timeupdate', () => {
      if (!S || !A.k) return; const k = A.k;
      const bar = document.getElementById('abar_' + k), t = document.getElementById('at_' + k);
      if (el.duration && bar) bar.style.width = (el.currentTime / el.duration * 100) + '%';
      if (t) t.textContent = fmtSec(el.currentTime) + ' / ' + (el.duration ? fmtSec(el.duration) : '…');
      S.st.apos = { k, t: el.currentTime };
      autoTurn(k, el.currentTime);
      if (Date.now() - A.lastSave > 3000) { A.lastSave = Date.now(); saveCur(); }
    });
    el.addEventListener('ended', () => {
      if (!S || !A.k) return; const k = A.k, st = S.st;
      st.played[k] = true; st.apos = null; A.k = null; A.mark = '';
      const seq = audSeq(), nk = seq[seq.indexOf(k) + 1];
      if (nk) { playPart(nk, 0); return; }
      st.lDone = true; saveCur();
      if (EXAM() && S.secs.includes('R')) enterReading(true); else { paintAudio(); toast('Đã nghe hết phần Nghe', 'ok'); }
    });
    el.addEventListener('pause', () => { if (S && A.k && !el.ended) { saveCur(); paintAudio(); } });
    el.addEventListener('play', () => { if (S) paintAudio(); });
    el.addEventListener('error', () => { if (!S || !A.k || !el.getAttribute('src')) return; A.k = null; paintAudio(); const m = $('#aMsg'); if (m) m.textContent = 'Không phát được file nghe này trên máy (định dạng không hỗ trợ?).'; });
    return el;
  }
  /** Lật trang theo mốc thời gian (mỗi mốc = lúc bắt đầu đoạn nghe của 1 câu → đúng ngay sau "Go on to the next page") */
  function autoTurn(k, t, force) {
    const st = S.st;
    if (st.sec !== 'L' || (!EXAM() && !st.auto)) return;
    const mk = marksOf(k); if (!mk) return;
    let m = null; for (const x of mk) { if (x.t <= t + 0.25) m = x; else break; }
    if (!m || (!force && A.mark === k + ':' + m.n)) return; A.mark = k + ':' + m.n;
    const q = S.items.find(x => x.skill === 'L' && +x.num === +m.n && x.page != null); if (!q || q.page === st.page) return;
    const onPg = S.items.filter(x => x.skill === 'L' && x.page === st.page).map(x => +x.num);
    if (force || !onPg.length || Math.max.apply(null, onPg) < +m.n) { showPage(q.page); flashTurn(); }
  }
  function flashTurn() { const v = $('.bkview'); if (v) { v.classList.remove('turn'); void v.offsetWidth; v.classList.add('turn'); } }
  async function playPart(k, from) {
    const st = S.st, name = partsOf()[k], ref = name && S.set.audio && S.set.audio[name];
    const msg = (t) => { const m = $('#aMsg'); if (m) m.textContent = t; };
    if (!ref) { msg('Bộ đề chưa có file nghe ' + (k === 'all' ? '' : 'Part ' + k) + '.'); return; }
    const el = audioEl();
    let url; try { url = await blobUrl(ref.id); } catch (e) { msg('Không thấy file nghe trong máy — hãy nạp lại bộ đề.'); return; }
    if (!S) return;
    A.k = k; A.mark = ''; st.apos = { k, t: from || 0 };
    el.src = url; el.playbackRate = EXAM() ? 1 : (st.rate || 1);
    if (from > 0) { const seek = () => { try { if (from < (el.duration || 1e9) - 1) el.currentTime = from; } catch (e) { /* bỏ qua */ } el.removeEventListener('loadedmetadata', seek); }; el.addEventListener('loadedmetadata', seek); }
    // đang ở trang của Part trước → lật tới trang đầu của Part đang nghe
    if (st.sec === 'L' && k !== 'all' && (EXAM() || st.auto) && !(from > 0)) {
      const q = S.items.find(x => x.skill === 'L' && String(x.part) === k && x.page != null);
      const onPg = S.items.filter(x => x.skill === 'L' && x.page === st.page).map(x => +x.part);
      if (q && q.page !== st.page && (!onPg.length || Math.max.apply(null, onPg) < +k)) { showPage(q.page); flashTurn(); }
    }
    paintAudio(); saveCur();
    try { await el.play(); el.playbackRate = EXAM() ? 1 : (st.rate || 1); }
    catch (e) { paintAudio(); msg('Bấm ▶ để nghe.'); }
  }
  function paintAudio() {
    const box = $('#bkAud'); if (!box) return;
    const st = S.st;
    if (st.sec !== 'L' || !S.secs.includes('L')) { box.classList.add('hide'); return; }
    box.classList.remove('hide');
    const seq = audSeq(), el = A.el, playing = !!(el && A.k && !el.paused), ap = st.apos;
    if (!seq.length) { box.innerHTML = '<div class="msg warn" style="margin:0">Bộ đề này chưa có file nghe — em vẫn xem trang đề và tô đáp án được. Muốn có tiếng: xóa bộ đề rồi nạp lại kèm file .mp3.</div>'; return; }
    const pname = (k) => (k === 'all' ? 'Toàn bộ' : 'Part ' + k);
    let main;
    if (S.scan && !S.scanHide && !(el && A.k)) {
      box.innerHTML = '<div class="row"><b>🎧 Phần nghe</b><span class="spacer"></span><button class="btn sm" id="aSkip">Bỏ qua, nghe luôn</button></div><div class="msg info" style="margin:8px 0 0">⏳ Đang dò mốc lật trang từ file nghe (chỉ lần đầu của bộ đề này): ' + S.scan.i + '/' + S.scan.n + '… Xong là bấm nghe được, trang sẽ tự lật theo băng.</div><div class="hint" id="aMsg"></div>';
      $('#aSkip').onclick = () => { S.scanHide = true; paintAudio(); };
      return;
    }
    if (EXAM()) {
      if (playing) main = '<button class="btn" disabled>♪ Đang phát ' + pname(A.k) + '…</button>';
      else if (st.lDone) main = '<span class="pill ok">Đã nghe xong</span>';
      else if (ap && ap.k && seq.includes(ap.k)) main = '<button class="btn primary" id="aMain">▶ Nghe tiếp ' + pname(ap.k) + ' từ ' + fmtSec(ap.t) + '</button>';
      else { const nk = seq.find(k => !st.played[k]); main = nk ? '<button class="btn primary big" id="aMain">▶ Bắt đầu phần nghe</button>' : '<span class="pill ok">Đã nghe xong</span>'; }
    } else {
      main = '<div class="actl"><button class="btn sm" id="aBack" title="Lùi 10 giây">⟲ 10s</button><button class="btn primary" id="aMain">' + (playing ? '⏸ Tạm dừng' : (ap && ap.t > 1 ? '▶ Nghe tiếp' : '▶ Nghe')) + '</button><button class="btn sm" id="aFwd" title="Tới 10 giây">10s ⟳</button>' +
        '<select id="aRate" title="Tốc độ">' + [0.75, 1, 1.25].map(r => '<option value="' + r + '"' + ((st.rate || 1) === r ? ' selected' : '') + '>' + r + '×</option>').join('') + '</select></div>';
    }
    box.innerHTML = '<div class="row"><b>🎧 Phần nghe</b><span class="hint" style="margin:0">' + (EXAM() ? 'Thi thử: mỗi Part phát 1 lần, tự chuyển Part, trang tự lật theo băng.' : REVIEW() ? 'Xem lại: nghe lại tùy ý.' : 'Luyện tập: nghe lại không giới hạn.') + '</span><span class="spacer"></span>' + main + '</div>' +
      '<div class="aparts">' + seq.map(k => {
        const cur = A.k === k || (!A.k && ap && ap.k === k), done = st.played[k] && !cur;
        return '<div class="apart' + (cur ? ' cur' : '') + (done ? ' done' : '') + '"><span>' + pname(k) + '</span><div class="abar' + (EXAM() ? '' : ' seek') + '" data-k="' + k + '"><i id="abar_' + k + '"' + (done ? ' style="width:100%"' : '') + '></i></div><span class="hint" id="at_' + k + '">' + (cur && ap ? fmtSec(ap.t) : done ? '✓ đã nghe' : 'chưa nghe') + '</span>' + (EXAM() ? '' : '<button class="btn sm" data-play="' + k + '" title="Nghe ' + pname(k) + ' từ đầu">▶</button>') + '</div>';
      }).join('') + '</div>' +
      (EXAM() ? '' : '<label class="check" style="margin-top:8px"><input type="checkbox" id="aAuto"' + (st.auto ? ' checked' : '') + '> Tự lật trang theo file nghe</label>') + '<div class="hint" id="aMsg"></div>';
    const m = $('#aMain');
    if (m) m.onclick = () => {
      if (EXAM()) { if (ap && ap.k && seq.includes(ap.k)) playPart(ap.k, ap.t); else playPart(seq.find(k => !st.played[k]) || seq[0], 0); return; }
      if (el && A.k) { if (el.paused) el.play().catch(() => {}); else el.pause(); return; }
      if (ap && ap.k && seq.includes(ap.k)) playPart(ap.k, ap.t); else playPart(seq.find(k => !st.played[k]) || seq[0], 0);
    };
    if (!EXAM()) {
      const jump = (d) => { if (el && A.k) { try { el.currentTime = Math.max(0, Math.min((el.duration || 1e9) - 0.5, el.currentTime + d)); autoTurn(A.k, el.currentTime, d < 0); } catch (e) { /* bỏ qua */ } } };
      $('#aBack').onclick = () => jump(-10); $('#aFwd').onclick = () => jump(10);
      $('#aRate').onchange = (e) => { st.rate = +e.target.value || 1; if (el) el.playbackRate = st.rate; saveCur(); };
      $('#aAuto').onchange = (e) => { st.auto = e.target.checked; saveCur(); };
      $$('[data-play]', box).forEach(b => b.onclick = () => playPart(b.dataset.play, 0));
      $$('.abar.seek', box).forEach(bar => bar.onclick = (e) => {
        if (!el || A.k !== bar.dataset.k || !el.duration) return;
        const r = bar.getBoundingClientRect(); el.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * el.duration; autoTurn(A.k, el.currentTime, true);
      });
    }
  }

  /* -------------------------------- nộp bài, chấm -------------------------------- */
  function confirmSubmit() {
    const blank = S.items.filter(q => S.st.answers[q.num] == null).length;
    modal('<h2 style="margin-top:0">Nộp bài?</h2><p>' + (blank ? 'Em còn <b>' + blank + ' câu chưa chọn</b> đáp án.' : 'Em đã chọn đáp án cho tất cả các câu.') + ' Nộp bài để xem điểm và đáp án.</p><div class="row" style="justify-content:flex-end"><button class="btn" id="mNo">Làm tiếp</button><button class="btn primary" id="mYes">Nộp bài</button></div>');
    $('#mNo').onclick = closeModal; $('#mYes').onclick = () => { closeModal(); submit(''); };
  }
  function grade(set, st) {
    const items = set.questions.filter(q => st.which === 'LR' || q.skill === st.which);
    const res = { c: 0, n: 0, sk: {}, parts: {}, noKey: 0 };
    items.forEach(q => {
      if (!q.correct.length) { res.noKey++; return; }
      const ok = st.answers[q.num] != null && q.correct.includes(st.answers[q.num]);
      const s = res.sk[q.skill] || (res.sk[q.skill] = { c: 0, n: 0 }), p = res.parts[q.part] || (res.parts[q.part] = { c: 0, n: 0 });
      s.n++; p.n++; res.n++; if (ok) { s.c++; p.c++; res.c++; }
    });
    const lin = (o) => (o && o.n ? Math.round((5 + 490 * o.c / o.n) / 5) * 5 : null);
    res.toeic = { L: lin(res.sk.L), R: lin(res.sk.R) };
    if (res.toeic.L != null || res.toeic.R != null) res.toeic.LR = (res.toeic.L || 0) + (res.toeic.R || 0);
    res.full = st.which === 'LR' && res.toeic.L != null && res.toeic.R != null;
    return res;
  }
  async function submit(reason) {
    if (!S || REVIEW()) return;
    const set = S.set, st = S.st;
    const res = grade(set, st);
    const rec = Object.assign({ id: 'h' + Date.now().toString(36), setId: set.id, setName: set.name, mode: st.mode, which: st.which, at: Date.now(), used: st.used || 0, answers: st.answers, reason: reason || '' }, res);
    try { await DB.put('hist', rec); } catch (e) { toast('Không lưu được lịch sử làm bài', 'bad'); }
    LS.del(curKey(set.id));
    leave(); closeModal();
    showResult(set, rec);
  }
  function showResult(set, r) {
    document.body.classList.remove('exam', 'bookmode');
    const pct = r.n ? Math.round(r.c / r.n * 100) : 0;
    const sk = (k, name) => (r.sk[k] ? '<div class="skc"><small>' + name + '</small><b>' + r.sk[k].c + '/' + r.sk[k].n + '</b>' + (r.toeic[k] != null ? '<span>≈ ' + r.toeic[k] + ' điểm</span>' : '') + '</div>' : '');
    const qs = set.questions.filter(q => r.which === 'LR' || q.skill === r.which);
    app.innerHTML = '<header class="topbar"><div class="wrap"><b>Kết quả · ' + esc(set.name) + '</b><span class="spacer"></span><button class="btn sm" id="rBack">Danh sách bộ đề</button></div></header>' +
      '<main class="wrap" style="padding-top:18px;padding-bottom:30px"><div class="card done"><div class="muted">' + (r.mode === 'exam' ? 'Thi thử' : 'Luyện tập') + (r.which === 'L' ? ' · chỉ phần Nghe' : r.which === 'R' ? ' · chỉ phần Đọc' : '') + ' · ' + fmtTime(r.at) + ' · làm trong ' + fmtSec(r.used) + (r.reason ? ' · ' + esc(r.reason) : '') + '</div>' +
      (r.full ? '<div class="bigscore">' + r.toeic.LR + '</div><div class="muted">điểm TOEIC ước tính (thang 10–990, quy đổi tuyến tính để tham khảo)</div>' : '<div class="bigscore">' + r.c + '/' + r.n + '</div><div class="muted">câu đúng (' + pct + '%)</div>') +
      '<div class="skrow">' + sk('L', '🎧 Listening') + sk('R', '📖 Reading') + '</div>' +
      '<div class="ptags">' + Object.keys(r.parts).sort().map(p => '<span class="pill ' + (r.parts[p].c / r.parts[p].n >= 0.7 ? 'ok' : r.parts[p].c / r.parts[p].n >= 0.5 ? 'warn' : 'bad') + '">Part ' + p + ': ' + r.parts[p].c + '/' + r.parts[p].n + '</span>').join('') + '</div>' +
      (r.noKey ? '<div class="msg warn">' + r.noKey + ' câu chưa có đáp án trong bộ đề nên không chấm (bấm Sửa đáp án ở bộ đề để bổ sung).</div>' : '') +
      '<div class="acts" style="margin-top:14px"><button class="btn primary" id="rRev">🔍 Xem lại từng trang với đáp án</button><button class="btn" id="rAgain">↻ Làm lại</button></div></div>' +
      '<div class="card review"><h3 style="margin-top:0">Đáp án chi tiết</h3><div class="hint">Vòng xanh = đáp án đúng; vòng đỏ = em chọn sai. Bấm vào một câu để mở trang đề của câu đó.</div>' +
      ['L', 'R'].filter(k => qs.some(q => q.skill === k)).map(k => '<div class="shpart">' + (k === 'L' ? 'Listening' : 'Reading') + '</div><div class="revgrid">' + qs.filter(q => q.skill === k).map(q => {
        const a = r.answers[q.num];
        return '<div class="rv' + (a == null ? ' skip' : '') + '" data-n="' + q.num + '"><b>' + q.num + '</b>' + q.options.map((_, d) => '<span class="' + (q.correct.includes(d) ? 'c' : a === d ? 'x' : '') + '">' + LET[d] + '</span>').join('') + (a == null ? '<small class="muted">–</small>' : q.correct.includes(a) ? '<small style="color:var(--ok)">✓</small>' : '<small style="color:var(--bad)">✗</small>') + '</div>';
      }).join('') + '</div>').join('') + '</div><div style="margin-top:22px">' + QA.AUTHOR_HTML + '</div></main>';
    const review = (num) => {
      const st = { mode: 'review', which: r.which, answers: r.answers, sec: null, page: null, lMax: null, inR: false, apos: null, played: {}, used: r.used, rEnd: 0, reveal: {}, auto: true, zoom: 1, rate: 1 };
      if (num != null) { const q = set.questions.find(x => x.num === num); if (q) { st.sec = q.skill; if (q.page != null) st.page = q.page; } }
      begin(set, st); S.res = r; paintTimer();
      if (num != null) renderSheet(num);
    };
    $('#rBack').onclick = renderLib;
    $('#rRev').onclick = () => review(null);
    $('#rAgain').onclick = () => askStart(set, r.mode === 'exam' ? 'exam' : 'practice');
    $$('.rv').forEach(el => el.onclick = () => review(+el.dataset.n));
    window.scrollTo(0, 0);
  }
  async function showHist(s) {
    const hs = (await DB.all('hist')).filter(h => h.setId === s.id).sort((a, b) => b.at - a.at);
    modal('<div class="row"><h2 style="margin:0">Lịch sử · ' + esc(s.name) + '</h2><span class="spacer"></span><button class="btn sm" id="mClose">Đóng</button></div>' +
      '<div style="overflow:auto"><table class="tbl" style="margin-top:10px"><tr><th>Ngày</th><th>Chế độ</th><th class="num">Nghe</th><th class="num">Đọc</th><th class="num">TOEIC</th><th></th></tr>' +
      hs.map(h => '<tr><td>' + fmtTime(h.at) + '</td><td>' + (h.mode === 'exam' ? 'Thi thử' : 'Luyện tập') + '</td><td class="num">' + (h.sk.L ? h.sk.L.c + '/' + h.sk.L.n : '–') + '</td><td class="num">' + (h.sk.R ? h.sk.R.c + '/' + h.sk.R.n : '–') + '</td><td class="num"><b>' + (h.full ? h.toeic.LR : '–') + '</b></td><td><button class="btn sm" data-h="' + h.id + '">Xem</button></td></tr>').join('') + '</table></div>');
    $('#mClose').onclick = closeModal;
    $$('[data-h]').forEach(b => b.onclick = () => { closeModal(); showResult(s, hs.find(h => h.id === b.dataset.h)); });
  }

  window.addEventListener('pagehide', saveCur);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveCur(); else if (S && navigator.wakeLock && !REVIEW()) navigator.wakeLock.request('screen').then(w => { wake = w; }).catch(() => {}); });
  window.addEventListener('beforeunload', (e) => { if (importing || (S && !REVIEW() && A.k)) { e.preventDefault(); e.returnValue = ''; } });
  gc().then(renderLib);
})();
