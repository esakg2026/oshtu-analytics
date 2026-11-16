(function () {
  "use strict";
  const OA = window.OA;
  const I = window.I18N;
  const t = I.t;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n, d = 0) => Number(n).toLocaleString(I.locale(), { maximumFractionDigits: d, minimumFractionDigits: d });
  const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString(I.locale());
  const pl = (n, key) => I.plural(n, t(key));

  // переведённые подписи
  const day = (i) => t("days")[i];
  const dayFull = (i) => t("daysFull")[i];
  const pairShort = (n) => t("pairShort", { n });
  const pairFull = (n) => t("pairFull", { n });
  const bName = (name) => (/^\d+$/.test(name) ? t("buildingN", { n: name }) : name);

  const KIND_COLORS = { lecture: "var(--s1)", practice: "var(--s3)", lab: "var(--s2)", computer: "var(--s7)", mixed: "var(--mixed)", unused: "var(--unused)" };
  const kindLabel = (k) => t("kind")[k][0];
  const kindDesc = (k) => t("kind")[k][1];
  const LTYPE_COLORS = { лк: "var(--s1)", пр: "var(--s3)", лб: "var(--s2)", се: "var(--s7)", "": "var(--mixed)" };

  const state = { flat: null, meta: null, building: null, week: "both", a: null, sort: { key: "load", asc: false } };

  // ================= данные =================
  function apiBases() {
    const { SUPABASE_URL, PROXY } = window.APP_CONFIG;
    const deployed = /^https?:$/.test(location.protocol) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return [...(deployed ? [`${location.origin}/sb`] : []), PROXY, SUPABASE_URL];
  }

  async function rpc(name, body) {
    let last;
    for (const base of apiBases()) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const r = await fetch(`${base}/rest/v1/rpc/${name}`, {
          method: "POST",
          headers: { apikey: window.APP_CONFIG.SUPABASE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!r.ok) throw new Error("HTTP " + r.status);
        return await r.json();
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  const CACHE_KEY = "oa.dataset.v1";
  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { return null; }
  }
  function writeCache(ds) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(ds)); } catch {}
  }

  async function load(force) {
    const cached = !force && readCache();
    if (cached) use(cached, true);
    try {
      const ds = await rpc("oshtu_room_dataset", {});
      writeCache(ds);
      use(ds, false);
    } catch (e) {
      if (!state.flat) {
        $("loading").innerHTML = `<p>${esc(t("loadError"))}</p><button class="btn" onclick="location.reload()">${esc(t("reload"))}</button>`;
      }
    }
  }

  function use(ds, fromCache) {
    state.flat = OA.flatten(ds);
    const ats = (ds.rooms || []).map((r) => r.at).filter(Boolean).sort();
    state.meta = { semester: ds.semester, generated: ds.generated_at, oldest: ats[0], newest: ats[ats.length - 1], fromCache };
    fillBuildings();
    recompute();
    $("loading").hidden = true;
    $("content").hidden = false;
  }

  function recompute() {
    state.a = OA.analyze(state.flat, { building: state.building, week: state.week });
    render();
  }

  // ================= язык =================
  function fillStaticSelects() {
    const kf = $("roomKindFilter");
    const cur = kf.value;
    kf.innerHTML = `<option value="">${esc(t("allTypes"))}</option>` +
      Object.keys(KIND_COLORS).map((k) => `<option value="${k}">${esc(k === "computer" ? t("kindFilter.computer") : kindLabel(k))}</option>`).join("");
    kf.value = cur;
    $("freeDay").innerHTML = t("daysFull").map((d, i) => `<option value="${i + 1}">${esc(d)}</option>`).join("");
    $("freePair").innerHTML = OA.PAIRS.map((p) => `<option value="${p}">${esc(pairFull(p))} · ${OA.PAIR_TIMES[p]}</option>`).join("");
  }

  function applyLang(lang) {
    if (lang) I.setLang(lang);
    else I.apply();
    document.querySelectorAll("#fLang button").forEach((b) => b.classList.toggle("active", b.dataset.lang === I.lang));
    fillStaticSelects();
    if (state.flat) {
      const sel = $("fBuilding");
      const cur = sel.value;
      while (sel.options.length > 1) sel.remove(1);
      sel.options[0].textContent = t("allBuildings");
      fillBuildings();
      sel.value = cur;
      render();
    }
  }

  // ================= отрисовка =================
  function render() {
    const a = state.a;
    const semName = state.meta.semester === 1 ? t("semSpring") : t("semAutumn");
    const scope = state.building ? t("scopeOne", { name: buildingName(state.building) }) : t("scopeAll");
    $("subtitle").textContent = `${scope} · ${semName} · ${t("weekScope")[state.week]}`;
    renderKpis(a);
    renderInsights(a);
    renderDonut("roomKinds", Object.keys(KIND_COLORS).map((k) => ({ label: kindLabel(k), desc: kindDesc(k), color: KIND_COLORS[k], v: a.roomKinds[k] })), t("donutRooms"), t("donutRoomsShort"));
    renderDonut("lessonTypes", ["лк", "пр", "лб", "се", ""].filter((k) => a.lessonTypes[k] > 0).map((k) => ({ label: t("ltype")[k], color: LTYPE_COLORS[k], v: a.lessonTypes[k] })), t("donutPairs"), t("donutPairsShort"));
    renderHeat(a);
    renderVBars("byDay", a.byDay, t("days"), (i) => dayFull(i));
    renderVBars("byPair", a.byPair, OA.PAIRS.map(pairShort), (i) => `${pairFull(i + 1)} (${OA.PAIR_TIMES[i + 1]})`);
    renderRooms(a);
    renderBuildings(a);
    renderPeople("topTeachers", "teacherDist", a.teachers, t("howManyTeachers"));
    renderPeople("topGroups", "groupDist", a.groups, t("howManyGroups"));
    renderBars("topSubjects", a.subjects.slice(0, 15).map((s) => ({ label: s.name, value: s.perWeek, text: fmt1(s.perWeek) })), { color: "var(--s3)" });
    renderFree();
    renderIssues(a);
    const m = state.meta;
    $("footInfo").textContent = t("footInfo", { newest: ago(m.newest), oldest: ago(m.oldest) });
  }

  function ago(ts) {
    if (!ts) return "—";
    const min = (Date.now() - new Date(ts).getTime()) / 60000;
    if (min < 2) return t("ago.now");
    if (min < 60) return t("ago.min", { n: Math.round(min) });
    if (min < 48 * 60) return t("ago.hour", { n: Math.round(min / 60) });
    return new Date(ts).toLocaleDateString(I.locale(), { day: "numeric", month: "long" });
  }

  function buildingName(bid) {
    const r = state.flat.rooms.find((x) => x.bid === bid);
    return r ? r.building : "";
  }

  function fillBuildings() {
    const sel = $("fBuilding");
    if (sel.options.length > 1) return;
    const seen = new Map();
    for (const r of state.flat.rooms) {
      if (!seen.has(r.bid)) seen.set(r.bid, { name: r.building, n: 0 });
      seen.get(r.bid).n++;
    }
    for (const [bid, b] of [...seen.entries()].sort((x, y) => y[1].n - x[1].n)) {
      const o = document.createElement("option");
      o.value = bid;
      o.textContent = `${bName(b.name)} (${b.n})`;
      sel.appendChild(o);
    }
  }

  // ---------- KPI ----------
  function renderKpis(a) {
    const s = a.totals;
    const k = [
      { label: t("kpi.rooms"), value: fmt(s.rooms), sub: t("kpi.roomsSub", { used: fmt(s.used), unused: fmt(s.unused) }) },
      { label: t("kpi.load"), value: `${fmt(s.avgLoadUsed)}%`, sub: t("kpi.loadSub", { all: fmt(s.avgLoadAll) }) },
      { label: t("kpi.pairs"), value: fmt(s.pairsPerWeek), sub: t("kpi.pairsSub", { n: fmt(s.subjects) }) },
      { label: t("kpi.peak"), value: `${day(s.peak.day - 1)}, ${pairShort(s.peak.pair)}`, sub: t("kpi.peakSub", { n: fmt(s.peakShare) }) },
      { label: t("kpi.teachers"), value: fmt(s.teachers), sub: t("kpi.teachersSub") },
      { label: t("kpi.groups"), value: fmt(s.groups), sub: t("kpi.groupsSub") },
    ];
    $("kpis").innerHTML = k.map((x) => `<div class="kpi"><div class="k-label">${esc(x.label)}</div><div class="k-value">${esc(x.value)}</div><div class="k-sub">${esc(x.sub)}</div></div>`).join("");
  }

  // ---------- выводы ----------
  function renderInsights(a) {
    const s = a.totals;
    const out = [];
    const lower = (x) => (I.lang === "en" ? x : x.toLowerCase());
    const busiest = a.byDay.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v)[0];
    const totalPairs = a.byDay.reduce((acc, v) => acc + v, 0) || 1;
    out.push(t("ins.peak", { day: lower(dayFull(s.peak.day - 1)), pair: pairFull(s.peak.pair), share: fmt(s.peakShare), busiest: lower(dayFull(busiest.i)) }));
    out.push(t("ins.saturday", { share: fmt1((a.byDay[5] / totalPairs) * 100) }));
    out.push(t("ins.lastPair", { share: fmt((a.byPair[5] / Math.max(...a.byPair, 1)) * 100) }));
    out.push(t("ins.unused", { unused: fmt(s.unused), rooms: fmt(s.rooms), load: fmt(s.avgLoadUsed), slots: fmt((s.avgLoadUsed * 36) / 100) }));
    const lt = a.lessonTypes, tot = Object.values(lt).reduce((acc, v) => acc + v, 0) || 1;
    out.push(t("ins.types", { pr: fmt((lt.пр / tot) * 100), lk: fmt((lt.лк / tot) * 100), lb: fmt((lt.лб / tot) * 100) }));
    const top = [...a.rooms].sort((x, y) => y.load - x.load)[0];
    if (top) out.push(t("ins.topRoom", { room: esc(top.label), load: fmt(top.load), pairs: `${fmt1(top.perWeek)} ${pl(top.perWeek, "pairWord")}` }));
    const bigB = a.buildings.filter((b) => b.rooms >= 5).sort((x, y) => y.load - x.load)[0];
    if (bigB && !state.building) out.push(t("ins.topBuilding", { name: esc(bName(bigB.name)), load: fmt(bigB.load) }));
    if (s.teacherDouble) out.push(t("ins.doubles", { n: fmt(s.teacherDouble), cases: pl(s.teacherDouble, "cases") }));
    $("insights").innerHTML = out.map((x) => `<li>${x}</li>`).join("");
  }

  // ---------- кольцевая диаграмма ----------
  function renderDonut(id, items, unitLong, unitShort) {
    const total = items.reduce((s, x) => s + x.v, 0) || 1;
    const R = 62, C = 2 * Math.PI * R, GAP = 2.5;
    let acc = 0;
    const segs = items.filter((x) => x.v > 0).map((x) => {
      const len = (x.v / total) * C;
      const seg = `<circle r="${R}" cx="85" cy="85" fill="none" stroke="${x.color}" stroke-width="24"
        stroke-dasharray="${Math.max(0, len - GAP)} ${C}" stroke-dashoffset="${-acc}" transform="rotate(-90 85 85)"
        data-tip="${esc(`<b>${esc(x.label)}</b><br>${fmt1(x.v)} ${esc(unitShort)} · ${fmt((x.v / total) * 100)}%`)}"></circle>`;
      acc += len;
      return seg;
    }).join("");
    const svg = `<svg viewBox="0 0 170 170" role="img" aria-label="${esc(unitLong)}">${segs}
      <text x="85" y="82" text-anchor="middle" font-size="24" font-weight="750" fill="var(--text)">${fmt(total)}</text>
      <text x="85" y="102" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(unitLong)}</text></svg>`;
    const legend = `<div class="legend">${items.map((x) => `<div class="lg" data-tip="${esc(`<b>${esc(x.label)}</b>${x.desc ? "<br>" + esc(x.desc) : ""}`)}">
      <i style="background:${x.color}"></i><div>${esc(x.label)}${x.desc ? `<small>${esc(x.desc)}</small>` : ""}</div><b>${fmt1(x.v)}</b><span class="p">${fmt((x.v / total) * 100)}%</span></div>`).join("")}</div>`;
    $(id).innerHTML = svg + legend;
  }

  // ---------- тепловая карта ----------
  function isDark() {
    const th = document.documentElement.dataset.theme;
    return th === "dark" || (th !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  const heatStep = (share) => Math.max(0, Math.min(7, Math.ceil(share / 12.5)));
  function heatText(step) {
    if (isDark()) return step >= 6 ? "#0b0b0b" : "var(--text)";
    return step >= 4 ? "#ffffff" : "var(--text)";
  }

  function renderHeat(a) {
    let html = `<div></div>` + OA.PAIRS.map((p) => `<div class="h-col">${esc(pairShort(p))}<small>${OA.PAIR_TIMES[p]}</small></div>`).join("");
    a.heat.forEach((row, d) => {
      html += `<div class="h-row">${esc(day(d))}</div>`;
      row.forEach((c, p) => {
        const s = heatStep(c.share);
        const tip = `<b>${esc(dayFull(d))}, ${esc(pairFull(p + 1))} (${OA.PAIR_TIMES[p + 1]})</b><br>${esc(t("heatTip", { share: fmt(c.share) }))}<br>${esc(t("pairsCount", { n: fmt1(c.v) }))}`;
        html += `<div class="cell" style="background:var(--q${s});color:${heatText(s)}" data-tip="${esc(tip)}">${fmt(c.share)}%</div>`;
      });
    });
    $("heatmap").innerHTML = html;
    $("heatLegend").innerHTML = `<span>0%</span>${[0, 1, 2, 3, 4, 5, 6, 7].map((s) => `<i style="background:var(--q${s})"></i>`).join("")}<span>100%</span>`;
  }

  // ---------- столбцы ----------
  function renderVBars(id, values, labels, full) {
    const max = Math.max(...values, 1);
    const el = $(id);
    el.classList.add("vertical");
    el.innerHTML = values.map((v, i) => `<div class="vbar" data-tip="${esc(`<b>${esc(full(i))}</b><br>${fmt1(v)} ${esc(t("pairsPerWeek"))}`)}">
      <span class="vval">${fmt(v)}</span><div class="vfill" style="height:${(v / max) * 82}%"></div></div>`).join("");
    let lab = el.nextElementSibling;
    if (!lab || !lab.classList.contains("vlabels")) {
      lab = document.createElement("div");
      lab.className = "vlabels";
      el.after(lab);
    }
    lab.innerHTML = labels.map((l) => `<span>${esc(l)}</span>`).join("");
  }

  function renderBars(id, rows, opts = {}) {
    const max = opts.max || Math.max(...rows.map((r) => r.value), 1);
    $(id).innerHTML = rows.length
      ? rows.map((r) => `<div class="bar${r.room ? " click" : ""}" ${r.room ? `data-room="${r.room}"` : ""} data-tip="${esc(r.tip || `<b>${esc(r.label)}</b><br>${r.text}`)}">
        <span class="lbl">${esc(r.label)}${r.small ? ` <small>${esc(r.small)}</small>` : ""}</span>
        <span class="track"><span class="fill" style="width:${(r.value / max) * 100}%;background:${r.color || opts.color || "var(--s1)"}"></span></span>
        <span class="val">${r.text}</span></div>`).join("")
      : `<div class="empty-note">${esc(t("noData"))}</div>`;
  }

  // ---------- аудитории ----------
  function roomTip(r) {
    return `<b>${esc(r.label)}</b> · ${esc(kindLabel(r.kind))}<br>${esc(t("roomTip", { load: fmt(r.load), pairs: fmt1(r.perWeek) }))}<br>${esc(t("roomTipTypes", { lk: r.lk, pr: r.pr, lb: r.lb }))}${r.topSubjects[0] ? "<br>" + esc(r.topSubjects.slice(0, 2).join("; ")) : ""}`;
  }

  function renderRooms(a) {
    const used = a.rooms.filter((r) => r.busy > 0);
    const top = [...used].sort((x, y) => y.load - x.load).slice(0, 12);
    const low = [...used].sort((x, y) => x.load - y.load).slice(0, 12);
    const toRow = (r) => ({ label: r.label, small: kindLabel(r.kind), value: r.load, text: `${fmt(r.load)}%`, room: r.id, color: KIND_COLORS[r.kind], tip: roomTip(r) });
    renderBars("topRooms", top.map(toRow), { max: 100 });
    renderBars("lowRooms", low.map(toRow), { max: 100 });
    const unused = a.rooms.filter((r) => r.busy === 0);
    $("unusedCount").textContent = t("unusedCount", { n: unused.length });
    $("unused").innerHTML = unused.length
      ? unused.map((r) => `<span class="chip click" data-room="${r.id}">${esc(r.label)}</span>`).join("")
      : `<div class="empty-note">${esc(t("allUsed"))}</div>`;
    renderRoomTable();
  }

  function renderRoomTable() {
    const q = $("roomSearch").value.trim().toLowerCase();
    const kind = $("roomKindFilter").value;
    const { key, asc } = state.sort;
    const rows = state.a.rooms.filter((r) => (!kind || r.kind === kind) &&
      (!q || r.label.toLowerCase().includes(q) || r.topSubjects.some((s) => s.toLowerCase().includes(q))));
    rows.sort((x, y) => {
      const a = key === "kind" ? kindLabel(x.kind) : x[key], b = key === "kind" ? kindLabel(y.kind) : y[key];
      const c = typeof a === "string" ? a.localeCompare(b, I.lang, { numeric: true }) : a - b;
      return asc ? c : -c;
    });
    $("roomTable").querySelector("tbody").innerHTML = rows.map((r) => `<tr data-room="${r.id}">
      <td><b>${esc(r.label)}</b></td>
      <td><span class="kind"><i style="background:${KIND_COLORS[r.kind]}"></i>${esc(kindLabel(r.kind))}</span></td>
      <td class="num"><span class="loadcell"><span class="mini"><i style="width:${r.load}%"></i></span>${fmt(r.load)}%</span></td>
      <td class="num">${fmt1(r.perWeek)}</td><td class="num">${r.lk}</td><td class="num">${r.pr}</td><td class="num">${r.lb}</td>
      <td class="num">${r.groups}</td><td class="num">${r.teachers}</td></tr>`).join("") ||
      `<tr><td colspan="9" class="empty-note">${esc(t("nothingFound"))}</td></tr>`;
    document.querySelectorAll("#roomTable th").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.sort === key);
      th.classList.toggle("asc", th.dataset.sort === key && asc);
    });
  }

  // ---------- корпуса ----------
  function renderBuildings(a) {
    const bs = a.buildings.filter((b) => b.rooms > 0);
    renderBars("buildingBars", [...bs].sort((x, y) => y.load - x.load).map((b) => ({
      label: bName(b.name), small: t("roomsShort", { n: b.rooms }), value: b.load, text: `${fmt(b.load)}%`,
      tip: `<b>${esc(bName(b.name))}</b><br>${t("buildingTip", { rooms: b.rooms, used: b.used, pairs: fmt1(b.perWeek), load: fmt(b.load), usedLoad: fmt(b.usedLoad) })}`,
    })), { max: 100 });
    $("buildingTable").querySelector("tbody").innerHTML = bs.map((b) => `<tr data-building="${b.bid}">
      <td><b>${esc(bName(b.name))}</b></td><td class="num">${b.rooms}</td><td class="num">${b.used}</td>
      <td class="num">${fmt1(b.perWeek)}</td><td class="num">${fmt(b.load)}%</td><td class="num">${fmt(b.usedLoad)}%</td></tr>`).join("");
  }

  // ---------- люди ----------
  function renderPeople(topId, distId, list, unit) {
    renderBars(topId, list.slice(0, 15).map((x) => ({ label: x.name, value: x.perWeek, text: fmt1(x.perWeek) })), { color: "var(--s1)" });
    const labels = t("dist");
    const buckets = [[0, 4], [4, 8], [8, 12], [12, 16], [16, 20], [20, 1e9]];
    const counts = buckets.map(([lo, hi], i) => ({ label: labels[i], value: list.filter((x) => x.perWeek > lo && x.perWeek <= hi).length }));
    const avg = list.reduce((s, x) => s + x.perWeek, 0) / Math.max(1, list.length);
    renderBars(distId, counts.map((c) => ({ label: c.label, value: c.value, text: fmt(c.value), tip: `<b>${esc(t("distTip", { label: c.label }))}</b><br>${fmt(c.value)} · ${esc(unit)}` })), { color: "var(--s3)" });
    $(distId).insertAdjacentHTML("beforeend", `<p class="note">${esc(t("distAvg", { avg: fmt1(avg) }))}</p>`);
  }

  // ---------- свободные аудитории ----------
  const WEEK_ANCHOR = new Date(2026, 10, 9); // верхняя неделя
  function currentWeekType(d = new Date()) {
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const w = Math.round((mon - WEEK_ANCHOR) / 6048e5);
    return ((w % 2) + 2) % 2 === 0 ? "top" : "bottom";
  }
  const free = { day: 1, pair: 1, week: "top" };

  function initFree() {
    setFreeNow();
    $("freeDay").onchange = () => { free.day = +$("freeDay").value; renderFree(); };
    $("freePair").onchange = () => { free.pair = +$("freePair").value; renderFree(); };
    $("freeWeek").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      free.week = b.dataset.v;
      renderFree();
    };
    $("freeNow").onclick = () => { setFreeNow(); renderFree(); };
  }

  function setFreeNow() {
    const now = new Date();
    let d = ((now.getDay() + 6) % 7) + 1;
    const mins = now.getHours() * 60 + now.getMinutes();
    const starts = [480, 570, 680, 770, 860, 950];
    let p = starts.findIndex((s) => mins < s + 80) + 1;
    if (p === 0 || d === 7) { p = 1; d = d === 7 ? 1 : Math.min(6, d + 1); }
    free.day = d;
    free.pair = p;
    free.week = currentWeekType(now);
  }

  function renderFree() {
    if (!state.flat) return;
    $("freeDay").value = free.day;
    $("freePair").value = free.pair;
    document.querySelectorAll("#freeWeek button").forEach((b) => b.classList.toggle("active", b.dataset.v === free.week));
    const list = OA.freeRooms(state.flat, free.day, free.pair, free.week, state.building)
      .filter((r) => state.a.rooms.find((x) => x.id === r.id)?.busy > 0); // только рабочие аудитории
    const byB = new Map();
    for (const r of list) {
      if (!byB.has(r.building)) byB.set(r.building, []);
      byB.get(r.building).push(r);
    }
    $("freeSummary").textContent = t("freeSummary", {
      day: dayFull(free.day - 1), pair: pairFull(free.pair), time: OA.PAIR_TIMES[free.pair],
      week: t("week")[free.week], n: list.length, rooms: pl(list.length, "freeRooms"),
    });
    $("freeList").innerHTML = [...byB.entries()].sort((x, y) => y[1].length - x[1].length).map(([b, rs]) => `<div class="free-b">
      <h3>${esc(bName(b))} · ${rs.length}</h3>
      <div class="chips">${rs.sort((x, y) => x.name.localeCompare(y.name, "ru", { numeric: true })).map((r) => `<span class="chip click" data-room="${r.id}">${esc(r.name)}</span>`).join("")}</div></div>`).join("")
      || `<div class="empty-note">${esc(t("noFree"))}</div>`;
  }

  // ---------- накладки ----------
  function renderIssues(a) {
    const when = (who, x) => t("issueWhen", { who, day: dayFull(x.day - 1), pair: pairFull(x.pair), week: t("week")[x.week] });
    $("teacherDouble").innerHTML = a.teacherDouble.length
      ? a.teacherDouble.map((x) => `<div class="issue"><div class="when">${esc(when(x.teacher, x))}</div>
        <div class="what">${esc(t("issueRooms", { list: x.rooms.join(", ") }))}</div></div>`).join("")
      : `<div class="empty-note">${esc(t("notFound"))}</div>`;
    $("roomConflicts").innerHTML = a.conflicts.length
      ? a.conflicts.map((x) => `<div class="issue"><div class="when">${esc(when(x.room, x))}</div>
        <div class="what">${x.items.map(esc).join("<br>")}</div></div>`).join("")
      : `<div class="empty-note">${esc(t("noConflicts"))}</div>`;
  }

  // ---------- карточка аудитории ----------
  function openRoom(id) {
    const r = state.a.rooms.find((x) => x.id === id) || OA.analyze(state.flat, { week: state.week }).rooms.find((x) => x.id === id);
    if (!r) return;
    $("dTitle").textContent = t("roomTitle", { name: r.label });
    $("dSub").textContent = `${kindLabel(r.kind)} · ${r.topSubjects.slice(0, 3).join(" · ") || t("noLessons")}`;
    const lessons = state.flat.lessons.filter((l) => l.roomId === id);
    const weeks = state.week === "both" ? ["top", "bottom"] : [state.week];
    const L = t("weekLetter");
    let grid = `<div></div>` + OA.PAIRS.map((p) => `<div class="h-col" style="font-size:11px;color:var(--muted);text-align:center">${esc(pairShort(p))}</div>`).join("");
    for (let d = 0; d < 6; d++) {
      grid += `<div style="font-size:12px;color:var(--muted);display:flex;align-items:center">${esc(day(d))}</div>`;
      for (let p = 0; p < 6; p++) {
        const n = r.grid[d][p];
        const items = lessons.filter((l) => l.day === d + 1 && l.pair === p + 1 && weeks.includes(l.week));
        const step = n === 0 ? 0 : n >= weeks.length ? 5 : 3;
        const head = `<b>${esc(dayFull(d))}, ${esc(pairFull(p + 1))}</b><br>`;
        const tip = items.length
          ? head + [...new Set(items.map((l) => `${L[l.week]}: ${l.subject} (${l.type}.) · ${l.group} · ${l.teacher}`))].slice(0, 6).map(esc).join("<br>")
          : head + esc(t("cellFree"));
        const mark = n === 0 ? "" : weeks.length === 2 ? (n === 2 ? `${L.top}+${L.bottom}` : L[items[0]?.week || "top"]) : "●";
        grid += `<div class="rc" style="background:var(--q${step});color:${heatText(step)}" data-tip="${esc(tip)}">${esc(mark)}</div>`;
      }
    }
    $("dBody").innerHTML = `<div class="dstats">
        <div><b>${fmt(r.load)}%</b><span>${esc(t("dLoad"))}</span></div>
        <div><b>${fmt1(r.perWeek)}</b><span>${esc(t("dPairs"))}</span></div>
        <div><b>${r.groups}</b><span>${esc(t("dGroups"))}</span></div>
        <div><b>${r.teachers}</b><span>${esc(t("dTeachers"))}</span></div>
      </div>
      <div class="room-grid">${grid}</div>
      <p class="note">${esc(t("dNote", { lk: r.lk, pr: r.pr, lb: r.lb }))}</p>`;
    const dlg = $("roomDialog");
    if (dlg.showModal) dlg.showModal();
  }

  // ================= события =================
  function bind() {
    $("fBuilding").onchange = () => {
      state.building = $("fBuilding").value ? +$("fBuilding").value : null;
      recompute();
    };
    $("fWeek").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      state.week = b.dataset.v;
      document.querySelectorAll("#fWeek button").forEach((x) => x.classList.toggle("active", x === b));
      recompute();
    };
    $("fLang").onclick = (e) => {
      const b = e.target.closest("button[data-lang]");
      if (b) applyLang(b.dataset.lang);
    };
    $("refresh").onclick = () => { $("refresh").textContent = "…"; load(true).finally(() => ($("refresh").textContent = "⟳")); };
    $("roomSearch").oninput = renderRoomTable;
    $("roomKindFilter").onchange = renderRoomTable;
    $("roomTable").querySelector("thead").onclick = (e) => {
      const th = e.target.closest("th");
      if (!th) return;
      const key = th.dataset.sort;
      state.sort = { key, asc: state.sort.key === key ? !state.sort.asc : key === "label" || key === "kind" };
      renderRoomTable();
    };
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-room]");
      if (el) return openRoom(+el.dataset.room);
      const b = e.target.closest("[data-building]");
      if (b) {
        $("fBuilding").value = b.dataset.building;
        $("fBuilding").onchange();
        location.hash = "#overview";
      }
    });
    $("roomDialog").addEventListener("click", (e) => {
      if (e.target === $("roomDialog") || e.target.closest("[data-close]")) $("roomDialog").close();
    });

    // подсказки
    const tip = $("tip");
    document.addEventListener("pointerover", (e) => {
      const el = e.target.closest("[data-tip]");
      if (!el) return tip.classList.remove("show");
      tip.innerHTML = el.getAttribute("data-tip");
      tip.classList.add("show");
    });
    document.addEventListener("pointermove", (e) => {
      if (!tip.classList.contains("show")) return;
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let x = e.clientX + 14, y = e.clientY + 14;
      if (x + w > innerWidth - 8) x = e.clientX - w - 14;
      if (y + h > innerHeight - 8) y = e.clientY - h - 14;
      tip.style.left = `${Math.max(8, x)}px`;
      tip.style.top = `${Math.max(8, y)}px`;
    });
    document.addEventListener("pointerout", (e) => {
      if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest("[data-tip]")) tip.classList.remove("show");
    });

    // активная вкладка при прокрутке
    const links = [...document.querySelectorAll("#nav a")];
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id));
    }, { rootMargin: "-40% 0px -55% 0px" });
    document.querySelectorAll(".sec").forEach((s) => io.observe(s));

    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.a && render());
  }

  bind();
  applyLang();
  initFree();
  load(false);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http") && location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
