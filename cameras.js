// «Наблюдение с камер»: вход администратора, подсчёт людей (TensorFlow.js COCO-SSD прямо в браузере),
// привязка к паре по расписанию ОшТУ, настройка камер и аналитика «план vs факт».
// Видео не отправляется и не сохраняется — в базу уходят только поминутные числа.
(function () {
  "use strict";
  const I = window.I18N;
  const t = I.t;
  const OA = window.OA;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString(I.locale());

  const TIMES = { 1: ["08:00", "09:20"], 2: ["09:30", "10:50"], 3: ["11:20", "12:40"], 4: ["12:50", "14:10"], 5: ["14:20", "15:40"], 6: ["15:50", "17:10"] };
  const WEEK_ANCHOR = new Date(2026, 10, 9); // неделя 9–14 ноября 2026 — верхняя
  const HELD_THRESHOLD = 3; // пара «состоялась», если в среднем ≥ 3 человек
  const DETECT_EVERY_MS = 1500;
  const AUTH_KEY = "oa.admin";
  const QUEUE_KEY = "oa.camQueue";

  const S = {
    token: null, login: null, cams: [], flat: null, byRoom: new Map(),
    model: null, modelLoading: null, running: false, timer: null, stream: null, cam: null,
    recent: [], minuteKey: null, minuteSamples: [], sent: 0, period: "today",
  };

  // ================= хранилище =================
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  // ================= API =================
  function apiBases() {
    const { SUPABASE_URL, PROXY } = window.APP_CONFIG;
    const deployed = /^https?:$/.test(location.protocol) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return [...(deployed ? [`${location.origin}/sb`] : []), PROXY, SUPABASE_URL];
  }

  class ApiError extends Error {}

  // Повтор через другой адрес — только при сетевой ошибке; ответ сервера (неверный пароль и т. п.) не повторяем.
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
        const text = await r.text();
        const data = text ? JSON.parse(text) : null;
        if (!r.ok) {
          if (r.status >= 500) throw new Error("HTTP " + r.status);
          throw new ApiError((data && data.message) || "HTTP " + r.status);
        }
        return data;
      } catch (e) {
        if (e instanceof ApiError) {
          if (/вход администратора/i.test(e.message)) logoutLocal();
          throw e;
        }
        last = e;
      }
    }
    throw last;
  }

  // ================= вход =================
  function showLogin() {
    $("appView").hidden = true;
    $("loginView").hidden = false;
    $("lLogin").focus();
  }

  function logoutLocal() {
    stopWatch();
    S.token = null;
    store.del(AUTH_KEY);
    showLogin();
  }

  async function boot() {
    const saved = store.get(AUTH_KEY);
    if (saved && saved.token && new Date(saved.expires_at) > new Date()) {
      try {
        const r = await rpc("oshtu_admin_check", { p_token: saved.token });
        if (r && r.ok) return enter(saved.token, r.login);
      } catch (e) {
        // нет связи — пускаем с сохранённой сессией, сервер всё равно проверит токен
        if (!(e instanceof ApiError)) return enter(saved.token, saved.login);
      }
    }
    store.del(AUTH_KEY);
    showLogin();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("loginBtn");
    btn.disabled = true;
    $("loginErr").hidden = true;
    try {
      const r = await rpc("oshtu_admin_login", { p_login: $("lLogin").value.trim(), p_password: $("lPass").value });
      store.set(AUTH_KEY, r);
      $("lPass").value = "";
      enter(r.token, r.login);
    } catch (err) {
      $("loginErr").textContent = err instanceof ApiError ? (/попыток/.test(err.message) ? err.message : t("cam.badLogin")) : String(err.message || err);
      $("loginErr").hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  async function enter(token, login) {
    S.token = token;
    S.login = login;
    $("who").textContent = login;
    $("loginView").hidden = true;
    $("appView").hidden = false;
    await loadDataset();
    await loadCams();
    setTab(location.hash.replace("#", "") || "watch");
    preloadModel();
  }

  $("logout").onclick = async () => {
    try { await rpc("oshtu_admin_logout", { p_token: S.token }); } catch {}
    logoutLocal();
  };

  // ================= данные ОшТУ =================
  async function loadDataset() {
    let ds = store.get("oa.dataset.v1");
    if (!ds) {
      try {
        ds = await rpc("oshtu_room_dataset", {});
        store.set("oa.dataset.v1", ds);
      } catch { ds = { rooms: [] }; }
    } else {
      rpc("oshtu_room_dataset", {}).then((fresh) => { store.set("oa.dataset.v1", fresh); useDataset(fresh); }).catch(() => {});
    }
    useDataset(ds);
  }

  function useDataset(ds) {
    S.flat = OA.flatten(ds);
    S.byRoom = new Map();
    for (const l of S.flat.lessons) {
      if (!S.byRoom.has(l.roomId)) S.byRoom.set(l.roomId, []);
      S.byRoom.get(l.roomId).push(l);
    }
  }

  const roomById = (id) => (S.flat ? S.flat.rooms.find((r) => r.id === id) : null);
  const toMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

  function weekType(d) {
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const w = Math.round((mon - WEEK_ANCHOR) / 6048e5);
    return ((w % 2) + 2) % 2 === 0 ? "top" : "bottom";
  }

  /** Что по расписанию ОшТУ в этой аудитории в момент d. */
  function scheduleAt(roomId, d) {
    const day = ((d.getDay() + 6) % 7) + 1;
    const m = d.getHours() * 60 + d.getMinutes();
    let pair = null;
    for (const [p, [a, b]] of Object.entries(TIMES)) if (m >= toMin(a) && m < toMin(b)) pair = Number(p);
    const week = weekType(d);
    const lessons = day <= 6 && pair ? (S.byRoom.get(roomId) || []).filter((l) => l.day === day && l.pair === pair && l.week === week) : [];
    return { day, pair, week, lessons };
  }

  // ================= камеры (список) =================
  async function loadCams() {
    S.cams = (await rpc("oshtu_cam_list", { p_token: S.token })) || [];
    fillCamSelect();
    renderSetupTable();
  }

  function fillCamSelect() {
    const sel = $("wCamera");
    const cur = sel.value;
    const cams = S.cams.filter((c) => c.enabled);
    sel.innerHTML = cams.map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(c.room || "")}</option>`).join("");
    if (cams.some((c) => String(c.id) === cur)) sel.value = cur;
    $("wNoCams").hidden = cams.length > 0;
    $("wStart").disabled = cams.length === 0;
    onCamChange();
  }

  function selectedCam() {
    return S.cams.find((c) => String(c.id) === $("wCamera").value) || null;
  }

  function onCamChange() {
    const cam = selectedCam();
    $("wFileBtn").hidden = !cam || cam.source_type !== "file";
    $("wRoom").textContent = cam ? cam.room || "—" : "—";
    updatePanel();
  }
  $("wCamera").onchange = () => { stopWatch(); onCamChange(); };

  // ================= модель =================
  function preloadModel() {
    if (S.model || S.modelLoading) return S.modelLoading;
    $("wModel").textContent = t("cam.modelLoading");
    S.modelLoading = (async () => {
      for (let i = 0; i < 100 && !(window.cocoSsd && window.tf); i++) await new Promise((r) => setTimeout(r, 100));
      if (!window.cocoSsd) throw new Error("model scripts not loaded");
      // облегчённая модель: ~5× меньше и грузится за секунды; на фото аудиторий считает почти так же, как полная
      S.model = await window.cocoSsd.load({ base: "lite_mobilenet_v2" });
      $("wModel").textContent = t("cam.modelReady");
      return S.model;
    })().catch((e) => {
      S.modelLoading = null;
      $("wModel").textContent = String(e.message || e);
      throw e;
    });
    return S.modelLoading;
  }

  // ================= наблюдение =================
  const video = $("wVideo"), img = $("wImg"), canvas = $("wCanvas");

  function showErr(msg) {
    $("wErr").textContent = msg;
    $("wErr").hidden = !msg;
  }

  async function findDevice(label) {
    // названия камер видны только после разрешения
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
    tmp.getTracks().forEach((tr) => tr.stop());
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    return devs.find((d) => d.label === label) || devs.find((d) => label && d.label.includes(label)) || devs[0] || null;
  }

  async function startWatch() {
    const cam = selectedCam();
    if (!cam) return;
    showErr("");
    stopWatch();
    S.cam = cam;
    try {
      await preloadModel();
      if (cam.source_type === "device") {
        const dev = await findDevice(cam.device_label);
        S.stream = await navigator.mediaDevices.getUserMedia({
          video: dev ? { deviceId: { exact: dev.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : true,
        });
        video.srcObject = S.stream;
        await video.play();
        showSource("video");
      } else if (cam.source_type === "url") {
        if (location.protocol === "https:" && /^http:/i.test(cam.source)) throw Object.assign(new Error("mixed"), { cors: true });
        img.crossOrigin = "anonymous";
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(Object.assign(new Error("load"), { cors: true }));
          img.src = cam.source;
        });
        showSource("img");
      } else {
        if (!video.src) {
          $("wFile").click();
          return;
        }
        video.loop = true;
        await video.play();
        showSource("video");
      }
      S.running = true;
      $("wStart").textContent = t("cam.stop");
      $("wEmpty").hidden = true;
      loop();
    } catch (e) {
      stopWatch();
      showErr(e.cors ? t("cam.errCors") : t("cam.errCamera", { e: e.message || e.name || e }));
    }
  }

  function showSource(kind) {
    video.hidden = kind !== "video";
    img.hidden = kind !== "img";
  }

  function stopWatch() {
    S.running = false;
    clearTimeout(S.timer);
    flushMinute(true);
    if (S.stream) S.stream.getTracks().forEach((tr) => tr.stop());
    S.stream = null;
    if (video.srcObject) video.srcObject = null;
    video.pause();
    img.removeAttribute("src");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $("wStart").textContent = t("cam.start");
    $("wEmpty").hidden = false;
    S.recent = [];
  }

  $("wStart").onclick = () => (S.running ? stopWatch() : startWatch());
  $("wFileBtn").onclick = () => $("wFile").click();
  $("wFile").onchange = () => {
    const f = $("wFile").files[0];
    if (!f) return;
    if (video.src) URL.revokeObjectURL(video.src);
    video.srcObject = null;
    video.src = URL.createObjectURL(f);
    startWatch();
  };
  $("wBlur").onchange = () => $("videoBox").classList.toggle("blur", $("wBlur").checked);

  async function loop() {
    if (!S.running) return;
    const src = video.hidden ? img : video;
    const ready = video.hidden ? img.complete && img.naturalWidth : video.readyState >= 2 && video.videoWidth;
    if (ready) {
      try {
        const preds = await S.model.detect(src, 100, 0.4);
        const people = preds.filter((p) => p.class === "person");
        draw(src, people);
        addSample(people.length);
      } catch (e) {
        stopWatch();
        showErr(/tainted|SecurityError|cross-origin/i.test(String(e)) ? t("cam.errCors") : t("cam.errCamera", { e: e.message || e }));
        return;
      }
    }
    S.timer = setTimeout(loop, DETECT_EVERY_MS);
  }

  function draw(src, people) {
    const box = $("videoBox");
    const W = box.clientWidth, H = box.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!$("wBoxes").checked) return;
    const sw = src.videoWidth || src.naturalWidth, sh = src.videoHeight || src.naturalHeight;
    const k = Math.min(W / sw, H / sh), ox = (W - sw * k) / 2, oy = (H - sh * k) / 2;
    ctx.lineWidth = 2;
    ctx.font = "600 12px system-ui, sans-serif";
    people.forEach((p, i) => {
      const [x, y, w, h] = p.bbox;
      ctx.strokeStyle = "#1baf7a";
      ctx.strokeRect(ox + x * k, oy + y * k, w * k, h * k);
      ctx.fillStyle = "#1baf7a";
      const label = `${i + 1} · ${Math.round(p.score * 100)}%`;
      ctx.fillRect(ox + x * k, oy + y * k - 16, ctx.measureText(label).width + 8, 16);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, ox + x * k + 4, oy + y * k - 4);
    });
  }

  // ---------- подсчёт и поминутная отправка ----------
  function addSample(n) {
    S.recent.push(n);
    if (S.recent.length > 3) S.recent.shift();
    const sorted = [...S.recent].sort((a, b) => a - b);
    const shown = sorted[Math.floor(sorted.length / 2)]; // медиана последних 3 кадров — меньше «мигания»
    $("wCount").textContent = shown;
    const now = new Date();
    const key = Math.floor(now.getTime() / 60000);
    if (S.minuteKey !== null && key !== S.minuteKey) flushMinute(false);
    S.minuteKey = key;
    S.minuteSamples.push(n);
    const avg = S.minuteSamples.reduce((s, v) => s + v, 0) / S.minuteSamples.length;
    $("wAvg").textContent = fmt1(avg);
    updatePanel(shown);
  }

  function flushMinute(final) {
    if (!S.minuteSamples.length || !S.cam) { S.minuteSamples = []; return; }
    const samples = S.minuteSamples;
    const ts = new Date(S.minuteKey * 60000);
    S.minuteSamples = [];
    if (S.cam.source_type === "file") return; // проверочное видео в аналитику не попадает
    if (final && samples.length < 5) return; // неполная минута при остановке
    const sc = scheduleAt(S.cam.room_id, ts);
    const l = sc.lessons[0];
    const row = {
      camera_id: S.cam.id, room_id: S.cam.room_id, ts: ts.toISOString(),
      people_avg: Math.round((samples.reduce((s, v) => s + v, 0) / samples.length) * 10) / 10,
      people_max: Math.max(...samples), samples: samples.length,
      day: sc.day, pair: sc.pair, week: sc.week, scheduled: sc.lessons.length > 0,
      subject: l ? l.subject : null, lesson_type: l ? l.type : null,
      group_name: sc.lessons.length ? [...new Set(sc.lessons.map((x) => x.group).filter(Boolean))].join(", ") : null,
      teacher: sc.lessons.length ? [...new Set(sc.lessons.map((x) => x.teacher).filter(Boolean))].join(", ") : null,
    };
    const q = store.get(QUEUE_KEY, []);
    q.push(row);
    store.set(QUEUE_KEY, q.slice(-5000));
    sendQueue();
  }

  async function sendQueue() {
    const q = store.get(QUEUE_KEY, []);
    if (!q.length || !S.token || sendQueue.busy) return renderSendInfo();
    sendQueue.busy = true;
    try {
      const batch = q.slice(0, 500);
      await rpc("oshtu_cam_report", { p_token: S.token, p_rows: batch });
      store.set(QUEUE_KEY, store.get(QUEUE_KEY, []).slice(batch.length));
      S.sent += batch.length;
    } catch {} finally {
      sendQueue.busy = false;
      renderSendInfo();
    }
  }
  setInterval(sendQueue, 60000);
  window.addEventListener("online", sendQueue);

  function renderSendInfo() {
    $("wSent").textContent = t("cam.sent", { n: S.sent });
    const q = store.get(QUEUE_KEY, []).length;
    $("wQueue").textContent = q ? t("cam.queue", { n: q }) : "";
  }

  // ---------- правая панель: расписание и сравнение ----------
  function updatePanel(peopleNow) {
    const cam = selectedCam();
    if (!cam || !S.flat) return;
    const now = new Date();
    const sc = scheduleAt(cam.room_id, now);
    const dayName = t("daysFull")[sc.day - 1] || t("cam.sunday");
    $("wPair").textContent = sc.pair ? `${dayName}, ${t("cam.pairN", { n: sc.pair, from: TIMES[sc.pair][0], to: TIMES[sc.pair][1] })}` : `${dayName} · ${t("cam.breakTime")}`;
    $("wPlan").innerHTML = sc.lessons.length
      ? sc.lessons.slice(0, 4).map((l) => `<div class="lesson"><b>${esc(l.subject)}</b> (${esc(l.type)}.)<small>${esc([l.group, l.teacher].filter(Boolean).join(" · "))} · ${esc(t("week")[sc.week])}</small></div>`).join("")
      : `<span class="muted">${esc(t("cam.noLesson"))}</span>`;
    const m = $("wMatch");
    if (peopleNow == null || !S.running) { m.textContent = ""; m.className = "match"; m.hidden = true; return; }
    m.hidden = false;
    const busy = peopleNow >= HELD_THRESHOLD;
    const planned = sc.lessons.length > 0;
    const key = planned ? (busy ? "ok" : "empty") : busy ? "extra" : "free";
    m.textContent = t("cam.match")[key];
    m.className = "match " + (key === "ok" ? "ok" : key === "free" ? "" : "warn");
  }
  setInterval(() => updatePanel(S.running ? Number($("wCount").textContent) : null), 30000);

  // ================= настройка камер =================
  function renderSetupTable() {
    const tb = $("sTable").querySelector("tbody");
    tb.innerHTML = S.cams.map((c) => `<tr class="${c.enabled ? "" : "off"}">
      <td><b>${esc(c.name)}</b></td><td>${esc(c.room || "")}</td><td>${esc(t("cam.types")[c.source_type])}</td>
      <td>${esc(c.source_type === "url" ? c.source : c.device_label || "")}</td><td>${c.enabled ? "✓" : "—"}</td>
      <td>${c.last_ts ? new Date(c.last_ts).toLocaleString(I.locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : esc(t("cam.never"))}</td>
      <td class="acts"><button class="btn" data-edit="${c.id}">${esc(t("cam.edit"))}</button> <button class="btn" data-del="${c.id}">${esc(t("cam.del"))}</button></td></tr>`).join("") ||
      `<tr><td colspan="7" class="empty-note">${esc(t("cam.noCameras"))}</td></tr>`;
  }

  function fillBuildingsSel(selectedBid) {
    const seen = new Map();
    for (const r of S.flat.rooms) if (!seen.has(r.bid)) seen.set(r.bid, r.building);
    $("fBuildingSel").innerHTML = `<option value="">${esc(t("cam.chooseBuilding"))}</option>` +
      [...seen.entries()].map(([bid, name]) => `<option value="${bid}">${esc(/^\d+$/.test(name) ? t("buildingN", { n: name }) : name)}</option>`).join("");
    if (selectedBid) $("fBuildingSel").value = selectedBid;
  }

  function fillRoomsSel(bid, selected) {
    const rooms = S.flat.rooms.filter((r) => String(r.bid) === String(bid)).sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
    $("fRoom").innerHTML = `<option value="">${esc(t("cam.chooseRoom"))}</option>` + rooms.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
    if (selected) $("fRoom").value = selected;
  }

  async function fillDevices(selectedLabel) {
    const sel = $("fDevice");
    sel.innerHTML = `<option value="">…</option>`;
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      tmp.getTracks().forEach((tr) => tr.stop());
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      sel.innerHTML = devs.map((d, i) => `<option value="${esc(d.label || "Camera " + (i + 1))}">${esc(d.label || "Camera " + (i + 1))}</option>`).join("");
      if (selectedLabel && !devs.some((d) => d.label === selectedLabel)) sel.insertAdjacentHTML("afterbegin", `<option value="${esc(selectedLabel)}">${esc(selectedLabel)}</option>`);
      if (selectedLabel) sel.value = selectedLabel;
    } catch (e) {
      sel.innerHTML = selectedLabel ? `<option value="${esc(selectedLabel)}">${esc(selectedLabel)}</option>` : `<option value="">—</option>`;
      $("fErr").textContent = t("cam.errCamera", { e: e.message || e.name });
      $("fErr").hidden = false;
    }
  }

  function onTypeChange() {
    const type = $("fType").value;
    $("fDeviceWrap").hidden = type !== "device";
    $("fUrlWrap").hidden = type !== "url";
    $("fHint").textContent = type === "device" ? t("cam.deviceHint") : type === "url" ? t("cam.urlHint") : t("cam.fileHint");
    if (type === "device" && !$("fDevice").options.length) fillDevices($("fDevice").dataset.want || "");
  }

  function openForm(cam) {
    $("sForm").hidden = false;
    $("fErr").hidden = true;
    $("fId").value = cam ? cam.id : "";
    $("fName").value = cam ? cam.name : "";
    const room = cam ? roomById(cam.room_id) : null;
    fillBuildingsSel(room ? room.bid : "");
    fillRoomsSel(room ? room.bid : "", cam ? cam.room_id : "");
    $("fType").value = cam ? cam.source_type : "device";
    $("fUrl").value = cam && cam.source_type === "url" ? cam.source : "";
    $("fEnabled").checked = cam ? cam.enabled : true;
    $("fDevice").innerHTML = "";
    $("fDevice").dataset.want = cam ? cam.device_label || "" : "";
    onTypeChange();
    $("sForm").scrollIntoView({ behavior: "smooth", block: "start" });
    $("fName").focus();
  }

  $("sAdd").onclick = () => openForm(null);
  $("fCancel").onclick = () => ($("sForm").hidden = true);
  $("fType").onchange = onTypeChange;
  $("fBuildingSel").onchange = () => fillRoomsSel($("fBuildingSel").value);
  $("sTable").addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-edit]");
    if (ed) return openForm(S.cams.find((c) => String(c.id) === ed.dataset.edit));
    const del = e.target.closest("[data-del]");
    if (del) {
      const cam = S.cams.find((c) => String(c.id) === del.dataset.del);
      if (!cam || !confirm(t("cam.confirmDel", { name: cam.name }))) return;
      try {
        await rpc("oshtu_cam_delete", { p_token: S.token, p_id: cam.id });
        await loadCams();
      } catch (err) { toast(err.message); }
    }
  });

  $("sForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("fErr").hidden = true;
    const type = $("fType").value;
    const cam = {
      id: $("fId").value ? Number($("fId").value) : null,
      name: $("fName").value.trim(),
      room_id: Number($("fRoom").value),
      source_type: type,
      source: type === "url" ? $("fUrl").value.trim() : null,
      device_label: type === "device" ? $("fDevice").value : null,
      enabled: $("fEnabled").checked,
    };
    if (!cam.room_id) { $("fErr").textContent = t("cam.chooseRoom"); $("fErr").hidden = false; return; }
    try {
      await rpc("oshtu_cam_save", { p_token: S.token, p_cam: cam });
      $("sForm").hidden = true;
      toast(t("cam.saved"));
      await loadCams();
    } catch (err) {
      $("fErr").textContent = err.message;
      $("fErr").hidden = false;
    }
  });

  // ================= аналитика: план ОшТУ vs факт =================
  function periodRange() {
    const now = new Date();
    const from = S.period === "today" ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : new Date(now.getTime() - (S.period === "d7" ? 7 : 30) * 864e5);
    return { from, to: new Date(now.getTime() + 60000) };
  }

  async function loadStats() {
    $("aThreshold").textContent = t("cam.threshold", { n: HELD_THRESHOLD });
    const { from, to } = periodRange();
    let rows = [];
    try {
      rows = (await rpc("oshtu_cam_stats", { p_token: S.token, p_from: from.toISOString(), p_to: to.toISOString() })) || [];
    } catch (e) { toast(e.message); }
    renderStats(rows);
  }

  function renderStats(rows) {
    const has = rows.length > 0;
    $("aEmpty").hidden = has;
    $("aCharts").hidden = !has;
    $("aRoomsCard").hidden = !has;
    const label = (rid) => (roomById(rid) || {}).label || String(rid);
    const dayKey = (ts) => new Date(ts).toLocaleDateString(I.locale(), { day: "numeric", month: "short" });

    // пары: аудитория × дата × номер пары
    const pairs = new Map();
    const perRoom = new Map();
    const extra = new Map();
    for (const r of rows) {
      const room = perRoom.get(r.r) || { minutes: 0, planned: 0, held: 0, missed: 0, extra: 0, sum: 0, n: 0, max: 0 };
      room.minutes++;
      room.max = Math.max(room.max, r.m);
      perRoom.set(r.r, room);
      if (r.p) {
        const k = `${r.r}|${dayKey(r.t)}|${r.p}`;
        const p = pairs.get(k) || { room: r.r, date: dayKey(r.t), pair: r.p, minutes: 0, sum: 0, scheduled: false, subject: r.sub, group: r.g };
        p.minutes++;
        p.sum += r.a;
        p.scheduled = p.scheduled || r.s;
        pairs.set(k, p);
      }
      if (!r.s && r.a >= HELD_THRESHOLD) {
        room.extra++;
        const k = `${r.r}|${dayKey(r.t)}`;
        const x = extra.get(k) || { room: r.r, date: dayKey(r.t), min: 0, max: 0 };
        x.min++;
        x.max = Math.max(x.max, r.m);
        extra.set(k, x);
      }
    }

    let planned = 0, held = 0, missed = 0, heldSum = 0;
    const byPair = Array.from({ length: 6 }, () => ({ sum: 0, n: 0 }));
    const missedList = [];
    for (const p of pairs.values()) {
      const avg = p.sum / p.minutes;
      if (p.pair >= 1 && p.pair <= 6) { byPair[p.pair - 1].sum += avg; byPair[p.pair - 1].n++; }
      if (!p.scheduled || p.minutes < 10) continue; // мало наблюдений — не судим
      const room = perRoom.get(p.room);
      planned++; room.planned++;
      if (avg >= HELD_THRESHOLD) { held++; room.held++; heldSum += avg; room.sum += avg; room.n++; }
      else { missed++; room.missed++; missedList.push({ ...p, avg }); }
    }
    const extraMin = [...perRoom.values()].reduce((s, r) => s + r.extra, 0);

    const k = [
      { label: t("cam.k.minutes"), value: rows.length.toLocaleString(I.locale()), sub: t("cam.kUnit.min") },
      { label: t("cam.k.planned"), value: planned, sub: t("cam.kUnit.pairs") },
      { label: t("cam.k.held"), value: held, sub: planned ? `${Math.round((held / planned) * 100)}%` : "" },
      { label: t("cam.k.missed"), value: missed, sub: planned ? `${Math.round((missed / planned) * 100)}%` : "" },
      { label: t("cam.k.extra"), value: extraMin, sub: t("cam.kUnit.min") },
      { label: t("cam.k.avg"), value: held ? fmt1(heldSum / held) : "—", sub: "" },
    ];
    $("aKpis").innerHTML = k.map((x) => `<div class="kpi"><div class="k-label">${esc(x.label)}</div><div class="k-value">${esc(x.value)}</div><div class="k-sub">${esc(x.sub)}</div></div>`).join("");
    if (!has) return;

    const max = Math.max(1, ...byPair.map((b) => (b.n ? b.sum / b.n : 0)));
    $("aByPair").innerHTML = byPair.map((b, i) => {
      const v = b.n ? b.sum / b.n : 0;
      return `<div class="bar"><span class="lbl">${esc(t("pairFull", { n: i + 1 }))} <small>${TIMES[i + 1][0]}</small></span>
        <span class="track"><span class="fill" style="width:${(v / max) * 100}%"></span></span><span class="val">${b.n ? fmt1(v) : "—"}</span></div>`;
    }).join("");

    const ev = [
      ...missedList.slice(-30).reverse().map((p) => `<div class="issue"><div class="when">⚠ ${esc(t("cam.evMissed", { room: label(p.room), date: p.date, pair: t("pairFull", { n: p.pair }), subject: p.subject || "—", group: p.group || "—", n: fmt1(p.avg) }))}</div></div>`),
      ...[...extra.values()].filter((x) => x.min >= 10).map((x) => `<div class="issue"><div class="when">ℹ ${esc(t("cam.evExtra", { room: label(x.room), date: x.date, min: x.min, max: x.max }))}</div></div>`),
    ];
    $("aEvents").innerHTML = ev.join("") || `<div class="empty-note">${esc(t("notFound"))}</div>`;

    $("aRooms").querySelector("tbody").innerHTML = [...perRoom.entries()].sort((a, b) => b[1].minutes - a[1].minutes).map(([rid, r]) => `<tr>
      <td><b>${esc(label(rid))}</b></td><td class="num">${r.minutes}</td><td class="num">${r.planned}</td><td class="num">${r.held}</td>
      <td class="num">${r.missed}</td><td class="num">${r.extra}</td><td class="num">${r.n ? fmt1(r.sum / r.n) : "—"}</td><td class="num">${r.max}</td></tr>`).join("");
  }

  $("aPeriod").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.period = b.dataset.v;
    document.querySelectorAll("#aPeriod button").forEach((x) => x.classList.toggle("active", x === b));
    loadStats();
  };

  // ================= вкладки и язык =================
  function setTab(tab) {
    if (!["watch", "setup", "stats"].includes(tab)) tab = "watch";
    document.querySelectorAll("#camTabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
    for (const id of ["watch", "setup", "stats"]) $("tab-" + id).hidden = id !== tab;
    history.replaceState(null, "", "#" + tab);
    if (tab === "stats") loadStats();
  }
  $("camTabs").addEventListener("click", (e) => {
    const a = e.target.closest("[data-tab]");
    if (!a) return;
    e.preventDefault();
    setTab(a.dataset.tab);
  });

  function applyLang(lang) {
    if (lang) I.setLang(lang); else I.apply();
    document.title = `${t("cam.title")} — ${t("title")}`;
    document.querySelectorAll(".lang-seg button").forEach((b) => b.classList.toggle("active", b.dataset.lang === I.lang));
    if (S.token) {
      $("wStart").textContent = S.running ? t("cam.stop") : t("cam.start");
      if (S.model) $("wModel").textContent = t("cam.modelReady");
      renderSetupTable();
      renderSendInfo();
      updatePanel(S.running ? Number($("wCount").textContent) : null);
      if (!$("tab-stats").hidden) loadStats();
      if (!$("sForm").hidden) onTypeChange();
    }
  }
  document.querySelectorAll(".lang-seg").forEach((seg) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-lang]");
    if (b) applyLang(b.dataset.lang);
  }));

  window.addEventListener("hashchange", () => S.token && setTab(location.hash.replace("#", "")));
  window.addEventListener("beforeunload", () => flushMinute(true));

  applyLang();
  renderSendInfo();
  boot();
})();
