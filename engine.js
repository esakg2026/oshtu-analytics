// Движок аналитики аудиторного фонда ОшТУ.
// Вход: набор данных oshtu_room_dataset — все аудитории и их расписание (как на portal.oshtu.kg «По аудитории»).
// Выход: показатели загрузки, типов аудиторий и занятий, нагрузки преподавателей и групп, конфликтов.
(function (root) {
  "use strict";

  const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const DAYS_FULL = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
  const PAIRS = [1, 2, 3, 4, 5, 6];
  const PAIR_TIMES = { 1: "08:00", 2: "09:30", 3: "11:20", 4: "12:50", 5: "14:20", 6: "15:50" };
  const SLOTS_PER_WEEK = DAYS.length * PAIRS.length; // 36

  const LESSON_TYPES = {
    лк: "Лекции",
    пр: "Практика",
    лб: "Лабораторные",
    се: "Семинары",
    "": "Без типа",
  };

  // Предметы, для которых почти всегда нужен компьютерный класс
  const IT_RE = /информат|информац[а-я]* (систем|технолог|безопас)|\bИС\b|\bИТ\b|\bИКТ\b|программ|компьютер|баз[аыу]? данных|big data|web|веб|html|php|java|python|c\+\+|1с|autocad|автокад|cad|алгоритм|кибер|криптограф|машинн[а-я]* обуч|искусственн[а-я]* интеллект|анализ данных|аналитика данных|облачн|операционн[а-я]* систем|администрир|кодирован|тестирован[а-я]* (по|программ)|мобильн[а-я]* прил|гис|excel|компьютерн/i;

  // ---------- разбор ячейки (формат «По аудитории») ----------
  const decode = (s) =>
    s.replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const TYPE_RE = /\((лк|пр|лб|лаб|сем)[^)]*\)/i;
  const HEAD_RE = /^(.*?)\s*\((лк|пр|лб|лаб|сем)[^)]*\)\s*(?:\[([^\]]+)\])?\s*$/i;

  function parseBlock(html) {
    const lines = html.split(/<br\s*\/?>/i).map((s) => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(HEAD_RE);
      if (!m) {
        out.push({ subject: lines[i], type: "", group: "", teacher: "", sub: "" });
        continue;
      }
      const sm = m[1].trim().match(/^\((\d+)\)\s*(.*)$/);
      const l = { subject: (sm ? sm[2] : m[1]).trim(), type: m[2].toLowerCase().slice(0, 2), group: "", teacher: "", sub: sm ? sm[1] : "" };
      if (l.type === "ла") l.type = "лб";
      const next = lines[i + 1] && !TYPE_RE.test(lines[i + 1]) ? lines[i + 1] : null;
      if (next) {
        const g = next.match(/^(\S*\d\S*)\s+(.+)$/);
        if (g) { l.group = g[1]; l.teacher = g[2]; } else l.teacher = next;
        i++;
      }
      out.push(l);
    }
    return out;
  }

  function parseCell(html) {
    if (!html || !html.replace(/<[^>]+>|\s|&nbsp;/g, "")) return null;
    const parts = html.split(/<hr[^>]*>/i);
    if (parts.length === 1) {
      const l = parseBlock(parts[0]);
      return l.length ? { top: l, bottom: l } : null;
    }
    return { top: parseBlock(parts[0]), bottom: parseBlock(parts.slice(1).join("")) };
  }

  // ---------- набор занятий ----------
  /** Превращает набор данных в плоский список занятий: одна запись = одно занятие в слоте недели. */
  function flatten(dataset) {
    const rooms = [];
    const lessons = [];
    for (const r of dataset.rooms || []) {
      const room = { id: r.id, bid: r.bid, building: r.b, name: r.n, label: `${r.b}/${r.n}`, at: r.at, hasData: !!r.raw };
      rooms.push(room);
      for (const row of r.raw || []) {
        const pair = Number(row.PairNumber);
        for (let d = 1; d <= 6; d++) {
          const cell = parseCell(row[`WeekDay${d}`] || "");
          if (!cell) continue;
          for (const week of ["top", "bottom"]) {
            for (const l of cell[week]) {
              lessons.push({ roomId: r.id, bid: r.bid, building: r.b, day: d, pair, week, ...l });
            }
          }
        }
      }
    }
    return { rooms, lessons };
  }

  const pct = (a, b) => (b ? (a / b) * 100 : 0);
  const inc = (m, k, v = 1) => m.set(k, (m.get(k) || 0) + v);
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];

  /**
   * Основной расчёт.
   * opts.building — ID корпуса или null (все); opts.week — "both" | "top" | "bottom".
   */
  function analyze(flat, opts = {}) {
    const week = opts.week || "both";
    const weeks = week === "both" ? ["top", "bottom"] : [week];
    const nWeeks = weeks.length;
    const rooms = flat.rooms.filter((r) => !opts.building || r.bid === opts.building);
    const roomIds = new Set(rooms.map((r) => r.id));
    const L = flat.lessons.filter((l) => roomIds.has(l.roomId) && weeks.includes(l.week));

    // слоты аудиторий: roomId|week|day|pair -> занятия
    const slotMap = new Map();
    for (const l of L) {
      const k = `${l.roomId}|${l.week}|${l.day}|${l.pair}`;
      if (!slotMap.has(k)) slotMap.set(k, []);
      slotMap.get(k).push(l);
    }

    // «пара» = занятый слот аудитории (поток из нескольких групп в одной аудитории — одна пара)
    const perRoom = new Map(rooms.map((r) => [r.id, {
      ...r, busy: 0, types: { лк: 0, пр: 0, лб: 0, се: 0, "": 0 }, it: 0, groups: new Set(), teachers: new Set(),
      subjects: new Map(), grid: Array.from({ length: 6 }, () => Array(6).fill(0)), conflicts: 0,
    }]));
    const heat = Array.from({ length: 6 }, () => Array(6).fill(0)); // день × пара: занятых слотов
    const byDay = Array(6).fill(0);
    const byPair = Array(6).fill(0);
    const typeCount = { лк: 0, пр: 0, лб: 0, се: 0, "": 0 };
    const teacherSlots = new Map();
    const groupSlots = new Map();
    const subjectSlots = new Map();
    const conflicts = [];
    const teacherAt = new Map(); // teacher|week|day|pair -> rooms (преподаватель в двух аудиториях одновременно)

    for (const [k, list] of slotMap) {
      const [roomId, wk, day, pair] = k.split("|");
      const r = perRoom.get(Number(roomId));
      const d = Number(day) - 1, p = Number(pair) - 1;
      if (p < 0 || p > 5) continue;
      r.busy++;
      r.grid[d][p]++;
      heat[d][p]++;
      byDay[d]++;
      byPair[p]++;
      // тип пары — по первому занятию; подсчёт IT-предметов
      const main = list[0];
      r.types[main.type in r.types ? main.type : ""]++;
      typeCount[main.type in typeCount ? main.type : ""]++;
      if (IT_RE.test(main.subject)) r.it++;
      inc(subjectSlots, main.subject);
      for (const l of list) {
        if (l.group) r.groups.add(l.group);
        if (l.teacher) r.teachers.add(l.teacher);
        inc(r.subjects, l.subject);
      }
      // нагрузка: каждому преподавателю и группе — 1 пара за слот
      for (const t of uniq(list.map((l) => l.teacher))) {
        inc(teacherSlots, t);
        const tk = `${t}|${wk}|${day}|${pair}`;
        if (!teacherAt.has(tk)) teacherAt.set(tk, new Set());
        teacherAt.get(tk).add(r.label);
      }
      for (const g of uniq(list.map((l) => l.group))) inc(groupSlots, g);
      // конфликт: разные предметы с разными преподавателями в одном слоте (не поток и не подгруппы)
      const distinct = uniq(list.map((l) => `${l.subject}::${l.teacher}`));
      const subjectsDiff = uniq(list.map((l) => l.subject)).length > 1;
      if (distinct.length > 1 && subjectsDiff) {
        r.conflicts++;
        conflicts.push({ room: r.label, roomId: r.id, week: wk, day: Number(day), pair: Number(pair), items: list.map((l) => `${l.subject} · ${l.group} · ${l.teacher}`) });
      }
    }

    const teacherDouble = [];
    for (const [k, set] of teacherAt) {
      if (set.size > 1) {
        const [t, wk, day, pair] = k.split("|");
        teacherDouble.push({ teacher: t, week: wk, day: Number(day), pair: Number(pair), rooms: [...set] });
      }
    }

    // классификация аудиторий
    const capacity = SLOTS_PER_WEEK * nWeeks;
    const roomStats = [...perRoom.values()].map((r) => {
      const total = r.busy;
      const share = (t) => (total ? r.types[t] / total : 0);
      let kind = "unused";
      if (total > 0) {
        if (r.it >= 3 && r.it / total >= 0.35 && share("пр") + share("лб") >= 0.4) kind = "computer";
        else if (share("лб") >= 0.4) kind = "lab";
        else if (share("лк") >= 0.6) kind = "lecture";
        else if (share("пр") + share("се") >= 0.6) kind = "practice";
        else kind = "mixed";
      }
      const topSubjects = [...r.subjects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);
      return {
        id: r.id, bid: r.bid, building: r.building, name: r.name, label: r.label, hasData: r.hasData,
        busy: total, perWeek: total / nWeeks, load: pct(total, capacity), kind,
        lk: r.types.лк, pr: r.types.пр + r.types.се, lb: r.types.лб, it: r.it,
        groups: r.groups.size, teachers: r.teachers.size, grid: r.grid, conflicts: r.conflicts, topSubjects,
      };
    });

    const used = roomStats.filter((r) => r.busy > 0);
    const kinds = { lecture: 0, practice: 0, lab: 0, computer: 0, mixed: 0, unused: 0 };
    for (const r of roomStats) kinds[r.kind]++;

    // по корпусам
    const buildings = new Map();
    for (const r of roomStats) {
      if (!buildings.has(r.bid)) buildings.set(r.bid, { bid: r.bid, name: r.building, rooms: 0, used: 0, busy: 0 });
      const b = buildings.get(r.bid);
      b.rooms++;
      if (r.busy) b.used++;
      b.busy += r.busy;
    }
    const buildingStats = [...buildings.values()].map((b) => ({
      ...b, load: pct(b.busy, b.rooms * capacity), usedLoad: pct(b.busy, Math.max(1, b.used) * capacity), perWeek: b.busy / nWeeks,
    })).sort((a, b) => b.perWeek - a.perWeek);

    const totalBusy = roomStats.reduce((s, r) => s + r.busy, 0);
    const toList = (m) => [...m.entries()].map(([name, v]) => ({ name, perWeek: v / nWeeks })).sort((a, b) => b.perWeek - a.perWeek);
    const teachers = toList(teacherSlots);
    const groups = toList(groupSlots);

    // пиковый слот
    let peak = { day: 0, pair: 0, v: -1 };
    heat.forEach((row, d) => row.forEach((v, p) => { if (v > peak.v) peak = { day: d + 1, pair: p + 1, v }; }));

    // сравнение недель (всегда по обеим, независимо от фильтра)
    const weekCompare = { top: 0, bottom: 0 };
    for (const k of slotMap.keys()) weekCompare[k.split("|")[1]]++;

    return {
      opts: { week, building: opts.building || null, nWeeks },
      totals: {
        rooms: roomStats.length,
        used: used.length,
        unused: roomStats.length - used.length,
        pairsPerWeek: totalBusy / nWeeks,
        avgLoadAll: pct(totalBusy, roomStats.length * capacity),
        avgLoadUsed: pct(totalBusy, Math.max(1, used.length) * capacity),
        teachers: teachers.length,
        groups: groups.length,
        subjects: subjectSlots.size,
        conflicts: conflicts.length,
        teacherDouble: teacherDouble.length,
        peak,
        peakShare: pct(peak.v, roomStats.length * nWeeks),
      },
      heat: heat.map((row) => row.map((v) => ({ v: v / nWeeks, share: pct(v, roomStats.length * nWeeks) }))),
      byDay: byDay.map((v) => v / nWeeks),
      byPair: byPair.map((v) => v / nWeeks),
      lessonTypes: Object.fromEntries(Object.entries(typeCount).map(([k, v]) => [k, v / nWeeks])),
      roomKinds: kinds,
      rooms: roomStats,
      buildings: buildingStats,
      teachers,
      groups,
      subjects: toList(subjectSlots),
      conflicts,
      teacherDouble,
      weekCompare,
    };
  }

  /** Свободные аудитории в слот (день 1..6, пара 1..6, неделя top/bottom). */
  function freeRooms(flat, day, pair, week, building) {
    const busy = new Set(flat.lessons.filter((l) => l.day === day && l.pair === pair && l.week === week).map((l) => l.roomId));
    return flat.rooms.filter((r) => (!building || r.bid === building) && !busy.has(r.id));
  }

  const api = { DAYS, DAYS_FULL, PAIRS, PAIR_TIMES, LESSON_TYPES, IT_RE, parseCell, flatten, analyze, freeRooms };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OA = api;
})(typeof window !== "undefined" ? window : globalThis);
