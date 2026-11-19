// «Наблюдение с камер» — часть «Аналитики ОшТУ» (вход общий, см. auth.js).
// • Сам находит все камеры этого компьютера и регистрирует их в базе.
// • Работает круглосуточно, но считает людей и отправляет данные ТОЛЬКО во время пар (Пн–Сб, 1–6 пара).
//   Вне пар распознавание не запускается вообще; база тоже отклоняет минуты вне пар.
// • Видео не отправляется и не сохраняется — только поминутные числа.
(function () {
  "use strict";
  const I = window.I18N;
  const t = I.t;
  const OA = window.OA;
  const A = window.OAuth;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString(I.locale());

  const TIMES = { 1: ["08:00", "09:20"], 2: ["09:30", "10:50"], 3: ["11:20", "12:40"], 4: ["12:50", "14:10"], 5: ["14:20", "15:40"], 6: ["15:50", "17:10"] };
  const WEEK_ANCHOR = new Date(2026, 10, 9); // неделя 9–14 ноября 2026 — верхняя
  const HELD_THRESHOLD = 3;
  const TICK_MS = 700;           // шаг планировщика: каждую камеру по очереди
  const PER_CAMERA_MS = 1500;    // одну камеру — не чаще раза в 1,5 с
  const QUEUE_KEY = "oa.camQueue";
  const HOST_KEY = "oa.hostKey";
  const HOST_NAME = "oa.hostName";

  const S = {
    session: null, cams: [], flat: null, byRoom: new Map(), model: null, modelLoading: null,
    tiles: new Map(), // camId → {cam, video, img, canvas, box, countEl, planEl, matchEl, stream, lastRun, samples, minuteKey, recent, deviceId}
    rr: 0, sent: 0, period: "today", wake: null, scanning: false,
  };

  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  const rpc = (name, body) => A.rpc(name, body).catch((e) => {
    if (e instanceof A.ApiError && /вход администратора/i.test(e.message)) location.replace("./");
    throw e;
  });
  const token = () => S.session.token;

  // ---------- компьютер ----------
  function hostKey() {
    let k = store.get(HOST_KEY);
    if (!k) {
      k = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9-]/g, "");
      store.set(HOST_KEY, k);
    }
    return k;
  }
  const hostName = () => store.get(HOST_NAME) || `PC-${hostKey().slice(0, 4).toUpperCase()}`;

  // ---------- время и расписание ОшТУ ----------
  const toMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const isoDay = (d) => ((d.getDay() + 6) % 7) + 1;

  /** Номер пары в момент d (Пн–Сб) или null — та же проверка, что и в базе. */
  function pairAt(d) {
    if (isoDay(d) > 6) return null;
    const m = d.getHours() * 60 + d.getMinutes();
    for (const [p, [a, b]] of Object.entries(TIMES)) if (m >= toMin(a) && m < toMin(b)) return Number(p);
    return null;
  }

  function nextPairStart(d) {
    for (let i = 0; i < 8; i++) {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
      if (isoDay(day) > 6) continue;
      for (const [p, [a]] of Object.entries(TIMES)) {
        const [h, m] = a.split(":").map(Number);
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
        if (at > d) return { at, pair: Number(p) };
      }
    }
    return null;
  }

  function weekType(d) {
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const w = Math.round((mon - WEEK_ANCHOR) / 6048e5);
    return ((w % 2) + 2) % 2 === 0 ? "top" : "bottom";
  }

  function scheduleAt(roomId, d) {
    const day = isoDay(d), pair = pairAt(d), week = weekType(d);
    const lessons = roomId && pair ? (S.byRoom.get(roomId) || []).filter((l) => l.day === day && l.pair === pair && l.week === week) : [];
    return { day, pair, week, lessons };
  }

  async function loadDataset() {
    let ds = store.get("oa.dataset.v1");
    const fresh = rpc("oshtu_room_dataset", {}).then((x) => { store.set("oa.dataset.v1", x); useDataset(x); }).catch(() => {});
    if (ds) useDataset(ds);
    else { await fresh; if (!S.flat) useDataset({ rooms: [] }); }
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

  // ---------- модель ----------
  function preloadModel() {
    if (S.model || S.modelLoading) return S.modelLoading;
    $("wModel").textContent = t("cam.modelLoading");
    S.modelLoading = (async () => {
      for (let i = 0; i < 300 && !(window.cocoSsd && window.tf); i++) await new Promise((r) => setTimeout(r, 100));
      if (!window.cocoSsd) throw new Error("model scripts not loaded");
      S.model = await window.cocoSsd.load({ base: "lite_mobilenet_v2" });
      $("wModel").textContent = t("cam.modelReady");
      return S.model;
    })().catch((e) => {
      S.modelLoading = null;
      $("wModel").textContent = String(e.message || e);
      setTimeout(preloadModel, 30000); // повторим позже — работаем круглосуточно
    });
    return S.modelLoading;
  }

  // ================= автопоиск камер =================
  /** Камеры компьютера с настоящими названиями. Без разрешения браузер названий не даёт — тогда ничего не регистрируем. */
  async function listVideoInputs() {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true });
      tmp.getTracks().forEach((tr) => tr.stop());
      $("wErr").hidden = true;
    } catch (e) {
      $("wErr").textContent = `${t("cam.allowCam")} (${e.name || e.message})`;
      $("wErr").hidden = false;
      return null;
    }
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.label);
    return devs.map((d) => ({ deviceId: d.deviceId, label: d.label }));
  }

  async function scan() {
    if (S.scanning) return;
    S.scanning = true;
    try {
      const devs = await listVideoInputs();
      if (!devs) { await reloadCams(); return; }
      S.devices = devs;
      S.cams = (await rpc("oshtu_cam_register", { p_token: token(), p_host_key: hostKey(), p_host_name: hostName(), p_devices: devs.map((d) => ({ label: d.label })) })) || [];
      $("wInfo").textContent = devs.length ? t("cam.detected", { n: devs.length }) : t("cam.noDevices");
      syncTiles();
      renderSetupTable();
    } catch (e) {
      toast(e.message || String(e));
    } finally {
      S.scanning = false;
    }
  }

  async function reloadCams() {
    S.cams = (await rpc("oshtu_cam_list", { p_token: token() })) || [];
    syncTiles();
    renderSetupTable();
  }

  // ================= плитки камер =================
  const myCams = () => S.cams.filter((c) => c.host_key === hostKey() && c.enabled && (c.source_type === "device" || c.source_type === "url"));

  function syncTiles() {
    const want = new Map(myCams().map((c) => [c.id, c]));
    for (const [id, tile] of S.tiles) if (!want.has(id)) { closeTile(tile); S.tiles.delete(id); }
    for (const [id, cam] of want) {
      const tile = S.tiles.get(id);
      if (tile) { tile.cam = cam; renderTileHead(tile); } else S.tiles.set(id, openTile(cam));
    }
    $("grid").querySelectorAll(".tile").forEach((el) => { if (!S.tiles.has(Number(el.dataset.id))) el.remove(); });
  }

  function openTile(cam) {
    const el = document.createElement("div");
    el.className = "card tile";
    el.dataset.id = cam.id;
    el.innerHTML = `<div class="tile-head"><b></b><span></span></div>
      <div class="video-box${$("wBlur").checked ? " blur" : ""}"><video playsinline muted autoplay></video><img alt="" hidden /><canvas></canvas>
      <div class="tile-count idle">—</div><div class="video-empty">…</div></div>
      <div class="tile-plan"></div><div class="match" hidden></div>`;
    $("grid").appendChild(el);
    const tile = {
      cam, el, video: el.querySelector("video"), img: el.querySelector("img"), canvas: el.querySelector("canvas"),
      box: el.querySelector(".video-box"), countEl: el.querySelector(".tile-count"), emptyEl: el.querySelector(".video-empty"),
      planEl: el.querySelector(".tile-plan"), matchEl: el.querySelector(".match"),
      stream: null, lastRun: 0, samples: [], minuteKey: null, recent: [], ready: false, busy: false,
    };
    renderTileHead(tile);
    startSource(tile);
    return tile;
  }

  function renderTileHead(tile) {
    const c = tile.cam;
    tile.el.querySelector(".tile-head b").textContent = c.room ? `${t("cam.room")} ${c.room}` : t("cam.unassigned");
    tile.el.querySelector(".tile-head span").textContent = c.name;
    tile.el.classList.toggle("warn-room", !c.room_id);
  }

  async function startSource(tile) {
    const c = tile.cam;
    tile.ready = false;
    tile.emptyEl.hidden = false;
    tile.emptyEl.textContent = "…";
    try {
      if (c.source_type === "device") {
        const dev = (S.devices || []).find((d) => d.label === c.device_label);
        if (!dev) throw new Error("not connected");
        tile.stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: dev.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        tile.video.srcObject = tile.stream;
        tile.stream.getVideoTracks().forEach((tr) => tr.addEventListener("ended", () => reconnect(tile)));
        await tile.video.play().catch(() => {});
        tile.video.hidden = false;
        tile.img.hidden = true;
      } else {
        tile.img.crossOrigin = "anonymous";
        await new Promise((res, rej) => { tile.img.onload = res; tile.img.onerror = rej; tile.img.src = c.source; });
        tile.img.hidden = false;
        tile.video.hidden = true;
      }
      tile.ready = true;
      tile.emptyEl.hidden = true;
    } catch (e) {
      tile.emptyEl.textContent = c.source_type === "url" ? t("cam.errCors") : t("cam.reconnect");
      setTimeout(() => S.tiles.get(c.id) === tile && startSource(tile), 15000);
    }
  }

  function reconnect(tile) {
    tile.ready = false;
    if (tile.stream) tile.stream.getTracks().forEach((tr) => tr.stop());
    tile.stream = null;
    setTimeout(() => S.tiles.get(tile.cam.id) === tile && startSource(tile), 5000);
  }

  function closeTile(tile) {
    flushMinute(tile);
    if (tile.stream) tile.stream.getTracks().forEach((tr) => tr.stop());
    tile.el.remove();
  }

  // ================= планировщик: круглосуточно, подсчёт только на парах =================
  async function tick() {
    try {
      const now = new Date();
      const pair = pairAt(now);
      renderPairStatus(now, pair);
      const tiles = [...S.tiles.values()];
      if (!pair) {
        // вне пары: распознавание не запускаем, недописанные минуты закрываем
        for (const tile of tiles) { flushMinute(tile); idleTile(tile); }
        return;
      }
      if (!S.model || !tiles.length) return;
      // одна камера за шаг — по кругу
      for (let k = 0; k < tiles.length; k++) {
        const tile = tiles[(S.rr + k) % tiles.length];
        if (!tile.ready || tile.busy || !tile.cam.room_id || Date.now() - tile.lastRun < PER_CAMERA_MS) continue;
        S.rr = (S.rr + k + 1) % tiles.length;
        await detect(tile, now);
        break;
      }
      for (const tile of tiles) if (!tile.cam.room_id) idleTile(tile, t("cam.unassigned"));
    } finally {
      setTimeout(tick, TICK_MS);
    }
  }

  function idleTile(tile, text) {
    tile.countEl.classList.add("idle");
    tile.countEl.textContent = text || t("cam.outside");
    tile.canvas.getContext("2d").clearRect(0, 0, tile.canvas.width, tile.canvas.height);
    tile.matchEl.hidden = true;
    renderTilePlan(tile, new Date());
  }

  async function detect(tile, now) {
    tile.busy = true;
    tile.lastRun = Date.now();
    const src = tile.video.hidden ? tile.img : tile.video;
    const ok = tile.video.hidden ? tile.img.naturalWidth : tile.video.readyState >= 2 && tile.video.videoWidth;
    try {
      if (!ok) return;
      const preds = await S.model.detect(src, 100, 0.4);
      const people = preds.filter((p) => p.class === "person");
      draw(tile, src, people);
      addSample(tile, people.length, now);
    } catch (e) {
      if (/tainted|SecurityError|cross-origin/i.test(String(e))) { tile.ready = false; tile.emptyEl.hidden = false; tile.emptyEl.textContent = t("cam.errCors"); }
    } finally {
      tile.busy = false;
    }
  }

  function draw(tile, src, people) {
    const W = tile.box.clientWidth, H = tile.box.clientHeight, dpr = window.devicePixelRatio || 1;
    if (tile.canvas.width !== W * dpr) { tile.canvas.width = W * dpr; tile.canvas.height = H * dpr; }
    const ctx = tile.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!$("wBoxes").checked) return;
    const sw = src.videoWidth || src.naturalWidth, sh = src.videoHeight || src.naturalHeight;
    const k = Math.min(W / sw, H / sh), ox = (W - sw * k) / 2, oy = (H - sh * k) / 2;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#1baf7a";
    for (const p of people) {
      const [x, y, w, h] = p.bbox;
      ctx.strokeRect(ox + x * k, oy + y * k, w * k, h * k);
    }
  }

  function addSample(tile, n, now) {
    tile.recent.push(n);
    if (tile.recent.length > 3) tile.recent.shift();
    const shown = [...tile.recent].sort((a, b) => a - b)[Math.floor(tile.recent.length / 2)];
    tile.countEl.classList.remove("idle");
    tile.countEl.textContent = shown;
    const key = Math.floor(now.getTime() / 60000);
    if (tile.minuteKey !== null && key !== tile.minuteKey) flushMinute(tile);
    tile.minuteKey = key;
    tile.samples.push(n);
    renderTilePlan(tile, now, shown);
  }

  function renderTilePlan(tile, now, peopleNow) {
    const sc = scheduleAt(tile.cam.room_id, now);
    tile.planEl.innerHTML = !tile.cam.room_id ? "" : sc.lessons.length
      ? `<b>${esc(sc.lessons[0].subject)}</b> (${esc(sc.lessons[0].type)}.) <small>· ${esc([...new Set(sc.lessons.map((l) => l.group))].join(", "))} · ${esc(sc.lessons[0].teacher)}</small>`
      : `<span class="muted">${esc(t("cam.plan"))}: ${esc(t("cam.noLesson"))}</span>`;
    if (peopleNow == null || !sc.pair) return;
    const busy = peopleNow >= HELD_THRESHOLD, planned = sc.lessons.length > 0;
    const key = planned ? (busy ? "ok" : "empty") : busy ? "extra" : "free";
    tile.matchEl.hidden = false;
    tile.matchEl.textContent = t("cam.match")[key];
    tile.matchEl.className = "match " + (key === "ok" ? "ok" : key === "free" ? "" : "warn");
  }

  // ---------- поминутная отправка (только минуты внутри пар) ----------
  function flushMinute(tile) {
    const samples = tile.samples;
    tile.samples = [];
    if (!samples.length || tile.minuteKey === null || !tile.cam.room_id) return;
    const ts = new Date(tile.minuteKey * 60000);
    tile.minuteKey = null;
    if (!pairAt(ts) || samples.length < 3) return; // не пара или слишком мало кадров за минуту
    const sc = scheduleAt(tile.cam.room_id, ts);
    const l = sc.lessons[0];
    const row = {
      camera_id: tile.cam.id, room_id: tile.cam.room_id, ts: ts.toISOString(),
      people_avg: Math.round((samples.reduce((s, v) => s + v, 0) / samples.length) * 10) / 10,
      people_max: Math.max(...samples), samples: samples.length,
      day: sc.day, pair: sc.pair, week: sc.week, scheduled: sc.lessons.length > 0,
      subject: l ? l.subject : null, lesson_type: l ? l.type : null,
      group_name: sc.lessons.length ? [...new Set(sc.lessons.map((x) => x.group).filter(Boolean))].join(", ") : null,
      teacher: sc.lessons.length ? [...new Set(sc.lessons.map((x) => x.teacher).filter(Boolean))].join(", ") : null,
    };
    const q = store.get(QUEUE_KEY, []);
    q.push(row);
    store.set(QUEUE_KEY, q.slice(-20000));
    sendQueue();
  }

  async function sendQueue() {
    const q = store.get(QUEUE_KEY, []);
    if (!q.length || sendQueue.busy) return renderSendInfo();
    sendQueue.busy = true;
    try {
      const batch = q.slice(0, 500);
      await rpc("oshtu_cam_report", { p_token: token(), p_rows: batch });
      store.set(QUEUE_KEY, store.get(QUEUE_KEY, []).slice(batch.length));
      S.sent += batch.length;
    } catch {} finally {
      sendQueue.busy = false;
      renderSendInfo();
    }
  }

  function renderSendInfo() {
    $("wSent").textContent = t("cam.sent", { n: S.sent });
    const q = store.get(QUEUE_KEY, []).length;
    $("wQueue").textContent = q ? " · " + t("cam.queue", { n: q }) : "";
  }

  function renderPairStatus(now, pair) {
    const box = $("pairStatus");
    if (pair) {
      box.className = "card pair-status on";
      $("psMain").textContent = t("cam.inPair", { pair: t("pairFull", { n: pair }), from: TIMES[pair][0], to: TIMES[pair][1] });
      $("psSub").textContent = `${t("daysFull")[isoDay(now) - 1]} · ${t("week")[weekType(now)]}`;
    } else {
      box.className = "card pair-status off";
      $("psMain").textContent = t("cam.outside");
      const nx = nextPairStart(now);
      const sameDay = nx && nx.at.toDateString() === now.toDateString();
      $("psSub").textContent = nx
        ? t("cam.nextPair", { when: `${sameDay ? "" : t("daysFull")[isoDay(nx.at) - 1] + ", "}${t("pairFull", { n: nx.pair })} · ${TIMES[nx.pair][0]}` })
        : t("cam.noMorePairs");
    }
  }

  // ---------- экран не гаснет ----------
  async function keepAwake() {
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible" && !S.wake) {
        S.wake = await navigator.wakeLock.request("screen");
        S.wake.addEventListener("release", () => (S.wake = null));
      }
    } catch {}
  }

  // ================= настройка: привязка камер к аудиториям =================
  function roomOptions(selected) {
    const groups = new Map();
    for (const r of (S.flat ? S.flat.rooms : [])) {
      if (!groups.has(r.building)) groups.set(r.building, []);
      groups.get(r.building).push(r);
    }
    let html = `<option value="">${esc(t("cam.noRoom"))}</option>`;
    for (const [b, rooms] of groups) {
      html += `<optgroup label="${esc(/^\d+$/.test(b) ? t("buildingN", { n: b }) : b)}">` +
        rooms.sort((x, y) => x.name.localeCompare(y.name, "ru", { numeric: true }))
          .map((r) => `<option value="${r.id}"${r.id === selected ? " selected" : ""}>${esc(r.label)}</option>`).join("") + "</optgroup>";
    }
    return html;
  }

  function renderSetupTable() {
    const tb = $("sTable").querySelector("tbody");
    const mine = hostKey();
    tb.innerHTML = S.cams.map((c) => `<tr data-id="${c.id}" class="${c.host_key === mine ? "mine" : ""}">
      <td><b>${esc(c.host_key === mine ? t("cam.thisPc") : c.host_name || t("cam.otherPc"))}</b></td>
      <td><input type="text" class="cName" value="${esc(c.name)}" maxlength="80" /></td>
      <td><select class="cRoom">${roomOptions(c.room_id)}</select></td>
      <td>${esc(t("cam.types")[c.source_type])}${c.source_type === "url" ? `<br><small class="muted">${esc(c.source)}</small>` : ""}</td>
      <td><input type="checkbox" class="cOn"${c.enabled ? " checked" : ""} /></td>
      <td>${c.last_ts ? new Date(c.last_ts).toLocaleString(I.locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : esc(t("cam.never"))}</td>
      <td class="acts"><button class="btn btn-primary" data-save="${c.id}">${esc(t("cam.save"))}</button> <button class="btn" data-del="${c.id}">${esc(t("cam.del"))}</button></td></tr>`).join("") ||
      `<tr><td colspan="7" class="empty-note">${esc(t("cam.noDevices"))}</td></tr>`;
  }

  $("sTable").addEventListener("click", async (e) => {
    const sv = e.target.closest("[data-save]");
    const dl = e.target.closest("[data-del]");
    const tr = e.target.closest("tr");
    if (!tr || (!sv && !dl)) return;
    const cam = S.cams.find((c) => String(c.id) === tr.dataset.id);
    if (!cam) return;
    try {
      if (sv) {
        await rpc("oshtu_cam_save", { p_token: token(), p_cam: {
          id: cam.id, name: tr.querySelector(".cName").value.trim() || cam.name, source_type: cam.source_type,
          room_id: tr.querySelector(".cRoom").value || null, enabled: tr.querySelector(".cOn").checked, source: cam.source,
        } });
        toast(t("cam.rowSaved"));
      } else {
        if (!confirm(t("cam.confirmDel", { name: cam.name }))) return;
        await rpc("oshtu_cam_delete", { p_token: token(), p_id: cam.id });
      }
      await reloadCams();
    } catch (err) { toast(err.message); }
  });

  $("hostSave").onclick = async () => {
    const name = $("hostName").value.trim().slice(0, 60);
    if (!name) return;
    store.set(HOST_NAME, name);
    $("hostLabel").textContent = name;
    await scan();
    toast(t("cam.saved"));
  };
  $("rescan").onclick = scan;
  $("rescan2").onclick = scan;

  $("addIp").onclick = () => {
    $("ipForm").hidden = false;
    $("ipRoom").innerHTML = roomOptions(null);
    $("ipName").focus();
  };
  $("ipCancel").onclick = () => ($("ipForm").hidden = true);
  $("ipForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("ipErr").hidden = true;
    try {
      await rpc("oshtu_cam_save", { p_token: token(), p_cam: {
        name: $("ipName").value.trim(), source_type: "url", source: $("ipUrl").value.trim(),
        room_id: $("ipRoom").value || null, enabled: true, host_key: hostKey(), host_name: hostName(),
      } });
      $("ipForm").hidden = true;
      $("ipForm").reset();
      await reloadCams();
      toast(t("cam.saved"));
    } catch (err) {
      $("ipErr").textContent = err.message;
      $("ipErr").hidden = false;
    }
  });

  // ================= аналитика: план ОшТУ vs факт (только минуты пар) =================
  function periodRange() {
    const now = new Date();
    const from = S.period === "today" ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(now.getTime() - (S.period === "d7" ? 7 : 30) * 864e5);
    return { from, to: new Date(now.getTime() + 60000) };
  }

  async function loadStats() {
    $("aThreshold").textContent = t("cam.threshold", { n: HELD_THRESHOLD });
    const { from, to } = periodRange();
    let rows = [];
    try { rows = (await rpc("oshtu_cam_stats", { p_token: token(), p_from: from.toISOString(), p_to: to.toISOString() })) || []; } catch (e) { toast(e.message); }
    renderStats(rows.filter((r) => r.p)); // на всякий случай — только минуты пар
  }

  function renderStats(rows) {
    const has = rows.length > 0;
    $("aEmpty").hidden = has;
    $("aCharts").hidden = !has;
    $("aRoomsCard").hidden = !has;
    const label = (rid) => (roomById(rid) || {}).label || String(rid);
    const dayKey = (ts) => new Date(ts).toLocaleDateString(I.locale(), { day: "numeric", month: "short" });
    const pairs = new Map(), perRoom = new Map(), extra = new Map();
    for (const r of rows) {
      const room = perRoom.get(r.r) || { minutes: 0, planned: 0, held: 0, missed: 0, extra: 0, sum: 0, n: 0, max: 0 };
      room.minutes++;
      room.max = Math.max(room.max, r.m);
      perRoom.set(r.r, room);
      const k = `${r.r}|${dayKey(r.t)}|${r.p}`;
      const p = pairs.get(k) || { room: r.r, date: dayKey(r.t), pair: r.p, minutes: 0, sum: 0, scheduled: false, subject: r.sub, group: r.g };
      p.minutes++;
      p.sum += r.a;
      p.scheduled = p.scheduled || r.s;
      pairs.set(k, p);
      if (!r.s && r.a >= HELD_THRESHOLD) {
        room.extra++;
        const xk = `${r.r}|${dayKey(r.t)}`;
        const x = extra.get(xk) || { room: r.r, date: dayKey(r.t), min: 0, max: 0 };
        x.min++;
        x.max = Math.max(x.max, r.m);
        extra.set(xk, x);
      }
    }
    let planned = 0, held = 0, missed = 0, heldSum = 0;
    const byPair = Array.from({ length: 6 }, () => ({ sum: 0, n: 0 }));
    const missedList = [];
    for (const p of pairs.values()) {
      const avg = p.sum / p.minutes;
      if (p.pair >= 1 && p.pair <= 6) { byPair[p.pair - 1].sum += avg; byPair[p.pair - 1].n++; }
      if (!p.scheduled || p.minutes < 10) continue;
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

  // ================= вкладки, язык, запуск =================
  function setTab(tab) {
    if (!["watch", "setup", "stats"].includes(tab)) tab = "watch";
    document.querySelectorAll("#camTabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
    for (const id of ["watch", "setup", "stats"]) $("tab-" + id).hidden = id !== tab;
    if (tab === "stats") loadStats();
    if (tab === "setup") renderSetupTable();
  }
  $("camTabs").addEventListener("click", (e) => {
    const a = e.target.closest("[data-tab]");
    if (!a) return;
    e.preventDefault();
    history.replaceState(null, "", "#" + a.dataset.tab);
    setTab(a.dataset.tab);
  });
  window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));

  function applyLang(lang) {
    if (lang) I.setLang(lang); else I.apply();
    document.title = `${t("cam.title")} — ${t("title")}`;
    document.querySelectorAll(".lang-seg button").forEach((b) => b.classList.toggle("active", b.dataset.lang === I.lang));
    if (S.session) {
      for (const tile of S.tiles.values()) renderTileHead(tile);
      renderSetupTable();
      renderSendInfo();
      if (S.model) $("wModel").textContent = t("cam.modelReady");
      if (!$("tab-stats").hidden) loadStats();
    }
  }
  $("aLang").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lang]");
    if (b) applyLang(b.dataset.lang);
  });
  $("wBlur").onchange = () => { for (const tile of S.tiles.values()) tile.box.classList.toggle("blur", $("wBlur").checked); };
  $("logout").onclick = async () => { await A.logout(); location.replace("./"); };

  async function init() {
    applyLang();
    S.session = await A.check();
    if (!S.session) return location.replace("./"); // вход — в самой «Аналитике ОшТУ»
    $("appView").hidden = false;
    $("who").textContent = S.session.login;
    $("hostLabel").textContent = hostName();
    $("hostName").value = hostName();
    await loadDataset();
    setTab(location.hash.slice(1) || "watch");
    preloadModel();
    await scan();
    renderSendInfo();
    keepAwake();
    tick();
    setInterval(sendQueue, 60000);
    setInterval(() => scan(), 10 * 60000); // раз в 10 минут — новые камеры
    setInterval(() => rpc("oshtu_room_dataset", {}).then((x) => { store.set("oa.dataset.v1", x); useDataset(x); }).catch(() => {}), 6 * 3600000);
    navigator.mediaDevices.addEventListener("devicechange", () => setTimeout(scan, 1500));
    document.addEventListener("visibilitychange", keepAwake);
    window.addEventListener("online", sendQueue);
    window.addEventListener("beforeunload", () => { for (const tile of S.tiles.values()) flushMinute(tile); });
  }

  init();
})();
