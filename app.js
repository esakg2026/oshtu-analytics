(function () {
  "use strict";
  const OA = window.OA;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (n, d = 0) => Number(n).toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: d });
  const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString("ru-RU");
  function plural(n, one, few, many) {
    n = Math.abs(Math.round(n));
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  const pairs = (n) => `${fmt1(n)} ${Number.isInteger(Math.round(n * 10) / 10) ? plural(n, "пара", "пары", "пар") : "пары"}`;

  const KIND = {
    lecture: { label: "Лекционные", color: "var(--s1)", desc: "больше 60% — лекции" },
    practice: { label: "Практические", color: "var(--s3)", desc: "в основном практические занятия" },
    lab: { label: "Лабораторные", color: "var(--s2)", desc: "от 40% — лабораторные работы" },
    computer: { label: "Компьютерные", color: "var(--s7)", desc: "оценка: информатика, программирование, БД…" },
    mixed: { label: "Смешанные", color: "var(--mixed)", desc: "разные виды занятий" },
    unused: { label: "Не используются", color: "var(--unused)", desc: "нет занятий в расписании" },
  };
  const LTYPE = {
    лк: { label: "Лекции", color: "var(--s1)" },
    пр: { label: "Практические", color: "var(--s3)" },
    лб: { label: "Лабораторные", color: "var(--s2)" },
    се: { label: "Семинары", color: "var(--s7)" },
    "": { label: "Без вида", color: "var(--mixed)" },
  };

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
        const t = setTimeout(() => ctrl.abort(), 30000);
        const r = await fetch(`${base}/rest/v1/rpc/${name}`, {
          method: "POST",
          headers: { apikey: window.APP_CONFIG.SUPABASE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        clearTimeout(t);
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
        $("loading").innerHTML = `<p>Не удалось загрузить данные. Проверь интернет и обнови страницу.</p><button class="btn" onclick="location.reload()">Обновить</button>`;
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

  // ================= отрисовка =================
  function render() {
    const a = state.a;
    const semName = state.meta.semester === 1 ? "весенний семестр" : "осенний семестр";
    const scope = state.building ? `корпус ${buildingName(state.building)}` : "все корпуса";
    const weekName = { both: "среднее за верхнюю и нижнюю недели", top: "верхняя неделя", bottom: "нижняя неделя" }[state.week];
    $("subtitle").textContent = `${scope} · ${semName} · ${weekName}`;
    renderKpis(a);
    renderInsights(a);
    renderDonut("roomKinds", Object.keys(KIND).map((k) => ({ key: k, label: KIND[k].label, desc: KIND[k].desc, color: KIND[k].color, v: a.roomKinds[k] })), "аудиторий", "ауд.");
    renderDonut("lessonTypes", ["лк", "пр", "лб", "се", ""].filter((k) => a.lessonTypes[k] > 0).map((k) => ({ key: k, label: LTYPE[k].label, color: LTYPE[k].color, v: a.lessonTypes[k] })), "пар в неделю", "пар");
    renderHeat(a);
    renderVBars("byDay", a.byDay, OA.DAYS, (i) => OA.DAYS_FULL[i]);
    renderVBars("byPair", a.byPair, OA.PAIRS.map((p) => `${p}-я`), (i) => `${i + 1}-я пара (${OA.PAIR_TIMES[i + 1]})`);
    renderRooms(a);
    renderBuildings(a);
    renderPeople("topTeachers", "teacherDist", a.teachers, "преподавателей");
    renderPeople("topGroups", "groupDist", a.groups, "групп");
    renderBars("topSubjects", a.subjects.slice(0, 15).map((s) => ({ label: s.name, value: s.perWeek, text: fmt1(s.perWeek) })), { color: "var(--s3)" });
    renderFree();
    renderIssues(a);
    const m = state.meta;
    $("footInfo").textContent = `Данные сайта ОшТУ собраны ${ago(m.newest)} (самая старая аудитория — ${ago(m.oldest)}). Обновляются автоматически раз в 6 часов.`;
  }

  function ago(ts) {
    if (!ts) return "—";
    const min = (Date.now() - new Date(ts).getTime()) / 60000;
    if (min < 2) return "только что";
    if (min < 60) return `${Math.round(min)} мин назад`;
    if (min < 48 * 60) return `${Math.round(min / 60)} ч назад`;
    return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  }

  function buildingName(bid) {
    const r = state.flat.rooms.find((x) => x.bid === bid);
    return r ? r.building : "";
  }

  function fillBuildings() {
    const sel = $("fBuilding");
    if (sel.options.length > 1) return;
    const seen = new Map();
    for (const r of state.flat.rooms) if (!seen.has(r.bid)) seen.set(r.bid, { name: r.building, n: 0 });
    for (const r of state.flat.rooms) seen.get(r.bid).n++;
    for (const [bid, b] of [...seen.entries()].sort((x, y) => y[1].n - x[1].n)) {
      const o = document.createElement("option");
      o.value = bid;
      o.textContent = `${/^\d+$/.test(b.name) ? "Корпус " + b.name : b.name} (${b.n})`;
      sel.appendChild(o);
    }
  }

  // ---------- KPI ----------
  function renderKpis(a) {
    const t = a.totals;
    const k = [
      { label: "Аудиторий", value: fmt(t.rooms), sub: `используются ${fmt(t.used)}, пустуют ${fmt(t.unused)}` },
      { label: "Средняя загрузка", value: `${fmt(t.avgLoadUsed)}%`, sub: `используемых; всех — ${fmt(t.avgLoadAll)}%` },
      { label: "Пар в неделю", value: fmt(t.pairsPerWeek), sub: `${fmt(t.subjects)} дисциплин` },
      { label: "Пик", value: `${OA.DAYS[t.peak.day - 1]}, ${t.peak.pair}-я`, sub: `занято ${fmt(t.peakShare)}% аудиторий` },
      { label: "Преподавателей", value: fmt(t.teachers), sub: "ведут аудиторные занятия" },
      { label: "Групп", value: fmt(t.groups), sub: "с занятиями в аудиториях" },
    ];
    $("kpis").innerHTML = k.map((x) => `<div class="kpi"><div class="k-label">${x.label}</div><div class="k-value">${x.value}</div><div class="k-sub">${x.sub}</div></div>`).join("");
  }

  // ---------- выводы ----------
  function renderInsights(a) {
    const t = a.totals;
    const out = [];
    const days = a.byDay.map((v, i) => ({ v, i }));
    const busiestDay = [...days].sort((x, y) => y.v - x.v)[0];
    const satShare = a.byDay[5] / Math.max(1, a.byDay.reduce((s, v) => s + v, 0)) * 100;
    out.push(`Пик занятости — <b>${OA.DAYS_FULL[t.peak.day - 1].toLowerCase()}, ${t.peak.pair}-я пара</b>: заняты <b>${fmt(t.peakShare)}%</b> аудиторий. Самый загруженный день — <b>${OA.DAYS_FULL[busiestDay.i].toLowerCase()}</b>.`);
    if (a.byDay[5] >= 0) out.push(`Суббота почти свободна: на неё приходится лишь <b>${fmt1(satShare)}%</b> пар — это главный резерв аудиторного фонда.`);
    const p6 = a.byPair[5], p4 = Math.max(...a.byPair);
    out.push(`6-я пара (15:50) загружена на <b>${fmt(p6 / p4 * 100)}%</b> от пиковой — вечерние слоты используются слабее.`);
    out.push(`<b>${fmt(t.unused)}</b> из ${fmt(t.rooms)} аудиторий не используются в расписании, а средняя загрузка используемых — <b>${fmt(t.avgLoadUsed)}%</b> (≈${fmt(t.avgLoadUsed * 36 / 100)} из 36 пар в неделю).`);
    const lt = a.lessonTypes, tot = Object.values(lt).reduce((s, v) => s + v, 0) || 1;
    out.push(`Практические занятия — <b>${fmt(lt.пр / tot * 100)}%</b> пар, лекции — <b>${fmt(lt.лк / tot * 100)}%</b>, лабораторные — <b>${fmt(lt.лб / tot * 100)}%</b>.`);
    const top = [...a.rooms].sort((x, y) => y.load - x.load)[0];
    if (top) out.push(`Самая загруженная аудитория — <b>${esc(top.label)}</b> (${fmt(top.load)}%, ${pairs(top.perWeek)} в неделю).`);
    const bigB = a.buildings.filter((b) => b.rooms >= 5).sort((x, y) => y.load - x.load)[0];
    if (bigB && !state.building) out.push(`Плотнее всего загружен корпус <b>${esc(bigB.name)}</b> — ${fmt(bigB.load)}%.`);
    if (t.teacherDouble) out.push(`Найдено <b>${fmt(t.teacherDouble)}</b> ${plural(t.teacherDouble, "случай", "случая", "случаев")}, когда преподаватель стоит в двух аудиториях одновременно — стоит проверить (вкладка «Накладки»).`);
    $("insights").innerHTML = out.map((s) => `<li>${s}</li>`).join("");
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
        data-tip="<b>${esc(x.label)}</b><br>${fmt1(x.v)} ${unitShort} · ${fmt(x.v / total * 100)}%"></circle>`;
      acc += len;
      return seg;
    }).join("");
    const svg = `<svg viewBox="0 0 170 170" role="img" aria-label="${esc(unitLong)}">${segs}
      <text x="85" y="82" text-anchor="middle" font-size="24" font-weight="750" fill="var(--text)">${fmt(total)}</text>
      <text x="85" y="102" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(unitLong)}</text></svg>`;
    const legend = `<div class="legend">${items.map((x) => `<div class="lg" data-tip="<b>${esc(x.label)}</b>${x.desc ? "<br>" + esc(x.desc) : ""}">
      <i style="background:${x.color}"></i><div>${esc(x.label)}${x.desc ? `<small>${esc(x.desc)}</small>` : ""}</div><b>${fmt1(x.v)}</b><span class="p">${fmt(x.v / total * 100)}%</span></div>`).join("")}</div>`;
    $(id).innerHTML = svg + legend;
  }

  // ---------- тепловая карта ----------
  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function heatStep(share) {
    return Math.max(0, Math.min(7, Math.ceil(share / 12.5)));
  }
  function heatText(step) {
    if (isDark()) return step >= 6 ? "#0b0b0b" : "var(--text)";
    return step >= 4 ? "#ffffff" : "var(--text)";
  }

  function renderHeat(a) {
    let html = `<div></div>` + OA.PAIRS.map((p) => `<div class="h-col">${p}-я<small>${OA.PAIR_TIMES[p]}</small></div>`).join("");
    a.heat.forEach((row, d) => {
      html += `<div class="h-row">${OA.DAYS[d]}</div>`;
      row.forEach((c, p) => {
        const s = heatStep(c.share);
        html += `<div class="cell" style="background:var(--q${s});color:${heatText(s)}"
          data-tip="<b>${OA.DAYS_FULL[d]}, ${p + 1}-я пара (${OA.PAIR_TIMES[p + 1]})</b><br>занято ${fmt(c.share)}% аудиторий<br>${fmt1(c.v)} пар">${fmt(c.share)}%</div>`;
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
    el.innerHTML = values.map((v, i) => `<div class="vbar" data-tip="<b>${esc(full(i))}</b><br>${fmt1(v)} пар в неделю">
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
      : `<div class="empty-note">Нет данных</div>`;
  }

  // ---------- аудитории ----------
  function roomTip(r) {
    return `<b>${esc(r.label)}</b> · ${KIND[r.kind].label}<br>загрузка ${fmt(r.load)}% · ${fmt1(r.perWeek)} пар/нед<br>лекц. ${r.lk} · практ. ${r.pr} · лаб. ${r.lb}${r.topSubjects[0] ? "<br>" + esc(r.topSubjects.slice(0, 2).join("; ")) : ""}`;
  }

  function renderRooms(a) {
    const used = a.rooms.filter((r) => r.busy > 0);
    const top = [...used].sort((x, y) => y.load - x.load).slice(0, 12);
    const low = [...used].sort((x, y) => x.load - y.load).slice(0, 12);
    const toRow = (r) => ({ label: r.label, small: KIND[r.kind].label, value: r.load, text: `${fmt(r.load)}%`, room: r.id, color: KIND[r.kind].color, tip: roomTip(r) });
    renderBars("topRooms", top.map(toRow), { max: 100 });
    renderBars("lowRooms", low.map(toRow), { max: 100 });
    const unused = a.rooms.filter((r) => r.busy === 0);
    $("unusedCount").textContent = `${unused.length} аудиторий без занятий`;
    $("unused").innerHTML = unused.length
      ? unused.map((r) => `<span class="chip click" data-room="${r.id}">${esc(r.label)}</span>`).join("")
      : `<div class="empty-note">Все аудитории используются</div>`;
    renderRoomTable();
  }

  function renderRoomTable() {
    const q = $("roomSearch").value.trim().toLowerCase();
    const kind = $("roomKindFilter").value;
    const { key, asc } = state.sort;
    let rows = state.a.rooms.filter((r) => (!kind || r.kind === kind) &&
      (!q || r.label.toLowerCase().includes(q) || r.topSubjects.some((s) => s.toLowerCase().includes(q))));
    rows.sort((x, y) => {
      const a = key === "kind" ? KIND[x.kind].label : x[key], b = key === "kind" ? KIND[y.kind].label : y[key];
      const c = typeof a === "string" ? a.localeCompare(b, "ru", { numeric: true }) : a - b;
      return asc ? c : -c;
    });
    $("roomTable").querySelector("tbody").innerHTML = rows.map((r) => `<tr data-room="${r.id}">
      <td><b>${esc(r.label)}</b></td>
      <td><span class="kind"><i style="background:${KIND[r.kind].color}"></i>${KIND[r.kind].label}</span></td>
      <td class="num"><span class="loadcell"><span class="mini"><i style="width:${r.load}%"></i></span>${fmt(r.load)}%</span></td>
      <td class="num">${fmt1(r.perWeek)}</td><td class="num">${r.lk}</td><td class="num">${r.pr}</td><td class="num">${r.lb}</td>
      <td class="num">${r.groups}</td><td class="num">${r.teachers}</td></tr>`).join("") ||
      `<tr><td colspan="9" class="empty-note">Ничего не найдено</td></tr>`;
    document.querySelectorAll("#roomTable th").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.sort === key);
      th.classList.toggle("asc", th.dataset.sort === key && asc);
    });
  }

  // ---------- корпуса ----------
  function renderBuildings(a) {
    const bs = a.buildings.filter((b) => b.rooms > 0);
    renderBars("buildingBars", [...bs].sort((x, y) => y.load - x.load).map((b) => ({
      label: /^\d+$/.test(b.name) ? `Корпус ${b.name}` : b.name, small: `${b.rooms} ауд.`, value: b.load, text: `${fmt(b.load)}%`,
      tip: `<b>${esc(b.name)}</b><br>${b.rooms} аудиторий, используются ${b.used}<br>${fmt1(b.perWeek)} пар в неделю<br>загрузка ${fmt(b.load)}% (используемых — ${fmt(b.usedLoad)}%)`,
    })), { max: 100 });
    $("buildingTable").querySelector("tbody").innerHTML = bs.map((b) => `<tr data-building="${b.bid}">
      <td><b>${esc(/^\d+$/.test(b.name) ? "Корпус " + b.name : b.name)}</b></td><td class="num">${b.rooms}</td><td class="num">${b.used}</td>
      <td class="num">${fmt1(b.perWeek)}</td><td class="num">${fmt(b.load)}%</td><td class="num">${fmt(b.usedLoad)}%</td></tr>`).join("");
  }

  // ---------- люди ----------
  function renderPeople(topId, distId, list, unit) {
    renderBars(topId, list.slice(0, 15).map((x) => ({ label: x.name, value: x.perWeek, text: fmt1(x.perWeek) })), { color: "var(--s1)" });
    const buckets = [[0, 4, "до 4 пар"], [4, 8, "4–8"], [8, 12, "8–12"], [12, 16, "12–16"], [16, 20, "16–20"], [20, 1e9, "больше 20"]];
    const counts = buckets.map(([lo, hi, label]) => ({ label, value: list.filter((x) => x.perWeek > lo && x.perWeek <= hi).length }));
    const avg = list.reduce((s, x) => s + x.perWeek, 0) / Math.max(1, list.length);
    renderBars(distId, counts.map((c) => ({ label: c.label, value: c.value, text: fmt(c.value), tip: `<b>${c.label} пар в неделю</b><br>${fmt(c.value)} ${unit}` })), { color: "var(--s3)" });
    $(distId).insertAdjacentHTML("beforeend", `<p class="note">В среднем ${fmt1(avg)} пар в неделю. Учитываются только занятия с аудиторией в расписании.</p>`);
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
    $("freeDay").innerHTML = OA.DAYS_FULL.map((d, i) => `<option value="${i + 1}">${d}</option>`).join("");
    $("freePair").innerHTML = OA.PAIRS.map((p) => `<option value="${p}">${p}-я пара · ${OA.PAIR_TIMES[p]}</option>`).join("");
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
    let day = ((now.getDay() + 6) % 7) + 1;
    const mins = now.getHours() * 60 + now.getMinutes();
    const starts = [480, 570, 680, 770, 860, 950];
    let pair = starts.findIndex((s) => mins < s + 80) + 1;
    if (pair === 0 || day === 7) { pair = 1; day = day === 7 ? 1 : Math.min(6, day + 1); }
    free.day = day;
    free.pair = pair;
    free.week = currentWeekType(now);
  }

  function renderFree() {
    if (!state.flat) return;
    $("freeDay").value = free.day;
    $("freePair").value = free.pair;
    document.querySelectorAll("#freeWeek button").forEach((b) => b.classList.toggle("active", b.dataset.v === free.week));
    const list = OA.freeRooms(state.flat, free.day, free.pair, free.week, state.building)
      .filter((r) => state.a.rooms.find((x) => x.id === r.id)?.busy > 0); // только реально используемые (рабочие) аудитории
    const byB = new Map();
    for (const r of list) {
      if (!byB.has(r.building)) byB.set(r.building, []);
      byB.get(r.building).push(r);
    }
    $("freeSummary").textContent = `${OA.DAYS_FULL[free.day - 1]}, ${free.pair}-я пара (${OA.PAIR_TIMES[free.pair]}), ${free.week === "top" ? "верхняя" : "нижняя"} неделя: свободно ${list.length} ${plural(list.length, "учебная аудитория", "учебные аудитории", "учебных аудиторий")}.`;
    $("freeList").innerHTML = [...byB.entries()].sort((x, y) => y[1].length - x[1].length).map(([b, rs]) => `<div class="free-b">
      <h3>${esc(/^\d+$/.test(b) ? "Корпус " + b : b)} · ${rs.length}</h3>
      <div class="chips">${rs.sort((x, y) => x.name.localeCompare(y.name, "ru", { numeric: true })).map((r) => `<span class="chip click" data-room="${r.id}">${esc(r.name)}</span>`).join("")}</div></div>`).join("")
      || `<div class="empty-note">Свободных аудиторий нет</div>`;
  }

  // ---------- накладки ----------
  function renderIssues(a) {
    const wk = (w) => (w === "top" ? "верхняя" : "нижняя");
    $("teacherDouble").innerHTML = a.teacherDouble.length
      ? a.teacherDouble.map((x) => `<div class="issue"><div class="when">${esc(x.teacher)} — ${OA.DAYS_FULL[x.day - 1]}, ${x.pair}-я пара, ${wk(x.week)} неделя</div>
        <div class="what">Аудитории: ${x.rooms.map(esc).join(", ")}</div></div>`).join("")
      : `<div class="empty-note">Не найдено</div>`;
    $("roomConflicts").innerHTML = a.conflicts.length
      ? a.conflicts.map((x) => `<div class="issue"><div class="when">${esc(x.room)} — ${OA.DAYS_FULL[x.day - 1]}, ${x.pair}-я пара, ${wk(x.week)} неделя</div>
        <div class="what">${x.items.map(esc).join("<br>")}</div></div>`).join("")
      : `<div class="empty-note">Не найдено — в одной аудитории одновременно идут только потоки или подгруппы одного занятия.</div>`;
  }

  // ---------- карточка аудитории ----------
  function openRoom(id) {
    const r = state.a.rooms.find((x) => x.id === id) || OA.analyze(state.flat, { week: state.week }).rooms.find((x) => x.id === id);
    if (!r) return;
    $("dTitle").textContent = `Аудитория ${r.label}`;
    $("dSub").textContent = `${KIND[r.kind].label} · ${r.topSubjects.slice(0, 3).join(" · ") || "занятий нет"}`;
    const lessons = state.flat.lessons.filter((l) => l.roomId === id);
    const weeks = state.week === "both" ? ["top", "bottom"] : [state.week];
    let grid = `<div></div>` + OA.PAIRS.map((p) => `<div class="h-col" style="font-size:11px;color:var(--muted);text-align:center">${p}-я</div>`).join("");
    for (let d = 0; d < 6; d++) {
      grid += `<div style="font-size:12px;color:var(--muted);display:flex;align-items:center">${OA.DAYS[d]}</div>`;
      for (let p = 0; p < 6; p++) {
        const n = r.grid[d][p];
        const items = lessons.filter((l) => l.day === d + 1 && l.pair === p + 1 && weeks.includes(l.week));
        const step = n === 0 ? 0 : n >= weeks.length ? 5 : 3;
        const tip = items.length
          ? `<b>${OA.DAYS_FULL[d]}, ${p + 1}-я пара</b><br>` + [...new Set(items.map((l) => `${l.week === "top" ? "В" : "Н"}: ${l.subject} (${l.type}.) · ${l.group} · ${l.teacher}`))].slice(0, 6).map(esc).join("<br>")
          : `<b>${OA.DAYS_FULL[d]}, ${p + 1}-я пара</b><br>свободна`;
        grid += `<div class="rc" style="background:var(--q${step});color:${heatText(step)}" data-tip="${esc(tip)}">${n === 0 ? "" : weeks.length === 2 ? (n === 2 ? "В+Н" : items[0]?.week === "top" ? "В" : "Н") : "●"}</div>`;
      }
    }
    $("dBody").innerHTML = `<div class="dstats">
        <div><b>${fmt(r.load)}%</b><span>загрузка</span></div>
        <div><b>${fmt1(r.perWeek)}</b><span>пар в неделю</span></div>
        <div><b>${r.groups}</b><span>групп</span></div>
        <div><b>${r.teachers}</b><span>преподавателей</span></div>
      </div>
      <div class="room-grid">${grid}</div>
      <p class="note">В — верхняя неделя, Н — нижняя. Наведи на клетку, чтобы увидеть занятие. Лекций ${r.lk}, практических ${r.pr}, лабораторных ${r.lb} (пар за выбранные недели).</p>`;
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
      const t = e.target.closest("[data-tip]");
      if (!t) return tip.classList.remove("show");
      tip.innerHTML = t.getAttribute("data-tip");
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
  initFree();
  load(false);
  if ("serviceWorker" in navigator && location.protocol.startsWith("http") && location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
