/* SC科目Bドリル — 依存なしのSPA。データ: data/catalog.json（過去問）, data/original.json（オリジナル演習） */
(() => {
  "use strict";
  const KEY = "scb:v1";
  const $ = (s, el = document) => el.querySelector(s);
  const app = $("#app");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const countChars = (s) => Array.from(String(s || "").replace(/\s/g, "")).length;

  // ---------- 保存 ----------
  let store = { answers: {}, history: [], timers: {} };
  try { store = Object.assign(store, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (_) { /* 使えない環境ではメモリだけ */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (_) { /* noop */ } };
  const ans = (pid) => (store.answers[pid] ||= { values: {}, grades: {}, custom: [] });

  // ---------- データ ----------
  let problems = new Map();
  let catalog = { exams: [] }, original = { problems: [] };

  function targetMinutes(examId) {
    if (/_pm1$/.test(examId)) return 45;
    if (/_pm2$/.test(examId)) return 120;
    return 75;
  }

  async function load() {
    const get = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    [catalog, original] = await Promise.all([get("data/catalog.json"), get("data/original.json")]);
    catalog ||= { exams: [] }; original ||= { problems: [] };
    for (const ex of catalog.exams) {
      for (const q of ex.questions) {
        const pid = `p:${ex.id}:${q.no}`;
        problems.set(pid, {
          pid, kind: "past", exam: ex, no: q.no,
          title: `問${q.no} ${q.theme || ""}`.trim(), sub: ex.label,
          pages: q.pages, ansPages: q.ansPages, answerText: q.answerText, commentText: q.commentText,
          cite: q.cite, slots: q.slots?.length ? q.slots : [{ label: "解答メモ", prompt: "設問番号ごとに解答を書いてください。", limit: null }],
          minutes: targetMinutes(ex.id),
        });
      }
    }
    for (const p of original.problems) {
      problems.set(`o:${p.id}`, {
        pid: `o:${p.id}`, kind: "orig", title: p.title, sub: `オリジナル演習｜${p.theme}`,
        body: p.body, slots: p.slots, minutes: p.minutes || 30,
      });
    }
  }

  // ---------- 採点 ----------
  const slotsOf = (p) => [...p.slots, ...ans(p.pid).custom.map((label) => ({ label, prompt: "", limit: null, custom: true }))];
  function scoreOf(p) {
    const a = ans(p.pid), slots = slotsOf(p);
    let got = 0, graded = 0;
    for (const s of slots) { const v = a.grades[s.label]; if (v !== undefined) { got += v; graded++; } }
    return { got, graded, total: slots.length, rate: slots.length ? got / slots.length : 0 };
  }
  const lastAttempt = (pid) => [...store.history].reverse().find((h) => h.pid === pid);
  const badgeClass = (r) => (r >= 0.7 ? "good" : r >= 0.5 ? "mid" : "bad");

  // ---------- タイマー ----------
  let tick = null, currentPid = null;
  const timerBtn = $("#timer"), timerText = $("#timerText");
  const tState = (pid) => (store.timers[pid] ||= { elapsed: 0, startedAt: null });
  const elapsedSec = (pid) => { const t = tState(pid); return Math.floor(t.elapsed + (t.startedAt ? (Date.now() - t.startedAt) / 1000 : 0)); };
  const fmt = (sec) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  function paintTimer() {
    if (!currentPid) return;
    const p = problems.get(currentPid), sec = elapsedSec(currentPid), t = tState(currentPid);
    timerText.textContent = `${fmt(sec)} / ${p.minutes}分`;
    timerBtn.classList.toggle("running", !!t.startedAt);
    timerBtn.classList.toggle("over", sec > p.minutes * 60);
  }
  timerBtn.addEventListener("click", () => {
    const t = tState(currentPid);
    if (t.startedAt) { t.elapsed += (Date.now() - t.startedAt) / 1000; t.startedAt = null; }
    else t.startedAt = Date.now();
    save(); paintTimer();
  });

  // ---------- ルーティング ----------
  const tabbar = $("#tabbar"), backBtn = $("#backBtn"), titleEl = $("#title");
  backBtn.addEventListener("click", () => { location.hash = "#/" + (sessionStorageGet("homeTab") ? "?tab=" + sessionStorageGet("homeTab") : ""); });
  function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
  function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* noop */ } }

  function route() {
    const h = location.hash.slice(1) || "/";
    const m = h.match(/^\/s\/([^/]+)\/(q|a|c)$/);
    window.scrollTo(0, 0);
    if (m && problems.has(decodeURIComponent(m[1]))) return renderProblem(problems.get(decodeURIComponent(m[1])), m[2]);
    const tab = (h.match(/tab=(\w+)/) || [])[1] || sessionStorageGet("homeTab") || (catalog.exams.length ? "past" : "orig");
    renderHome(tab);
  }
  window.addEventListener("hashchange", route);

  // ---------- ホーム ----------
  function renderHome(tab) {
    sessionStorageSet("homeTab", tab);
    currentPid = null; timerBtn.hidden = true; backBtn.hidden = true; tabbar.hidden = true;
    titleEl.textContent = "SC科目Bドリル";
    const done = new Set(store.history.map((h) => h.pid)).size;
    const avg = store.history.length ? Math.round((store.history.reduce((s, h) => s + h.score / h.total, 0) / store.history.length) * 100) : null;
    const pastCount = catalog.exams.reduce((s, e) => s + e.questions.length, 0);

    let list = "";
    if (tab === "past") {
      if (!catalog.exams.length) {
        list = `<div class="notice"><b>過去問データがまだありません。</b><br>GitHubにpushすると、GitHub ActionsがIPAの公開PDFを取得して問ごとに分割し、ここに一覧が出ます。手元で試すときは <code>python3 scripts/build_pastexams.py</code> を実行してください。</div>`;
      }
      for (const ex of catalog.exams) {
        list += `<div class="group-title">${esc(ex.label)}</div>`;
        for (const q of ex.questions) list += cardHTML(problems.get(`p:${ex.id}:${q.no}`), `問${q.no}`);
      }
    } else if (tab === "orig") {
      list += `<p class="cite">${esc(original.note || "")}</p>`;
      original.problems.forEach((p, i) => { list += cardHTML(problems.get(`o:${p.id}`), `O${i + 1}`); });
    } else {
      list = historyHTML();
    }

    app.innerHTML = `
      <section class="hero">
        <h1>情報処理安全確保支援士<br>科目B 過去問ドリル</h1>
        <p>問題を読む → 解答欄に書く → 解答例と見比べて○△×で自己採点</p>
        <div class="stats">
          <div class="stat"><b>${pastCount}</b><span>過去問の問数</span></div>
          <div class="stat"><b>${done}</b><span>解いた問題</span></div>
          <div class="stat"><b>${avg ?? "–"}${avg !== null ? '<small style="font-size:13px">%</small>' : ""}</b><span>平均自己採点</span></div>
        </div>
      </section>
      <div class="seg" role="tablist">
        ${[["past", "過去問"], ["orig", "オリジナル"], ["hist", "履歴・設定"]].map(([k, l]) => `<button aria-pressed="${tab === k}" data-tab="${k}">${l}</button>`).join("")}
      </div>
      ${list}
      <p class="footer">過去問題の著作権はIPA（情報処理推進機構）にあります。各問題に出典を表示しています。<br>採点は自己採点の目安です。<br>©2026 YAMANEX Inc.</p>`;
    app.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { location.hash = "#/?tab=" + b.dataset.tab; }));
    if (tab === "hist") bindSettings();
  }

  function cardHTML(p, no) {
    const last = lastAttempt(p.pid);
    const inProgress = Object.values(ans(p.pid).values).some((v) => v && v.trim());
    const badge = last ? `<span class="badge ${badgeClass(last.score / last.total)}">${Math.round((last.score / last.total) * 100)}%</span>`
      : inProgress ? `<span class="badge">途中</span>` : "";
    const sub = p.kind === "past" ? `解答欄 ${p.slots.length}・目安 ${p.minutes}分` : `${esc(p.sub)}・目安 ${p.minutes}分`;
    return `<a class="card" href="#/s/${encodeURIComponent(p.pid)}/q"><div class="no">${no}</div><div class="body"><div class="t">${esc(p.kind === "past" ? (p.title.replace(/^問\d+\s*/, "") || "（テーマ名なし）") : p.title)}</div><div class="s">${sub}</div></div>${badge}</a>`;
  }

  function historyHTML() {
    const rows = [...store.history].reverse().slice(0, 100).map((h) => {
      const p = problems.get(h.pid);
      const r = h.score / h.total;
      return `<a class="hist" href="#/s/${encodeURIComponent(h.pid)}/c" style="text-decoration:none;color:inherit"><div class="body"><div>${esc(p ? `${p.sub.split("｜")[0]} ${p.title}` : h.title)}</div><div class="s">${new Date(h.date).toLocaleString("ja-JP")}・${fmt(h.sec || 0)}</div></div><span class="badge ${badgeClass(r)}">${h.score}/${h.total}</span></a>`;
    }).join("");
    return `<div class="group-title">解答履歴</div>${rows || '<div class="empty">まだ記録がありません</div>'}
      <div class="group-title">データ</div>
      <div class="settings">
        <button class="btn ghost block" id="exportBtn">学習データを書き出す（JSON）</button>
        <label class="btn ghost block">学習データを読み込む<input type="file" id="importFile" accept="application/json" hidden></label>
        <button class="btn ghost block" id="resetBtn" style="color:var(--ng)">学習データをすべて消す</button>
      </div>
      <p class="cite">学習データはこの端末のブラウザ内にだけ保存されます。機種変更や別端末で続けるときは書き出し→読み込みを使ってください。</p>`;
  }

  function bindSettings() {
    $("#exportBtn").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(store, null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `sc-kamokub-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    });
    $("#importFile").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const d = JSON.parse(await f.text()); if (!d.answers) throw 0; store = Object.assign({ answers: {}, history: [], timers: {} }, d); save(); route(); }
      catch (_) { e.target.value = ""; toast("読み込めませんでした（形式が違います）"); }
    });
    let armed = false;
    $("#resetBtn").addEventListener("click", (e) => {
      if (!armed) { armed = true; e.target.textContent = "もう一度押すと消去します"; return; }
      store = { answers: {}, history: [], timers: {} }; save(); route();
    });
  }

  // ---------- 問題画面 ----------
  const TABS = [
    ["q", "問題", '<path d="M6 3h9l4 4v14H6z M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'],
    ["a", "解答", '<path d="M4 20h4L19 9l-4-4L4 16z M13 7l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'],
    ["c", "答え合わせ", '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'],
  ];

  function renderProblem(p, tab) {
    currentPid = p.pid;
    backBtn.hidden = false; timerBtn.hidden = false; tabbar.hidden = false;
    titleEl.textContent = p.kind === "past" ? `${p.exam.label.replace("（旧形式）", "")} 問${p.no}` : p.title;
    paintTimer();
    tabbar.innerHTML = TABS.map(([k, l, icon]) => `<button role="tab" aria-selected="${k === tab}" data-k="${k}"><svg viewBox="0 0 24 24">${icon}</svg>${l}</button>`).join("");
    tabbar.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { location.hash = `#/s/${encodeURIComponent(p.pid)}/${b.dataset.k}`; }));
    if (tab === "q") viewQuestion(p);
    else if (tab === "a") viewAnswer(p);
    else viewCheck(p);
  }

  function viewQuestion(p) {
    const head = `<div class="hero" style="margin-bottom:10px"><h1 style="font-size:19px">${esc(p.title)}</h1><p>${esc(p.sub)}</p></div>`;
    if (p.kind === "orig") {
      app.innerHTML = `${head}<div class="prose">${p.body.replace(/<table/g, '<div class="table-wrap"><table').replace(/<\/table>/g, "</table></div>")}</div>
        <div class="group-title">設問</div>${p.slots.map((s) => `<div class="slot"><div class="slot-head"><span class="slot-label">${esc(s.label)}</span>${s.limit ? `<span class="slot-limit">${s.limit}字以内</span>` : ""}</div><div class="slot-prompt" style="margin:4px 0 0;color:var(--text)">${esc(s.prompt)}</div></div>`).join("")}
        <button class="btn block" id="goAns">解答を書く</button>${timerHint(p)}`;
    } else {
      app.innerHTML = `${head}<p class="zoom-hint">ページをタップすると拡大表示（ピンチで拡大縮小）</p>
        <div class="pages">${p.pages.map((src, i) => `<img src="${esc(src)}" alt="問題 ${i + 1}ページ目" loading="${i < 2 ? "eager" : "lazy"}" data-zoom>`).join("")}</div>
        <p class="cite">${esc(p.cite)}<br><a href="${esc(p.exam.links.qs)}" target="_blank" rel="noopener">IPA公式の問題冊子PDF</a></p>
        <button class="btn block" id="goAns">解答を書く</button>${timerHint(p)}`;
    }
    $("#goAns").addEventListener("click", () => { location.hash = `#/s/${encodeURIComponent(p.pid)}/a`; });
    bindZoom();
  }
  const timerHint = (p) => `<p class="cite" style="text-align:center">右上のタイマーをタップで計測開始・一時停止（目安 ${p.minutes}分）</p>`;

  function viewAnswer(p) {
    const a = ans(p.pid);
    const slots = slotsOf(p);
    app.innerHTML = `
      ${p.kind === "past" ? `<p class="cite" style="margin-top:0">解答欄は問題文の設問から自動で作っています。足りない・ずれているときは下の「解答欄を追加」を使ってください。</p>` : ""}
      ${slots.map((s, i) => `
        <div class="slot">
          <div class="slot-head"><span class="slot-label">${esc(s.label)}</span>${s.limit ? `<span class="slot-limit">${s.limit}字以内</span>` : ""}${s.custom ? `<button class="slot-del" data-del="${esc(s.label)}">削除</button>` : ""}</div>
          ${s.prompt ? `<div class="slot-prompt">${esc(s.prompt)}</div>` : ""}
          <textarea data-i="${i}" rows="2" placeholder="解答を入力">${esc(a.values[s.label] || "")}</textarea>
          <div class="count" id="cnt${i}"></div>
        </div>`).join("")}
      <div class="slot"><div class="row" style="margin:0"><input id="newLabel" placeholder="例：設問2(3)" style="flex:2;border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--bg)"><button class="btn ghost" id="addSlot">解答欄を追加</button></div></div>
      <button class="btn block" id="goCheck">答え合わせへ</button>`;
    const upd = (i) => {
      const s = slots[i], n = countChars(a.values[s.label]);
      const el = $("#cnt" + i);
      el.textContent = s.limit ? `${n} / ${s.limit}字` : `${n}字`;
      el.classList.toggle("over", !!s.limit && n > s.limit);
    };
    app.querySelectorAll("textarea").forEach((ta) => {
      const i = +ta.dataset.i; upd(i);
      const grow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; };
      grow();
      ta.addEventListener("input", () => { a.values[slots[i].label] = ta.value; save(); upd(i); grow(); });
    });
    $("#addSlot").addEventListener("click", () => {
      const v = $("#newLabel").value.trim();
      if (!v || slots.some((s) => s.label === v)) return;
      a.custom.push(v); save(); viewAnswer(p);
    });
    app.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      a.custom = a.custom.filter((l) => l !== b.dataset.del); delete a.values[b.dataset.del]; delete a.grades[b.dataset.del]; save(); viewAnswer(p);
    }));
    $("#goCheck").addEventListener("click", () => { location.hash = `#/s/${encodeURIComponent(p.pid)}/c`; });
  }

  function viewCheck(p) {
    const a = ans(p.pid);
    const slots = slotsOf(p);
    const sc = scoreOf(p);
    let ref = "";
    if (p.kind === "past") {
      ref = `
        <details class="box" open><summary>解答例・出題趣旨（IPA）</summary><div class="inner">
          ${p.answerText ? `<pre class="answer">${esc(p.answerText)}</pre>` : '<p class="cite">テキストを抽出できませんでした。下の画像を見てください。</p>'}
        </div></details>
        <details class="box"><summary>解答例PDFの画像</summary><div class="inner pages">${p.ansPages.map((src) => `<img src="${esc(src)}" alt="解答例" loading="lazy" data-zoom>`).join("")}</div></details>
        ${p.commentText ? `<details class="box"><summary>採点講評（IPA）</summary><div class="inner"><pre class="answer">${esc(p.commentText)}</pre></div></details>` : ""}
        <p class="cite">${esc(p.cite)}（解答例・採点講評）<br><a href="${esc(p.exam.links.ans)}" target="_blank" rel="noopener">解答例PDF</a>${p.exam.links.cmnt ? ` ・ <a href="${esc(p.exam.links.cmnt)}" target="_blank" rel="noopener">採点講評PDF</a>` : ""}</p>
        <div class="group-title">自己採点</div>`;
    }
    app.innerHTML = `
      <div class="score"><b>${sc.got}</b> / ${sc.total}<span>採点済み ${sc.graded}/${sc.total}・経過 ${fmt(elapsedSec(p.pid))}</span></div>
      ${ref}
      ${slots.map((s) => {
        const v = a.grades[s.label];
        return `<div class="cmp"><h4>${esc(s.label)}${s.limit ? ` <span class="slot-limit">${s.limit}字以内</span>` : ""}</h4>
          <div class="yours"><span class="k">あなたの解答</span>${esc(a.values[s.label] || "（未回答）")}</div>
          ${s.answer ? `<div class="model"><span class="k">解答例</span>${esc(s.answer)}</div>` : ""}
          ${s.explain ? `<div class="explain">${esc(s.explain)}</div>` : ""}
          <div class="grade">${[["1", "○"], ["0.5", "△"], ["0", "×"]].map(([val, l]) => `<button data-l="${esc(s.label)}" data-v="${val}" aria-pressed="${v === +val}">${l}</button>`).join("")}</div>
        </div>`;
      }).join("")}
      <div class="row"><button class="btn" id="record">この結果を記録</button><button class="btn ghost" id="retry">解き直す</button></div>`;
    app.querySelectorAll(".grade button").forEach((b) => b.addEventListener("click", () => {
      const l = b.dataset.l, val = +b.dataset.v;
      if (a.grades[l] === val) delete a.grades[l]; else a.grades[l] = val;
      save(); const y = window.scrollY; viewCheck(p); window.scrollTo(0, y);
    }));
    $("#record").addEventListener("click", () => {
      const s = scoreOf(p);
      if (!s.graded) return toast("○△×をつけてから記録してください");
      store.history.push({ pid: p.pid, title: `${p.sub} ${p.title}`, date: Date.now(), score: s.got, total: s.total, sec: elapsedSec(p.pid) });
      const t = tState(p.pid); t.elapsed = 0; t.startedAt = null;
      save(); paintTimer(); toast("記録しました");
    });
    $("#retry").addEventListener("click", () => {
      a.values = {}; a.grades = {}; const t = tState(p.pid); t.elapsed = 0; t.startedAt = null;
      save(); location.hash = `#/s/${encodeURIComponent(p.pid)}/q`;
    });
    bindZoom();
  }

  // ---------- 拡大表示 ----------
  const zoom = $("#zoom"), zoomInner = $("#zoomInner");
  function bindZoom() {
    app.querySelectorAll("[data-zoom]").forEach((img) => img.addEventListener("click", () => {
      zoomInner.innerHTML = `<img src="${esc(img.getAttribute("src"))}" alt="">`;
      zoom.hidden = false; document.body.style.overflow = "hidden";
    }));
  }
  const closeZoom = () => { zoom.hidden = true; zoomInner.innerHTML = ""; document.body.style.overflow = ""; };
  $("#zoomClose").addEventListener("click", closeZoom);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !zoom.hidden) closeZoom(); });

  function toast(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:999px;font-size:14px;z-index:60;max-width:90vw";
    document.body.appendChild(t); setTimeout(() => t.remove(), 1800);
  }

  setInterval(paintTimer, 1000);
  load().then(route);
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
