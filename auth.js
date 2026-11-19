// Общий вход администратора для всей «Аналитики ОшТУ» (дашборд и камеры).
// Пароль проверяет сервер (bcrypt-хеш в базе); в браузере хранится только токен сессии.
(function () {
  "use strict";
  const KEY = "oa.admin";

  class ApiError extends Error {}

  function bases() {
    const { SUPABASE_URL, PROXY } = window.APP_CONFIG;
    const deployed = /^https?:$/.test(location.protocol) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return [...(deployed ? [`${location.origin}/sb`] : []), PROXY, SUPABASE_URL];
  }

  // другой адрес пробуем только при сетевой ошибке или 5xx; ответ сервера (неверный пароль) не повторяем
  async function rpc(name, body, timeoutMs = 30000) {
    let last;
    for (const base of bases()) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
          if (/вход администратора/i.test(e.message)) clear();
          throw e;
        }
        last = e;
      }
    }
    throw last;
  }

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
  }
  function clear() {
    try { localStorage.removeItem(KEY); } catch {}
  }

  /** Есть ли действующая сессия. Без связи доверяем сохранённой (сервер всё равно проверит токен при записи). */
  async function check() {
    const s = read();
    if (!s || !s.token || new Date(s.expires_at) <= new Date()) { clear(); return null; }
    try {
      const r = await rpc("oshtu_admin_check", { p_token: s.token }, 15000);
      if (r && r.ok) return s;
      clear();
      return null;
    } catch (e) {
      if (e instanceof ApiError) { clear(); return null; }
      return s;
    }
  }

  async function login(user, pass) {
    const r = await rpc("oshtu_admin_login", { p_login: user, p_password: pass });
    try { localStorage.setItem(KEY, JSON.stringify(r)); } catch {}
    return r;
  }

  async function logout() {
    const s = read();
    clear();
    if (s && s.token) { try { await rpc("oshtu_admin_logout", { p_token: s.token }, 10000); } catch {} }
  }

  window.OAuth = { rpc, check, login, logout, session: read, ApiError };
})();
