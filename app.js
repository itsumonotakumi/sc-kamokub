/* SC科目Bドリル — 依存なしのSPA
   data/catalog.json   過去問（ビルド時にIPAのPDFから生成）
   data/notes/<id>.json 設問ごとの問題文・解答例・解説・関連語（手書きの学習データ）
   data/glossary.json  用語集
   data/original.json  オリジナル演習 */
(() => {
  "use strict";
  const KEY = "scb:v1";
  const $ = (s, el = document) => el.querySelector(s);
  const app = $("#app");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const countChars = (s) => Array.from(String(s || "").replace(/\s/g, "")).length;
  const enc = encodeURIComponent;

  // ---------- 保存 ----------
  const blank = () => ({ answers: {}, history: [], timers: {} });
  let store = blank();
  try { store = Object.assign(store, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (_) { /* メモリだけで動かす */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (_) { /* noop */ } };
  const ans = (pid) => {
    const a = (store.answers[pid] ||= {});
    a.values ||= {}; a.grades ||= {}; a.custom ||= []; a.revealed ||= {}; a.idx ||= 0;
    return a;
  };
  const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch (_) { return null; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch (_) { /* noop */ } };

  // ---------- データ ----------
  const problems = new Map();
  let catalog = { exams: [] }, original = { problems: [] }, glossary = {};
  const targetMinutes = (id) => (/_pm1$/.test(id) ? 45 : /_pm2$/.test(id) ? 120 : 75);

  async function load() {
    const get = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    [catalog, original, glossary] = await Promise.all([get("data/catalog.json"), get("data/original.json"), get("data/glossary.json")]);
    catalog ||= { exams: [] }; original ||= { problems: [] }; glossary ||= {};
    const notes = await Promise.all(catalog.exams.map((ex) => get(`data/notes/${ex.id}.json`)));
    catalog.exams.forEach((ex, i) => {
      const nt = notes[i] || {};
      for (const q of ex.questions) {
        const n = nt[String(q.no)];
        const slots = n?.slots?.length ? n.slots : q.slots?.length ? q.slots : [{ label: "解答メモ", prompt: "", limit: null }];
        problems.set(`p:${ex.id}:${q.no}`, {
          pid: `p:${ex.id}:${q.no}`, kind: "past", exam: ex, no: q.no,
          title: `問${q.no} ${q.theme || ""}`.trim(), theme: q.theme, sub: ex.label,
          pages: q.pages, ansPages: q.ansPages, answerText: q.answerText, commentText: q.commentText,
          cite: q.cite, slots, summary: n?.summary || "", hasNotes: !!n?.slots?.length,
          minutes: targetMinutes(ex.id),
        });
      }
    });
    for (const p of original.problems) {
      problems.set(`o:${p.id}`, {
        pid: `o:${p.id}`, kind: "orig", title: p.title, theme: p.theme, sub: `オリジナル演習｜${p.theme}`,
        body: p.body, slots: p.slots, summary: p.summary || "", hasNotes: true, minutes: p.minutes || 30,
      });
    }
  }

  // ---------- 採点 ----------
  const slotsOf = (p) => [...p.slots, ...ans(p.pid).custom.map((label) => ({ label, prompt: "", limit: null, custom: true }))];
  function scoreOf(p) {
    const a = ans(p.pid), slots = slotsOf(p);
    let got = 0, graded = 0;
    for (const s of slots) { const v = a.grades[s.label]; if (v !== undefined) { got += v; graded++; } }
    return { got, graded, total: slots.length };
  }
  const lastAttempt = (pid) => [...store.history].reverse().find((h) => h.pid === pid);
  const badgeClass = (r) => (r >= 0.7 ? "good" : r >= 0.5 ? "mid" : "bad");
  const pct = (h) => Math.round((h.score / h.total) * 100);

  // ---------- タイマー ----------
  let currentPid = null;
  const timerBtn = $("#timer"), timerText = $("#timerText");
  const tState = (pid) => (store.timers[pid] ||= { elapsed: 0, startedAt: null });
  const elapsedSec = (pid) => { const t = tState(pid); return Math.floor(t.elapsed + (t.startedAt ? (Date.now() - t.startedAt) / 1000 : 0)); };
  const fmt = (sec) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  function paintTimer() {
    if (!currentPid) return;
    const p = problems.get(currentPid), sec = elapsedSec(currentPid), t = tState(currentPid);
    timerText.textContent = `${t.startedAt ? "⏸" : "▶"} ${fmt(sec)} / ${p.minutes}分`;
    timerBtn.classList.toggle("running", !!t.startedAt);
    timerBtn.classList.toggle("over", sec > p.minutes * 60);
  }
  timerBtn.addEventListener("click", () => {
    const t = tState(currentPid);
    if (t.startedAt) { t.elapsed += (Date.now() - t.startedAt) / 1000; t.startedAt = null; } else t.startedAt = Date.now();
    save(); paintTimer();
  });
  const resetTimer = (pid) => { const t = tState(pid); t.elapsed = 0; t.startedAt = null; };

  // ---------- ルーティング ----------
  const tabbar = $("#tabbar"), backBtn = $("#backBtn"), titleEl = $("#title");
  backBtn.addEventListener("click", () => { location.hash = "#/?tab=" + (ssGet("homeTab") || "past"); });

  function route() {
    closeSheet();
    const h = location.hash.slice(1) || "/";
    const m = h.match(/^\/s\/([^/]+)\/(q|w|r)$/);
    window.scrollTo(0, 0);
    if (m && problems.has(decodeURIComponent(m[1]))) return renderProblem(problems.get(decodeURIComponent(m[1])), m[2]);
    const tab = (h.match(/tab=(\w+)/) || [])[1] || ssGet("homeTab") || (catalog.exams.length ? "past" : "orig");
    renderHome(tab, decodeURIComponent((h.match(/q=([^&]*)/) || [])[1] || ""));
  }
  window.addEventListener("hashchange", route);

  // ---------- ホーム ----------
  function renderHome(tab, query) {
    ssSet("homeTab", tab);
    currentPid = null; timerBtn.hidden = true; backBtn.hidden = true; tabbar.hidden = true;
    titleEl.textContent = "SC科目Bドリル";
    const done = new Set(store.history.map((h) => h.pid)).size;
    const avg = store.history.length ? Math.round(store.history.reduce((s, h) => s + h.score / h.total, 0) / store.history.length * 100) : null;
    const slotCount = [...problems.values()].filter((p) => p.kind === "past").reduce((s, p) => s + p.slots.length, 0);

    let list = "";
    if (tab === "past") {
      if (!catalog.exams.length) list = `<div class="notice"><b>過去問データがまだありません。</b><br>GitHub Actionsのビルドが終わると表示されます。</div>`;
      for (const ex of catalog.exams) {
        list += `<div class="group-title">${esc(ex.label)}</div>`;
        for (const q of ex.questions) list += cardHTML(problems.get(`p:${ex.id}:${q.no}`), `問${q.no}`);
      }
    } else if (tab === "orig") {
      list += `<p class="cite">${esc(original.note || "")}</p>`;
      original.problems.forEach((p, i) => { list += cardHTML(problems.get(`o:${p.id}`), `O${i + 1}`); });
    } else if (tab === "terms") {
      list = glossaryHTML(query);
    } else {
      list = historyHTML();
    }

    app.innerHTML = `
      <section class="hero">
        <h1>情報処理安全確保支援士<br>科目B 過去問ドリル</h1>
        <p>設問を1つずつ解く → すぐに解答例と解説 → ○△×で自己採点</p>
        <div class="stats">
          <div class="stat"><b>${slotCount}</b><span>過去問の設問数</span></div>
          <div class="stat"><b>${done}</b><span>解いた問題</span></div>
          <div class="stat"><b>${avg ?? "–"}${avg !== null ? '<small style="font-size:13px">%</small>' : ""}</b><span>平均自己採点</span></div>
        </div>
      </section>
      <div class="seg" role="tablist">
        ${[["past", "過去問"], ["orig", "オリジナル"], ["terms", "用語集"], ["hist", "履歴"]].map(([k, l]) => `<button aria-pressed="${tab === k}" data-tab="${k}">${l}</button>`).join("")}
      </div>
      ${list}
      <p class="footer">過去問題・解答例・採点講評の著作権はIPA（情報処理推進機構）にあります。各問題に出典を表示しています。<br>解説・関連語はヤマネックスによる独自のもので、IPAの公式見解ではありません。<br>©2026 YAMANEX Inc.</p>`;
    app.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { location.hash = "#/?tab=" + b.dataset.tab; }));
    if (tab === "hist") bindSettings();
    if (tab === "terms") bindGlossary();
  }

  function cardHTML(p, no) {
    const last = lastAttempt(p.pid), a = ans(p.pid);
    const answered = Object.keys(a.revealed).length;
    const badge = last ? `<span class="badge ${badgeClass(last.score / last.total)}">${pct(last)}%</span>`
      : answered ? `<span class="badge">${answered}/${p.slots.length}</span>` : "";
    const name = p.kind === "past" ? (p.theme || "（テーマ名なし）") : p.title;
    const sub = `設問 ${p.slots.length}・目安 ${p.minutes}分${p.kind === "past" && !p.hasNotes ? "・解説準備中" : ""}`;
    return `<a class="card" href="#/s/${enc(p.pid)}/w"><div class="no">${no}</div><div class="body"><div class="t">${esc(name)}</div><div class="s">${sub}</div></div>${badge}</a>`;
  }

  // ---------- 用語集 ----------
  const termKeys = () => Object.keys(glossary).sort((a, b) => a.localeCompare(b, "ja"));
  function termUses(term) {
    const out = [];
    for (const p of problems.values()) for (const s of p.slots) if (s.terms?.includes(term)) out.push({ p, s });
    return out;
  }
  function glossaryHTML(query) {
    const q = (query || "").toLowerCase();
    const keys = termKeys().filter((k) => !q || k.toLowerCase().includes(q) || (glossary[k].read || "").includes(q) || (glossary[k].desc || "").toLowerCase().includes(q));
    return `<input class="search" id="termSearch" type="search" placeholder="用語を検索（例：CSP、SPF）" value="${esc(query)}">
      <p class="cite">${keys.length}語。タップで解説と、その用語が出る設問を表示します。</p>
      ${keys.map((k) => `<button class="term-row" data-term="${esc(k)}"><b>${esc(k)}</b>${glossary[k].read ? `<span>${esc(glossary[k].read)}</span>` : ""}<small>${esc((glossary[k].desc || "").slice(0, 46))}…</small></button>`).join("") || '<div class="empty">見つかりませんでした</div>'}`;
  }
  function bindGlossary() {
    const s = $("#termSearch");
    let t;
    s.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => { history.replaceState(null, "", "#/?tab=terms&q=" + enc(s.value)); const pos = s.selectionStart; renderHome("terms", s.value); const n = $("#termSearch"); n.focus(); n.setSelectionRange(pos, pos); }, 250);
    });
    app.querySelectorAll("[data-term]").forEach((b) => b.addEventListener("click", () => openTerm(b.dataset.term)));
  }

  // ---------- 下から出るシート ----------
  const sheet = $("#sheet"), sheetBody = $("#sheetBody");
  function openSheet(html) {
    sheetBody.innerHTML = html; sheet.hidden = false; document.body.style.overflow = "hidden";
    sheetBody.scrollTop = 0;
    sheetBody.querySelectorAll("[data-term]").forEach((b) => b.addEventListener("click", () => openTerm(b.dataset.term)));
    sheetBody.querySelectorAll("[data-zoom]").forEach(bindZoomOne);
  }
  function closeSheet() { sheet.hidden = true; sheetBody.innerHTML = ""; document.body.style.overflow = ""; }
  $("#sheetClose").addEventListener("click", closeSheet);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });

  function openTerm(term) {
    const g = glossary[term];
    const uses = termUses(term).slice(0, 12);
    openSheet(`<div class="sheet-head"><h3>${esc(term)}</h3>${g?.read ? `<p class="read">${esc(g.read)}</p>` : ""}</div>
      <p class="term-desc">${esc(g?.desc || "この用語の解説はまだありません。")}</p>
      ${g?.see?.length ? `<div class="chips">${g.see.map((t) => `<button class="chip" data-term="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : ""}
      ${uses.length ? `<div class="group-title">この用語が出る設問</div>${uses.map(({ p, s }) => `<a class="use-row" href="#/s/${enc(p.pid)}/w" data-goto="${esc(p.pid)}" data-label="${esc(s.label)}"><b>${esc(p.kind === "past" ? `${p.sub.replace("（旧形式）", "")} 問${p.no}` : p.title)}</b><span>${esc(s.label)}</span></a>`).join("")}` : ""}`);
    sheetBody.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", () => {
      const p = problems.get(a.dataset.goto), i = slotsOf(p).findIndex((s) => s.label === a.dataset.label);
      if (i >= 0) { ans(p.pid).idx = i; save(); }
    }));
  }

  // ---------- 履歴・設定 ----------
  function historyHTML() {
    const rows = [...store.history].reverse().slice(0, 100).map((h) => {
      const p = problems.get(h.pid);
      return `<a class="hist" href="#/s/${enc(h.pid)}/r"><div class="body"><div>${esc(p ? (p.kind === "past" ? `${p.sub} ${p.title}` : p.title) : h.title)}</div><div class="s">${new Date(h.date).toLocaleString("ja-JP")}・${fmt(h.sec || 0)}</div></div><span class="badge ${badgeClass(h.score / h.total)}">${h.score}/${h.total}</span></a>`;
    }).join("");
    // 苦手な関連語（×・△が付いた設問の用語）
    const weak = {};
    for (const p of problems.values()) {
      const a = store.answers[p.pid]; if (!a?.grades) continue;
      for (const s of p.slots) if (a.grades[s.label] !== undefined && a.grades[s.label] < 1) for (const t of s.terms || []) weak[t] = (weak[t] || 0) + 1;
    }
    const weakTerms = Object.entries(weak).sort((x, y) => y[1] - x[1]).slice(0, 16);
    return `${weakTerms.length ? `<div class="group-title">復習したい用語（△×が付いた設問から）</div><div class="chips">${weakTerms.map(([t, n]) => `<button class="chip" data-term="${esc(t)}">${esc(t)} <small>${n}</small></button>`).join("")}</div>` : ""}
      <div class="group-title">解答履歴</div>${rows || '<div class="empty">まだ記録がありません</div>'}
      <div class="group-title">データ</div>
      <div class="settings">
        <button class="btn ghost block" id="exportBtn">学習データを書き出す（JSON）</button>
        <label class="btn ghost block">学習データを読み込む<input type="file" id="importFile" accept="application/json" hidden></label>
        <button class="btn ghost block" id="resetBtn" style="color:var(--ng)">学習データをすべて消す</button>
      </div>
      <p class="cite">学習データはこの端末のブラウザ内にだけ保存されます。別の端末で続けるときは書き出し→読み込みを使ってください。</p>`;
  }
  function bindSettings() {
    app.querySelectorAll("[data-term]").forEach((b) => b.addEventListener("click", () => openTerm(b.dataset.term)));
    $("#exportBtn").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(store, null, 1)], { type: "application/json" }));
      a.download = `sc-kamokub-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    });
    $("#importFile").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const d = JSON.parse(await f.text()); if (!d.answers) throw 0; store = Object.assign(blank(), d); save(); route(); }
      catch (_) { e.target.value = ""; toast("読み込めませんでした（形式が違います）"); }
    });
    let armed = false;
    $("#resetBtn").addEventListener("click", (e) => {
      if (!armed) { armed = true; e.target.textContent = "もう一度押すと消去します"; return; }
      store = blank(); save(); route();
    });
  }

  // ---------- 問題画面 ----------
  const TABS = [
    ["q", "問題文", '<path d="M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'],
    ["w", "設問を解く", '<path d="M4 20h4L19 9l-4-4L4 16z M13 7l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'],
    ["r", "結果", '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'],
  ];
  const go = (p, tab) => { location.hash = `#/s/${enc(p.pid)}/${tab}`; };

  function renderProblem(p, tab) {
    currentPid = p.pid;
    backBtn.hidden = false; timerBtn.hidden = false; tabbar.hidden = false;
    titleEl.textContent = p.kind === "past" ? `${p.exam.label.replace("（旧形式）", "")} 問${p.no}` : p.title;
    paintTimer();
    tabbar.innerHTML = TABS.map(([k, l, icon]) => `<button role="tab" aria-selected="${k === tab}" data-k="${k}"><svg viewBox="0 0 24 24">${icon}</svg>${l}</button>`).join("");
    tabbar.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => go(p, b.dataset.k)));
    if (tab === "q") viewQuestion(p);
    else if (tab === "w") viewWork(p);
    else viewResult(p);
  }

  const headHTML = (p) => `<div class="hero" style="margin-bottom:10px"><h1 style="font-size:19px">${esc(p.title)}</h1><p>${esc(p.sub)}</p></div>
    ${p.summary ? `<div class="summary"><b>この問で問われること</b>${esc(p.summary)}</div>` : ""}`;

  function questionBodyHTML(p) {
    if (p.kind === "orig") return `<div class="prose">${p.body.replace(/<table/g, '<div class="table-wrap"><table').replace(/<\/table>/g, "</table></div>")}</div>`;
    return `<p class="zoom-hint">ページをタップすると拡大表示（ピンチで拡大縮小）</p>
      <div class="pages">${p.pages.map((src, i) => `<img src="${esc(src)}" alt="問題 ${i + 1}ページ目" loading="${i < 2 ? "eager" : "lazy"}" data-zoom>`).join("")}</div>
      <p class="cite">${esc(p.cite)}<br><a href="${esc(p.exam.links.qs)}" target="_blank" rel="noopener">IPA公式の問題冊子PDF</a></p>`;
  }

  function viewQuestion(p) {
    app.innerHTML = `${headHTML(p)}${questionBodyHTML(p)}
      <button class="btn block" id="goWork">設問を解きはじめる →</button>
      <p class="cite" style="text-align:center">右上のタイマーをタップで計測開始・一時停止（目安 ${p.minutes}分）</p>`;
    $("#goWork").addEventListener("click", () => go(p, "w"));
    app.querySelectorAll("[data-zoom]").forEach(bindZoomOne);
  }

  // 1設問ずつ解く
  function viewWork(p) {
    const a = ans(p.pid), slots = slotsOf(p);
    if (a.idx >= slots.length) a.idx = 0;
    const i = a.idx, s = slots[i], val = a.values[s.label] || "", shown = !!a.revealed[s.label], g = a.grades[s.label];
    const dots = slots.map((x, k) => {
      const v = a.grades[x.label];
      const cls = v === 1 ? "ok" : v === 0.5 ? "mid" : v === 0 ? "ng" : a.revealed[x.label] ? "seen" : "";
      return `<button class="dot ${cls} ${k === i ? "cur" : ""}" data-i="${k}" aria-label="${esc(x.label)}"></button>`;
    }).join("");
    const modelHTML = s.answer
      ? `<div class="model"><span class="k">解答例${p.kind === "past" ? "（IPA）" : ""}</span>${esc(s.answer)}</div>`
      : p.kind === "past" ? `<details class="box" open><summary>IPA解答例（この問の全設問）</summary><div class="inner"><pre class="answer">${esc(p.answerText)}</pre></div></details>` : "";
    const termsHTML = s.terms?.length ? `<div class="k-title">関連語</div><div class="chips">${s.terms.map((t) => `<button class="chip ${glossary[t] ? "" : "nodef"}" data-term="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : "";

    app.innerHTML = `
      <div class="progress"><span>${esc(p.kind === "past" ? `問${p.no}` : p.title)}・設問 <b>${i + 1}</b> / ${slots.length}</span><button class="link" id="openQ">📄 問題文</button></div>
      <div class="dots">${dots}</div>
      <section class="qcard">
        <div class="slot-head"><span class="slot-label">${esc(s.label)}</span>${s.limit ? `<span class="slot-limit">${s.limit}字以内</span>` : ""}</div>
        ${s.prompt ? `<p class="qtext">${esc(s.prompt)}</p>` : `<p class="qtext muted">問題文の「設問」を見て答えてください。</p>`}
        <textarea id="answer" rows="3" placeholder="解答を入力（わからなければ空のままでOK）">${esc(val)}</textarea>
        <div class="count" id="cnt"></div>
        ${shown ? "" : `<button class="btn block" id="reveal">解答して解説を見る</button>`}
      </section>
      ${shown ? `
      <section class="explain-card" id="explain">
        <div class="yours"><span class="k">あなたの解答</span>${esc(val || "（未回答）")}</div>
        ${modelHTML}
        ${s.explain ? `<div class="k-title">解説</div><p class="explain-text">${esc(s.explain)}</p>` : p.kind === "past" ? `<p class="cite">この設問の解説は準備中です。</p>` : ""}
        ${termsHTML}
        <div class="k-title">自己採点</div>
        <div class="grade">${[["1", "○ 正解"], ["0.5", "△ 部分点"], ["0", "× 不正解"]].map(([v, l]) => `<button data-v="${v}" aria-pressed="${g === +v}">${l}</button>`).join("")}</div>
      </section>` : ""}
      <div class="row nav">
        <button class="btn ghost" id="prev" ${i === 0 ? "disabled" : ""}>← 前へ</button>
        ${i < slots.length - 1 ? `<button class="btn ${shown ? "" : "ghost"}" id="next">${shown ? "次の設問へ →" : "スキップ →"}</button>` : `<button class="btn" id="finish">結果を見る</button>`}
      </div>
      ${p.kind === "past" ? `<p class="cite">${esc(p.cite)}（問題文・解答例。設問文は読みやすく整えるため一部改変）。解説・関連語は独自のものです。</p>` : ""}`;

    const ta = $("#answer"), cnt = $("#cnt");
    const upd = () => {
      const n = countChars(ta.value);
      cnt.textContent = s.limit ? `${n} / ${s.limit}字` : `${n}字`;
      cnt.classList.toggle("over", !!s.limit && n > s.limit);
      ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px";
    };
    upd();
    ta.addEventListener("input", () => { a.values[s.label] = ta.value; save(); upd(); });
    const move = (k) => { a.idx = k; save(); viewWork(p); window.scrollTo(0, 0); };
    $("#reveal")?.addEventListener("click", () => {
      a.values[s.label] = ta.value; a.revealed[s.label] = true;
      save(); viewWork(p);
      $("#explain")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    app.querySelectorAll(".grade button").forEach((b) => b.addEventListener("click", () => {
      const v = +b.dataset.v;
      if (a.grades[s.label] === v) delete a.grades[s.label]; else a.grades[s.label] = v;
      save();
      app.querySelectorAll(".grade button").forEach((x) => x.setAttribute("aria-pressed", String(a.grades[s.label] === +x.dataset.v)));
      const dot = app.querySelector(`.dot[data-i="${i}"]`);
      dot.className = `dot cur ${a.grades[s.label] === 1 ? "ok" : a.grades[s.label] === 0.5 ? "mid" : a.grades[s.label] === 0 ? "ng" : "seen"}`;
    }));
    app.querySelectorAll(".dot").forEach((d) => d.addEventListener("click", () => move(+d.dataset.i)));
    $("#prev").addEventListener("click", () => i > 0 && move(i - 1));
    $("#next")?.addEventListener("click", () => move(i + 1));
    $("#finish")?.addEventListener("click", () => go(p, "r"));
    app.querySelectorAll("[data-term]").forEach((b) => b.addEventListener("click", () => openTerm(b.dataset.term)));
    $("#openQ").addEventListener("click", () => openSheet(`<div class="sheet-head"><h3>${esc(p.title)}</h3></div>${questionBodyHTML(p)}`));
  }

  function viewResult(p) {
    const a = ans(p.pid), slots = slotsOf(p), sc = scoreOf(p);
    const ref = p.kind === "past" ? `
      <details class="box"><summary>IPA解答例・出題趣旨（全文）</summary><div class="inner">${p.answerText ? `<pre class="answer">${esc(p.answerText)}</pre>` : ""}
        <div class="pages" style="margin-top:10px">${p.ansPages.map((src) => `<img src="${esc(src)}" alt="解答例" loading="lazy" data-zoom>`).join("")}</div></div></details>
      ${p.commentText ? `<details class="box"><summary>IPA採点講評</summary><div class="inner"><pre class="answer">${esc(p.commentText)}</pre></div></details>` : ""}
      <p class="cite">${esc(p.cite)}（解答例・採点講評）<br><a href="${esc(p.exam.links.ans)}" target="_blank" rel="noopener">解答例PDF</a>${p.exam.links.cmnt ? ` ・ <a href="${esc(p.exam.links.cmnt)}" target="_blank" rel="noopener">採点講評PDF</a>` : ""}</p>` : "";
    app.innerHTML = `
      <div class="score"><b>${sc.got}</b> / ${sc.total}<span>採点済み ${sc.graded}/${sc.total}・経過 ${fmt(elapsedSec(p.pid))}</span></div>
      <div class="row"><button class="btn" id="record">この結果を記録</button><button class="btn ghost" id="retry">最初から解き直す</button></div>
      <div class="group-title">設問ごとの結果</div>
      ${slots.map((s, k) => {
        const v = a.grades[s.label];
        const mark = v === 1 ? '<span class="mk ok">○</span>' : v === 0.5 ? '<span class="mk mid">△</span>' : v === 0 ? '<span class="mk ng">×</span>' : '<span class="mk">–</span>';
        return `<button class="res-row" data-i="${k}">${mark}<span class="body"><b>${esc(s.label)}</b><small>${esc(a.values[s.label] || "（未回答）")}</small></span></button>`;
      }).join("")}
      ${ref}`;
    app.querySelectorAll(".res-row").forEach((b) => b.addEventListener("click", () => { a.idx = +b.dataset.i; save(); go(p, "w"); }));
    $("#record").addEventListener("click", () => {
      const s = scoreOf(p);
      if (!s.graded) return toast("○△×をつけてから記録してください");
      store.history.push({ pid: p.pid, title: `${p.sub} ${p.title}`, date: Date.now(), score: s.got, total: s.total, sec: elapsedSec(p.pid) });
      resetTimer(p.pid); save(); paintTimer(); toast("記録しました");
    });
    $("#retry").addEventListener("click", () => {
      Object.assign(a, { values: {}, grades: {}, revealed: {}, idx: 0 }); resetTimer(p.pid); save(); go(p, "w");
    });
    app.querySelectorAll("[data-zoom]").forEach(bindZoomOne);
  }

  // ---------- 拡大表示 ----------
  const zoom = $("#zoom"), zoomInner = $("#zoomInner");
  function bindZoomOne(img) {
    img.addEventListener("click", () => {
      zoomInner.innerHTML = `<img src="${esc(img.getAttribute("src"))}" alt="">`;
      zoom.hidden = false; document.body.style.overflow = "hidden";
    });
  }
  const closeZoom = () => { zoom.hidden = true; zoomInner.innerHTML = ""; if (sheet.hidden) document.body.style.overflow = ""; };
  $("#zoomClose").addEventListener("click", closeZoom);
  document.addEventListener("keydown", (e) => { if (e.key !== "Escape") return; if (!zoom.hidden) closeZoom(); else closeSheet(); });

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 1800);
  }

  setInterval(paintTimer, 1000);
  load().then(route);
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
