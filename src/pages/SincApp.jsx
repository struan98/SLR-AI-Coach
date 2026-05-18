import { useState, useEffect, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// SUPABASE CLIENT
// ============================================================
const SUPABASE_URL = "https://vtvfnlvphdobrkcvkage.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0dmZubHZwaGRvYnJrY3ZrYWdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5MTYyMjQsImV4cCI6MjA5NDQ5MjIyNH0.Cruk0OnV5x43SavREvzJEMo29rYJCjMXDZaEeYauNrM";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ============================================================
// STORAGE — Supabase-backed with in-memory cache + optimistic writes
// ============================================================
const DEVICE_ONLY_KEYS = new Set(["sinc-session", "sinc-theme", "sinc-seed-v10", "dark", "light"]);
const cache = new Map();
let currentAuthUserId = null;

function getDeviceStore() {
  try { return JSON.parse(localStorage.getItem("__sinc_device") || "{}"); }
  catch { return {}; }
}
function setDeviceStore(obj) {
  try { localStorage.setItem("__sinc_device", JSON.stringify(obj)); } catch {}
}

function parseKey(key) {
  if (key.startsWith("u:")) {
    const rest = key.slice(2);
    const idx = rest.indexOf(":");
    if (idx === -1) return null;
    return { userId: rest.slice(0, idx), subkey: rest.slice(idx + 1) };
  }
  if (key.startsWith("pt:")) {
    const rest = key.slice(3);
    const idx = rest.indexOf(":");
    if (idx === -1) return null;
    return { userId: rest.slice(0, idx), subkey: "pt:" + rest.slice(idx + 1) };
  }
  if (key.startsWith("link:")) {
    return { userId: key.slice(5), subkey: "link" };
  }
  return null;
}

// Get current auth headers from the stored Supabase session.
function authHeaders() {
  const sbKey = Object.keys(localStorage).find(k => k.startsWith("sb-") && k.endsWith("-auth-token"));
  let token = null;
  if (sbKey) {
    try { token = JSON.parse(localStorage.getItem(sbKey))?.access_token || null; } catch {}
  }
  const h = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
  };
  if (token) h["Authorization"] = "Bearer " + token;
  return h;
}

async function supaGet(userId, subkey) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/user_data?select=data&user_id=eq.${encodeURIComponent(userId)}&key=eq.${encodeURIComponent(subkey)}&limit=1`;
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) { console.warn("supaGet status", r.status, subkey); return null; }
    const arr = await r.json();
    return Array.isArray(arr) && arr[0] ? arr[0].data : null;
  } catch (e) { console.warn("supaGet threw", e); return null; }
}

async function supaSet(userId, subkey, value) {
  try {
    console.log("[supaSet] writing", { userId, subkey, hasValue: !!value });
    const url = `${SUPABASE_URL}/rest/v1/user_data?on_conflict=user_id,key`;
    const r = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(), "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ user_id: userId, key: subkey, data: value }),
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error("[supaSet] ERROR", subkey, r.status, txt);
      return false;
    }
    console.log("[supaSet] wrote OK", subkey);
    return true;
  } catch (e) {
    console.error("[supaSet] threw", subkey, e);
    return false;
  }
}

async function supaDelete(userId, subkey) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/user_data?user_id=eq.${encodeURIComponent(userId)}&key=eq.${encodeURIComponent(subkey)}`;
    const r = await fetch(url, { method: "DELETE", headers: authHeaders() });
    return r.ok;
  } catch (e) { console.warn("supaDelete threw", e); return false; }
}

async function supaListSubkeys(userId, prefix) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/user_data?select=key&user_id=eq.${encodeURIComponent(userId)}&key=like.${encodeURIComponent(prefix + "%")}`;
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok) return [];
    const arr = await r.json();
    return Array.isArray(arr) ? arr.map(row => row.key) : [];
  } catch (e) { console.warn("supaListSubkeys threw", e); return []; }
}

const storage = {
  async get(key) {
    if (cache.has(key)) return cache.get(key);
    if (DEVICE_ONLY_KEYS.has(key)) {
      const ds = getDeviceStore();
      const v = ds[key] !== undefined ? ds[key] : null;
      cache.set(key, v);
      return v;
    }
    const parsed = parseKey(key);
    if (parsed) {
      const v = await supaGet(parsed.userId, parsed.subkey);
      cache.set(key, v);
      return v;
    }
    if (currentAuthUserId) {
      const v = await supaGet(currentAuthUserId, `global:${key}`);
      cache.set(key, v);
      return v;
    }
    const ds = getDeviceStore();
    const v = ds[key] !== undefined ? ds[key] : null;
    cache.set(key, v);
    return v;
  },
    async set(key, value) {
    cache.set(key, value);
    if (DEVICE_ONLY_KEYS.has(key)) {
      const ds = getDeviceStore();
      ds[key] = value;
      setDeviceStore(ds);
      return true;
    }
    const parsed = parseKey(key);
    if (parsed) {
      await supaSet(parsed.userId, parsed.subkey, value);
      return true;
    }
    if (currentAuthUserId) {
      await supaSet(currentAuthUserId, `global:${key}`, value);
      return true;
    }
    const ds = getDeviceStore();
    ds[key] = value;
    setDeviceStore(ds);
    return true;
  },
    async delete(key) {
    cache.delete(key);
    if (DEVICE_ONLY_KEYS.has(key)) {
      const ds = getDeviceStore();
      delete ds[key];
      setDeviceStore(ds);
      return true;
    }
    const parsed = parseKey(key);
    if (parsed) {
      await supaDelete(parsed.userId, parsed.subkey);
      return true;
    }
    if (currentAuthUserId) {
      await supaDelete(currentAuthUserId, `global:${key}`);
      return true;
    }
    const ds = getDeviceStore();
    delete ds[key];
    setDeviceStore(ds);
    return true;
  },
  async list(prefix) {
    const p = prefix || "";
    if (p.startsWith("u:")) {
      const rest = p.slice(2);
      const colonIdx = rest.indexOf(":");
      if (colonIdx === -1) return [];
      const userId = rest.slice(0, colonIdx);
      const subprefix = rest.slice(colonIdx + 1);
      const subkeys = await supaListSubkeys(userId, subprefix);
      return subkeys.map(sk => `u:${userId}:${sk}`);
    }
    if (p.startsWith("pt:")) {
      const rest = p.slice(3);
      const colonIdx = rest.indexOf(":");
      if (colonIdx === -1) return [];
      const userId = rest.slice(0, colonIdx);
      const subprefix = "pt:" + rest.slice(colonIdx + 1);
      const subkeys = await supaListSubkeys(userId, subprefix);
      return subkeys.map(sk => `pt:${userId}:${sk.slice(3)}`);
    }
    if (currentAuthUserId) {
      const subkeys = await supaListSubkeys(currentAuthUserId, `global:${p}`);
      return subkeys.map(sk => sk.slice("global:".length));
    }
    const ds = getDeviceStore();
    return Object.keys(ds).filter(k => k.startsWith(p));
  },
};
const userKey = (id, k) => `u:${id}:${k}`;
const ptKey = (id, k) => `pt:${id}:${k}`;

supabase.auth.onAuthStateChange((_event, session) => {
  const newId = session?.user?.id || null;
  if (newId !== currentAuthUserId) {
    cache.clear();
    currentAuthUserId = newId;
  }
});

// ============================================================
// THEME — Navy + Orange + White, with dark mode
// ============================================================
const NAVY = "#0a2540";
const ORANGE = "#ff7a3d";

// Status colours used across the app for metric trends and verdicts.
// Green = positive change / good. Amber = static / neutral / caution. Red = negative / risk.
const STATUS_GOOD = "#10b981";    // emerald-500 — gains, on-target, positive trend
const STATUS_STATIC = "#f59e0b";  // amber-500 — flat, plateau, slow
const STATUS_BAD = "#ef4444";     // red-500 — regression, missed target, risk

// Light variants for backgrounds with text on top
const STATUS_GOOD_BG = "#10b98115";
const STATUS_STATIC_BG = "#f59e0b15";
const STATUS_BAD_BG = "#ef444415";

const THEME = {
  light: {
    bg: "bg-slate-50", card: "bg-white", border: "border-slate-200",
    text: "text-slate-900", textMuted: "text-slate-500", textSubtle: "text-slate-600",
    inputBg: "bg-white", surface: "bg-slate-100", surfaceText: "text-slate-700",
    nav: "bg-white", navBorder: "border-slate-200",
    headerStart: NAVY, headerEnd: "#1e3a5f",
  },
  dark: {
    bg: "bg-slate-950", card: "bg-slate-900", border: "border-slate-800",
    text: "text-slate-100", textMuted: "text-slate-400", textSubtle: "text-slate-300",
    inputBg: "bg-slate-800", surface: "bg-slate-800", surfaceText: "text-slate-200",
    nav: "bg-slate-900", navBorder: "border-slate-800",
    headerStart: "#000814", headerEnd: NAVY,
  },
};

function useTheme() {
  const [dark, setDark] = useState(true); // dark by default
  useEffect(() => { storage.get("sinc-theme").then(t => { if (t === "light") setDark(false); }); }, []);
  const toggle = async () => { const next = !dark; setDark(next); await storage.set("sinc-theme", next ? "dark" : "light"); };
  return { dark, theme: dark ? THEME.dark : THEME.light, toggle };
}

// ============================================================
// LOGO — SINC monogram
// ============================================================
// ============================================================
// SLR BRAND ASSETS — actual designed logo files (cropped from brand sheet)
// ============================================================
const SLR_ICON_B64 = "data:image/webp;base64,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";
const SLR_WORDMARK_NAVY_B64 = "data:image/webp;base64,UklGRlqwAQBXRUJQVlA4TE2wAQAv80ExEFUHxIBtwzYgqYj/32y72wkRMQFIgJ78qDvlLgFtefdJqyen9OChA0m3tv2B9gbQAkigk6NIgMS1PG9XetICAtCPgK78oj9w8Z6WBPoPfpX0gqPtvqXCH5D44wUKx7m7tp3sOkmROLhKvxSJt267dpLMzCQT85SgnO2jBSgUuOz65swZI5J81ziJLiX5rgm97+7mOTOTxFLmHWdCJYHnxzy868THXJzImXxnYs8EuOS7ZiZw7O7mNjNJJpE8E8uWrQcC3X2Dw04cH7GdWMo8E+eBlPeMb9117jMztneR85hJZtwDZd7h2nodH5NkYq+r2pLkzPhWsDPJl5lEtPRxTpyZeNegfNdMjuT7vs+eiaTMpNAWdr17XC3vImfeUeaZzATJmUlPUOsksRMXdiU53z0B57vGSQzgL2lpC0hJ1nVa7+rkbCuBKklVaQ30DaWXPb27q2vb0rW38q537dXuetf4VgpItrx3nXh31971tuvdXe967cO7uy3lLUBSQQKEQHvR7vpyHrKAFvp4F1GeOtFpJASSoJwFkISgPwK0FCiItuXeltKWttyFhLjR0pYWSQIOWtE7LS3llN8GoGVbkm0n1X9v3ap3b/6qvHV//Sqg8Nn3IqXeBWr034/akUaUFF4kUC5sdkYcIwZow3PhNwZsDAuGD8MG9ks7AVwg1clm6AeYQAFTqC+mAZSuF8uEp02VPekCxS2x2cpkG8lGLgNSCDZyLfZkCFMLA54YUoGGpDJRzpRENfTAtOQ3W7vikanFWDYkuzRjo4KNVGwDKU15qQmUlNoDprB9KBOOCRSfzANsLC9SYnOUcOIDwWaJS6Z0PfhSicmmAGob9GA5Acm17bbNc/oC2rRuKVvvAgESVHliPqnPIsn2BI5t22qbE4avz5LeF5jhe4U56TwKDT0dl6kzAEOQbTttq2s8FNnS568vpczMXFkAkLaBtfe92cYoAuaTb/v/rm3LclZ3k9YTJW/J2/eiLy+11lpLU15qzaff8yi9CoG2Dol5MAAGcNfeT4QwrULnQFSjGMKgCqIqh2E/u4J4ARwMCpOY1AEMj8J91vLupJrUXBR/fwMDWMAwTpkvHM4s/lYD17xJUGx7O5NyTqM8AieAFjOCvexrTG+6BI55qCYYBC3NBebQMRyr3QXQfFhRUHMbyzvmYQg1NoWlyafDWFiHwlq4FBMt//Z2C5hWewSWcailVx4tAucxinILBxiYFFabVGVRTIqyGENdY5kjBKJtprCdae8UBk0GIEe2tkXKLu7ulmlGTEoEmcMOKCKK1GEidCX0JpgFdAj88lUXHzX+jbW+3ahcadvWKLvx6Put2/humDAf7k4o9wRyPN9sTcXQ01pqejgAq6i2wyrnd4VjbXsq5UzsT3KTq+PubrhWTumdLcCto7eNsAr2QEVF5e7QcgYWJLttGyLV3YkagYeHB33qef5/lWTb+W+aPdNdtf5rraLumZ6ezdCb95xz+d7Z+zDzHGY+G6+ZmZmZmZk5ZGZmZma7VWuqj/0Sfqb2jcx2Nkc+kLaleg0nazP70tLF0MyQWSo5otF6A17GkU66svGcN2BNNi2NVJKjCnoZsj0qqeTS1XZYqdneuSns4+iGHXlZmsTM9ALmWAejS61ztlRliOeYYbRV5onuOGAoY5l9dMa8o7qQmU5stkv1NhzSjlrOWvuYS0t+Bxwe6MhburBP6pvVWmZmZmYazQ46asOoNKYV13VmafWJTCV1MLqRmS7fO8a+znBHl2KXVGozUxsyKlN0U7Ndhg5LJzR7Z8aKdnipQ6vNTnvMvpRZ1PbPkCTrG65t27Zt27Zt27vnRuYq5gKO7dPnmWdnq7IyI/7/+AcyMrPa2v9PhiRbMdtTTERGZGRWZnVPTU9vz/JzuLg2H51n+xbOu7gf2zi2bdu2bdtndTEUsG07G0tX3U5tTNukTdqkSKrUxtQem4czx9batm3btm3b3j3c0Q8Lkt22DZniXlVIAO/hQZ+6pm1bdjdy7hZaWuujxSQtWWjJ1O7Vlkltubttt8x2e9TGHrtJRrndZLaXmdlud8sy203qNlPLrbbMbMsMI8kMIgvWWh+97/fprf6+dyn0B54wJwoNuh1Ohme055nKqIYZvnCGVKrZCjMzeZhnbQwopIpTcdXwzAr1qhlvdc2qqYbA8ArbgVVrmJS4SmFmUJjpG2ae2XKFFWZmBg0zs6ukwGB3UDuDDg96SmHSVJfjCXe1K9mebzOcL/BVDTsZd4e2hhl6KzigcHe5FI7SpdDAbmCYR1MZ3pzNXg6DZ0cO7XkzjBrmmbsVXhWOggp8M8WgKoWptwZXGFXuCTMzR1Wqga2QBld4QIEVRjsw5MDwuHornHjthdqZQu10xaVw1+CXqmH3Rpcqw9nAHNu2akuS5rnPI4sZBGDmLiqBcnAvI7plJUGpEEp4ChDN4gRPcvfv/7134fA+G/TItq3atu3U3scYczDPOdda9+xz3vn3M4OYr6sEXGXn3wzIVMhUAp4nsn8GxGAxs2SRdZYHbNuWKdn276W7u1tAQHKYoTuke0QYOqRVFOPGTuw7sMVuH1tvxe6+07pfgzCxBWHgOmOHxLaRI6l8cfdC96RKrurZLx5p+1fbtrIvLjk5maXu7q6hW+TuGrm721Hc3d3d3d3OXmtNGXOuWXv8vrGQFuwOIJHF3gb74xKOlDaQ3i7cPiD/iKrrN9cWTJwd0oZ9aQARRR9GSvoLsNWGm9IAJ3XYLVi426raHTgDhys98PjWiXH6sZJfcKLZhZOeNkAXrkWXmjgjxWIbEbK6sNObrhQZMbE1gB/Oish04JwG3GhX7R4sXAfO7ACNoGq34d+FGSOjLUS3A7j88d2GdZAcJhJdqiS4bSRJkhRZs/9/65ybkRVpCJIkt21mFgQgApBz+P9HdXRubTu2R1VWymSmzZrWnk5/wLbZ2rbd2a5t27Zt872u69yyINut2wZMW1t+hJJIELi4APttV9q2ZZKb/0xEy4OrMZMYIlYvM8ziLKPZPgsxMx2CT8CnoCWfAMNA2zXf902bToDZ41AQe0PRZDJ1arbb7IgmMqQuRQrNDKOso9mqicz2lBnShXiijlQyda4qbjOzPb3G0FXtiDlcyOYApNBMKcOYqatmDBnbrYxyVzEuZVObCULTiCky/WaKmNrMnDHDZPLyijkyezfacjsTjVJDuzbaUugDmFMQM//qzF0ecy6zJ1TEOgWzu8pMU47mAIwiM4mlzGxPKpYmM8NarMg0sdkLE2onN9ubGYVLVS7JkS0pkvSr9RdqFJjjnhgbitE6f0T8CFmy7baN9MSoEgEQD5QcenIOv97/2lq2rW1nJGEYljW27Tkr877mqN1JuSrFqNwoG+M7KryuIFltm7z0esINMFKSX83T/693YzmfarMFv8PnCCzZat22rW5Tq41tt9ptty0zSEeSBZYsSzrwg+8Pz++coyPJbpqZ0Ir3WeXfYdplxXvu8rHu/Ru+YWYGh5kdWjMNz+xCJ8wZxl3YYT67sILDqF2mXVlxhqdTXeWtAgpD31LFKd2pXl4nO+4wM3eKOZ6QKszMTENhTjyoDjMzOcwZ5tFq3Nl11TCPwrBM7jqkaBfeMnPfCjPHpcwyjL0LM8OKSVKYOcMMYUavQn0dVjhROF2jDpNSXgwuw5wMh7nvXQVWqCrPhVWYmZlpxwp0r67DzIwO3FmGOXE4W+Zk6VvbtsVtrG07n5ERZmYY4WZwGDrpgCHpcNwBBzq245hJJnHxzXfJ6alnFZ61eBbgmX3m+XlCtqAklUqS2xf//6ubaNv2Z6DxtVasaVoYrK7QV49hODiEw1222DpO2XPf8vPkYJi2SZb9fUmSSupN3VuYQvHiPrgMDO4uwxQDtv/rm1Z7q0CL1b2RpkmTWqTuSosUZ7g786Fzd3c9Z64dzN1dKDb3DRl7kTPGasn/9/39HkdsIynS0jFjU3XVPPm2/ydJtm3nqnvvc0733mcNbx44k/47uKO3ERzTi3qDAdPi5AC19IDT3wgaUQYUwoLQrgGhPguI0uoAC7hqCCf13khOyUlMCzgsL9qErZVK8RrBqeVWguM5dizhiltiKpy28Ne2fii+8eAYwumPcobSUt8gBv6WcCj1je1CRnCQKF7pmFHgAt6SOF+0lHKqGzhbuVoDKTRAE9qEAg24PlwE0Egb3igvZUvHhuSQYpnwPGipNc5ygR6UE7Js227bBiPI/EeWL69eXyFwD0A8pK4lO7YlR1JyFSIbulpV5n0jsrvR2gX8d4AvjJEcgI0iydpecNy0LdnVIDX3HEMSF8KdJEhy20jy3tzJEGwAjQaefxKX+A11/F1nZfX4JzHg21LCM0arZzNVET2bQTh4NiMujAhgRIND9Lxu8hEReW8eGbXfDFXh71n4HZKfzd9QK/zHydMflc7+bDA2jvTHaU5fq9n/dEr126P271nH71DyUsQvH+roJSvBP799SUfga4MRmr3FrTvqRQVc+Le4TRuB1Jd6VXcPyTMGtRxRFSPAz2u4+9leYNUI6PX1iLJ81Y2AVX3mf7aXWxaNWKQjYjwLMvfz29BqBGS5lmv64qDih363yHd8r9+a62YM/9nQ2QG/dGLFErLgO5QIgVkrgbBy++2x9c76q2ZktglV1ME3Q9Xj7nCt4g9jh4rHb+i1FF+24+jIHbfjY+OWsxxUaNauulhmWdM0781XpGduN6uQVHbuT86rvu+LJSRAFicakRRIqUFANP+d/+We5tYAE0/BGK3XDR7GLvedSLWVK9bGMYJYLBjjuJ7LmFjqDpDEoi6LR/TOdBsgo0YsSiK/bidsdjvQLVH806modSnFEKvVr9VU39sfYToTNqcbfcnvj8vElnn/BRCTLsiaiFVNqGv/9XyhoWl2oG3ZL1ciVtvtgUspjNbA39OBTdyti9g/KhsDtaWgft94+urONaygzfcNxAi6u1Af9PvwzasKtZgegT/o13GvlVHqvX3ym9dWPujrgJv5aNuxyDniaVZZ5VVInnjQZg2/LYCg3C0PLqKIiDGkNdhZsSz2DKqqIRqz9v4cxrCc/Lv+5MwNI0BxHde/dBrCXNxLhX3lvsT3vStyXmLh3K5+UwgOVLSNdfmO5bM8b7druvbgnIG4YnFqu9CxujILNnGHov0R55O/wurBWosjoLBLlqccAbCrf9gkdvO61q/VZXXroml08Rwi+9nngOgOpZBRltwAA2oqqQFAW8aaYIcgbsh52gVt20sgxlgcuagfKhkKo2acENLtPlOPcs/9BpHflgwxp+7O53HtVBvFZEy1llUNS5OTFkJrZT9bXsRZxRANVcdGJRNOI9ZEoeYHzqcSygMnp3UXFDu06Fhh9M5CTlFLyNfr9WlfGWXHrzTiCEvvfxQpYtkAy16R9whWxAsqaGFlSqg3Owt1WbwwWwQMUEn8uiwPPBq3Ps0fA+/IKDkioZ1bGiJv6VjSN2ZsaDNppJeqfWoJhGZ95imkAVGu1xRDNlI8o0TLJrOKA2ZD3xcUwcEcN/br2eiyFIiO5yIgM59kDzzAGlgQBIHb+yIeEXHN9wSEHi0BWo+YLbM6jzHqGfNF1m4dMreRmJy4Tedfnaqh4KzBvRRXJ0CIoKeFgpH942MY5qWYvGkh1QMooGJJCUW73okqGMsYouz3mrTQeKLKUhLSRUa0pDn3CDeyD9rY0mFlyJ0Xu8AREG6DIBhhUBAEwczLy2k5JS6+wkhM6rO8knGElIwvo1EWQSuDIVdh1wHuRA1BCOxy6ttTzDmwi7qclpjSYlGWgAjKwCFMOfzswXfdWPiZn6Jx0+gXe8YOkeWckLg/7MYQQq8ZLxulQD5bzpQfKWQ8IKQ4qVp0AhBSJn+OabKV6bzDgima9gFStBYs/0kEIR/8+qV99oBxKSK0YRsw1wUEBRrS+2/Mvg/Gvj80H5HLANni3Tqim1NwVqpAviJ3LCntK2J+kZCgzA+ZB2GIWRUa9vHYwhcglvw1hRZogI8rFugSzMtEkSVEGZK3jMigj2vrz3VKscU3dkRU19b2TZ81TWYbZ/NsFtRtQ9+xJ289SPEFDAblZgTEEFCRXsLxMacEvIy4yVxKKYfV9bhIDvAWLspPVELnWGk45wgtbBClEBEWQdAzxfVqYlvmi6AlID88sBIRSe8lQN8OQxs4KfuKEWN03RBllYe5lOvqZ+WR2e7uejRdz6crGyzxy+HcOYt116XJEmGwjtlRToKxS/s55dQ5CG7tC/vFORBlmU7pnpzMhZYsIhYSqGs6Wyxy3UcI9fTbmSm3SPWxJMr4g76MTC4+tcR2uQTci50ppbZ4JFfsJbhNTCmXE1+SgYPbcTHSmiFeolIYrBSNTRdTSoKwPU4pjyaIxBsFvk3rst4Tk6udqwMiQbM/ljRNuVWvl178S/kjj3gMsBe1BRKSynuE+QGr6kUVQKZorRFgaS2cHaq9Un0tdw+lpKFuB4K1O5sQ3pTPveOgdXhN6Pqmrqu1s0MME+XPrd3dnTUX1TayVdPOlICirp2d5QwFLenDX7sYjYMiSK3aHZf9ohPWlqUU7+kP1qqLK7YWVS5L140TfWwqa6NtcQgaQhidF9DXp9xcHjACoH5bIAjqWydTIww1cd1GzEWsKbIaAQiA0AgWZFJHPxbbhODshYexH+FMno6dtK1FJFTU3ImUUkbaYhhVkW2rtqJK2fOilxHUhbCV08+tPTxdrRZlmnJuwvQQ/Xx3jcyts4AAzKoGA69l03wVYkQ6Aj/x4LlNOYkPRGO17EjEDZuoqhCJ6lIcC6SMsxc18RPPVjkCoUPonIZyurPpoK4aLUWxMtLTwnVMRjUFJUfEeiypTMSJWNbHkuohxSNwqs5tTU9tgJd51dt2wbBu1uvlTsCMqwVoB0YaQeezxkvXDpVVZhEYrJSSn1oIjp/C/Ksf/lhraut8W+SxBYkIaUlrT3qw9CncBc47G+fEjbN1PfSMWB4jefvAwv/zM/9Fs2W/eX13JnSg1cnfFo+RwI0B105G8KW83FZYl2UujeNqDyn4eT2mDrwFZX0sGl+yIIqTbrN5Wb3Fbg97bYQkOQfvSRswnNl7e3mnYP2ujUkfDOR137uiiWcOQC/zD6R6KG5y9+jZw5Ii2FyqGOPlYdu0Sk3TQADRFgFR7pbFDEscBFjgGvSuIIpcX5dCWOWQb1KZH3gQR6a/41NwjbxU5vz4Max96QO5khwf7csuBEC9XDdKrZxLE3E+9JnuxCpD/Z9bdh+TUri8JTQ5v/6kOTQu5XT1/2sOYwAzNg3Pn/Sha8YxYIN6OFRTxcmUUJamOgdr36TNoHXPYRbjsSREdLE+Ak/dEw8O71ZlSMp0sTBePrVEmrBVPGbysvlqw94Nabque2UNh2Ub9y47J6WgqrXNoaLChAYmLQ7K3c+/cr1r3hh2Q93WFQIt8TsQ/XrZ48MJVMEvnb4gFgEcY87bbWO1wGw5q6KqMA9xyPD7Njdnj8+I1sFRoUGxTpSIqiI6V0G0FUbxrON6Pk195xRc02yT81K8NSqhAdpukRnUYi1II0gukDkkol3rxZUwnfSIhANJGgYQl4JlAYK0QZsPHm3cPBjaGTQPf+/7Btkr38/nncqpnmJ/PwEgo33KSloKD8Oi2SlTp+ZzdqR03BAoMzhEGC20niRzzvtiW23PyQgTYERVbV7GAEEPRyk59zQ3XZ4XZzbBOR+B6ycehHVDJ49hL1eAwjRlKG67NfnNiz4c4sjp9oPnGSldZPF8iDHHgJsYIWT72KotsCUAOLauPEKTaZHsBllgfX99BC5TYTEcgeurdkjpPsrlb5fbOq2EnZQmt9zC6M7LbHc8L4Qg9hQRgCdppichpR06CSnBWgOoqLb/0IeF+48jubauqqoOPsZYs7WOJGHvIsuaOs9pquzdJRB4NNwtAeysyRu1sTOEbnXoZ49Q/DuUoDF0NOAi4NQMPSnbm8dS1AX0BftGHHdRXexQfAgWQEvTt+XSeSzY99kXeQxFxWhthJKQqInGfGkuQ+or5yUXCVdslim46qS0BQkfZ0TkrEskoZpuWcoWgoW9b56NXN7SboEpdLRDtOAcpNH7EmPdo1owAVPuAyEYGtW6c0tgtxCik1JKJDpxljQ2tIqlcBP7TQ1hnMJBJ9mfY6p3MkQ8ZMSYU4I3HC76PRFZvp0WJrfg+bghFIwxB1Tqb2P84xSOX0SYbv/a0pwmhA12gFQRCfwhlEBOBPEa1Tl55otiY917Oxgdg7JJWdunlkBXcu1iCKvrIzD7Q2aGY0kPX5xKy2VZxzBMM33Y3WUK5C5//ewfynJVNYM+OGkAe55lhTIXmfbqfHpF2d2MkFnE9cervm/6izd/apC1dUQSqbd9bU8APlYo11giWjvnKYuRCCmr1uvZ6zuUUPFSTgKyNWxJiaAOQ3HGfMSe9WMoT5U5ZQjl4/EyPhXTFO0duy8u2cVYp4yeBrEMKQ6W6i4x26zQwWqxmAoeaoCDQF8Hdr2am5hx/asZ07RcGaKEJ8026oQ/RwCH3X7N6Yi7QEWe7055GCLGgezM9FfWAvqTXQtYU3llR6c7QKCYYue6mOK8VIpsDSKi52QopFy93X5rJ5GuUlDcQLmYICIhhTfoLG75tA8l7p71ZfRtGpjo8u0pUpe7N5GOR3JKfZ/QO7tcLjM5uiMw6ujmWRXwiQdvAFEfeuY2O70oSmPVCtCQjHoRZcS2vMZLBomP0nMAaZGY0hX94Ac/iDFxNXGgJIaJWVSKGO3o3h/zTJKQ9hm6AaFZ6iZTstefFgQJYGiPYG3fFVpmSajYta3bZda2Adn2aLdcf6KOz+u6De4+WK/XzFFCROq6AWCz2awu1s4hkYvvViRUxD79y0dIT9cGYfF7vwhIQYlj2ZGRosZotZwYbcwNJ0C8t5iuwbMyvHRAYpuXoJZZD2W/1I1AUmyQEOXizHoycLXoZFFvkRDKtFoRsYASQIRCA7AlGol1QECODPk5vgT+vF6ud7udV5Ix9YOx6hwXKOv3PfEnYfi5R6DKFV8vbKX4Qjml/ZWzsIUKCp7nZnKTyOkfjJfs7MkNkZwuynBhiBhKaKq1HF/CNqbxzxFv1khMqBZl2d/drfVudwecOgix7vYLWzupKCjbPzuMbE1w88YCqNh266xidgw9ZHt6LwAyRHwtohYiCoaIEWXm/b4y3gylG4Yj8FC74eqJD1TDIAwKBtj7SjFJaYlJG1pYNLRYGGiaz/7tj2weGqW4CHZmK6WQdCY/00tpOFdRUMg8CFq01tphsEU12CVlcVPH9eCGornYpJJUNkTSMOu0WguFhXORQ9c6V0SfWllYxWFo7CEBL8vNTlXEF42RIhX+hPN0tWFFHMnFHFBUDl8iHoAC2QY7nEB5r2GoNilYNjydzycWcb4IQ9q1vaUu1WmKXz0sHKn0mTbkt0PcSDAAbkCzSveCR9ACpI3tx7Efu346i+DuqK3sp17XD4wAzxdTgRXdWEYhA3YtkFKSAu9ZS1YbsIOJpJf79foBikW4XleFuVSaXylEWnSM9axEYon9bT6nHpk7jOwpbJqxP3nc5wWdZ4cyxZGBsBpjVDVaMtKYZoM2rY0itEYBUKC9mgBuB5wLTNSOAAMgRhPROJz3lkm2J188hBBceQSOW4uvyvYi89IU3vvcuoRtkbfcCvzJCmRE9nOtNXuO+bNrY2WFpmt6aqGT0Pd7rUbMGNlu5/ILaxvbFK8V2XIbN7M3h2y7beMgyPP4munOWCvtudfTw0QlTbNUeiKEAYWP2fLYFZHPRy5IOWjoDS7F1tA4p6HaT2hUlhvRTVdpJxIifovIH84jwqT6CWIzOSU8hrFuX1rmBE0rIDSfl4mHqSHMKnwdkVb8Fm/FNV8oP4tRPCq2S4s+yzIiANCTzcl9qdBgGihwOcTpgJyz+OuDwhfYTJU/Hztk9myqThTC2E0D4ADMTw59ykWwLBWEKVAAw0o7HBn1FGweOwJ5vaSw63goDodD1xgjV8x8w/EIPDzxINxlWs8J58hpXR6BjyUldszfmuvWXHdSLvvggADzLp9xcOVTS5w2/WaT++TDPaXfB95LspL6DD4zuypYG0UAIHHu8c5stIPElceSnOPKrNwbdGnCA5YpxW9eXo7AyOfn8YkHOVLlO05GP4OPfntnxWVikn2zlJfgTJ7Go5Hmoc/1ZmOwmptQyTNz+zXm8oFhVPh+mM3iWRAEO18FQWCXTZPl7RBpWN8B2H/YOb9IBWT3PVyFnLTh0w4IgQQ3KckDpQSuGYEqL9Kh6KXqw1/NeGNtQWk3mUymt7St9oZknMaQgl+/mh+ELqCAbeIloXMaoQOKIiZX34E9ge8HZkwHlKThY+50Au/Fgnxk7siJMCxoCMA2VZU1n6gL72PzV4oTJVQdS6o3vyFPFYMFNDShP3H6EHiSvlqn7WFqpsbgjtnwj8ZAIui4tgih00NBDwnfoQSvEdDmUWZ7B65gaTlNhTh0XakD0XFZi9/0wxE45XytD8hJKn5aqEuXUP/8It/qXmD8tMOT16bIXs/nVPP6boyxO+QYZLaxSqV8gQtZvNTKpVKFhARTaR3XaDK0PdbTwVKI3xvYuiPwtHziwWRIwzgpHVku03AEjtYvqirP2ahOgpp06uaJBzGN1M62F7C258lCZUISjGzWhelyTF6rs72aKqyCIc8ztG3b1kPcBrW0Q1zPcgLYtQ+K6m4kuORzXEtjCATnWupE7Y3aN/0lW1I8k10+REpGD87hiJYRWyGA0yvvbrFogFPv3GQlo7iPorVfr/c0sRURc7BdbO7m0kHIfSjQgXWgOrB9bBkQqQOwiKGSWpRlaUUEhZHEHwtyVZyziLXHrN4xprKeXeqnEX01L/qUc2am2qv3p4VjaRgBZXLbrtfzg3XconbhyI6Afc63uByiuqLGuPEIpsxoFGFWR+QtguiAxGLiKNpvurE7FLjUd82IMSiKeDGiRUJ5gUg4jeM0qaJdikVFl4H2OsNqf/FsHoLaHZSC5pnsPZpM1YG3HlBZpDlPhlsmlCMB4SzR1QTG4qqOobw+Ag/t7fRY0kq9XPHeMFsbAhTCZ2CfWqLK150C3StqJbRD6soQAcqPTKyZ4ngsiaVlbsWPUED7wxV41rQjumDzYNbE9RYxjusmywBc0DIkRIK1JUQyxoipVoTwOWCRcyI8lfva/yIBzvvTFVCtFAHdVetYgXLjHUUjIo6QQIKNCHjoqzYI6r+n+9j5ZZnv9jm9O6VOBot4KyGmscWJ3D5clAlFOQMibzgUQY4UjwDc/PtZEdUJIfV8AaxtAFgbVN57kAASicVj/mBFplleEqeYJj1GhK3MJwVLRRx9CoDQnZa//I0P3REqxPz8Re84pIBKUUQwpQDwXlcWkAp83GZSOgxPIrpHKAmoBBCWrTt2Te9hYhQhfbW7u+uJ5IZInp5mf/JHdYCI3cZYrZQh5uWdYjqX+S5nwlOdNxK5UogYyphzn3ud9wy0oyGqu3qNJzkca1Ilz/P16I4lYT29Loc9vjoC1wHdGLFMbCtcB2CNkiCzpWbaz1u3OGskWUtqzG+gMR1LIvPUEg/yPK2pD232FoW+Bbi0fb5s8iD4uL3/6jDrna2zNTpf1bn1iF7xJkdDRXEWijLlV3MFDUwnanqFV2CSkdMOkEKzCJhYPcsTT4Nh6ZQ1RXzKRNCBx/AyTJBR/KZf/Ghf/fhqIANFpAhSjEcsW/EQuOz9oymQnhATc4pjD9qQdUQefauWBcxilYbhSiIpTZRdA3mfzFecvZpNGtqYkdAqcUjsaZnTO5TYHCz4pURz6mO3VmcLjR/FKN6HG91KTel5nyg2cBhzjjsyu7WIE+H5ifUMrxNmB9atZJ+jrLZmVYapQPQYoe0ORIY4W+92d+tdc1ju+lBWawnVl9ZO0FkIifRKEQANQee4OpZkvZaWuJIA+VNLRGxtc7eb5ya9+KAPfvE2JcMx4c7xRIaJSBaepy4pj8DfvLbrWNIw3N9fX5epcyy+qBxK8egEeExDYtAKjurZ/tum7bKsTSKBV5AhY+MnLSgAIJTPeiDzmJuLnd3tmoL19XYbsaZ9UMezSilri//w1frE7l/7FMHfnfhdISpY/KV3RSknvPD+cL6HzBIVeV7kPiE46xiwMNC8FtTzNoH3vpta8We8K1Vk11VFktnf7wkkXM/PFgGAs5IDqfaXB2bdYoEYmcXnANwSiiKSc+mIHh7SUGvFU8nSGMQUJkDY0yODbc0gNNEsOY0WYxAW3b4PPNnc3RnoZOK70ykEJ7VeX+NiYbTW0KU8IFS1LXNVItiAt2WL5uOTRUDMY5aEi7IsF/Jurb2u59//+LTWPlOIFEVM5QosvCuf8mGaxqlZ5HTIfUJDlZTViEC4G25gOWEyTBva0fM3byJAeGNEjkAUB5BpoqmxgzlC8XAG0JQRFFB5DASWOE3S+KGtGcvH0fevr+08llTi9Hr69dWPWxP+xa15aom4YA5JDB9x+iScKpt+qLadKeNPT2EB3kbGMEE1r8yELdIIiJKsv+9GbGgOVNi6JoA+znp7/uau76/vM9ThuP/1jIexEmD1RZxft8KWX3mr41YZx5vIGxNoI1UumWTLFoFUtS2KoKenT11JnapOeBP96W7/ROw/DOusjmgKTO05DGjnIlBtFyfsUh6GOuHSqK7ruktlbUZaVi2x9Kc4ZOKVvRGKP0a/HhMwBcS13/CFYn0zrHFzOLBFcX0+AjvE+cbaB55rkJmPTdPszhTTctM70gKqfMm6S00i4QtV9sJAx5syt81Rd+9KSR822Vam6lOf4qGQ1yPQdmpOz+x4UHTWfs4VQSrozre7GZemv00vxjv2aggWi8PQic2fJWDrtLEaYlDnNF6SI/X5Pl0rmEAGPfcR0QTnxTKjQd0zNBi3ggIhBkOYXk9dzQ/1ydYhJKEeHofHJ6sQPzkCJ08tkdt9JkA0dwS+LTKZATcZLn+7n/v+s4tOKrhyztpktVqlTzzoVQy2yjQ9SPQMr30i9yy7fdsjId22DjADM3nY9zQ33EoCIeyqteCgnPauscX/csZA7ROnxhACMuGYZ5tIoI5bP3VeTBW1ZSE0Nf7VaeYJO5SlSO378+rNnEwJ3vbMpd1HfFp7AIJmwi40sPTEXQSL9NB1e2mEeIi9U5wLkPuN1mojEwBbRzd/z/4mRSNBCf7IaHPfOdat7DJLwma83NMqhNVq+iYlnUsYx/PUuOsmXd0YRESbW8lVKZ6W+XxGQ+pEgExZ4IiG7bQq08NBfcdeVkOGgnk7Na4LW/sJpubBMvPpEecG6uLsecJxu+Ox2b55MQkzGQNqQh2LZc8cWBaBlCl0O1QwHSmrna8PgD7kHC2qOwCBBpWrWq4RAOfZX6Z44KOnzGQ5lHVMhweu6zKEkB6BU+Pup8OHHsRjSWIlHNj/dhUG99Df7ehdfw7TD9znCsAAl+XDZp6+uj4Cu6rTsH9uOhVC5wGEes16h6AhkcTWXMMNbJ14sokaq1UcAcIX+wVMT1CLLwwExpCg/juW1ZqHsDDnUql2omwFMScpJJpjc+cROHUG0L4LDBCJ5M47jTauG5LgAUBCFa17YTPKg7sHsxrX9G7tWqYm4ByKabpQaE/UfLHXYi4ZqnAiNJqz+EeL6FkQKiG95HMB6F5fgXOWmmu/G9MP78L2k1fT+5q8QgPN+oFfTrMu55IhAZiEL8LDpFhGairlERTvPZICHBG5SmS6CJXL2x0dxNo/4BRDiaF1UIvl9UM+X9fdztpJENH6Ki5d5L45VQj59sVgkfvl3KYbYIuGKILFY4YQh5Bgb0WrPUwBRCc7Q58PXd/b5dMmNBqccyMCs/ESQ7+0+DiOsLKPx5JeUo3TKcbgYoJYR0fl4K4DQYhkBcyr9fY2LgUd14FJVjCys+Ar4fStpZd5VoRoL/YVhOE+DDnQWoQSb6USkU+F0OjWShIR12URplUWfI2Ug5b98rTYIaYUFZDATQhtmlKR4xayddNUMxQGMbn10mJ0E5oYU8+zcDLgn5DhkgBQPewtlD/uhgyfTruc81TW/+BfepxviND63dY6W7fWWaYeMjpIWk8WiznmVhPqORdYxLtjlSJGEZ4AlzcpEHVhTCkVTHimCP2lW1lEuJjxRWzKK3+QQsz39R1CupqCBnKzIasiODRNgLFFOijCsR0P/pwWC25g7c7PiXfrGcjBOMnyM+xT5iL+dBVRAFoMthnZWYApJvvAeUw5UWaI9S4jKhy2poNEgF0C+CwjHRDQQmdPHg0LsYmpCzHoYh2Tg5iGSgNV4uWl9M0F+Iop1sQfPnx9Xc9PMaGytklNqXtqidSlJSOgUYBMqpoY1CpdxZTGw263pppnYLmu2bxJMANiyqTBRQkSwjL9PGqhpN98yDgD68XialpyLokKBik3fS5l3odESGmwNUfDPub+IoMHxRQYpDJg0AKaCABoKiNgTAgkUjB+fBNjh1xUAR0ZbgSiN8Jw/Pz/+pvTXgzFcSlSgAOi5MDqtnVE3jEqy9WBijdQdOT7OI57IL3HFFBfyrqtEQAkAIAQhl9xKY5MQp03YJE5v8tGIiPjwZcSgticCNHGtV/LkJM7fa1qh1IrooiICVslAxhiEKpiHAcegJgdtqiMeDQxQmK/cK8F87g+zfFSlwbAOiBmH1P6ZHYYUrASEffrZ022nG1IxiRD4sxu74IV9ALI9jIkIF4qFt2WYhFZ1GNKjUcrnkm5kp99h+QCcXB1mh5Luq8HPAKXibNPPIiR3bS+vw5WNk8tEexackqg1iEYGMoajez7vsfV9cAgX0xCKewqmLWGpUUpOYGVIkTNxQbMvb0kLn14uZo//XEGtZRvzXXr42QM7isq3BogYwSY5fpaxJn3hujSq06Rc3WCimtKKZl0JVpVWImOMD98dFd7Xc456IQA1nnX321wU3K5tMsW9MGvn3jub65qcvPpWNhIyTPZV59FM3F09frVaq+haNja22Ebx1mxJJJqQH4pCORsHA91WyNwte6eatlLGiKDzIjDZt38h1Vk22RBi+eYFss2E+oEVa3ddIkKJ0p2jwjL79d6S4AO1BanPh8cGNw6hsw6SMl7pJYX+GwKCE4bFyNVAApIQNUDYEl9f/CgTCmEN/fX0Y62Gm3qeyxiP37K9BiF1U4pUBM665yrj2G7xY6VMUfG5TTkFMmKBWkLdzCqRU4+tBfCU0voJx68Lo8l4RTfrS1rrBdteAmT9geRRaTOvJkLE9UDZMtORzCGgOWVe0NcozgvHxY3NtgxTcLsxlZZ34q9ajcR3UaCMkZJKR8JpSddR2SmHwkvV5PDeK4+9M8TahEJ5iLZ4lIoUnTC9nA9RmBOjyVFsLEW/+yJf+LBBxBBJHsluPZzQcdXp0dXj5HoUNHyO5TQAhvy/n5RsO5yOvW9ayNhMzrFynDDLct0QrbpGQ9fnxw69F6qm5DyGEUnwUXkl4PWgM0jyw9OJVZloHrzush6BtITFypFabfrsk76PM9yP1deyi/6m7osJYJn7CEwmguwDtaFTy+3TbusG3h9/Tmze4+YUdcfXn2V4WQi7WflYXJQzlPZjFCWebqpEDtAhNAgYEQmZRxBQXdgRcezCSNdfHC/r+uUBermRm8VQY3lEUY6PS0YECulrX/1avZ/YTx2alVbxAUOjaGUb+HE0DXjyJrpspVzEU2rNvTm2sUQjsDldYkvYgi8fz4JbmEu0LE3g7PzvgVQ6mVttIZYW/jwHjTFcK4bm/DrfWiL/FJLBnh5tcgQ+s0X5WnR+UID6JyCLWbvVmU4H03iqKrECnG+aM2t8f+E1jLrjnEQ2WwiQBpdSlLvMeVF/Tzf5kaaRkpRHFAsoKolfmLhU2fh6zzteVnz7Sd33qGz3XiozWSs/NJZEhd7WViyCqcSpTgcDFSD27zeLcqJ9s72wrya9/tX5kIbbmTTUggsiBk1NtHYe7yWp5MNkXIOEaMqgpX4joOtAEXYnY2stTuOjh0C+zXIyd7oO3YtDVQVCcOWXoqJVKFh1iwmJkzp4hO0mYgJ7BoP740sghA7lPXCgVCVbS0NWFR4LykaUbYh5FqwNDmH1Ocx5bi/3Gw28+FY0nhXls87wIJog2VmHkAY0MA1ndDBqOkcI2hZNPc5pBwaVCxw2/ciq8TNXOcPA4YQiCO/fEkxLVfJ6rp+yc8Xx5K4gnaYsheu3uD45UUnzfeecwzIKak+jaXxza53UdowVPl6XbGUWJox0BS25aff6iNB39IG0KJzscpPVWSjIjNtWwoGduv16QVotTuMBHAV7IjtTRtCmR5LqsWVhoZG3tNNT8kJKPXGZHzUwKIzYnI4H65EnQgXtupiAPYEzgHCfj1GLsDLsAQNzEbExdr3PTOPJHq3VtpIgPlKIi7v+KhunSZsG0Vawzprz700h8XnvO0BlFEJOlV2siN1dG2tIBZB6kC2MWZe/waZNSVseziYvvUaqK37ibDMCMLEEOLnSt+3PUwU86SBzejnktK2K//Qj710UdzWMgx2S52pdWeVOjgqjgHuUp9TquN5KkqJf8Pn2V0W6m7eVxFU2R2ijikMLYIMiFzvp3sbbXIARkCqamLoaJoOa5dzsF038RyTZobLwe73HEa53XrYuphG5yK3IZZpjEN5BE4sgFq5aHTuZ+FxeDgRqFk/1PXgWZwPZ16YiihWgZT4XCoGucivYH+nN4a6TiyMM2d0rgsJOGyNMoBiwRhWw16p0Uhxkhu5PnE36J2NjPlyQ+Kuef3qjSsd2ZNeJLJ1hQ5RMHpupkvF3hXvmLzcWHu31mzmlpLzLY5cHnrXZVkveuSiO5PLw+FJyhfU7xhML01RIxEBEk0XREi0WSmUkqqgDRwlgHiHeEl5g0qYvXKO2O7VzSp85UnoHeqVRGi0hNSr3+YURBVGGw/rRxR9vEdCzznZnXwsMSN90AUkRQarVBPatbdVBIL8d5SGzu/8g//riYYuFJkXT1kVLiMOATkAUhUMygllb49iYkr5+nQqWkyi+Q78R/B7jqjpi1J2eA4ARp2/GqidGB0aAF18AXPsRIm0lHleF5YY01MpSBwzFebHq5B/vuZ6/CEyc/3OqaL60ZUpUVKGY0mvpqklC+IfLCVUXucK05SYePikLCfPjyUJ2076Qn7v3PstE6mhbqXCOPKCKSFcdBUdgZ1XRkrpUZkVqu0TD2Id++fRBT6WxJbYPbWEl5AyTXLORNAFTj40H/A6Wiklsa6CVAIcvjXXbfGhMovARxHS2lp5tqZX//PrEhMoGZVCnS8etQn3Hvov1q2LG0ne+9OVd8TnlISInULvtRBAxJZIN+V80UkiOg/qWENCGSJgvkRRdvw8Q0hYf7Yy4R6Ka0xK0cIXWnLOBCnlbs+dRC2LxwRYm7s93eFgbbfiWhgjqamynniKpNlsDS4Tc9ClIUQp891p9px0SmmgSi+xUjaYEpfCGiKEpnSugqnuX3V33edmXe2QwD4r9GHZZFlhNKrHFGqRcpgscIwWiEJgnk5Xj/3iIXDdWdfaOqSYoH5cPH+hQ8JQq2SZliq700yM9fWxJPfUEnJ2LCn9eevu74/AacQacSvzPbPN2498qumFF0+iTcuBob0KoUVLgRXkX3WgXr5bldKCcR88v+xiRGg8tAuzCMPK1avBWkQ/hvrHpM6Ay9qV7lgSgV84YdaKhWBwHgIvNa3exIGt7T02qFzSYCZmpZvl9LCwtON0Mp3IqgB44CV1rk2oP33keHtmEdXHH6tYqFxKcfHQW/7QOTCQYSLJrFJgjROSPHQAAGaPDsEAc2w7xJl4DE1dtyT5spBhOZXKreU8FXsj0s3balgcVXlUkanPUVgNYHbrdxXfs/oBC4VHKfHzZMpSD3HvevRKEDV144mYJT/04DylZTgHXK9LDnRGRIsIBF10mJyoK8WPcYitVLQAn0IrUwy4N+n+1Gg79tKbrguND4bb8erJ/6rJIYRjOjYYlbXxTu5N8WVbH0Mid4B/FSMUJ2ynTvmGZo4RAEaL+duCSkehjFsOq2lpLdUxTbldXaeclDWe7vqYkFTWXuwtO/ErWV0sgev9PLC7EncG3xH/2TwDZSv12V/0aTChg3Vhc9+6W7q9am2aEiiOzqU82hTvj8Ar8W8NTy0RjiVx8l6Fv/JdnslDw4GUPud0ASrIyIZqXTdga3OYDu/Kxau9d9d3XPFqXRJ1q1tcWdbF9tPar80w0rysx9z6h+/Hn7Bwo92yneX5zLmGQWfMQ2axI50SyxgBogSG0hg+tMEMJnKEQcGDigCcTzZCpHOGbDLfaGkWXBn+q5ctOHQ7Bauhm9b4/9RxtNY72yNtphNtuCwGEJJtWWIMFs3ApLQkxWl306Ftcze5Kc0Uj2EaEb/wPFT+SgNYG3LTQsfNtix3j5Grge4gidBKSfnWSRfvd888J3WARd93/upyN8/MT/6vliyispUdiYfI4iySsiwQEZBw7MTqpIUD2sosWjHl56zIRVo2IaWtWh1LKq/L9M2QDs+liKm3Yxg2+yS9tU3WZbnSFxIeYoh1+erNeZ4V7cpZPa9olfL5UibDg/H5PlBRpDnHIXV/48UtZzn0GvKsuqnLfSdjWt7fX5fDsaTraV0O0ym6OI3JXZtmfrT/t+V6t8xE8AifK3JcfWnhTGMVAy5ODpuQHYtAAubpUxOpEW0c8OVR5EqWq/HAXHc725ZiDxNimS2qW6k2tMzrICPqGREi5/Q4iSgJldZ7AzTR0QUhUZHljS2qrGYgkSTgNdJiLglomfWIhyc8GfVAYWx2zNbSAV56lqaLYfYODiFVdBBmAtlAymfecK11si2ujQGIYLE4HAz42G06TRULTzE4y5xp/iUAWTtOB4xY+KjLzp7mZQd4LEpWVZuxAYgXwR6gSsoU80MzOU7gqlW1dv+uPMPpVHsD/fZVUD+lLidIZT0LaFZPaQNsiwy143IOAClVGGIAXUUm4vJYUlnGuQj1/N7rdsJpYjddN+5z71vdAHYXvqCUTd8Pb9i8vuE6DWwlIFPXdPOOmPILQnW1MI8xxnH/kDLK09MLL1FSoBsQftDp9FW5Kss0FUAE1ZxMh8BF+Kqs143Mmrx959yGf7Lswbkx301TBwi70LXtaJ0+fYcS1gEOEwCcvqtUCHVhOUTCcG58izA4UXXkTswyPF7W63MWf04/ghtCAMAoKQ3QkRlDINdrEPyRNuSZc8uIKA7ugJasjiSgSYEAiGgjNCNs6nrY9l6UvBoMnV/f1RscO38OZAuLWNYgeUezyjnmqowET4CkdGsNIEIB1OeQKuuiiMBZdzVtT6Bo6IBoIgg61TD59Tqkg0MthRvlcipYT4Uh99OdFwdkjFpsCS2CeCxlwJAILlMQKeJcYYghtu0dc1nyMh/SyMzgx6ioIWfjdbCwE4xBwQ1caTCzJEVkxOohtcTn53ws6ZPwODzqpM8WrVJ6l+niiqxZnK5Bgn6bUbmKGO3J5nGVdEK4gy2XiiTA+V6RARE0PXUe68QCBGZuVBAO4hUmIt8662IWale81W1tXuONra04+rm0LKsr8Jb97fleT2npuaysPd76giu+4jqvt/BtlS1zv40lL+dXuCtesbs6I80XBwJEdHbT8dQ597oURBVpLZen3rELr1uUe0ByHnjIdg2S35cTliMR64kIw6vOAEibyCwOHnikZe8p4QIIBHrTAZ57AkQiSVHOJDXXRPgwxMhSyswGSApAog6dZ3pE/c59tomDoAfmJAERSa4E9NdIgNvaw6mp4vaHp92+cCQ6QNLiyZy8dyn4RXJTHvmJfc2TL15g9GIBCyPFNMlTGWOOY6vHSwKCmEjcy666ejWG4ktB4iGhpY4iSxsF6J2XV6uw+EMCPGgXYxSR/e5l7hTRmlU6ZgUlx5KcgeCML4qbKRIRoogshte23QZUeXNqE+y3BLm01Smg8d4dS2Kv2+aLkBBtCYf+8Vnc7sgFf+pNSB1FGkFLpUwluYytVFQyRTdc1VgSXE5ks/FArrFotwJ3WtA3L6pZuazlO8zTVMJZ9+f+BISB/NAQ2INrTldA5CjS1KXgU9XU/YEvoqv7SvWh5FBXPNm6sjdDW87NbHyu65568SGe4tXuqNDPeUVRIglOIHBXIxF2l+PwkPM0MWRxnM6QDmVmtnBlRCjRJRLRrGTfOikm/rzOUMooGAgmXIpTrpXgC0FIXBEKrtkQAWET7AAetEPWtnFc2YcACB3RRiFN1HW8vpM/bLMm9ZKKa4XEbdGYiufLWYFgBySpi6pA8kQmXRlqh8yTph6ADcP1PH88xK3SFDGQ5cuzX592mf1T79SplrWXNH6B80lSOrsKpiOUoiMUzjm2IarnEM6qAO6QXmayeXeaT3NWW0beI2EBiQAkAQjCuNOdyzi1qoVVbeqw1aczAmsinAnghepyRRxkJoy5I/D1auLoQcRg2+JU7lWeeUOrnGJuZnnPEkJJlsqavUc/0s1suH0eIZMaAEPBoCBlEsuHyt00O2/3L2NU3oZjSS/UuG/ra+b+kebcfLaxtbamukrzOexeUK2sBvMCaw5PUOQpD6h7QsogUKL9JBWcZYfaMtcCQN24PZ46YM14wCcpgJp0wNq0ywRUZQDW2H3Ky4t9ystKiUJuQLkYLNZBchogeAPgKFIjnF1c/pl3Dd//krDXW3BXy+JLvaqrPmuRHEpFifg8ibTTQJZZAR+bVfpHpZ5fnwDcJ+/WCSX809oymMwZy914+7fuI3I9ci7kNJSkuEgAHiuSUm5jioolc44thwy3bsgLV2ORM5iEREKi3DuL1J13r90RHEXFqAqKzN+R2LqHM8vEoySLYyXmc73rZSqxPRfhDZezemCOeUZrb3bs2qZTAmxcGADABRQNLsQuhrghrdpZdmT9CBZHh6iCyH5/098267JnSoAIwI4tEMH4Hti2IdqkkjXD8rPbe0Iv5VyvpaEIiKHeeQ0vLfc9WtlOMcUqJv0YYu2OJZUkAnBnI0Y2qyPwwxMPxuCOwLUFpYyVeSb2rznnepnZhG54YBI4EMPmBUOupd58pEL+sLdKy6yjoXZp0KvH7c3tU0vMJaZ1q96tStyM+4WhQFVyBM7GA80pVZ2Qx/raWvefSG1RKtDWRFdICJx3RVf2lgFW1AKKOwClLYCS7g6Ngg7VGqkqbOe7kvBN7wMDvrpz17BzV5/Z6vzVR0Ze+vLxbS+dfWLE+XNPDD998amtvrva2//Y/Rd7bHl9dsAaZ5d6mTDNd3mkoWO4tA5Q0gYobgQU1QDKUoz/ko3JM7ZEL4xsAXHp9xqKPaCH6xdawjK2cKqBNcUJrVFOHs+RmK2sC1ndntUqnjKvhcsYoXfATzuZubdXA/Om67oDBxehlk2jpTJCOkQhfJMtkWV5nlliTaQnnUnecMt2uy3iWhKwOFtLRAJkk1Uo8hYet7rawEMwEjNQ3oBGu14AXFtJvRdKc0EDqVMo+oxhQrutVOZ+NttdyI6AnBeIr/1s+8aoeY8MkWp52dnVqm+0eVfST/GLQ1nP9FGlDophi04t2Os6isNxHJ2iNt1nOs8PGSA0GDmyyjCmyoSsB5ctrx1Kuq90g2MDwc1rSQO4PhGfzrcZUjlNqxzEqXMr+wd3RbVz85FxygC3R2AqhaN+iUb1LbPlGfg21NxaROQYLA4Jd1oZYwBZ11MSqoPf5U88eIN6TeHmY9U19ga5TJT0g4skFddxj64ZSzQHGtWZB6ktS1RByKurijXahrPLN4g0AKpzAb9NAmyO7xgW1kUef3jV5Oc7zx3/aO+jE+7uGTYOTg6mxXsGTHZLv9VNDvMeR6YEp4vIdhAuG3LCddmWjmxjGNPCbDUNzZjrDqdMDvwb1zP1b/TtQ9+N6Dx2fd/WW7dtfOTb0wB14zDGMPXpB1noE6Dr7/eLxD3l43GeU2uJsG+C2G/e4jZtirz+Uq/qInzxmTz8iWWNKcUN4bMRixI3r5jP3DMl2N51JWRLfVisVgtyayld5UAjEiJK3gl5Ox5AY9Pueoqyj9HNpUiGeGiaIovf6IkkNG1EBkiaQ5bTM8l4GEeE0LWQdqPCQVEq8MPOg7TMlMoX8NBbuRGKixccrChjronvSFUaZj8FLQIkRZpmBMON2j8bMHTWAkSJdn60t8uzZ2jXj4pq3U3jSLtqBG1GlgNa7zBO2S3rkuLual5YWTWa9R1tJsoIQJc7+HHaD0ySg4fYP1q72IzoFElHF7boeBp/tErb2v6pJa5kqLFb51y+c6osUpe6pKqG4Wo2C2HgPtPSAGMtzhOTcNaK4A2OhL6QXLKVE+vuhxDNpYk1g2IPdP8Wi75HcprvOgO5JXujxqSsB0bLDsM9Njd2sMLagCESvIaKu/IAwPpkwJpi3XrvqkHnr5w14tbJb5PmhnabZ5sP8wmOTBUkriIKFV5AWIFBksAqDOtj4TRWgsRKFESJAqs/95wFCRWvoCBFeE9IEDiBELmGxDUkjpBcAj3bRGqs7+fxvXv6+v1y87Eera9CiMOEANsCwqodtVLhOK5tHFvovG1326a3CHmOZAQFKSCrZP/226N2OKOyELAIOefhvpj1gAxOmOcpV5L2B4gioCimREjDgel5SEuYd0RBW2RNjt0CsI4REoD1eUGJgeTitp4bNUb3f/zai83jA+9DhypKoFw9fBauOmraYm0ksQgSoqi/YPc6nvBDohVurSIm0banMkEl64t4v2rBbkflCZdarYKMu/n9X5dl/pl9Pb8qOc3z6cEaAMgS2DAA6DYG5KuNdVZTU+3s+QzsxZVX1HknLkOcBai4dLH1lCghSayKL9GGPmvRDfuuz9yk52Wlr24lOdK7uYzl++My1Vitys08nZZlLM6yntM0IlgLkFCjkhCjgf0Q2QCyA4kEgB2g2yRiC2iABJI/nB2kYI0JXGm4gbb77fO6XLGtTtgdVEvTahbwM029xm21dHwRwEI0oNYWsNa9YMilyw8nTw7uSJ3oAwkTUSBEoSNIFWYeK1IzZeVcLNwwFmkYUjBDc2oYQQySGE5AeAEROIQXmH05iWEl5tVTkmGVhrFI01iEYV6BlXFDCyIchyJTWXKsOLlmAhujmGZ7OMtzV759wlsfv2ybg/+bRfxQDHVNEGxWALqPhDXt4JVEV8frPnjJAlt33s5wPEhq5X1Zv8YqyyrHvVKvSyQQx9a5gHV6hGa1RyRCKdmIokEbGTUNU48vOZ4jIoljk/8dURQBESRYFMc8CIyAcElpCUjFa8j8aepDfC889XPopNGioH4vHMNSUMZEpyS5YUByQRAE1oQOxdXiUnnnhh4mEtei0RhfpBSRaAqoxKyOXBnqaZ6L37dHVRApMRS5e/VomR/vvkTWYTyDtUgvgWy8TI0XU2cv52iliPPOnkcEQoIdHDHv7QzL8mqxSDkWkaOvKSXojJYxRnOTIpIBCQJz7+68cgLYf2oJzf9iIEKk1BQaaHBDK/NcKaYbufy8UKTvuq3IsRYR+8eSBrPcZaqKiP+EyIi1BrayB+oshPw8uBhmUipsVVH4ZMXyQ1BYeV+picR9TKJwbdqvRxE7NLhIetSTQ+uNXZOfZsUzliAINqbAK02zgmqa25pShqZ8pmlNoTWB0pQXTWnGkZBEPHtWInihc2IndtNu2iU+e0ZhaEmhFOMX7faLaMWgcwTGx7CSwgpD88QS0TW0w1PlEXz5J/Bwvv0HuNCHp4HT3n3TNzd32VNHIVZtiDVa/N2M1t4u2dgIg0aA6yyzdRvUUdw+r+EipIvbkYAGu46IrsvrEiIwhCV/RSOuV6VBO7QRAHnXtHHdxnFcnHQTALvFIwwtbYMtAc6CtmVcI13JLMuKRAMVs+BjABdBTNBJRIby1f6J0jEUlsHw+BJjGGSZWcWEEvdG8BL6bDKxQz3kwxIJwKg1kfgRU7RxheZ0kUz7MgDHaE2KNsREvIWUTAIavWdzw3PROKZUFpuC6sN1Manr/GGgoxVAtez8mBaMDl2MBC9Dco/uPDkbt73pkijYOrMogYgAXDeVvQ8RaL9HSIEVjJZyk7FRNM9VDJzf9eSmr47AqGx9n17eHQBjinmnzI3egcbVdjTgszulNL7NhmNJ2BrVOmb9Nr/NYBtX+1zptTGyEG+CRvdAhlqbK04HBQNbDCtrKmoOKS5e06qKgj5dweUElGUBfpC1yYU3bdH3DjybPNoX5jlBpnEEqcNyLkhQxSgM42NKjvRXkUaUlHwy5GM4heAF5B7yDMIxCMsRDMMwFPPxGY5hBOGr/p339J6QxrAawWoI6yMu8AJZjUE+AfkURjMYwTUSXH3LV8l7hJTJ/iOjnh66SfmVWAuocWg/ia5uABl6gERcuagpCNqtr4Lx1M+44UXVh/1KaYskEr3GscJm9S9ZKjiFiJz3fbDDqEB16Jh1zvqLNpOKRVIYwX1PGm1tgR1Lm+OAmJhrH2WoUg13c7cchjheEkvLGwApYeF3SIawnufiumtVqXHVIsboEpYik1bSyMTK+KHuB3ikl9iF/Twvrouwv/v9nfQ5BudsSpuICgBlB4iG7P61pU0KLFbW66vHj2vxaz8M9fHHY3GWIuBgDJYhpe2+YhhFUAMIgnLMvP79I1/96eSdZxcMDmEYCk0+z2Axrr0HAx9bJy2rokmwlJQzClDY+T3z6XDxPL8pGZQ7Ag+24ZD7qFtYoStUwU4BIJI9TCnoLosuNaolkJA1fdjA5BCN8Vp3xtPezhQNbgtoZH4YTWi9DXVg2FDvKVgzv4QI/faAek4QUG4D1OX3OvxsQ3LX+EumZAsyTfD6OEEsWlGNfMRv+mRIIY70fmhF+KuMJjCaghTVnCTCCSISQWJzkMiuLrKnikgVLTBVc0zXJ3mSHNc1LzQtcF04joVnRARKhOdEOEF0K88RnESwCsFoDDVPoeYZtE95P7+IUhSKU4MkVXai4fB0kmcG1DYvjj3suz5Yf6r1QVWQ2/BK5iBd2Y/m223h+jwvxn5dAR1IaFO++C01VV+u6qywWEqBhxI/xhJg9asgJt3hcDCJbfK8DvJseb0sRmiVzA/gnJwASJBSG8DiRAIOTZ5nPSgf120hQUy4YU3mNxH3GJpxv34QUgMBnbqxQTRjO+KAr8t93W3gv90yx6xXJ0tE5MV77xo9jIWVvkA7z2VSPDh1UfdYzNezUdx/x6MgjNhg8SVOIMzzuoyNgow9LCefDxWrZR5JEckAalSFlBxCQGvl4H42wwSuiOsmYB4hGSpIs0KWL3V0pdAlF5J5u3GCoRUykfeHEFQPilaPJoUbBezig/hpz1/kpkAdqKc0OoJtn3LKaTqwlNXlxsPevLdPzor8YjOeKaf8hXON/Iyw5dgqRceSSpFgbWSWgVHKVGix+oiR1KCqBnN1cNd2qK20A36W3f3Ui7UTX80dQZkkuWYMQaoGcaQRx4YVCE7qfMNP9lcZiaEFhRLMWCU3tKDCC2TZGLScLiTHSuCyG8kztpJr1uPwVIQshUmaWGfSmCdbME1kME1mIGNpmCkbPsVwujJnOiv7ObOy9czOxDhhhweVyJBiONGkYsaqDUNqg8fGSMILfPYc1+E4hPeQEW1dbExFkIjU2S416sHhu9uuWl4P+H5SF3iy/bA0ZfnQH13YZA/a+loTc7LrLMof9qnvELkWDCq1mvjKhLiEx+A9EeLhcDh0RvZxnjd50wxbNnlFGKW1dizqewSeTjX1fW+zfDZjcqFsXGTbvvd33DoP4n5ya1wYwlTRdRkxTuv1gylV5ghD7/z/6ufnngsqAiYfgZ6gx8lczUVkebWWaLS1Ms+z1TKftN+571m4HonL8FjeGzbTvDyc19Y254q4lbXkYNlp87S1uuVzs57vMFcpHk31IVIXxjFoC5nvHjT8yEPvvK+XHVzI73BZQjUb5yKpctTwkoFKqcYqTVCWgwIhXZcKwKPJ4ci+ywl2TXTj5bzrb/tMDdEAwNNYmENPoRnPvHBri8Oup8jhWNLC9M+yeyHjBHTkh/Y8PfljLrJKbCJHmhXA0a0C9hwUzI9++ifdqG24GvQLjmLAP48IP/m2Z/KLne+R2SbsRIVVVCOJhRWQ/Xip8ZH2YyXkh5OcQQmmKEHNsxekyutjXRMq1op1NHMoM9a1c/KLHX0jO472DTt//jXjm8mGKX2zwS0u3px4mMNvlm289/2asF0f1oXtfb+u+8GXKzb/6t6MCXfma2b29NQP//HMU6MvHu2b9nDiS3K4eR812HqEG0ohpyBON44oFB6bVRpiEYaQgvFwb5rANUSmwkudN85RaFiKRBAqdiKTNDrc3+/8rYcAn9qx8esz8W1w3FqGwCWEJPA/UvncHPxy2Fbhe83yq5B1fqoThjKhV5HICOasB+ZIKQDQck1dGgphjJG+qgNELQmjuG5jkEYRSbCZlKwN2sGtrQW5CRMgstqYiAI+BisLBAdjOIMSz3dxjJvOv9nAhJEwBF08iDi5mtdt8V7I7osPUUQgKatBOyLXx5+FoKdlETRlPZ/4Vv0iHYQwwTiFBFrxwE7qpKKN+1IJPRKqIAqm9u7OiQgM7KWzWMSeyBjIrBSimyNiCIRsaxqg0tBjwWgi1rghVaAIIVgXo97lwe1Pd0KggKhtzFln8tY6ZSl+bsNGGT0noqROg0vJqGiIn9iUV1co+TZ1XhYdeKVkxUSEbsq2rGfSlF60EsG8gHpO6DJ9GtGWMU/2PWmaa9FON4HAkEEeN/eQ0zq80njMBwpCg2MIliFhBNYoh+A0grY5abPdJ8Y+2j844dmuOwd2XdkQdhic1a5eWILzzafarr6qrG1jeUPbxseNbRurqp8NoDIv330A9Ma0q6/0h+96t2XLS+eumHB1/wvGRzP9VNr4W7R1TgNpLIgyYSnVAkV8A0FqnCjPNFgKYQiGYVhsTEZ0GNO6J37o/dPtxTh4aSfBxz97lEZuyvCcSIP1h0L7Uvyq8qKFwyZsOfdNULkzBUgQaorrOG6bJFUeqeS+d7KU5CxNpgrtef1mX7eBlZQtyQiJRADANUOERHAxH5NZlYXRKapaoVDNjZl9idF7/z0LNyFBIURkjgiQMcRjG7UdFWY57dd3xeU/bHUbBqoKlxlsBfQn9xIcIVSyp72EXIpfL7NrZPHFj4c9JAJpYudKSsmpQN7OTQAQSwRd3E1bqu/qz4XHoS3ee08AZAwQoWdIoo16CJbBiYbUAbgmJ0qmFei2chVScGQaJlwjE6JRQOH1lX1cTpQS7a1WI0XlH1rflXRb6beXbqUspQGUatV7CcqiFm2VUVCqpSgrnih9N6/fH8uE+bKPgUQmbXZWpCv7SpWLvuIPMfjCta2pwz3/e+i8ggYRrnmC2O8jcQrCS4jAEDyhhuNEiULTMpWhmYnx7aSeODD3VMRXj+/UrvH72zRXTwZUewC/SyjXwpPZDSAjcvethKhD10ZGH5saEQYwTg9vuq4mOdW1UJEyChbvropCXn0oOXTwZkS2HIlbuHD/hb133k00wJcGqEh+N4DyjjbNop7AlUumDD5z6ZXpfdn3smIZHJ6CnSjYmGoJHtUCJbxxnmuwDPIaEEcgwozoEXHZCZhUM1vf+vLNEdNO8PcGQdv26zGu2SRe4icr3HfPfqLZ04P9qPNsjW2GeyUyc8axry1s2MM5fpRJVmjJbAYAdXAB5LL+GOmkO7ceyNf1CODNIQ+sPFA2MN6hnM65YlIIkRowREb7V6VD0XBAtir7vX7feNrflbiK7udDwmZrTw9Y5Q7EdLGAvq2o/Du85gj8lRe6CQb2J9qSVu8x8BJimsriO6yV3ivLeuzRpN7O6yZ3vpRhQEbLtMKWgyGDNqrnVNToR6j5MgMiJbZDxGk0lNrTW2Ccy81qnkC/dXAjfZPdN9bUjAXDhPtCJp0RyNgYgQuQIaCM9mo+b8EQUftuVTKmLpG6eUzJgI4TaGsS+wKTGW6k76WZoQKLUnqTxQwyF+ZMF9TKz9Q4jkMwpjhsQlkOYyHpIzch0iOnpF19ebFyTe7Ead1Tjws25hEgzhVijAfzkTilc2KfjuNESxwqp6tzwpbJDqZ27u4b2XZ6proWmgZY52jTXNHmVwpONBTclcGRo9QAly0QYoqnoHHeIa3NRCFqr11p+H9fWt38OWCUi5uaLniPIm1RdGlCX5O26pipKPsW+pQDpwGKmwA/yRn8y9nAuNZ9N1liTd9KacyflV0K7zEtUMiJndgbFwREYhDJtLTT4tplI37Vw/PLZ2bHpoM/rg7aCqclgWXzmojKs6Z58uDkl0IExO8iCB3Ty24YI0QG5Io6cJLPpa3ruvcRglB5G1tnMU0i710T98iawCnDudYJbpEnr4p0Kl8FJT5nigzBz2JHINBghvnu/ffXpax9NBTG7iUAW2ncZwEARKiUDXrahuvWAYvr0FaAgobQInWGW55jn+MBkByIozCK2NBRDVMESyE0e4FxrEq2XNUO0ZAKBYCiE1RmRoCqybxUtOy0y7reT02iJWU1m3SJnoNVokHskCOKwhVDylEYzRcMqIgxhwqVVc8NojIi+HHRWV2lOHTpYk4DibaktZZlzJdQapMHAxfaogKMrHKxFZmLrOfMqfVgLT5KT6UVWakxERxIIXByxd9c6/1/nPKQm5empg32/5PtxOE0UjTnhhWYIx683yWylGmBEcl2YkgEkdI3+m/Ckx1XhO1ZPA+wEAMoKVIueksMcHq1NamgpqigvqrGnbHzFolC1L7yO8w1YeoaStx/kM9lnvaTJ7PaN8j3+pWi1b5hpF5ZCtRrG0J9aA14LxjjqLMXVse+mvmYz3AzOxPHblMRXWZsFGKjCJlA7B7ETiDf157l8tteH3R+nbOzzs+9d7cTvPQIfnfgBkeE2u+vViEpPSceoll+vtTwndzr3xMDfs9O01LTeRW4xP4iwuZGmO6g+WQ+37A3P946L2kXtA/QHHTykKKs8uKghZ4cxvG2KjFQBU3eFNIQGyfGK4nilqY8Z1TODdw7PZeTt7ej14S7XVMeLs3ocMRjDBbxj4o21hN/4nuH8xDRvdn2GLPMp3lZ5o+ZqzrdKEsrue/HpQhAvH0xDDqLB4rT2vuXl1uGcaO+dMdxROcOtnEWDq4BNNYdAckqHloCOTQOnVqlCFUKA8j8Dsmf7F3eoO+dAucUs4XaRtgiozTHhaNJriz+4JCHS+cspUH1rwrQBvgrRSBbc1HE2goVtFpC8SK8G618z8ITsN9DgWExUcXGeyJSeXPI5WKm8kLKbYQLQ2kMoDG18oymbKtlVdXNvkGoSFv2lqsr4WzA3yQMO3P+Q2vaRuIKDDOEkZxnvO++iGMYjxpGURGFBsMtEp5P/TzwzI1rAd9PQ/yIn66h6bSVGv4Y0nUPZYdltadsDGKlO7bTnbddPKvc/0qtxB27hnHv9qh3f/ePcPfbvyXe+bTnnZfvvw8/g4P9z6JPzriB3/7X4Rv9+7/5T9f/+lexU7yB7DQSu4v52Y/T7mnceYFjEKea9aFO9zNsde/Uc4AKn28U9Ckagcb1WAbzmmvx/VxGLVHULYdvxbzbt96nbfizGwBofI3WXx5a7b5e2g7793ol+MfLruihKmoFdrzjU5XntgIbO6IAvFw771yTO9LlBKsRDU5yvawdlDVOnhp0/qqjKojr/PzcKY2FNY/5fI0vKiAfAfmpdU7qRkeD7rqpBbaqcD6iNogWGiXVQDeyXq6A9j9lRSSyrZOnh+/TUpCfv6FWXhcF2BpkdhoOzUF51SzW/7WlOX0zOousH1v8VJGftkc1jTIrCnajAgE1TYAvoUqlwFwqYYeKYGxVeGW1tQC1rtJH7NzZrXUut77fMS9WFBzjIbidGtuNp12a0KFUFLZfz0ZJnT1nkgdgDiOLtSEjIm6c2NdcK21ArbVWlDQp4byAMUpY+dGQajJocYFV53W2x7a9Uhe5h22IAvXlPJ9LKdsHVoJ0e4Ei7y/X1KXQ33xGxp7Jt0SOYZWhETUMqwisRnyyg2lBoDjVP5f2bGJ6tu3pf/7mAkBpHWDj6NA8GL/Vjl8obb6Gh6Xe4IrgYYqfLZYplxykj6TBkv3tB5RQXtK4eOPBhAY0W+RPUK8npJ9vohbj9TIX7A9P7rUDsYLpb6JDCPDH9Jr6s39cJLxsPXQ8M1tw2cjYDaZkCyvZQZZEoMVKpCifqixpa7O2hNGc6Pv7/uy4fGmtfznUqY5ci0wiVCoV4WQ5+aW+1Oqv6wiL1lezWWv/jy4BRqrFvH7hznsZQIwGwNzx7Q/K4dtlsfgeSxQtUfTcl0up5UcgaVWcyEpPoLUBRIZZO2Miy88esRbSnND71YFsjSCVa+Cgrq3mQiNJo7QR5l0kF7POa8yqgRpI75V5Lqd1CXG1kneoy74x1aoKrInIFWQITbnQfpb5VII50FlbVlcecPpd5LjqYHcsXZfrwi4lEgiQwrr2OV0JFqfSQuGzK0ojjS2rgMGxa9l7uLFcFYoGFUIQsAag68yDVoAMmFLocsSFW2tSBEZesJSRQMkYXhy2EDuShQPYeU45dQoGHRM/Tu+FGAG8KLIxSKGqxJQ6b2zWSMu4O5PJsSTjKwJoVF3WN08tcSYXcUjIDcRVR8wIoaaievWXUJE28vgBZVn6ZcKU6SMDX9qJDisNxREDXmA4DWF9yM2nJNXMPNasJMR2zwxu3nLnGkBFFaC0NKgMyjQQC09f5NixkB7rjZYkmfQZ6jRYj2OJ7gfrzCmSpnnU5vKDPZgxBEtOIixnUGNZlofttcVRH9Wt/qsZOv7VD8qJQCkeqBACKMxLvLf9GXuMs2PiM2Zn6skzYvzZ5/36UA5DSqYtzIzwHGH8Y+IwsUmY7huEZlBV95kXYv0iWhsrF3nn016wT080Go9o632EmZ5bBBABHHNCcf4ytOX/n9gCkmrA5O5ujYo/0uRc9wB8jjk+f1lNcdpWLmr58jDleSZ9b5e+4D1qzIURgRmjj+BF1YehADh2WO2L3+8eiUdUbNerA/b1Wu33vp85x7SeoCtITBNf4qXxD5oU7Lys7uAtpcjlCkTEFeE0FstaEZfZsyx340oT7TWqU/TEGLIiUspJlsU3mVBpuYoXqQk5x+vKGCKwQtNMNYEHXDfvStCLBa31cVsrHmLkgjnndFjbYlLCxhvjM8qx8LVNyjKdAgkiKFe3zD5NdvceVgNrsVgVAQw4LArBtTElOoloIAk5f7pQFQkx8lqw7G09eUIU8eVuAdo80oTGILVsd/n6q7szud1mu8JzShMVFpW/SVwa6ic+8EWZWGgDlydBPkm6KsPDWHVKhtDVDCjLCtrx0Q1prwdw2XGQZ2uOcu7iXeQlAkkKran+MlnT7Qz/9dSzgNpsQIVfW/Z06wNnm/6D5PAeb6A47B0rBJf4JEnOmlrBWheXiwtmcI0qgWVDNyJ9cFEuEtn2yE90iQbApbG+1yRsaW6TYxwCRjFAOEASgDMhhDD8M1WMh39/YSbqN5+2TKefoSZTd1NTqbvIePoe2rHuTOka+i1rtB3B1eGJjsRVpsTGDvgd8PcQOkGrAWOvHtrqX3POWOQUuNdTxMkzxerZc4A8GdjTu+/zWL9SMbQXMAAGqBZRjMG2PL+Pq2MSgHa8r1CxqLdZsQr842W3ehxP4oP0M18EVsVPT0TMrjUkpMX0KJKRUirF4+VipRm6h2PCG2f3QiAWbaFFuUB03rk3HkkCVUuyFAXi/bR1yuogpQBxotEYQ0qgp0feez+Hx4dy0UkiBF/FIxocNzkkeFd1/w7f9f8jjQgU0/0XuSmuxbTDLx4/hlHAXhneooecQiljp0yjxc65VvZjvniRu9lCSImaZ4XOkXNoR4JLsAhJxCar1eLJ6jF6TqMw32wqpSF1DgEdpkaRE8BgF5MCAMSAIR8WfY0b9LPk1BRKhIBSFKxz0G/ZiGXDdksIYNeAII2RvezCQiqlhlopI1EZ4ydH4NJKgQZTXWPRqasFgFqvbXi6Aasqu+16d3fGUBd2omiOYnkSnIbcRV4QWMa1TFVsLmLy87mfgneAUwHFTkM+YFNBqHl59S0LDioH5vm1kO6LpaMr6a7Rdy7uTBRlTgvnvcWFcykXCcqFKBZJGwOXrcE1TK4UCBDa2GyNo6z0Z1pXhk6mSO38N4jG1x2NNrTp0U/MpAQNPmJo7fVqCaGfawkApMDXIB5jwC+S39zVA9aWA+pKO9QKl2+8Gywef+3gqriuqT+zxluQuIJxdqh/0gF7M3BZAICW5bjXFlmcOwZwstrW6k62YjcywBkgdMDoENAI6BBKIUQCDF3CDPY8+3/BraZyZ3eyPk+/b7BW5SvmXGafL2UVstvICmRPsHe+70FqKZ4Ytqv12YmahjIhivQBCCWo8gCOdatybw7l3BBzmKKUK7v2PmgICt0YYgygDoyzkccq+qUlohgmCFtRT65+xJktGofrKBJpqJagRYyGdsrqPMUj7CHFkOnpY0baIlFMLZpEYLFDZIFR1P1JBItrpACI4rbsC+TDE0mBuJnv+4pI7q9MQhU8dELMJ1LDyYmWiJDw9KulVaUuGCyWRadaJrKqdFP3jy9RZQYTXrM6HOnlsZzwXbHYfUNEClNBZDA1zI233AR3zuC+pQKbw6WNLL2lTFsC2bYBez8/R5FHBS32fTiWFDZZJX3hH+V4aEJfM6Au6zC7PtyZNdSOIFWhmWE4DmEV5NcJjMBRQ2c7EHKkixFtp28AfDf9OwTCnaf/4Le3FH3NCr9SgectznAe5hnG9lUFxIF8zpMoz7XjZjzhkFti1USW9MFFekkSZgdtpmcRuh3czhW9r3orlTkgHYCON9GiEiJTTLsCkkjE7Gb22Oq+d4IawmQAmK78u7sueMk9T99wb9VHrsuVTce2znBuUjecm9SL4sLOlehSQPGy0A3vLhvedvixlJEec9bnLgZbnfvxGngk/JLukLkj8jNah+JwW7f2i9OpB7oAEyOgEGROIHMSIGYGZA4gDrg0ARzD4yMbWlAtI9iFP29Ho/r0qPAo9yyTn11u5tkyl1V3Cs6F34d8czDPa/jHmiZbw0LXfp2TX1CuNCM4dOiQ0NFRTHAyFQR7PuValFtLQZb3Peo0TQnRMgA2RA4Ai4UiY9OAMgMB4tHKfi/36uGk60KY3HQSABAVLOIObYM0XlWUJzH/4oO+kQbHCgqIgBbRqZphICmh4WXduAJjMyqbcLQ8vnnT2UNB5wsMZeAub8ZL7cYGVfpKeqmY+7C3TQX6pDS8frT2IW6Neeor8S6MDsyuKfXGFH7XHfe1ABQciTI+Vtc43MQDAP/ScwTPXzRWKQlnn9fY2g/KwWwAcNH1oR7gUgUrDVe+bcEkaThJ0SWrTlw7aVmPfQwW1B98tJsefH2BZaSDJ0JR07Ac86dZCWEpg6WWctky5ljPnr5733bgrBY7LgBC6n9aMb/uXletXNJ5NJYEz5rvKSGA2c1l7jHSechQX4T3QVQSnYW8ajLMVCVbREB5OrRyPI9fkE5QEcIkSTmdBDVphMmA0cBlCSYHptUa8IDrvbRoaMeqcFDRDC0GgOWvHQA6lZXoQ8HV/N0AaSMAbAMsOVfTAE0h/7ncCfiLRMCykpPccNd1e1z9LNhiD8iCGwAcQZFYaIid0NIrBpgQodIQyAA6ZEEnBU7Fm2By3B17TWPtGlbWebutVToWR28vrcAKZeCe5esvCluhcH415wIYIjpUQAxoF4bIFYrxbrop6ESHUq/Dp8Z5mh7I2W4Fwor+bilOm5FEjwCV8RrhgE4YmXPu0ZeqaLHyYIWzLLl8ciNkpBbfx4BcKeDK+kBdxe7Tjhkdw3hoDmiScWDG0/Kg6dmvr9IAVrVpDsqMActN379DFYLUMPQXH3yQe3snDCGp5rQpuI+z9LlH4EJs9kbccBXNrJZcCdgKtlvaWEYFptwjK6pXpSrl2Vt4W9flxLtFydDhKn5E01Ls+EkF/x+YgVA0wksQPL1PGxN3NYQUVCdNa2jlQhhufYWkCo7gz1NGS24/UYUtB4tp4DjYN4//+M9/q9f2l1vM/d3wShOKGgZRAksRiBEYSmEFFoeHSO784ouAFpCAjV9n43cFVMQv2vttlZU1VCjy+bamps65xhAskQ4uY2dl6puNRbzWjsMTuy5coz6wdattW8RO5YZYyAcA9QB9FQLSj7S49146oz9RiFJRUkg3BZ0UcgSZESDDGzqdPAnkAagQiFBIEHKDAMwBB1zHJcf+a9cUj1+fpcWf3rC/wAfXs7lk4HrVc7iBS4u+vpZLvhMo9FxChKGrASAfY9hl193umzrojU7QAWIMKADodTjXRqR5MzmgsE6XXadE5nhDTQHECMXh3H8IuUoe8xblHS8sc9DPsoZAgGxrZCgmj3S6koiJSNSqLL2BpnhLygADclaeKP4K1wp0aRItVnOyb3SLERb/YD1bKH4t6QjXTa0N8LVa3/Q5oUkx1FPo+/OJj/qFEwmAueGnMmHrkJe8sFQqy+k6USquWNQYLrEsy7KDbcCYw7rIeD4wM2x0kaJOx3rsMl3RNGLIuV1Tvh/G6exmyG+m7vIL2vt+nAqPU0oLIKP4qpwuDjIBZQyGAKrIus05s6AbMo3nSGt2Lg4ki/gipEx0xruaM9U9i5SgTMgPPOfgtrjHVEg8so8DaZHgG9lyGIZQvrdPioSsVtlWWVISlOwnz40HdKwKs6yioLTx12sBRodt+3CWqbcXhxdXpLAMEgTEMIhgKMINklg/9K+OBCe94tGnEV+VFXaeAV9z5t1BKbiiMNi8ljIWYHa/XCqsdSDP+C/zjyvcqD4jTc4dC0QRgD+AL4DT94y4f69XxqsQIZqkb1HW1FnXxPE13URZAtOYlmoTAdEx0jwf9YJKVTgOQFM1qCi1raqd6D7f4Xru+wUbYI3Njr/7z1UJ26PwALAYw3OvQQxMh2g6yrExzGpVIAUUHUfpP+74oOaZASf1jgnFAhLSkI6VTOMg7WfPfcpHAehS8eXcu4cfipZ5dwMm4i50ipBy7IKXwkJGQxRZ4hPym8VcE9xThOFWVc4pgrsKHkh2mE1BoFh8wZwUDLYMAxjSyhNg4c83OjGytWT6XFIgBT7zcxMohBt7Wtse+GiIIUaCCcE8Vt2vfYrJeTL4tgDzvBSP6TbiviXm+RLD/O6AiL45bb7qlsVDTvGxHSE69SXmCDEl3luOpkO4HP2eDBvwJ73Jw1G95pTKVULb7/bM6LSGhLLmNEqJCryeZ2cpkfmYtkSdRn75KD3fRDAgFeLenKkFVZIrRStHL9+kx5ISuHC7EAs0RbFQvS08JvxocGxK/8gBO1EFMUNYQUAKw3IIxZhBAhkmYcqeVz29D3EIOhlA7o71SIUDnc5waax6q1FUpEFbTLBPz30al5f7457Fve2Tk7fYqJ6RnHymGpeVw70uKTDzovd1o9G27uxbG6dbavtkveNeD+Bg/vrVHPiZvnfZZYJIG23NnXJ5oJg3EyflLlAvtvNwMyusai9FE8Pxjh1t1cJpaFrYb9WErAQwzZAZnB50D2qfM7+7sD5rkqSgTMgyZZeu/wefNWpEmOfWWd0N+7ggKMwSRwd0iBKAJAk9/C0Rmw59mneSfBsWJ1mLZSoRl29b3NilWFRCVtFc3tWQPDu0CC2mroZ2XoTJMG9dYYUjXss3A0UxhvLAcyEqF5edL9hEE5DkhbVKE+MAxc88RCQDlhDTzk8ISeZZwoGwEqBUUdlCrVv1y0KAaBqHBFIiJYnSBzgtZErAqyzSuoQMLqLHsDk7p4D4EorbybLsz9xyfNcjU8L2PN8zMZ08wjJrYIZIcPDeRFuqSFUrZQk5OUjJzmB4oQ35uy9mdrR/42551Q49Md9hn7vTFXq/udu4VVX2huiyBwZsmoD6k7moDcS7vk9KwWnRrM+AiFojiLVrJbHS+cw5owTpVTQDPYTqqSVamheogpA3cKXoBtSlxr8e/UDiCJqlhRWMfTiJQJQY1ofGkmrWW526dA5is8dai5EPmkuqHDcsRkfapOG7OmxOfkj+8ttf8BvwjzmGd778jcsdwj9mCqdOmeW58oK5q++Q8OdcZpBeDZzdwNkt0sQxPIin2lByuIVv3V+QZ6hRnZ51jYcDgGb3tKmpw4IBIgqoDk2gTjYJKpwzVaKqYjoVht2OHTuc6wpVbYD/00ce39vIGn4ABm28+6oepn+x5OQPF8F+e/HO09+u7UAA+zal7RKFAQVUjECNqwnTURaFqC5dmw4zvFlq2nSAUadWxs1wzCnIq55DL+9iNlRdXa7ltBb/4C0M4wpt0yHGSODC2Z489mCNwwkst9A0AGk8nbzupiUHc0N+nbDeo7415ovYyuqi4iffUMdz6D9IcbMcSVDtrqhuxGUTTRW6R6nzFoblGXfUNbAddwoTcMXGaJNOc5UcS6rt+nBo7nJt2zTdFVbzHmq6Oj0WVWVBK/blihZLKfN8koQ+5ef59k0yeUUJO0dx9CkhDMHa/NQDl1HpENE21sHUAUxjtIW6fJF5AbEThDD1e7hAC+MEU45Y6cienWNCn2cmxPmpxPtUXlvAhoDYdgEdZhD7B2vVCUU1hKbYXG5U4dvUDVyvwOP5srtJaucEEU6A1NVJsWhZr/ksBbVVVwNgY+bQX059ymkInWMKCQbjE/ZBxDCcpJqca1LDrlxaBVhbaJ3q7F2QnsjFrkSR5zTEhCf+8+FI0vI4Iy3HGWXXWmCEfLrazQ/nKGd3tDy6A/f67HRRn51XerbdMTIAxne8RRh2JUQZA8M4pKYFAB52V0/gzTzFcuQWgMRN2PhNiIGPBOHnossnrl3RLm2ZbGVRFTHGGWoiohqqnA76E507zIuNvPGxwc1Gm5Ul5eSdxr2uPE5eZdbXHH9DU7ibiJKASAEq9crGmESEvjAzb6gCGBAM8VZdgwD91kHbUop/5cqV5K4Po2umEYGYSBibA1tsDiPXYwX2h/ByotEqVmekgmLRPABgo4fPvV/dtal3ao045xogEemD+3lZVq1CE7MH8wfreJ+E8xyN9GTi2DpFfIyt/cMmYee7nz/8CnaIMeSlsG5QtD1Tgayj9FVqLy8vNxutLxoA2xAQBLixy7dH3JFe1+94VAoCQLG24Hg4jLtuUlW1VmL/fNRzow0rxVzZEOa5tDYEONTBadM0hEdPfR/nJeaLzwyzSDQI6c0ROI62DkqFjQE4vkSk5Ue4aqyZmRHDKMeD22T4voGk5rSLcSA1x9BgMAxGsbVNJx9c+hKUGQKql61pb2c3ABXWwxCRYIgx+Pf2RyxQLuaV6MquDkCZu9/h6yssc81w1BimqK2peQrjY2jJ4LRuMZbNqMunl+OAcEkDrRzqtE/4GYRc5B4526xTrXBRLhKEdgHSh/hbBXA+m5UBHAG0CNF788btWMejugGM6d3jK/90LjxDKKk5qvpf9HGe6PLLDLO72niAmn2XcnwaC5gmDHVOwrG6bjURH6iGpgd15i6IWcLH8EdqEB2pdIIZbJx10ye1WqkTSBwnKL2SU0eTcRkt5kcvXRfpWG/SBB9RCCiASq02Bj4SikqdFsHM7jDoigi16mZafZAKHDFYtiUY0rMMbvq+E4IOj9PpeI8CtjmowG3fi0yi6NAgTsn7uUmH7/heLTptxrEJjR6aOKHWbkSo/Zj9+uM9TLi3vcXD2IzChyblXpi0zntryEhlTBwTrv3exOpMLdb+6ApQrwONws6yF0W1XG+uaG5jrOuag9TdodI4jbRjAKCnE2ijk4p2FNRZXZfbvtdC07IUawpDc8j7QN7Wdn1u55vNBoCZE7LaYiOp7zfFKoxNUIwxIHYvsf10NPrlyIH5WFIqbqeMtEl+XoOxo3u584WPbrMJvUoldHo5OAXyrIeRCsS+pwVuXofzApO6/hBWlS05jlfl6ggc4eytV2ZU29Cai8I/N7Nmw4LP51/LdfXc9Lwp/U0vDk/B4WnIVObnUoJrWlHFMcagC9de3jcAoKjZ1AoWd7nKTEKC5OCChYQmPzbXxNFu3GiylWkt7Eqb/E2nZG5I0Tti5D6N3O2htwMAaoQQBpRqjBfmNAOcATkm1XCZrOQAKvHeowkQMpCnhVTosCSEjuyebzUcMiSBTo0agF0diG5Mc1V33fngb39Rp0Id1FnqlNJQeViREUgtabqzZXwm7FOLHCDXfMQpJjNsMOux3e5IGUBt25YU+EhCUFOt00mS1CLhcZUY4TgL2l2Pzxa+rktheskhg6//6W+hLh/tYNF0obsCh7RSY13p9vhtznEt3RRw27kuxN0O2SKLh2ARmXbvEu5YYfqwaojoC6an4BhzbhgBdt6fTus59PGA04TjNHKX960dCyDjMIzFa6SRAMAM04jaVITzcpqlMgbci1pm1iLP8P4+CnQ3wlKD92tNBMqoFtAdtE05Gx7zbSbdrngQCu9ZcAx1q/s1sKVQlthZHN8ePCjVj/McPB7Abaduq4fRFla3izEe1ho3jsPNgAIU235UwHYMgRbfDpOO3HCTyXEE2J9hKURVYAQR66oU8Zaef5Bhb81sAVJKDlvvLUaxgg6LOsDf+XecARni1vhMawWkXAzmEWGegyistA//+aptWtfMtvEDX6xLHBw+e8rzmd9NqSY4gREYYtvLx/YB1tiDAVzqgljZ4rI0iCQtTavpKXpYD3dU+eq4mGlTqk5C60bZZHG8QCW2PGMvgA7RkASgQoZccfs2RkJ/PfG+e5Y3ft2JHgm+QoUAZCaQvF+GIapLxzlQzIkioKYU4e/UrbTORvc9/dMredfJn3xe++e6e3pvOm1mqpL2UreUaFJpDUuGMcJu59kOkgqoNETe/OwbAC0J5qkWoB6go66+z8/qjuv8WeZDXelIVXSBYoThzMk+AwgL22aRYO+VxuBHsfjMutQVBa+/c2JVES2suKFWC8a9bQQuWta+GRG3U3AHXn6CIaJw82XXRJLyYCUr2oZmvPa+JUdyUeomCIIoEeTmky8x5ei9aiml7JaFsASxt/vrxpfixanq9tBW0HFXrj4ft6nxd6xNCGitCDNLWYtLlZmokgWEUoq1q04l4spACi2n/sLeQf9BDygFQf1sDVlutJsiSo9IaBWznVN0sbq8222oV9t8rWb/er7Qhb/Urtkdtk2RIaWxoZi6kPL9AKO1Cvq95Xdp88yXBtEBhiWTxd0p82+Q0Od028dGqc9xdzT6YFHo7xOwfXaa5ztfrWpEev7cBTbGKonvVg+Q7Wq1WEB++tp4UKGq9f98O8A/j8AYsGFM191vu0Y+O/zx+Nv7/wBUFQWWRLem4A/oPuY5FXm/LUX6DCV5hecEwT8rMZfKut8S610ffxKOB3RAXQJBGEJpEORA+6ixC8CSaIiehFwPL2AVASYBQEw+IDEuZ0SCWb7hUlLgNaUBKODiJBAl4QzfGOp/PMi5Xr+hvk/cACs2b94AK5/73/ee9znjru4Nnal0U7gqURnJLArFOXINdkpRSIDgdrEHBJY66pb9OZ6X3QOv+HoWPeCjUquvVSEjWGwkexERAkwcHsEZC0yu1sC9WgOhNIhF0oRmytIENHDsoDY6JIDNSwUEaAOtqMOvHDaIQytVxRfsQRB3AEApoRXsWnn2/p2slESwLLOUScc15MEIg0b89yFQ31tcqUK0iNRl9aWU//rzQnLNFk1uyqsfvv/+w4dFM5E6kfI9O01SYQh9kuKtSBEkVIBIRt3WZUKYFwVPFQx47+Fbs2o7oC3o5Eq893DIeTyJkYKE9Up1XdQWRHVOrT/14HWW2TRhVwejFZiCJqBTBUQg1PKURQTT17NRr2WB0Gm+KRBDZOef/fhXs7dDhYYUicjfydXKAl38Ax/k3+WR6SKnc+pj+FgoTYUU9lIWuoAQU1ebNhhWW/INRKLYKhFrXFhQ5Cn1VtXM83qCi2Jyr41Pk3rvBInGzmz8QkDskI8vQ6zKtNI2047FfR83xbBPin5RUNrkZNkWVGVD1MiOPb4nCh0ySJJAnoABe6nxC4Ar0bAc/KSg3voLppu4miEx1zth67N+QzkQOoDnwhRQNODjT2/69lEP+vuzRtyKAB/AH44B2XVr0i9P5m4A8d2sVutoNBJJDDtHFkXcxJF7Sn/lhu77909wLzNctMcrAZBeoCKJYOMAKQLnEPj0a+kFYPeal1L3oQnlgjHE8MUtjUVduY7+6uyEIuUwnkCTlBNHY8hpCg9Uwtsvdw7v/PlPz90vb448fn5+p5fXL0+2ghZiI9FkwgYnM7EQspoVC8WMliyYRiamIhORSGTq7NysFtOi2WaZwsF1hGvTZ+pjeJG9Fiq7RH73vPnXUWSGWuq6MV1TUF/Nz929opvvEmXLnuB1Fdy9n5+fm5vbjg26WQMroxQm9NTs/aEl3oyBR9lssCxEMbACIwTsRGLfyxqUlgBHtMauVylH9m7H3t5+3vnz+528u7u3O+syxtIX6ggb1E3z9OynFjeoI9QX6wuhWEKhDtPCgsW0YJgasFj6QlbPpz51Mn1vdz8/P98Viua9JDfv03O7JDctgjxzz3H++aUgLWJRFPA+te3YIxoVy6kL6Cxam1KUGRAH14J8zrQKc2CXFrkh7LJO+Yv8kCpvaUPdd6ip8dYVXvSKys9RA/CmABIbHX9mpzH0mKn1+MclfYbiglcUGItijvQZKg9ZlcObDIXrOJHOGHxGPrF5TB4ek3OwyXFserdo96pvAeyIhngQAnhHgByAwvs1r7t4uFUGUQiMCvBuVjZgirDynlZDP5IeNDHLGaO6mhDgQgAb6gG6DqA7foFi3XzVv1/T9Sjoa/WOSc0Pe2aON4YsKsJhW+4oEZVxM0b3n/7dbWX8tj4NPS1pPzoKeBS1MDtHv0yC4CthF9RJAFKLWSYal535pQgVaqhHTTZ6ugJ945e5e8HBUkZyvbmno/UPfHC/d8vj5p3H9/rc87rZXc0waq7GtV2fjOo8vxg47N/rNf3hO834/49aIn5UcvwvVOPxx1Qc+UE5Lr+h2sY71FkoYrjRerKvYZ7dP9OT/n4kOjufwkLNtZ+scBdjCrn1q7a415269rX3MYfpZGYzB/ucFCu9MgBY/R9nM/9i//CHcwx2vjFcHU+j/FNMeVPM+r8Z5jD9ZQa7MukviHOPcX0YvrS6j6Efh19WC/J4/XVsFfyMjuF+LCh1xvR6onHgj6m8yKY/oHlPkZ7TJtp9W0Z5fLaK8thWMT5M2+gfht2ZHY4H8Qj6PjFeL/Pa7pfFvf0ehH0vQ0lDGe0XmTLGr4GZRJUFtEJVZUADEyoJNlZBh6jyA1argHG5EuHP4XCLr+SVxHjN5vt4kUFV/8aLrPoZHPbv9VycD5OedH+zuJg/3Cp0ed5xMcetRnIVNr/dfl9B6+Pe+46sp5c310qf0/tHpPtheZ9eirx5f/CD3q/8R733pXhOzM5inizv2w0KG65HLvv7gwP1mesnO4Lypf0oz197g5blYZr7fHzznE/uRW6OraWmAav18mfHhzpNxZYiPSEmjJGNGqZ1r/MD2Dvs/7AtIjaFjHUdDXzt/vraxndOFcQfm0ms2oXhKBttoj1xMhUCahKPXrChqspb11BaHvlvIK57yaH+RN/lDdbjB8/MDLDKrIGevsWXpzu222Zouu5lgCEzbXeG1TyTbPUptl5nWLi548K2Tz5ETzQEwOgjR+z7ZNzeHnY7Skd7FvYNLBlIBcxfnIQiTmUHBvDUWZc8U4AgA7QGQPQDd3Bs+NA6OHRNUn5QJhpgeLdo7c2n6YYcJpqLMeEfljyUI8tt31EPnfSwCQIxGBgSMQxIkC9Ph3AG2NYscjsZzfagbnZ2v2e8cGF26T3KEQX3moEcyhFVwcwtqYQ0Tbqfw6d+Ofzc16lyXXH/E9XYx1f9evlqDqB+6HsAcAcY9ZwBrL/n8Z0SgO7Kz3k+DHgGZYMBrzHgDQa8eBMGPKzL8E3HWWa/hp9aV0LDZdosM126T2HA7eO86U0JwQcYYsArG5s3JTTsFwO+RT/Yg3cNIP4kK78LL0IgtjJekQbtQZk0YWOetwoQCZANaCFA4a8ACH7Op0QIqXF1Z3NhI7xAic8YlAyNRsHi9yZ9aglvlMoOm3lV/CygLCUCOmH+8vwNtWLn+b2e1XIxCwEbBQ6bt6U8+MeP5/bm2zVA3O857j8EoK0n5JjnAbB/Khjwcf3RMcD5wl0cLHr0I2Q4AgZ8z4ABX9a//q/3uMYj9IgBHy5ykfrrt7GxuW26ugxvmy6dYVtvsvn6gzHAAfi+/obP5qYBzN5FGT3Z4PWd0auxyZ+MSqywwiIPVOAy5oj+sJQc8Fe/TPXmcmPDsDqWFPrLsRoNB57vdtx/raZqV/S9wAFNb9tJKF3dyoVZPUpP9YNVTbEOHMLMP68/et1uROi3B9ecrsCawxMSAufzCoQ7Lxggx7DOl0bAP76suJSLW5pWM7PH1Ap28bnlMukzFAlEsCSYcmSMx5OppODwfewVeJgCU4+VnKmL39HaXB+7h5D0dWa3VOoWclfITIFUvHl5LaZSHUw4w5lGxohY0otEPruTbV8Sk+d2P4gL6eDY++GX1QA0u1w1aEyOrxKEByHjVFRMBB5QYR0/SJqxupIZ8QLvSpZajywGGKbHora1i4gHqbLSOo/qXGNEXqAo+nFUIlm8SsB6yXpP+X4qZ1vi7vPUz5/RcAR1cp+LA9hyZXXUvuaWzUrLH9JC/NbUxw9tJXo4QtRwlKhRNUQmpoQnIYSNSIjcpvqYbWqOsbauvnWXtXUVEvfjqtDu3mC13J3VhDiqgThYrGq1Ox9XTezuqqJ7qoC4q8Zwxas+uitevLVWC3GCW2u97nXjxbPeqjVrgKpbdyWvHmK37qYC9kA57KEy4wiVG0cgoeXEwdTHb2uEqJGGCx9RY9jIxJAkpMB+yFGPvFL9vAsvjAWrftHKVLJE9GTxpkeTde0lfxAt0aNoDB2RGLZFS8mdS5a1M0tTm7PM3NjI0+Ot2tiVNemQWmLGIAZNSQr4ChNjA4fRENG35aSBNcf+Up+VLt7NQ3NYEfYYU9U9JPODzLLuXRUi17ZioqxPgi7siq9hQpP70ZSGhbCJf21pTv9t5q/Dm3ttUYzR9zW/+qouRi7ckqWkROqjhyVEjkoMG5MYPAlRPAFRklRt6CgaIobTELVN9TFVSNwPqVDdV34Mf0Xc/RVi+CrG8FYa3VeRdv+mnZw+6LTpbirD8Gy6fAx/BRqBijD8leLwVRqHrxtgmOoju1gsVvLkyR9Rfez2amJ3VI7dVSmGm8XaYGXRPQ8Zouw4gmVj+MvD4RuMHJ93RA2R2yGEDmA5pfU16uvRPV8gn5pJmWNukF/TeUtKXrUJEUOf1EmKjAhMOaw7wLpu9ZkigR161fsM+wH1azU7ggDxQBc2jJWLnIOKZN6tytAaakW5IHHGUpWnyAuoSAaUhQAVrrsKWOu7q4CqIsB3nOW43KNmO7EkON5J+khiyT4swUO5SFwt2zq7tUz6DA1zUiEGOvCj0ryxQdm8XuaPaXk87csS8sUs6m02tsXbCsdBmmCiTah4E/rQBWRJqAyDsczsb6If2TUIIdXctr/IIIeYcxybngFFAJ2+tI11ce1DWcBYBLTIbIoYFlFyF/9SZkVXMLMPNQ6zD7++Vh0LEeDEatH4c9oAb4V5CYHDrPOobsTSmVyuxntdm3Z2BIQbTUxansOL+wGfktm9jrK9Lpf6r8+GSwIEBOdObz6v1l7mvDFLuL1j64GU5pApLKgwoDGgw0AWip3tTIZisZ3JXHDGUKqZoa2trYIMcEtTUzUTDk9BZ4b3n/nMEEEFBaqVoKmtqYKKLJBPJROkYSB1A0lY3K/UFcIwSI+FJBk83Ul/c5Ls9XPAZ59RjOmBP1QkwXxJh7GEUhnD4rXf74lL3EAUFiI3EIaFyC3EYSANBRWKK1/oviSheP7OceBX/cidB396SSinTCPycyQiAbkxk5oUI5R9CcmVcshcYuqbu1lSv843VgLYZdG/Y4uHb6v9Mis1DCghyd13Sd3B2R1+0WM/zYWe2852ttBCiokD3W6Hi8EsapWBCmDd7naaOwRcysiwVUYBhNPU/jnQYx/BQgtlDIPkfmBcjUiLbul07ksN5WcZgA3A/8V5bt27zyvFjeXxRa5asndn+oCBT+Db9KTu2xH45L8CbozJl3Z6fkumNXKvbqj9QQhKtjYuWvN8AhMOj8OjgDKlonnqSjgbRxx52BZ9c++xse37To69Nj8wtm1+cGLbnsFJN3eeHHPn0GD/C3fW46irc7HutgzDEdJnqDybchQlfUgciSV7v7UxpKDBYgxL8Nwo65n6a2DpsOI25iigqRL7GygTEkS6XvkwA3ABwTmEl5beFKI3BqKbgTgphAjzGXEd++6YkJx6QsjSK/QU+90OLegr9UCLE4V9j+IkjA4QEREuoAe1lUxJr3gXtrIcpKlIKBdoSGaON1SHN8lJCIysjJsXy1oHmo5L6ghWITuNA3XSLY8l9n16IygPz1qvLQJqMEBMPXofHsD74bEswyUMQ/TRXoAkCVuVDWnADmLVCRcJrCec8E4rUAbWuYceOjfQnSakoKGHHhpCIcqtgWlohICKN5PyZi4hlAIhg+vgCas74TJzdAAo+Dm8/0+aZaxku0+HG9I6IVQUMMV4Lv3SH+2qf7IkYGKESYGelASoJKAMkEzo15/rK7MXP19P2RwQOQUX+Gs3PXP/VgsHKKG3RdgWLyOXbTYrMsFw++JLAUXnWGloU19n/wj/rJj/Pax3XVfShiXieBMXhLHm+z4V071q9sSBKSgaZjTENhBlBblXAE0C6VaAGjC3Ylg/edUL0PogzhIH36bVm63LLiLks8m3x3aj+zF+gSoXzLtN1xKloa6PwKv5PJnSPT3xYBtWATdmwmH48xVlmeFeTTgyRd4Gk1BM39snXzIPisvYetRfPNm6msuJ+565vjHblJmV/Uznmo3kWDFyrEZmZzZrO0H0+fXhFhzZciQO63pvrQzSraUzT+l8aKJgrjqYRpW4tsGkgYW7sXCPMUjNGEKJ0FDE4rPWwKGpUbRQDzDgovWcOe2PK2saDR8ZEEQhPLA6nQTSJJAkgSTAa0uvBjHbmB0H1FbSE6LX1PhoFfrWz3ZFtGC4Db6qL96j9XiXMJ9RFELPBWeFjzww9OVGxHovvaCyFLZlX5b0VhY97UPjtGbh0GcoS/Qwx+eSrheJgBIM8O5i0agaD4heWrtI/81cXdW65zEA4vXUuy2h9g9zuQUaSksQSgN5t/SmWDZ7vny67FipUmYE+VDSHpxnJTgHeitovpFKlUgInEq+AY8k3xLIXQKc2QXb2AbcqAkEEh5HQigNWhWVhGKPqx5EAN/BvTgiPFmb+zkKmF4xZeWKQz8XlqBchkDpwag9falNQCXBu6U2hW/gBeBs6PPgj87Gx9bp0/RXvVpz+Aj1EckLEX6er4cVyfCHT8XDfl38zgH7kPuDjcG2DIqQLMXx4c//ua2IGt1o7VhIhNDb15UqpSulsKUK59PhBMHmcTgSiQRHJOF1juMSaD42zmbj7XE4bPYj2fhEEzk5SQg6m104e/abDghQ15QBkSSh8ngD04TFdiizgB4dE3S/ndoTGJ7H2IWEe93MP7LIUB3DEdi9EJW4V8FaZlmlWVFlOQp80VfiXBw4PiT8wipTO7e4vVqYNDxKz+kRsT7Ur9eVvWV48+9urkGzprExNSIYzIgmNYLDtNOOycx01341wp6FlRgAEMBGgOSrISCPgNHvYDC3llBaS6ibI5RXYcGVBuMVxuDHEaOun4kAMdwYIfFtg8f2aoJg43d0Yp3dIOL+8LT/OOyJZhkGlEj3oxV9PSlQtTwElQIWFifh0oAywGcyd8VkjNIgPWEh1vnFoM6X7mhqkaI7H6QcRyhH0ddHeiIJFao6YtfRd2o9LqMffUgDZf1FYRFrvWdOxYiRwphEa1UVedPtY7dly8lOFqggZKs4RGDgy+jT/xDIU0qU38TC929nUGVImKwFu0PUk4NwYwpq+dWH7//wh/88TNMPAUx703QiHe4zXsBJ+QfKADetDlDrcuXT6VZDzH5PrNgCPhHuhOMc5MAmJDiONBtHQlEeT4DEowJkNiQmWg3RU4gyn4k43pnYKtvZOtVfGevVY4hlrsGSkl/vMfbH8AGQNLoGF4dCCtxfVVKHLP/G05NOipr+N4pb0/Djp4dGsPRvq6Wt6fSJyJNez/vCcKiaAubZYEC4Lg9nHGV9t7bcBmPG0co+U7YFyY4G9+Mf/vCUklrYhkKEFNfp5Cgu71ZKrpydZUcRqFkIGERZtSdBpgtuhRO4FRXHrdqjfuQjdOpH2ARB0OkE+yPZ1azwiTJefvFa3OJq8tDzOeHvQVG/Lfrub10C7mNao/8V79YOQQBGpUhLCe+PZUrTpL2xOGmVX+u387RMvHmN71YlW05C5ElAFsQWpedStaG4uLhhr3k3tqp2QTVRiNrfoq4cKMUDzl9cizIcicuW4EJsJkJysOSYDcSOTX6Jo4y5WIzJvGTD2mPb0HKlFa2nN7zKzea0PGxS6x8mbRcZl17Jv0odJ48m4zJa+KXMDi1pQevSWqckNkzmtnFOtGpoC1uGH55Ps47hlG4HUpoZmH7Z/mmWE7Y+4lUA9WjHsL+I+n/wWSMuPyoxYDnC8g/ThLDXtjYGlkdpQLBfSadYlx4NgPHRf2SARICysG2O5R8zhXeODONypu+Qd65c8zKyuNMnnH9/HvMImb9rAyeew+23QpYDQfrHNrMpRfhMEHXFZUAM6EMhPODlSW4GxcUBbmZWdWhc+tl2x7SLdT9HAQ8ttv0RcncPzpsXjkGIG7+ZTrvFnEh2eWqw4hDr66/sR2Lep+MGzpHJ/OgYHPZ+dbcRuIMsGl28ioL6kmgdSkp/cjhvc+wcJAeh3vrTAc1oFnHmeRLAbmIwdSzBQ/oMyczGa4DbzgDbMiKf2eZXfVVYHMJvP5BDAe6Ip6dncRHCseuRv//nfzjPaxmGhV93Jwnmh8mpof1803VcePtyQdiemVDDBmCTTLrod9qhyRsVb5zX7NiM6ZuAAec0vzvd6busTxkrIkXKQ6ZhxTSyMrFJBY4zOMkFdWi3sNkNJhcPQWwowiAYGzu8gWZC6c3M+e24G/8Bhg9k/92v6n4Vfc8HyZgXgjOQe8Z7URBms0/IUEje2ycV5K0UBsFAXMH2+WT4oF9H6X04lnSl1HZZcUlBQdn8Us9n2fCs5+2myPttFc2az7mF6opYCbDiIq+e28hZSMlUHhJNrGxpquwZHHa6cRV169Q+vDMWRWGs9wDQHUjzQczkisdfaOYwaIfuCHQ/s1KkvLNnG7dVbiJ5GcDPHVkRsBKyUB4H1PRhvjpP71gh4j71chqXZ83YK35DGuFrC4Fh+hDM5dotS/C5kww1PkZUGUKqkq4kS0dcsWcEi6+GstA/0IrofyUao51pIdcqMampnFNHkXFbFYIWl3Bnrl9XzLa76k2ny2mvcNUoF2MlbEO6f+Ah0PsME/aPOLk7bEX904yhQBcH4ptCclM8tCiEMfB9U1o6AVLDtssXuM127Aa8NDUEwBeyx9f8+DyMUzVD77hgPLwyKHP4aUgifq60ZP3HPXs8KdBnaMVEhpWANSps0BkJHydJEiH7QD+gV6nUMhxSJ/I8rxTgxpEmeXZPOgleNG5lpt8BtJvl1Hn5jLFEVRNDglqTbfsoOq2U5jaidBNB8pmCugn6Q8EHulKFJQiel24Ai3X/nn9xgrwXppX0sLh/Cx8OQJeGJUfrmDiJgyC4lovVVCJEIhMnIqJhwuPGE1+uhWAOXNjnz6oPmhndNlGIU8P7UpacpkLUok4SY/DqMQoXRYGcJZKCRWieQk/iZhRA9eDPrRPnAacF8yVKmkLeOdwAY6zr6TdmbCEX5l59BE7+vEerTqo9Who+6PfB9mqEw91Z+zIulNkP6eok7V5Q0M6pZlmJ54pLdy1urFm2oeUlV8/pAvmfPyxgfXLf72/cjFIWvMEQUgZi3EScNRAZpd+Zm+/+gID1IBWwEDXXZOpVSm/WjMFIRlRggMyEGU7wk8VYY1WqO/8YdibXkphLbAHM8jakfaNMRtKHCM6IIAa65onKAk75mzs5VA68554+veF471+awB/TXKaqZbuSZ7bj2qgRPo2PYwxQnNYNb0jb3f48XsMBV/y0JNETBpTJBLejHBVg4NtG1pIAI92spXJOHSXGZdaYjToToHqElbadZQqmVbG6KmQ7iBe6XpHh4cUmyaqw2hA4XhzvR/NjmoPs8TVanPPYNO6GfJyTskxJmTNCsL8Vv56WfY+Z/NEKBfkKPX/u9QowfWy3CjGuD0OauaglqAPiO8xVXdt6oDECEZwX4Rgac6vEIrv3IHa1eI67AgzvP1EdJaCY4d6xwG00wO0C0YTulzcmcqYRJZdbK1arqq7Cg2ICSrsgXLsfy3yKOEaJ8qxCbGNxqTLpgwuLpE1qKrNsOTmUjNZJLT00iDdh1BsBfRM450WxqcUhoBCazgxvc7amtwB99+jOpdh6ddWczYjW6/MUCTXgsg0q52dt23qU4jGgtbKq6N8tKSV7Otx+Q9NZjmcst9y0/wEXAfwr/PvYrpmM7ukGKuAYCS6wIxnS6mdEMNZpolp4d2LYFDSuhkBlgLnCnA7hClN/VhZmDo912yO2hsP7l+b1+ZXz1XQEZnsScv7S0jD9xux7TcxYSYNI+NASVlpLhSHsHe9Xwyr6C4VcU3Wv62sILE8KBcg0IGDTQ3KE1IAjuOZ0tXpKW4lC1H6eP/52e7quA829jjx6rs9XDx7v89W9p/qcvPdw7yOPHtzsq/svdFkDpnYMl9b+0m++mhAAxz5GBiqQJgwSks2IB3G3aTUN0MruZn6HLpswySYIoJNAgvD3KUGoC1Btbz292RvL3orL1BtyC7t/Jg4nx9vYPUo2rG2yCKGZzHxrt7WkIOZzFIlCxucolAMTIcMZQzgV8PRhfnTA6QJ0B8HsCdze8s3LygYobHqu/4Rh0E457Q5jMjZWcGX2XkQVJlMuq+JU2owY9K7pKCGJQBXALIr1cQNZgiwUbwbHdDtoaWMtf9Y03ujlnDplO+SVM8M670xeWdnh9hkKhBBEj038mQxiOp23Y4hsmxMcZbdbUDCeoZ3PCj+j7oaV+fziNJXlcwwQCujCUEVyiAZlADcUhYevM8aEQsqYPh8deJUYs0rmKtluluasHeX5UHyAFIEUIVIzaLfthSQuHxp6ACgt/zlYxEdoKJr0Uh/cQqx9e66fUhN8pP7GytXNIBSbjHT5UC0M4DOpeFiOc/0fFey7ai/Wd/ekHYR3hhC86qCqlLTZLI8ALUNq7ua0ScXef60uq4nmnpOibJd3VWXYCXnQDRlzF9qmNfgHvJz+av3E/pDEDQu0a7QWI9au+qIwpBGNSRJF89rsTsRntOgYmbOlhInHbBIdT4f2GcDy716O71DP4ea7jhY0Rj2odnvi9WVmTEsugIu5oAIOKRM8iAgPHq7M4/DYv1azx3FEq0AVZcVXXP3wADXpgBoHoCL5QwCqMk5zcV1DVdG51LTWvi1AUS6gsgBQ6QUUFQAKi9s0l3d0roQn+5XCPb5BuIkoRPxEIWr3jfvXKF1ZZ63enjXp/Rlx92bB3J9rs/fHt3DX8WqGCoGvo2jWksUfH2mkwxmS9GT6UeHiG/zo10YFZrMDjY5VSjxIoVXDdCxj1jYl7VI4m2LrI7TuYQvX6ZLKDBWGoDNJc4gHUUoyQoFaFAhOIfg8Gd2ij76tyKVYlep+Onarls+43HcGeAMT+8+Be2xQKUqtAhf22CYd8lBKrX1t2K+V34ExJv7//5JauFJDw/QoAdyybq3+NqaGx2N4+Lu2vpeFkiNHUNtkTl4l1V8c7xxZAOlhWxsLuLbGZq/dMWDLpjZoCj3WLzFqCeoxOzgW48KhW+sN34P36rVeXQQQ1tWsj1EYMCpArQL4Qp5rAmsIpxRBMNbA3cpFUID8CTM3m7VYGuos4JlaqUYjssRuFEdc8VYIHRGxPhaTJ+tbcqbdmnUe1YdTjmLmM9UArnwjfTRnNMfuRRogH3qRzzEmT1ZDVItCKM7o9hww7P45+eTqm9le+oczGxAh0gP5s/ZvQ8a6VJItDOlxVUGT9dvaTviz0wqOaeIloWBTpfLsaJJyRODsmlXRjiAgf2N93tdAhr1ISrNCxGpCpkEmu5M8ApDhU8MMv263WfWwhBgjNuL34DB0ZCuNp2J8JnLfbz6eJTkj7t/r5c2TV7IA+UmgAiMRAxBhyiOF4i94sE+zNnVolCtdOsaHgT7oy/jEB555v3q3KiVkWWFDkT4vOQAbR0b84+Fpg05ffX3wuRsPDTh/8/EB5756elDLpd6wzR8mATbFhy8Ex/5twPpRgJrEvXct3E1bkwrUUdijioI+VTVUrQl8Taqy1EkEoXbfINJAFMIt56BczCs5kLtdlLiGXh+mf7H8REDJDmvp2OAWWFanEDp3qHxACS+2KmHz4BIObXH5Rx2NuglI/ktn2/6rfh5m5/AN07toY3Us2lQdk/ZK2q2X+RAznnHssR5AP+lblGuwZGqOUi3Fe1jKW8AJLB76oFUZUCAAHkOs8tlHCHzF4Sof0jcUrxkcJstuWNDAK1yaAZIJg4bXXAY4X4tcMgWtVwvyDAEIuDIAEfAI5JUrx6juQu61pIKzV9Uic7xZn2vHHWFzrdL3NRX1a2pX9mj7+jACBrd3Dkq1uRG7GMGit2TGye6R87Yn27yTc4xYMW1c6gIK01fxRukk6Iiym0L+x6gSK+BnsfGZZH511cBwGsLZSiWWtAnFj4YFvVNsLiwWLHX6xh+knTnsUIR1yuB3UI38XLqVV+cPDQbdIcQWQeDnAJR35bkJnRF+5ZXQ+2HmvTl2vlK6knRAcEQPp8k/J52efmOvL7D8GzmuoD953vZSCtmlByygO8gj5QIbl0k5Zh8PiwCormKffLSu/nGCUoRX5pM+kmSxo9aq9yKg9STTbtFWUa0PtB9xCvojsTY8IU0MuDbhSyJ+1SZSFCKmAJPB7DYmLcLGqf+crGDGW2YygRZv06YPg4ZX30jq+JTNFJ30c+3DYM+0rRmpLFNmDqHmPtfzkXgIMTJP2GAMUbW3ofAKoKiRCCWHbnlODeBXaWPfzPXaGIG1UnCOjWwjXFM6PQ89exDw80QVgrl/+4W/udVr/1NFlSKfb/Mrhd137PYThYLAY/QvRiv9SpE6/2Ko6sx55+XLyd+5hm2XeZxvosaAkgJVWV+4GfedZV3DTMBe7HkWMABMEfYyQC1AJ8ANgCOAVpmerwDBPkM4+Q7inSvWuDwyOHkUcfIq5R87HcCSeMxLypCquU+eED1ZdaCZf0y/Dky6DtzmUC1Tk+dzNJmX4edKAJrdaW+RuUIOzLPPpoAJLRGniOxhjpjwsMp4uqCcATKsx6cAaTal5PH6yHrMenMzOqQ6+WIQ7b519nh7vHNE2h5nFEDVFqT8kSksbdTbKgn6uuILXl0E51yLFyNAMblEJCd42Vvj2esEh+y1vhps1bZlPQDCB5MKFCbBy6OTYEf8MWBIVXakFbgExktWeJPQFJUCbo8p0GzJpBbD6XDofcQLp6VGaZJnxW5H7wBQW4lUeyCZYW9aBVCID2oAsZteleCfK/7L0HMRSqdiOXs+nZrxbwzbmPXD9/yXUvJU9Ag0KRClZJkO0jyS1790GpLB6kaTFIblmX604cKwBlInMt3rVGc7MWyrEktn1zYWNTK+0of3PrN6kPduLQWFLsXDBEgSGvT0PNJU6pGF1xNDM0IKs7trHNuAsOeMIwIelwiX5ZgGKt+Ud69h3t7WXZ4muatVgawhxmz3S77pS4fxuqR5FWi+6R/lnmGUNzJOS0EOPJGwrQzwhx92wUuWsMajDILFejh6AL9NmjSy7S6JI0HMHkbUVCKDljhLVfiGhcvb1T8u1RSkYL23uLSwpKhxyUG+QajolBT53PKP98P8i3lVt983iDTsckHeOezdyhLXKHsK5jUnBGNM7GiURyN7eJ84wqv4kq+F9lBuPXy7qRz7zXv62XKM+aatzTdrfaZp79PMSv3JpPWZ/NZ/4uTezMmj2HqfoQ7793pE70EYUFyp2fups6+cer0+Z7t1xzR87syYx51RT7nqzV/vYKKPByqkvnrHTWceWcUIdCocMXoFps3u3ZHfI3mS9Ci15tOphCiff07cj6hrb+dMP8r+9TYH/lBRw5rY3+Mfw86a0ZIuVD67y72hN78YnUJG7vtFMdp/E5O9aCrAmsaU6+XUMWf10wmgJBvUWB29wabmtdk5DJcF5OhfnpKb65YZdC2eU+hCGR5GvIeMjfGGbG/J5/IcGbwzPA42uay1w2Ay9X8Z1elF9IQsjWUqGUiokg90cnXDaOpBEcJK63IZUwzTlF327GpPZEDe/BrF9/vDZx9Kt2HxlRYOWyuFAiJHE7V2CN43Tsp5eSki74FShGKDXRb3lKWS061PjOhBAL57dXc86kzb/7JdKktGy0Yk87hCrNIagwcMfoIloQuECy+wzoepAcUEIIpqkvhAjMcXhpufBQAZHu5kUS/HomcScd09BiGP5nJMnniw+V80O1ZSieUGFEXjWwUtrZ6b0UslpaBQRk4rZRPxA/kpX7rxwofx/RFL+3550v+U3aRZwjQ1l5RuKz66pEMtr+3gt1h7vO64VL2bPROhEaEcO+wnfx+W7MUi3t/3rw/7LD/iW13kNWbhlxTbrFMhAEFAC7FuGmHGjcFvmJD9CWHbWg30tQCLAeZeGsBMgGaAFuCYyslrknGZ1YJ9Jn++Kq50DskCgLfCj24+1kPPvLMH05JuB0MVeAweW5qmRnJY9OniWSRn0EnwXWQBdQqLpta6QBp2j/sc3OJhn+5WHB6WMGDIlBRihOCg7pu9GP5I2e0R9vjJj6zSx4vVJSfpoZAO4AEE2xE1PUARQqUAT7VzHQNM5yz9K5yKrHDgskgIYNyPxKRW8HntIa6/AFmv6Nj+uPKYrE5vgofO+pJWR4fPXXiKMVsD6MKangyhE1kI4JZgydcdcNvL2oYek9vB7L1JdWoagb9h1rCk0b4kNf7VP/9LGczeDiNbWXXmBrRhBYd14/tECdgCFgdKpgI/vFO7MkOi1tA9GARyJQB9X+acO30WU1UqJQYiCSDnDdkmUFe/VjoyQzk5OXHao+Odw5QUz6q9zjnt4VbgPgFuheMTSZCgEafToX+kVi+r/NXqAqugjmqiJndT4gBcOnYllQFEk4L6si3RUu/fdvuZVzHOf/KPU3OCgkYWN1IgAMGLeo5OKlDD8LWbnlfCBZkwNJBnY4SnTdurqMqI7yhO99S1Vz2ST38PHtY3RwCRMxyeipBmhK7/6PJHrCoKNb5Bvvcsz3HVqsaWVQuIguQwWI8vzn7cJrpj+1D39Z3lTRrVZ9QH4R8jnHfePvzjZVdwUSX0BBDAqNtiZVMiemxZ95nFDhJKQ0TBnaEktzvUcb6b1nZsdvb/tS/tbDujno/Xy4V2JF9ravTzoeT8lVNHE6eOIsF+he7dJj+CNlTH4Y32vXOjbe5qsY2TLbR5ork+r8e++iIATXu+qt8IIcznKOZM9CVKOfX/uQFW3PT3flo70JyLIow25HRIKt1HMUBD5ltNXaKSQpQE71wcytuerZ0c49hew+kH85U/snk5AyyxH0gfinylpQg3bNXjZwCxx1vdfu69JP7jPvKRp7zziK3+BRyA4E1tAR6J3B9N05un2uKyeCM72x8UjrjLJdk7Bl3nopOJIJDUWed0OpJNIQgkj/IOdjwNc1WvXn3ZZelNIUpC8XEX/BABhl2S7xwDACgoDj6rOT96vp9/lz3a9Nl62ESEZvUyfF2gGIU2iSSEkWsx+XvA7i0wrso1SatKWW3JViDWQMGtvU2RSD/yRIuF1nwsAu2ELPJ0m/NFJkpx5YwGCDA+qqofQSHCllIWE+WiU6n4O5BdW3REEIAg6Pg7JnoHm0CKFd9BR2KdR9IRi7GOzJVdbebIh5jjWAocu9UyDBBOClbLT+evZ6Mz9P30DsmPAzCvCnRbScyVKpFphYnbP/GBY8ui+F9dFL4tgwTM7gRv1S81NLEWHsTP2ae9+4ZjHuaHR3yy/8dHv0um7B94G+5iB1N7uq779vT20Qrvl/2qh9d8zi388aqFkLd1niKfbztIuZhX0hmI85am1fS4sCS4mHF5uZ//Xf5Xs/saa/56e0f+5tIlWUJwMEWo90+MZgpgVUerAWWuYBxkdgHlAty2RITQ8yR/lALBrJV2dXotGWutC3Ooh8QNxGYgMkUmM5C6QWe9AiAr3KihxmWEN3QtScR92gJbR9HHxGPzde73w4NEt1g8e58mRALvzLIuYhpeVryHp6vWePDma/4ghm/UKRRx1jhC5jTw/nmEnt55RAtP8AIY/8Z1qvlxRPcAbBCx+lhM/KrlHqUWUyMi5hxfLOZmt0tBC2Dd6WwNi8mBuVKr6Cao1eXpJPBVXx6fT6PR7O35Qpq9vT2gEAr5angHjYZ8AE0jFORQsX5OFiCwSJEi/1+CQBjCdWnC9mwR/Vnj4bDZKLGQ7uaicAwgFnUDwDE/epW/n5e3bizFfbpSgFT67OrSrxFHWOEq4PI9QGAFXM6dcyXknLWM9whRonqW3Y2EZiTHxUrWa1gkkl1lqEO5t7hckFAqRcN/GAGBx101KOyMcjEClacqkAUEQLXbwOdDC9nPMAOfRuMLaTSaapcg5CNYfBoNJeFD+wUG+gaoq+vAMmKWyOTtU8Cxy1UBEE/K5eGdX/VvqHnyXYdc9BHLx8nB7144kE1m0rCdIaWR2ZYR39vBF20IxBOu+eynv/WdzxU+Y1602ikrIEFsUCAOtiC2GQGfZgB+lwDYMKa40KusBvM0ENy6uq9UH/mKDXDZIvAsORwgTQupwBD4fH6lpe7E6BVFga2MK+qcYF82q98bJ99pRnVNXFeMw8DcBuxpwFkFXMXAmQesXGCVAW0CUEwifnvq6aAD6Fimki1CEwXI68HKWwaoE0JELkyCMOcQxgAZYR4s5Dp/e4dWZwpo7AUt0oS0486ulIERGdAVhQj1aXvmHkALBD3mRauzoNE81/OkZ79hTv5w4Z3dwJGfFO1B/WL7e4/HS//hLEdiUatJAlbRqvfZ59jEoutLAYxjwyKpQ/UP0qbCsPrX/k3fcK+UiN9QJSmxP6EQBCoJstMAcQjHPiV+AkwM8SKk9nmc+UkpSHq0RcLFwbv4Ggao3kJv8JEkgae6uo5GcZWoXuuysiRYIFAaMAqYdgmjK5Iiwptqp+fTCNhcHfRKYwjldVg6U/yGI6GQDg7TnYedtZ/2YJGmwp0C+7LPkul0V35YuFX3awCMNn7fOirGOKVIMKKqyVux9BLVu8SM07LHJX4Zc4WT9OpkTHHJQJk1ru6OkmRqNwp7DjGL+BCL/hfM6DOtFMiK2idzoBCmypVLUh6Ug0HKsDyamObNsPNVTgBEbvCqRq/aqP6iaY6qHX/XWTEEqUm5Jye5CdXGEsmlboIyE+ZbC4FTu6UwGV580D99+rmf/rk7QeGWUq43UJmMk7Sy1GiFfuguBWdBUNWdW7j7GsC6sYB/HgH465G3FLAQjU8B8IMswCeZ6i+ebNJnaO2gKLCc4J1DUB6eIfQONpfR2d/I2JYmbMMLtmUZQ3vG9W5NM7ZpCYNa/m4r9/wwvYkDfofxwnQH4mOeaDsOZHVGh4So8DddDIGB4RHlEELJ2UzifPNfqBHS3BzbM5oRGJALQ+jNOrsIsoTQ9QrlANkWIxRYzBFjXHZW2DaLOHXLOG0m2xynb6L//A3VkBxed/o+6FRMTAa5RmA362ctuDKqdAkhUz3P4Y9CXiNOjT4m5L3mhUwXABDHL1AcxOJ2lCKkSKAkBDcsC6Htrb4KwCzeezRZycE2vx77Ofwz8gBptBnbpGTLALGjWHmGoiSMTgKW91HXlRKqpA5cE/1nNIca1FBDNkTKishZEUUVkbMhsioiq+HYx04RVQVRsyKaKvJEzQZw6/5R1ZAnzwJUEC0r8uSJpgZA8P3vAxLAkGdWs/hIM8eBb/JNvsTT9UthDinUYT/UYwY9MHV4zMSBbXggwK6jrdlEJDuHxWewBI/Bkt0emsB3T1mZch2CiWADrHOnve7ogRb2MBfruwUPXijqCkhCmDgM4q52G0An0tWccY0M9V4Nt8e1h4SVk3uweBBqHF12qIUQbL2nV6dVOljPZEAUgP+pnywlbtZc0hNpTFJFmMrzXJYfz+IHnu7jz24Wc6jF7O7w175EZBVEioorRlJD5OyIEhU/jqqK+38/alS8KkVrkaMicjQcu7UUUdTQSy8pNChyNsSN+wEikjpaa21jEGI34AMiZcPT/UizhsPcGDAAQ2Fl3GPQKQwGBHaJ6sJEBjTfuNiE+SKV5bHgCShuZaObEPBdiJwGUNY9likrsEK/0/ZRek5aI4PyE8v7Kq0nzyNcGGiEmQtygdzoaH1N6VJNxRPsVC3KjTj04OyBFy7sHnD68uf9T13tG3Lq/O6hpy/sGdpyce/Qlgtf9//pq74QgCzEXOQvpFfGec2vnNV9i4BbYrn6n8nV0awMMB+DAnTSPou61oaSM5UWzuMUPIoOcBtgX3dbMj2ALIw5I4zbo4rMG0TakH5Q5gbSMEAFhiQlPzNz6bncMgq41y7g5NkoqG26eWl1wbyWAfhtcKy5j3nz7sMnM43pM5i4AuJpWUxsXo+qHPuy8JqYT6M++t+cBh1uRetiAP26rY1xHaFCrbvOsR0LHE7v9JWat3ZXigGFsNJUvOEUwnEM9Tysrf0WNcSaX82ZZY3W2X1ByKTu1rqCFkXEnHVfaA+VUrO38fvRSZA9F2qlmkA4ThZAChxHC/++HS9zY+hcJ8UlyDGO3LfYlScPZMiIlEXanTHnjswfUorMSJGCLD0ub4y4t8W55+KPJU+Py5qnpSOEMaUtMtIeGVkyI0dPypNReUZMziIh65EY85cHlLYQ7jqmjEfywh11JOeLf7DDHKsd5lq+Hjnb6p1zUcy55scca4HDWEvqXOfPtc+1IcYYW6LPtSn6vH6rXc+l0WzutZ5zbdi5ErD5NqFUxJJ9fXNbLY1F7RyMkgMKH87ufh5xB/tYn0EdAat8t9AF6G2IQyAPWJqwg9Hn3B4KP8o8z5BbV2YlpylGuqeNNlmKuFKXHosNcNZaJ8sFx8qSYyDCmVNCjwEeFMRIoInQTBksRjercnn0da+vd+5lMddcsr65Z2xgnhM3OFdjw302O8g1X/4d+zKNkSce0p2vnJQvAZhBxiIpy0jIkGkpi5Q0I3mQg3Qlw4jJcp24J48KZ+yNo9Bi1z3jQM4W/yNZvzh5Wwfyfu7L2TqW5eKl/QxL+RWR8jMmQ49J+8XLcnFyXMeyvnh5Lk7Ob4f11Sfn15Gcr6MMGRTa+rFeORc0KHtmU+sqS0gKHFjjsjndwafAAixzy96Dbu1StmlTJYfmfU0+Zpvj8lm+qPfPfrai6bSrfHg37e/GZKSUiGN3otlIDfWQhNqg2Usn+OTLgKg6JskWGw8ifYaydMf6YU/L8d5ubdM9G1BVNvLewUcdnorEEHai4nQT5Fhxsh2FPCOGyWqTgKsgFdBdwADIs7y6G7N79xOUJQVWls2at6fWA1Qou0BRgKN/aKHDf/NcGCFGP88Et5Fh9aZJqw/M0wHq1wANGrxW0Iiz1EzgoXwcD5WTuauYjFAxobmKqdxVJMy1ojLRe5C2eg9MvFLVwFLLE1na2P+Ir0Y1/2uqzVd0MrrjfVoew57XTj+LuuIs6iwAQjPAxgalb26xjX+bms3lst/Pp28ryzQZCeN4OeA0YCHhsEN0M0QDWpguREXhmaoKjmnua9iRi8wJfUR2w9hck/SSpBxFPysWn7FGnzVtLiD0LDVbtPxNhnBpwKWAx5MioEBoW9IqgDSbXNPObOmyimgQk89mEEMTR5nEOOH3W9snE6K01z5m9xx2YH4RQKX080FvqVb3lAcUxyKcmQ/AkiwBBKBQ5piXXBxY1qaPM+C1Uy4SxjC2flxTK1g5wXARlQBgGsB0n8ff30YPOvO/Lslflj7q45BIA4azJfMQQNeyNTG37cA3CJVeVkArjKBk/Osp5OAB/a4ihswhjl3U8h1KrEi4NvzKI4Jcq8xjmqbx6lp4MozWZG5IGwZylE4K8IUiuH8ApoHPpH4Qvl4HANTNrw/n5dzzPzrJaRFs4rJwwfM4dqe7u12m8M97tEqROin+EuV7O+HSNqW0LGtqdtmuGAKkdxCWzpRd/GCLXS0t9b5R1KeGZxrgF8mj3s1v5QQX3iFh1iXCeVgEh4hgM3G6qk7snuh/6g6rtuZxvf2DF9Q6FRhNdY+xL5UaUAiXJFB6e6WOVBJuyBTa79DG6pDr8JjYOHdu+qbzGfBy64tqNCwPEsCMNYplAEwAshuLtCux+2tUmH6xK+ZwMzKdRvt9EZvXqiMdqSrkQmP0KgSr20ETo5P7T9dEyoDdZacTWLkxnc8Q5XZzaXYbo11vMGkYg9QqowyZs90woeqeWqROHWilEbxRKgRihBskCB1AjzkAAZHP2+nX7pF3ftVfJ7+ZHjCq21bimSB7cbeF1yFAGH+27VQIlyShEkD56tWV+VlThFLzwrSzu/lSW76zCKnqOMoos8MnwsX5MBV63c2Z5FbXKuBJOjg41HjC98riTtXoGn8YFwjWdpRRRikRuFajQ4n4dW2UURxsXWMxCniRJOCqbcOOo7jDRZPw/2pQPFCJ+Vy6+7mjqlXrB42jOqqIfK/3YyP9cNrY5HOU1XONvhg7U0ckkSuqBpsr5RTrBrgYotFf1P48uHX9+zdmMB3hIUQUQa+eAm5pZYRQRA65GJtdzcUyVNiwA2BBtUosIqVLi3TMcNStOPYZeThdKPoi3wwX5Znj00yh3L2F3TBDqyWjhfM2qh7Sa69a1RGUv9ghneOExb1A2cpsU/ecGs1rLGIAvQfHUYAcHc3PMYpju0UA15fX7iiAy/YcJ3WBn6x5jZvaVI0O5ic9KQn/ryridaWb9bvZ1RA1V+P9fFqvZIQPaAJoTm7+NAbQgSK0g4JiBBWvzYTCVKGHAGzi7lMvj6IB/+8LDe+RBeAVSU9ZLCi9zE+Qi8qA2j4OjxG2sC9LZiXyIN3A/+veVrl3lfaTVLBg/UFn6RtEfaqFoO8sa72feXUIgBNgxY18PX+5IBCchxTnQVgPwREER5B2Wo1MaDv0+ykoZVH3sO0y9+EfVzj/qsWCWqcBpbX5OiZnMgNJUiwVqAqUJmGYEX2qj/3uq7rbYZTHIJiDGFCZia/q/fDLapOAyi52kQBUSJbAgBKDKHiQT7r883/QXd/7rY3kfx03IRzIhD3tIj9rybWWMPkdLD1kpahVqsCnsLsr1xlmNNu3Sc0d/Vr5jp6FlSdNsJpWNVM467eVxwsAJeYrrjAefTon7yJe26U2pdUG82NqaMqqwVeWozDgUhQ0cG0GV2Fo89U/5jcoFo0zsyp5+oVLPp14i4qYafaw512AEAHau+n7HD2whfysoFnmCTdRaRI4h3DsS9IggGkQi/4VViRJYlGTVX3VQrpLikbz0XChd9rmW5lH9Pams77qrd1FpVJL3llY5fDp3amkVMYV9Vh7ho+PSqXH+Tat++x/AP4VLn1//NW9aoZpoEAxsMZGFVwqCjhuYdaXdxWfX1I7XmD6J/0ABWZcYXQGKp/riijM+3WopW1iB5dhXpab4gGBgA0WyyE0Hemz0/sxA6qCY/YJkgQS2IPdWITK0Gd5Xbd9k8c7F73MZ333E9WxuHUbBMM1G9GFD6R6yB30OUYvZMtdwWGftmRCcx0YQE3gYoC97dxpp2PjkBau64P0eo3XiUcaFRF1MuM4Tm/L+GBoZr3NGYbIFpQZIz/xgRQgiEQtbqmoeNaFXsP/+9LcybREIWqvWrrerxTyLFi2HOMIA8Tj8YM7tzldKNmOOux0E+LwEuKwVbETOZxr1uv01MCZONFf/xUlQpbxW/1iuNdTxDt3DP+qRYJaW4AyJ5703Exu+Bu48sBzuf2DwNlDX2QhYgOnBKBB2DgboCYDIQLw8UBKAWIG4KTAlkX8djHdTR7gj2k6/heqxLLtRbfXz4ef6A56aBMmUDvamnYpKJX9LqWEOCj9W+diJbDUqiJUEnb0UoQhMtA/pVl5JyN/MV5nJcCEISR9MdDxhpIA0zba1TSr2Uhm/QFnvhncxnbzHrPNSs/7U2FWrAf4xWGV0zNb+BN3R6GYnwE6ugQ0762J/LQgGBHq8Xb56bdfjfVhJt0YE9qMJcF9Tfv+EziIatUt7W29GQSAvfezlk3OB1z4Kxc5FPuS3BYWLIiGtV+6Bb9fJ7IP6poxmfjCYYba5kBntBBy+6asTLlRkWUR5qj4RcXvLBwRczjhRnR8wwW28YhFOjygdzjiorts274JFgTobvjvPK/N1Jx23suQRnOlmqtrMkAMY+Njv0Zsbu27FcGm0T0i59zLyosuvexWxKLrVePquSNFcfUhcoEljgrcoa4g6qswo5GKNAzHx4DkGThzM9FUDctlc7cK6uwiazK0VWWbtm7ssOsrW0QXs2gpDY79NfLOp31d92vU2aTwYzu2oWL2KYCXfXbcTmnENmxu1os1iJ4cWpW79Z9OqV4C4tsCKPLLPn3w/AWhY6fx9gKqYJ41k4RmdrLHalXSsorqqrqS4g2t1S1Vv7KlpWoFxjirz47Dk4e3n28zKNREBnKqDXK8HfNIFxkDWVL7Rhlx9/TpOM6v/ws1zd7dVy8m2JeHYL9CuNeV+PRMSp0I5Elb0JokRokMBCkIj1pIjAhiZDjrtG67AXQ8dB1Ah8s82qWe2/Ior/pv9XWiEfdPPI9JTZxnAOHxVb+ul2wKEN32bFuHkoSBJLOEIyHBTBhAEhJKQset8TBzN5icPY6TZ7L9cfkuHmetSWNZhLZgZjABxi13jE7JuTguaUFWaHU+1gjkvCFGmCy9KRpEIZh0uaGBLd5Zv/WXRlrqAPOLXYuZYUDUm7U9SCPkXNT9gGjbtKtp2Tzt0sP2FEH2hZhPdIFuADAm8qrLhvByMrUfUDwrDoE2pTrUVq5ZZF/tGHFrzOkHLw983pnJYTmToZDu2G4W8Y6Nrzx+d+e2flgnEMklUeDix1cu36Bp3KHRNds0v9qVdiu0MMuRfVBbIi06wmQR4xVFFEVxSTga2Rhhrp3i98/jDZaU8715x8XzMNv3rg6CIJxXXFiCh3IcmaJUQoD/oc+4uQcODIJ3m6WYaMCcVUtpU7lDbFlt5PX7Od/0fdpXqOP4ru2Ydys7URaBCRKuTzhdGCE8s2C50MRdVf9k0ZdkDhQfHz+1KNaPuArHVAeads0yy8bFDwoEWUTfN9lQXmdSL9F0G7QF9AvphvZUv8j8klpw28tHW2HQ0MBMYtelMOMHJAB7REmFvsS7Lkn0Xvndv28gHG1DiK6s2/4fiO9Qoht+gOLHhYfbaDbPjTJ7BnUsKZD82v31tbZyzbxfWausBvL1octuiHw+Q+T0auEqCK6AHD8IKaWlZbs2vK1KjKOugli85U/XVw46ff3yQZdvBbe48rBy4M8PQv2+fVrR4+j7oHJZeBJRifgNQTTN6rlGm1+3k9n14fJfeOfLj5OfYu61RTfJO89IXhlZFrlnAkdqjy0lycxA5gaZQ4CIpTDxdADwJw6/qx7TqG9/6YwAIlJmsP5a93lZtJphMcp4wDYm1AJFXyLU4uZGvwEcM00k/2Ta65SdtrT69Fnj+KFtYJ2WiIUpGjpdyrsxUnEgklL4Rh9Nhy6umDbkVUca0czMm3ij3gOQAWSFXE+PqLm62Zw9JiSHV91rnc7obkAO/O4oBIGxs292butA92BGwieS+iyVDiap08lsH/rIAqa7/U8vR9GHptlk5/ogmDGY/E2r1f+9OKr3uleETIpykTAl77+VbcSZHiv9V+1AWNAqqYTjsSSAYfLpIJD9JJS0UbZXleTWgGNnNDk9GBMVSSFImpdlsFXzJGYkxYnpcZac1CI0fkXs5ivSoG0elKK6Q4DnNg7aJiu2EBNchPoApVy0qglvPIXr7/Od32/9kBjCj0OPVtqOfKay47NZO2fn3MfdpzyECUz6QZIFWbpVF5OKokDfbSvGyT+EMkxXhjGmAwLs12pVS6vqmaNlGwR1na9NklytfpxUhzE19iywEpaoFQgOtCnnUkvJDUASTkDKcJa31PCzdOQnRRKhXb8mWwHaZjAex2WEqSHS1+ndsgbX5UPm1RTMu0rIu7uZoSIXDl1AMFtykQBNMkLNXuKSVtRbJZEK2Rw88755IaAiE1BUA6gsANTlA9blAr7jBKwbu6gSL29YU7y6Eh/23OWjWKAJ/M0dw0BDCN2BwHYDqmvYdvnyzjOKd+7ot/DZz5+THxKLT2PM24xXT4ueS5szaIkTh5t+QpIVKpKaq9iu+cokmIpkG5WOPdYb1eIZ/n5ZBNioD/RHUc2b9cARZ2c4lSuRJBGmczti39r+kKt4CSTMNe3+V4Do5Or/XsAphIlCkDGUyxJshJk+AW02f5QCU4kLTaaNs5Oyb3L1YAA320lRjKlClNmFNQyWsW7FL1Nf+pqIc4QhScycalXjFmBWA1QDhBnV4hEpr6Da3y+bS9l7wVgfiwmAx9YjPzG4hLDihxtRboLfff24Mub2oHPPDOGBKAXqWfJcKN4cB5qlC4iBRKPkaQM/jAHgY963yVHpVFEYNgWD1Sj6EXXs5grd2E3+XmcRzYFdR/LWcFbMRaBU2eSZyusjk3ee/pX9BUcv82AjgiN6H27tLFaRBEkKhiVJ6+4jAOb9PcnLcfFkMs5F9RgAuNsamZUd5H3OASzObQ2mgdD2KcXf8eB32NpGaQ64qgekyl+EEEx1s3sBdFp7LN2iJeItuKXEF/+LG/jTKdWjKwVRN10DqXPHUfZPHiHI8kOEELL9gd3KFYcNtJJynva7oCWy1oLQZ0/mXk4Xc/BvtAh9Q+gwXZVGXF2NkwbCq8Xi8DpfZ9apV1arQeGwUINWlXRQ8rhM5kBv0KZ60UCUAwo9kGZdmGwdURJC6DWR2P3gwzBP3vMp8bjw7DUAjU7FM6Rki0tj6EbgKpkmD2RaokRJC0I9R2DJ6caRx66fMeXO9PDE+ztPTGrdd3LKzd0njHe2DQ6/cvxmnGdsiV7kqTqkqMhTujwCIH7hQjeWvzofbgG4ajdakjar6qHnLeY+YzPOqxHGvM7p18RaxjP8ofjH5S3Yp9e9VTha4K1AXGGvALa7NC5XGOlDAsvYTegENS+sZbfU6BAAP/Te/rkaCxsyYc4dtMUIs7nmt/AkbAvmoURm5k5WZxhxDiEiIBlRNClzMfwIzhYjF5jrDAFwGGnluz5S3lTBLgNDu7Y9CpEPOIX6NAvMaz4a4rRqenu2eLeR0QoAHElUqnHsUo3r+HSbWe/f2S7yufWEHJIdaLRoozgdDrtbmBQPn1Yf5WprywNRiDA64Ig1XRBumELdj9qkeLI41o3brMZHZeNHsN4O5JfyEp1Zv5VvPR//jBUPz16cdUEI/EPlGsd/AOdyewrAP9I4I3mjV/DzTHmo32dqBYvbZgfyfb5Qumko/MIXnr4vhzcYV+1UeancgJpLFUeHOW6z1zeX5RdWRbpjvXkRLMsM1uOdLus8qrWoroPDDhKE+PSY83bW/DVkdC5bshUEkOcpbvKJuNKtTAwWD3xrKBTABWHY3Sp9AM4Oe7Ct8JTq3R6wTTmPvNMydITmQABxW7Nd+0cPM0adBAJpy7JflEVrg6vKPm57p8PFarp6mnK9T1AfZBM4eYBiXPlClCEPFxy0OYTiTEtSn5F3tOFlOqwoguh4wqNM771PRwlv2irNz7syjFJn4FUHoXUblq/eRdwdPU7ervzjZVd5uRLoW6diK07OWHSreLvumcR7QTy3jjxyixN9+VCzKtAWRZe24a7HIy8cvnbHxJ9x2fU616wnz9hqjmfmPzCb6ZuwMZuNL16pyOfbVra6U3SX1JblYUs07rvjZXn67aN7pN9OHbr2e998cQOWPvr5umCJNbU5TB0es7pBfxG7AJMT5Xw4rrVK7kf43AR4KzCglBSU95WAP6Zyt/H5JTWH19MiQr29rY4r/Mnd5Gc98oMRkQvVYgsbTYupR5zM/S9qOXpt7pB7acP8k9IsRhn+OoDYovnl/HVsCS1xpW3dvXNMD5S7Qo4CR7fwOAQlLC6XdpRc3PfazhobZKEQJ6HSAKW0jpIzCepl48KqRR0UB0ETG3HScD0dWmkP5qNxzzVIENEvWq0Qu7AGuM2GtnwOGYfErEh4ZvhGiijpev4UUKEbbKz19mNO8BUqimqNTIXjanljOCn2DSvipssZdNdsAdl20voQoHqqU32rHhgDT5a5gHiHvyzB51iO1j7PUx/Zdvho6zP5WT4fnlWdt01eiO5m/i5CuGhOwa/3SHPmvJ0nvwkYc+ZAg/6BJ8hLz7B//ldR4/AV9iKd9pco2Hwe1bWzZNqyI8Mure/cXq1l24XXbfWvOSemN3As1Jm8/JZ/65PJrDGItWzMPjg56/gPeQxVbdHtqUhNUReklhT/mfIQtDDG128QqRSPCgpSHQOoMTerTmfTboHVNEYxrIwWTY65inQ+1pAQ1x+e/KPZPzh5bnhEDQc+0SIMr55+YVwxGSRgBJAFAwiAlHMBwMsfd6r2wtAIrcK3VzHtOBcQIHzZTVsarkNOqbzUoiEaAgS7LkcbwgMeG9+1eG8RPdsT4GJ9dI6ZAHq1P4r7gl+qaA5vPaiUR+rw7NRouyJqGzsIvmgJSRRlt/ObuXKJ7R9wkOeiLUoF2oZYh7c9c/wSR0o1ElcjgoWNaMJITrbemEj6IhyyCjiWKPJ+m+Zz2P3y3o5/cZnrLK+SKOQGlIt5Jc9XD78djzty4znx9S6YtnNch3UL7AzADVr2LVKAJIRp+4kIgNxY5xeDCidy936u7dayK1QQ7NNzwV0eSXpJvvnKGPqMwY1h8W0EWN2kRtR910W59tRaxrIR7D2Bl0dZ6DlKIpVdt+1SaiZesXri5RsmcD91gFGebHakkjKHRHjlu5hxJHZpRcD8FYl4zVXJMyTbzoTC434LZ7umCPe1LSvnAJcP4G93NcO4ny5toieu9jGLvV13u0tmc/udATIdBUTFznUKwYI0AWoTHPZh00ng6/8vcZsSD5QhZbZ315NLx00hRTrOyoU1kCzutvmdMGVlyj1ubDWIUfPZLMsXdAo7lJGlx44JFxAlgc8YmtGkhNkhtIQDayXQf0PYyxHmIgQej6DNCFqN4GlEmEDQzIjU+ojMzgh18PUNgZsRdg6BGz/yR0bgps+IcOsRuAVhdyLsbgTu8B3ZPzpCDke4RyP8U0R7FkKfhTAnIcw2BPQhQKLDnGMajDeZfvptf89f8Ra3lL6aMYyt67EEzyupMZP4IY+kWtADL88KcaMagCotLkHggo40tXYREEVWrYm+c15tWu3sPeYKOOYVkzw4u2pFBjB2aOblNC7Cebrxb4xFME6WYWz2S0m31Zof94XLxR7v0M1YPuJK4HLEmijyurFvLPPGyZu9gr0QRgvhi8bTOyroE6mMNI/S1csaQT18Y2M8efDBJdYgVck4evyNLiHsyBoxwyti52yfus2G2ngGYBHhcbqulR/4DdUy3sD+obTIRBYtTYfDO5TILxKgOmeG6bSmfvKyDSkTxmCqlNX8/ODIUYqjL89fZrcUJC5bAtERXBhxujGTRtquAPwkw9BwNROFcPAqv6qp9bgx9BjdZdtsLMFDaPIbTBLGxCW62Hz4NCe++PHe99+xuO8Fzyw82Q2w+LKBpZe0bm35BpwQMEB79MgBamK8Xs6fffkSOa6PdSoyU0Zn4uKEdoEvxb12HO8cGYJz5Zmdo9z07NWW+0wJ91weMVm69QBjxmpbsjSImLzPcHINBgg7aIAigDJAFgA+9hGCyEbHkjqZgXZtlTLJBvM/jEDPUiCQriqNdBKGmUIwlIWrmxe/CwG6qW4mrttKRot3ruxAWIeL1v83PIwBz3xZy3VAhpC1FReg8uXpTXBadAKXRyUgeaOQbAonlOOz6eu/TMXN7oxSTepYLwhavm6cmp6m3ve9W/vs2jv/jZDY/KBMrOdon9QOLE1FodioiEr6Klunaf/d/Tvt28ve77bXWfbqZZ9e9utl/77tf5b9e/v//XvZ72z7nu0j9+3tVfc52757OdOZ9tnbd3zHq+99tr3OsVdve/Xx3Xv3tvc+vvQ79u7jpW+3j9/bay+3u7fb2dtt7eM2extsZiw66EwYeBYMoOXRmJ4mtNj3Lk7+EkyIB6u6K9avYklwpyvbaVS/ePzcJ2dUn1H8PNItZ005vrHN/6fTOKHUoQgXYiuhEBimUkvsZWfOY16Hd4680K6YuFcUgvckV8LbkkEJXFFrjAU510Xs2CBVWwQnouOaz+fgqTtwJU9gOd75xXE3i+QH/pjK0m4rKOqVzidv/myFltEv4+d7fUvkr1jRzdc7j7f7ybv55j2967s+dz8/P9+8fn553fP+uIsweW6rm8v9unjn03655be3LTh5i9/+gdzSSt80jWmvQRjwIyvMYVUxg7aa1pgnmfbdpEI3TRha6qHmSV1hxITH7cpxVVFHkaNQ/+L5qmzcDKFTQBzxw8Bq7zEONEQPTBXKajAvqO4ow2Padl2RbcnInqZsJkFMU+N0G4mzBm8FrK1UNz09iry/6fb/+IWdl193o1fwwwmzA2S1o59r+oVPvLnXfXeAW7z4ieWnsG5t6dovce3agktCcEKEX9F9BAKwzHafyZw8iozLM+J4KvtW8SrD8hLAM2QMKUgoFbllSbml14TQMguwzYBOAJACIyyvDrdxGwDQyxvdMXyvIeH7kRuuR2mEbNJtS4m0Omb4M26a7zTn27y0GwywJ1Ze5Q1BABFXBiCVyU2RJBxcQpHc9HWTq16eByB0gOxSueBFjeobqQfoiKb1FMb2Ha044AsXKXLYdBKoypcvf3n/X5SEyzeoc+i70w5qEm3X6CZFIknvIHF4xszOojDkXd/069726+yekKqkidnq53TlSzNoQQkES9nRSeaqsqIKYS+IRWx9MrWluVoPqqJieIhOZpFyHZ8SSb7TqawcViqHSLKr82pYEnw03Xnb7Z0l77x9Dk6QV7Bla2KTFcWi0H/Xp+OwCl44YxPh0tphesK64lxErPdo63d60KyW5e031Eq7QjiqijvSqGwbekxdAES/Ls7f7RWhLAUnZi1bM2tZuKrMO2/H2y1W4Qj5x8suR+7l7j6/n59ilfeCGi/NEu7u7rnL+fou4pvn+tZQlGbkdvf29vXNWzF3uXPPvUie/BUXOYG7rVy0mHF5uf/cZ/PDP4hg7wmmVxlf99UCAaxbHf3h7WupAKw6yonbwvPtUrP0Gvqw6e/9+xq1AdtMqUJhhi+TLUInqhBUmM4r9hvjJD2P3YjUqBCMRBdA0aYP6K06PTzqxsGLuYQFmzUtJpXWrGGcZBmOjHq19w1AdUjZFLt/qW9QUNRMud7QfnA7FjStq4wpjQtOV2YZqAW2nfGyB+bPe9c94IKXPTH/pPkfcFiS+wwPgHUWZ680qqPRuFw5/GOGLe+WrZof+8Gxnrs3plgP28aUUNJn1Cl9acNjkUbn6G+0TVL32EtCruT7VhwWP8SyZsKUW6F4jQ0jV04t45aFmVeDSb1KBdcca1QvKbd3afjW/QCSelgNmRGs6RnwfzH1cchpJMOnekCBRBaG25V6GXDjALQdj6FPMROvAjezDnmj0IBRPs+QTtnUB4xjEbROdNL0FiAH/oMWLnLYysMy18riEMiBuLgijrYnCCht7Z37wWb5r6jGxQsOVlUzJOfAg16T27tfIX1V0qumRHEoulQ3A1ZJUx4AYwW5tLzWirYdeuhpz7yN2qGHHkrv2zZXC/vQBNvmbGIEYoTRIGgRnTCYSNPJDvUKUXB5F1lGOXKuv3gfFjQdnq1QbDc5Yj7RrbHesc6mNYulmYg1MWCYG6I0U0moYdsaDwAxkAElN29fpFBUVBWR4oo79ojFyLzKB8gqpJQns7SnOzUoqiwXAqtxgaJoVtH0k0d4ILzz9Dffa0iERxOHKzM00rMFRcvV9d22/vLQIlmAYhGFPW3mB2g09w79o27t/9GN+230mvpeNzjq9xaXD434/JJavPcvzWbvp07rL2hN8h+oeBDmS5Te554284MPjYt8mDjPrdvU9zCI/aEab/CH1ejn7inRf6Lq+O6r+s99b/V9ymb1fkrmDq+nRd2PbeXwmizOKOo5HCI8otimFKlZKXkAabXpfDadefjQAJa9DAk95SGtpcbSGddv5f+2IaOZm46gsjQgALfGewYYBSuZDIywm/cV6Iib9A5VHLHL2oQZn2imQWWkHbmwxPMPog5dG9lz/6vpEftedvc58rg+65/thH7nb7pC133T0jFcZVPkc8tXHe/xztOc2rBMaKawcc+/MVc1uO3O++/cfqf/n7z5Bhg5W1RXPOlcvvrMxuLWmUI3zZjYJOHb+k5X3BPcwhKTY5Vzcm/m5FHEvVb8B1whm5de+R6z52J5dXQ2IbOgN5S37QNZ/shAn1NYZAoD7SCWfgBugQMxMAI69kvuvWeybMAoHjGSJQynmY9kmY+hmaxX12MgyEx7nmbVY/Y1JViJoBg4jUDZr6SAtMJhKOS8qxfQaWd3/TaoHvs5q7Xf1Y6twSkjQl2zcszd8Hp97CjrPKqzWKKbMDtgKWrbhst6e7tj7N6tBGELK2OsiOoCcqBUKDY1etdBb2faefcpjquM61XNHdjE5F5UfWBYFwhKoi17etlIVTLuiiIag6M1wUJieMg+0wj1BzqdADMnymDBTCkbWd0kmk8j0b5g4f2XBnRFnA1LN9nnnX3EuJqh4GqJhIYCFs4ZLMZ+3+EMzlvRzU9hcnasvY0K5T1e9eKMxXYMAC8TBgQcUuJSslJBRVcJgVWxtKGWT9830DdD1TejF2Gyp0e/95ZUzERFLMgOLjkBfjgVjIB63z39FqP69DgrwT6TaxmjEDDLAfkFkDUArQDFAJEA/nd8ZfMBeAEEPrO7AggFCHn1OwVIBcgCyAMoDAoCGL9bgPS3808A4gCiywFE/b+7evUAMeXK3cy9AqQ8793udrcAmdd0TW/noAGklwww7prKAYgBRADBAOUAyaHXVduN9oMpzYMBJgLQSYAKXB6WYXlIu/CVm+QGf85TX286IAhCuJ9hWHrK4so29HhSUEu0Mrw2ulXmMcKuQpmNoaREEDUzZqcN3oLSSkBRWofacuc/7BgW5HeofVzQMSzMe3inX7f7e3/HOoBb6LwmlpgzBqmOq11j0z4UKmMkEcBBABcI2TNAkOljZ3DyKjWqq8m4rErjcqZbHiMy4j69Gngppo7vUM/pWg1UFYIQILKRNTuZOeCjp0eRdUD1APzqqT9nhQA6IID99Kb2h9WYS40SV8Rc4x1gMk1GmW3TQjHArL61gAF69IEqNVIKidxKmkYrRM/iiKOtgMZXXfm7qkXlJ3YcfrD4WMPrY3k2Jz/YaydiKBqjG6vqqARQO7ymNwYRwmuyjg8hwuUg0C5of7VnAE47oau3ZXKK1L+8gzl82KG1eWGR3NAsXbCQQoZaIUQYyj7hxQM1cI6JalWBZHMlpKQM+VORllDVM0ULNoEOmURqRMyHunyIajFQWbwhc0UH0j4DNFqMlf/m/g0WnyFUqLmuYmNeQsguNBN7+gn/+LTpyHB0TYxPy/CNCd2g8bEflSFe7ke74tnYmEEpg7XdEUsFREcGwAozD9Yi2YI8SNtsUaapbOqd429xS+n/j5PvIMG+Eo1LrTBfe0Y7Nj516BOb1omOZkNns6LL2Uj3ow72MuvXXqV9ft89Sfve3axyR2lCl9JJl6sLXc4mdD477Wx21tls6Hw0dCYDnc+OR3iEzqWji9HQxezoQjrvUgZznI06rkZ/2k9zlEa7liZ0PRrpShr9F11KZ12Ohus99q/W+WzoTDo6lY7j/6yftVNpOP5n+2yfbWezsS6kjzjOOtTtKIPdjiLvXjIbyXzvXG57USu6CaQ3UL46UdmYzTCUQ/Z0oNvRrfTcyv3VdQh72I5VHrKMCCbjfqfbl+hj7rcFfWOGGFgfpCqdq5nTybwprGkpbjAE0TRNJZylroSz74+qGsxVVgvy6lYvhyyIdvdi+zpf57J1AHurfwFHm2tqkTIbJUyG2e87xTu4HqAfs4tdbJytY/843Xhnjz70/8TJU8Y7dymQ8wCiARz1rg3823gkABssxyibQA+uFQZwDsAA6X8FBtiNtYvgJT2RNVuAB+9w5AlE88ETGNQTw3l8N9fNDMyxmYHZP7P901ror6fOf4EjVdD7NOuWKkJAyyfTSpJCrVNWxhRk1sEjylJV2jrSEKpNZwYPq6qfEVAYV1VpM69cEjTsYVUdVu0IpVdQGSVNZewz0yMlpoeytOG+VPwfOtSVFgNDZzPYRK9PAUY5grqVlNGbDKtuqhKRxdKZjuIV7nSDfQZKM2koaiKpYTkYDmvXJA+Hpe9pGR3VZ/bWKqIDwqnJxHtc+kM+OhyHLnQNI5B/VmASHQvkYuZjkRhZ1zNZCFqRMvA+LMnOGbNef7VrXjzOh1lWBYBVwtnk2A4mLManqYfcq0A1Ygxp3H2PlO9lBYnihkX0evXmJiJBlyMKrRjE5Mu0suXUPny2MmES7J9nwOEt3OS38La6nElS/Jac3U10+dZ6OfUXmjx7nOWzSwGqGrQJKhzTKruoP4lgUAKfVJClMVG86XOjN1A+QLkjh+yNybyL15YeMuPv8/z9PQ5uA2IhjZPRoUKHuPq5bsA9NorkEEbCL+zlvMtke1K0MZlMYpp+h6oa7xqPt2HXvZaVLseHa9ZSdJfsdMd2SxNQtcsh8OpiDpt3Xr7mewsO05OorlUvr9/bh46s7hxlxZp6xiNGwyQUdLiNYwDgxjGkXpnOHXxECJxCkDXhdADMPpuTqjFItapje91fggAA0csRwAPQGugXT51Ev3Rp9/ILW6cXto7l8bQ3Lmc4tyzp3byPJvtqdXKD3+wvQ1AqNOycI4Fqk5ytrA4IoJOgyEMzfCP1wP/PieKhbXp7/v38b92hMcPIA4dnzpTLrR+K9JHE4tx1t20FYNOJteMoB0IB339JwOUbDFOjr9rucfkfIg6gB/yOw/EvefyZ45z42q2IA1U2U05GrajGJ9iwBPoc5Z5c31dZQk/g63+oyIACd97x04b7e+vGOL+4I4ZkCPpjUgaTwkayYc1uei38gcGVEtgspsA3RPjN+X4Zi6qsKxlQxAWBLIRlDPch2iobK2q5z5TU7JE3Wpb064SQZUiY9RSNsjLHSdx3pU/Zh4x91clMHEzh9hmAddRcjXN4e6+DnV2JIm6rSL6fi79Z2ZnQGG8y6ZNiEcZxHLtI7MDb3ptQwv3bR1VanjGS/zq2z56z2651HF1IGELFAaQoaITv/5pK7P/+08Cp9ObSDb6f+ylNwqUJviaVhM8//y0osP+KobCGcwtUgn+SNfefDvj885eQbsJLlFAO5hZugTVOOgmTAVPm7wIUXCE2nQpOKYt7Txta7+rMZzfAMgZ5vIqxTg3Wtq6qnrKjpilcFwjsq3i8NVRFFJSUVw68tarCWkjJbslXaVHkLfV8xtA8GI97H7nXPfHu7r7T3Xjbq6e96Y43Tnf3LW+c4e5bXpl+/81vnOzmu4sw/a7zGe41fX2uIl/S6DUF/U5+/zhUI5O5103ix4A0FCiNA83I3s6mw96UF++0QaiHVfRxz6IWn86MxWJqf0mCpnVlfTTfBRybbUIDFYnGNhm4b6PJpT7j/SCAA2yEf+mOYcE8Yh8LW5V2Fqiy8cxfRRGQ4pWUDC43B/UffDnPmhSKAj999bMZG3CuMayDx8c2lmMrsLKlaTVyKmtetNpRvt9HyJLjpWMHyuON4igOwdDreNIQS0I84v7Oz1WBP2/QyJ/9k8MP9/N/g5u69NlzEAdbqlLjNy9abdxzlNAgxxAIb2lfdj4O9IUI0TdONyQDe7iw3oy1FohSBB3kNF0G5NtqFa2jALnPSA8g1jJpO2OiK41GmFystBidFNSmkCSBC0pxSDuuIxbntvGKPEg6ELHMTTvuMlvli8Fs5oawkwqFpIC7TW18RhxYAgWIcOB7vcrueb0RIXNZob3HMSbmYYo5UdsFBMYYojx4sFYQGeY0wqC710KjCH8cF4oWgjK9oj+LB6CypCseMkgQSqMoiezKayWjXgm1Wqnz8lVyVcdXqVSp7NVZw9KxOMk61iBL6VghlpLqgPJy3nDMqaO8WeUTHD+gcvlfX7cfC7o0TYxzgipv8cBJ5pMMXDot0zhffT0bjYCoWSbltj3TcjSI9btVWQVKXy4W9YuiqoK6oJqzELBhTOTpaxtzDJkdkvXMyiaYlY0zO1PP8cz8H1lG+1KcZ2yJ1b09pM/Q0XSX7JYGEdm7WjU9IXH5DVV9neO8NEc4aBmQZx1r8w1/KNLq/hY1mwHFOPbVA7pc4+Cgo2Ac8Zg1LNAQWMAwB4o6tfGQa1YZyZI+PZvSa+odJbyBHoIbq8lnQzI9Wj+9c4Idvalf0e6hPE0UAQIGUejnm6gF8z19CC1UaIp6rEs3MVNq2rDCoVEBX41KlMzFC42kA/R3to09m+qCPCrD3rN323wa2JV3uFjGguYik4pACQHosa+EAPWTp73yea2Wh+uB355ZrQ7tVPVu+sz/IK/zbDwG/C5h+PPDvYgweEX1oOuXzgPUlBgqngrVgienqH4l+Vb9vOJeB/HjwDfHcJmCdSBi4xGpmyvuuNRhIAv42qrquXRY0V0ZOAc5NFVlrWQml6woICMrr4YMq0gGB1lwdI7ozuYmEvx245WlR0jriLJKSRaMJIcdPQCrxtu5hnYZkSX4ybbE4N6iDbTnAMzqh130QQSUdihsCGiCHyT43Iq9NTT3HvbzdHHLdy+5TbnzjmS+eyQYjJZy9xCgdZy/wnni3KWQ0PJYkngWaEvLA7jOZaswpRcMi4gDTesitBQcLRN9zVKf6qoaVTlM2MFgeRlGqA7VIhQ4tEUAzpv8uOiNna2iFlmc3YkI5p03O1npXzxeTeTSYjST1soOjLrhYAjrMiFaQJIWVTTO01fc1YA1OVFXzswXklzkDIvY4pbYU1QcljKca9ZLltkyxx2ul9T2ytgRBotRUyvU0CmeYOxvoOz4BYoOX6GS99xqdDRXo3MYQb69h2QwZBjU41KAcZYjzLdotWof3Wh9Wkmr1V7AArfvEsJ8xlT7GPCldi1a2V8x6OGaaPOYxOw7MaZPFOaT1PWzyORLOuzXNMv191DaXNL0BzQ5uRrF+YWtC+DZ56ivkQE+rIW/rqwL7dcwqzQp2qUQj/YyjAhTSbJUMmZ75CmSHsyn3DGPPTafBlaIufZyuT13kHWu1JHlXTowCyq8xqlk4yPItWF8WYEAIOZ+Ydx1fU5T3PPp18g/Lcw5O8wok2HtZ7cB1ifrIDk3lLpxoUYH2kz7/kiuTJ7FsXDBvYAKHKlZUAIBk8NqupZVHEL9Xc+pLAcuchOthYQUYkbPlfQshffWgCMxCludUKZ7YmDRc8vLhoddKhp/rm37JBq2LBK+hhiA2LhjDchcIQH2ZltcBNBQUV1rhP66T2FqehHgmjwglSh0S9JahSFBsX3OIqhEMFW4opt08O3+cepa0Ex+vnMtO7J91twzCd0lxKGckTOsgxtUal2ikKQFtwJSJSIKUQFFAUAFSNSROQpIn1KZFquEpKYppwb6q9p/BogM6W/Pd6kDqHj88GGhFK2HTt8lXh5iHKetsJS6h/fO6QtvDdk+bKEyClrnlFKjMvs9DOXxuvUqaOpS6EMMPH9hDZchCB4U3kbwHkTyZMtlNzIz2TEXDzp/YBRiwivNLC8ivSQpx2FjsJZChJCKnNzE9seRBTBuCMtrUOICnMIsYsy9N4S3JoEch8NImGex1sUUenzNKkZ4cdULl/NmVBKaddZk0Ya0ueTAI/NLajU2MZtzSndQiRCsLQLgqHJc22uUvNwFsyWFrz0GIH5wShsDXyXxphTCGBjoI+KqwxtUcy86I6xhbJkfeGurXAUk6rhVKgf3oA6oy13T9958fDVyLJ1piHKRWN9abnfZWUw50dkbi404xTq1MkSnQtSG4LUDiMOAdWNHPzp+SvLwsBIkwiJSQlJLeEUY/MuFq3A4QJrX01Kd/mCd9g8+g1/+4NMFSbJx1fe6g2O5S5sF+3FZzETpe+U0K6GiMIC6ErIyxCXlv1KWHCZoQNYwsCxyiTSoh+UhY0FHUoES995xN+XdGIzDgOqqL6mvAIw92JJNkGeopcRpAFU9rva8khBhJ6STgVtNun7yCS9mHC2fM5sNN67tnYkhztH6EOoZQGtI9lcvAdCxSZtvqOOFEig3k1hlQMR7Hp0DOlY7OCKxmka7b50lexglQhTKaYAKMeLBMix6HD0zU6BvZUyYAUsVfYY4KOf0aiXRSNIPO/aKxSUBwz41/UUI+bFcTX1OwrBJCrXalw2ELcIXAqpEGU+WgXFo+4tWzpJjSSvvoZ+ILOlVHRprivZSw1d0/v1PnV/HJokWbN1iLKoZi2jWRmGJ6zo50TfvkvWrXPZM9xJugO5Yn7KKzwnaSuDWO87uOkWm7QwI0+8s22NEmpUREUJ79abmmDSB+/rh1TeM6nFyy6O1Aq2a08YCnvqTgJ1dj5cfGc3glUsDrM3Kq0yodtDqmHYeekIG4GGawg/6bn7mg2pnCf1a67ybw/RlbVJGpmXpeYArbXj1R5lwCHz+D712GreIpakHYNM02MvY0Fk5WbDCJJCQHqk+QPMqJ4Ot38QsPQm61Xru/4VqjXPG5OpYJE36EP8nnXTnO5OBHOtfgdjG8kdyOUsTEdJH0uocaevISasPaoqC27+W60roHPuCowzWp4biSaGZBZJUeEUZdPPCRTi8A4woPX3VQjC39s///IPUdSqYZWvv49q3ottD+gy14oTemshOAPO2/FyaPjloV61ZSufKYGF3p7DIAkM6A0WSiaiCKA5z+LzHVJUqr1SqnOwaer+BVS89UFOaPU0YUGa9r2F2by4v3WL6XwFqZrJjH7qE0DXnIKuOcAWTTpaeUy3BFjGcCHVNEKwK+2d22cmS7VsCRQt17PC7zoq1jM3hexZu0u0lfCUjVusd0ABgXWhoG28LdXNZ36dsBmDf5mgfUQRsAVd7wXFGAsWzw6aJpAwtZS6gGIMqZWaPogiqA/8WsV6/2LW4geh+MgMkpdoLEeR0rf+B1RP6us4rj6sO/MXC50EKEwRy7qUW1CJsyHNY5miRXrZSURIX7eM4ggGnf/wXptH7rL11GoiF57/5iWvnOeIyLrsBhxXHYcZxZGJkOwlSZgcWAP4i0QCfb03dX55iA+hgjUQ86aoOjuceY1hAUot06Ehk9IhkyFUGwo7z8IKADQdwPZtnBpg4wXmO49Q6xWT4nZ+ufm99mVy5JMHFAGkIqCRCHxKebqHk+x1f7dbGSu9u9uibSU59Tr0jny1nNgeGb0ImFyJE5HIXdDjTHgDTcH2EmYxSblEPLzNKYzI7BO2FlZYCflDF2dygyRVevZ1k+OP5roPWjKlU58B9E+DnQB7Qh3RTeZx0Z5r4yo/2BUlPNYOFOJbsMy/ESjk2DEqaVgg9YFukbyHl2DFEOXJik5SxuLHOlfBkXdM5lUmawvpQLDlbM8oEMQueE+EVZdCtS2fjyN23Ego9D28l/XkOw/ZrNTsmYB+4vm2dIhsJUK43CDFCBiVVzhkWeEVShNNJsGP+2Mde9OSH5tG0RxlKZBpXWs2RkEm/AcNglXhyJtOOAcYNuYs8g6VO6DmWaJYI2y7zgxOcbRy/+7pQOm9sV7OcAe6MoqWcM4mQZMLcgdbntCzfRCjHd6hfAzTELgbiq7y15sWy9v0xV8+aLF+fowH3XuddR/1K6GmmPho8nI0UyuGeQ0cngsBOQd0eh+LaXf4w72QQifdRhNDXhMqDvlPiRRPRfAqS0IUp0oFnw4w54mTcjrRG7JEdiYX8ARXxXYrrh1V4J/EDVtrGamyfy/qWSiQ7q+qX4Eo5jUen5Ss7pq79rkNU1KlaprcFQJd965LbFtrCXPHJLw2wSGuhOK+gtKFUWQ3kA0rHbLLp1fThP575fsTl43tGXTqyb8zFo7ujrxzaNfb2/u8Hf3N5fvtotVtTE9wDzLfpgw3x409rqADSSZDudiDjZmFIbAeC+Tpm85w2UR/VrXUeWgwov+Aoj221luBqY01HmgtQWb/2vkxhqTBBMyDMyYVTmwysh5wAkAHgezYAWixXz4himmimz4g49jjumF/NeaUPHfv1v2u/neE0P8iaIYSJAhQpItkUwiSc4Rtn4NtkoU9mCPe8TTNj0gHdIk2NgyKiYEXiaEDDSfZMYbqVPI91Ldh18q8iRqUqwx5joirdeVuOcjNxtw90CEYPHbYbRZe1DtFi80Sv1/iUw/MDG652Syb9D6MIZI4bxmew1EKQVCFuMfD2lWW49867ie4ir5UrqYbH4O4pbY6IOACrgxahg1mtddAfEokj58pxPL5kAuDCDegGZKXsFkYaaWAoqNakSRLIO9NIG8GGFKqYGkeZeiaFVRtkJpY6bdpJViJ6r9f4QEfIOy9fi8eIAWqw7Tz/mWZF+IhCsMYOKDA5sWDiDlQPPFPq2+FTgF6alWKC4uIUFsn4lfxid5N/dyhqUgRK17BRZ/rpMKS68B6iUQyyOL6rSgSqJLXJURQipAhLuZVlmAMNnkgyGiWReuqSGcqTjPpXuVZ5jsoIpgS5CBXlz5G4/p4pCM6gDuuZ6w7gPKK1ZJnX74GGe/qifzqlut23zmHw7iV7Z8nux/6iv73NhyJ7sL3srGnByFgG5oSUGaVUMFQU1HnrC546YJ0DUOMGVPgAVWWAsmZAyXSfcl6baiFUrVyMFud6AUL6hksceppjveSTAeEilEs2pdox3f0F2GrHd6iz6QIfrVYZYwC8WurtuEQchCbI6AZCN0iNkmYl5RhJXG41whyrOpMsH0t8MU/4Gy3qbWbHhyHZSvFuU7mrnW5z1bOYVjf82CKSk+yo196PsHblstSmKCJJAn/EhgqMr31MQtuQXa1S+0GwEKj5jnCHA5mmirqL8drG51IPLDxLFKgZ7VOGsYhN7rTjAX0Aug6hfIFtDLia1s+mBXN0aafaNlbUbrL1xZVmI21on2hynsFoCiI2gqRitVtM77MPVuDwAKQVrFyychzvWe4kfPXu94wl5DMbziv2EJs8ANEn4O+pAGgDJSd+1N3jb+GtS1iquhTINGX+aFekrN+uXS1qnu/5qGDfrpOedNdrvdbBr/Van3FwQ/KP/37SsD///u8nPSl17eDXOmlb0i8XnxHHUiLwpHEtnRvpJLEoJlw+DLNly6FI6tnk71z30Nbo5S5mIANaYFKWPEfW7srx9WFX9cvPgxW+EsvoEhErBbJFEJEh9rcDOooRAOh4z8dMBO3ShFUrwU2sgsfAd2NnSuTec2cyfe3jEsL9A5btUsryY+KFrshI8jAIXaGNCCzPAh6hSwOEgZEURSiewfWiniS2UokbZRrF6ERxDEeT9fGbRTiG9wfMnWeVG8+wQgWUNatF3p9CjrhoSqlPz1fWxlKKhTVk2uLiCt6tyoHJxNq9CDfAytQuqf58NR7tJ09mcM3p0kYev7Yq1GvLnm5t4J6jCVzziCDUrsjnlhOFiD/lgC2/mSr1F706mjcIAyyQEUG6sJh0+fu7JnriKhnT9HHHtHmtOy2V8Wfzvb9scrXBRqSMmF27KWzrM7ilzTaqo5F7zVrBufL4ZYSb9C02u3d/67P7RTtbQDEAS0VvAC+NBsAw2QzzXZJZkTF0zXbdvd2uW8wSylcLCAiYXxqwS2+CDuRRblzju368Q+aHO7VVNRs/SOPBygk3JfaVJDVoy2Hhdp7sFw96ySwsXfvZranergSIi+LQ63VyETXh6myilUPUpAYAG1OHXLj4AEcIdI4o2icwisK6BqJAkj7VS9DWxWd8c3UkeBpfeWtrvgB/cvuHMnr5Mki58AotTmdvKF0Q+EvqbuHOz062zyYGyAJqYVPzOr139v33cebXj367JqFP4a2/iRwwH3rYLmK5VTpsxtZtq390WVFkuQvK9LyIcm969dUrx3uP5l66G3UZ7sB/hwuZowS0pZnyQZ0w3aLO3tMZf3pOOC2xERFALzF9QMEU436Gy7AaMEjkuImFGYc0GFyv1ILfgxV0ohv2v2+zoQ2C4KeRDfS9MpU5aI++CL0pAvwzOtdnFK2gNh6YvFB8J8vIz6XjOVXgAFjTsGFXMuEEyPztByAIrckdOd40tlIN1DKrayVy+h3MP152y+Vejr3BgkIro3mzOSqnlIKGnFPdN6udbMq9XCGEy7QrYQYxZbUVoqLjmWTlU5GIPNrRwa/xLJnTVPlEiUJu4Cp7ZoDVrvAwqvmlHgA7uHgUwx/daQzddJ5LAHQc+UkRABoELwGoA+gCmM4HkGBU5zhOXs1GdczjlNZmVHszMDaF0PNCML/+F0J3J1B2A5QAjA25lsf6Xr9YbAY0PAghQ7YusrBPacDtFULvoGi9T41iYde1zVwQJ9KcaKfqKWgzod8HiLqqWZu7p3N72dktcIH3IEpw6QYujyWu8vhFPyAm45OVvnjcjqdOoJgw/JGyxlWZ/MiYyHkya1WTIGVaNkOA3yVMeTJ7t53oMIIrJDFIIBiXa5lq5iwvXvH5RsxyVWUxYRb0piKymn7Q10Fmz05K8Y7LXTy0bFxA/rt/z4++K0TADSS/xWuvFcxic83XiQAOIg+fpO9WPnsK7+MezMy+xX2zXzHff/+vSdT9V0f+w5eLPP7moq7/+t9c5PHLRJ6+XOTpyyX1+FWRPHyVyMNXizyM7StFPX5FJC9fIfL6ZXHq9ctE3r4skvffXORj+M++PJT3L4/k/csk9f7lot6/QuTlK0W9fFWsXr5W5HHvYn/aJ9vv98v6m/2z+Xz/rD/bt9jP9sn2s70Sfhmv99eb6PVjm6OODO7hhRAZZPjGbnSx9or5iG2TU7WSs+otFgsutbVv3UTy/mTOw3lXJACRnfYO3P+aDlxIv0gWaH8GpY9f7Z/zb8d6BEg3nys17z30qFRIAmQZ3ICNOdvF5nAj2k041WUpDPHFbTC0hjjGuJJX+HnOMBP95wNgdlgjWx5Lh3B5vEnxIqelpE0uDzynOtc6TqdWs6JCy4epAAp1GLl86b0vS8SwqQtKqAqrA1fcAeLMboc3K+3uNX1J4pdeqKUb/9QzJp9/quT8KQ5gYN7LXbMDlABAcVr38z53hXMfdWahmBcXESmbgh4chPjePrl4QRyVzc1PJNXIcm7t2rLGBbv4lKPFvkG+F0uCVXYr00r3tCIjz28qQT2wIAnB9zMMs0Kvl6tETFSHBn3dH58mvPOM5F4zn9PafH4Pq4Fyqq/Z/khiCcNZwkgaMaKlb1N62Dp5P9Y319aaYN6KbZ9Rcndx+dAA0Ote2kEnc0gZHinCY8ZwmNENkofB4yE1QGvBXEuVwpkwj5qhz2tUw40tW3qVFh1AFCH8VEurVla78uCyIk2d69csIAehUuejHnLVtjTWu8rpZ5JURprNgj7zurYCsOJSxvvud7o6yLMUIylIIFiXiMNTmf7UDU8hDtBbqRo4ObdnrZpMg/dnslJK3Hra2SXJ/O3/8qO3jUiusCeCPZr0wWWdE3EzrQgdXvi7RYAGAdpvHUF8BMkRZL/5m0eQHkFqBImvZ9/8/SMo/5gRVH/oDx1BZWzfP35Bf9D3QYD63SKgAwG8b/AN/vTRf0jgmAYQG9/HqnTmQCFMkgTzi94k9CbwM8se1BmLuxFR9kzuVBdpFM+xTl2zBAk9cRpa0keUIUwtagYhXTQscZhp/I3r93u76oEGEUFgdUQwIcpJV02QF9r77YFw6GGltgvqqs/X/H3j6dNDAyaBKJmL5y/ukZ2yMuVqpTDiq7wlTFospqUBQNL9LGcNqwYqLlpgu0hasJRHYQUUFc7UBhTYhlr3Dg4PStnHoqRKrWy+Wi4SXiQK2IQ6wNNzASqAGOE0wgyIM4YRRl3HruZLjCDkl2aXwDxVcMIDbL6hji02nwo5e5tz34iOa8hzus849v212Kn/8x6tKuRPNs87x11u9WW+xxpHUechhi0PckVCI9JJuWxUZ+qRl2hENgb+AlHQCWJUCI4tWKD+EvZkF2IRrynYGp1NaKuqp1/Q6uLn184YMuKMyHWbk7H1kJRdY0OIA/lrUncQdHhYjQb4mfpb5Z0vf5PWijk9NvPnPDCOZWjpJMwHcRa1qEN3W3CbSfwxZKYjF5hL8onqrTC5HT8YIIx/I6zMhURIQ7rSooBicozQAr7hewLMsPf+a5/E28k4BmUoUHdSBVSs0+T9L/qMGUKjpSvO5Va+4TmTWJ8R21jpaZuBeUSoTdEExUsZOzAO9lu51B37fMaSuG4YxwIJAisgHIUicci0q556FrHdYJnKtllaXyYz3EgKoPDVxVvclJ2E6cP9hrTKc53DbL48wI1GxJB+G8ccAy9P/Y/+7W3ob/zW5L+9vUiDb4Idc8VXEuEY3ratJdXWkwQwWYlXfmSQIowIq2IYZSyPS2rPin0IzNIZe7Bh9mh1Bqog7vfRWDyjuT9QBqywKBWzBNfNxgeQ6O3M+hPRlr+nRRFRGYloWZ6fiUqenU59QuqHlQGzPe5nqHB4/vxiwI6FEPs3SeFYXvQeEPYFx8aCB1rnaN42eR1gcvqVArxRZRSZvc3z2lodovrQGCAyoBewIJXgJUqUoBPswKt9+ctkYNl44+QblmodVje8gMv91jRvfuAL0gHzj4MKN1iMFO6wormy2iTQgGncYkI5MLbZE+3OdmN9fQUfM2v5hQsYSz0bi5Rc5SA1XAQLLKvTJdZ8xFTzmzfhcDiM0xPOYX+W/wTPzWmvZgAJBkO1H+OPhfbQQRmOuOKtQ53aT1JBPWDjyMWr5y8rCbRew5B4xhZ4CgEr95rap1YjTiDHYMQ5oj3m1a+TKx9uDD12iGtU8NJ7afSEaMpG/lhMQq7uu6Hy8JjBD8EZRVpXpHdBBpS8qT40/fk+bM42jltag3U+0wGKEni8isIQKg6Bf2Bg4IIAHSvR6WiEYspk3zWqJQLAM0IZEZGeyyO47UwAmYmvjRvzvntbm381q9sRxFJLXeMbV5Wvjv6vSRA9xSEER/V0OTTdkQFlj6LwvFBIR/PR617XZwP4vtFPd9pNM82wimiGchhBQQLBCqgZZrDjUR9fhNhipCZVIGMkMwxJAFtF51l2V6EyuA/Rtw/JLbsykmG1cDoGoMeYKm66fHF9ZO3R5W3d1nE9wqA6r+PjL+L4S9L12JJ4qtjt8uvwbvD0ToSBVnxT4IYRwkK22Lat9zMdVeXuTXvJ0Ma93+Rw26xTuUHvcSMx+1qR1twPbaAyowM4TCidhUMaofQeZ5yDAP5pAsirg1Eo85OpwFZwtPtc+hAC8pCz7Qqb5y2lGGM6j8z1Y+FuIoFbzvKDgqJwnKcjazLMmAvFAR8/joePeKKubAaNrCU6GsUVu5jCyRUZwmDusJjbDNK5xU29mU+ZwS0WmAULqowFV8ZCKqOHhVRCDwvJhK+1zGvKEBYZ3SCDK078RFcmoc1ditRqESRGVXFpEtaTZnRo8efWLRdZtXEUwGdxwuq/284QG0s3Mq86dO5ZG1eslLwY+9Gg+1DYQuT9/uvZqMDZ8hBl5SnTEuSViPus1eSEt87PvjHv26uVJ1dMlok+IrJlXVVUbvc1GLYCb9cd78u77XhXFroHFEX+L0jAgIrRhE7QdVh8hlDux4LTlZE3InjyyVZ79DTqWqZcYcJGS88lOf1qrdmsjg/ebZJhplZUziouS0Tf9Z5IL0lChTK1Hjevl7krHqueAJjGk76VAVLRR4sjj4DIq+zgTt/AG2W+Scszg3Ok1TfX/Qxu+LXdPmst5ShNrObzwtRITw+4MSQ+v6TmfgLW+7St7Uz+IdfwBlzF34is63oPmrduwwJPFUYuDwViYPUsRLMQn5sYwbVlwGBD2hoBbCwhRkhPcVNrMFdilJVChViMsfvqo1pOrRYYBAkiiFEYiWE4hlWQrHRGbXfyfuem/bLJEpqIpUGkZouVNWJJsIutiDoA1eQWhXtHJdTCe7W6fRwewqqPy7IUA4CY20k5Es9iVNYv42+AQ6cdYVA7bg0oy+/mRVYHcdMGX+8l5deSPkOdFVYX9GUTH9SAK3dMS48Mh0+fjfiMvDaDvX5vcz2OaK6t6rDHGGjkGuaFsQ7HQE/0G5njmtAdHm3tfGptXSOFu2yLjlSLuKH/+0zYpW06vWHBI5vaVmdFcxuHZjYit7xoSvt103hhNqTxbpn3dexOXrnMp3kRno03M0Xx9LR3mhfBgkV8pmQaxmTLvLHKhW67cE12XLoa2SSv8FykQHFS3NaNSVzesuTTTWm7soHV/mzIWlf92t7Vr+19gzq6Yq/xd+PSrzQj83jpRsmze8qHk/NDP/JLP/Tlk/MSTJXhU21mtTONa7++AZ331+/jUePa/2kk6oP4Xs87Y/hpDxpjucY8SapRPVKIKIRhQs0vATyurpZRQyKUGe6Qi3FcUGLZ8W18mw1koJSQwUR9caNkjLjb7RpoGbdhtTWwOv+q19bU1ww7u4ScjVzUsVbBIu797fT6Q5H4yVTKnNDnsm4cDZ/+wavnzfGWoYyJriFTvC1iSTYPUXPpcNzr6VnYEAleLMFjDD74nY0hlLBIEwv3UCplBEQA9Akh5x59H3aA8wV0GqI4DzG6FNEchwOuMBhPG4Mfx+LalAsxo/owBTAFEAFY3ifREw0DilcXr47eaeaBKfXA1HZgBjsw2IycL3sD0BJ4fTRzJa4xldIMxEWDa+43CIGXpnhDpVaXjBjAfSHCGMBsYXsdcX5erKt9IfPrcra9lsSi1SqgFewUWJPqm622We1sq9hLU4f7RIdAHm+UFI22wqoCDJAOo385o8li88aIk3RnQstcPbLCCNTSITbt01uZMPHW3k9sTIFRRFiOuR0MI0hcJvbJDjbddhNcyYqajJG0zRwsB1wu3otmIUViQlGdTDWdoJ0JpctHTP5y6lKrtxpFHnQdYnqLyHI8h19vBEE9awckonHeGcNj25W7X2841wQ6D8S4vNzt9uylsbe5fmqL0BYQTSpi79S1uNP+l97NbdcgYH11wJULsHBuXSAP+iCSSNNSFCYh/qgEzRGZjOMjt9T6o9Kdz/+fBxGtdlIkckIedMEWbVbKCYP2QyBS+pX410oHlOa1orHnFOdi3xZgsQ6JVN3yFpifSKLHk8QSzUOtTUeXKReJ26uMkrJk7EaAN6bMngxmIU3w4sqsUmIjZcg8s8pC+BAjlBOvxU8JwP6pAIwBsKqhJxr1Lr7nfP/i9zyV5z241bc9qJkwa1aBXRqFNdRL7T8D8nZGvwWYNLu6Eoz7zuLkLV7dF/jTGksUHGFQcDeLtBAqLRndBnlY774xx3ZYjR7pq/Xp3eEqropNi+z7EKR/+j3r+D0qLprbVcvwKD0xUJB8fQSOGTkVwMWlPtTknf5X3+upU8H2qZh2xDn2LMZhyZJrfk5SvHc+YGOmuuFtIz3FKceRu3i117gL0of4Zj66jqW1B7p1vxv65ld3EpTpCdgJ659zarxZj52lmBfOOaoHT1vxhI1H2YTFTRJqZ0mlYWwuHYrR3J6MZT33/qPP0bsHHvV5z7mEKqhwGhL5+Rxt3x9La517aZRxzo06zjVh+pWtt7juIE7eaRZ1FALatCHbRzKFI2JkxAUhwg0u3cBiigVYN9lbbscO1zSmyeBsYZ/HXSuwTJCe5VbmX2uXZvtMjpxrqmnJMQAL+NFOdRh5ZxLiAIWwmiqMWWAtOAkCBmjvngEgq1FbJJJdRzkTaaUcO5iCYBAH8vNu0NNTzwDWYOZcZrcoFENrolmJYDmF4UxkqjD1xVwv4nDWFjuCqtx+EEO/cFIuFwW1X9/LhSZrceGOJf2r9/dvihkN8R1mIe2DGLSIiqgMUlMfy4OJm+Hnt6H2DmEQtHFcD3XTBt+AubWllgaRgxPsM9SqxGwAydZx3sIw7FQlAIIILUZT3Lbv6SSusM8fCFhRHe0wFp8ltAusjygxPQMKAAHDrHAOnQPmz4q+JyMl+sGkqaNPom+c0+zNyOTrlNrSxTXELva0zbcyhTh+ekQuP5DntrdQptuLtGTMoZ0t6J6N+yMhwCrlu/1moPz0LQzjKo3li6R3kMtlDMHSd1frX/urrcmmeV9daTpVUhxQaRIoxdpawSqoqU0tFg7lvFDV4fROtsc9xna/vG2O0zfc8+kR9WU4NPj4NR0W998RSuEuRvvX4WO9n2HhXkeY3WMH/opIVw1udEcvOjXsYWcuuAWJhHfEAn6JOh0db+hSuiURtU/jjFBs2soETltJgv3huUej+jB1K9O29Vj/XRgS2hAgwoWWTy3f+5XrkWmuAeyWmVGRdSZ0BHHXG4vx3apcGJMuKKnrhOIR+3IEdg/QmErRGQOeLbfdm7rg02ctu2zZEjLcCA4yAtUjMpXNtIm+eYCf5Ghr3i4sLkWoDyy69O1hCZ5LE5r8vPPlx+lPMT/PVF5ZOaHnatiypFtzhYP2Za6uLV/7iS+bRQRts6gt4mRONAXT2GDVXD2YxxeSZJCrJgOIr3kJ+yEW4n2Fig2fjGyPOcbquUaHkbp4fHMMFbj9halN8fIu+kQnClQAXvjQppmlxJbkUamTgOJuV6eXaz/D/e1bXTMJKBWhdLb0L+X+rG6AqHLlAmlC91AlTgoGSFdaAZC7VdN6sGGvwWIUS3Svzyas86hei2UqyQNMORS4sMshHw5bkm1wGllIETiJ4D0Gq1hEZITxz/Zvg1pAmw14PLkAyZFaKaUSb68GZjFu1E76X/1i9YfmeV0PiwyrdLc4bDnyY8ERpyCbvBnqWdHHcZDduV8c2+y2dRvns2/w4w6yB/cTzEcuDoZObFPmkcwucEEgSQIWP2vxVHCYi3gGNTEHTJsL/P38BgGZSV6nK2MkCZ2gPVgcTPoMDdrzVZ2EkZE+8grAWwhkxVxHCVAJJw2M3vGd32+ATScK5rC5lnnhPINjemhMzfbmqSWSpPf3bNJYBkTQmda5Fbi80bcFYP/owzurXz1bhfgO18suKJZJn6FET7Z1qDJ2zjpj+8+c3c0iFCJCadZjVW2TruECVXMHhnQmT036zrQe0/Y58Y/hXaGyeyGSRa3HO5/2ihdHVUXD8HMlAJMb2h+X9eCfNzgMKWGl92HxH2V7QhrgEgIGyFZWHgJ8Q5TZHS+qXN487t/hIQG59VHGXwM8XfRKtjJP4wle4YhDCN6znchuNvOcTUx6pA3AfljdEjFyuBI5M1frS3ZYYutGzMRb7rk3dYEXzl52uoqSsgTR0xGZGhG5RnxqYC6gNyagnhN6R0dbmoA2NVkaizKwSF5ZsfyWG7mlTAgt1/ZJzUObLpRnchFckkXCLc3dtWWLjdyZV/J6zVxXPM6Nph5Z06HcGREyuaVxtB4CMI7cl7Vy2a64/Kjk+BblqjtnZURiXo/8oXo5O627LVOXiwNeF9/Pm09nouO3VPO5tFdz0fQmqEkheGh5vFGpb60Yv3SPbdpXa+lEY1hc2sUrDhcsHfVqon/SfL067v99/NeD6QQNmJYIBAOaMUpA6ABfEduUdhJAsmUT0EVNplawoc4eUyu6VUtrGvbeZP3zVNiwPnlk25EdvKKGYSlBksEqDGebRuJEzEZHf9j2DzOr6TtsHk2kz5AqaowmEcoXiWQ8EN79qjT889uX9OWscX2YnF6a3ZNF5T1WzuF7ersHXcZNxEwm+E0jTKaYqa/PHH54hqgRkdbwwzu/qCUGo6XJJmOYMJwZLRkJdcSMFz3pnyV45/C1P0bk3+hbywiKQtjtM/NgGYpMZ1ftqJQEfR5yXT4HE0xk+ZISzw6ZXecoIJlvvG3LtGEGUBJAhcJmiHgcrzVC9Br2u7OnbWd/DJ8dGpcznJM/XC7CvWyhKn5nW+J1VTjC5XR1d7SjHa1NB/xw+lQ70r24FhjogLVZXaZQl1nQ76/XJ/vy8GZLXKJ+XdF7qG3WqYq5ZnnUL+48Az6MrzJ8l++9WP/CPTDPqnAI5y4QVBJIA4qTo3cBTCM/y2hBmV7mr8n8Ylxa5evZYPWcE7o6COrAaxueHqIwoAsvW76843KRvR8Y47mbMj66DmhpvoYQsszSviTq8oI5USYHpM3YGNc8hsPh4G9czdXlvNfyUmeSXB1aWqUj20BAHMvUPPGBzyciSGxaHoG/vraToalUrKEJ3dE2e3yS3eu5U0GOpSpbgiNZGJutiChUieUjc3DYOpDemYsnErlkoCj/uLwFrVbxRq0ILWvfuClxAzIwoh3TtR4gy2ylpbwZfzMpJQe4rgxvCXgJB+myDBqS8s9uLUcqW373rs4KTn4WtzGvxH7O0x+YtoQARG+AXTfA4ZfYbw9spC3akKc825bLCyz+gxjgGd0Od4PfBfgjRNKzVHRbsGDP1deVVU1PiP6gjnsQCzNkYfrXf2Zb2whU3KWErBSIYuWINZ0Rrp1LtcfK26ywTG9zEi9T1F+23GewHj/Ls2wt8r4sQK1tUu924TSFJmnDKA7SGNYztJ1AEv7Y/heeXCrkOvYxOCPKq/kiXdxPQLz2AMxlXce7uI5nv/EbvN5Pl3nEMr3srxVkV2a4XduBEfflGe142sc6vxjMD7i8xO3O/xNXFO8g0ygcT2O3c3qKqYiHGhWG0yYzx63Z9sOy/gTurq/W2e2f9EWsro0RI5N66TKpv+gYMYpdqMlU0ngy4Fy9VjlbGvnzYdL8Rbdul8fdjzv8wnGJS1xiUn5QbuMY+gBa1m0unM1sv1aSBIEdSkzxB6hrp5YGHEezo/9+Hb5soUx3HDLfZwgQQhqea7U8dFjnr2bxS6COpcpaM0ZvcL//vgFWab0WU6s+sqzzyLCpOzZ8niER8una3Luh78hvqjKglIA/ptIGX9XvO9ox7CNel0tt93PUJ3W1+f0/u1t4Z0v1PvCB00r1t4fnK+Q4nxS2X49cbvcH9bZl2Va3sz4+GCwt20qQw9V2v+/wwHss+gOXkU3EdIAdi6VbnIIzCIxBfJskMw9xbz2YF58YgEZUrXBcXBRw7EIzABP1nx4oCxe/uhlrAgk/GObHNzQ/LA6oRex72mzhurKKEU4ncHmntegHhD5Hdj5sBT2oOcxgg3NVkaqEkGyPo4cRrblgIXlxAE7kwGW0Tw7JlWEc/7xHq/7bnw2ijar8meJAI0RdWdi3SkyM/Pw5JdYcS7pG/DISaOSsUZGIDYrNdtpdP9fjFyxxKUuTMy1YUk1CmtagVaYYN75jKQ69en0koweSMf2L2gnevUnZ7saluPPrLupv1pFRxGME9WxY8xhuBnRY4mIgZpm2NI8z6mJeGRnBfN0eWUIfA+/ShXmfHvs+tZj365n1PhBrTXtt4eQzhXeeflalmBAC4B2r3yFblr4/pfqjSWbE7HZgVvFovfclo1lsn83s79u2iHubh/ub4c0nK2HlNM+vKE3Cso67nLCetV8ATDJvsQ4nN1EZY9c1b/nifUVmT6HfBYDhtmjNMoxQvZkK9/uO2Q8I6xIyhSQIp3gLleLNehUg0qbNFFoxgCXB5kWwkD5Dkc6LU46IXZa2BPxfIF9TFAv9SutSuh98sCmLpyz6PRdKWTCa8l1ZjsXGoBnXfuhW6NwUM5HKqvoV1q4vVl0VyohwWGbPN1ZXDnTj4JgBqF4WQABAIkA8QMhe9owB1xDnuVcMIDCAzMxtgpsZA6gpQL5nil7Pc57zZAba/HkY54Eg9XC5B/7V1et50RIRmch2T27HKaSAlj+X2IU0rggyQwcce1tZDhDlECuuZ4jk/eHyCAMQtyPtI16Ap1r5sFlGukZ/bf0R7vj3/PbP6QTA5rp+D0A0gP/HZ43umBd/F3vGAPPVr94El4sBNAYw3M9jgG644R7J5U7BeBGDcZ7PY4AFA+4eZ7jMLS2RkhyHhfdzYVOZRlK8NnEcKXDrJS7weLgpyR1fwCMLTs6IiNCRdHGQ8ustfHWs84vBKW149GMis6AdKgZIN8FplV3L4uIi8TM8GV+HNWIbZgh3CfgwTAAqeqL3ez4+jh7TKKqygxeVpu91X4VX0JaBST/b3c3rTyLRXDDGf7E71NBFmtYsdeaVUKLl6qHdvlxNO+8qsCDjPWK7A/aED7P/w7yeu14u3nTfk5beRx6V9Nz/9KoeOx7V4h+I+Dld4geWi4Xpm4DBmjnwFAGfooFXCHBlA2NOyLWLeOfOMi692ritKk5eZWHbWRk9l/B6RgmvfZTIOnRERB0jmn+tYuM2a1Y0LqPcNO9083wH/571zXNKQindqdwOs0pW0of8QPRZWlqPOdFUjAJFoehzlffBfE4FfJ3VubN2aLAcp1xyBBrVuMxU3bVzMprXShoDOW+88Vi8Yw/0wbIcdJac/1tDHEDTM6CmxXjN5oJ9elZvbYxJ+3/SZ+iuWlvXL3mLypJYq274WgC1ZSM65veiHMLqc6E1hdEERhJ4pSlzpoVNf348BVt7NC/N8EJ+nsE2KshegeKwkplvv1Zbhy37ZXNELdS+JNmVeHOca332iy3K+Ktp7S+b1t7V9BovmpXxpNm1/i3d+MeDceqlceCD3vZJNn3Rm94tut7IvifnxANj5sHW1IPHmGRrQmJMPXINPZMDEmNWhsV8BR65Bp4YPQ+MMYmcxindY95AAyvwSE68NPa9Nba9N7Y8MUaH9MiY/H8CknFehvmiNPrfUs3/l2b+h0TOvJFNn40NP/SKf6OsRGa3tHpLUk2zJjY/jMXpAGolT5mi9k7JzWOAYDJcwV4dM9dELYpIpNyCADySaDiJu1PrclF43zjPcOgwfcCZEnts6WKM9k3OcX6juq+0tOZfLa3xZ6tr3tnkmqfjyzyw2dF3dzjXnvZlHWxnjqPxZJ7chIyzG5+z0xd95JM+9uaceTdOfNKHPtwHXsmJZ3LhxTh9llfj2KtxcjLfZMuv88yf+XkAY03JKIVoU1TiVPcXhF7x5970TR/4sDnyZnPmjT7x3ubQe+PQz9ubAd4sB+IS9yl01X6VbnjolfrhYg2WG29dDBoEYOco/PH69iPHfUZYRKzERy8B5oSgX3UhL9xDz5YHfTNulhKoqY/7WLMRa2JEqLltB4bLMR2wdVtZ9YKPEFiRAIJ+qcptlkmuScFZsf/eNpGgMt4/LoaAgxVStXDHfrrf47yyZ7H67yVPdtRyvXGhQCEcgJiLDB3+YVtENCecKYK8p9UQUorHmnQ/LWdJn6FcjoshBmn7aFmhTzla/GmOMDf5eWBCHnSJpRlWc2uyYCRavjztjeqnaN65cjl5yz4091rS0HNV1SJlplEL88KONCtML/MuxLiMWk5uEwW1Tw2heSLgChNE6kznZgjlvEEDlQFZQK3Gz7giDZjEXKvETSxDcg/y9rTMB6gwlu3+TozLyuZeV6IxxPDROTGmF2IehCSilogwfMXHyxwgEsCP3XxYcLH5xPS/1g3DB12Cz91LegIcoxWvppItqqqnMcJgcI+qinyz/ctit3qzsyd5NKuYeaJJzbi3tKIwlGmZyibu3dRP7VBR3AsgqahGZHFGvbNuxQjm7qX8ap/AqqJ6jN56V5Kd/V2/rV+k3UDmCioMpG5w4lIzOHHlKlDJDJUsyJJFNQvUMuMLakpQVUaBLKpKGLdAgXHHHTfR0hJpJ1LOgqMlGjdRokQPBipQoEAilUxYmrZqJmR52cvImVArIlII0yGyKW+0dUzm9IaKDqB1doOWZl9BmAmQWwfQ1tuXzf3OzbENJZslAers0DdKtZVaRd5tKyIe8O1/va8nNwXj4EixUqVKR3qktZIzYVHaUGuttU4HBb6DLWOttW5UAnkyknPDR172hekA0Xte/XTH9lH9U+gAkPdHTF5lJqmpvJdHUe3vIfrX59IDUUhUeT+1U/uB2udsycLBaLEqGEL/8sFH86B3A1Pz/a81u2aSgGhjNc/Jk0aC9kZV3gAnxxP4q5WKKIS/aFHop9Znr4rI/9aznZeLyXONPpBrUTa9dgysiKD7H+z1X6586i3j/WnASmG+Gdhi5HnR+kx2DSDRSWeq6l+7QUgcem+fxC+//eXXf/fj9kkfyaFvYew9dmDhtwYsuvP1ecmhqoZyfFCY7oelKbBv2ahSohDxUy5GjCEFjcEHCRWKckSY2ownvF6scshlllm0UAxQjc1vakd9VDfbq4kj3lNAlA/F3fKxA7n1juPnkca/moyXeyX3mrWcOiab5F0c0ro03Cp/jYN/jKWFAQ9cGTGfTs4bunyVyAdItk3jaJIZ4SCrFUCz7mPYC6459tY5+Uri5DOF0Nh19WXDOswBAmCfcKWKNFgwwGjgKp2ONDfOnehE8yc7+LXaOtob/h9LHfpf/kSd3meeDfEiVSpjp0oySuw0TvHOv9d3E1Cdu9WV0/fwCkNxS2jJYDQGMQZiXCSbmM2/v/UeoCykqwu1Vb8QFIg8AFNgEAM0hAp4t5bcgcgUy8PhR/zSZlL9Lb/Lp3P2b1AJIkUYnWB0Ej6/jDefXx5vRsb72m76x5KB1Sqnzzr99FnJhbWdnZ1ahzW4X63b1nZQJ9/97rNOj+hb03/LLisAuQz5hhWXexkGyDuXx5sro6ioFYWZZKjLFShKyg3TmR2yux4N+osxabrdAJcjoWQ0TaT+jY9oE069MVi2JEgGwX1RTeJ3vvi1Xdu10UnYBciAHtqhyXnTQ2P4Rj/xa3ttgAI8L+v04Dzr7nfPBVold5WrRHAeOz0Y0vKlsjZfv4SlCyX8BAFiB5yt2kT6kCBNz9lSexwCKs9pKh7VNjTD6PbUQrl2n9FWImHXVQaBgkLerHYNacjIJBfZxYiyXL6ogCar/VgU/SIVon0c9vfbrq95UhTiEH70SMjLMAZea76ABBiOascgoPnRcnU1OVu8YJ8hv+mJB/Oi0JQkJwDtD4ZfzvlaZG6exxNFHjLba0yD9wAwnoR4iwNgbnxI60AiIeBm+ijfn9ePcjsf0f5Q2USsuQmZxyZuzU3YrMY6IQ+6/rGysrXFx+tfXObyK0XqFKG4kB6ajdRQb6eW9XZ6ajaZhnYN2bsG6SNZzK8hrrEXAGcA66cC4OmVo9hN8o8zgp9HmmC0GqPhYzk+l46pASgMmBjhRU4rgL30JqKo9mdwelB6l//nU2bt3LAX29KjD5yTr2Tjcmdxr3M89zrzKcf9WHzbvHBJyrEDcSB/DiBAUd+sSUOs3CMNAwbY/DqsRNeJWNfjGSJMfZ+auL/Tn72cfb9Ry+rtAPVAGc2AkkZfMO9AKhdnC2Oi+kvpmPJ/EPHN2Xh9KDmSBgaPS1zVFLc1oyiMj/lVEoFMHxyC+FtwlaIk9PjXQp2WJqBMsc2ZgQFeEZUdswvo1/uVObL0xz4TyvS7I3vgF4zdtd/td/TrH7zRQFWAWle4MLkAY2MOx5gD7jfm8GKOzRk7pjENQTGegWbM40EAmKznGceMGRNxHHSVUCkW6DtJorvWpT4TDu/xydV5OFkxPwJwG4Rf7xXjaYBWeDOQfuZA3xRqEOtNxyCtLhiHUZcPoJPiJwTIeeN8zkelTMBwwB74FmDmntMC7N+Aqj3q32LOcK973WuFb/ElLhcWTpHcLKKG/g6jKHeNMYythGbKGHzdWPUxuNTHbjrZh57rVH6nr8WR2tTdAplRTAUCzuxubY1J/hQVvUZxx9zgbJTXFzLKpC5Q69deI5CfyZ+3nCM/KAP4DGz1tZZCWBpBB0jqOtwyh97A82JA3qPUKwBFNr3kceuK/yuqIls38zFd3pso+36/7fIKSYkHIrKbjsP8i7lw7eTSzKw6p2W9WwE0D/meOF2A96ZO5fP3/rR/G03T4ri6UkdsiG40TQsVqauyxYHVTeWlK/2LeVWXtNHS0mWIyTbEZAtivAuxtBMxbEMM01h8xmA9vlxZ10WrGzh3YA9jvOprto/9jvK6z9k+dz/au7rala2IO61hWR6m9fdtxQOH6W/hrI8ISKDyNjhUbPsqcHsDawbr+PrE7+Vm+r51A2zImSnF/KolRnXW3QsnrxLzq9WZ1jQ9zIhtFbk+s7LUx5FWzdnMpQ9BgGTS1HQ/kWV95RxxDKAceOlzqcSOBMtkhkwTZlYs6WMev7qFfnxzBf/3WRtg31OvFb0Uj3DP5ZE7m7v3JXGqS76DUt65YvUc39+ws2dvddgynEaKURykKEgTkMbidBNE3z/0OuCTTD3c1eqCWFnGkmBG53YuPsr39I3dR8hWL7XMv2+Kpy+EXv0P/u0S/+/f+N3hn0KgZi30yDoiCAoF6NDjwzUUdqOywt+BMKDFq0j1JYv6YnGTApZtAuqNQpIEIoTRKG+l1xufJEKurjlOuq5DMxrPBeOuCK0oKeibwfa8R4HCHJ5dWbKfIwCdXZ3d9ZoTBDLmO/SDKYz0j9xP5cUcApSrfLgXNK07tKegb+PRxOhs2mQkMkU5Nhx99e9MOaqYstqKqAd2y/T4Cxxr8AXNQCJ7AkCi21CLPa3cqe/nm6gpbr1MkYvrWb4smroQpqk052HI5X6dJTQepC7aqOndDmCDZALl/GA2A5OHTgJxAP80riSm9ZYwxMDw59Nhv1xmpvuWzhfRFYzvUEV1E3QpXfeI+lmxH+3h7qDXOTGCXVg89heG4PSjdHtjlt3riocXtODOXd11x6tpk59uI/bNNJNffKETXw39Ev9ibHDio1k0yxzz/o+i7C/3OLu8WBJMWkiMq0uNXU98/dXxD+YOjr6z79fR7fv+Gtu+5/e49slftjl36pX2UcE0ouqfoaqK1QEQUiO+AfHGzmxMHrZEw18gCmNSo8m2bqECEgw2OM4OfRAhHofe72y/owihkgD+OrXCJihf/rQCdDKE+yiaGskcTOr2YavSWgFcol/exaT0XO41843LKufkPoVXxgIgzAHSYatZO8JJmms5yoawq3UC/TR35YYePe6f1sJHxFMtfnnl1dmxkqcU+KoUwrWIL4q1g09iWYFHVturzclP3dcXOubsf+j486mYjnVBcetcqSnXG1wple/ualoThbnY1zW9e9DKdmTDMm6Qj2EFhWXM8ErTlJm0wg5+WIADF9x51b+47ScCIhCl2IurE627Oz7osLGLByqk1bwWOoVhWkkIgqDfX4iQeKPFDTmNUlmJzThnU2FJcCx8jhHB/WI8GHLOl7ophEmA29GAMD5reGv4COpMfmc5Xyj7+mg+uy/g6T5TuKtIJaFKZi7UnnSkMzxwY+pqpPKkNHp7AeUgwZsEkIt649wh7eCIPonFI5RdHf+UN3qVYG9Bp1BMsN9e5/9s3n6Eo0QAuI8uMVsWhje0mmikDBu/4P8Px+famhjzbwCjqPllrFiSbV8e+HJaOwqCCNH3eUZAIhyhlS9/RGxaAwIECM470S0vGzhIASlQCnWs6lJgYhZuEoAGpgd1b3N/f3b3b5+rhqU2+ZPROoqUR54HWo4IFNq8Z3tWEZGdV3SxO3k8rJnnMiS9hmf+z4bOMPZ96kRSzqRVRQXKxUC+tii63lzk2ZvVnMm1TOPCK433aicxKJf/64dgrW8YaSAi30yDJfv8IEd6Iulo84h518lvu/OvHCsGKwiChMhExWUiIn+89SCgsEvV9CzvVF1eAahLyLfb8EH1jbfrnDR0hIHBDMGwfGNwzjCsgTqWEebznxT1pEZLq9e4hAFqtQwIv7k8nQSLLXZ51E1w+9JNcJA4TTi0ovXxTG42zOxmi+Nos/dGSLYSu+SdPZtfalMILXMasXh4u5ZuzuRpKK37zynsGBl7eQy+IiZwRxBF6c1OtfTfltwUkjcC6U2wGIWADpgWEVObxUTq/mpPSu/uWe9GlHte4zcAWBFOore4TXv1bU/FZXtT3+ImLAmehfgqb3lYFeQDFqK3vXDkLqetGIEYFu8xvivLKYyX1DJV9IQnuw4DNo4OAxhXVIch9/Idz7ozPJRw5M5mIxFm8tPFcA4zoGRZHp7JJP5rWJGlJzhjjtb9Z2Afc5SNnBiDfFuNEteB9OlXV/OkIiiKeXHApXP+EgQrMo68Ve1bgltMtzl7LL9cYf9dOPY5B8EYgTmK+06sqNZVEob3+jmq49IKhDx+Azwtb4QS1jg10IYwhNWKNwMXqLUZHQbYICs+A8Js+6sGCUobb/Lc4rO4UbN7cznCynmeJoBLvzMexSkcEojJEqeSnw0liXeR9BEE3I4mfVmv4FfoQ5eje7T+hk6ZsgKL9UHZoR2zNUktippo8zU8VSzy857QUr2NUqBqHasZYoVlmlwcH7kZRu/grgs3wNJ4oFluhaKn51uUf7zs4phdPso9A3EZiEO/hlCHan4ClBcHLPmXfL/rtxFhLI1TWLlhZchHVsd1VY1L7t8DHHr9rI9MJKF9asy+iZUbgiQxllTyb79SyONfC3QrQu+i32ev9MIYJpbvTPamjtjsOeltd32HKDGZLCUmahmGYrHOtuhNvnnbDSi1Ayrzgvd8mB7dcahnwu0D3ROv7pvcd++jOaFrP2zUIWeNXyU40epqicDh1lDbNxgHKHcFzqD2o7UcbvYM/Rj/9ZuqGgJYyWAj72XgWmq0aza1SK2K9KZgAKrSkptCchNINiC5gfxOm3A6wZxdRzoaZd48rI5KeqJfxP5R3MMsFxhJ+18zeqD40FQAtUGLohvM6cfeXPQ1IEkCyaYQ3xSim0J4UyoGqLQoc0Wq0M8jreNl5zMfbEFaAUAkgDmiguEXzWGqaoyNdblfvb2ajT0WX2A04zMxQq4+RT1QRiDi1Pw9tylzqP2kIFXNMGZYgfiuDDdAwhDGaKHXySfnwfqyFEPk8xXVZSxyz/DKXrotik5wjFGdEYI7QoKOubPV225FBEyRJqE6tTC2DGzfIKjyJcTvE2OiezkpDcKCYSyIMOVOZQL0T+898B+kKIShDIdd8SFAsk3tsdxri9Z6+oxBtcHdpq7J99zkHFcYIIaa6l9Gg3ER2fjUKqEQP7LKUgP9gV2jEIw1RZHBlgeWBr5xcdyRBSYlzLq69e7LRrBPL7P75SLYp61R/QUzt/xeehIcEgaXApzBrKmyXyxJCap0UhrKsF1zLLitnOcr2F+24b+HgZf+AaeuzKt53kc0uLz51DitvvNBm12j7H/AFjFjVrFa+9psqfGY5OG7GCBvoaYOdazlBKyFXVTiI77XAbS5tPN1ySlF34cdJy/JWrlzKBwtIZCr6YXSP2S7PpUPbitgPlcmJTQUiUKsbHla+XEUlEPcpF2IuLJD4VOOZDQbFgQvoCZ9m8vHfWTCBikE6TMowQ0nMWYjdcIXUZ9vI9xMRL7ZdIcBypFzERafJYyGiN6uRWyOn+SuO77lBMTKDU1xhsBUjaabGHbtch3uuuf13PSebvkMdlvFlY0T+3Q7W165SPf9T3/tUMvdwJ+5KbTe8RH6QzzZCMVTkContFCReMbGpvJcH3IlH7MyInjniOK1l79FXXHmdccDPRYgIJi/ZJHrfbKhtg622VP95HEcQEkSKvzRA8IfO3DikgQOWJvaDO9OUyuANkkEqjt3tTgrA0pl2rV+EikQpAEkCBdj4PRZRKbPEly2A+JkcOLiTSFKClFS9oNkCYYoCb6NYR4DajjbstYT9v1uPvQ9s9J77hisiq6IxmxsI2I2QqvwKZZlkyuZqUhTTWouGWxVXXOuB9QEJnbsftbGZChJ9cGMwvxVUnHNK6SnPN2zE7Ah2wCQRoR5jlLvjSxWYf+qjptmLA/vTOlY2iy7FhYt6m1GbEufNoV5ohUFqMlW60OY+Bn8L0yMieQdwOGqSkArVLBuh3u90PAYpmkWFq2H0mmqdWhjMP8PBsgs7j42ghMfVMRaTPOXbbbxiBjvYB17kHrWCporDHQFFtBxXL7IM0I2AG33RyNMVPNcCLBeTbMi/BQDP9aG4QLmjDYq9MZWiunePV5DuaCV2i7oCdEULFiIED2TREE/l9tebIeZ0CfLRZ8e7gyHGGk/K1PAlRH363N/oIMdDm9LBlWHjdaYF8+YvHoIDwIGEAW7eb/mmRgxiwC8hXVvyBQHqIBcuap8eeX2Zf85nvSk8JH0/phfca3lm8+WeHK8smLXylHuKSnJXAGTljT+eY9ztesdq9wUReFndsxyn3ufWYe7g4MVvjo0Mt6/NdZTVqxczM/XL3hLACWOkS0nS+m0qTgNLSSYxXpGRCLUsrjpw52wLEcRBhqVNWHy28aSfdfAgr2V2a3H0W5CbEqe8I57vqMFMxaaFJKYhleaUGMdesz1c24c3Tp/6+xMgty0GrY5mna6DRLTvd3asu287nHo4R8dw8giXutVvHb5ElbjYLPjCjOqVx732vXGZdYAJALkmfXWZN/rhHBjhsIv/KoOOfQpPO41iJPQ////CwgDjinNokmdZwCiI6zhfX1ZSFDsnCT20miouIAnjUKSHMTJQYLiDYgQJkIolWBomHNZjKfHpbYtsTqkHQy12i6AJmX9ZJCe3eITjhjDvh9rxO5xcJTuxvrGIpYEZ+msuzs1I9Mj1jw/l5pKw3EkiBAO/gIMJTA+1hmpDrrvfdOKlQiM8w2iacv8ixXJpG5THv3Nn9ctGslhzIdeJH2GXKZWMCziI4Op2R8lCiC5Z+l3DVRSJg+gcE0jxsOqpY3QYB8/oCvXYKIBfNc1BDOo7KrNQUAfjWxV57nCV2n8lxWpUGy+9hVl2J2scnxRYUIeAG+FoJArjxne/V2DcwgrLtsU8SaqxGDAKZ0DDtyRKLgXonYVaPEG6gGiJnu1VUuKroAxrBq/eA86wzKo73ke0Xi4Du4Bl3aU9SymXfoMbUhs0i7l3RYXveFFv7CtAYXj4ScBmAato6htuPhtAhj8cn3HOdKSovGErYp8hVijTdt8K9NZCKUJRWTz6MhXP1TUMz5ilCl5PSJyuGdP+5Ooxj+jXVl9DbDI7soF3LrjuNeHc263HZ8JUXLnXIcPM0fTOun7ZCBpTtpM1XNYHvTJcArm87HcmzChn3Q/NzEAbihuqNcUxUJAWdaAY3drsuKdkDQN6bZgJa3Qvs30VC+BJYdHteDzEaG/ldDkP5LQmDcY9xgSr8QJpxHr0ye+765fbUxDkIj7nu00wGXSDDt9ea5+15LJMd3TJ3Is2dgTDJujYydxpr7ZqYe2n6fnoQe/da7kdwtaS6y8zE52vvNJQOWD8trtw7+ajNtafRiZO6eY8Vrfqy8HWA/gD2AJYNLLrFWTLv8JZcBVdABxwA8cx1f3OrKPtwDp9nlL/nJuTRZ4T2Tjc/8mCgsGSHFPXWHPQB1iGjswpdvu9q2SdUs7AfATQD7QpKaPJqr16iL74/K1eU4bPy89e3DuI6JsEbxkJbgq8jHosiRxMukz9L/MppOAiqrEx2MHbEw2FOcaccwXYBmCJVjZmMroxwefA/TG6JFTUlJa4NFV9HtPScXn1N2IuRHZeDzSSjmKWoIaD71SdV3SFqTyY0SKcAmCgOyu2jwrbIEXMRV2W0hBS2y40a0FE1FBxOOeM4X38G5MUyLfgsdPg+O8sbOJq9AfhgvdBuRFkialzEkbFnQSKgHUPNnJ5gcOzkhHQJjQESW6kEFiVynDeo78xdxau7oK+/iEXwa24XgmzPqcYV9Eu3+29NC7FgCj2DKpxA1kSfgKlGaAFNiS40b0TR+tA8krSVAh4KXpVnmlv3e9YiSVRLBPOCAc9xQ6Zph1va67QY+VamdoNiFam8s5ZTIP0LqgvAhr6w1cl+KAGF5MGpggjEsywy1KWgMQds6rLFG22tKLaCGKDBdEyHE1rcXZFAaumqWVO8khZM1yWjP8gFN8rwQjoOK5eJ513XeY3w0gY/PLX28e9ujLlVs//HLlVq9Orxg6eGh1ZOuVbXNQ+5SLgRLKdU5ChToSC2Z/KS3Yu/E4DR3n9FefG3t/fnBc+8GT49v29U+8sv/k6CvH3h9+5YROGBvCwmw4irVk6VogurZ5so7pnbWG3f1SNj157+vPZ3l4h4Ls7ZY74hzRAEl9aL6AGd1hMg13xl9xfSe9n0ug9Wp6N0A6QRegEFBJGEpDMZCHB4A2Aklmd/UE3nlGFaucd40q1VhB6pwkRn6WzO5uRPsWAlGnMqQIRV8abm1z5V8blPMS0BoOD7AB9r1JIh/D1+r5cjd57kDeefma3S+XCiu4uyteQiXovpImiYiYtXeDow44wiGLIlI91HHENu2ItpM3SDaGplwjgWEl5GCWImMncTENdw6G7QcV4QBjNRVPyDeIprnZdxI391whkATU6uGlDI6UND/pM2Txzl1r2g7UxqElDG2vnVlxelMsq7DV4UFiBejoVnAb97m2/dGRjRCg5ij+7jNafpI6yhAaNnCeRid7o3PISqxHn81UxWbcqDDEgQb4mXpjPLT2siVLm/CwxA5+P1gaGCMwKPOqor5WasPPizF5ntPIEnQ4FXSZz+jkokNzz8YYHcy8cMdEQ9iIu089AP0trXTI8EvbKStB6UR0sazIgi//cmkmt7SOMbYSx7co11jCfTkawmobvJKSEbRzvXU5Y5EV6hMFUQyVnC39Uc/gcFmbtT75qKQIXwCVRZ9dS9kpgKLhOHYnwAnEw0pmK5mXEK/GvwbC1KE//bxLTlpgIpDmzQd9HShrltlILvZzesbIhee3sE1opu3KaKiE/gcY+cHq1q74eW8rP7ZkXcvhjaHH+ijHjlu+5c86NK4u2wCFxYCqDMD6ZECtF1DePvy3Y8epnAnlmQhUR3Zl7J6Mw1aJ6d3BtveP0+erez/nJxFIiMZjb11rmcfANzFQF2CI8lAgA+w3LyBNMB+cSO33uJJOAMhsryS2O2o4J9/BZ3mEq4fpXyx559P+UB+B5cPpgzQjeuzC7xeIan/tzG7Ak7poHgBzq9ZEdXyoblZljV5FcRfhy53CHit/qUNdJI/UVRgTeCXNUsEyvMY3HO7SED+nW1FqdMl3mFsduHc4M9kGp7FCngHHEbzQETwMT5FkWxrbnD3/BA4HSCMKUlLx3LaxEMAVEV6OVWmbTkoQ03WEFx43gBwBiu56WyXDQArs8mRJcNHLVvcC60NybHTUibVMRRll6I2lXYspG8EjWdWq4NBkSkG0Cdh8LDJphtEnStw51wlkEv6Yip6wdtmqM7LP+nUqPivrXMKAOLd3aRxFgG+fJ7vBWiDHjKDmvTWexrMHx2SOZFnJK5HMg71iPPTGhtKZ5IcA4fFBrQbRa4imIG8M+6g5hgAkJle3GiUgNFVLBQUgTKtK4TuWJrSmTfYq4B2jX96FP4adn3ceb9gksIhYviwL05nVFeJRNzjKFppfK40JJfAiAC6DzvJMKwvY2iWT0FwBGQ752PPzT/lSDaObPw5gsC890f9lP/89Z+vNcO/S9rXf9UppbUne5cK2yPcw1kfgh9dC5+b6kYKtlQVrMHWzOIdZW9O7KIT+kmbdn9cMv6p5/tpm/GU/xg6OwH/i4yNi/Se/vtbr/v0xz//F492jFpBOPeNBVh3vCzYDoCoI2vXId5/d7cS3vph6zOuf1Pd7/+pFrN/+F0/X97v/8mGs3/y3dxv8vX9f08Cv//v82n/5/8Rn4fpIWmJsSs8BpANGAyQIoxBCA11RLQWsjbOYxcDm241TVUUAF5xy9uMytUQuTN1B9VboaJlx0sMBVHq0lSjf9PVvphCu06klATcM0eJ9e/6/fT3AtM2UasGxs1h/Px5LohXFp5Y4c2XxGJ2f9xW72Nn/tLzMqyt7M3bGoujVif0j3whS07TmckRWQ3iO4C3DuGxFpj2fkVFPu/AimO/zxcMlKHnC+RTQrctQ8FL2ecGXBqhjK/tcTLlbj0VgBnP9Po+nzsUy4tlISIBEfjjeOZINp9PhSoQ+EU5RTojbBfsiAKxn0l+tjmVUbK/VRmkpwgJxJje9rY2yg9284bRuV+4MM/47Tt6jYnFuWlzLltvAxkve9zjG5rOXCSz77CpQp7QEEZeEjXztORIbIOg4j4PMWxQyTgQSP9If6cRRtvE4rYUl/qZyFM+AOocAalJxaSwO1sQ27WiX58+aatpSakgbx4f3OOTjkgTiNwbSm6I8y9BBVNS5qQ4fn8jY/IeAoVrDHNFjl0tmJSu2Olp10a58zU8GIa7+r2Bdt88+XMZJ/W/gNmAnKuy5LYv9q+/tZa8CoINrZ3BCtOyyy1ZXqbSl2pO1mXjol1mOXvER+Fpo0fRgL9a7mPvvOuROytVBxNJGwcS0qaMdW+Z5pcbZp34TrPtcj/uayCvUy0wu8Gr69bVeH5ffmLH9iUfZj0RnwRVRQq3MNkMTYiW34XLo23gcrw7mX4qBX0gFfiUE+GVH4EdVQvRVqmmIPoh4DUOckA6LDEm+Z8IADapAaVJc6q58DnrYeTxtYKYqBU1Ph3xFGrSuxe3Zow/vycWvSwjRBGlaiX5JhkBb3LPwveAgK3b8ljk+94HL4/HhycgzBflvb12D8mrtZMUraLCot3Dx0UMAnIDvpo9uO/yRxAmIJYUVDJTDcFKHEwiJq8KbNlt1XO0J3okT2ePtYQR0aMAI0EJJI4WWglpCadABAbLHPpgPfcQIK67WuQYV9m+BO0t4HB6OOBSQg4eOrYCCIQA8TnvgQG0P6TOu06moJJxKsE+zIy2mDyUDS3pqq0lcY0+n95/c3S2LMfc3g2VxbM4YPIbFeUgL8S21Qr/QEx2bHTOFBWp/Jg1MURbCodiNuj3KeSC0nZS8GHS+BidqExShElhKBnRuNzjBgBdeylLU+KU9LM/yj5fd2zetWRZCS1PtczSlNAvKgSgE/9/T9airl6eTwF8M8Nm3twCxbmuNb1qE2aHXbp13ZtusU/lXAquW0fKqkrEBsHVDK0T5tMrZ/epk+mP5Fein2AodCFDtVejaemD/y2Jt8S/T1NNu2zgY6tiUPK3y1XMV3hUDJBWuuwG7MxoEncjlaeJG9fSdUwVED5+OC0GUlW8mhmbk03qJzglhetlmdV/iskoc6dSdJ8SKnTH2zeaaWCZvTBvakKyur0tn892qLpGL09kHLVEVzKmtmpUoFfQiNek103TkaJvcRsXjpcmAUnPv0I/62G7R7tvV4f3LWJHPBaK471UfyBA+g2k92agdWT1ZeiYJpfMf/Y6kCMWp3WJTHjYCSNi3yNHrJ32GWvtc18GCpmxAvgPgQ6MsIcQUdDqzdFunLb0wxZtlndb9G5v5iCG3ARBjcJjzeQ/KgAQYVmibmUs42p+gu7srLVhlgM+HB1+8cCnDOYzPBDEDVhL24QiF4YZ+KNu0n/4ef4Bz4l5UAUTZOyqhvo5zmoR7MUIrhwlPXnDSlrxUEhM9W6cTGQJEJ+zt+he8WoAVH08Swh7t0SigRamA3jKZRt0SfV7uZIu1QN84gKmCbZVMA+wVFV2RTsIQseRU6rDVlW7FkTUNwKtMYy8Prdz8f/3hzIgElhEVvp4v1CMnFwxrcxDAqXeOyQktds0aDogoS9CToti+WyZ7OGWIxUIasW5HihBxgjBAJg47ZFzSo4ZqcDq7NuWI8EjRgt8j2NXl+c+aXX0pHchdEMEFIbdDA2GhKJWEHr4kCX/jYoSLgAuTcNntTc+9tMci6jGbYT827sWSveaFsVrnaKYcG373DiXmK0J7z+mmFK5Y7RpD3IH8PR2o2uzwLTxu4a7Aaf+tVB/wyY3tu6tfErBwnVqOOcgxj4k27H3+ASoJeSZX5IIwJ4Rgf9S3AE5RHss9bPvO9+trvUSPXPOsF9qWVNb90i97Z4esId/aeWPt/LLBGEKc3ru22JjQFlGWsdsZd+1JZo0XGt/3NNLj8HAxBql0aYzLkN5Bl6dcJEgfXLxzxfKPkcY/RrrgWolG9YwECAaw3wuAL4AIQFzuD8W0ETWapf8wuRsaSeqC8GNWcqW1mut4NINbyDd4egRIhUHidXRaW9wCOFnk/sk69jvU9QCwKr1kfiCbPbj9rnrkBasXLfEeY5WXCcDYad1eQhlQ1VHJEixVGDjiJCwuCWg5QpeQ7LGk1Faschmy5ceV7LtHTfKv9mrWh842wPrkXkfvnWpJNQ9xGlmkNAztE+YIQqAF0zamSNrY4L6A9UJqyBqQ9fTlw+YM9LhzMo8ECAD68WSs9wycem9HXSFj1diWntZU/7xaEgZUKGgEslCULMVmNwkEgn7g/f2QkcAndwn8jHzkA7axDT6fnxEQIFD9CKCo2wCSSNion1dS7ILUajCzmoGZsHd6WkXoQMpGe51td/VbgiLuU28db9gvohGZSlH1SHFOaXsNDp6spi1l9xR57+j4nhnMkHRuQIeAIAgCNq0fARshEAjYQAJUSMM1SK3LINcGnhoSVLuM9arVhsU+ReHrfm7ipMBpk5x6J1u3HKQCxUytYKN50ImGvOGOewdKXUGHwa2wGd23srPHfv7iUAjDwBlFgTQhOF512xEFaVGfJ71Lrh9aaB+tv1mNwXyMYeUPlxceR2TrFFRNpOJNnyK5hWYLCcPQrNlqaC944Sx+tXp9yCgXiLlZMzjSQ5KguFTJ5oa3oH1lCHUSc72D/8uQBrJECkMPGE7KNb5DifO4rwD5Mqf6CDwgoiW0wUBVBGGe3xYglEbwqbl9BjFNW6ECwcvoZJFJHC8HXPZ0zE+Fk68kk3PFhZ4tgVNHUfMyXrcx5ps2+3jf5mh9G1/9Q4sy3lr0JWnB07lZsJ+QAnriKcwimTpMogcmigMZk4BOEAb4nKZvNmZxNxBag1tLDne2eLOz++VQ0BFjQcnL1GVrZ50ytYIRGtCeOJbOVOwUBHsL4tdaHK72OIBxKcwcwH9Zc0UcVNPReRxBVQ8Aaf+xTCYp41XlhVpG83lcNRAaLAzqXFmlqUuhosANYGniwKDhNITkpqEV5d4yisBQAq80ZZrpJGwrWIB1Ncn56WVeUJZFCBjhCw5WB5CsOi1CKOWlKStKg1iW3OSQfY96wjMe3mSubFvbqVa132vF2p9taL3RttbfN63t4OY17+nI8s6IMTI/COujGFqHHDpFDFNaCF1aDCMthJQqIWRqk8E1VaWwamDNhpJmWUlWDpxeU5Q1A8jOg4ZWd7MbJWkliKz+BiVZZTeB5bVAmvV2grjW3xCktBakZi2oZr1uJVlVqaxad9C0RuDSs+kV07qKkp5iWTtQ2lmQ1HqDSmXlUGnFsJJ8aGnxTncKKymGK8134nV7F5o3d+J1y75rO9TgnNesxtx6XX8DIOFjOezBNur7avyBl9acIAGZXW1k8dSPBTcR0TdlZcpN90bd8xICYL3niO0ubmHOtR1pWTc3jdQ8fAjhNcQwUjmEpHymwNLzoNJ6cFkpTIgUXpobo6eewkjF0BJ5k+EkhXBpuQipwpWuFDYtHzpNDFGmikNKlSGaDJ5TDSmRQ0vEIYYImaqETFFClolh0nL5wkvTYSXZEFIxRJgUSlIMHqYEkVYCS2tKEnWzVnZ2onVTZ9bWdml1TXdel3atuW0L1na2uUqtpWk1tpaDWIJnWdw/ll+UENJBnlXdrbl6QMlT+5C8sPuZV/S0UlufGhcMoKm1f82z+pE4v1stqz9MW1JPtmr1VrNWu+NY+dKYl4E4Vt40be1Fs6vfmJxiY3xhQ2tlTI7WZQGmJrGLRgwBgWcxq891o2wpHFcp30VemuftfZSLhCG7pkXNJKJcv2PvrjjPRK8HNylF8FGctyQ2Xxk3L0k0vDST4xZH2aHl/3Vg6chP+DI9WV7Zl5dFPXhevTmtO9u2erxVa7ebjvFPc97fbGjOjtCzxFg+p+cHffksOlUu8Toa0RInUfzkf3HPpQ9q3VUc2ZpwomXQMloLq+tKWxYpbqypa74qOZcQeCRDL9S5++ZVxV/8BQ//X8aumMyxfMoYxtZ74x/3mGj3bWkhuWDyiOe1j72z65ahoEORMo4haVgwgEcspVMycXxwGyMgZp2yvdWZvavltcS88/Q3fWw3/vGyy7FEDI9oCs/2EBqRPkInaLbcZAxi3SfvvHy510zktlZ3lQChMySziQFIQ4QC2kxuBptoq4JtmQUHB3ne/5+NEleL2oCF4XcGGKkDFaMt+8sbNKsdpxhfTsJppK3a1HSOcDTGxzCCgjgVgRhsc+vCxYDabEPk9K6uh8Lb8ywBEYarkpbvzVekPow9gZxLzv7BNgB44QD2e9jzkuRJAgznzbe0RAaD4fwi+DyoFzGcQWXW5p03vyoM0GXuVWM9K8oIYBam9wDrXDPC7SXM/rX7ml8fzjfntkbBQ1vCFxwNTd6vr5ulVBW1sUPFNqFFr6+axVkxWlriYi/G5jWWFYNSLQygX0RcIWUwb6McO8rFhCz7ehF9lodZ48r+ySUDFDzvFw9ghwiC5YkylgQzqVD/1u8QKj9y6HxBU73dINCUYxGMj/GzPtFnZ5k1hhgx+ZRCmPCb1YgNoPNbFicslFn5Xxw3gIvp4+V2FtcOy/tjSWlZq89YIAMfeS/zUjLikim/yykMJlp/KsGo1S48FjbjGvZkZeqGF+5qOzx/sbVu6FUnCpw49oCiuERcUCUOfU6fOTy0zgh/vPM4VWqTkf41ftycBMLAa4ZvlArhJT2XegsGYSiSyLEYiBJCSNnVj7DyIwh53R0W2ZyL8blelu7YbjCPLz5L3nn5cq8rgZdrufU1CwByOrAMH2cEB8wAhjf/ZmXXNQxshnuWKRyMymSYVE0ERwbc0+F/j1XI65j6ZJslcRWKJjUjOIyPeReMIjA+sWSqMebOkT17quFr0ea95e/ZenZ6IDsixuTuCEloyo5Zq1PZkvcrYsvjA1jPBGDGeW7dej9d5g28FNO435568fklNcd3qDe6T70GXp6ms9s/6YtYv2pJ/UV7e90pxTvIkP9AhPz3kai5xdeaZyp2+a45CKkHrfk76xZ/oXD8Nn6xpyJW11q/Vr0I03K2/c1iee46rc0125rz78NWxK9h7amnOT2fJvWayJ4yHWTQFhXvT7KpOjUtf3GQn7vfP671F7RivF7mlsfD4WK2p35LGJdfNXbLtkbBbKv2p3YiCthdn149ZMlrXs6jMdUqFyKKdcQd+UH5da38d7977Z6r+oKr5uYHOcicts86heO3UbNO6/8NWtJ4MmmyZQMYoBVFrK5tsevXZus6W51x68z2uzRp7vGLbF6/gs22cuuHOY0gBUOeVK3eCh3DpHeQyzpH89yF5cp59CQoiAGllZSPrxS00veq+7GtIt2Hn90xw+2OM8L2OCOt8xUavjxHRzue9uwVm13xj+uKvwn2uLKtKStpype2wqQzDnGSpdiYwNyuppmK9xmDx+J1W6zsYfwB+M+A5Zx7TqNw5539+0jf/mpI0EpB5FLrfC5r+3K6Rdynl03erkUvQjQo5/DD5hbrGOSzLnVfnD/oJ6vtdVesxV9eLHtMeWeqPPj2yJYzyanJxvkJ3ImKRoX1u1U5W2zD1S22N3WUWT44zy8GC106ceQnRX394y6azjzTigM8QxHAMBlGvq6o2wB+anPWf2kzEAdMgkKKQM6b49Tm5a3NfoCw1tDVlFu9aHcUfBobSQbiTNXrWBzc02P+2px55/AxLmf4N7Q6RgSQY+pfc4MzSoUo0odyHFC9ABDs+BZ1v6WjiO8wC84ZCWpz0GfNcnkGz29X3D/fdVaeSa14/RbW/nee1ftbuOUuq8CSKS9mESQyFLMMEgSkMUwOgziHZpbIVMH4fNsxJYLF3bc+GKOphLNKAv4PJGitTy/hNgFtG5Z7+aWeduWwG5qcCYqXFfMxvWzZslWua41sfuD/xZn1KmKox8VfNunVSCz+p+k3mCwMT9JCLDbSalBXd0cnW5tYq7l76uvoNij85z8bPJRY1IhYX7i2wYU6zOuroc/vl/sEFK+39eZOz1tBXLupMyvRoZUrFt/AdUuSJyOI6WrZqtQou3Tkby7dR9hRg87Opi0ZaGkNv6tdnU1rALPJLEyaHX4yCzMjpoXIwEBLnMFgMvE9TcW6O9IRmQzfq9mu1vH2rrL00rG/gXKVtng5knI1mRfG+rqOdgmSBVQpUbRYMe712anoEZ7fER5hRO3g1UBKblHEmCIS+kurobd3wjTaw2FHVKbL3zbLKpYEZ9W2wotEIjMzVm8vPIETcK9STa/X31ZBt0PdzdGe3t1D65CmJXut3+ZJ6OGzD3K22szzH4r7TdFUaRABt7e3C5j3zH6MJOvPTYBHH7oNubVgoiqE4KtQiSeheuz7ICBx+VGJrHs+a6b2AK0kwJWLQuCTRC2MV/zHtqQqILdvx1MnOiehKFbFUCP9f+RRIr6Sx0uBLIhuwk0rft7PK+buoPswbeUVO8rpEbW+iZN9yOXac1gSXNsnEwJ8T39ZP6u9XEyOfW+srZXTHxKTa4sF+/Sqr1rfCDvw5lz7Qp/UJp4nxzu8zov2eh7ef9M23PWAheguWz4si+8eg9O6tirTUD7nUMYnIE2gNNe/zc1e58uPjm5/yMzvvr/03bGVHhOfpwc9nZDfWSRtzBoj4nrM8DWiwV00QrOLe/ey/uc/fHVFanEYaH7114stdz/8jYAW5grsHKpqtZarL/KiGXGxAOm7Lm/A8H673SqvBTmYfvJy9Sf+3d/+ba+YIuufYFk+/IGcGm+ICHtnODCb/8O7RoOSoH0QRMz1n9jOZrOqAMq2WdQ3zbCbRVKSMSr77YqNlJIbx2hu2lvTLoy8WS0Xtx/8994WfftqJp/91Ec+9FPfycDRwZam1eSSRVUN/DdSjhf5gKqqAKwrW5mfAW7PXeZbzKvUbaUpOj2m6T6EYPzhq8KY1iF4Zc1WaZ3JP+9xriwP0Sq+vg/2i2yZF/meeNbN57kM5cXF85RCwO3zv/VckgstaL2w7xLoneSJ/EkgGSIiKwZkulpJMHiWQnRsrGdcJVO5h1aKoLgIhU8SdQDqX7WMuhHwy2zXuDazG+C4y8nbWHUNQOW7cKWU/8HPW7f7HXh5jh/gZRE1G/fVO6dKOUssAJwE4MA2MY5OoR4MECeU/Id9s/ocUJlVbTJ+ruk/+akI2Jd6nmeHkU40unDd/g6Halfrf7wO7pp/1/3Yo+XTBoZEkJqQ0tC0ptA5Aj1PQILBEFuLQtdfd3z49Cuv36SDHxw50SkVKNMSjuVBVF7MjR0ccHSzJg4KgmiEQQ6l+FL2YmKMV2WBHO3+CrGUAgO6mGKjk5OZ7nkBbA6jTY/AyZhdnKg5/UzBEF+aKy4JwfD0Cx/59pJruJNhY7h4fyUICpg3HlkdxN855EN8lJ4thMDs3cxWGQMg4nufnVvn+jjPeiW8V9AahSEYTSfKAyUjDSfX++TNxfOLvBIXKtln+v/8/o9+9KMDhOGTL5vaUzmGkqCY4nkaJy43VK1R1e62NwExRVIUW2THkSBffzESSdjfRsJtHDgwUYymHVJi9LY+ItaUmMJAch/Y79SEEfK3zRiOJX2SQkpplWvbnmNSFnrtlbc4USJmMLO3RPFN/mywjKSdF4fFHEhLItu2imCyfbtqk60DDAgZQ5hzCPvicqAp3CLmmp3hZcjsreU3svrOFHawra7jUnDLKwEdb1VKjvmzxy/vXvYw69/NABQV4DfiWVP0HVgve0OvwyEyUNvnCpQo6cBkCXufzYy9bgbzQAb4UOouAcy0qamU27v0bxLKoSPnOvdCua38SCIZy7OC0likK0jOQAAPoDd+8PWLK2ZOt8MrZCzSNrRmvIuzon0KxUwjCl1Zpzv4ZZcexoLn+nDYq1XQIBh/vuuljAZriyAggIjJ27ElGCtoRqkq1lmY5AvoYpyEIadNN//+f3Ud0SKi+lJaYLFklHxNaZCyya2Ry4yojnteSVsYHUUgILGVJdUhJ4yZ3gtho1irWWVt37ODjKK1S8QPCWC2ym12b5pKMrrP+6A60URSS5+R2nkB0Uuhi58r1zjGds1zun8V97fjyuAxkI4KVFv5oms8iG4ApmX7oED1KG1iudtfrQb2VLjR8Qa7Fbri9n7QtPI8orW8elkUdNJ86kx5INXLioLokyWtkxBeGn8KsXSRGC3KFgNHty+nSaWRqL/Ld/ok+tqe5lWvM9hyNc9S6zU47Bn7N4YgB+APf/nZH6dwfBmMfyTm+aUhBWT4hnO/bTNvNfqgBxnJ0j2kXaDIG9IIxKaDjPFK6uYVA339awHADPNl681rnsK9dgHvXDn8PNIE+/e2Rrc8Pq5ngq1/P/o9oNivWoj6tDXvhLOvWhpoXPqJhIy4sg1tGYr/8O/RSw62ftDX3ffPW4v4Mok7xFp9UyjxY03zTOUfM+w3XU+v475pFPMmq6xl+UhzhmOVxi4hKPACymq3vXXybiqTFE4TSGqbr3go8hGsgtCcIUg1wqRTDPz61u3BD4ZoFo/oQh9Xx3hT3El3DP0a5Jb4anGpGW6mUNzR85WuvaiJ2CqLDYf1MjM6XvwaB+b13Xr9cL6Tf6hYQsbWEtulNkrmmYdEjFAG7GqPTZHlQdu22yKztH64Rn2aYEVL82YD5ZWUAuyFe/0CP2QBuP5D90JLK4GvgiyjM0BkkM3ioFjfmoZ8ba/BZ7+36S5kLxQlLcKLIH7Zj/UT7e+b3AjJF4uzdyjxEbhFkAvkhMqyHN45VerQYuvlbDnXIThD7z969L96qAaGjqU0fY7Y3ybYXETSiqw6k5REfpR7Ds6qsIqmUpNJiMFRS7NOgzKISuVaGpkrEhLyXiBz1Xu9NNB3RoHWK0YdvkpvknVq8665s44Bb83zGNNe0J6emtTFbFhjb9JFOWWzDHRUt9W9vfHNPy/pmGm7mdbPdFhGT/u1vNn0Sh8zhPzQ+fu7uAC7lrwkJIy3lDCf2/IM7rWkvNxK+LPUwZtfF9f5R//pV7OwoXIGW3cfONh5vXBD+2jpLF3N1eFfiVb6lQo8SVnlK5Joezyjq7JNo377fbfT7bDDift9NADUgSM17Drb9yLYb6+1llPKcnCT0dWcH7z33n5R4HjVFDweGDndgLVpxNpQe0znzM8yhSBpGEqYMD7mkzE5wh+mBTWiUIROphjw49d34feFI12Xxa6/PwLo+8Laqsq3RdH3u3E/YXOl1Z6nGzk/pYhNJraTB/MVKiE7TBr5dFrPs9dgPrLz6bT+Dyic650aqrQiVysoMik3Pjs7WK6DlGaPdT20s6jauXOLUP6hJ4wKhj5TEbR3/EpiXuHrWr159S++OQLXHxn3YzYUPePz8jCRrg6CtmUy5GFHBXToGmSXhGEQ2t/DbRBlsJ+MLrGKzKpd55scIC3rKBqONcZOEpFy6obusOb9qx/+mi8DGWG3V0auyut71qlkSPpdrsKsa2TCFqhMA1/VKSeWkSdbuQ8qW2pjMiyPJQ3l9NoxRc7y1xX4QilpCPSJWt1bwtz3WLzTnd6plMyUoZK1cvVHRRuvvafhEv36p2svocQRoYboDjEb5BSm0x/3QN7VyDwAjve7rti/zK7mMwOMAk4FkAUj2F8/xgMEWY5azi1tHCfPFP4Is3meJwO/7dfi3//dr3SOGLNrCjOPMU4ME/rVi5cBRT3KmtitK7vayzlGQ7G6ZgDjKKX3vzfmkApw+iZgtB2v5WMHWp1nwINbPbf7m87m9VPfvcv2FLgObZFpmQtHRToy16quBncB/iZueMv5C7OG2k44vBhIE4tWjENRDvF/jviDBIkxT2Xoc/Tew4CF6IA9IPUsHveVKvbiMD+cFEHbw57Ea42/vpMfO68DkmVZZglx9lju9ncFtuPGoeq2OYyqLQ47AVyWD70rLF4Eg6hUtuKxKjbzjW+eCTan1kvM7bIAYlFEyziom6Yph5HAoaHnW3WK9lQIDfDaOhvb9vmQsNmPHQVcgbl68oKD5Zr6OIHTrMnzpogET4RxKf2hPzStw1NDt+Og+ZnlDUOdsvPeIYSXy9+77JUyt7Orq630vlMUxSvGYsEH/vTkkzEYv0cTcVlQWcRZUqDtPs+sE7afhDaUQarbAU10dekSM7xQcmzTylfBuUe5Z6xXq/JYUrLCe54/tYRIyCehV3/eF8uv8j1bFEBnGZqdzvXBhniLwHxVQaoRX9Y08NqL/4lg6rKlCaMmnuU9S/ifeITG5Ts3o/r0WD5GvcwBtPZALPNan9wOaPdTBAJOp/Z1zNLybWhGZu30416vAN65ozk+C48g5h//i9Pt//tfpyZhabMwsTBDsz7UZjfFkNunf2uzZnlP28aK2uqxypMxkoxqeJbLDOXKf+vu7rurwhCLFfoDt8s7bx/TRw94LavcBqtTuLZtPcWJlKLnM6lIXOKvT8yNAbFGqzu4tCfdm3nfltERhQqpuUYa88kOvemM5DDEEFFAslKdx4f8eHcaDtwgppQEuWPV8xq+5ulkJZsRsDXvpIv+mmpcv75goIwyRi4ZnO0BteVquRV2XV1KQUiZsFTCIri8v8jKdJI4MLGOkXiIb0JI6jqMeimlzknSiLKUCRHI5exBnRVZ/aRFEywayoQ5KkjXXzA2MPlBvw9Xz1/SfAP+TIZXn/70VLo34qCNZ3UbxNWuvjvbNllEZXn9oan4h6YxfjAl27Z19XOZqdOSrVtePXlQ/o28/D91f3713CjtjX72r3yej0aDzqieXvD2Fxcf3F95HRwPYXMJWh2h53uOAjnM+1T0EZ2CVCUGvZNwK9RQiOZCuWIpzRbyJx40exItMAZ6eb6pOIZ6VdPYVxUPdcrNnX7W890VVyvrMWfK7CLf10fgFMtstX49G52GbGGz+dZct3G2UIplNBIAbbOrG1s0UXi5/MHtJ6+MSAC/1mRnJqBHbZ0o2cgaO2Z1y7UqnHq5vt5zdSMMKK7xuIK+go14xUX+lf92c5P/8DfQ/r/9NW7mFlbFoTSF4RReYC1TlfiJsf7wb588iNhuPuQtWJ0iE3ym540LcPiv/+CPgmGfnudmthc7kLVO5Lez6nu/+53lJq4Qa9V43oqsZXCuSX1lQewUIXbIT3LJ05ft88YZf7rsGCiHNCOJQT7mG37D70orDukbSuI6mfHO34d1XnDsHboWZC4v7wdGUV45a4VxdS82mM2yWWTAsT3nepqmAgC6Rb7Z7wE+sqeVl4luFtNt4UxyquDKM5FFrBWPNsQr8v63KzwCvxJZ4K++nA5GA8Ly2ZkQxkipFNkm9yRx8Sy717aDUbuUuhRCb91Jn+X8QV/G78lmd9BhyJ9+cnxIh0PQ1m0bxHEbz/K8yeJ6u5588tU/+QrTCPLxxKFDoMab9uWwN2TlwcNHD9bPlrkCAvBf+TZbHu5ikA6GwzNEM/0v+pRT4Jfk65FaRzBEKZGw6xltRczMgSMjS/CzI/DAdVm3fhJ4Ncy61gxDmbqaZwW8jDWvXpHoZuImTu9X3MtsrjtgY0XZj/lcm8XVR9rJJlhVxLmAMYghmIu6m//HNJXCFJf9zubtkCEyFe7GuGy38GfyD7mSX68+5s0ZjqcPh4xYiJOipg+FDo29/Kr11+FNHN+ijJsMgdPrG0Sbg/5p0RWZb9uRaTycRZKalIwXjTSBlxiBESQbGocnYyFNjOrdszN434fTAGXBW66tuhr0RU/VedZ/h8aiuvlrV2BcWb6utKa5uexKqGvb0g4wjKa1hVW1S2obS8vm7/ZIA+F0vzlAWdagG9fOnjE4vC/H0PhIDKeaEzqsgnAKwmoEqzG0ZNDvqfotHvY7v87B2dUvuvKUun4vdhLqLA76tXezNhgQ8bzOkAgEEdnh7vcgwNoiYF6pK5jBWQEA8ubkv83jjbTSS68POahKKc0Gvm88WVaeI+LeCl9HUV2dxztXbs5AnNVaHjAsaZG4HO8vXIQrKysLS5Wlmc0+6PbJGynLBRdhPBKJ5O5R1IrrCgpDAUZ+jsonX9BCFKL2+tqlLQXeYFAH0H2L8GqM9168eO+3VV5e0lJTFehc7JI7IpE2v2cgwvPKHuWrl7tHhqn+8oMTyPosmr+Xt7DwPxUWFDY0lHj3euH/AONFu3o3NK4KJDr8yliJq7jG+p+y5vxKGuoq6jxeb0Vrs0foZj2cpoEo5j4VU6lAoKc5cQR2IWUU3U0i4RuY8yqKHdpDWQ7f28ZpWccTkkR6Mw0WcsheM1rdEHF3N6UJm1ld3u7bW7O5/QicDNYaqTOr4sB3Angpi6YChbOgtdY653zD3U/LVcPItXQ7FqF1CqgwYJJ4c3m8iXZgracICSJ4tTIIFisD74JOzfwZ3ffdfz9jKIPEFEjB9PPkJUEQhKt5MBxFhpO6CFJlRqKdIVe//Fy92nsqoNjfMYzU6RuuFn3kK/b+vKh/BbGL8zvS/8F/+nyKfL5t/Xm6iu2uAFdygCw3VRauXOXGu1yiKYqF9zS4AnIApdmAjakjHp2ZNX1i4FORMOwEwjIuSBDzDTmpc/JP4qbRigrKIU1Tg19+9eZihE5+5t3xWKYNXlvWcREHD6qhcNaZ5zU2NgUdJvoA2DBijZeADb7aZFKDMv5c+pOG4MCiynKlZB9i3/T8wC1qTBMuEmPX4LEmTY8llW9WLdB8FtxXe3cMkc+nh8seBHducekwO2+eIoYZKU85+xe99O4GAuQFwp33sAzwpe1eXgZtHSr9mdp7s3ollOtBbySemjWLKwkHGBvZcisBYxy2E6Tr4HIa8gHbnGE5OCpRkJy7eUrzIzGHjeXqRctfVkgFZAWsdudHbADJOOrqtZHddoAMwzqQpi17MmsKiuYlsuVsblAUFRELSu0RSsWERS2qh6M4AKAoBMBpgNOrqYmFjZ6XPO5uqQ/O27jsWZ9LcWFDcdmG4CJIDl4NckJXAXsEniX33nk38ZVltRyJgyyIxhivK9B+8mS2ZrNyon1Fu7UqUh1KberQ16KpSyH9B7+9qLjwP62YXxxQElIDATxqiJW6hrvGEPh8xWE2d+xgSZCl7H1ZIcsbc2oyGUmmtXM1R37OoQ4z5rIOz+Wk/vi3fXLFXEcwxPuLEDyk/NuX+5WrtCSiZnfOOcnZy9vtGGKQVR5l/zqnrDuLHJ9fUPnwAcTF2tbDG0UbBPXQDogFXxaxnOf6if3gWrEDEQIxUG16FE3rKQqqSsgij3IxWkwUgh2KsrC0fRSd3XXdswtnvu79M8eKIQooPOGIDMNLzG/6ZAzDUIRqlkEjCo3U8V6Gd5zqCzv0bh6gPPCs8M5YFBV1dS62Kd9NLlpXXN9MFPz2Bdls4FqqUnB4LZWLSqv8SiGPTzlarCn4A1oIDdqSUE8UQu2ANXZAtWdY64W5096OfsWblGxHRfAsjbipWR+Bcoj/w/oQTukgiQyroCVInZTYAFG3z5w1YrzyfrHjb6Nt1XmV26LI6l0QNO/NIyfjwx5jBO+UG1omU62V0SKUh9QkMA/BKwMZxNRNp6kbFGwt4PYb80ereKayvC0002e5LWRUj0O4srGZKISD/xlQWgqoLgUUlwNKPYBfJHNxdVacZef5BZGT18zPASoyjwKotQEq8wB1WdXP2iP7QABkyWlBJxL4gVxRHU5atm81nwNjwM/G/RDA2jTAXyQCqnP9i7muE1R/CVUq8pGys6z9fOUNk5JVlj0sTVFwA8qLAbWuy7ipgPU5gDU5gE9SAKVjQgCyVNVQjlvIQlZl5q0jI+/VLxusxxd9nFv6U4CiCYDVkwArugHlTe3qKwLnqMjn22qkUDh4dIVHnzvCJ8XBAMmblEAqoCzr4gF/Gguo9AJqHAArDmMMV0AsxuW6j5EM3UfJ2eTK3mjRLTchVoOA1RWAwlZAefX6Vo+noWlRGeDTDEBdAaDMDVjd9k3tB+ElHpCH85JWvDccNLDNgebm5hl4YdEHtvj2FLFt6ePp9NW9e28H4/2rV9dUunRIHX/W5KfrtcUwh1CyVZbHvMucFzTmopMP9RMPhk9ay/NyXBglLtWL2e8Mdrr+STkzNKvr7KN1EGcPHsSZxpGfFEkkebTvh3toxSFAzOgGXY90vIbj5ygqDiU3TsdSzWexMCR0OrFit98W+2Du62wLIlOsGWZqOkehfQItKZRgUJxhZSZWamhWQCNTGfNUM5Neze7e4tTXd8OZorEYz1HIZezMxvzCwJKY0npmFbXN69+iIp9vI3SCZtU74LtH3D8vH6mAzxR6CIwMroAcDTxBouBrASzvAJR1hmxd0r719dPPpfT0/cYSRsMrZjnTnCTwEvImWQ15EqxCIEGEVxCRMZKHR1/pth3Mvsz3M1Y4+LaO637cgmqWPQhyLSDrMSvurIuhDRjoqGDoXnttrPtYejf5EYWcLYjTKLbxESnWkYSdPGYj6EYDGdGqxtA7L4UDIeCiVZfCnjrNck+w7/nrbw/+7ctnB5y5+eyQ9osvR1668VIVBUX6DFXW5DCGiSUZl1ORBC8OqzQsQmyR9T56++bBty4+2P/mtScir117ucd39y4K+L/fJ+jzksOdQvJfvLc/olctPGO0IkNNbIm9FqEBbTq8aWJfYrcLKHH0P3ljY3Tv3ueNE2P7Yl7NENc/+tPkoak3B1y8/JZhnWMRoCykqXimKEJ/k1+pwFNdWNnglA5ZED1o/81RgM3xr6LX/kc3bNM5/5FxfPizKa9nIrHD499Ej+x6d4vWr94IPODsufgnoyyJtT7lvFJTK9iEPOlkOUHr1R8w2Upo8pOBqmRUoxV9LtbsvG92QMe5Twf8cu29LU7f/HBA2+VPNvvhzvXF+rzLfn7ZWKIyCtMd74093pUejwEu25cFLET1Pvioe5ubJ15Pivc+F987ejC+d+xg3NTIa1vfOfVS7xOPuvOpRytrVSvSoH0w0lOcUluqSIPXQtne7Zg3nhl06fojkee+fnHTU3fe1CzPaaxQ5ANl+g+SQ/8hL33Dy8K9f7p2+pBHJ14c/PDygwNvX3i/z083bxtfZkaTIFVOdHwiTbt3rFzv4qkOlO3Tkc5lC6fxJsbrL+85lO+crYTbN/ePY9xfffyHpsM75zoegV/cftCvYzJZlezV+fkPf6h/9Yu9qeqpOKkgJoTEYXMH86dPF+pwNzpu0/147zBWJJPGbn7Fu7USDkiB1m9hNzxBdE0cH53umDrDdRWQ7B6WMqdPH/65jwzhM7khA85yvoWyd5RhcRQrjl58yXOfri8bd2fPBstoOzKVIX2mzMo0pGJYlYFVmliFCckN/gIlmOY01E5Xx2kwZkz19497uv/5/lfvrgJ8PwnjK9YErmZ9zdGjrTm71YG3XVUMVWk/+f0/fr37S97LL/XE5dqAkpDaHQ/GdN8KxgTvA8nRHZdGYIxx2LLFS0ffP3nu5Ac7/8ywW4c4juCVBq2JUJJplmN4ocNpnVfwJllFQJwbgVPL6apYMs3/RHccvwXwzyPOzBD5fPsG47bdjaOCQcv6uukd6YTo5f30mvWNV3x97oTwLy97fs12GXWlFvB/SIiIkJirjZqP6B6ov9PyRhHycJujCks3pxW/t0++WAVGOQFo+Zu4yO+v3idThD3DsSdsnGkGomnqzvpwYmNmfnrS3aQPrj5LExHSZ6hsDGLNFjXWlEQ3MYB8oyk3k+6MsX1Kxj6ZxGWrjEvOfPm19atcdqIQteN7OwjuxfZWGQnREAxr+4FzeJu3jM216UFNILYiu5z+9p7Yt2MnfoGdUGTKsDFiZIqRKURyETNmu8zQO6ffAhQ3vkV1Raycn+9LMp3W4e/i77rVxZPnxQ2PDCBKkKmGjSEkjnF4CKeLefkzsp0m6s6pdwDL633KkQ5FKC6kHDkZ5pBSqCQNurAET2VMKUOxq8mpuBSxOTftuvs/lLgOZzGEtMEvTRgapePmQGMEQLwSgXFBPu6kdzpu7Xj9Qc3qL74i/UqnA/C7hB4/PpofOzjxCWNxS/Y0ZKpiYzoOTyfH0nDZGNZo0gkDEy/qD4ApGOPP4RlI2t8eznpjRQpF627rTtn/meOB3ZHhPQLpWIRsf721baOwgqhKcxRBoPEgVVGq0mNJG04fbb9/h2Q9YoYzK/s5xqnhTxCHCT/3XSVG1ygcgP9qv0LmeXLFclPnsqEp+7o+6TRcPfHg5N2qfH8s0x+4PqLW6affPpb0/0f85HZVx0/u49nO8iA2lMtNEIrGjLVIVG1+2CGi1sMWLHG4vZ/rFXs5Vd7vTmWhmsm/+vAvH1hG+VH2UNtmpIm8V4heigeAd68p3MucBD6DjcAAIokjKHvn8HNbpa48n21ciXG3rR9mTXm4/VeWcF6BWZnaLE3zqUnJoSTnsTEagySGJ0w7bCR5hkKuqSKm0pinu34Z92S+b+C5y7frTny0rm1jxemAkjZAacX/71yJTvIv5nYThXBo6c8DgCm7gqSGCrWUJkImUyNVjfqVAos7VyIT7jpg43jA5ljAz9MNu4WmqNGjNSNaT/UmGkM7zVMZy24SbEyBkRir4EISrmlGYASGEzr7nSmrMIgzw2ms7ERGtEySuyd39f7hfgMO3gCSv9Tpv5ZnWbZ1fixkKe/jehYUJk0YG18MiOpDpcYL4saR6cAx6lKtT5ecBmWRlIBnLtRnhSRm5HYRlAru+QAY4vAR2rAKoifIwCrIw/GvR3/NMxpENM2IlDWVlOaWy5blpPfc/QTip6JJtXA1ZZctXJxtZAUuMTGU2Li63E5undA7JBst+2RyOMdSJIH0PIPDAPLdKNpiOxAG4hItohTxCN0Z248lJ6oiZu2buu2JRy7y7XFAFAqMZhqRVIRz0hZvp0CerRlmhGmPieBoiEJjQs/sUdUa1/JwgBFzf/zTQb+KJcGm3uM0LPJbX+CZcGfPD86MwiO4EN6xIqJlhQXLFtEyLc4xwyxhIkgVG1OZ1DU77Lvc8wgRhNqpbMPLckIhpIm5w2/ZYH2MMBrCQ7vDSB+58FsnfsQrKLTHLcYxRPCwdSGD2q6sgr9A1Jzi3na2lq+8tV5OvaPilz72VZ7SVw2oeIJXP+jaxVuY8SQyjfP4GEIjLKXDvMkRs7aWjGRYMNPK4WC2SzeQ0jNMl11vz3/hr8mnnJfuduke8i/pXG0cX0J/7S6j2f2eOHFR9uIRzkZCunwobOPbmZ2qBVMVge9UIpDmqBZC1cqyMNnQdMzB5Fzq2tmZhIgu/ddlxySNtD8BNkoHlgTHXZ3NHkT269PezJKLZVc8/utFQAZyLy4s65PrL//nX/jarcef+G2lK6dffjm9/5LEzD/YoBW322SfgUWkViGRyTstpUntqiY5ltNb4O9ZOBnqmaGAClXkPyraYDnN8wPHIGpH/Pf9/DZ0V+WkIRHfWbBPL9tScgHyW/QBKpTLAzaBOQTzRyWxe2yrBZ/xW80N/KrOosNOe+gBkHIEQFnN5pdv35TU0/+P5KnwUoPkXCjGDaUZjI/5hk9CEBCJImw2M7JFxU50y05UnG4MTiNSsj1M+GO72vbp3k+H/Hru5U2PP34+eMO3t6jhXOe/TJzX6e951Xcd8U0p4juC94jYpvh1iNX4+NINGkZ3tO/fhOu1q5ec3nPf84cjz916Nfrt/IPJ48Pvp4yNQrFmZKpjJwqcJtDaUKQ0DaWpoTmFYYRXgigCcQRLEQyjmmNIHoFMINMHBw9E3b64HuNIPB5XtvcKoqNOklxbt3nbM8B+QBxnQPa3BTgikoC2ICJPt9Lx0uBkr6TkwJNxDHstuTa9fRwe80JMKOfF3oT6I31QnBjNe+LQiNX3cYz7+23+tnhw+6UujuN/Ja4IR5nhPG44jxk7Sch5Pz7zcO3B/81ClWllMRE4eIba8VGzGqstNcHxZTIy7c4kOVbc8HFbOTyFeDu7A3dZA7Jrwq33wn7fjxdeGK4FdZV+jRnl+W173nD/Q69/718duWAStqF9oo8lmRjBpCf5FMXhxWAlNBZqGooxJQqVMb07/wbUjcOVGLb615wzWDa13k8plfHo0hV9LEx+/MXh18wrYiFqGJmqku2oOAyCmDJxpCHZThyea1AONbRNxeHFmfp6eqjNshWTLNnEqGjLlMtGhu7Hz3ghPAlrVSTih+I9bnt8xy1+dQSgFbWQR0GEgzjVTreRiT17vneLCmpbuHX1yd+TKISDfqW8mr+ojLwLAD/IG3zh3F2cRbARVWibap5oYidx7FkNIU0j9lnCrKxMrtmAbOlGzHC5Q1N6p/BpBDtVVaFGWQrU6z5KztysNZSLhCXW+U2GJWL7vb8c2e/5E4DNTQhyCBbTNCFb35/WPlreowh8pxFBcPaNVOf9rbpl3k5syaRu+DySy4ZyzXrSvbZeqD0YpBmG1ayTIcRKrsxLZVOdBuvxhX1lht/pWJJY+nsxpwE+lvTxx/SHvv0bP8V6SljXNYWYXk+jFXOGEKBbu6nm3Xv7I67ak5gNZebWB9Qh3SxlkqbRd31MFyHFQs4eKBoNYToL1sHdlyzwrh5j+U3C0GLuAzHrRRrcTFJDc/2cDgsRSsQhPAnm+iZXKjfWGmb5XB4/d5X8GnxY03z9B8mhyfuaNTXvJEBhXbt6wbKoK6d3zOzriTjdOIJUYTRVLKMIDCEyiMghJ3qigkSwGsNooinFhFRcyBzT9HsCM0+gBYMkFqZsmvTJDmv6QJ+V0j8UTn45NnTqG+84cNKr7t9/4mvu33/Cq+775/hX3ffniW69599TP3bD/tO/dOXhhNhAJNXtCGfxNKQ2QTmKxFUkDkWkXHhiC8dNQYob+j3lyIzGPNwPghiGoRjaI5qlUH6UICEpY31/bXXj0n0/A3cDyAgpgKR1gLq4f7BaCxyTCWLTeNag7G5kkbUfSIH63mIoLZNgGygyAMwy8F4AhOFFmHy4k/D4/lim60+er8JEwrvV4018HqKwD4b9cKxJwQ5QVsV1k0CleP8b36/x76P/L//bNsprJj6be02mCTiORGQar1nwEKJQI//9xC/fMoM+AfrOJ7/LZ/SsyKOyeo9FIglFR50bX9J4wsMJXHbCcAlbOV2ZOLNvB/6h5/j+0LyQUu+RDmlqbjd1CzD1DGDBnlc/umm/b48A+/x0xPyFvz12mc4RoU0T4+vxzyJP3nip25q3Uzbb/uTKSb/veD5rrBVeaYZ0Uob0miJ0zpSBreduwwvdIJzLDBZjpNpRurSTiB+pjn/FvU89ZlIY1q2WqQzKWkwdnHp74Jmv7um94cUdA47d/m/S2NCDaIJHbG7CkA43pMvFThJEP9yzC7HJaR6ch+58p1cSvQ4erUfCL+mI8xine/SmX/87LQ0jCoidaIZnxIhC0RRL/bXZt+/KInEk7r8wd0Lx5F/9L//zjVSEvoWd6suqIo4/PM2aSCIwXTE2MzKNKylLmDYw9s6WP1y7v9e6F3N6b39y+phHBx/K7G4fnp35M7xNNOnZilVIbd5+8QnARrs6EnuIQqjNGMTKRk2tCKvQSt/NnP5y/KG/cgyQaVw4gqBNStcdrze3q5eXnAgR+Fu1n6SCqw07AtIxPZe8aYekit3iQ7Mzn5HJmnvhgk8fx5JsM6XCgiZj8BjlkmP213N9+WZT7VhNT2fT+kWUI6d9Y/LmWFIIs4mA9N9cf31drk+//ZN/syAN/E3X/2I9bMN+++a6pvqpJS6yP+9xrlq9u8sCs1KtYSdiAhZs7XHyUTQCUmDyPBIixkTchm63wr+GeFaknx6jdOvjXQ98xIzR9FbxMh7Et1XX6BGj1DNdVp/UA+AlAourH9VSAwR07+DYQBvbu/SGp108MJfQLkD1tvzaELMy3sm3RnUcejt9sguHp+HwMBLhWmBUC4zwv8+dkwikEUejfI4lZ2LWFpk6RaafkqycLeacKWSOw2mCKAgyxThdiMvWyLEUXLbM85a4zM89ReufHOs8xzxvkfWnrU3zlpjfm8ry3hBynsPkKKwmsD7hbt04lCM8Y1ZgECWGFkQhjsyBlGuRnOjbt83t0xvb1UvKH/JzZSLPLiOC7yFC5opdnZFBJgW0NRMHRW3N1M1YToyY7D0BlvU8DYYv5MNONmffZKxaVd1yZp9v6VHvxzlW7LLLOeo+RjKqlrjHGamleun6K6taVVG92xyPcmTKCkj82hjXL3LcPZI+Q4uIQc8aitmtCqUV04f6YRiHcxFkvJlJb/YeFYliEKFa4hpTe2a+wWfx88ovuk6TlNwQpbZIme7btO+n4x9M4rRlg1K2es3GdP92/DDXp1KJivbhRj/LwkLufoTnvK9ebupo31FOQ2PiSfMI937nJLDrse/fh9ic3WTohoypOaUimW2IjZFJuy5uTOkdUDKhsHYz9y452UfoIVCE4S8QVV57x/xK4SmKuuu6TrXgWSEH369Kz2YGrD5XFmIa5COsRurI8Nvnp95SwKZRHcPchjbNpe0Podue97dm9HUjMkUoj8ERXSObsfMp7069q1pAGtTTorMJu5ki9T95r5Y2W4UjaSNx3cyc6Cahd5rfzTLLErnJ1u1n7gdUei2UvWR0LiakjJGTSxSids1nf0BT9wSJwveTpr0Z3CPThGEzTCRb1Q/z/aPAtPNePgWgMnZOQn0AsUOOGXznfuyClx/Bl78DD/2bv4G7PN3nlwPLIWWbVh+ks2ljCR45xMh8O8XlD3of1qvHAKcbE5GpmrUwm227cwa01MUFVDyhgMVA/hf4vfQIGREFEIti1i07xWWcJh3aPvVnzF66F15T0DqP6rtqXWgXXj6X9BlSWZbr8Q3yvad0wAFEoSBwSgetql7QfGXr17vR3a/yvfmVQtW3f05hm28QaXjEinxuk3IxWHdKZ3kQUYjaW0SGTHkEvi/x3aqMLYi6ghVU8Y7LmNbCNhLhl6iD0Z3oRCTwlUHm2ab7hNBfVsuqphPdLeNeJDsFUmCV5wBe8t7wV/rJJxnx+BewZvHgtf/rwxv132/w5mSQViTRAjRoDY+nEp0GS/a3Zy5NnPREXl7gKl/7xPYDt2e+6z5pdyDZjoLEsbDU1IximvYpL5r0OaTmWHMGH+OtWHwTs2/xqa2+Cekb0IrDKG5YwQwS3CDODSO4oZRhSM2NxTeM2beMybf5YibfwuybmHMm1hzHOm9AzjOo95QjH4p8AtIMVnLNclMLHpf7/bxJJ0lc/2TfyCcnFwD+JgHws3GqajD3O9Z13i+XVnMcAY0gfV6nbGyWd+xQLbOmyXa9Fo+nYVcadO+ooLF9h+RPDnWDiiKWQpYGBJtHUE8uFaKBJ6SFt1wLj18DKWSoeyoMdXflzXrYBvh8gXB4AuAo0sFbdhUqSFUvQQ2p4va8Ui1ElwEOnwaCuwtA9te8oL97Fbq6UKurumsCyzmBIIBcQ+BL22BpgiZXGTtVRhlzu8OILQJvBkuCzQv0UoOa2XA5WRn5zeUnGUrF5DZpkSnEvZoZCNmbczOTMOFMbjjXlkyWoefx+yuboAXEYbzC6XZrfWSgGpXUzIScN8Tfm8LhyIZNmsrhKSTM9G7HXQAK6rd76ORFLk8o25LBfGcOKRg88uLR8+wGMbxrWTS3RGSQ45/3xF2In3dUMSqZUjOLg5mkUrvCuixWItbofb++t9GUaiU91TY44fe9f4+5c3BHj50vSnDT2gU/65crmo5rN1pauX7YtTOfMjlClpfWFmkoxuOy+ZnbNwKsuNAVwG+oeCp0RaFWXfYtUGPJpYCS+sifbp8jmASea4YjVOVYCXPah298AeruAjZAzIFbPe/qlti9E7qmt+dYHD7VFXbZOlNezn3Q98S95xyebNhkWoueYaa82fZXm+aqHrq0U1S0ZSwJDmTE95sv/BCAzdHDrp2ZgJIGIlOU6GiSY8U48Y0PP/mubuaCZ4VbAOI6gE1n1k8aFkOIA/Q1FDPneemcf8/8xKX/nPymu1843XtXzm124J5gZRwcpFGc9MHVONJSg5UhdjH2OPPZ6MN8+Vjg8BIicUU4Qui15/41+G1hjIP3icnYliZX7hRXcBh0aPvUFsx2Sy88kk9/yYwJRSwJdj3Y5d/uXEInqHkh1oMTk3prCai6GpVNqUvV8HZqG0KDFn6/dqXouqBQgMyvaYDLpobged+ahq/p7mlr3gnammuCpiZOVtd801WRb/ZN0lbdc9SRZ6q25u1SNaTOu3f31A1vu7bhalBBrDZEPp8WuZnucJEZ6Dd9LLouWAjkwNVv6HQ1W/M7F3wnNyJDktgf0RovIKWVyZ01f9gkJgQwTm77qbJ1iq0UkeCYdBVrlq9F/mXMfeFvAwAEWHdZhhUXWoMHzrXGzu+S7KqKBJop3kmcsZF0HB/RwCl+B4zQcDlnXrTaKl9DwQA5GCsRGDfq3InTk1+O77LMZrAxFRuTQTlkKE2VRRnaqrkh55mh5in0POE5kjnGuVA+4/3M0XOyzzd8MJyEcArBasQ+hx56NHKe8UE/xsew+gZWn0NqBulzQ2luEDNEFMyyEw2X3YjEGemDA4MpAxP/jWy5uwCwKR4HrBdS9Wu96X5YmrJ4hGbbfOz+2Zsv9bSbboDsEoDVwata9kGMDzvy/iFd305oHFl/eDeLCEteVuwCxMyJWHUB1tgBVUWAygJAtQdQU/IHvuQfAtTlA6oyALW2PwQoLwSUlQDKgoAKP6DSexqATzOe0S3dd889vzZgwxhAjQNQ4QPUFQBKigCFebsZQ49RLhvlNZ4ud0swHRrroRyH6ax7Kko/HfN8aj+rsDET2xKJxph7e3vboKo1pWfod5sLNWMmw7xCjBmefQKfAMZNhTSEXSaPWSrXgxNyP5twb4JsM2G4hKnOLmG2dzsOgcvREt+tI1S2+6/+v+bqCEz3lG6yorDNYNy+sQ+3v/fP+bk2sTEqWcnOI1UgdcEzHmRZfOu+qnmhE1c1Zg5VB6PAYQfetHc7+zLjGWGM8RpFPlCmXAxM9q0EV/lXxNM6hkvnTur9wqIUM5lek2YUIWZo7K8HrAmdqxUlccqTelKqYrCGqPqn6+qOUsAfx097PnXE6TYiZiydYyB93nfO/bmGkqhngVYNdIDvmqHKJozDD7zzmccylsMjwqU7lcMxzJCfLz1pgGO2ZSKD4FJNWmmT6bWwyf5nF07IS/4vRzlyjn6XFQB40Pmbo7Dx6Y4LXbZqRJMpp9sotG0OTNlzMQXvEGLWeVQvowKH6S7ZrdjQxuNKEHGoD/EdhX3zyAhfLpE+Q6ai05sMvXvHfT4Z3v+V44HEVeG0rgWC6LvnxTZ93t8auvrDhqD1i9eErASrQ1Z+e3rY2tdbgiPf/Bl9fW/kGTKSxcJ5Rj2ZdlsvTN3tJTFTrmFzPN5+ncXrFmER32zEsBKwahagtBVQWHsZz+g4x9lzT8BfjwTUpX5JQGXluwIUTwIUTgOUTAMUTgUUTQEUdwBK6m8qoNYFWJd78Rf97y4DUOEClBQBinKLJgLMwk8/PQKXH7LIClHuPB6wrMb7qqsKn3z7zcs+kkKuyh2Mo0252e/Smwh8fletk9BMAE0HroAbAe6dbe/2IL7En/DW10gaU9+ADxCgQoADAT6Etg0eEIpqTtcHbWAl1zx0x/qB0SJzrMe0yB395TAGbMju/s27nmHnTmxP7O3/yTzYhGRq2EmM9yoIDM+44phh0dzStDSgFYNWlMdGS8Jj+2eMJCCJYSWCkxBeQXil8/o5jWB9zDtkFIVSHKvk2qJMZfENRWomc4SvShzBZJvJSrQfmPp6dmfU5Utnq9cXeDB+rMHnwai17295ob49azyNI+3UyTyII4S1J2LOMhwv9xKt7atZJF3hwvfookVBvMctIqj+4cmuv/mts716/h/xo4O/JowPHIgfH9wfPzqw/x8ZxwcPGCeH9sdMjex//sbY8B/GiaEDxvHhg3EjQ4eMw8N/GgdGDhsHhw/FDQ/tjx8a3B83PvT7tJm+H5LiPd8lJ7u/S8l2fpNsdH2bnO7+NinZ8920mewvxqnB32NGR3+NGRg7usXFy18AytymolM4ia+MJcE9dyB1pRm4jfz9xtWZdafD3u81J5uhORWSM6zppNV9y8urfuyIi6ffl20dKzOVIFVJnOs/7nMgWIy/AMY6ApgIoB+YpNUHcMFsZeyGEh+M4zLjho9bKttJEJfq245D4bIvpVtl/N1bDVwfkYvDI6b6iQ8kwojzGojC8qT4p1OIgsHF28VlI5IHRz6CaYe+wnWL2bLqf1EYsBCVZ2yJNn59Jv7nLSpV5PNtB3wZIpBm+QZ5008v3Ws7TvoWJrdZsz5lq8sn+uBvK09RRUuu9w/EeWf+41vLjNls/A+cPjl4RY7ViC1tKadpWnu9dxqoO/KdyTdhozINM7zi87SfpAJDJHjXjrh89FJB6NDSFF5QZowNELwKLAeUVyf3Dr9uJzJWakWQxmbE0wO7EN/Sfj+cotvbwH40ue3Q0TwDYUumJNdsICnV+QdcDtJcM5YE20FGE3IM0R0GqksRrRlKpzek6zHlClRWg+NqV9t2190b9n7lRIAU0ozA5glZks0DGRNdhprIYI21Y53MYJ1oxhxrInOsA9qwYDkGUSpON86MeM/ziMOEVUNBmVrBZrZxbSIn92GJbsp0P6Exj7PZegtX3Ds/fmDqn4nvpg5NHR79My42+FvidO+PKXOd3yYnu75NTnV/m5ju/TYhMfhDXGzoV+PY8IG44aFDxqHh/499N3os5t3Y8Zi+0eMxA6NHYweHj8SNDh6eFsvuT5rp+T1lruvX1Hj7L6np9h9T050/zEh1/pA+2/ZL2kTnL2mTXYfH/b7jTUCF65f9eX1OB3TJkAqAEKP4hrkK5LyaPSWEfe8lERFkYuRHI7M8YbwcAFJKqTMYLnojYC2ebJXTBiwKIQ5hOO20lhZJUrZwM/FJulXRcWPQVIdewUkMSYEeDW29cydXTJlYLHOktjKeguL3rKkJbn3dXd0+WuUBVJa/gIC1H1235fUzN8bemnkvbbS7H2Usy5VF5BkJfoCdxIVXmkYSCc2J0IwIxZmQnOunwDAiiBFhGRaBYBE9IpJLRXSZiB4TUWARpKZfpygU/iMrCZRrMTPT1j/x8a7BCV177uj3653TAWsLMcbGzjPx+Yos1xYiAuMco54hIcrIjwkYITqmvQDlVUhEe7+0Is2d5hAyc1ecRxk7XtW4GpvnePR88Cg+/Bm47zaW4FU6vEae6R+9ze/1NE7jvb5X9/kEqcIrDbe21tM4jdMQhcqjFKQG6yOObH3P4TRkaNex/YAyt6nWo0TkPOmJHCI0oKpQaskDhN85nO7uWy6QODKklxRBaCS8mIz4NqLNfghM6bHj1cVozpAvgQSSx9DzzJ07v52mLoUa3QGjkugxBY/ffmWcpFMejJJrxowwZymXnSAh3bsd3353MB2Yc7Eh0SZIuS1VQdDnVwq7gwGSE3sGhjllwGQ65P6Nv3F4L2KNxpRgyqt2y/l5KoNo8beaw2zN8P8BW6vbwG/WFSSnZ5O1b7aa3Wah3xuasdKK0wZj3+5e/JFVjSXn+VX8U1fWAuri8PfEY//Yd/EHl2zLshkptffHJy7vdt6Lq8bVud1UVGY25SKxep0iH24mKsIqZcWzFvDz9Li3o9+/SYs01IHRD/Z93jHMXdK5HliyxbFbb0q2ZpCLhJNQUiZ6qT1gT+S6BBF5r+DYk3unD+aaDPtss+QZ9Yx/tO0A+uTndHBmVH5pqpNyybG+1TqP6vcLoLu7sHQmqrfFjcdZbJt9d6+9yOsnA1pTTUkK4gRWU3jFtUxZ2E5I2E7gsMS1MK+0MMqhCKWoUJxCciY2ppIwMfbWK7XUpvuWsCS4S+oNaSzdjfWz8ag3EYarjNvWJ5zz1dOXZZrQT/Exn4adxHG6MRxenFt1mw888DHzUoPnGgLTELjGTz6N07jN987hJbg3t/B3P9M/+kclrpBjfU6S1fs+4Fdpv/Pb9OZ83heSXS1mgJcRF84rH1M8CFzzEtK/APyykViBksogEs3eSUoZ7vn/ALHl0Zq/OAgCyXChNPJFqgTvxJNIJBKJewf7lTZ/yc1Enj5o20iu+HS+bQb84bgqc9JedWu8x6v5LLiJesSvrbrr1ZGnhyiEW//QHvB1xeg+x5/4R547/UDGTMv9qQPZr039XbBJA8mFvNAfJQqNn/yTX5zENexE5XYdM9eE5JoYl02wMQZjJJk50Udi3+j+DLf13uhnh+7vffjJzUGbHWVtG6V1gE/tgLVpoXlgD9wgphz7M+V/+tctk153e2MWK4Eku5vVK0I8liy+dt2KC+d5OL11dTPlc8IC0oZFU1jajM0yKNdG00r+NHdct/CwPvw7oOYsaIPDmAzWZPBZCmdyWIvD2Aa0bUKZFnTW4F5QhgllmtCGAW2YVJK2BWWZULYJbRnQDod2OYxrghwT1jWguI1FWWTxFJQ22bL93P8DarMtfZ3HSXx9liYi5dRBHm83g0W1AfzJph3ne/H8AzbXNIzZqpxuggkd+x++vFAAL+Bn4xIeTxz7oxThYmOq2fbFvj8AxU3qunM9Efhbrthzj6zisfkavoeKNPimPx5mVjZmbNOWyjVjJGW7tuOg1e7cepYnCmWeff+nlRmugI7IhaiEgz7laHEw3DmJfQMRVhrQ2XbJdhCjL5z66k3svM+7fID+Djl7Sg9NURKm+pcD3UQh3OJfzKtSLuaVvMWVRGHl+MVRV+dice/tT2+nSRJO0whntAivbEb37172tFVL7iXKxUCDbxAqmgcAsXj/puG3T14qCAJHbUswkmrfT49d3u3CV3aMq+MevDSTBkvJV0A5ihIa836l4Ar/uvOBzqGwJXz/myszMhlllYaiKJPPGXHs4S0dw/A8ZcGx1b+Y20UOt/xttxXEFFMSw+xxywNnwU0d9AYPHNpZ4KShqQMu20BMZMRlx4h+OHsIcThrGq9wJ+RBV5GCRkQAh+5AdOdDZq8TtGCO9BSnu2RvFJhHgN6qUkOITfKph77V2O/1EwCnkUYCwwnEa3a6Gv/cZUOcLsTGIP/xxbEMYWUcKzVEFDpTx6Y+RGwsUIOaMSaqrOdrtgAPpm8ChqTIButxKqkZY8Qpcn196vTHLwHWlIk5kcRiWVC2AeOYsJYFsm1o14Z0bay2jdW0IdMWZMqCSpnQaRMmbcBkOIzBQTaDsymiwZCyHMngCJaBYDI4m8E6FNam0BZHEJjY4YnPAT9N+UeeeFuHgM+/dtMXCumXfY7dwfsOO/h6NsrzfoXXye6K1qTvoTN5GyIGxwZNzsLgGMB0RZAnkp/8xE7l+HwKxIXrOsPDx2ev+9dG5IhWsAcbFRDAesDgqpBuL2oLHQ8jfsXfXQg5Sz0Ne9V98+rqtxuw6M7vGgLbd/zbGGPApnG9Nr4PTW7dEzJPZgITbu9bNOy7Ky+N+fXIl8anM1/Fv5rck9g1tjv55ciu5J6hvtTugZ1pT0Z2jj9/pm/Et9ffnXJjfnnGXDY0rnM+tPmB9yHAbzIx/hOKfKAs8LPTHQRQGFoBmcXrIv4dxP8DjH/rinX/qbFoTSbBhE6FnpNlIZeyU94xMecrFVkvEhKcz4XYL4yOLyXvdGaonI2IbeLtDvywvfvprw4Pv3+4ztg75I/pmQxM6ZsOGl/PhC5pcu+O0Kua8mY6OLF/e+BWGnvH/XEjY+XnbBwb98eMTAbi+saCNyVuaCyY0D8SSBwc8j/N5Mme8uTJgfLE6SF/ykh/IGFuJJCQ7g8kzPUHJvVON/b/7k4FjnbFU/ZBV4/qqfpFKw9w/wa4uQufO/rhfP5vIGdSlt1OKjTVSu+D32x8LX1OPmjZYv/ryuFtZ5+ViQxncbFZRNJiPRHVavcN/jXfOkUoLpqD3G9Prr4mZfMOPmCTYSOZ+mSY7VMx45xIqtmZGClGxw4c8c390bsL4t2zXDjUs5sxMIJSVYO5jcFFkJzwekSz2oDOZOSMozsO/Yg2bCCrh8LLarkBiVdW8/N9g9B038C/Shl556sjsYcIwq2KfG65cjGQ712EjcjGNPXY+k2nhaUjgqSGT2dEFBbDrx5/FFZWO7VNx0xlKVB/+FWepx7QAhLw0Lunbr9bFE0q1jPlAm+eDjbfa/fxE3q/jspquzHEOhZJX4P0VHseRNN5+0ZLH58V1XnkZfo9w+SkFE90kxLrPajcELzEsBZcF7Tmw7X63d4zxnft+yDXjGGfslWeoZgzvXnxL7X/B209CzQdQId1N/EZxTyZO+bwCGy2WZ73lP6R44gt9qrO2LCIN8CUNuZ93wYLPYS64Vdv6VWetmRPtgAAbHUkcOCkFzxBPYzXjgdXJArd2KjKjP6+gxlvO/vSRzp2pU1296XFuvqSZ7N9yRO9u1KeD/aZJluPIIGwUEtJXGfqwPRniI01U1+vIoOrYwmeoqj3SoMRyrHBGGKkMnZZOnNoyj67d21y/PGGLc5enTrq0f464+CQ3zg25H9n72z80GzwJ08anPBHP9lbM/n1TOgtGnvHQwn9/YHk4YHyhJ6RQNybseAzeAaJveOhF5w4MB5KmBwJJM8OlL/6uJmx4B7Ts11lqelsaMDPNxoBm2KO2lRjPk/FqB72kWyFSlEI33XIaVcg60Su8eGiAHRVhnpgc1KxMyFPKZuOQHfO2w7Qhj8qG9uG5rDBPbksE2e3rgz3+gWOVcS81i/k/+4Ik0VZUpZJMitFZ0kURG73dasBvxpRdMX1jUUFnpIS+LoiPrIPxLn/nmF8ec/o8i4PsDkesG7sKeDDMecZW2IjtoPRenjTf1ShJ+D/QGrVhtMv+3mVK/Z269MslAI0heXY9wBrC3uyHq3zXXlrI3R3xvm3RraRIbAPf2p9oWSdwSCXGkVshO8OUOoBfD8J55+Ps+cLB1QnAerGXXK+ev0ve3nnfxTA+lEXjC/4gvfAGGLzAsYwsTxYgJEZYmksmqtngf79T/Pgje8+gi9/vywaSSO7Bpxpkj4yTOZ4loxYlsyJLBnxbp6E6GGELNM2Wyfy/OXXAYVdysg7z78Y6iS0C8xeN0Q5dpjVWmwz4I+r6y3pnYPsmIgZ52ST2j7VSFq6fQf+9Ovk4qSLW1lkh0JJU/zc2woDSAf8PHHC3bkDEkcwyVaxMcbU/qn/bTSNe6pKnaAcVQwmSVNr/csymKmkPKC5eL5vPbQeUN4IqHEAylKIQtTeqbo8e12+B5v5Z+shUVCQ0SGiMBn3dMcRQLVH3fT0qIpCzXpFPlBGFMIh5WKwVhd6O2F5efGoB7s/5DTERFIKaco53zn343F16MZjczJR9D5jCBWDhbjBcgIL5/xq/ql+leBERVNcFDc1zCezEgOGYNKzbSQMjzFtcojk8X6mJ3rJpK3Ino4rgZiVbYw8zC/+CW7i3JfnGIH8ACVlECjRNh2zAWvLo28e/USQGNJNyX9MyXT0b9qPs6YqGBVMdAEAAGdZW2wbvzbsQawOINbXDSaJRRN/JoPEjCvrWaDBlR/2y8cDh6eLxFXzOsI2LZ6B88+WeOoapytDE2P4oceNjb6HOMhx71hc6uKpIj/IHRYOelydE/Ik2Kka7elQK+gAFFcDyrLmPrsXfBRAZd59AJQU3QdART6gOmlPnH8GVIwGrE17tYByG6Au62f/bPz35PlcjGKoaEvh9BNDmIsEB7SH7UnnJ1rnGYKD2uwqMFyuztrM49BU1UODAAoC1n7H97qFMWZZP7wrLK5r1f5r70phsFaRNljmt8D4aoxFbbJsVj0qwrM6rlaRbSRsFUgfvgWGBy8CPDuNeBHMP/P7X4TADwkJvQcr9S5U9jmIvK8X7/d6rg/n5594lD///iX9e/////MnVMv74MEw1QNYVP+b358WZXEUz2gAq76PQHEl0aLOJMWYiqSoL48q2pRfr8g+WlqqM7h6b8Uvvx2/8qcnff/HCMf/r+8B/j/+Pe/s2u89k/7n51DO+xDvHeSizyQq965EZZ+N7NhzkRP5e7/5UJV/EoDvAP0WVPuXv7O7s//+t3d/8o/9Y9/EeX/7HnjnifzP5F/+cT3r+bd/y5//Y32DfO8pPXt1ILX5lFdldN32TXNGIoMoVMMLjuiYWna55XRZ2MaSw6JoCgsyGRakZXHMUgIh8A7GTuJMfTke3mhp+VIiCM72qYYXGCxG12GJbizZR7lIWNSiY+PqekvG4352TMRN9kST2iHZQFqyfQe+JHdxln/iwUX7bvUQk8jSyhX97ILDj4KxePTjA7fZPQKfSanH+U5D//HyhXuhjpybFIH3TGVR6lKE/mZN03HKxYdteb7cPNo0PH2g1xrTuufgyPYjD3Q98e4UrERgnIPd86Of5oHb/nqYP/xzmbTaDC1SJt1p1SEHX25WLawbGxw5SrWfRJfms+BWVsRudeS4gij5Vyir4oKk8V4sOYNMnhKUQ/oML1z1AuJgC7Vsd+DkJggVyjpH80JTMFhglBO45IFnLjwgSM0w81gxAkNRqmlBLMqnlmXeilC+GWE0D7OCW6LNxWkisi1Ztk/9P1PebXt6dWTLrYSSdWs6hqvzn5Cy4d4IKKsd9Wx+NZkzMQtTWaUhNGP0vvTVu4AN2V2Wf9MQWHXn4aaIzrPxOHjb+5XpU22SNtwto2/u3du3/cr24LVg48kqq8E6LJ3p/nVfHe8LQnuc9EryYb94LLATTU6O4Zx+h+8t2t/YmY3ff//96fdkxP7mdMvdeYaCYBnD2U6cxPjga4ifs6uobK1220dnxLwQ7fx2E3wg1UO7sx9OZxukRhumRwzYqnJaeov+nTdkJar/gn//3bGV/s/f/pGpvufDq/7wP/zv/Q/94O/8P9R+H56+t6r+zm7P3z7p27cR774Jc/Uf/LtxfvB/0OK9XJ/PTiRDh82f92hV1kAb0xNSe8IVKse4lTntHvzqkGXEposEZvMnMRxlnZf93pIT916xw3qbVigW9GVZBLio41JOFT17EbbWnX6/Lr4Ndv0YFzkL8jPeP1Ew+oTNUUogdfww648xPg/b5qjrd6ORwEgJgi32Emcf9HVYdeN58VcM5Ao6G57KIsjr2IF48sTFmenJ/jssoSgCFNvi0Fn/l0988Y5PPYmkdW3xzIUh4kaYENYP14VxGw0pzz/7cdxEsvzg2AGuXAyUKIvCZNWS88y/tvXNo/9hfaKRJoqTmA/usnWcLsXhceyEYycUiTPsREemMhyFcFQ3TIbSbceLu9s0V3Yrqr7TKKXKOlPrcWPwGOU6pyl4/A7G1Q34zM5+dkjGjCOWVrMzcVLnunfgS1qrlzg9ItZVhOmT9+XE48dgo5E4Eod77nm6gp5t1XaiWjQxjCg0E9c3MtxpeeBawKopior7PKLmPuc1to+ikz/J5Dcz+2WqITFEnrEFm00JO/bmQhyFuVg97ZxvoYlcZs/Lnt63/0/HAau0lYXZhleaiR0cG/DfKE3AH1VT8ATVJc+0dvX8RYDKrpjnUx/TPjGZPGVMytI0tbjpM1/duoQeTIiMRMrBkf7QtSCzOHVo4N1sRzUcpyJwlVtlJwpP4klIHCFTHYenkmc04HRlY3c0ZmU+J3V4gM4b84OKfKBMVXXPvEq/Uth9Vv7lYBdR9Z7jG4abAtc7VyTMDQ5Tf1LLxGyQRCbdyNDt52cPA76fhBe7dQylvurfOTvzOdlmXOeaW7GoND2/fbSiXb2wRB16Fy6iu7F+vikIZskmithknXrA+70P7aVjwRNBCkMyQ/ofuVGR/zsYU7PNd++QVJFNYyjXbGCG0bndvpvj+YGy3cbT8aINglkvLZeLyZQckSBdBHjUbKm/56jLHe7NxNoF/eW7plu/DSE5z0UtKhCdV1WFHCdh7H+xgvGaeMP6Hd9r6iZAMPlyQ4hDjvRlprIT3oiYRgkEzkmLX1GqgDLEWMS/hW16WIDXT+5EyTlgIARaVjRYEUBqvL0EiqF9sib5s71MspcvjOw4RJe/KuVR9UrVadyipHO43AC0Jo4FJ4NWy2l+6K2Q1Fdx4xzSl3riPveOgyCd94qkFotw4SIW0tYXVVqiOUw4V5hPhRLjMY5FOeUfTC3/ANyyt12nSdav2vw+IVy9q+SGljSryuIEIhSX+VWik41vRw8iTTXlWpZMFMzpzAfIMFdbiLUmg7WuNtGm1dNig+fFTo9dMP7VrluyRjOWjSQMYxGxuwlG/rZ/L6B8kqrpPhsb93ZWpEG7FEuCiT6g3oq07JnxqJ/3bZu2Va6ZIHk2uwP32fRk/Box/6mn1pZPrwc35eJYSoDb/wdYiBrTevjDHKsRlmLFuNzIVCZ5qO9kxPePnlEvcy/0Wwov8l0fadj0h8fXGPunDvASwli2RtmkyjEbmPZ2fIc7fqlzzbdMx3bSMLrkxO16w5mev/JzTuvKLCxNU2ZkqhA/OjHQ79Ltq3XfejMUyC3XbBcL+xx9cPbMvu7PWIYxMduYmK14BU3c2+kPwx+rEF4BUHMg8I6z6YGHs9hYE7KdFMkyRaaKif1j9r2Myc7ViQMjW4190xdmZdrWk9xeY1Xm6unD2ftkU8Vuq8aWZlpOYd3jh8ePtatHlygjxyVEEGpTLkZKf/yNJAr+6aqqbw6g1tXv2qUv6PccihqK9gxsTBGL1cSwuyd3brzj7fTAzSAvovP+6KE/XV1s6c3s3T61BUcKaSlNVI7VIAlvJz4ChMYElpxuIvC3LGoaugTdN5vG1dS77S6fb9vnleMBzYm2CpNMktb9Dn9VccGqajC35IKbLglb461375DUkU1reFa2nnS7rRd+TPqGRVeyIgVNeLwL3FlY5DweWR5GcEX+vG7yplnvYERh5ZmV6F7RGtL2y/5NDOLSrOtf9WpNoxQH6jO7n8Hc5jRgTB0ak8PqtAGGxN5STAnXzf0N1NdTUKd7BXKFSTc3ZV6aVt1hFKQiRTRlo1pkIMRaiZ+yyb99nuN+lmpMMuo9/0gYNcQvWeBdvNvNdkH/EDCuI3TFUiRe6r61BJagvbLWzwIgp/fvYL4hP2ukQesOZnNTliW8B/Qllq2eqex3Bo9patjcKZgW2sAw4NgERWdtQ2Qe/eYf4tQtiz90uI2RozxuKzjj8w4xRE5v+6jY2/2bBxsznBZIzxbKs4Szmd7i69tn4vxz9J0Dz9pd2aAsU6ILdepAl1JucM0/AlXZoV0331KjVnYPE/JqcPr9IXKsRiPETXV2cXOD2wELUV0AChT5fNsb8lWK35i3fcrx9oiI1EN9hDHAQfCWJb+a+PsYyGHCUGZkKvOnrLGWgRkvRk9mjbb/I2Z1ZBqHYlRTtmGuyBTrsjb76lHtzlgUdWycPta8CJZFlOMizq7Vss2hX/TPnOnBxhSLtbkRLWpctopEOabpjoG07uGTGdMdJ1iDGIkrWIihTZ6tWR+q6cMD9DzyauK/+ZIONvDLATbHj/ll/slcM2G4VJvINjcZU+361gHA/wH+MAbwF4kYY8DfJ6W+6zvsshuNMGuKK5tg5OMDvwFWrFM3HFue3QM//MfWffSWKSqBnpPp2MhtHPvH3H4b0xFtrHiL4/BUne3EoNMWWaPtA+ZYa78tDdkuvYXsjGyccWxmZRuFS9gMuHB7Go74BsQXWJqItK4jjPtxbU4eV8OGzXfdf8xFXj4RWKmpTSzJTK/JbLLr0cSO4ep8VVnqUBXF6uqCbb8/mYgtTuvN26URdsscehspbm8vvCZLEwQ9Ta2RBcKMyWaCNkfMOW1shlV4VotljtoY9/obamWosDmW/b/jLbCs35YMMFYDJoWAawX6s4cwNhq4dk8tsb5DMMVbkxAZjMgQJnTnlLddJK361B5ZLOf7ufEFwU682LlJIyoykbOMFFAEOqIYqM/vaf7Y+OKsOKcPVyf9BdaqWi6Ch7ucoe1za62tLaQp9XZSlmkodNVfZmNwz+N0p8aeZonb8Xp+NCJmWcZgNQ9XJdh2QNGNG1MBBHkEM5S90w4v5XRap53v46pxhpAxTmFYlouyw4e/udsHA10H2AU14UBR3Pc7W/cd9PCm4+gHBz/lNLLMNBVmJFNx0yORH9oFoDgIS2ouIrrj0ojwo2CsAYsnEpDawre8WkHP2iKkiWKzPMxyJAOvn7sUfx1dB7AQBGY1VoMtxRNvTUi2GVfCHB+WXU2mJMaffplBUU558xF44aUKt2HiqyCoj5L/GlWR4H3PgXucHfFvJiMuuxGJaIg2tmSLWNkG5ktn2zKCq2nkIoumRGwsgXW6hS07Li+Zm13huyITM0zG4DIXnQxt9s2jmy1TneyQ3IrT1I3dIJbD4CrborhsHburgyjWJGMRknHDK42kniF67nl5BmDj6A/kdNAHBO2j5b60vu4TdqIoymoJi4LoMXf3//A7I4/fSu218WnSJV3SJQ3Y+3UunvBsx5N5Rr1IcTgsZxQrbay733djcKtPGOkgQn/LVS5tUeT9tmplNZiH/fYK7onDXxzMNetxZWUjmUTZbGQ5TJ0cQyUnq+LIIGM3UMTpKmr71GfYpk0mPj+8HB8bL1bkw7G5Ni7NSZv2smqrXfbvuPBzpyxRtmGZnJSkua3WxnvftJ68MvAuUJYCDd/BE7HvWTLOiHXdtV1aV7Jp9js8WcXxoaeg5kCQ2R0oC80LY03kjlqsGRHA0ch7Z9THxabpeMrUleFotH7fQKkHLoFgdGPHvuk/+CBbLhFuhofW6nzZABxipNGV4naKZOQ1pUubE1m3RQuBmWAnvigDtXVCjmb85EFxwJ63imZXRBTVDjRa/NOpqGKj9hSa5NDIyZenrWrob4yJKaI0ZE/5zAglkQ4cQJTibG/Cx4JLZWYEvfSfFWuE6Zc/fiB5mlcmI9ql7CaGTyanBgiOTtdMLGLtCBbDroq2CwXiyubWY7NBJkvB4U1OlUhzEfLkAR8sW1XxxVKFMJ0bGgHN0a3Rh06HESBm4w3v5lrnush2FEQBcbpxJj7Z8RRgISqo7ihTBYK38LmqvwgeIhRWqELX8jbN5Z3Gzhl2SDbicCG/e+LkdjQQ3A7MYRODlZsX1mLIoXvmbwPsFN+Kaw6Sa8aYZE69ulYLj7/mvR2E3YYfMOuzXRwEwa7Yu8S/GK5Ql9zTO1WjlX4bxMXRtw7+xM1ys126ntkZGZeNxOERsRMoDi9BjhWDS3Jiu2ZO9jz2eB0OaAEJuAnrmhhkDt8k4N4/3l6S/MfwLzlphR0TW3loTouI7BCRqSZ2ksDGFMisxaTO7Tu1a52nt218XKWpCVNMrcfZKABcztf/pysv75jYQo5Vj53ISFnCkIuXFsKVjbH3dA+MG1Q1b+cu4ZueXeSYUjnu2f8i1/icpzTg1wt7ALUuZVPqUhWlqs+yfHUTNiIbg33X+bzDfzv+ORVv0tulG5iVjeGyVcm2oLhMJHmGIrMzDeSajWS+6enf8qfLS/CLxrjJpx1OBlMja713fIkjm++57+yH88o/wb0RpI7JT9F13/Ot7aNSjzKQTvGJosXLy+mOyRE4qXvszWsx0cCsDGK79FYS7f5XoIYKxZLg9oScyfyIMFR+aK0kaktEg82V9xgRSm/4GZ8C68EBA5hAO9jqCkVKYM9Wc73vH1z/7CLLdsUsfd5vgMh7nPUbei0mrVp2xHJoxFKHrFD5j4o2y4+pzCvYBn58NbJS6gxb5wsXUUSujoHgy8mx1keP+ZkkJ+ItzDpAYE1bZbE1xUDW8XIpJvO50ZrzWyGXqwPzbi/DhQRm0V2WlitQRbVskymPVjX5zaQs2fik+V3okAutCP1SaMikDit5CzJ11l6G06kQmhQ5PjZj6K1bOglTYVxBO6oWlbrfWyW5SsXtImENzwD32/F0ZsLo7JNppOe+DN56T1Ji+LFtLl+owp+64JAlH1sR+JvVobcN1lZlDL52aVPq9NCrpmTLQyaduj8xPvKf7qtetEILQMyURGdqBfusW/989r24vunXUvoHn44fH31nRNehCwAL0ddQZYpDv99jU9XsTpEPrm6vijl9wJQ1sVu1INQASks32/Kyc3LXrvtNo13vZnb3kTnQTcbbXpK6Rv4X2zX7dK+Dj+4CFLY+JH3osucjX9bAgPsL8R6DTt84K324/9HUFyNHst51YxpvI62nn9S+vs+n9sw8venhh+tvtm9QUK8JhEZVEPIWxRn/T8ILnPc48vyZ85KHh99OHsluT0t3Phnz++ydLzwCIL7wgpcXtqgLUgVRifjbR8sKt7526o1pL4c/TB7Ibk8ez7468tqRxwF1qUEL7tylhcsxbnL/TL297ju/aY25v+vetP6Bj9N7+skc7iKjr5e0Z8NYpjO9o345dhOgbtzcgHAThnCR7jBAW9NTkUJp4vajNSe8+oGPjO8mXo6fGNgxsnd/X8je13NOVRUEfacPWIjCC/G4W/NnZgwNvZg12flw5nTHjnG/778QqjGK4Zw8KHJXRnYvOGnLQC4Kml8U/IoWQpwJsa9CK/EEB9iYwaFhBSA5rFhsUEyzb3/5w0w2Mlciu+raWrMC7EarXN8LEUUpyjJ87FAt1X1dF5uMIShiXAALxgIA4gDfs6S3cFFALKEchCH2gKyLMiWHksMZ1WTUvSWW/a9LBdA2RtR87PEQV/LiM+kZoVx9nwXgj+al1GNFuadjxS1ZB8pbILBXRA6lwjHKvY9Irsrk9jLePs8bmtzuRhgtxa3pRAothfe+ARVvB6dAKxNyXU48WVm7DLAsAiDKKTdMYdn8FRjn8xpU1s3J/11CFKL25qNjQG/M4SDa1BFZA6h2Aiq9/wpQVQQoSV1TME9KG0VQXwZ4Z2lt9aIK4G2VX3RBxQd+9/qqp+qFY8BCTNBab1vw7m+agrYsqfmmp/BjlaVgrbbqrq8uXlHZBMDAbbpi0c+oigSvruByAqoyAHVZ7eor5wWuy9kQuvf9Mu0KaQ6gqgzwi2RArU1XdpR+i93qBKkrpC9ZMGUFJICNIwGfpAB+kAX491GAfx5RWbl2eVlhRfOP1xZFF6A2G/Dd9H8H+EnGnisaGhaVlzfl+2+CMeBTu3a5sCxoN5gZsH1xlyLIbcQYLzwsfApPdhHlOFKRsvfTAVZPAhT1AIpmd6gVuuob8r+P9wRsGvW9HmrpUEWTOOGA8hURhqnQnIcVSwz0VmsxLdVagLOdDWN06zWaio0oIk4pGmsZ+7d3vN3SbIvVpxwCqLlZHWXX2exhEZkrEytC18V0JNiO0ZBiKyKAyntVVlaQmPxXaBfnvHiB/CYlq8ZkqERaFSEMy0l4f9WnigSgYx9QFGavG3AtlmdrTg18BrUyC1ZWFMC1r2Tze+8UCD3eMC5HQPr1NJzKfPr1niM1RWexBXU5LXtRhRQAKmhD1cHX84W2ThP5v62bqHZbuzCg94xGypo/sr6oCQoK5NYPn6xd8yyIF7oJ/gztJJ5rJ/Pi+JfASyQ4qCmcAg9fVH34m3+xxWf9M3d+iz4/Svivro+BCcdYmvd8eNX3MzLwXoZH39M83PdurLT5DMdVC8z/IptiJLi63g3OZhmEl68864n7s/HhHlsmfv6BV+ud5CJPHoUjZoy2qYNZG2eMiWZ7IWlkdS4bVcaSm6jBkn1+/bf/GU5uvtVUs+sipAWL5VvcUvqf/Pf/4/dD63l+lZ/rJPKiAir07vSsT//434WT6+eg+h+/0EbhRQhUds0Y38Lb+q6701sfjP9E/Pv3wNkv/mAd7zf2+6/Qi2vAsVfx0Sqe3Z++tV5O/WV/1HuS4Zl3YC0/8z2y9sz36NJbw3Rzmh/7/Jfgffn+HSd/1w0v71wf/XwL9kItr+eirNoTytUTMWzkTx5IsX8eRwvBSWzQGV7mhVDJ6f7v6cCUQzDWbnKycwOf5cuMyynkaNw55T9Yp32i2gUKCUrIBEPqP4ttBRFhN5rmG2ol3kAR0KdlFr7a66ZziqhaAMIkLdAon1tO/fNshOcyHAkJtLSREkno74fw6VJmhG2z09WB1AFgCaRTRDCRaAMGWS9P9ZlvTX6+MHVh0VCSe0cFrS3jIeXwWM8gVd4AWLQ0hNi6GMGf2EVzhNOVDXFItuCQzAYKESERPntQKW07YceVaXvQS7f+2c/7jEEUBLFtzpdS2rXcNl9PQuxsqafmhAyrPpo7+ZhfAhbrkPZQZLtg17jtg0hIdVG/RIL/35/ww4Jml10jkh/aPMtO7p1G1Nx/nBX4AuYk2m/A8ZPTUiwTF1OuTHeYUtUTEZMJOUTibRDU2RKfzeDmhKdXv/71o2d/80ffbFX/1/yX30YJj+IgqLdM6j4v7jApD4+NeHfRDfIiWz786mTPIUfLAGFq4atMV0r5/GYQyKktYO7/+RTjprMIaiGY6SMjDkD1rumfv0h9EAoaVivcz8LFUoBZWGBItrY6my3oRjX5JiHkBEu7BmOxfCgYiOtVcbFrmTqLhKRrOaq+dCu+70rYxcGAOvbitNOiqDZ/NsT7eZx9qVfjc3JF7E9/Kg9V8HA3O0Qsz36ybrLReNGf2yblaL/A9W+HyK3JKaiihhQxoou75QgVqDWU2+VbCiFi/uA2M8ZpXTymiJboDPCuCKNgMgTo/GJzHELYajDURcuWB1Ukiu3d0pQdqyi8vQaxL9UeXJPZKG/jqLoHoXFIQBldzZEVt09dmzBRGpoFeWWb4IHl+6IaWD/UBfMoftylQUtpp1Fm1Ds/SmzR1g7YKkUjZtqdCshcuFeczlEMps+8drJtx0OmqdqI5eHvS/lmuCgCAZ/dFYVjbi2kTidYB+0Qx0ymPBEgD5RNNLtWCKtYD9B5WXSPd5I6yxVZxzjK3gJbAKX9Egm2ycr4um2Lak/OmhhoP4cJKKfLZTcq2Vacgy6XXio0Q29Q3VWRYpiN87hDO/C8loTFVlAHSHK606vGYLvDKiHny882YO1S3HacTwRqhzzGy8upHBrrp3BshJhR30IGxmhnWQTDyIiHiV6b3w51r/Rm1RLOm53esiKutMNip9LmNjETNcxv4SYXcbKY60vQxUtAVMZ7s8a7pQaalFKfI4iFkD5di2sCyzj0f3FMOY148xd9RiAQtgeDBCI5h+TsIKTzZv9kuucTbjTkH0NA6xcHWjaMTj/0kcswLi6JL0KKVOiLB7tZn1V9XxQKfD9kLUrBu1LKe5vSeIRTL8v1K4rWD+qxz3HBgzHmTPrcunUxROnAqE99DOQ+GlizeuRK1yjmSBjv98iM8qBpCY8XmjWzvqpndVOQpHCIOfdGVR2jVflRxaizri+qR7T4aXNV0vNe14frKvE7vtedbQ7FyvFdNx6aS8irZmikc128ljY/T8oAwp+Znk/loQe51qe5tMXh0FRlTpcZ7grvvR5Bnooq8by2BhL4UsFatxwQ3K7zkn+LjoVJT2JSt79i2BxV6X7/DiVq7CeZx/ewLeLsS1YLEWX/rNUwORD9bIIdW/Hipt/lERnWGr3jBYh5TTJRIMISzgDMIrsLNniaNTZS9Wu0E1Rjm82Liw1u45tLXO5CN+lSMPUhxJtY3cuUgompGS06HcJ26yvuZ6eEflyuwCjwRErsRTon3TCpkxM5P1BWSb3h4cGgiFR0QpyGWpwayhuWGLqNaqrAJFT1Nur7yDyelyDFqSxFS/mSxinWyV+dw8iJ0FNwfXvMRQZc+7sFHEzsPPSRLDtlBDa5j2Y15fe57LWRbNdG7sLughyKYjY0M4tHk+zcZ0QtxRLodN8lXK8GzBzgqfZ92peY402+SFwFRPs+sUyAtoIFk0MzBhd+9u26KS4/j3sPZVZn07XyPJcwZg1YzOaFDVyJMXH0c0GthNaxw8GWAmkcLqXoNLGc9hJwearmzW/tfDqVnBxqSO/p3k5HJExvLmL8/+d4sGYwMC/nEFPlRcjcELKkbBcXJ1scoT0Pn5lM8RUpM5aiMJJVJB7Opx0qEaVojnKSsAoJcRlTNgbvbIrRKBkwEUeAxalCzulNMqqwycBd2kpO2Y4DFgEtTtCykAwPJU+5Cfleor9XpnuBAGKq/fpUAwFo6bBTrLbsdy9ZmD2ns+l0AgTAuQinOjx+KlkyQoSJAGNMqPFQ0S92j/Ei4qVDkKJvDitlh16G8zSccsWC4Nfeg3nZG23pJmRnq0U4Oxie5w2oc4hRw+hjQR2/ZCU4i0g6S5BMu1SdGVuQ1ylHbs8v6oqvv762sx7zlzmjPYcoe3QwxBBKe8XYxW5qck+OwOYcoBz2ZPu5z7PaTlOOkZg2Io4CIDujpJ4YRDSAkICQRRgri07Oz3MpMvXbsgC2jEC4npETzTOaF5d4JcJgzEgxG6w0hZgbRkNk8rnbxvsppbMxQ9rvTwrmkmC/nAdACZE6gwCUnj+nlincWjiPkFi7cMXvgBQnjNWi6QBhkgTFgcP1FeYIqXHDcQL2y03K4KwtRdUMefht2M37c3gP/dW+SEqRMCSAc+PmOYD9ggshT9SZMJ8HIQkpnPIwMQh8g4ToiU/fXZwx7oUiDHfYDRZNEJKECo0P5xLZzWIRThe3OEWWSKSr1cLQa0a6ptAdcT7OHup0KpCZEATJTvcMZRpKs+KusJHWT57Mki4ISYbTTegjTfYAm/5Nf2NSYqMNoJygQ3K/dPqC7GRKjE8TZAJ1nJibmO93oikiYBlReRhuAKcp+FIdxziOn6aEuMXiQt8DRuWVAoyrichu/PrZb9erO8kpazlaxgZwtwXUs7DvcmHy3Tdl0WuLvLaqy/t/89V/4K//zV+xeC/jYV0KqsDXqvZanAnCLdg/iSCHy02Z90LE78X+g/58/02KaIFffcVaaoX+wrih7+NoFdDa8ugh43z3iPP9nF8QWg9n3aaLmun8Z++yXZc/A1ed5QLMvUTBw1ciFNHvLqMy+drmflcI7ZISodIlYgKGDDLPunMcyCaLkIKbQ/y4w1IKcruFK9yCncesLorIw1l5EFcyXmJXSsXPtMwYTgTg8mwxn4uSq4ko1nvfhY5zXgohK+SA45jBqdmfynvUXYaGSIhTYXRIVFwL/0pxregXNfl3FCWFqpd3lNB7A4lUC4G4qP7ybxNc7sWt1ZyDgNUZll3kOuYP3nywiQSG436ahny6eryYuiXNSyM2ZyDvYBOjhZXz7Z7CL37Lb3NOK92cgbC5/Qf+RrJQ21Pbr+Qk/sZtsEIxbcr+gdqTzbfPN1Ay4vAb3sqfdxW5LTy2jMZaZkxSZHaPMSXhIgSUJlGQ8PRGYVtUvetn9tDOJ77ZFW6UVAcmyT64W5IxlqWOBKLM85ey+Plth9Evn+l8t1NEf1bGVVkqaNn4HPQ5K68re678We7z9SkyQT7+9gP4Zj6rxuL0TGW7dQfZZ7J3vLMC6lgr5wTlia3YHf+KVSymHraY57/i3VoEtArPu7FFhAMi43DhWsBFjdWU+4DaNCpgsHAcffFTjlPj5cbPMfaBqgEEIEaBgLitnZpL0F01VQCruR97rXQeQmg6+axQPMrX5zrrCjtWEunKqUGMHWqrJOsmEAI6z4pqQHyNDVnrH3ge7UgI0ioYeAlnUvpCStAAMRCoEBaLRWjhCgx0RhV8bmCZnU2d+a4bC1cDffcMTlpXLF1InEv6ZxsxDacF7O+bbqXt/je+oelsGA9NLuG2rmu3UiMzy0J6WTCtLvmxY2btKsL286cwFavFsklqnXRHCnXepviBOYAUSvDX97Jp1nskkESTiZxIg9UL76ZytbZoFg/X62eyn87Aes14c0Qvw1Xe5Kqb3PplU2i9xJKq4nF44OvZ1RBejvadU6VV68xz5PgRk67PLyVIa1PGL069DI4tzgHVslFyp4MJwrXhGmMQQQzNYcdmsK8NBfH2MUZHXrIxXYZkjBrS/Dyi1GGz1QfkuHJ9f5FNCHEwcQPN5pLcwY5Q8UJJhfzAQBU2gTGQlgd/W8cb2lqjL/IHzEyKl2kpaD83lZXSw2XFEdVJcgVkhfSWWeamg7pFNNpchxCaMRDJV8LOMKg6qNhBQvHrueA4oXCpJMKlNrviDD7TClGhTUJ8tyoVUiv/oZ9of95fOaNkRfRu3XaXmzwOkYojvdC7eXo9vS7RhrrXOdWlS9PgVorJ+TPA50m/y1uqJKi2LOvyqSXUa67raOQJ8vP7hPuKlNJFHKWi2I8gdobUutEioGK9bqC/DFYmh/BDV+vlrNBQNch66CiSZRrSfDrVtJkLIzdlJ9ahW/4dcHlx/7nBUhjdCwUtwVfdbFF4dXXzUOKFMpBrRdWFBG+M1OqqjryoPgOtQ6D1Yb9Aeb5tpRlHYsbCKon5Rnccf3eJdQeUw8TltPS3fTqmRCZSIq2AkUlJCj9GzVGCZDb3+3rFxsHuDtk5GpuG0MbfUfvTCjmgIm2OaKvpDkV0IWehILBFi9UJspbzDbqLCxSSGTYrYPI1puI6OJPN2iaOUyLQYxLNjZRgR2MqgwtTwYWdlJBvcS+ig62G2WSCpT1CZG+rX/Tyvi1OizJXhOKsU7PucNFLRcAxKphgN1OSmQapw2c/vzzgVZLa3WP4LF9u7J1iQW5HVYjDEdj1n4vRcvSXwgVix7EqqG36H5tNU3DsdbeZc0nZ+nyorfYmhWmscFUNRUO39zPclWFXti0W48KB+d/h/W6In3Pf17WUZPGeR+Ah/zz1Fz1qyiriNCyLbaxHLSRFqq9+Zv2pUnrvoieuUkqZ51QvwMS0BeCWEm4NBrZqL6HF+Y+HWctMstENTPbtUAbZ7EF2fagnDBqpVUCDgeVhqUDFM9cdbM6spHueKCoESrHR8wC2AtFNJyvfWuWl1972nBCYwagRKBq/nBfnOgodugca+wgpx2i17LeM881oezersRVqh7Q7h1gZqT32njCSIUqBYzkjImKrMGEwMZ0sZrNblFlmkQdLidxVy3Xew5FiN41ABIDYNYKxI7JenO4YVejydxj6HvjfuMnDEHirihaCzDHeWmJsH0ArnKBaXmxKY0+clqlKOQUISb7VjTiEwCJKnsbqnAceD2+Fw+yTu30IQZ5s0pI7HUp7OPziDh3P3/Z2D3fr/n7w/mok6Ago5zSei+zsX2nTQVbea+t8QUijpQRrczXpRxhkeaol7Mn1vcdJmDBmc5J5WYQ/PmMR8U1WX9agp4URj7fPY7F7uzwDxcmDc1w6C6cVly4VmrPdZOJKfCEXwcoTlpw8l5SUcVWWN96SUngVfvADC60ipMiyMAogL6iBHCEl06I5utPCrxfeX9VF/Oc5NhboLAO9zjxBpkHpg318JR0FkyuqHciGGSxNFLpoumFKAAMRezwQYvPDkUJsHAtAYZ62ih07Zxel7/sm0gbaUzlpKV8soNPpw1xPkDhu01IkJYBFeaMYTbwlLGiAke6/uI0IMSUp8NIIq9fheVhb52LrhVN+r7t58cEAYBIApbFSL4fSKDABAF7UCVO/XJerLt3GWE/lVRoRZHxxG60FYupHKqdfXh9LCn/2bmfL+5rkYUE8nsaBznKaE5PsgrOH3WY8cbA1uW6KRqcYrdMo1e2o7wm4bqI5jkXbSFZdufpShWcbqtiCTEhy5mCimfdsGQcxGQ5CbFJX1h++KpvNmh6FhuQYjCs7GCOfCvb3SQG07Nrezx5a5ECK6/o2reurSLcuHoEXUjZ2Ya08WQhRxfR2cLRXBkHxylzsCRTHVPlCDnEV2wLTm9/F8OLFb7HG6Ga2ynBVDgilyblf5lwbpZRULZ1fseo6MItPJsmpshjrh0BKoA6IqrZSdnI1L+I49rzPIIQEY0KmRBbsZdh0NayuXr86eGQKfKWdQUxSQQVapyVZFU7WZ8shrRMur+uFzPKmeEUF5M1mZOqzsQUTqHW4L3W2lMaiWJFstWQ+GoabGH+XQuXibwJTyiYM7Xq3y2RLmAZaKoB8f8U2dgt2WKHSX+m4Yketmp0IuBQSvmOoI56EQqW35vTw7HDYq/I8/1Vsi9M8a4ipO4w1Zzli8+wcLdhF3dPilj06lLvmop8ovmshJld2fbNeq77Skgw5hul3IMGEexs3J9NSR5nGzOOILjgGHVXuHmazyhlh2YM6cKvBsgjJ4m5cuNGZYmbwhKjAifRb5ufoyrIUPQOwUQlJacRmWHFkJXTED2W9kp0WTmCWih0BTYoMeLhty0C5h8tE9BG419PNDbB1IhSBbza5LrwTtfuLXFEgBRcUlAQAxisLNuv82FpQQEZ3u8KyG6weiB3zgtmAja9WlBeKZ+nvZ9rEjRYRJ1KlSpr0FKDx8faDF2VKioewbZOUgSNaQqtm4IOYPk1QXnYgFCCgNecGQGcL/cUQ571UQOPYlyJBrwAAlRwjOvkk5OyWr04Pa+STljM5z3uv9tDpZUbcH8pu5VakD7GmiyYDZBa7E4AFikDJrQJd5HYVFYbQH8aqkFq4lCmHuSfyMNIVUGDzERMa0yj5DHqmZkTUFjXmPhUhkKs5IE7YjCnIDJepN245ivBM9dnggBU+vFL8MKfMaQPFwPJosfZ7YgYGSQEUlk7b8mPZxJEuuV969RBCUnhOVjdeqrKsH4fHcyzAhNvyAfMlkM2lutH/4V4cr5JBtYOz80wDyCYfR5hX43xj4hD30pz815TBjcb7tfqCEzvZm5x7Q5bXZQETErPnK2iy1kilFBJcjndiD9lFZWYGFztrvSxbbdGQ/WKzHR/Xj6vIvgqvjiVRL96Z98MmgqXE65///uFdf7glzOnUNH2f48U/cMtotPQa9uSlNPGB2yRh38xV5j14rvsEoYOYoMurMQHGk0MiIrVEULPeLfuK+NjVWq5y3wOEji7/u3moMvfLtR3KW2WpLsP5oauo38x7pZ9AuFjFMHnmmbk1kWz9RBLZXqW1m4A0JqQn0yGVZmY9QGU9af/87CGTN22diOX7xlqid06VMvJFluV9H7Z5RXfwDiWK9dD3o9gG4vX6dLfZcaWGEC3Lbsr5Pm1tvfnkyc8LpMo+cMn4WAb4qycPPIVcF3dgaiRRuLaRBlfq3hiRJLnh9BlKU1Wg58+VwvDmBhaJtRaCIx7KyfmeItlYcwFd3szt4CoNStqPqHMBN4vHtn6gG4oo5bCQusLg5x2Vvc2zpmnkRbGRFzJXVOWnX/nMYDVN1jXIyxp5wDawqhR81QHdXvy1pTml6dAwOiKuAStHNwejjDiTXLnw6Mkuy7BcBLtnhy3u10thWa95+xIB3Hz9u/uxnl/0Sipm3xgmD1tDoRROkiCqlIfTDMZ0mSo5gt943SPjfK6NUGav4FvFEhCzNMqvtdxvl1m/qaDwOLmaKLW4JWpOERngKk1wTyC5LpOgJCdkKL6JW2/HZiJnjEvDRdNzOqR1jAbUNPHNL2Kvzz6j7Nn4wMpscVxPfSY5NKF21RhWQVIzjntfcBynJqVzwKtaIJ4/fcA4BhUt9XHBMApyYLq4y5s+olvm075gFFMR1RbZGgnL+sTgSE65Fgapk+DIFPVFUZyhEwCftaRuqbk3BQiMYtiDsrGshcM4mcbX50Q0IteOqswzgUdjrwLHRHBnr1jaT4+JDCLxJ/UPtoIuO1hfoFiwutt3xpg829LhorUjGNWt/ahv8tM9rnJ4y0LVKBf1EAfC4itlZ5RigkbtrIycP11QFTQ9TRdz4iYspbw6LEohxGTeTWew4ixd7cX2AYEUNZH6Q8x9CpCZMDLIFplXQ7ul0hHOP7NV2pfc/27HHs60zjLdZR7kQT+jpCwVWpDZb7eUEzYaGVvmfnc3hioDUWIpRheha5ZSwsXYSoOh/DH0USy6SXXCKYSisOFKemd98hG0shZ53lT1q/T8XJRrCjDdW4uk3um+WVZuaI0lppynusyz3eOmT1OJuZmLHc9NmffbPlcGHYhs2REerpVjgkoG1v6u8DZHDpHIPta7v+41XwKfAtx+ORuqfXBIdNkga0nAQx3qzGl+ptXk0Pu2EFu/pnXCyT/7sV+qoWKnKQxMG41h+ibWaVkihRTnGyIC/DFRDBZDGSaTIHqLoDer8k+NPTXrnN1Agkfxui5TUGcARavr7CMdBOrsziO/NpRSpbN1drouaBDa07K8O9zQVprAr82CB1b+jkfFGm1WpSGdIPqT3olLvg4lTM5WfB2G885IAV5EK0mBIUEnr6dMJC0EZOzfJLvfqCxHorSOZVkmcQjbyOPIdom4jzmn8RzJX6heLqAnBCvR8SkUGfGT968WeP7BuPbETKGmubfEyroQ6i9F8Yd+wbxpikvdqDB1nMaTYGjCXGPCuoov+usHpTir4HLvyjryNqXAbvWube7IG9ZvJawzEgftTNIqrgqW4VJllzVLqWTGF6k4bAC0LIfnb0xhBNxbdsytumCAjclhvZakenDhsIJvvla1W+8wj74FoV8V5Ur6ZT9SE5MjfRBk5HyObm0Mhga1sBQU4e2osWrirvaqvOyUMkovRw4zr5KT0SNMy0FMp9nHI/BJJK/YEmEcxKiZIy94xiXbWRAMdVYv3jnfyrCXqmVOaz6XdD8REgJmmXl4aonXimTXWtnG+2uWUqoewNjd4ESyXJIh8fD6V7225ja+GJKP0oC6+9jBhEYA8YByQirc75U0woRzDZoboPX1cvmzAgFRybDSBFeHPKBiiCEmA/OPXy3Ln9mJ0Jb7b17r/Zuuy+DwKigBD9SRvHO8GfL91e9FeBmv2CA9lHHhmPOpLNq6vXv4/szn/r7VutE8Pbl0Kn3eLgKb/YMb6ikGTOfZmZS5tADuUW7nP/nO+TJsoXt9Mo6Gq3rxkUZiXSvPfNvW93/iN33Q18dvuv7kCLwqxQnbtuj8nhCV1mqdWS6HELd9Hm9f/EVH6gpAo5fZDYSKMDgWrlPOg2q1qsjFutadeDAb5lZVA896KXLo1NaRB+gmroaDh0nYpfzqtLvpPtO+l4Kawp2doTFam+h0Pnkrzss97Rdn24P8O05+/VhlOtNe5pn8aq1eGl5wrFHFoIbW55+9bL0Uc6qNIdRYJ8EYuefVf0GPw4U0e7PCdKZeLya5169fV2dDM2sZwjgp7/EK9NKGugyuHtg5GKuDMF2EUaCx3elXF526jTS8oMHaSrtliOMRBq3dtokt8NAYrbSZKzY0zjXZUNd2if1toMKW0QAIRlzCbY459/b04fs//OH/91YrwUHw6uP73//774+YHD8JLd6Az+5Whwykwnvlvfivm8aLvaN6wGv69JRHcdsGP//5ord9sBUs387dq4//yU/dXOfr/8Cfgdd9RKTpNMybbP2dw1e5NGH6yclsR/z/+YvLwgyxTEbPy0PvuA2ffPKb3h/59f2xfBH1vq5jr397/pVv5YlFvoovsz/bLPdpLQxJJ4aTd0noWOWMOIx3XbZHwBaHsWpKIJMBC8oNhmRgZNeOSbw/+NNCLJqAI9yqYyZU1nvNEU0O4mYldyfbfZ7lTQapOvswZoOT3DDkurN8YGWFCEPx+My2fjktX6nssu/8t+sRb+bZJiv25fQb8779T0fgyd6V6YrRg8karVa3BtXt9I878/Lnm9US9OY2xky0l+FYkx5H34/Yl3/1X70uncP1qbTlQZHTXR7fxHD/T/6m6b8qmJlS9zA8jtiOwLc6y/frR9aeg2mzrMl3u59ZavlvG7h6Ho4He13mU5W3wXL5Bm02kIzLvcw3h4NB1gZBXdfxiP++gEm8+cUH/Scie2EABdOFfHubBgJb5eHPf/OXv23613Q7TL92X+6v3Xr8zUf0X3/ztz8+lpTymP9E+/Hh+3/5D3/+0Lcd28fh8YKHq2AW+JN/8z/1J37hny8/bYrgmL3iFH+LXOUyfPyTR2y/f3L96lF6nonRP333537mZzI/SYfb8tM/VAbJ434vGN0TqbrC6N/793z/p77zi98ppOF7PMEf/CLfptNPVl9ev7q+Lnl2cffd7//mfV92Cuimr6ZPvK2/8AuPo23TPzS9L6n1kAbU2hw6CdLPb3L7mGGRfD+PFst1V6Ye/LycA8IlDbtV70mD41Z8q0UXAgA=";
const SLR_WORDMARK_WHITE_B64 = "data:image/webp;base64,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";

// Icon-only (runner in circle) — used where space is tight
const HERO_SPRINTER_B64 = "data:image/webp;base64,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";
const HERO_SQUAT_B64 = "data:image/webp;base64,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";
const HERO_CURL_B64 = "data:image/webp;base64,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";
const HERO_SPRINT_W_B64 = "data:image/webp;base64,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";

function SINCLogo({ size = 48 }) {
  return <img src={SLR_ICON_B64} alt="SLR" width={size} height={size}
    style={{ display: "inline-block", objectFit: "contain" }} />;
}

// Full wordmark — runner + SLR + AI COACH. Use on dark or light background.
function Wordmark({ inverted = false, height = 48 }) {
  // On dark backgrounds (header gradients): white-text version
  // On light backgrounds (cards, light theme): navy-text version
  // Default = filled navy (white text on navy bg) — looks integrated on dark headers since app navy matches
  // inverted = white-bg version for light theme cards
  const src = inverted ? SLR_WORDMARK_WHITE_B64 : SLR_WORDMARK_NAVY_B64;
  return <img src={src} alt="SLR · AI COACH" height={height}
    style={{ height: `${height}px`, width: "auto", display: "inline-block", objectFit: "contain" }} />;
}

// ============================================================
// CALC ENGINE
// ============================================================
const GOAL_DIRECTION = { "Cut": "cut", "Bulk": "bulk", "Lean Bulk": "bulk", "Recomp": "recomp", "Maintain": "maintain" };

function weeksUntil(dateStr) {
  if (!dateStr) return 12;
  const days = Math.max(1, (new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
  return Math.max(1, Math.round(days / 7));
}

function calculateTargets({ sex, age, dob, height, weight, activity, goal, targetWeight, targetDate, targetOverrides }) {
  // Derive age from DOB if provided
  if (!age && dob) {
    const birth = new Date(dob);
    const now = new Date();
    age = now.getFullYear() - birth.getFullYear();
    if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age--;
  }
  age = age || 30;
  const w = weight || 1;
  const bmr = sex === "M" ? 10 * w + 6.25 * height - 5 * age + 5 : 10 * w + 6.25 * height - 5 * age - 161;
  const tdee = bmr * activity;
  const direction = GOAL_DIRECTION[goal];
  const wks = weeksUntil(targetDate);
  let rate = 0, label = "Standard";
  if (direction !== "maintain") {
    if (targetWeight && targetDate) {
      // Both provided — derive rate from delta
      rate = (targetWeight - w) / wks;
    } else if (targetWeight) {
      // Only target weight — use standard pace (0.5% bw/wk)
      const dir = direction === "cut" ? -1 : 1;
      rate = w * 0.005 * dir;
    } else if (targetDate) {
      // Only date — use standard pace toward goal direction
      const dir = direction === "cut" ? -1 : 1;
      rate = w * 0.005 * dir;
    } else {
      // Neither provided — slow recomp pace
      const dir = direction === "cut" ? -1 : 1;
      rate = w * 0.003 * dir;
      label = "Easy";
    }
    const cutCap = -(w * 0.01), bulkCap = w * 0.005;
    if (rate < cutCap) { rate = cutCap; label = "Capped"; }
    if (rate > bulkCap && direction === "bulk") { rate = bulkCap; label = "Capped"; }
    const pct = Math.abs(rate / w * 100);
    if (label === "Standard") label = pct < 0.3 ? "Easy" : pct < 0.7 ? "Standard" : "Aggressive";
  }
  const floor = sex === "M" ? 1500 : 1200;
  const calTarget = Math.max(floor, Math.round(tdee + (rate * 7700) / 7));
  let pPerKg, fPerKg;
  if (goal === "Cut") { pPerKg = 2.2; fPerKg = 0.8; }
  else if (goal === "Recomp") { pPerKg = 2.4; fPerKg = 0.9; }
  else if (direction === "bulk") { pPerKg = 1.8; fPerKg = 1.0; }
  else { pPerKg = 1.6; fPerKg = 0.9; }
  let protein = Math.round(w * pPerKg), fat = Math.round(w * fPerKg);
  let carbs = Math.round((calTarget - 4 * protein - 9 * fat) / 4);
  if (carbs < 100) {
    const fatFloor = Math.round(w * 0.5);
    const remForFat = calTarget - 4 * protein - 4 * 100;
    fat = Math.max(fatFloor, Math.floor(remForFat / 9));
    carbs = Math.round((calTarget - 4 * protein - 9 * fat) / 4);
    if (carbs < 50) carbs = 50;
  }
  // Baseline values from algorithm
  const baseline = { calTarget, protein, fat, carbs };
  // Apply user overrides if set. Each override is independent — set just calories
  // and macros stay calculated; set everything to take full control.
  const o = targetOverrides || {};
  const finalCalTarget = o.calTarget != null && o.calTarget > 0 ? o.calTarget : calTarget;
  const finalProtein = o.protein != null && o.protein > 0 ? o.protein : protein;
  const finalFat = o.fat != null && o.fat > 0 ? o.fat : fat;
  const finalCarbs = o.carbs != null && o.carbs > 0 ? o.carbs : carbs;
  return {
    calTarget: finalCalTarget,
    protein: finalProtein,
    fat: finalFat,
    carbs: finalCarbs,
    ratePerWeekKg: Math.round(rate * 100) / 100,
    intensityLabel: label,
    baseline, // for Settings UI to show calculated reference values
    overridden: !!(o.calTarget || o.protein || o.fat || o.carbs),
  };
}

// ============================================================
// FOOD & ALCOHOL DATABASES
// ============================================================
const FOOD_DB = [
  { kw: ["pizza", "slice"], kcal: 285, p: 12, f: 10, c: 36 },
  { kw: ["burger"], kcal: 540, p: 30, f: 28, c: 40 },
  { kw: ["chicken", "breast"], kcal: 165, p: 31, f: 4, c: 0 },
  { kw: ["chicken", "thigh"], kcal: 209, p: 26, f: 11, c: 0 },
  { kw: ["rice"], kcal: 130, p: 3, f: 0.3, c: 28 },
  { kw: ["pasta"], kcal: 158, p: 6, f: 1, c: 31 },
  { kw: ["egg"], kcal: 72, p: 6, f: 5, c: 0 },
  { kw: ["bread", "slice"], kcal: 80, p: 4, f: 1, c: 14 },
  { kw: ["banana"], kcal: 105, p: 1, f: 0, c: 27 },
  { kw: ["apple"], kcal: 95, p: 0, f: 0, c: 25 },
  { kw: ["potato"], kcal: 161, p: 4, f: 0, c: 37 },
  { kw: ["chips", "fries"], kcal: 312, p: 3, f: 15, c: 41 },
  { kw: ["salad"], kcal: 50, p: 2, f: 1, c: 8 },
  { kw: ["sandwich"], kcal: 350, p: 18, f: 12, c: 40 },
  { kw: ["yogurt", "greek"], kcal: 100, p: 17, f: 1, c: 6 },
  { kw: ["protein", "shake"], kcal: 180, p: 25, f: 3, c: 12 },
  { kw: ["oats", "porridge"], kcal: 150, p: 5, f: 3, c: 27 },
  { kw: ["beef", "mince"], kcal: 250, p: 26, f: 17, c: 0 },
  { kw: ["salmon"], kcal: 208, p: 20, f: 13, c: 0 },
  { kw: ["cheese"], kcal: 113, p: 7, f: 9, c: 1 },
  { kw: ["milk"], kcal: 150, p: 8, f: 8, c: 12 },
  { kw: ["chocolate"], kcal: 170, p: 2, f: 12, c: 13 },
  { kw: ["ice", "cream"], kcal: 207, p: 3, f: 11, c: 24 },
  { kw: ["nuts"], kcal: 164, p: 6, f: 14, c: 6 },
  { kw: ["peanut", "butter"], kcal: 188, p: 8, f: 16, c: 6 },
  { kw: ["curry"], kcal: 380, p: 28, f: 18, c: 25 },
  { kw: ["sushi", "roll"], kcal: 200, p: 9, f: 4, c: 30 },
  { kw: ["fish", "chips"], kcal: 850, p: 35, f: 42, c: 80 },
  { kw: ["full", "english"], kcal: 1100, p: 50, f: 60, c: 70 },
  { kw: ["roast"], kcal: 800, p: 45, f: 30, c: 70 },
  { kw: ["steak"], kcal: 271, p: 26, f: 18, c: 0 },
  { kw: ["tuna"], kcal: 132, p: 28, f: 1, c: 0 },
  { kw: ["bacon"], kcal: 250, p: 12, f: 22, c: 0 },
  { kw: ["sausage"], kcal: 200, p: 11, f: 17, c: 1 },
];

const ALCOHOL_DB = [
  { name: "Pint of beer (4-5%)", kcal: 200, p: 2, f: 0, c: 16 },
  { name: "Pint of lager (4%)", kcal: 180, p: 2, f: 0, c: 14 },
  { name: "Pint of stout / Guinness", kcal: 210, p: 2, f: 0, c: 18 },
  { name: "Pint of cider", kcal: 230, p: 0, f: 0, c: 25 },
  { name: "Bottle of beer (330ml)", kcal: 145, p: 1, f: 0, c: 11 },
  { name: "Glass of red wine (175ml)", kcal: 160, p: 0, f: 0, c: 4 },
  { name: "Glass of white wine (175ml)", kcal: 145, p: 0, f: 0, c: 3 },
  { name: "Bottle of wine (750ml)", kcal: 625, p: 0, f: 0, c: 14 },
  { name: "Prosecco / Champagne (125ml)", kcal: 90, p: 0, f: 0, c: 1 },
  { name: "Single spirit + mixer", kcal: 120, p: 0, f: 0, c: 12 },
  { name: "Double spirit + mixer", kcal: 200, p: 0, f: 0, c: 18 },
  { name: "Spirit shot neat (25ml)", kcal: 60, p: 0, f: 0, c: 0 },
  { name: "Cocktail (margarita / mojito)", kcal: 250, p: 0, f: 0, c: 25 },
];

function estimateMacros(text, db, isAlcohol = false) {
  if (!text || !text.trim()) return null;
  const lower = text.toLowerCase();
  const lines = lower.split(/[,\n]+|\band\b/).filter(s => s.trim());
  let total = { kcal: 0, p: 0, f: 0, c: 0, items: [] };
  for (const line of lines) {
    let qty = 1;
    const m = line.match(/^\s*(\d+(?:\.\d+)?)\s*x?\s*/);
    if (m) qty = parseFloat(m[1]);
    let best = null, bestScore = 0;
    for (const item of db) {
      const kws = isAlcohol ? item.name.toLowerCase().split(/[\s\(\)\/]+/).filter(k => k.length > 2) : item.kw;
      const score = kws.filter(k => lower.includes(k) || line.includes(k)).length;
      if (score > bestScore) { bestScore = score; best = item; }
    }
    if (best) {
      total.kcal += best.kcal * qty; total.p += best.p * qty;
      total.f += best.f * qty; total.c += best.c * qty;
      total.items.push(`${qty}× ${isAlcohol ? best.name : best.kw[0]}`);
    }
  }
  if (total.items.length === 0) return null;
  return { kcal: Math.round(total.kcal), p: Math.round(total.p), f: Math.round(total.f), c: Math.round(total.c), items: total.items };
}

// ============================================================
// SHARED COMPONENTS
// ============================================================
function NumInput({ label, value, setValue, suffix, step = 1, theme }) {
  return (
    <div className="mb-4">
      <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>{label}</label>
      <div className="flex items-center gap-1.5 w-full">
        <button onClick={() => setValue(Math.max(0, Number(value) - step))} className={`w-11 h-12 ${theme.surface} active:opacity-70 rounded-lg text-xl font-semibold ${theme.surfaceText} flex-shrink-0`}>−</button>
        <input type="number" inputMode="decimal" value={value === 0 ? "" : value} placeholder="0" onFocus={e => e.target.select()}
          onChange={e => setValue(e.target.value === "" ? 0 : Number(e.target.value))}
          className={`flex-1 min-w-0 h-12 px-2 text-center text-lg font-semibold border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg focus:outline-none placeholder:opacity-30`}
          style={{ borderColor: undefined }}
          onFocusCapture={e => e.target.style.borderColor = ORANGE}
          onBlur={e => e.target.style.borderColor = ""} />
        {suffix && <span className={`text-sm ${theme.textMuted} flex-shrink-0 px-1`}>{suffix}</span>}
        <button onClick={() => setValue(Number(value) + step)} className={`w-11 h-12 ${theme.surface} active:opacity-70 rounded-lg text-xl font-semibold ${theme.surfaceText} flex-shrink-0`}>+</button>
      </div>
    </div>
  );
}

function TextInput({ label, value, setValue, placeholder, type = "text", theme }) {
  return (
    <div className="mb-4">
      <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>{label}</label>
      <input type={type} value={value} placeholder={placeholder} onChange={e => setValue(e.target.value)}
        className={`w-full h-12 px-4 text-base font-medium border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg focus:outline-none placeholder:opacity-30`} />
    </div>
  );
}

function TextArea({ label, value, setValue, placeholder, rows = 3, theme }) {
  return (
    <div className="mb-4">
      <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>{label}</label>
      <textarea value={value} placeholder={placeholder} rows={rows} onChange={e => setValue(e.target.value)}
        className={`w-full px-4 py-3 text-base border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg focus:outline-none placeholder:opacity-30 resize-none`} />
    </div>
  );
}

function Modal({ title, children, onClose, theme }) {
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />
      {/* Sheet — anchored to bottom with absolute positioning, NOT flex.
          This avoids the iOS Safari quirk where flex items-end + max-h
          intermittently breaks inner overflow scrolling. */}
      <div
        className={`${theme.card} absolute bottom-0 left-0 right-0 mx-auto w-full max-w-md rounded-t-3xl flex flex-col overflow-hidden`}
        style={{ maxHeight: "92vh" }}
        onClick={e => e.stopPropagation()}>
        {/* Fixed header — not in scrollable area */}
        <div className="px-5 pt-4 pb-3 flex-shrink-0">
          <div className="w-10 h-1 bg-slate-300 rounded-full mx-auto mb-3" />
          <h2 className={`text-lg font-semibold ${theme.text} flex items-center gap-2`}>
            <button onClick={onClose}
              aria-label="Back"
              className={`w-8 h-8 rounded-lg ${theme.surface} ${theme.surfaceText} flex items-center justify-center text-base flex-shrink-0`}>
              ←
            </button>
            <span className="flex-1 min-w-0 truncate">{title}</span>
          </h2>
        </div>
        {/* Scrollable body */}
        <div
          className="flex-1 overflow-y-auto overscroll-contain px-5 pb-8"
          style={{ WebkitOverflowScrolling: "touch", touchAction: "pan-y", minHeight: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// DEMO SEEDER
// ============================================================
function dateNDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split("T")[0]; }
function srand(seed) { return Math.sin(seed) * 10000 - Math.floor(Math.sin(seed) * 10000); }

const PT = { id: "pt_dave", username: "coach_dave", password: "demo", role: "PT" };

const DEMO_CLIENTS = [
  { id: "u_james", username: "james", profile: { name: "James", sex: "M", age: 32, height: 198, weight: 92.5, bodyFat: 23, activity: 1.6, goal: "Cut", targetWeight: 85, steps: 10000, waterTarget: 2.5, experience: 3, daysPerWeek: 4, sessionLength: 60, split: "Upper-Lower", treat: { name: "Pint of beer", kcal: 220, emoji: "🍺", ambition: 2 }, focusAreas: ["Chest", "Arms"], rollingWindow: 7 }, ws: 95.2, we: 92.5, kc: 2200, seed: 100 },
  { id: "u_sarah", username: "sarah", profile: { name: "Sarah", sex: "F", age: 28, height: 165, weight: 62, bodyFat: 25, activity: 1.4, goal: "Recomp", targetWeight: 60, steps: 9000, waterTarget: 2.2, experience: 2, daysPerWeek: 3, sessionLength: 45, split: "Full Body", treat: { name: "Chocolate bar", kcal: 230, emoji: "🍫", ambition: 1 }, focusAreas: ["Glutes", "Core"], rollingWindow: 7 }, ws: 63.2, we: 62, kc: 1750, seed: 200 },
  { id: "u_mike", username: "mike", profile: { name: "Mike", sex: "M", age: 24, height: 180, weight: 78, bodyFat: 14, activity: 1.6, goal: "Lean Bulk", targetWeight: 84, steps: 8000, waterTarget: 3.0, experience: 4, daysPerWeek: 5, sessionLength: 75, split: "PPL", treat: { name: "Slice of pizza", kcal: 285, emoji: "🍕", ambition: 2 }, focusAreas: ["Chest", "Back"], rollingWindow: 7 }, ws: 75.8, we: 78, kc: 3100, seed: 300 },
];

DEMO_CLIENTS.forEach((c, i) => {
  const days = [56, 84, 70][i];
  const d = new Date(); d.setDate(d.getDate() + days);
  c.profile.targetDate = d.toISOString().split("T")[0];
});

// Meal templates: combinations of 2-4 items per meal that produce realistic distributions.
// Each template defines items as { name, brand, p100, c100, f100, k100 } with portions in grams.
// We pick one breakfast + one lunch + one dinner + maybe a snack each day.
const MEAL_TEMPLATES = {
  breakfasts: [
    { name: "Breakfast", items: [
      { name: "Oats (dry)", grams: 60, kcal100: 389, p100: 17, c100: 66, f100: 7 },
      { name: "Milk, whole", grams: 200, kcal100: 60, p100: 3.2, c100: 4.7, f100: 3.3 },
      { name: "Banana", grams: 120, kcal100: 89, p100: 1.1, c100: 23, f100: 0.3 },
    ]},
    { name: "Breakfast", items: [
      { name: "Egg, large", grams: 150, kcal100: 155, p100: 13, c100: 1.1, f100: 11 },
      { name: "Wholemeal bread", grams: 60, kcal100: 247, p100: 13, c100: 41, f100: 4.2 },
      { name: "Avocado", grams: 50, kcal100: 160, p100: 2, c100: 9, f100: 15 },
    ]},
    { name: "Breakfast", items: [
      { name: "Greek yoghurt 0% fat", grams: 200, kcal100: 59, p100: 10, c100: 4, f100: 0 },
      { name: "Blueberries", grams: 100, kcal100: 57, p100: 0.7, c100: 14, f100: 0.3 },
      { name: "Almonds", grams: 20, kcal100: 579, p100: 21, c100: 22, f100: 50 },
    ]},
    { name: "Breakfast", items: [
      { name: "Whey protein", grams: 30, kcal100: 380, p100: 80, c100: 7, f100: 5 },
      { name: "Banana", grams: 100, kcal100: 89, p100: 1.1, c100: 23, f100: 0.3 },
      { name: "Peanut butter", grams: 20, kcal100: 588, p100: 25, c100: 20, f100: 50 },
      { name: "Oats (dry)", grams: 50, kcal100: 389, p100: 17, c100: 66, f100: 7 },
    ]},
  ],
  lunches: [
    { name: "Lunch", items: [
      { name: "Chicken breast", grams: 180, kcal100: 165, p100: 31, c100: 0, f100: 3.6 },
      { name: "White rice (cooked)", grams: 200, kcal100: 130, p100: 2.7, c100: 28, f100: 0.3 },
      { name: "Broccoli (steamed)", grams: 150, kcal100: 35, p100: 2.4, c100: 7.2, f100: 0.4 },
    ]},
    { name: "Lunch", items: [
      { name: "Tuna in spring water", grams: 120, kcal100: 116, p100: 26, c100: 0, f100: 1 },
      { name: "Wholemeal bread", grams: 80, kcal100: 247, p100: 13, c100: 41, f100: 4.2 },
      { name: "Cheddar cheese", grams: 30, kcal100: 402, p100: 25, c100: 1.3, f100: 33 },
      { name: "Tomato", grams: 80, kcal100: 18, p100: 0.9, c100: 3.9, f100: 0.2 },
    ]},
    { name: "Lunch", items: [
      { name: "Salmon fillet", grams: 150, kcal100: 208, p100: 20, c100: 0, f100: 13 },
      { name: "Sweet potato (baked)", grams: 200, kcal100: 90, p100: 2, c100: 21, f100: 0.2 },
      { name: "Spinach", grams: 100, kcal100: 23, p100: 2.9, c100: 3.6, f100: 0.4 },
    ]},
    { name: "Lunch", items: [
      { name: "Beef mince 5% fat", grams: 150, kcal100: 137, p100: 21, c100: 0, f100: 5 },
      { name: "Pasta (cooked)", grams: 200, kcal100: 131, p100: 5, c100: 25, f100: 1.1 },
      { name: "Tomato", grams: 100, kcal100: 18, p100: 0.9, c100: 3.9, f100: 0.2 },
    ]},
  ],
  dinners: [
    { name: "Dinner", items: [
      { name: "Chicken thigh (skinless)", grams: 200, kcal100: 209, p100: 26, c100: 0, f100: 11 },
      { name: "Brown rice (cooked)", grams: 180, kcal100: 111, p100: 2.6, c100: 23, f100: 0.9 },
      { name: "Bell pepper", grams: 100, kcal100: 31, p100: 1, c100: 6, f100: 0.3 },
      { name: "Olive oil", grams: 8, kcal100: 884, p100: 0, c100: 0, f100: 100 },
    ]},
    { name: "Dinner", items: [
      { name: "Cod fillet", grams: 200, kcal100: 82, p100: 18, c100: 0, f100: 0.7 },
      { name: "Potato (boiled)", grams: 250, kcal100: 87, p100: 1.9, c100: 20, f100: 0.1 },
      { name: "Broccoli (steamed)", grams: 150, kcal100: 35, p100: 2.4, c100: 7.2, f100: 0.4 },
      { name: "Butter", grams: 10, kcal100: 717, p100: 0.9, c100: 0.1, f100: 81 },
    ]},
    { name: "Dinner", items: [
      { name: "Beef mince 5% fat", grams: 180, kcal100: 137, p100: 21, c100: 0, f100: 5 },
      { name: "Quinoa (cooked)", grams: 200, kcal100: 120, p100: 4.4, c100: 21, f100: 1.9 },
      { name: "Kale", grams: 100, kcal100: 49, p100: 4.3, c100: 9, f100: 0.9 },
    ]},
    { name: "Dinner", items: [
      { name: "Tofu (firm)", grams: 200, kcal100: 144, p100: 17, c100: 2.8, f100: 8.7 },
      { name: "Brown rice (cooked)", grams: 200, kcal100: 111, p100: 2.6, c100: 23, f100: 0.9 },
      { name: "Carrot", grams: 100, kcal100: 41, p100: 0.9, c100: 10, f100: 0.2 },
      { name: "Cashews", grams: 20, kcal100: 553, p100: 18, c100: 30, f100: 44 },
    ]},
  ],
  snacks: [
    { name: "Snack", items: [
      { name: "Cottage cheese", grams: 150, kcal100: 98, p100: 11, c100: 3.4, f100: 4.3 },
      { name: "Apple", grams: 150, kcal100: 52, p100: 0.3, c100: 14, f100: 0.2 },
    ]},
    { name: "Snack", items: [
      { name: "Whey protein", grams: 30, kcal100: 380, p100: 80, c100: 7, f100: 5 },
    ]},
    { name: "Snack", items: [
      { name: "Greek yoghurt 0% fat", grams: 150, kcal100: 59, p100: 10, c100: 4, f100: 0 },
      { name: "Strawberries", grams: 80, kcal100: 32, p100: 0.7, c100: 7.7, f100: 0.3 },
    ]},
    { name: "Snack", items: [
      { name: "Almonds", grams: 30, kcal100: 579, p100: 21, c100: 22, f100: 50 },
    ]},
  ],
};

// Build realistic meals for a day, scaling portions to match the target daily totals.
function generateMealsForDay(targetKcal, seed) {
  const r = (n) => srand(seed + n) - Math.floor(srand(seed + n));
  const pick = (arr, n) => arr[Math.floor(r(n) * arr.length) % arr.length];

  const breakfast = pick(MEAL_TEMPLATES.breakfasts, 1);
  const lunch = pick(MEAL_TEMPLATES.lunches, 2);
  const dinner = pick(MEAL_TEMPLATES.dinners, 3);
  const snacks = targetKcal > 2400 ? [pick(MEAL_TEMPLATES.snacks, 4), pick(MEAL_TEMPLATES.snacks, 5)] :
                 targetKcal > 1800 ? [pick(MEAL_TEMPLATES.snacks, 4)] : [];

  // Compute raw totals
  const rawMeals = [breakfast, lunch, dinner, ...snacks];
  const expandedMeals = rawMeals.map(template => ({
    name: template.name,
    items: template.items.map(item => {
      const factor = item.grams / 100;
      return {
        food: item.name,
        brand: "Generic",
        grams: item.grams,
        kcal: Math.round(item.kcal100 * factor),
        protein: +(item.p100 * factor).toFixed(1),
        carbs: +(item.c100 * factor).toFixed(1),
        fat: +(item.f100 * factor).toFixed(1),
      };
    }),
  }));

  const rawTotal = expandedMeals.flatMap(m => m.items).reduce((s, i) => s + i.kcal, 0);
  // Scale portions so totals roughly match target (within ±100 kcal)
  const scale = rawTotal > 0 ? targetKcal / rawTotal : 1;

  const scaledMeals = expandedMeals.map(m => ({
    name: m.name,
    items: m.items.map(item => {
      const newGrams = Math.round(item.grams * scale);
      const factor = newGrams / item.grams;
      return {
        ...item,
        grams: newGrams,
        kcal: Math.round(item.kcal * factor),
        protein: +(item.protein * factor).toFixed(1),
        carbs: +(item.carbs * factor).toFixed(1),
        fat: +(item.fat * factor).toFixed(1),
      };
    }),
  }));

  // Flatten to the meals array shape used in storage
  const flatMeals = [];
  for (const meal of scaledMeals) {
    for (const item of meal.items) {
      flatMeals.push({
        name: meal.name,
        food: item.food,
        brand: item.brand,
        grams: item.grams,
        kcal: item.kcal,
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
      });
    }
  }
  return flatMeals;
}

function buildLogs(c) {
  const t = calculateTargets(c.profile);
  const total = c.we - c.ws;
  const logs = {};
  for (let dayBack = 41; dayBack >= 0; dayBack--) {
    const date = dateNDaysAgo(dayBack);
    const progress = (41 - dayBack) / 41;
    const baseWeight = c.ws + total * progress;
    const noise = (srand(c.seed + dayBack) - 0.5) * 0.6;
    const weight = Math.round((baseWeight + noise) * 10) / 10;
    const r = srand(c.seed + dayBack * 7);
    if (r < 0.1) { logs[date] = { food: false, kcalEaten: 0, proteinEaten: 0, fatEaten: 0, carbsEaten: 0, weight: false, weightValue: 0, meals: [] }; continue; }
    const kcal = c.kc + Math.round((srand(c.seed + dayBack * 11) - 0.5) * 400);
    // Generate meal breakdown for this day
    const meals = generateMealsForDay(kcal, c.seed + dayBack);
    // Recompute totals from the actual meals so they're internally consistent
    const totalKcal = meals.reduce((s, m) => s + m.kcal, 0);
    const totalProtein = +meals.reduce((s, m) => s + m.protein, 0).toFixed(1);
    const totalCarbs = +meals.reduce((s, m) => s + m.carbs, 0).toFixed(1);
    const totalFat = +meals.reduce((s, m) => s + m.fat, 0).toFixed(1);
    logs[date] = {
      food: true,
      kcalEaten: totalKcal,
      proteinEaten: totalProtein,
      fatEaten: totalFat,
      carbsEaten: totalCarbs,
      meals,
      steps: true,
      stepsTaken: 8000 + Math.floor(srand(c.seed + dayBack * 19) * 4000),
      weight: true,
      weightValue: weight,
      workout: dayBack % 2 === 0,
    };
  }
  return logs;
}

// ============================================================
// LIFT HISTORY SEEDING — designed to trigger every suggestion type
// ============================================================
function buildTestLifts() {
  const lifts = {};
  const today = new Date();
  const dateAt = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString().split("T")[0]; };

  const sessions = (count, fn) => {
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
      const date = dateAt(i * 4 + 1);
      out.push({ date, sets: fn(count - 1 - i) });
    }
    return out;
  };

  // SCENARIO 1: increase_weight — Bench, top of 6-8 with RIR 1+
  lifts["Barbell Bench Press"] = {
    history: sessions(7, (idx) => [
      { weight: 75 + idx * 2.5, reps: 8, rir: 1 },
      { weight: 75 + idx * 2.5, reps: 8, rir: 1 },
      { weight: 75 + idx * 2.5, reps: 8, rir: 2 },
    ]),
  };

  // SCENARIO 2: increase_reps — Lat Pulldown, in 8-10 range with RIR 2+
  lifts["Lat Pulldown"] = {
    history: sessions(6, (idx) => [
      { weight: 60 + idx * 1.25, reps: 9, rir: 2 },
      { weight: 60 + idx * 1.25, reps: 8, rir: 3 },
    ]),
  };

  // SCENARIO 3: decrease_weight — OHP, last 2 sessions show first set < 6 reps with RIR 0
  lifts["Overhead Press"] = {
    history: [
      ...sessions(5, (idx) => [
        { weight: 50 + idx * 1, reps: 7, rir: 1 },
        { weight: 50 + idx * 1, reps: 6, rir: 1 },
      ]),
      { date: dateAt(5), sets: [{ weight: 60, reps: 5, rir: 0 }, { weight: 60, reps: 4, rir: 0 }] },
      { date: dateAt(1), sets: [{ weight: 60, reps: 5, rir: 0 }, { weight: 60, reps: 3, rir: 0 }] },
    ],
  };

  // SCENARIO 4: tune_weight (sweet spot) — Tricep Pushdown
  // First set holds (10 reps in 10-12 range), but last set crashes to 6 reps (far below 10).
  // Engine should suggest dropping weight slightly to gain more total reps.
  lifts["Tricep Pushdown"] = {
    history: [
      ...sessions(4, (idx) => [
        { weight: 25 + idx * 0.5, reps: 11, rir: 1 },
        { weight: 25 + idx * 0.5, reps: 10, rir: 1 },
        { weight: 25 + idx * 0.5, reps: 8, rir: 0 },
      ]),
      { date: dateAt(9), sets: [{ weight: 27.5, reps: 11, rir: 1 }, { weight: 27.5, reps: 9, rir: 0 }, { weight: 27.5, reps: 7, rir: 0 }] },
      { date: dateAt(5), sets: [{ weight: 27.5, reps: 10, rir: 1 }, { weight: 27.5, reps: 9, rir: 0 }, { weight: 27.5, reps: 6, rir: 0 }] },
      { date: dateAt(1), sets: [{ weight: 27.5, reps: 10, rir: 1 }, { weight: 27.5, reps: 8, rir: 0 }, { weight: 27.5, reps: 6, rir: 0 }] },
    ],
  };

  // SCENARIO 5: stalled — Hamstring Curl, 4+ weeks no growth
  lifts["Hamstring Curl"] = {
    history: sessions(8, () => [
      { weight: 35, reps: 11, rir: 1 },
      { weight: 35, reps: 10, rir: 0 },
    ]),
  };

  // SCENARIO 6: growing — Squat, healthy progression, no suggestion
  lifts["Barbell Squat"] = {
    history: sessions(7, (idx) => [
      { weight: 100 + idx * 5, reps: 7, rir: 1 },
      { weight: 100 + idx * 5, reps: 6, rir: 1 },
      { weight: 100 + idx * 5, reps: 6, rir: 0 },
    ]),
  };

  // SCENARIO 7: high fatigue — Leg Press, RIR drops sharply
  lifts["Leg Press"] = {
    history: sessions(6, (idx) => [
      { weight: 140 + idx * 5, reps: 12, rir: 3 },
      { weight: 140 + idx * 5, reps: 10, rir: 1 },
      { weight: 140 + idx * 5, reps: 7, rir: 0 },
    ]),
  };

  // SCENARIO 8: another stalled — Barbell Row
  lifts["Barbell Row"] = {
    history: sessions(7, (idx) => [
      { weight: 70 + idx * 0.3, reps: 8, rir: 1 },
      { weight: 70 + idx * 0.3, reps: 7, rir: 1 },
      { weight: 70 + idx * 0.3, reps: 6, rir: 0 },
    ]),
  };

  // SCENARIO 9: growing — RDL
  lifts["Romanian Deadlift"] = {
    history: sessions(6, (idx) => [
      { weight: 90 + idx * 4, reps: 7, rir: 1 },
      { weight: 90 + idx * 4, reps: 7, rir: 1 },
    ]),
  };

  // Stamp lastSession + lastDate on each
  for (const ex of Object.values(lifts)) {
    const last = ex.history[ex.history.length - 1];
    ex.lastSession = last.sets;
    ex.lastDate = last.date;
  }

  return lifts;
}

function buildSessionCompletions(daysPerWeek, splitName) {
  const sessionNames = {
    "Upper-Lower": ["Upper A", "Lower A", "Upper B", "Lower B"],
    "Full Body": ["Full Body A", "Full Body B", "Full Body C"],
    "PPL": ["Push", "Pull", "Legs"],
    "Bro Split": ["Chest", "Back", "Legs", "Shoulders", "Arms"],
  };
  const names = sessionNames[splitName] || sessionNames["Upper-Lower"];
  const completions = {};
  const cadence = Math.max(1, Math.floor(7 / Math.max(1, daysPerWeek)));
  let nameIdx = 0;
  for (let i = 28; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = d.toISOString().split("T")[0];
    if (i % cadence === 0 && i > 0) {
      completions[ds] = [names[nameIdx % names.length]];
      nameIdx++;
    }
  }
  return completions;
}

async function seedDemo(setStatus) {
  if (setStatus) setStatus("Ready");
  return true;
}

async function findAccount(u) {
  return null;
}
async function getAllAccounts() {
  return {};
}

// ============================================================
// BLOCK HELPERS — shared with Artifact 2 via storage
// ============================================================
async function ensureCurrentBlock(userId, profile) {
  // Ensures there is at least one open block for this user.
  // If none exists, creates one starting from the earliest log entry
  // (or today if no logs) so historical data still sits inside a block.
  const blocks = (await storage.get(userKey(userId, "blocks"))) || [];
  const hasOpenBlock = blocks.some(b => !b.endDate);
  if (hasOpenBlock) return blocks;

  const targets = calculateTargets(profile);
  // Find earliest log entry for the start date
  const logs = (await storage.get(userKey(userId, "logs"))) || {};
  const dates = Object.keys(logs).sort();
  const startDate = dates[0] || new Date().toISOString().split("T")[0];

  blocks.push({
    id: `block_${Date.now()}`,
    startDate,
    endDate: null,
    phase: profile.goal,
    calTarget: targets.calTarget,
    protein: targets.protein,
    fat: targets.fat,
    carbs: targets.carbs,
    plannedWeeks: 4,
    split: profile.split,
    daysPerWeek: profile.daysPerWeek,
    targetWeight: profile.targetWeight,
  });
  await storage.set(userKey(userId, "blocks"), blocks);
  return blocks;
}

function getBlockForDate(blocks, dateStr) {
  if (!blocks || blocks.length === 0) return null;
  // Block matches if startDate <= date AND (endDate is null OR endDate > date)
  return blocks.find(b => b.startDate <= dateStr && (!b.endDate || b.endDate > dateStr)) || null;
}

function getCurrentBlock(blocks) {
  if (!blocks || blocks.length === 0) return null;
  return blocks.find(b => !b.endDate) || blocks[blocks.length - 1];
}

function getBlockNumber(blocks, blockId) {
  if (!blocks) return 1;
  const sorted = [...blocks].sort((a, b) => a.startDate.localeCompare(b.startDate));
  return sorted.findIndex(b => b.id === blockId) + 1;
}

// ============================================================
// TREAT BANKING — evaluate week-end checks, distribute deductions
// ============================================================
// ISO week key (Monday start)
function getISOWeekKey(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  // Find Monday of this week
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split("T")[0];
}

function getISOWeekDays(weekKey) {
  const monday = new Date(weekKey);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday); d.setDate(d.getDate() + i);
    return d.toISOString().split("T")[0];
  });
}

// ============================================================
// CUSTOM TASKS — user-defined daily items beyond the built-in checklist
// ============================================================

// Day-of-week mapping: JS getDay returns 0=Sun, 1=Mon ... 6=Sat
// We use 1=Mon ... 7=Sun internally for nicer display ordering
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function dowFromDate(date) {
  const d = new Date(date).getDay();
  return d === 0 ? 7 : d; // map Sunday from 0 to 7
}

// Determine if a custom task is active on a given date based on its schedule.
function taskIsActiveOn(task, dateStr, activeBlockEndDate) {
  if (task.archived) return false;
  // Created-after-date check
  if (task.createdAt && dateStr < task.createdAt) return false;
  // End-date check
  const s = task.schedule || {};
  if (s.endKind === "date" && s.endDate && dateStr > s.endDate) return false;
  if (s.endKind === "block" && activeBlockEndDate && dateStr > activeBlockEndDate) return false;
  // Day-of-week check
  if (s.kind === "custom-days") {
    const dow = dowFromDate(dateStr);
    if (!s.days || !s.days.includes(dow)) return false;
  }
  // weekly: just once per week — we don't enforce on a specific day, user picks any day
  // daily and weekly both pass through
  return true;
}

// For a given task and date, return the response object (or null if none).
// Responses can be: bool (tick), {value: number}, {value: string}
function getTaskResponse(responses, dateStr, taskId) {
  return responses?.[dateStr]?.[taskId] ?? null;
}

// Is a task considered "complete" for a date based on its type & response?
function taskIsComplete(task, response) {
  if (response == null || response === false) return false;
  if (task.type === "tick") return response === true;
  if (task.type === "number") {
    const v = typeof response === "object" ? response.value : response;
    if (v == null) return false;
    // If target set, complete when v >= target. Otherwise any value counts.
    if (task.target > 0) return v >= task.target;
    return v > 0;
  }
  if (task.type === "text") {
    const v = typeof response === "object" ? response.value : response;
    return v != null && String(v).trim().length > 0;
  }
  return false;
}

function genTaskId() {
  return "t_" + Math.random().toString(36).slice(2, 10);
}

// Returns { bank, changed }. Evaluates *completed* past weeks against the given treat.
// `treat` is the treat config to evaluate. Pass profile.treat or profile.secondaryTreat.
function evaluateTreatWeek(currentBank, logs, profile, treat) {
  // Back-compat: older callers passed (bank, logs, profile) and used profile.treat.
  // Allow that by defaulting treat to profile.treat.
  const t = treat || profile.treat;
  if (!t) return { bank: currentBank, changed: false };
  const today = new Date();
  const todayWeek = getISOWeekKey(today);
  const lastEvaluated = currentBank.lastEvaluated || "";
  let bank = { ...currentBank };
  let changed = false;

  // Look back up to 12 weeks
  for (let w = 11; w >= 1; w--) {
    const weekDate = new Date(today); weekDate.setDate(weekDate.getDate() - w * 7);
    const weekKey = getISOWeekKey(weekDate);
    if (weekKey === todayWeek) continue; // current week not done yet
    if (weekKey <= lastEvaluated) continue; // already checked

    const days = getISOWeekDays(weekKey);
    const dailyDeduction = Math.round((t.kcal * t.ambition) / 7);

    const loggedDays = days.filter(ds => logs[ds]?.food && logs[ds]?.kcalEaten);
    if (loggedDays.length < 5) continue;

    const baseDailyTarget = (() => {
      try { return calculateTargets(profile).calTarget; } catch { return 2000; }
    })();
    // For secondary treat, the effective target subtracts BOTH treats' deductions.
    // We pass that in via treat.combinedDeduction if set; otherwise just this treat.
    const totalDeduction = t.combinedDeduction != null ? t.combinedDeduction : dailyDeduction;
    const effectiveTarget = baseDailyTarget - totalDeduction;

    const allUnder = loggedDays.every(ds => (logs[ds]?.kcalEaten || 0) <= effectiveTarget);
    if (allUnder) {
      bank.count = (bank.count || 0) + t.ambition;
      bank.lastWonWeek = weekKey;
    }
    bank.lastEvaluated = weekKey;
    changed = true;
  }

  return { bank, changed };
}

// ============================================================
// MAIN APP
// ============================================================
export default function SINCApp() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const themeCtx = useTheme();

    useEffect(() => {
    let cancelled = false;
    // Boot timeout: never get stuck on the loading screen
    const bootTimeout = setTimeout(() => {
      if (!cancelled) setBooting(false);
    }, 5000);
    (async () => {
      try {
        const { data: { session: supaSession } } = await supabase.auth.getSession();
        if (cancelled) return;
        if (supaSession?.user) {
          await loadSession(supaSession);
        }
      } catch (e) {
        console.error("getSession failed", e);
      }
      clearTimeout(bootTimeout);
      if (!cancelled) setBooting(false);
    })();
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, supaSession) => {
      if (cancelled) return;
      if (supaSession?.user) {
        await loadSession(supaSession);
      } else {
        setSession(null);
        setProfile(null);
      }
    });
    return () => { cancelled = true; clearTimeout(bootTimeout); subscription.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSession(supaSession) {
    const u = supaSession.user;
    const { data: profileRow } = await supabase
      .from("profiles")
      .select("data")
      .eq("user_id", u.id)
      .maybeSingle();
    const profileData = profileRow?.data || {};
    const username = profileData.username || u.email?.split("@")[0] || "user";
    const role = profileData.role || "user";
    setSession({ id: u.id, username, role });
    setProfile(profileData);
  }

  if (booting) {
    const isLight = !themeCtx.theme.bg.includes("950");
    return (
      <div className={`min-h-screen ${themeCtx.theme.bg} flex items-center justify-center px-5`}>
        <div className="text-center">
          <Wordmark height={64} inverted={isLight} />
          <div className={`mt-6 text-sm ${themeCtx.theme.textMuted}`}>Loading...</div>
          <div className="mt-3 w-8 h-8 border-3 border-slate-200 rounded-full animate-spin mx-auto" style={{ borderTopColor: ORANGE }} />
        </div>
      </div>
    );
  }

  if (!session) return <Auth themeCtx={themeCtx} />;

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("signOut failed", e);
    }
    setSession(null);
    setProfile(null);
    // Force a clean reload so any cached state is wiped.
    window.location.reload();
  };

  if (session.role === "PT") return <PTApp session={session} themeCtx={themeCtx} onLogout={handleLogout} />;
  return <UserApp session={session} themeCtx={themeCtx} onLogout={handleLogout} />;
}

// ============================================================
// AUTH — Supabase email + password
// ============================================================
function Auth({ themeCtx }) {
  const { theme, dark, toggle } = themeCtx;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [username, setUsername] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState("login");
  const [role, setRole] = useState("user");

      const tryLogin = async () => {
    setErr(""); setLoading(true);
    try {
      // Raw fetch — supabase-js hangs intermittently on iOS Safari
      const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await r.json();
      console.log("[tryLogin] status", r.status, "hasToken", !!data?.access_token);
      if (!r.ok) {
        setErr(data?.error_description || data?.msg || data?.error || "Login failed");
        setLoading(false);
        return;
      }
      // Store the session in the same localStorage shape Supabase uses,
      // so the next page load picks it up automatically.
      const projectRef = "vtvfnlvphdobrkcvkage";
      const storageKey = `sb-${projectRef}-auth-token`;
      localStorage.setItem(storageKey, JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        token_type: "bearer",
        user: data.user,
      }));
      // Reload — boot flow finds the session and routes you in
      window.location.href = window.location.pathname;
    } catch (e) {
      console.error("[tryLogin] threw", e);
      setErr(e.message || String(e));
      setLoading(false);
    }
  };

      const trySignup = async () => {
    setErr("");
    if (!email.includes("@")) { setErr("Enter a valid email"); return; }
    if (password.length < 6) { setErr("Password must be 6+ characters"); return; }
    if (password !== password2) { setErr("Passwords don't match"); return; }
    if (!username.trim() || username.length < 3) { setErr("Username must be 3+ characters"); return; }
    setLoading(true);
    try {
      // Step 1: create account via raw fetch
      const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          email: email.trim(),
          password,
          data: { username: username.toLowerCase(), role },
        }),
      });
      const data = await r.json();
      console.log("[trySignup] status", r.status, "hasUser", !!data?.user);
      if (!r.ok) {
        setErr(data?.error_description || data?.msg || data?.error || "Signup failed");
        setLoading(false);
        return;
      }
      // Step 2: store the session so the next page load picks it up
      if (data.access_token) {
        const projectRef = "vtvfnlvphdobrkcvkage";
        const storageKey = `sb-${projectRef}-auth-token`;
        localStorage.setItem(storageKey, JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_in: data.expires_in,
          expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
          token_type: "bearer",
          user: data.user,
        }));
      }
      // Step 3: write the profile row directly via raw fetch (using the new token)
      if (data.user?.id && data.access_token) {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles?on_conflict=user_id`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": "Bearer " + data.access_token,
            "Prefer": "resolution=merge-duplicates",
          },
          body: JSON.stringify({
            user_id: data.user.id,
            data: { username: username.toLowerCase(), role, createdAt: new Date().toISOString() },
          }),
        }).catch(e => console.warn("profile upsert failed", e));
      }
      // Step 4: reload — boot flow will find the session and route into the app
      window.location.href = window.location.pathname;
    } catch (e) {
      console.error("[trySignup] threw", e);
      setErr(e.message || String(e));
      setLoading(false);
    }
  };

  return (
    <div className={`min-h-screen ${theme.bg}`}>
      <div className="max-w-md mx-auto">
        <div className="relative overflow-hidden text-white" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
          <div className="absolute inset-0" style={{
            backgroundImage: `url(${HERO_SPRINTER_B64})`,
            backgroundSize: "cover",
            backgroundPosition: "center right",
            opacity: 0.45,
            mixBlendMode: "luminosity",
          }} />
          <div className="absolute inset-0" style={{
            background: `linear-gradient(180deg, ${theme.headerStart}99 0%, ${theme.headerStart}cc 60%, ${theme.headerEnd} 100%)`,
          }} />
          <div className="relative px-5 pt-16 pb-12">
            <div className="flex justify-center mb-3"><Wordmark height={88} /></div>
            <p className="text-center text-sm text-white/80">Train smart. Eat right. Recover.</p>
          </div>
        </div>
        <div className="px-5 -mt-6 relative z-10">
          <div className={`${theme.card} rounded-2xl ${theme.border} border shadow-xl p-5`}>
            <div className="flex gap-2 mb-4">
              <button onClick={() => setMode("login")} className={`flex-1 py-2 rounded-lg text-sm font-bold ${mode === "login" ? "" : theme.textMuted}`}
                style={mode === "login" ? { background: ORANGE, color: "white" } : { background: "transparent" }}>Log in</button>
              <button onClick={() => setMode("signup")} className={`flex-1 py-2 rounded-lg text-sm font-bold ${mode === "signup" ? "" : theme.textMuted}`}
                style={mode === "signup" ? { background: ORANGE, color: "white" } : { background: "transparent" }}>Sign up</button>
            </div>
            <div className="space-y-3">
              <TextInput label="Email" value={email} setValue={setEmail} placeholder="you@example.com" type="email" theme={theme} />
              <TextInput label="Password" value={password} setValue={setPassword} placeholder="6+ characters" type="password" theme={theme} />
              {mode === "signup" && (
                <>
                  <TextInput label="Confirm password" value={password2} setValue={setPassword2} placeholder="Repeat password" type="password" theme={theme} />
                  <TextInput label="Username" value={username} setValue={setUsername} placeholder="e.g. james" theme={theme} />
                  <div>
                    <div className={`text-xs font-bold mb-2 ${theme.textMuted}`}>I AM A</div>
                    <div className="flex gap-2">
                      <button onClick={() => setRole("user")} className={`flex-1 py-2 rounded-lg text-sm font-bold`}
                        style={role === "user" ? { background: ORANGE, color: "white" } : { background: "transparent", border: `1px solid ${theme.borderColor || "#cbd5e1"}` }}>Client</button>
                      <button onClick={() => setRole("PT")} className={`flex-1 py-2 rounded-lg text-sm font-bold`}
                        style={role === "PT" ? { background: ORANGE, color: "white" } : { background: "transparent", border: `1px solid ${theme.borderColor || "#cbd5e1"}` }}>Trainer</button>
                    </div>
                  </div>
                </>
              )}
              {err && <div className="text-sm" style={{ color: STATUS_BAD }}>{err}</div>}
              <button
                onClick={mode === "login" ? tryLogin : trySignup}
                disabled={loading}
                className="w-full py-3 rounded-lg font-bold text-white"
                style={{ background: ORANGE, opacity: loading ? 0.6 : 1 }}>
                {loading ? "Please wait..." : (mode === "login" ? "Log in" : "Create account")}
              </button>
            </div>
          </div>
          <div className="text-center mt-6 pb-8">
            <button onClick={toggle} className={`text-xs ${theme.textMuted}`}>
              {dark ? "☀️ Light mode" : "🌙 Dark mode"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ============================================================
// ONBOARDING
// ============================================================
function Onboarding({ themeCtx, onComplete }) {
  const { theme } = themeCtx;
  const [step, setStep] = useState(0);
  const defaultDate = new Date(); defaultDate.setDate(defaultDate.getDate() + 84);
  const defaultDOB = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 30); return d.toISOString().split("T")[0]; })();
  const [d, setD] = useState({
    name: "", sex: "M", dob: defaultDOB, height: 198, weight: 92.5, bodyFat: 23,
    activity: 1.6, goal: "Cut", targetWeight: 85, targetDate: defaultDate.toISOString().split("T")[0],
    steps: 10000, waterTarget: 2.5, daysPerWeek: 4, sessionLength: 60, split: "Upper-Lower", equipment: "Commercial gym", experience: 3,
    focusAreas: [],
    treat: null, // { name, kcal, ambition }
    rollingWindow: 7,
  });
  const total = 6;
  const u = (k, v) => setD(p => ({ ...p, [k]: v }));
  const next = () => step < total - 1 ? setStep(step + 1) : onComplete(d);

  return (
    <div className={`min-h-screen ${theme.bg} pb-32`}>
      <div className="max-w-md mx-auto">
        <div className="px-5 pt-10 pb-6 text-white" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
          <Wordmark />
          <h1 className="text-xl font-bold mt-3">Set up your plan</h1>
          <p className="text-blue-100 text-xs mt-1">Step {step + 1} of {total}</p>
          <div className="mt-3 bg-blue-800/40 h-1.5 rounded-full overflow-hidden">
            <div className="h-full transition-all" style={{ width: `${((step + 1) / total) * 100}%`, backgroundColor: ORANGE }} />
          </div>
        </div>
        <div className="px-4 mt-4">
          {step === 0 && (
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
              <h2 className={`text-xl font-semibold mb-1 ${theme.text}`}>Welcome</h2>
              <p className={`text-sm ${theme.textMuted} mb-4`}>What should we call you?</p>
              <TextInput label="First name" value={d.name} setValue={v => u("name", v)} theme={theme} placeholder="e.g. James" />
              <h3 className={`text-base font-semibold mt-4 mb-3 ${theme.text}`}>Your stats</h3>
              <div className="mb-4">
                <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Sex</label>
                <div className="grid grid-cols-2 gap-2">
                  {[{ l: "Male", v: "M" }, { l: "Female", v: "F" }].map(o => (
                    <button key={o.v} onClick={() => u("sex", o.v)} className="h-12 rounded-lg font-medium"
                      style={{ backgroundColor: d.sex === o.v ? NAVY : "", color: d.sex === o.v ? "white" : "" }}>
                      <div className={d.sex === o.v ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{o.l}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="mb-4">
                <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Date of birth</label>
                <input type="date" value={d.dob} max={new Date().toISOString().split("T")[0]} onChange={e => u("dob", e.target.value)}
                  className={`w-full h-12 px-4 text-base font-medium border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg`} />
              </div>
              <NumInput label="Height" value={d.height} setValue={v => u("height", v)} suffix="cm" theme={theme} />
              <NumInput label="Weight" value={d.weight} setValue={v => u("weight", v)} suffix="kg" step={0.1} theme={theme} />
              {/* BMI display + auto-calculated body fat estimate */}
              {d.height > 0 && d.weight > 0 && (() => {
                const bmi = d.weight / Math.pow(d.height / 100, 2);
                // Deurenberg formula
                const ageNow = (() => { if (!d.dob) return 30; const b = new Date(d.dob); const n = new Date(); let a = n.getFullYear() - b.getFullYear(); if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--; return a; })();
                const estBF = 1.20 * bmi + 0.23 * ageNow - 10.8 * (d.sex === "M" ? 1 : 0) - 5.4;
                const bmiCat = bmi < 18.5 ? "Underweight" : bmi < 25 ? "Healthy" : bmi < 30 ? "Overweight" : "Obese";
                const bmiColor = bmi < 18.5 ? "#3b82f6" : bmi < 25 ? "#10b981" : bmi < 30 ? "#f59e0b" : "#ef4444";
                return (
                  <div className={`${theme.surface} rounded-lg p-3 mb-4 text-sm`}>
                    <div className="flex justify-between items-center mb-1">
                      <span className={theme.textMuted}>BMI</span>
                      <span className="font-bold" style={{ color: bmiColor }}>{bmi.toFixed(1)} · {bmiCat}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className={theme.textMuted}>Estimated body fat</span>
                      <button onClick={() => u("bodyFat", Math.round(estBF))} className="text-xs font-bold px-2 py-1 rounded" style={{ backgroundColor: ORANGE, color: "white" }}>Use {Math.round(estBF)}%</button>
                    </div>
                    <p className={`text-[10px] ${theme.textMuted} mt-1.5 italic`}>Estimate from BMI — tap "Use" to apply, or override below.</p>
                  </div>
                );
              })()}
              <NumInput label="Body fat (estimate)" value={d.bodyFat} setValue={v => u("bodyFat", v)} suffix="%" theme={theme} />
            </div>
          )}
          {step === 1 && (
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
              <h2 className={`text-xl font-semibold mb-1 ${theme.text}`}>Activity level</h2>
              <p className={`text-sm ${theme.textMuted} mb-4`}>Outside of gym training.</p>
              <div className="space-y-2">
                {[{ l: "Sedentary", x: "Desk job", v: 1.25 }, { l: "Lightly active", x: "1-3 sessions/wk", v: 1.4 }, { l: "Moderately active", x: "3-5 sessions/wk", v: 1.6 }, { l: "Very active", x: "6-7 sessions/wk", v: 1.8 }].map(o => (
                  <button key={o.v} onClick={() => u("activity", o.v)} className="w-full p-3 rounded-lg border-2 text-left"
                    style={{ borderColor: d.activity === o.v ? ORANGE : "", backgroundColor: d.activity === o.v ? `${ORANGE}15` : "" }}>
                    <div className={`font-medium ${theme.text}`}>{o.l}</div>
                    <div className={`text-xs ${theme.textMuted} mt-0.5`}>{o.x}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {step === 2 && (
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
              <h2 className={`text-xl font-semibold mb-1 ${theme.text}`}>Goal</h2>
              <p className={`text-sm ${theme.textMuted} mb-4`}>What are we working toward?</p>
              <div className="space-y-2">
                {[{ l: "Cut", x: "Lose fat, keep muscle" }, { l: "Recomp", x: "Slow recomposition" }, { l: "Maintain", x: "Hold current weight" }, { l: "Lean Bulk", x: "Slow muscle gain" }, { l: "Bulk", x: "Faster muscle gain" }].map(o => (
                  <button key={o.l} onClick={() => u("goal", o.l)} className="w-full p-3 rounded-lg border-2 text-left"
                    style={{ borderColor: d.goal === o.l ? ORANGE : "", backgroundColor: d.goal === o.l ? `${ORANGE}15` : "" }}>
                    <div className={`font-medium ${theme.text}`}>{o.l}</div>
                    <div className={`text-xs ${theme.textMuted} mt-0.5`}>{o.x}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {step === 3 && (() => {
            const wks = (() => { if (!d.targetDate) return 0; const ms = new Date(d.targetDate) - new Date(); return Math.max(0, ms / (7 * 86400000)); })();
            const wtChange = d.targetWeight - d.weight;
            const absChange = Math.abs(wtChange);
            const direction = wtChange < 0 ? "lose" : wtChange > 0 ? "gain" : "maintain";
            const ratePerWeek = wks > 0 ? absChange / wks : 0;
            const ratePctPerWeek = d.weight > 0 ? (ratePerWeek / d.weight) * 100 : 0;

            // Safe rates:
            // - Cut: ≤1% bodyweight/week (aggressive), ≤0.7% sustainable
            // - Bulk: ≤0.5% bodyweight/week (lean), ≤0.25% optimal
            const maxCutPct = 1.0;
            const maxBulkPct = 0.5;
            const maxRate = direction === "lose" ? maxCutPct : direction === "gain" ? maxBulkPct : 100;
            const minWeeks = absChange > 0 ? Math.ceil(absChange / (d.weight * maxRate / 100)) : 0;

            const tooFast = direction !== "maintain" && ratePctPerWeek > maxRate;
            const verySlow = direction !== "maintain" && wks > 0 && ratePctPerWeek < (maxRate * 0.2);

            // Suggested date
            const suggestRealisticDate = () => {
              const target = direction === "lose" ? maxCutPct * 0.7 : maxBulkPct * 0.6; // sustainable middle of range
              const reqWeeks = Math.ceil(absChange / (d.weight * target / 100));
              const dt = new Date(); dt.setDate(dt.getDate() + reqWeeks * 7);
              return { weeks: reqWeeks, dateStr: dt.toISOString().split("T")[0] };
            };

            return (
              <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
                <h2 className={`text-xl font-semibold mb-1 ${theme.text}`}>Target</h2>
                <p className={`text-sm ${theme.textMuted} mb-4`}>Your weight goal and date.</p>
                <NumInput label="Target weight" value={d.targetWeight} setValue={v => u("targetWeight", v)} suffix="kg" step={0.5} theme={theme} />
                <div className="mb-3">
                  <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Target date</label>
                  <input type="date" value={d.targetDate} onChange={e => u("targetDate", e.target.value)}
                    className={`w-full h-12 px-4 text-base font-medium border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg`} />
                </div>

                {direction !== "maintain" && wks > 0 && (
                  <div className="rounded-lg p-3 mb-3" style={{
                    backgroundColor: tooFast ? "#fef2f2" : verySlow ? "#fffbeb" : "#ecfdf5",
                    border: `1px solid ${tooFast ? "#fca5a5" : verySlow ? "#fcd34d" : "#86efac"}`,
                  }}>
                    <div className="flex items-start gap-2">
                      <BrandIcon name={tooFast ? "warning" : verySlow ? "down" : "target"} size={16} color={tooFast ? "#dc2626" : verySlow ? "#a16207" : "#15803d"} strokeWidth={2.2} />
                      <div className="flex-1">
                        <div className="text-xs font-bold" style={{ color: tooFast ? "#991b1b" : verySlow ? "#92400e" : "#15803d" }}>
                          {tooFast ? "Too aggressive" : verySlow ? "Very gradual" : "Realistic pace"}
                        </div>
                        <div className="text-[11px] leading-snug mt-0.5" style={{ color: tooFast ? "#7f1d1d" : verySlow ? "#78350f" : "#166534" }}>
                          To {direction} {absChange.toFixed(1)} kg in {Math.round(wks)} weeks = {ratePerWeek.toFixed(2)} kg/week ({ratePctPerWeek.toFixed(2)}% bodyweight).
                          {tooFast && ` Safe ${direction === "lose" ? "cuts cap at" : "bulks cap at"} ${maxRate}%/week. Faster risks ${direction === "lose" ? "muscle loss + rebound" : "fat gain"}.`}
                          {verySlow && ` Going slower than 0.2% means daily calorie adjustments are tiny — easy to lose track.`}
                        </div>
                        {tooFast && (
                          <button onClick={() => {
                            const s = suggestRealisticDate();
                            u("targetDate", s.dateStr);
                          }} className="mt-2 text-[11px] font-bold underline" style={{ color: "#991b1b" }}>
                            Use realistic date ({suggestRealisticDate().weeks} wks) →
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {direction !== "maintain" && wks === 0 && (
                  <div className={`text-[11px] ${theme.textMuted} italic mb-3`}>Pick a future date for SLR to calculate your daily target.</div>
                )}

                <NumInput label="Daily steps target" value={d.steps} setValue={v => u("steps", v)} suffix="steps" step={500} theme={theme} />
                <NumInput label="Daily water target" value={d.waterTarget} setValue={v => u("waterTarget", v)} suffix="L" step={0.25} theme={theme} />
                <p className={`text-[10px] ${theme.textMuted} -mt-2 italic`}>Typical: 2.5L for men, 2L for women. Adjust for climate / training intensity.</p>
              </div>
            );
          })()}
          {step === 4 && (
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
              <h2 className={`text-xl font-semibold mb-1 ${theme.text}`}>Training</h2>
              <p className={`text-sm ${theme.textMuted} mb-4`}>Set your weekly plan.</p>
              <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Days per week</label>
              <div className="grid grid-cols-6 gap-1.5 mb-4">
                {[1, 2, 3, 4, 5, 6].map(n => (
                  <button key={n} onClick={() => u("daysPerWeek", n)} className="h-12 rounded-lg font-medium text-sm"
                    style={{ backgroundColor: d.daysPerWeek === n ? NAVY : "", color: d.daysPerWeek === n ? "white" : "" }}>
                    <div className={d.daysPerWeek === n ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{n}</div>
                  </button>
                ))}
              </div>
              <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Split</label>
              <div className="grid grid-cols-2 gap-2 mb-4">
                {["Full Body", "Upper-Lower", "PPL", "Bro Split"].map(s => (
                  <button key={s} onClick={() => u("split", s)} className="h-12 rounded-lg font-medium text-sm"
                    style={{ backgroundColor: d.split === s ? NAVY : "", color: d.split === s ? "white" : "" }}>
                    <div className={d.split === s ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{s}</div>
                  </button>
                ))}
              </div>
              <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Areas to focus on (optional)</label>
              <p className={`text-xs ${theme.textMuted} mb-2`}>Pick any. SLR will tailor your plan toward these.</p>
              <div className="grid grid-cols-3 gap-1.5 mb-4">
                {["Chest", "Back", "Shoulders", "Arms", "Legs", "Glutes", "Core", "Calves"].map(a => {
                  const sel = d.focusAreas.includes(a);
                  return (
                    <button key={a} onClick={() => u("focusAreas", sel ? d.focusAreas.filter(x => x !== a) : [...d.focusAreas, a])}
                      className="h-10 rounded-lg font-medium text-xs"
                      style={{ backgroundColor: sel ? ORANGE : "", color: sel ? "white" : "" }}>
                      <div className={sel ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{a}</div>
                    </button>
                  );
                })}
              </div>
              <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Equipment</label>
              <div className="space-y-2 mb-4">
                {["Commercial gym", "Home gym", "Bodyweight only"].map(e => (
                  <button key={e} onClick={() => u("equipment", e)} className="w-full p-3 rounded-lg border-2 text-left"
                    style={{ borderColor: d.equipment === e ? ORANGE : "", backgroundColor: d.equipment === e ? `${ORANGE}15` : "" }}>
                    <div className={`font-medium ${theme.text}`}>{e}</div>
                  </button>
                ))}
              </div>

              <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Training experience</label>
              <div className="grid grid-cols-5 gap-1.5 mb-2">
                {[1, 2, 3, 4, 5].map(n => {
                  const sel = (d.experience || 3) === n;
                  return (
                    <button key={n} onClick={() => u("experience", n)}
                      className="h-12 rounded-lg font-bold text-base"
                      style={{ backgroundColor: sel ? ORANGE : "", color: sel ? "white" : "" }}>
                      <div className={sel ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{n}</div>
                    </button>
                  );
                })}
              </div>
              <p className={`text-[10px] ${theme.textMuted} italic leading-snug`}>
                {(d.experience || 3) === 1 && "1 — Brand new. Avoids complex barbell lifts; machines & dumbbells."}
                {(d.experience || 3) === 2 && "2 — Some experience. Still building form on heavy compounds."}
                {(d.experience || 3) === 3 && "3 — Comfortable with most lifts. Heavy work introduced cautiously."}
                {(d.experience || 3) === 4 && "4 — Trained for years. All lifts available; intensification suggested."}
                {(d.experience || 3) === 5 && "5 — Advanced. Complex movements actively recommended; intensification doubled."}
              </p>
            </div>
          )}

          {step === 5 && (
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
              <h2 className={`text-xl font-semibold mb-1 ${theme.text}`}>Treat banking</h2>
              <p className={`text-sm ${theme.textMuted} mb-4`}>
                Pick a treat. SLR sets aside calories each day; if you stay under target all week, you bank one. Eat it guilt-free — it's pre-paid for. Skip if not for you.
              </p>
              <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Pick a treat</label>
              <div className="grid grid-cols-2 gap-2 mb-4">
                {[
                  { name: "Chocolate bar", kcal: 230, emoji: "🍫" },
                  { name: "Pint of beer", kcal: 220, emoji: "🍺" },
                  { name: "Glass of wine", kcal: 130, emoji: "🍷" },
                  { name: "Slice of pizza", kcal: 285, emoji: "🍕" },
                  { name: "Ice cream", kcal: 270, emoji: "🍨" },
                  { name: "Pastry", kcal: 320, emoji: "🥐" },
                  { name: "Burger", kcal: 540, emoji: "🍔" },
                  { name: "Custom", kcal: 200, emoji: "✨" },
                ].map(t => {
                  const sel = d.treat?.name === t.name;
                  return (
                    <button key={t.name} onClick={() => u("treat", { name: t.name, kcal: t.kcal, emoji: t.emoji, ambition: d.treat?.ambition || 1 })}
                      className="p-3 rounded-lg border-2 text-left active:opacity-80"
                      style={{ borderColor: sel ? ORANGE : "", backgroundColor: sel ? `${ORANGE}15` : "" }}>
                      <div className="text-xl">{t.emoji}</div>
                      <div className={`text-sm font-semibold ${theme.text}`}>{t.name}</div>
                      <div className={`text-[10px] ${theme.textMuted}`}>~{t.kcal} kcal</div>
                    </button>
                  );
                })}
              </div>

              {d.treat && (
                <>
                  {d.treat.name === "Custom" && (
                    <>
                      <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5 mt-2`}>Treat name</label>
                      <input type="text" value={d.treat.customName || ""} placeholder="e.g. Pub burger"
                        onChange={e => u("treat", { ...d.treat, customName: e.target.value })}
                        className={`w-full h-12 px-4 text-base border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg mb-3`} />
                      <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Calories</label>
                      <input type="number" inputMode="numeric" value={d.treat.kcal}
                        onChange={e => u("treat", { ...d.treat, kcal: Number(e.target.value) || 0 })}
                        className={`w-full h-12 px-4 text-base border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg mb-3`} />
                    </>
                  )}
                  <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5 mt-2`}>How many per week?</label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { v: 0.5, l: "0.5x", sub: "every 2 weeks" },
                      { v: 1, l: "1x", sub: "weekly" },
                      { v: 2, l: "2x", sub: "twice/week" },
                    ].map(o => {
                      const sel = d.treat?.ambition === o.v;
                      return (
                        <button key={o.v} onClick={() => u("treat", { ...d.treat, ambition: o.v })}
                          className="h-14 rounded-lg font-bold text-sm"
                          style={{ backgroundColor: sel ? NAVY : "", color: sel ? "white" : "" }}>
                          <div className={sel ? "flex flex-col items-center justify-center h-full" : `${theme.surface} ${theme.surfaceText} h-full flex flex-col items-center justify-center rounded-lg`}>
                            <div>{o.l}</div>
                            <div className="text-[9px] font-normal opacity-70">{o.sub}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="rounded-lg p-3 mt-3" style={{ backgroundColor: `${ORANGE}10`, border: `1px solid ${ORANGE}55` }}>
                    <div className="text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: ORANGE }}>Daily cost</div>
                    <div className={`text-sm ${theme.text}`}>
                      <span className="font-bold">{Math.round(d.treat.kcal * d.treat.ambition / 7)} kcal/day</span> deducted from your daily target.
                    </div>
                    <p className={`text-[10px] ${theme.textMuted} mt-1`}>Hit your weekly target → bank {d.treat.ambition} {d.treat.name.toLowerCase()}.</p>
                  </div>
                </>
              )}

              <button onClick={() => u("treat", null)} className={`text-xs ${theme.textMuted} underline mt-3 block mx-auto`}>
                Skip — no treat banking
              </button>
            </div>
          )}
        </div>
        <div className="fixed bottom-0 left-0 right-0 pt-6 pb-6 px-4" style={{ background: `linear-gradient(to top, ${theme.bg.includes("950") ? "#020617" : "#f8fafc"}, transparent)` }}>
          <div className="max-w-md mx-auto flex gap-2">
            {step > 0 && <button onClick={() => setStep(step - 1)} className={`h-14 px-5 ${theme.card} border-2 ${theme.border} ${theme.text} rounded-xl font-semibold`}>← Back</button>}
            <button onClick={next} disabled={step === 0 && !d.name.trim()}
              className="flex-1 h-14 text-white rounded-xl font-semibold text-lg disabled:opacity-40"
              style={{ backgroundColor: ORANGE }}>
              {step === total - 1 ? "Get my plan →" : "Continue →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// USER APP
// ============================================================
function UserApp({ session, themeCtx, onLogout }) {
  const { theme } = themeCtx;
  const [profile, setProfile] = useState(null);
  const [profileChecked, setProfileChecked] = useState(false);
  const [tab, setTab] = useState("home");
  const [homeKey, setHomeKey] = useState(0);
  const switchTab = (next) => {
    setTab(next);
    if (next === "home") setHomeKey(k => k + 1);
  };
  useEffect(() => { storage.get(userKey(session.id, "profile")).then(p => { setProfile(p); setProfileChecked(true); }); }, [session.id]);

  // Allow any child to request a tab switch via custom event
  // (Home Food card → Food tab; can also pass {date, quickAdd} to focus a specific day/mode)
  // (Block overrun → Insights → Review sub-tab via {tab:"analytics", subTab:"review"})
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.tab) switchTab(e.detail.tab);
      // Defer the focus event so the target tab has mounted and registered its listener
      if (e.detail?.tab === "food" && (e.detail.date || e.detail.quickAdd)) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("sinc:food-tab-focus", {
            detail: { date: e.detail.date, quickAdd: e.detail.quickAdd },
          }));
        }, 50);
      }
      if (e.detail?.tab === "analytics" && e.detail?.subTab) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("sinc:analytics-tab-focus", {
            detail: { subTab: e.detail.subTab },
          }));
        }, 50);
      }
    };
    window.addEventListener("sinc:switch-tab", handler);
    return () => window.removeEventListener("sinc:switch-tab", handler);
  }, []);

  if (!profileChecked) return <div className={`min-h-screen ${theme.bg} flex items-center justify-center ${theme.textMuted} text-sm`}>Loading...</div>;
  if (!profile) return <Onboarding themeCtx={themeCtx} onComplete={async final => {
    await storage.set(userKey(session.id, "profile"), final);
    setProfile(final);
  }} />;
  return (
    <div className={`min-h-screen ${theme.bg} pb-20`}>
      <div className="max-w-md mx-auto">
        {tab === "home" && <Home key={homeKey} session={session} profile={profile} themeCtx={themeCtx} />}
        {tab === "plan" && <PlanTab session={session} profile={profile} themeCtx={themeCtx} />}
        {tab === "food" && <FoodTab session={session} profile={profile} themeCtx={themeCtx} />}
        {tab === "training" && <TrainingPreview profile={profile} themeCtx={themeCtx} session={session} />}
        {tab === "analytics" && <AnalyticsTab session={session} profile={profile} themeCtx={themeCtx} />}
        {tab === "settings" && <Settings session={session} profile={profile} setProfile={setProfile} themeCtx={themeCtx} onLogout={onLogout} />}
      </div>
      <div className={`fixed bottom-0 left-0 right-0 ${theme.nav} border-t ${theme.navBorder}`}>
        <div className="max-w-md mx-auto grid grid-cols-6">
          <NavBtn icon="home" label="Home" active={tab === "home"} onClick={() => switchTab("home")} theme={theme} />
          <NavBtn icon="plan" label="Plan" active={tab === "plan"} onClick={() => switchTab("plan")} theme={theme} />
          <NavBtn icon="food" label="Food" active={tab === "food"} onClick={() => switchTab("food")} theme={theme} />
          <NavBtn icon="train" label="Train" active={tab === "training"} onClick={() => switchTab("training")} theme={theme} />
          <NavBtn icon="insights" label="Insights" active={tab === "analytics"} onClick={() => switchTab("analytics")} theme={theme} />
          <NavBtn icon="more" label="More" active={tab === "settings"} onClick={() => switchTab("settings")} theme={theme} />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// CUSTOM NAV ICONS — line-based, brand-aligned (no emoji)
// ============================================================
function NavIcon({ name, color }) {
  const stroke = color;
  const sw = 1.8;
  const props = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke, strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (name) {
    case "home":
      return (
        <svg {...props}>
          <path d="M3 11 L12 4 L21 11 V20 a1 1 0 0 1 -1 1 H15 V14 H9 V21 H4 a1 1 0 0 1 -1 -1 Z" />
        </svg>
      );
    case "plan":
      return (
        <svg {...props}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 9 H21" />
          <path d="M8 3 V7 M16 3 V7" />
          <circle cx="8" cy="14" r="0.5" fill={color} />
          <circle cx="12" cy="14" r="0.5" fill={color} />
          <circle cx="16" cy="14" r="0.5" fill={color} />
          <circle cx="8" cy="17" r="0.5" fill={color} />
          <circle cx="12" cy="17" r="0.5" fill={color} />
        </svg>
      );
    case "food":
      // Apple shape with leaf
      return (
        <svg {...props}>
          <path d="M12 7 C9 7 6 9 6 13 C6 17 8 21 12 21 C16 21 18 17 18 13 C18 9 15 7 12 7 Z" />
          <path d="M12 7 C12 5 13 3 15 3" />
          <path d="M12 7 C11 6 10 5 9 5" />
        </svg>
      );
    case "train":
      // Dumbbell
      return (
        <svg {...props}>
          <rect x="2" y="9" width="3" height="6" rx="1" />
          <rect x="19" y="9" width="3" height="6" rx="1" />
          <rect x="5" y="10.5" width="2" height="3" rx="0.5" />
          <rect x="17" y="10.5" width="2" height="3" rx="0.5" />
          <path d="M7 12 H17" strokeWidth="2.2" />
        </svg>
      );
    case "insights":
      // Bar chart with arrow up
      return (
        <svg {...props}>
          <path d="M3 21 H21" />
          <rect x="5" y="13" width="3" height="8" rx="0.5" />
          <rect x="10.5" y="9" width="3" height="12" rx="0.5" />
          <rect x="16" y="5" width="3" height="16" rx="0.5" />
          <path d="M5 9 L10 6 L14 8 L20 3" stroke={ORANGE} strokeWidth="1.5" />
          <path d="M16 3 L20 3 L20 7" stroke={ORANGE} strokeWidth="1.5" />
        </svg>
      );
    case "more":
      // Settings gear
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    default:
      return null;
  }
}

// ============================================================
// BRAND ICON — line-art icons for content (replacing emoji)
// Same visual language as NavIcon: 1.8 stroke, rounded caps, 24x24 box
// ============================================================
function BrandIcon({ name, size = 22, color = "currentColor", strokeWidth = 1.8, fill }) {
  const props = { width: size, height: size, viewBox: "0 0 24 24", fill: fill || "none", stroke: color, strokeWidth, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (name) {
    case "food":
      // Knife + fork crossed
      return (
        <svg {...props}>
          <path d="M7 2 V11 M5 2 V7 a2 2 0 0 0 4 0 V2 M7 11 V22" />
          <path d="M16 2 C14 2 13 5 13 8 V11 a2 2 0 0 0 2 2 H17 V22" />
        </svg>
      );
    case "weight":
      // Scale (balance)
      return (
        <svg {...props}>
          <path d="M12 4 V20" />
          <path d="M5 20 H19" />
          <circle cx="12" cy="4" r="1" fill={color} />
          <path d="M5 9 L3 14 a3 3 0 0 0 6 0 L7 9 Z" />
          <path d="M17 9 L15 14 a3 3 0 0 0 6 0 L19 9 Z" />
          <path d="M5 9 H19" />
        </svg>
      );
    case "steps":
      // Footprint (single shoe sole)
      return (
        <svg {...props}>
          <path d="M9 4 C7 4 6 6 6 9 C6 12 7 14 9 14 C11 14 12 12 12 9 C12 6 11 4 9 4 Z" />
          <ellipse cx="14" cy="18" rx="2" ry="1.5" />
          <ellipse cx="6" cy="18" rx="2" ry="1.5" />
          <ellipse cx="16.5" cy="14.5" rx="1.3" ry="1" />
        </svg>
      );
    case "workout":
      // Flexed arm / muscle
      return (
        <svg {...props}>
          <path d="M5 11 C5 8 8 6 11 6 H14 a2 2 0 0 1 2 2 V12 a4 4 0 0 1 -4 4 H10 a4 4 0 0 1 -4 -4 Z" />
          <path d="M14 6 V4 a1 1 0 0 1 1 -1 H17 a1 1 0 0 1 1 1 V8" />
          <path d="M11 16 V21" />
        </svg>
      );
    case "lightbulb":
      // Lightbulb (insight)
      return (
        <svg {...props}>
          <path d="M9 18 H15" />
          <path d="M10 21 H14" />
          <path d="M12 3 a6 6 0 0 0 -4 10 C9 14 9 16 9 17 H15 C15 16 15 14 16 13 a6 6 0 0 0 -4 -10 Z" />
        </svg>
      );
    case "flame":
      // Streak flame
      return (
        <svg {...props}>
          <path d="M12 3 C10 6 6 8 6 13 a6 6 0 0 0 12 0 C18 10 16 9 15 6 C14 8 13 9 12 9 C12 7 12 5 12 3 Z" />
        </svg>
      );
    case "target":
      // Bullseye target
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1.5" fill={color} />
        </svg>
      );
    case "barbell":
      // Loaded barbell (heavier than nav dumbbell)
      return (
        <svg {...props}>
          <rect x="1.5" y="8" width="2.5" height="8" rx="0.5" />
          <rect x="20" y="8" width="2.5" height="8" rx="0.5" />
          <rect x="4" y="10" width="2.5" height="4" rx="0.5" />
          <rect x="17.5" y="10" width="2.5" height="4" rx="0.5" />
          <path d="M6.5 12 H17.5" strokeWidth="2.4" />
        </svg>
      );
    case "reps":
      // Counter / repeat arrows
      return (
        <svg {...props}>
          <path d="M4 8 H17 a3 3 0 0 1 3 3 V12" />
          <path d="M14 5 L17 8 L14 11" />
          <path d="M20 16 H7 a3 3 0 0 1 -3 -3 V12" />
          <path d="M10 19 L7 16 L10 13" />
        </svg>
      );
    case "tune":
      // Sliders (sweet spot adjustment)
      return (
        <svg {...props}>
          <path d="M4 6 H20 M4 12 H20 M4 18 H20" />
          <circle cx="9" cy="6" r="2" fill={fill || "currentColor"} stroke={color} />
          <circle cx="15" cy="12" r="2" fill={fill || "currentColor"} stroke={color} />
          <circle cx="11" cy="18" r="2" fill={fill || "currentColor"} stroke={color} />
        </svg>
      );
    case "down":
      // Decrease arrow
      return (
        <svg {...props}>
          <path d="M12 5 V19" />
          <path d="M6 13 L12 19 L18 13" />
        </svg>
      );
    case "up":
      // Increase arrow
      return (
        <svg {...props}>
          <path d="M12 19 V5" />
          <path d="M6 11 L12 5 L18 11" />
        </svg>
      );
    case "warning":
      // Warning triangle
      return (
        <svg {...props}>
          <path d="M12 3 L22 20 H2 Z" />
          <path d="M12 9 V14" />
          <circle cx="12" cy="17" r="0.8" fill={color} />
        </svg>
      );
    case "swap":
      // Swap exercise
      return (
        <svg {...props}>
          <path d="M4 7 H18" />
          <path d="M15 4 L18 7 L15 10" />
          <path d="M20 17 H6" />
          <path d="M9 14 L6 17 L9 20" />
        </svg>
      );
    case "plus":
      return (
        <svg {...props}>
          <path d="M12 5 V19 M5 12 H19" />
        </svg>
      );
    case "treat":
      // Chocolate bar / candy
      return (
        <svg {...props}>
          <rect x="5" y="6" width="14" height="12" rx="1.5" />
          <path d="M9 6 V18 M14 6 V18" />
          <path d="M5 10 H19 M5 14 H19" />
        </svg>
      );
    case "apple":
      return (
        <svg {...props}>
          <path d="M12 7 C9 7 6 9 6 13 C6 17 8 21 12 21 C16 21 18 17 18 13 C18 9 15 7 12 7 Z" />
          <path d="M12 7 C12 5 13 3 15 3" />
        </svg>
      );
    case "trophy":
      return (
        <svg {...props}>
          <path d="M8 4 H16 V11 a4 4 0 0 1 -8 0 Z" />
          <path d="M8 7 H4 V9 a3 3 0 0 0 4 3" />
          <path d="M16 7 H20 V9 a3 3 0 0 1 -4 3" />
          <path d="M9 21 H15 M12 15 V21" />
        </svg>
      );
    case "scale":
      // Bathroom scale
      return (
        <svg {...props}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M8 9 H16" />
          <circle cx="12" cy="14" r="2.5" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...props}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 9 H21" />
          <path d="M8 3 V7 M16 3 V7" />
        </svg>
      );
    case "search":
      return (
        <svg {...props}>
          <circle cx="11" cy="11" r="7" />
          <path d="M16 16 L20 20" />
        </svg>
      );
    case "star":
      return (
        <svg {...props}>
          <path d="M12 3 L14.5 9 L21 9.5 L16 13.8 L17.5 20 L12 16.5 L6.5 20 L8 13.8 L3 9.5 L9.5 9 Z" />
        </svg>
      );
    case "globe":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12 H21" />
          <path d="M12 3 a14 14 0 0 1 0 18 a14 14 0 0 1 0 -18" />
        </svg>
      );
    case "beaker":
      // Lab beaker / flask
      return (
        <svg {...props}>
          <path d="M9 3 H15" />
          <path d="M10 3 V10 L5 19 a1 1 0 0 0 1 1.5 H18 a1 1 0 0 0 1 -1.5 L14 10 V3" />
          <path d="M7.5 14 H16.5" />
        </svg>
      );
    case "task":
      // Clipboard with check
      return (
        <svg {...props}>
          <rect x="5" y="4" width="14" height="17" rx="2" />
          <path d="M9 4 V2 H15 V4" />
          <path d="M9 13 L11 15 L15 10" />
        </svg>
      );
    case "water":
      // Water droplet
      return (
        <svg {...props}>
          <path d="M12 2 C12 2 6 9 6 14 a6 6 0 0 0 12 0 C18 9 12 2 12 2 Z" />
          <path d="M10 14 a2 2 0 0 0 2 2" strokeWidth="1.2" />
        </svg>
      );
    default:
      return null;
  }
}

function NavBtn({ icon, label, active, onClick, theme }) {
  const color = active ? ORANGE : (theme.bg.includes("950") ? "#94a3b8" : "#64748b");
  return (
    <button onClick={onClick} className="flex flex-col items-center justify-center py-2.5" style={{ color: active ? ORANGE : "" }}>
      <div className="mb-0.5"><NavIcon name={icon} color={color} /></div>
      <div className={`text-[10px] font-semibold tracking-wide ${active ? "" : theme.textMuted}`}>{label}</div>
    </button>
  );
}

// ============================================================
// HOME — yesterday/today/tomorrow + calorie bank
// ============================================================
function Home({ session, profile, themeCtx }) {
  const { theme } = themeCtx;
  const [logs, setLogs] = useState({});
  // dayOffset: 0 = today, -1 = yesterday, +1 = tomorrow, etc
  const [dayOffset, setDayOffset] = useState(0);
  const [showWeight, setShowWeight] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const [showWater, setShowWater] = useState(false);
  const [linkedPT, setLinkedPT] = useState(null);
  const [streak, setStreak] = useState(0);
  const [blocks, setBlocks] = useState([]);
  const [treatBank, setTreatBank] = useState({ count: 0, weekKey: "", consumed: 0 });
  const [secondaryTreatBank, setSecondaryTreatBank] = useState({ count: 0, weekKey: "", consumed: 0 });
  const [ptNote, setPtNote] = useState("");
  const [ptNoteDismissed, setPtNoteDismissed] = useState(false);
  const [sessionCompletions, setSessionCompletions] = useState({});
  const [suggestions, setSuggestions] = useState({ pending: [], accepted: [], rejected: [] });
  const [customTasks, setCustomTasks] = useState([]);
  const [taskResponses, setTaskResponses] = useState({});
  const [activeTaskInput, setActiveTaskInput] = useState(null); // {taskId, type} when editing a number/text

  // Use current block's calorie target if a block exists, otherwise live calc
  const currentBlock = useMemo(() => getCurrentBlock(blocks), [blocks]);
  const baseTargets = useMemo(() => {
    if (currentBlock) {
      return {
        calTarget: currentBlock.calTarget,
        protein: currentBlock.protein,
        fat: currentBlock.fat,
        carbs: currentBlock.carbs,
        intensityLabel: "Standard",
      };
    }
    return calculateTargets(profile);
  }, [currentBlock, profile]);

  useEffect(() => {
    (async () => {
      const allLogs = (await storage.get(userKey(session.id, "logs"))) || {};
      setLogs(allLogs);
      const allBlocks = await ensureCurrentBlock(session.id, profile);
      setBlocks(allBlocks);
            try {
        const sbKey = Object.keys(localStorage).find(k => k.startsWith("sb-") && k.endsWith("-auth-token"));
        const token = sbKey ? JSON.parse(localStorage.getItem(sbKey))?.access_token : null;
        const headers = { "apikey": SUPABASE_ANON_KEY };
        if (token) headers["Authorization"] = "Bearer " + token;
        const linkRes = await fetch(`${SUPABASE_URL}/rest/v1/pt_links?select=pt_user_id&client_user_id=eq.${session.id}&status=eq.active&limit=1`, { headers });
        const links = linkRes.ok ? await linkRes.json() : [];
        if (links[0]) {
          const ptId = links[0].pt_user_id;
          const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=user_id,data&user_id=eq.${ptId}&limit=1`, { headers });
          const profs = pr.ok ? await pr.json() : [];
          if (profs[0]) setLinkedPT({ id: profs[0].user_id, username: profs[0].data?.username || "PT" });
        }
      } catch (e) { console.warn("load PT link failed", e); }

      // Calculate streak — consecutive days ending today with food logged
      let count = 0;
      for (let i = 0; i < 365; i++) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = d.toISOString().split("T")[0];
        if (allLogs[ds]?.food) count++; else break;
      }
      setStreak(count);

      // Load session completions
      const completions = (await storage.get(userKey(session.id, "session-completions"))) || {};
      setSessionCompletions(completions);

      // Load PT note (if a PT has left one). Track dismissal locally.
      const note = (await storage.get(userKey(session.id, "pt-note"))) || "";
      setPtNote(note);
      const lastDismissed = (await storage.get(userKey(session.id, "pt-note-dismissed"))) || "";
      setPtNoteDismissed(lastDismissed === note && note !== "");

      // Load custom tasks + responses
      const taskStore = (await storage.get(userKey(session.id, "custom-tasks"))) || { tasks: [] };
      setCustomTasks(taskStore.tasks || []);
      const responses = (await storage.get(userKey(session.id, "custom-task-responses"))) || {};
      setTaskResponses(responses);

      // Load treat banks. Evaluate any newly-completed weeks against both primary
      // and (optional) secondary treats. Both banks use the SAME effective target
      // (base − combined deduction across both treats), so a week that earns the
      // primary treat also earns the secondary if both are configured.
      const primaryDed = profile.treat ? Math.round((profile.treat.kcal * profile.treat.ambition) / 7) : 0;
      const secondaryDed = profile.secondaryTreat ? Math.round((profile.secondaryTreat.kcal * profile.secondaryTreat.ambition) / 7) : 0;
      const combinedDeduction = primaryDed + secondaryDed;

      if (profile.treat) {
        const stored = (await storage.get(userKey(session.id, "treat-bank"))) || { count: 0, weekKey: "", consumed: 0, lastEvaluated: "" };
        const result = evaluateTreatWeek(stored, allLogs, profile, { ...profile.treat, combinedDeduction });
        if (result.changed) await storage.set(userKey(session.id, "treat-bank"), result.bank);
        setTreatBank(result.bank);
      }
      if (profile.secondaryTreat) {
        const stored2 = (await storage.get(userKey(session.id, "treat-bank-2"))) || { count: 0, weekKey: "", consumed: 0, lastEvaluated: "" };
        const result2 = evaluateTreatWeek(stored2, allLogs, profile, { ...profile.secondaryTreat, combinedDeduction });
        if (result2.changed) await storage.set(userKey(session.id, "treat-bank-2"), result2.bank);
        setSecondaryTreatBank(result2.bank);
      }

      // Load suggestions; run monthly check-in if it's been > 28 days
      const lifts = (await storage.get(userKey(session.id, "lifts"))) || {};
      const stored = (await storage.get(userKey(session.id, "suggestions"))) || { pending: [], accepted: [], rejected: [], expired: [], lastMonthly: null };
      if (!stored.expired) stored.expired = [];
      const today = new Date().toISOString().split("T")[0];

      // Auto-expire pending suggestions older than 14 days. Move them to expired
      // so we have an audit trail and don't immediately re-suggest.
      const EXPIRY_DAYS = 14;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - EXPIRY_DAYS);
      const cutoffStr = cutoffDate.toISOString().split("T")[0];
      const stillPending = [];
      const newlyExpired = [];
      for (const s of stored.pending) {
        // Legacy: if no createdAt, stamp it now (so they get a fresh 14-day clock)
        if (!s.createdAt) { s.createdAt = today; stillPending.push(s); continue; }
        if (s.createdAt < cutoffStr) {
          newlyExpired.push({ ...s, expiredAt: today });
        } else {
          stillPending.push(s);
        }
      }
      if (newlyExpired.length > 0) {
        stored.pending = stillPending;
        stored.expired = [...stored.expired, ...newlyExpired];
        await storage.set(userKey(session.id, "suggestions"), stored);
      }

      const lastMonthly = stored.lastMonthly;
      let needsMonthly = false;
      if (!lastMonthly) needsMonthly = true;
      else {
        const days = (new Date(today) - new Date(lastMonthly)) / 86400000;
        if (days >= 28) needsMonthly = true;
      }
      if (needsMonthly) {
        const monthlyRecs = generateMonthlyCheckin(lifts, completions, profile);
        // Dedupe against existing pending
        const pendingIds = new Set(stored.pending.map(s => s.id));
        const newOnes = monthlyRecs.filter(r => !pendingIds.has(r.id))
          .map(r => ({ ...r, createdAt: today }));
        stored.pending.push(...newOnes);
        stored.lastMonthly = today;
        await storage.set(userKey(session.id, "suggestions"), stored);
      }

      // Also run per-session progression analysis on whatever lift data we have
      const progRecs = analyseProgressForDashboard(lifts, profile);
      if (progRecs.length > 0) {
        const pendingIds = new Set(stored.pending.map(s => s.id));
        const rejectedIds = new Set(stored.rejected.map(s => s.id));
        const acceptedIds = new Set(stored.accepted.map(s => s.id));
        // We DO re-suggest things that previously expired — they may still be valid
        // and the user just didn't action them in time. We only block accepted/rejected.
        const newOnes = progRecs.filter(r => !pendingIds.has(r.id) && !rejectedIds.has(r.id) && !acceptedIds.has(r.id))
          .map(r => ({ ...r, createdAt: today }));
        if (newOnes.length > 0) {
          stored.pending.push(...newOnes);
          await storage.set(userKey(session.id, "suggestions"), stored);
        }
      }
      setSuggestions(stored);
    })();
  }, [session.id, profile]);

  // Refresh logs + completions whenever the window regains focus
  // (e.g. user switches back from training artifact)
  useEffect(() => {
    const refresh = async () => {
      const fresh = (await storage.get(userKey(session.id, "logs"))) || {};
      setLogs(fresh);
      const completions = (await storage.get(userKey(session.id, "session-completions"))) || {};
      setSessionCompletions(completions);
    };
    const onLogsChanged = () => refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("sinc:logs-changed", onLogsChanged);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("sinc:logs-changed", onLogsChanged);
    };
  }, [session.id]);

  const reload = async () => {
    setLogs((await storage.get(userKey(session.id, "logs"))) || {});
    setSessionCompletions((await storage.get(userKey(session.id, "session-completions"))) || {});
  };

  // Rolling window: 1-7 days. Default 7. Drives both the bank calc and forward distribution.
  const rollingWindow = profile.rollingWindow || 7;

  // Compute the rolling N-day balance ENDING on a given date (exclusive of that date).
  // Used for: today's "available bank", future days' adjusted targets.
  // Past days are immutable — they use whatever target was in effect when logged.
  const computeRollingBalance = (endDateStr, blocksList) => {
    let balance = 0;
    for (let i = 1; i <= rollingWindow; i++) {
      const d = new Date(endDateStr); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split("T")[0];
      const log = logs[ds];
      // Use the calorie target that was in effect on that day (block-aware), or planned boost
      const block = blocksList ? getBlockForDate(blocksList, ds) : null;
      const dayBaseTarget = block ? block.calTarget : baseTargets.calTarget;
      // Logged actuals contribute (target - eaten). Planned future boosts/cuts also contribute.
      if (log?.food && log.kcalEaten) {
        balance += dayBaseTarget - log.kcalEaten;
      } else if (log?.plannedAdjust) {
        // future-planned days contribute their adjustment as a "spent" deficit
        balance -= log.plannedAdjust;
      }
    }
    return Math.round(balance);
  };

  const bankBalance = useMemo(() => {
    const todayStr = new Date().toISOString().split("T")[0];
    return computeRollingBalance(todayStr, blocks);
  }, [logs, baseTargets, blocks, rollingWindow]);

  // Per-day distribution: total bank divided by window size = per-day allowance forward
  const dailyBankShare = Math.round(bankBalance / rollingWindow);

  // Compute date for current offset
  const dayDate = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() + dayOffset); return d;
  }, [dayOffset]);
  const dayKey = dayDate.toISOString().split("T")[0];
    const dayLog = { kcalEaten: 0, proteinEaten: 0, fatEaten: 0, carbsEaten: 0, weightValue: 0, stepsTaken: 0, food: false, weight: false, steps: false, workout: false, ...(logs[dayKey] || {}) };

  // Active custom tasks for the displayed day. activeBlockEnd lets us scope tasks
  // to the current training block if endKind === "block".
  const activeBlockEnd = currentBlock?.endDate || null;
  const tasksForDay = useMemo(() => {
    return customTasks.filter(t => taskIsActiveOn(t, dayKey, activeBlockEnd));
  }, [customTasks, dayKey, activeBlockEnd]);

  // Save a task response
  const saveTaskResponse = async (taskId, value) => {
    const next = { ...taskResponses };
    if (!next[dayKey]) next[dayKey] = {};
    next[dayKey] = { ...next[dayKey], [taskId]: value };
    await storage.set(userKey(session.id, "custom-task-responses"), next);
    setTaskResponses(next);
  };

  // Daily deduction for treat banking (sum across primary + secondary treat if set)
  const dailyTreatCost = useMemo(() => {
    let total = 0;
    if (profile.treat) total += Math.round((profile.treat.kcal * profile.treat.ambition) / 7);
    if (profile.secondaryTreat) total += Math.round((profile.secondaryTreat.kcal * profile.secondaryTreat.ambition) / 7);
    return total;
  }, [profile.treat, profile.secondaryTreat]);

  // Past: locked-in baseTarget for that day's block (immutable)
  // Today: base + dailyBankShare − treat deduction
  // Future: base + rolling balance ending that day / window − treat deduction
  const targetForToday = useMemo(() => {
    const dayBlock = getBlockForDate(blocks, dayKey);
    const dayBase = dayBlock ? dayBlock.calTarget : baseTargets.calTarget;
    if (dayOffset < 0) return dayBase; // past — locked at original target
    if (dayOffset === 0) return dayBase + dailyBankShare - dailyTreatCost;
    const rollingForFuture = computeRollingBalance(dayKey, blocks);
    return dayBase + Math.round(rollingForFuture / rollingWindow) - dailyTreatCost;
  }, [dayOffset, dayKey, dailyBankShare, baseTargets, blocks, logs, rollingWindow, dailyTreatCost]);

  const dayLabel = dayOffset === 0 ? "Today" : dayOffset === -1 ? "Yesterday" : dayOffset === 1 ? "Tomorrow"
    : dayOffset < 0 ? `${Math.abs(dayOffset)} days ago` : `In ${dayOffset} days`;

  const stepsPct = profile.steps > 0 ? Math.min(100, (dayLog.stepsTaken / profile.steps) * 100) : 0;
  const waterTarget = profile.waterTarget || 2.5;
  const waterPct = waterTarget > 0 ? Math.min(100, ((dayLog.waterLitres || 0) / waterTarget) * 100) : 0;
  const waterDone = (dayLog.waterLitres || 0) >= waterTarget;
  // Built-in checklist: 5 items now (Food/Weight/Steps/Water/Workout). Custom tasks that count toward streak are added.
  const streakCountingTasks = tasksForDay.filter(t => t.countsTowardStreak !== false);
  const customDone = streakCountingTasks.filter(t => taskIsComplete(t, getTaskResponse(taskResponses, dayKey, t.id))).length;
  const ticks = [dayLog.weight, dayLog.food, dayLog.steps, waterDone, dayLog.workout].filter(Boolean).length + customDone;
  const totalTicks = 5 + streakCountingTasks.length;

  const toggleWorkout = async () => {
    const next = { ...logs };
    next[dayKey] = { ...next[dayKey], workout: !dayLog.workout };
    await storage.set(userKey(session.id, "logs"), next);
    await reload();
  };

  return (
    <div className="pb-4">
      <div className="relative overflow-hidden text-white" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
        <div className="absolute inset-0" style={{
          backgroundImage: `url(${HERO_SPRINTER_B64})`,
          backgroundSize: "cover",
          backgroundPosition: "right center",
          opacity: 0.3,
          mixBlendMode: "luminosity",
        }} />
        <div className="absolute inset-0" style={{
          background: `linear-gradient(90deg, ${theme.headerStart}f0 0%, ${theme.headerStart}cc 60%, ${theme.headerEnd}66 100%)`,
        }} />
        <div className="relative px-5 pt-10 pb-6">
          <div className="flex items-center justify-between">
            <Wordmark />
            <div className="flex items-center gap-2">
              {streak > 0 && <div className="text-xs px-2.5 py-1 rounded-full font-bold flex items-center gap-1.5" style={{ backgroundColor: `${ORANGE}33`, color: ORANGE }}>
                <BrandIcon name="flame" size={13} color={ORANGE} strokeWidth={2} />
                {streak}d
              </div>}
              {linkedPT && <div className="text-[10px] px-2.5 py-1 rounded-full font-semibold tracking-wide" style={{ backgroundColor: `${ORANGE}33`, color: ORANGE }}>PT: {linkedPT.username}</div>}
            </div>
          </div>
          <div className="flex items-center justify-between mt-4">
            <p className="text-blue-100 text-sm">Hi, {profile.name}</p>
            <p className="text-blue-100 text-xs">{ticks}/{totalTicks} logged</p>
          </div>
          {/* Current block strip */}
          {currentBlock && (() => {
            const blockNum = getBlockNumber(blocks, currentBlock.id);
            const start = new Date(currentBlock.startDate);
            const daysIn = Math.floor((Date.now() - start.getTime()) / 86400000);
            const rawWeek = Math.floor(daysIn / 7) + 1;
            // Cap at the block's planned length. If you've gone past, show the
            // block as "complete" — it should auto-close on review.
            const plannedWeeks = currentBlock.plannedWeeks || 4;
            const isOverrun = rawWeek > plannedWeeks;
            const weekIn = Math.min(rawWeek, plannedWeeks);
            return (
              <div className="mt-3 rounded-lg px-3 py-2 flex items-center justify-between" style={{ backgroundColor: "rgba(255,255,255,0.1)" }}>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded" style={{ backgroundColor: ORANGE, color: "white" }}>BLOCK {blockNum}</span>
                  <span className="text-xs font-semibold text-white">{currentBlock.phase}</span>
                </div>
                {isOverrun ? (
                  <button onClick={() => window.dispatchEvent(new CustomEvent("sinc:switch-tab", { detail: { tab: "analytics", subTab: "logs" } }))}
                    className="text-[10px] font-bold px-2 py-1 rounded flex items-center gap-1"
                    style={{ backgroundColor: ORANGE, color: "white" }}>
                    Review block →
                  </button>
                ) : (
                  <div className="text-[10px] text-blue-100">Week {weekIn} of {plannedWeeks}</div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Date stepper — arrows on either side, big label in middle */}
      <div className="px-4 pt-3 mb-3">
        <div className={`${theme.card} rounded-2xl shadow-md border ${theme.border} p-3`}>
          <div className="flex items-center gap-2">
            <button onClick={() => setDayOffset(dayOffset - 1)}
              className={`w-12 h-14 rounded-xl flex items-center justify-center text-xl font-bold ${theme.surface} ${theme.surfaceText} active:opacity-70`}>
              ←
            </button>
            <div className="flex-1 text-center">
              <div className="text-base font-bold" style={{ color: dayOffset === 0 ? ORANGE : theme.text === "text-slate-100" ? "#f1f5f9" : "#0f172a" }}>{dayLabel}</div>
              <div className={`text-xs ${theme.textMuted}`}>{dayDate.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div>
            </div>
            <button onClick={() => setDayOffset(dayOffset + 1)}
              className={`w-12 h-14 rounded-xl flex items-center justify-center text-xl font-bold ${theme.surface} ${theme.surfaceText} active:opacity-70`}>
              →
            </button>
          </div>
          {dayOffset !== 0 && (
            <button onClick={() => setDayOffset(0)} className="w-full h-8 mt-2 text-xs font-semibold rounded-lg" style={{ backgroundColor: `${ORANGE}15`, color: ORANGE }}>
              ↻ Back to today
            </button>
          )}
        </div>
      </div>

      {/* PT note — coach-left message, dismissible per note version */}
      {ptNote && !ptNoteDismissed && (
        <div className="px-4 mb-3">
          <div className={`rounded-2xl p-4 relative`} style={{ backgroundColor: `${ORANGE}12`, borderLeft: `3px solid ${ORANGE}` }}>
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${ORANGE}33` }}>
                <BrandIcon name="lightbulb" size={18} color={ORANGE} strokeWidth={2.2} />
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-[10px] font-bold uppercase tracking-wider mb-1`} style={{ color: ORANGE }}>Note from your PT</div>
                <p className={`text-sm ${theme.text} leading-snug`}>{ptNote}</p>
                <button onClick={async () => {
                  await storage.set(userKey(session.id, "pt-note-dismissed"), ptNote);
                  setPtNoteDismissed(true);
                }} className={`mt-2 text-[10px] ${theme.textMuted} underline`}>Got it, dismiss</button>
              </div>
            </div>
          </div>
        </div>
      )}

            {/* 1. Daily checklist — top priority, what to do today. */}
      <div className="px-4 mb-3">
        <h3 className={`text-[10px] font-bold uppercase tracking-wider ${theme.textMuted} mb-2`}>Today's checklist</h3>
        <div className="space-y-2">

            <ChecklistRow iconName="food" label="Food" done={dayLog.food}
              value={dayLog.food ? `${dayLog.kcalEaten} kcal · P${dayLog.proteinEaten} F${dayLog.fatEaten} C${dayLog.carbsEaten}` : "Not logged"}
              onClick={() => window.dispatchEvent(new CustomEvent("sinc:switch-tab", { detail: { tab: "food" } }))} theme={theme} />
            <ChecklistRow iconName="weight" label="Weight" done={dayLog.weight}
              value={dayLog.weight ? `${dayLog.weightValue} kg` : "Not logged"}
              onClick={() => setShowWeight(true)} theme={theme} />
            <ChecklistRow iconName="steps" label="Steps" done={dayLog.steps}
              value={dayLog.steps ? `${dayLog.stepsTaken.toLocaleString()} / ${profile.steps.toLocaleString()}` : "Not logged"}
              progress={stepsPct}
              onClick={() => setShowSteps(true)} theme={theme} />
            <ChecklistRow iconName="water" label="Water" done={dayLog.water || (dayLog.waterLitres || 0) >= (profile.waterTarget || 2.5)}
              value={(dayLog.waterLitres || 0) > 0
                ? `${(dayLog.waterLitres || 0).toFixed(1)} / ${(profile.waterTarget || 2.5).toFixed(1)} L`
                : "Not logged"}
              progress={waterPct}
              onClick={() => setShowWater(true)} theme={theme} />
            <ChecklistRow iconName="workout"  label="Workout"
              done={dayLog.workout || (sessionCompletions[dayKey] || []).length > 0}
              value={(sessionCompletions[dayKey] || []).length > 0
                ? `Done ✓ ${(sessionCompletions[dayKey] || []).join(", ")}`
                : dayLog.workout ? "Done ✓" : "Tap to mark complete"}
              onClick={toggleWorkout} theme={theme} />

            {/* Custom user-defined tasks active for this day */}
            {tasksForDay.map(task => {
              const response = getTaskResponse(taskResponses, dayKey, task.id);
              const done = taskIsComplete(task, response);
              let valueLabel;
              if (task.type === "tick") {
                valueLabel = done ? "Done ✓" : "Tap to mark complete";
              } else if (task.type === "number") {
                const v = response != null ? (typeof response === "object" ? response.value : response) : null;
                if (v != null) {
                  valueLabel = `${v}${task.unit ? " " + task.unit : ""}${task.target ? ` / ${task.target}${task.unit ? " " + task.unit : ""}` : ""}`;
                } else {
                  valueLabel = task.target ? `0 / ${task.target}${task.unit ? " " + task.unit : ""}` : "Tap to log";
                }
              } else {
                const v = response != null ? (typeof response === "object" ? response.value : response) : null;
                valueLabel = v ? String(v).slice(0, 40) + (String(v).length > 40 ? "…" : "") : "Tap to add note";
              }
              return (
                <ChecklistRow key={task.id} iconName="task" label={task.name} done={done}
                  value={valueLabel}
                  progress={task.type === "number" && task.target ? Math.min(100, ((response?.value || 0) / task.target) * 100) : undefined}
                  onClick={() => {
                    if (task.type === "tick") {
                      saveTaskResponse(task.id, !done);
                    } else {
                      setActiveTaskInput({ task, currentValue: response?.value });
                    }
                  }}
                                    theme={theme} />
              );
            })}
        </div>
      </div>

      {/* 2. Today's calorie ring + macros */}
      <div className="px-4 mb-3">
        <div className={`${theme.card} rounded-2xl shadow-sm border-2 ${theme.border} p-5`}>
          <div className="flex items-center justify-between mb-1">
            <div className={`text-xs uppercase tracking-wide ${theme.textMuted} font-semibold`}>{dayLabel} · {dayDate.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</div>
            {dayOffset === 0 && bankBalance !== 0 && (
              <div className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: bankBalance > 0 ? "#dcfce7" : "#fef3c7", color: bankBalance > 0 ? "#15803d" : "#a16207" }}>
                bank {bankBalance > 0 ? "+" : ""}{dailyBankShare}
              </div>
            )}
          </div>
          <div className="text-center mb-4">
            <div className={`text-5xl font-bold ${theme.text} mt-1`}>
              {dayLog.kcalEaten.toLocaleString()}
              <span className={`text-2xl ${theme.textMuted} font-medium`}> / {targetForToday.toLocaleString()}</span>
            </div>
            <div className={`text-xs ${theme.textMuted} mt-0.5`}>kcal</div>
            <div className="mt-3 h-2.5 bg-slate-700/30 rounded-full overflow-hidden">
              <div className="h-full transition-all" style={{ width: `${Math.min(100, (dayLog.kcalEaten / targetForToday) * 100)}%`, backgroundColor: ORANGE }} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Macro label="PROTEIN" v={dayLog.proteinEaten} t={baseTargets.protein} c="emerald" />
            <Macro label="FAT" v={dayLog.fatEaten} t={baseTargets.fat} c="amber" />
            <Macro label="CARBS" v={dayLog.carbsEaten} t={baseTargets.carbs} c="sky" />
          </div>
        </div>
      </div>

      {/* 3. Banks — calorie + treat together */}
      <div className="px-4 mb-3">
        <h3 className={`text-[10px] font-bold uppercase tracking-wider ${theme.textMuted} mb-2`}>Banks</h3>
        <div className="space-y-2">
          <CalorieBank balance={bankBalance} target={baseTargets.calTarget} rollingWindow={rollingWindow} dailyShare={dailyBankShare} theme={theme} />
          {profile.treat && (
            <TreatCard
              treat={profile.treat}
              bank={treatBank}
              dailyCost={Math.round((profile.treat.kcal * profile.treat.ambition) / 7)}
              theme={theme}
              onConsume={async () => {
                if (treatBank.count <= 0) return;
                const next = { ...treatBank, count: treatBank.count - 1, consumed: (treatBank.consumed || 0) + 1, lastConsumed: new Date().toISOString() };
                await storage.set(userKey(session.id, "treat-bank"), next);
                setTreatBank(next);
              }} />
          )}
          {profile.secondaryTreat && (
            <TreatCard
              treat={profile.secondaryTreat}
              bank={secondaryTreatBank}
              dailyCost={Math.round((profile.secondaryTreat.kcal * profile.secondaryTreat.ambition) / 7)}
              theme={theme}
              onConsume={async () => {
                if (secondaryTreatBank.count <= 0) return;
                const next = { ...secondaryTreatBank, count: secondaryTreatBank.count - 1, consumed: (secondaryTreatBank.consumed || 0) + 1, lastConsumed: new Date().toISOString() };
                await storage.set(userKey(session.id, "treat-bank-2"), next);
                setSecondaryTreatBank(next);
              }} />
          )}
        </div>
      </div>

      {/* 4. Training adjustments — separate section from Banks */}
      {suggestions.pending.length > 0 && (
        <div className="px-4 mb-3">
          <h3 className={`text-[10px] font-bold uppercase tracking-wider ${theme.textMuted} mb-2`}>Training adjustments</h3>
          <ProposedChangesCard
            suggestions={suggestions.pending}
            theme={theme}
            onAccept={async (sug) => {
              const next = {
                ...suggestions,
                pending: suggestions.pending.filter(s => s.id !== sug.id),
                accepted: [...suggestions.accepted, { ...sug, decidedAt: new Date().toISOString().split("T")[0] }],
              };
              await storage.set(userKey(session.id, "suggestions"), next);
              setSuggestions(next);
              await applyAcceptedSuggestion(session.id, sug);
            }}
            onReject={async (sug) => {
              const next = {
                ...suggestions,
                pending: suggestions.pending.filter(s => s.id !== sug.id),
                rejected: [...suggestions.rejected, { ...sug, decidedAt: new Date().toISOString().split("T")[0] }],
              };
              await storage.set(userKey(session.id, "suggestions"), next);
              setSuggestions(next);
            }}
          />
        </div>
      )}

      <div className="px-4">
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: `${ORANGE}1a` }}>
              <BrandIcon name="lightbulb" size={20} color={ORANGE} />
            </div>
            <div className="flex-1">
              <div className={`text-sm font-semibold ${theme.text}`}>How the bank works</div>
              <div className={`text-xs ${theme.textMuted} mt-0.5 leading-snug`}>
                Eat under target → bank fills up. Eat over → bank goes negative. Either way, the next 3 days adjust to keep your weekly total on track.
              </div>
            </div>
          </div>
        </div>
      </div>

      {showWeight && (
        <WeightLogger existing={dayLog} dayLabel={dayLabel} theme={theme}
          onSave={async v => {
            const next = { ...logs };
            next[dayKey] = { ...next[dayKey], weightValue: v, weight: true };
            await storage.set(userKey(session.id, "logs"), next);
            await reload();
            setShowWeight(false);
          }}
          onClose={() => setShowWeight(false)} />
      )}
      {showSteps && (
        <StepsLogger existing={dayLog} dayLabel={dayLabel} target={profile.steps} theme={theme}
          onSave={async v => {
            const next = { ...logs };
            next[dayKey] = { ...next[dayKey], stepsTaken: v, steps: true };
            await storage.set(userKey(session.id, "logs"), next);
            await reload();
            setShowSteps(false);
          }}
          onClose={() => setShowSteps(false)} />
      )}

      {showWater && (
        <WaterLogger existing={dayLog} dayLabel={dayLabel} target={waterTarget} theme={theme}
          onSave={async v => {
            const next = { ...logs };
            next[dayKey] = { ...next[dayKey], waterLitres: v, water: v >= waterTarget };
            await storage.set(userKey(session.id, "logs"), next);
            await reload();
            setShowWater(false);
          }}
          onClose={() => setShowWater(false)} />
      )}

      {activeTaskInput && (
        <TaskInputModal
          task={activeTaskInput.task}
          currentValue={activeTaskInput.currentValue}
          theme={theme}
          onSave={async (value) => {
            await saveTaskResponse(activeTaskInput.task.id, { value });
            setActiveTaskInput(null);
          }}
          onClear={async () => {
            // Clearing removes the response entirely (resets to "not done")
            const next = { ...taskResponses };
            if (next[dayKey]) {
              const cleaned = { ...next[dayKey] };
              delete cleaned[activeTaskInput.task.id];
              if (Object.keys(cleaned).length === 0) delete next[dayKey];
              else next[dayKey] = cleaned;
              await storage.set(userKey(session.id, "custom-task-responses"), next);
              setTaskResponses(next);
            }
            setActiveTaskInput(null);
          }}
          onClose={() => setActiveTaskInput(null)} />
      )}
    </div>
  );
}

// Modal for logging a numeric or text custom task value
function TaskInputModal({ task, currentValue, theme, onSave, onClear, onClose }) {
  const [v, setV] = useState(currentValue ?? (task.type === "number" ? 0 : ""));
  const canSave = task.type === "number" ? (v != null && v >= 0) : (typeof v === "string" && v.trim().length > 0);
  return (
    <Modal title={task.name} onClose={onClose} theme={theme}>
      {task.type === "number" ? (
        <>
          {task.target > 0 && (
            <p className={`text-xs ${theme.textMuted} mb-3`}>Target: {task.target}{task.unit ? " " + task.unit : ""}</p>
          )}
          <NumInput label={`Value${task.unit ? ` (${task.unit})` : ""}`} value={v} setValue={setV} suffix={task.unit || ""} step={task.target && task.target > 10 ? 1 : 0.5} theme={theme} />
        </>
      ) : (
        <>
          <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Your note</label>
          <textarea value={v} onChange={e => setV(e.target.value)}
            placeholder="Write anything..."
            rows={4}
            className={`w-full p-3 text-base border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg mb-3`} />
        </>
      )}
      <div className="flex gap-2">
        {currentValue != null && (
          <button onClick={onClear} className="h-12 px-4 rounded-xl font-semibold text-sm" style={{ color: "#ef4444", backgroundColor: "#ef444415" }}>
            Clear
          </button>
        )}
        <button onClick={onClose} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
        <button onClick={() => onSave(v)} disabled={!canSave}
          className="flex-1 h-12 text-white rounded-xl font-semibold disabled:opacity-50"
          style={{ backgroundColor: ORANGE }}>Save</button>
      </div>
    </Modal>
  );
}

function ChecklistRow({ iconName, label, done, value, progress, onClick, theme }) {
  return (
    <button onClick={onClick} className={`w-full p-3 rounded-xl border-2 ${theme.border} ${done ? "" : theme.card} flex items-center gap-3 text-left active:opacity-80`}
      style={done ? { backgroundColor: "#dcfce7", borderColor: "#bbf7d0" } : {}}>
      <div className={`w-10 h-10 rounded-full ${done ? "bg-emerald-100" : ""} flex items-center justify-center flex-shrink-0`}
        style={done ? {} : { backgroundColor: `${ORANGE}1a` }}>
        <BrandIcon name={iconName} size={20} color={done ? "#15803d" : ORANGE} />
      </div>
      <div className="flex-1 min-w-0">
        <div className={`font-medium text-sm ${done ? "text-emerald-900" : theme.text}`}>{label}</div>
        <div className={`text-xs truncate ${done ? "text-emerald-700" : theme.textMuted}`}>{value}</div>
        {progress !== undefined && progress > 0 && (
          <div className="mt-1 h-1 bg-slate-700/30 rounded-full overflow-hidden">
            <div className="h-full" style={{ width: `${progress}%`, backgroundColor: done ? "#10b981" : ORANGE }} />
          </div>
        )}
      </div>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold ${done ? "bg-emerald-500 text-white" : `border-2 ${theme.border}`}`}>{done ? "✓" : ""}</div>
    </button>
  );
}

function StepsLogger({ existing, dayLabel, target, theme, onSave, onClose }) {
  const [v, setV] = useState(existing.stepsTaken || 0);
  return (
    <Modal title={`Log steps — ${dayLabel}`} onClose={onClose} theme={theme}>
      <p className={`text-xs ${theme.textMuted} mb-3`}>Daily target: {target.toLocaleString()} steps</p>
      <NumInput label="Steps today" value={v} setValue={setV} suffix="steps" step={500} theme={theme} />
      <div className="grid grid-cols-4 gap-2 mb-4">
        {[5000, 7500, 10000, 12500].map(p => (
          <button key={p} onClick={() => setV(p)} className={`h-10 rounded-lg font-medium text-xs ${v === p ? "text-white" : `${theme.surface} ${theme.surfaceText}`}`}
            style={v === p ? { backgroundColor: ORANGE } : {}}>{p / 1000}k</button>
        ))}
      </div>
      <button onClick={() => onSave(v)} disabled={v === 0}
        className="w-full h-12 text-white rounded-xl font-semibold disabled:opacity-50"
        style={{ backgroundColor: ORANGE }}>Save</button>
    </Modal>
  );
}

function WaterLogger({ existing, dayLabel, target, theme, onSave, onClose }) {
  const [v, setV] = useState(existing.waterLitres || 0);
  // Quick-add buttons for common glass / bottle sizes
  const quickAdd = (litres) => setV(prev => Math.max(0, +(prev + litres).toFixed(2)));
  return (
    <Modal title={`Log water — ${dayLabel}`} onClose={onClose} theme={theme}>
      <p className={`text-xs ${theme.textMuted} mb-3`}>Daily target: {target.toFixed(1)} L</p>
      <NumInput label="Water (L)" value={v} setValue={setV} suffix="L" step={0.25} theme={theme} />

      {/* Quick adds */}
      <div className="grid grid-cols-4 gap-2 mb-2">
        <button onClick={() => quickAdd(0.25)} className={`h-10 rounded-lg font-medium text-xs ${theme.surface} ${theme.surfaceText}`}>+0.25</button>
        <button onClick={() => quickAdd(0.5)} className={`h-10 rounded-lg font-medium text-xs ${theme.surface} ${theme.surfaceText}`}>+½ L</button>
        <button onClick={() => quickAdd(0.75)} className={`h-10 rounded-lg font-medium text-xs ${theme.surface} ${theme.surfaceText}`}>+750ml</button>
        <button onClick={() => quickAdd(1.0)} className={`h-10 rounded-lg font-medium text-xs ${theme.surface} ${theme.surfaceText}`}>+1L</button>
      </div>
      <button onClick={() => setV(0)} className={`w-full h-9 rounded-lg text-[11px] mb-3 ${theme.surface} ${theme.surfaceText}`}>Reset to zero</button>

      <p className={`text-[10px] ${theme.textMuted} mb-3 leading-snug`}>
        ~{Math.round((v / target) * 100)}% of target. A typical glass is ~250ml, a standard bottle is ~500ml.
      </p>
      <button onClick={() => onSave(v)} disabled={v < 0}
        className="w-full h-12 text-white rounded-xl font-semibold disabled:opacity-50"
        style={{ backgroundColor: ORANGE }}>Save</button>
    </Modal>
  );
}

// ============================================================
// CALORIE BANK — visual
// ============================================================
function CalorieBank({ balance, target, rollingWindow, dailyShare, theme }) {
  const positive = balance >= 0;
  const maxScale = target * 0.5; // half-day's calories is "full" bank
  const fillPct = Math.min(100, Math.abs(balance) / maxScale * 100);
  const accentColor = positive ? "#10b981" : ORANGE;

  return (
    <div className={`${theme.card} rounded-2xl border-2 ${theme.border} p-5 relative overflow-hidden`}>
      {/* Decorative shape */}
      <div className="absolute -top-4 -right-4 w-32 h-32 rounded-full opacity-5" style={{ backgroundColor: accentColor }} />
      <div className="flex items-center gap-4 relative">
        <div className="relative flex-shrink-0">
          <svg viewBox="0 0 100 100" className="w-20 h-20 -rotate-90">
            <circle cx="50" cy="50" r="42" fill="none" stroke="#e2e8f0" strokeWidth="8" className={theme.bg.includes("950") ? "opacity-20" : ""} />
            <circle cx="50" cy="50" r="42" fill="none" stroke={accentColor} strokeWidth="8"
              strokeDasharray={`${(fillPct / 100) * 263.9} 263.9`} strokeLinecap="round" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-[10px] font-bold opacity-50" style={{ color: accentColor }}>{positive ? "BANKED" : "OWED"}</div>
            <div className="text-base font-bold" style={{ color: accentColor }}>
              {positive ? "+" : "-"}{Math.abs(balance)}
            </div>
          </div>
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <div className="text-lg">🏦</div>
            <div className={`text-xs uppercase tracking-wider ${theme.textMuted} font-bold`}>Calorie Bank</div>
          </div>
          <div className={`text-base font-bold ${theme.text}`}>
            {positive ? "Banked: " : "Owed: "}
            <span style={{ color: accentColor }}>{Math.abs(balance)} kcal</span>
          </div>
          <div className={`text-[11px] ${theme.textMuted} mt-1 leading-snug`}>
            {balance === 0 ? `Bang on target across the last ${rollingWindow} day${rollingWindow > 1 ? "s" : ""}.`
              : positive ? `Spread across ${rollingWindow} day${rollingWindow > 1 ? "s" : ""} = +${dailyShare} per day.`
              : `Spread across ${rollingWindow} day${rollingWindow > 1 ? "s" : ""} = ${dailyShare} per day.`}
          </div>
        </div>
      </div>
      <div className={`mt-4 pt-3 border-t ${theme.border} text-[10px] ${theme.textMuted}`}>
        {rollingWindow}-day rolling balance · target {target.toLocaleString()} kcal/day · adjustable in Settings
      </div>
    </div>
  );
}

// ============================================================
// PROPOSED CHANGES CARD — surfaces progression engine suggestions
// ============================================================
async function applyAcceptedSuggestion(sessionId, sug) {
  // Persist to a write-through map that the training engine reads next time it generates a plan.
  // Format: { setOverrides: { exName: count }, weightOverrides: { exName: weight } }
  const overrides = (await storage.get(userKey(sessionId, "plan-overrides"))) || {
    setOverrides: {}, weightHints: {}, repHints: {}, swapList: [], volumeNudges: {}
  };

  switch (sug.type) {
    case "increase_weight":
    case "decrease_weight":
    case "tune_weight":
      overrides.weightHints[sug.exerciseName] = sug.suggested;
      break;
    case "increase_reps":
      overrides.repHints[sug.exerciseName] = sug.suggested;
      break;
    case "reduce_sets":
    case "add_set":
      overrides.setOverrides[sug.exerciseName] = sug.suggested;
      break;
    case "swap_exercise":
      if (!overrides.swapList.includes(sug.exerciseName)) {
        overrides.swapList.push(sug.exerciseName);
      }
      break;
    case "increase_volume":
    case "decrease_volume":
      overrides.volumeNudges[sug.muscle] = sug.type === "increase_volume" ? "up" : "down";
      break;
    default:
      break;
  }

  await storage.set(userKey(sessionId, "plan-overrides"), overrides);
}

function ProposedChangesCard({ suggestions, theme, onAccept, onReject }) {
  const [expandedId, setExpandedId] = useState(null);

  // Sort: high severity first, then medium, then low
  const sevOrder = { high: 0, med: 1, low: 2 };
  const sorted = [...suggestions].sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));

  const iconFor = (type) => {
    if (type === "increase_weight") return "barbell";
    if (type === "decrease_weight") return "down";
    if (type === "tune_weight") return "tune";
    if (type === "increase_reps") return "reps";
    if (type === "reduce_sets") return "down";
    if (type === "add_set") return "plus";
    if (type === "swap_exercise") return "swap";
    if (type === "increase_volume") return "up";
    if (type === "decrease_volume") return "down";
    if (type === "schedule_review") return "target";
    return "lightbulb";
  };

  const titleFor = (s) => {
    if (s.type === "increase_weight") return `Add weight on ${s.exerciseName}`;
    if (s.type === "decrease_weight") return `Drop weight on ${s.exerciseName}`;
    if (s.type === "tune_weight") return `Find the sweet spot on ${s.exerciseName}`;
    if (s.type === "increase_reps") return `Push reps on ${s.exerciseName}`;
    if (s.type === "reduce_sets") return `Drop a set on ${s.exerciseName}`;
    if (s.type === "add_set") return `Add a set to ${s.exerciseName}`;
    if (s.type === "swap_exercise") return `Rotate ${s.exerciseName}`;
    if (s.type === "increase_volume") return `${s.muscle}: add volume`;
    if (s.type === "decrease_volume") return `${s.muscle}: ease back`;
    if (s.type === "schedule_review") return "Review your training schedule";
    return "Suggested change";
  };

  const detailFor = (s) => {
    if (s.type === "increase_weight" || s.type === "decrease_weight" || s.type === "tune_weight") return `${s.current}kg → ${s.suggested}kg`;
    if (s.type === "increase_reps") return `to ${s.suggested} reps`;
    if (s.type === "reduce_sets" || s.type === "add_set") return `${s.current} → ${s.suggested} sets`;
    return null;
  };

  return (
    <div className={`${theme.card} rounded-2xl border-2 p-4 mt-3`} style={{ borderColor: ORANGE }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <BrandIcon name="target" size={14} color={ORANGE} strokeWidth={2.2} />
          <span className={`text-[10px] uppercase tracking-wider font-bold ${theme.textMuted}`}>Proposed changes</span>
        </div>
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: ORANGE, color: "white" }}>
          {sorted.length}
        </span>
      </div>

      <div className="space-y-2">
        {sorted.slice(0, 5).map(s => {
          const expanded = expandedId === s.id;
          const detail = detailFor(s);
          const sevColor = s.severity === "high" ? "#ef4444" : s.severity === "med" ? ORANGE : "#10b981";

          return (
            <div key={s.id} className={`${theme.surface} rounded-lg border ${theme.border}`}>
              <button onClick={() => setExpandedId(expanded ? null : s.id)} className="w-full text-left p-3 flex items-start gap-3 active:opacity-70">
                <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${ORANGE}1a` }}>
                  <BrandIcon name={iconFor(s.type)} size={16} color={ORANGE} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className={`text-xs font-bold ${theme.text} truncate`}>{titleFor(s)}</div>
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: sevColor }} />
                  </div>
                  {detail && <div className={`text-[11px] ${theme.textMuted} mt-0.5`}>{detail}</div>}
                  {!expanded && <div className={`text-[10px] ${theme.textMuted} mt-1 leading-snug line-clamp-1`}>{s.reason}</div>}
                </div>
                <span className={`text-[10px] ${theme.textMuted} flex-shrink-0`}>{expanded ? "▴" : "▾"}</span>
              </button>

              {expanded && (
                <div className={`px-3 pb-3 border-t ${theme.border} pt-2`}>
                  <p className={`text-[11px] ${theme.textSubtle} leading-snug mb-3`}>{s.reason}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => onReject(s)} className={`h-10 ${theme.card} ${theme.text} rounded-lg text-xs font-semibold border ${theme.border}`}>
                      Not now
                    </button>
                    <button onClick={() => onAccept(s)} className="h-10 rounded-lg text-xs font-bold text-white" style={{ backgroundColor: ORANGE }}>
                      Apply change
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {sorted.length > 5 && (
        <p className={`text-[10px] ${theme.textMuted} mt-2 text-center italic`}>+{sorted.length - 5} more — review later</p>
      )}
    </div>
  );
}

function TreatCard({ treat, bank, dailyCost, theme, onConsume }) {
  const displayName = treat.name === "Custom" ? (treat.customName || "Treat") : treat.name;
  const banked = bank.count || 0;
  const consumed = bank.consumed || 0;
  const today = new Date();
  const weekKey = getISOWeekKey(today);
  const weekDays = getISOWeekDays(weekKey);
  const dayIdx = weekDays.indexOf(today.toISOString().split("T")[0]);
  const daysIntoWeek = dayIdx + 1;
  const weekProgress = (daysIntoWeek / 7) * 100;

  return (
    <div className={`${theme.card} rounded-2xl border-2 ${theme.border} p-4 relative overflow-hidden`}>
      <div className="flex items-start gap-3 mb-3">
        <div className="text-3xl">{treat.emoji || "🍫"}</div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <div className={`text-xs uppercase tracking-wider ${theme.textMuted} font-bold`}>Treat bank</div>
            {banked > 0 && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: ORANGE, color: "white" }}>{banked} READY</span>}
          </div>
          <div className={`text-base font-bold ${theme.text}`}>{displayName}</div>
          <div className={`text-[11px] ${theme.textMuted}`}>−{dailyCost} kcal/day · target {treat.ambition}/wk</div>
        </div>
      </div>

      {/* This week's progress bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className={`text-[10px] font-semibold ${theme.textMuted} uppercase tracking-wide`}>This week</span>
          <span className={`text-[10px] ${theme.textMuted}`}>Day {daysIntoWeek} of 7</span>
        </div>
        <div className="h-1.5 bg-slate-700/30 rounded-full overflow-hidden">
          <div className="h-full transition-all" style={{ width: `${weekProgress}%`, backgroundColor: ORANGE }} />
        </div>
      </div>

      {/* Action */}
      {banked > 0 ? (
        <button onClick={onConsume} className="w-full h-11 rounded-lg text-white font-semibold text-sm" style={{ backgroundColor: "#10b981" }}>
          🎉 Enjoy {displayName.toLowerCase()} ({banked} banked)
        </button>
      ) : (
        <div className={`${theme.surface} rounded-lg p-3 text-center`}>
          <p className={`text-[11px] ${theme.surfaceText} leading-snug`}>
            Hit your daily target all week to bank a {displayName.toLowerCase()}.
          </p>
        </div>
      )}

      {consumed > 0 && (
        <div className={`mt-2 text-[10px] ${theme.textMuted} text-center italic`}>
          {consumed} {displayName.toLowerCase()}{consumed === 1 ? "" : "s"} enjoyed all-time 🏆
        </div>
      )}
    </div>
  );
}

function Macro({ label, v, t, c }) {
  const pct = t > 0 ? Math.min(100, (v / t) * 100) : 0;
  const m = { emerald: ["bg-emerald-50", "text-emerald-700", "bg-emerald-500"], amber: ["bg-amber-50", "text-amber-700", "bg-amber-500"], sky: ["bg-sky-50", "text-sky-700", "bg-sky-500"] }[c];
  return (
    <div className={`${m[0]} rounded-xl p-3`}>
      <div className={`text-[10px] font-bold ${m[1]} tracking-wide`}>{label}</div>
      <div className={`text-lg font-bold ${m[1]} mt-0.5`}>{v}<span className="text-sm font-medium opacity-60"> / {t}g</span></div>
      <div className="mt-1.5 h-1.5 bg-white/60 rounded-full overflow-hidden"><div className={`h-full ${m[2]}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function WeightLogger({ existing, dayLabel, theme, onSave, onClose }) {
  const [w, setW] = useState(existing.weightValue || 0);
  return (
    <Modal title={`Log weight — ${dayLabel}`} onClose={onClose} theme={theme}>
      <NumInput label="Weight" value={w} setValue={setW} suffix="kg" step={0.1} theme={theme} />
      <button onClick={() => onSave(w)} disabled={w === 0}
        className="w-full h-12 text-white rounded-xl font-semibold disabled:opacity-50"
        style={{ backgroundColor: ORANGE }}>Save</button>
    </Modal>
  );
}

// ============================================================
// FOOD LOGGER with AI estimate + alcohol reference
// ============================================================
function FoodLogger({ session, existing, dayLabel, onSave, onClose, theme }) {
  // mode: list | addMeal | estimate | templates
  const [mode, setMode] = useState("list");
  const [meals, setMeals] = useState(existing.meals || []);
  const [editingIdx, setEditingIdx] = useState(null);
  const [draft, setDraft] = useState({ name: "Breakfast", kcal: 0, p: 0, f: 0, c: 0 });
  const [templates, setTemplates] = useState([]);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [foodText, setFoodText] = useState("");
  const [drinkText, setDrinkText] = useState("");
  const [foodEst, setFoodEst] = useState(null);
  const [drinkEst, setDrinkEst] = useState(null);
  const [showAlcoholRef, setShowAlcoholRef] = useState(false);

  // Load templates on mount
  useEffect(() => {
    if (!session) return;
    storage.list(userKey(session.id, "meal:")).then(async keys => {
      const m = await Promise.all(keys.map(k => storage.get(k).then(v => v ? { id: k.split(":meal:")[1], ...v } : null)));
      setTemplates(m.filter(Boolean));
    });
  }, [session]);

  // Migrate legacy single-record format if needed
  useEffect(() => {
    if (!existing.meals && (existing.kcalEaten || 0) > 0) {
      setMeals([{ name: "Logged total", kcal: existing.kcalEaten, p: existing.proteinEaten || 0, f: existing.fatEaten || 0, c: existing.carbsEaten || 0 }]);
    }
  }, []);

  const total = meals.reduce((acc, m) => ({
    kcal: acc.kcal + (m.kcal || 0), p: acc.p + (m.p || 0), f: acc.f + (m.f || 0), c: acc.c + (m.c || 0),
  }), { kcal: 0, p: 0, f: 0, c: 0 });

  const slotSuggestions = ["Breakfast", "Lunch", "Dinner", "Snacks", "Pre-workout", "Post-workout"];

  const beginAddMeal = (suggestedName) => {
    setDraft({ name: suggestedName || "Meal", kcal: 0, p: 0, f: 0, c: 0 });
    setEditingIdx(null);
    setMode("addMeal");
  };

  const beginEditMeal = (idx) => {
    setDraft({ ...meals[idx] });
    setEditingIdx(idx);
    setMode("addMeal");
  };

  const commitMeal = () => {
    if (draft.kcal === 0 && draft.p === 0 && draft.f === 0 && draft.c === 0) { setMode("list"); return; }
    const next = [...meals];
    if (editingIdx !== null) next[editingIdx] = { ...draft };
    else next.push({ ...draft });
    setMeals(next);
    setMode("list");
    setEditingIdx(null);
  };

  const removeMeal = (idx) => {
    setMeals(meals.filter((_, i) => i !== idx));
  };

  const addTemplate = (t) => {
    setMeals([...meals, { name: t.name, kcal: t.kcal, p: t.p, f: t.f, c: t.c }]);
    setMode("list");
  };

  const saveCurrentMealAsTemplate = async () => {
    if (!templateName.trim() || !session) return;
    const id = `${Date.now()}`;
    const t = { name: templateName, kcal: draft.kcal, p: draft.p, f: draft.f, c: draft.c };
    await storage.set(userKey(session.id, `meal:${id}`), t);
    setTemplates([...templates, { id, ...t }]);
    setShowSaveTemplate(false); setTemplateName("");
  };

  const deleteTemplate = async (id) => {
    if (!confirm("Delete this template?")) return;
    await storage.delete(userKey(session.id, `meal:${id}`));
    setTemplates(templates.filter(t => t.id !== id));
  };

  const saveDay = () => {
    onSave({
      kcalEaten: total.kcal,
      proteinEaten: total.p,
      fatEaten: total.f,
      carbsEaten: total.c,
      meals,
    });
  };

  const runEstimate = () => {
    setFoodEst(estimateMacros(foodText, FOOD_DB, false));
    setDrinkEst(estimateMacros(drinkText, ALCOHOL_DB, true));
  };

  const applyEstimateAsMeal = () => {
    const k = (foodEst?.kcal || 0) + (drinkEst?.kcal || 0);
    const p = (foodEst?.p || 0) + (drinkEst?.p || 0);
    const f = (foodEst?.f || 0) + (drinkEst?.f || 0);
    const c = (foodEst?.c || 0) + (drinkEst?.c || 0);
    if (k === 0 && p === 0 && f === 0 && c === 0) return;
    setDraft({ name: foodText.split(",")[0].slice(0, 20) || "Estimated meal", kcal: k, p, f, c });
    setEditingIdx(null);
    setFoodText(""); setDrinkText(""); setFoodEst(null); setDrinkEst(null);
    setMode("addMeal");
  };

  // ===== UI: meal list (default view) =====
  if (mode === "list") {
    return (
      <Modal title={`Log food — ${dayLabel}`} onClose={onClose} theme={theme}>
        {/* Running total */}
        <div className="rounded-xl p-4 mb-4" style={{ background: `linear-gradient(135deg, ${NAVY}, #1e3a5f)` }}>
          <div className="text-[10px] font-bold uppercase tracking-wider text-blue-200 mb-1">Running total</div>
          <div className="text-3xl font-bold text-white">{total.kcal.toLocaleString()}<span className="text-base font-medium text-blue-200"> kcal</span></div>
          <div className="text-xs text-blue-200 mt-1">P{total.p}g · F{total.f}g · C{total.c}g · {meals.length} {meals.length === 1 ? "meal" : "meals"}</div>
        </div>

        {meals.length > 0 && (
          <div className="mb-4">
            <p className={`text-xs font-bold uppercase tracking-wide ${theme.textMuted} mb-2`}>Today's meals</p>
            <div className="space-y-2">
              {meals.map((m, i) => (
                <div key={i} className={`${theme.surface} rounded-lg p-3 flex items-center gap-2`}>
                  <button onClick={() => beginEditMeal(i)} className="flex-1 text-left">
                    <div className={`font-semibold text-sm ${theme.text}`}>{m.name}</div>
                    <div className={`text-[11px] ${theme.textMuted}`}>{m.kcal} kcal · P{m.p} F{m.f} C{m.c}</div>
                  </button>
                  <button onClick={() => removeMeal(i)} className="w-7 h-7 rounded-full flex items-center justify-center text-base text-red-500" style={{ backgroundColor: "#fef2f2" }}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className={`text-xs font-bold uppercase tracking-wide ${theme.textMuted} mb-2`}>Add a meal</p>
        <div className="grid grid-cols-3 gap-2 mb-3">
          {slotSuggestions.slice(0, 3).map(slot => {
            const exists = meals.find(m => m.name === slot);
            return (
              <button key={slot} onClick={() => beginAddMeal(slot)} className={`h-12 rounded-lg ${theme.surface} ${theme.surfaceText} font-semibold text-xs ${exists ? "opacity-50" : ""}`}>
                {exists ? "✓ " : "+ "}{slot}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          {slotSuggestions.slice(3).map(slot => {
            const exists = meals.find(m => m.name === slot);
            return (
              <button key={slot} onClick={() => beginAddMeal(slot)} className={`h-10 rounded-lg ${theme.surface} ${theme.surfaceText} font-medium text-[11px] ${exists ? "opacity-50" : ""}`}>
                {exists ? "✓ " : "+ "}{slot}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <button onClick={() => setMode("templates")} className={`h-11 rounded-lg ${theme.surface} ${theme.surfaceText} font-semibold text-xs flex items-center justify-center gap-1`}>
            Templates {templates.length > 0 && `(${templates.length})`}
          </button>
          <button onClick={() => setMode("estimate")} className="h-11 rounded-lg font-semibold text-xs text-white" style={{ backgroundColor: ORANGE }}>
            I don't know — estimate
          </button>
        </div>

        <button onClick={saveDay} disabled={meals.length === 0} className="w-full h-12 text-white rounded-xl font-semibold disabled:opacity-40" style={{ backgroundColor: NAVY }}>
          Save day{meals.length > 0 ? ` · ${total.kcal} kcal` : ""}
        </button>
      </Modal>
    );
  }

  // ===== UI: add/edit single meal =====
  if (mode === "addMeal") {
    return (
      <Modal title={editingIdx !== null ? "Edit meal" : "Add meal"} onClose={() => setMode("list")} theme={theme}>
        <TextInput label="Meal name" value={draft.name} setValue={v => setDraft({ ...draft, name: v })} placeholder="e.g. Breakfast, Chicken & rice, Pre-workout" theme={theme} />
        <NumInput label="Calories" value={draft.kcal} setValue={v => setDraft({ ...draft, kcal: v })} suffix="kcal" step={50} theme={theme} />
        <NumInput label="Protein" value={draft.p} setValue={v => setDraft({ ...draft, p: v })} suffix="g" step={5} theme={theme} />
        <NumInput label="Fat" value={draft.f} setValue={v => setDraft({ ...draft, f: v })} suffix="g" step={5} theme={theme} />
        <NumInput label="Carbs" value={draft.c} setValue={v => setDraft({ ...draft, c: v })} suffix="g" step={5} theme={theme} />

        <div className="grid grid-cols-2 gap-2 mb-2">
          <button onClick={() => { setMode("list"); setEditingIdx(null); }} className={`h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold text-sm`}>Cancel</button>
          <button onClick={commitMeal} className="h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>
            {editingIdx !== null ? "Update" : "Add"}
          </button>
        </div>

        <button onClick={() => setShowSaveTemplate(true)} disabled={draft.kcal === 0 && draft.p === 0}
          className={`w-full h-10 ${theme.surface} ${theme.surfaceText} rounded-lg text-xs font-semibold disabled:opacity-40`}>
          Save as template for re-use
        </button>

        {showSaveTemplate && (
          <div className={`mt-3 ${theme.surface} rounded-lg p-3`}>
            <p className={`text-xs ${theme.textMuted} mb-2`}>Save this meal as a reusable template</p>
            <TextInput label="Template name" value={templateName} setValue={setTemplateName} placeholder="e.g. Standard breakfast" theme={theme} />
            <div className="flex gap-2">
              <button onClick={() => setShowSaveTemplate(false)} className={`flex-1 h-10 ${theme.card} border ${theme.border} ${theme.text} rounded-lg text-sm font-semibold`}>Cancel</button>
              <button onClick={saveCurrentMealAsTemplate} disabled={!templateName.trim()} className="flex-1 h-10 text-white rounded-lg text-sm font-semibold disabled:opacity-50" style={{ backgroundColor: ORANGE }}>Save</button>
            </div>
          </div>
        )}
      </Modal>
    );
  }

  // ===== UI: templates browser =====
  if (mode === "templates") {
    return (
      <Modal title="Meal templates" onClose={() => setMode("list")} theme={theme}>
        <p className={`text-xs ${theme.textMuted} mb-3`}>Tap to add to today. Long-press × to delete.</p>
        {templates.length === 0 ? (
          <div className={`${theme.surface} rounded-lg p-4 text-center text-sm ${theme.textMuted}`}>
            No templates yet. Add a meal and tap "Save as template" to build your library.
          </div>
        ) : (
          <div className="space-y-2 mb-4">
            {templates.map(t => (
              <div key={t.id} className={`${theme.surface} rounded-lg p-3 flex items-center gap-2`}>
                <button onClick={() => addTemplate(t)} className="flex-1 text-left active:opacity-70">
                  <div className={`font-semibold text-sm ${theme.text}`}>{t.name}</div>
                  <div className={`text-[11px] ${theme.textMuted}`}>{t.kcal} kcal · P{t.p} F{t.f} C{t.c}</div>
                </button>
                <button onClick={() => deleteTemplate(t.id)} className="w-7 h-7 rounded-full flex items-center justify-center text-base text-red-500" style={{ backgroundColor: "#fef2f2" }}>×</button>
              </div>
            ))}
          </div>
        )}
        <button onClick={() => setMode("list")} className={`w-full h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Back</button>
      </Modal>
    );
  }

  // ===== UI: estimate from text =====
  return (
    <Modal title="Estimate macros" onClose={() => setMode("list")} theme={theme}>
      <p className={`text-xs ${theme.textMuted} mb-3`}>Type what you ate or drank in plain English.</p>
      <TextArea label="Food" value={foodText} setValue={setFoodText} placeholder="e.g. 2 slices pizza, side salad, banana" rows={3} theme={theme} />
      <TextArea label="🍺  Alcohol / drinks" value={drinkText} setValue={setDrinkText} placeholder="e.g. 4 pints of beer, 2 glasses red wine" rows={2} theme={theme} />

      <button onClick={() => setShowAlcoholRef(!showAlcoholRef)} className={`w-full h-10 ${theme.surface} ${theme.surfaceText} rounded-lg text-xs font-semibold mb-3`}>
        {showAlcoholRef ? "Hide" : "Show"} alcohol macro reference
      </button>
      {showAlcoholRef && (
        <div className={`${theme.surface} rounded-lg p-3 mb-3 max-h-48 overflow-y-auto`}>
          <div className="space-y-1.5">
            {ALCOHOL_DB.map(a => (
              <div key={a.name} className={`flex justify-between text-xs ${theme.surfaceText} py-1`}>
                <span className="flex-1">{a.name}</span>
                <span className="font-bold" style={{ color: ORANGE }}>~{a.kcal}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button onClick={runEstimate} disabled={!foodText.trim() && !drinkText.trim()}
        className="w-full h-12 text-white rounded-xl font-semibold mb-3 disabled:opacity-40"
        style={{ backgroundColor: NAVY }}>
        Estimate
      </button>

      {(foodEst || drinkEst) && (
        <div className="rounded-xl p-4 mb-3" style={{ backgroundColor: `${ORANGE}15`, border: `1px solid ${ORANGE}55` }}>
          <div className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: ORANGE }}>Estimate</div>
          {foodEst && <div className={`text-xs ${theme.textSubtle} mb-1`}>Food: {foodEst.items.join(", ")} → {foodEst.kcal} kcal</div>}
          {drinkEst && <div className={`text-xs ${theme.textSubtle} mb-2`}>Drinks: {drinkEst.items.join(", ")} → {drinkEst.kcal} kcal</div>}
          <div className={`pt-2 mt-2 border-t border-orange-200 text-base font-bold ${theme.text}`}>
            Total: ~{(foodEst?.kcal || 0) + (drinkEst?.kcal || 0)} kcal · P{(foodEst?.p || 0) + (drinkEst?.p || 0)} F{(foodEst?.f || 0) + (drinkEst?.f || 0)} C{(foodEst?.c || 0) + (drinkEst?.c || 0)}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => setMode("list")} className={`h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold text-sm`}>Cancel</button>
        <button onClick={applyEstimateAsMeal} disabled={!foodEst && !drinkEst} className="h-12 text-white rounded-xl font-semibold disabled:opacity-40" style={{ backgroundColor: ORANGE }}>
          Add as meal →
        </button>
      </div>
    </Modal>
  );
}

// ============================================================
// HISTORY (compact)
// ============================================================
// ============================================================
// PLAN TAB — 6-week boost calendar
// ============================================================
function getWeekKey(d) {
  const date = new Date(d); const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return date.toISOString().split("T")[0];
}
function getWeekDays(weekStart) {
  const days = []; const start = new Date(weekStart);
  for (let i = 0; i < 7; i++) { const d = new Date(start); d.setDate(d.getDate() + i); days.push(d); }
  return days;
}

function PlanTab({ session, profile, themeCtx }) {
  const { theme } = themeCtx;
  const baseTargets = useMemo(() => calculateTargets(profile), [profile]);
  const [weekOffset, setWeekOffset] = useState(0);
  const [boosts, setBoosts] = useState({});
  const [boostModal, setBoostModal] = useState(null);
  const [customTasks, setCustomTasks] = useState([]);
  const [blocks, setBlocks] = useState([]);

  // Load custom tasks + blocks once (used for per-day scheduling preview)
  useEffect(() => {
    (async () => {
      const taskStore = (await storage.get(userKey(session.id, "custom-tasks"))) || { tasks: [] };
      setCustomTasks(taskStore.tasks || []);
      setBlocks((await storage.get(userKey(session.id, "blocks"))) || []);
    })();
  }, [session.id]);

  // For per-day task counts on the calendar
  const activeBlockEndDate = useMemo(() => {
    const today = new Date().toISOString().split("T")[0];
    const current = blocks.find(b => b.startDate <= today && b.endDate >= today);
    return current?.endDate || null;
  }, [blocks]);

  const tasksScheduledFor = (dateStr) => {
    return customTasks.filter(t => taskIsActiveOn(t, dateStr, activeBlockEndDate));
  };

  const weekStart = useMemo(() => {
    const d = new Date(); d.setDate(d.getDate() + (weekOffset * 7));
    return getWeekKey(d);
  }, [weekOffset]);
  const days = getWeekDays(weekStart);

  const [allBoosts, setAllBoosts] = useState({}); // flat map across multiple weeks

  // Helper to compute week key for any date
  const weekKeyFor = (date) => {
    const d = new Date(date);
    return getWeekKey(d);
  };

  // Load boosts for current week + previous + next, so rolling math spans week boundaries
  useEffect(() => {
    (async () => {
      const prevWeek = new Date(weekStart); prevWeek.setDate(prevWeek.getDate() - 7);
      const nextWeek = new Date(weekStart); nextWeek.setDate(nextWeek.getDate() + 7);
      const keys = [weekKeyFor(prevWeek), weekStart, weekKeyFor(nextWeek)];
      const merged = {};
      for (const k of keys) {
        const b = await storage.get(userKey(session.id, `boost-week:${k}`));
        if (b?.byDay) Object.assign(merged, b.byDay);
      }
      setAllBoosts(merged);
      // boosts state holds CURRENT week only (for editing)
      const currentBoost = await storage.get(userKey(session.id, `boost-week:${weekStart}`));
      setBoosts(currentBoost?.byDay || {});
    })();
  }, [weekStart, session.id]);

  const calculateWeekPlan = () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const rollingWindow = profile.rollingWindow || 7;
    // Use the merged boost map (spans multiple weeks)
    const boostMap = allBoosts;
    const boostDays = Object.keys(boostMap);

    if (boostDays.length === 0) {
      return days.map(d => ({ date: d, target: baseTargets, isBoost: false }));
    }

    return days.map(d => {
      const ds = d.toISOString().split("T")[0];
      const dDate = new Date(ds); dDate.setHours(0, 0, 0, 0);
      const isPast = dDate < today;
      if (isPast) return { date: d, target: baseTargets, isBoost: false, isPast: true };

      // If this day is itself a boost, show that
      if (boostDays.includes(ds)) {
        const b = boostMap[ds];
        return { date: d, target: { calTarget: b.kcal, protein: b.protein, fat: b.fat, carbs: b.carbs }, isBoost: true };
      }

      // Look back N days. Boosts that fall in this window contribute their surplus.
      // Surplus is distributed across the rolling window, so each affected day takes (totalSurplus / N).
      let totalSurplus = 0;
      for (let back = 1; back <= rollingWindow; back++) {
        const lookback = new Date(ds); lookback.setDate(lookback.getDate() - back);
        const ls = lookback.toISOString().split("T")[0];
        if (boostDays.includes(ls)) {
          const b = boostMap[ls];
          totalSurplus += (b.kcal - baseTargets.calTarget);
        }
      }

      if (totalSurplus === 0) {
        return { date: d, target: baseTargets, isBoost: false };
      }

      const adjustment = -Math.round(totalSurplus / rollingWindow);
      const floor = profile.sex === "M" ? 1500 : 1200;
      const adjKcal = Math.max(floor, baseTargets.calTarget + adjustment);
      let p = baseTargets.protein, f = baseTargets.fat;
      let c = Math.round((adjKcal - 4 * p - 9 * f) / 4);
      if (c < 100) {
        const remForFat = adjKcal - 4 * p - 4 * 100;
        f = Math.max(Math.round(profile.weight * 0.5), Math.floor(remForFat / 9));
        c = Math.round((adjKcal - 4 * p - 9 * f) / 4);
        if (c < 50) c = 50;
      }
      return {
        date: d,
        target: { calTarget: adjKcal, protein: p, fat: f, carbs: c },
        isBoost: false,
        isAdjusted: adjustment !== 0,
        adjustment,
      };
    });
  };

  const weekPlan = calculateWeekPlan();
  const saveBoosts = async (newBoosts) => {
    setBoosts(newBoosts);
    // Update the merged map: keep adjacent-week boosts, replace this week's with new values
    setAllBoosts(prev => {
      const next = { ...prev };
      // Remove any current-week dates that no longer exist
      const currentWeekDates = days.map(d => d.toISOString().split("T")[0]);
      for (const k of currentWeekDates) {
        if (!newBoosts[k]) delete next[k];
      }
      // Add/update current week's boosts
      Object.assign(next, newBoosts);
      return next;
    });
    if (Object.keys(newBoosts).length === 0) await storage.delete(userKey(session.id, `boost-week:${weekStart}`));
    else await storage.set(userKey(session.id, `boost-week:${weekStart}`), { byDay: newBoosts });
  };

  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  return (
    <div className="pb-4">
      <div className="px-5 pt-10 pb-6 text-white relative overflow-hidden" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
        <img src={HERO_SPRINT_W_B64} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ opacity: 0.30, mixBlendMode: "luminosity" }} />
        <div className="relative">
          <Wordmark />
          <h1 className="text-2xl font-bold mt-3">6-week plan</h1>
          <p className="text-blue-100 text-sm mt-1">Tap a day to boost it for an event</p>
        </div>
      </div>
      <div className="px-4 pt-3 space-y-3">
        <div className={`${theme.card} rounded-2xl shadow-sm border ${theme.border} p-3 flex items-center gap-2 overflow-x-auto`}>
          {[0, 1, 2, 3, 4, 5].map(i => {
            const wd = new Date(); wd.setDate(wd.getDate() + (i * 7));
            const wkStart = new Date(getWeekKey(wd));
            const dateLabel = wkStart.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });
            return (
              <button key={i} onClick={() => setWeekOffset(i)}
                className={`px-3 h-12 rounded-lg font-medium text-sm whitespace-nowrap flex-shrink-0 flex flex-col items-center justify-center ${weekOffset === i ? "" : `${theme.surface} ${theme.surfaceText}`}`}
                style={{ backgroundColor: weekOffset === i ? NAVY : "", color: weekOffset === i ? "white" : "" }}>
                <span className="text-[10px] uppercase opacity-70">{i === 0 ? "This wk" : `Wk ${i + 1}`}</span>
                <span className="font-bold">{dateLabel}</span>
              </button>
            );
          })}
        </div>
        <div className="space-y-2">
          {weekPlan.map((day, i) => {
            const isToday = day.date.toISOString().split("T")[0] === new Date().toISOString().split("T")[0];
            const dayDateStr = day.date.toISOString().split("T")[0];
            const dayTasks = tasksScheduledFor(dayDateStr);
            return (
              <button key={i} onClick={() => setBoostModal(day)}
                className={`w-full p-3 rounded-xl border-2 flex items-center gap-3 text-left ${theme.card}`}
                style={{
                  borderColor: day.isBoost ? ORANGE : day.isAdjusted ? "#3b82f6" : isToday ? "#3b82f6" : "",
                  backgroundColor: day.isBoost ? `${ORANGE}15` : day.isAdjusted ? "#dbeafe50" : "",
                }}>
                <div className="w-12 text-center flex-shrink-0">
                  <div className={`text-[11px] uppercase tracking-wide ${theme.textMuted} font-medium`}>{dayLabels[i]}</div>
                  <div className={`text-xl font-bold ${theme.text}`}>{day.date.getDate()}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-base font-bold ${theme.text}`}>{day.target.calTarget.toLocaleString()} kcal</div>
                  <div className={`text-xs ${theme.textMuted} mt-0.5`}>P{day.target.protein} · F{day.target.fat} · C{day.target.carbs}</div>
                  {dayTasks.length > 0 && (
                    <div className={`text-[10px] mt-1 flex items-center gap-1`} style={{ color: ORANGE }}>
                      <BrandIcon name="task" size={11} color={ORANGE} strokeWidth={2} />
                      <span className="truncate">
                        {dayTasks.length === 1 ? dayTasks[0].name : `${dayTasks.length} tasks`}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex-shrink-0">
                  {day.isBoost ? <span className="text-xl">🍻</span>
                    : day.isAdjusted ? <span className="text-xl">📉</span>
                    : isToday ? <span className="text-xs font-bold px-2 py-1 rounded text-white" style={{ backgroundColor: ORANGE }}>TODAY</span>
                    : <span className={theme.textMuted}>→</span>}
                </div>
              </button>
            );
          })}
        </div>
        <div className="rounded-2xl p-4 text-sm" style={{ backgroundColor: `${ORANGE}15`, border: `1px solid ${ORANGE}55` }}>
          <p className={`font-semibold mb-1 ${theme.text}`}>How boosts work</p>
          <p className={`text-xs ${theme.textMuted} leading-relaxed`}>Tap any day to boost it (e.g. wedding, holiday meal). The other days that week automatically lower their calories to keep your weekly deficit on track. Protein stays constant.</p>
        </div>
      </div>
      {boostModal && <BoostModal day={boostModal} baseTargets={baseTargets} existingBoost={boosts[boostModal.date.toISOString().split("T")[0]]}
        profile={profile}
        theme={theme}
        onClose={() => setBoostModal(null)}
        onSave={async (kcal, protein, fat, carbs) => {
          const ds = boostModal.date.toISOString().split("T")[0];
          const next = { ...boosts };
          if (kcal === null) delete next[ds];
          else next[ds] = { kcal, protein, fat, carbs };
          await saveBoosts(next);
          setBoostModal(null);
        }} />}
    </div>
  );
}

function BoostModal({ day, baseTargets, existingBoost, profile, theme, onClose, onSave }) {
  const [kcal, setKcal] = useState(existingBoost?.kcal || baseTargets.calTarget + 800);
  const [protein, setProtein] = useState(existingBoost?.protein || baseTargets.protein);
  const [fat, setFat] = useState(existingBoost?.fat || Math.round((baseTargets.calTarget + 800) * 0.35 / 9));
  const [carbs, setCarbs] = useState(existingBoost?.carbs || Math.round((baseTargets.calTarget + 800 - 4 * baseTargets.protein - 9 * Math.round((baseTargets.calTarget + 800) * 0.35 / 9)) / 4));
  const [customAdd, setCustomAdd] = useState(0);
  const [showAlcoholRef, setShowAlcoholRef] = useState(false);
  const dateStr = day.date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  const minFloor = profile.sex === "M" ? 1500 : 1200;
  const baseFloor = baseTargets.calTarget;

  const applyBoost = (extra) => {
    const k = Math.max(minFloor, baseTargets.calTarget + extra);
    const f = Math.round(k * 0.35 / 9);
    const c = Math.round((k - 4 * baseTargets.protein - 9 * f) / 4);
    setKcal(k); setFat(f); setCarbs(c);
  };

  const handleSave = () => {
    if (kcal < minFloor) {
      alert(`Minimum allowed: ${minFloor} kcal/day. Your safety floor for ${profile.sex === "M" ? "men" : "women"}.`);
      return;
    }
    onSave(kcal, protein, fat, carbs);
  };

  return (
    <Modal title={`Boost — ${dateStr}`} onClose={onClose} theme={theme}>
      <p className={`text-xs ${theme.textMuted} mb-3`}>Got an event? Add calories here — the rest of the week redistributes.</p>

      {/* Quick presets */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[500, 1000, 1500].map(b => (
          <button key={b} onClick={() => applyBoost(b)} className={`h-12 rounded-lg ${theme.surface} ${theme.surfaceText} font-bold text-sm`}>+{b}</button>
        ))}
      </div>

      {/* Custom add amount */}
      <div className="mb-3">
        <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Or add a custom amount</label>
        <div className="flex items-center gap-2">
          <input type="number" inputMode="numeric" value={customAdd === 0 ? "" : customAdd}
            onChange={e => setCustomAdd(Number(e.target.value) || 0)}
            placeholder="e.g. 750"
            className={`flex-1 h-12 px-4 text-base font-medium border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg`} />
          <button onClick={() => { if (customAdd > 0) applyBoost(customAdd); }}
            className="h-12 px-5 text-white rounded-lg font-semibold text-sm"
            style={{ backgroundColor: NAVY }}>
            Apply
          </button>
        </div>
      </div>

      {/* Alcohol reference toggle */}
      <button onClick={() => setShowAlcoholRef(!showAlcoholRef)}
        className="w-full h-11 rounded-lg text-xs font-semibold mb-3 flex items-center justify-center gap-2"
        style={{ backgroundColor: `${ORANGE}15`, color: ORANGE, border: `1px solid ${ORANGE}55` }}>
        🍺 {showAlcoholRef ? "Hide" : "Show"} alcohol calorie guide
      </button>
      {showAlcoholRef && (
        <div className={`${theme.surface} rounded-lg p-3 mb-3 max-h-56 overflow-y-auto`}>
          <p className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-2`}>Add this many calories per drink</p>
          <div className="space-y-1">
            {ALCOHOL_DB.map(a => (
              <div key={a.name} className={`flex justify-between text-xs ${theme.surfaceText} py-1 border-b border-slate-200/30`}>
                <span className="flex-1 truncate pr-2">{a.name}</span>
                <span className="font-bold" style={{ color: ORANGE }}>~{a.kcal} kcal</span>
              </div>
            ))}
          </div>
          <p className={`text-[10px] ${theme.textMuted} mt-2 italic`}>Tip: 4 pints = +800kcal. Bottle of wine = +625kcal.</p>
        </div>
      )}

      <NumInput label="Total calories" value={kcal} setValue={setKcal} suffix="kcal" step={100} theme={theme} />

      {/* Min floor warning */}
      {kcal < minFloor && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg p-2.5 mb-3">
          Below minimum safety floor of {minFloor} kcal/day. Won't save.
        </div>
      )}
      {kcal >= minFloor && kcal < baseFloor && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg p-2.5 mb-3">
          ℹ️ This is a "down day" — below your normal {baseFloor} kcal target.
        </div>
      )}

      <NumInput label="Protein" value={protein} setValue={setProtein} suffix="g" step={5} theme={theme} />
      <NumInput label="Fat" value={fat} setValue={setFat} suffix="g" step={5} theme={theme} />
      <NumInput label="Carbs" value={carbs} setValue={setCarbs} suffix="g" step={5} theme={theme} />
      <div className="flex gap-2 mt-2">
        {existingBoost && <button onClick={() => onSave(null)} className="flex-1 h-12 bg-red-50 border border-red-200 text-red-700 rounded-xl font-semibold">Remove</button>}
        <button onClick={handleSave} disabled={kcal < minFloor}
          className="flex-1 h-12 text-white rounded-xl font-semibold disabled:opacity-40"
          style={{ backgroundColor: ORANGE }}>
          {existingBoost ? "Update" : "Add boost"}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================
// HISTORY (compact)
// ============================================================
function History({ session, profile, themeCtx, hideHeader }) {
  const { theme } = themeCtx;
  const [section, setSection] = useState("logs");
  const [logs, setLogs] = useState({});
  const [blocks, setBlocks] = useState([]);
  const [expandedBlocks, setExpandedBlocks] = useState(new Set());

  useEffect(() => {
    (async () => {
      setLogs((await storage.get(userKey(session.id, "logs"))) || {});
      const allBlocks = await ensureCurrentBlock(session.id, profile);
      setBlocks(allBlocks);
      // By default expand the most recent (current) block
      const current = getCurrentBlock(allBlocks);
      if (current) setExpandedBlocks(new Set([current.id]));
    })();
  }, [session.id, profile]);

  const sortedDates = Object.keys(logs).filter(d => logs[d].food).sort().reverse();
  const weights = sortedDates.map(d => logs[d]).filter(l => l.weight && l.weightValue);

  // Group days by block (most recent block first)
  const blocksByDate = useMemo(() => {
    if (blocks.length === 0) return [];
    const sorted = [...blocks].sort((a, b) => b.startDate.localeCompare(a.startDate));
    return sorted.map(b => {
      const blockDays = sortedDates.filter(d => {
        return d >= b.startDate && (!b.endDate || d < b.endDate);
      });
      // Block summary stats
      const days = blockDays.map(d => logs[d]).filter(l => l.kcalEaten);
      const avgKcal = days.length ? Math.round(days.reduce((s, l) => s + l.kcalEaten, 0) / days.length) : 0;
      const adherence = days.length ? Math.round((days.filter(l => Math.abs(l.kcalEaten - b.calTarget) < 200).length / days.length) * 100) : 0;
      const blockNum = getBlockNumber(blocks, b.id);
      return { ...b, blockNum, blockDays, avgKcal, adherence };
    });
  }, [blocks, logs, sortedDates]);

  const toggleBlock = (id) => {
    const next = new Set(expandedBlocks);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedBlocks(next);
  };

  return (
    <div className="pb-4">
      {!hideHeader && (
        <div className="px-5 pt-10 pb-6 text-white" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
          <Wordmark />
          <h1 className="text-2xl font-bold mt-3">History</h1>
          <p className="text-blue-100 text-sm mt-1">{sortedDates.length} days · {blocks.length} {blocks.length === 1 ? "block" : "blocks"}</p>
        </div>
      )}

      <div className={hideHeader ? "" : "px-4 pt-3"}>
        <div className={`${theme.card} rounded-2xl shadow-sm border ${theme.border} p-1.5 grid grid-cols-4 gap-1`}>
          {[{ id: "logs", l: "Logs" }, { id: "weight", l: "Weight" }, { id: "body", l: "Body" }, { id: "review", l: "Review" }].map(s => (
            <button key={s.id} onClick={() => setSection(s.id)} className="h-10 rounded-lg font-semibold text-xs"
              style={{ backgroundColor: section === s.id ? NAVY : "", color: section === s.id ? "white" : "" }}>
              <div className={section === s.id ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{s.l}</div>
            </button>
          ))}
        </div>
      </div>

      <div className={hideHeader ? "mt-3 space-y-3" : "px-4 mt-4 space-y-3"}>
        {section === "logs" && (
          <>
            {blocksByDate.length === 0 ? (
              <div className={`${theme.card} rounded-2xl border ${theme.border} p-5 text-center text-sm ${theme.textMuted}`}>
                No logs yet. Start tracking and your history will appear here grouped by training block.
              </div>
            ) : blocksByDate.map(b => {
              const isOpen = expandedBlocks.has(b.id);
              const isCurrent = !b.endDate;
              const startLabel = new Date(b.startDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
              const endLabel = b.endDate ? new Date(b.endDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" }) : "now";
              return (
                <div key={b.id} className={`${theme.card} rounded-2xl border-2 overflow-hidden`} style={{ borderColor: isCurrent ? ORANGE : "" }}>
                  {/* Block header */}
                  <button onClick={() => toggleBlock(b.id)} className={`w-full p-4 flex items-center justify-between active:opacity-70 ${isCurrent ? "" : theme.border}`}
                    style={{ backgroundColor: isCurrent ? `${ORANGE}10` : "" }}>
                    <div className="text-left">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[9px] font-bold tracking-wide px-1.5 py-0.5 rounded" style={{ backgroundColor: ORANGE, color: "white" }}>BLOCK {b.blockNum}</span>
                        <span className={`text-sm font-bold ${theme.text}`}>{b.phase}</span>
                        {isCurrent && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: "#10b981", color: "white" }}>CURRENT</span>}
                      </div>
                      <div className={`text-[11px] ${theme.textMuted}`}>
                        {startLabel} → {endLabel} · {b.calTarget.toLocaleString()} kcal
                      </div>
                    </div>
                    <div className={`text-base ${theme.textMuted} transition-transform`} style={{ transform: isOpen ? "rotate(90deg)" : "" }}>›</div>
                  </button>
                  {isOpen && (
                    <>
                      {/* Block summary stats */}
                      <div className={`px-4 py-3 grid grid-cols-3 gap-3 text-center border-t ${theme.border}`}>
                        <div>
                          <div className={`text-[9px] uppercase ${theme.textMuted} font-bold`}>Days</div>
                          <div className={`text-base font-bold ${theme.text}`}>{b.blockDays.length}</div>
                        </div>
                        <div>
                          <div className={`text-[9px] uppercase ${theme.textMuted} font-bold`}>Avg kcal</div>
                          <div className={`text-base font-bold ${theme.text}`}>{b.avgKcal ? b.avgKcal.toLocaleString() : "—"}</div>
                        </div>
                        <div>
                          <div className={`text-[9px] uppercase ${theme.textMuted} font-bold`}>Adherence</div>
                          <div className="text-base font-bold" style={{ color: b.adherence >= 70 ? "#10b981" : b.adherence >= 40 ? ORANGE : "#ef4444" }}>{b.adherence}%</div>
                        </div>
                      </div>
                      {/* Daily entries within this block */}
                      <div className={`px-4 pb-4 space-y-1.5 border-t ${theme.border} pt-3`}>
                                                {b.blockDays.length === 0 ? (
                          <div className={`text-xs ${theme.textMuted} text-center py-2`}>No logged days in this block.</div>
                        ) : b.blockDays.slice(0, 14).map(d => {
                          const log = { kcalEaten: 0, proteinEaten: 0, fatEaten: 0, carbsEaten: 0, ...(logs[d] || {}) };
                          const diff = log.kcalEaten - b.calTarget;
                          // Goal-aware colouring
                          // - Cut: under target = good (green), at target = good, over = bad (red)
                          // - Lean Bulk / Bulk: above target = good (green), at target = good, under = bad (red)
                          // - Maintain / Recomp: within ±200 = good, outside in either direction = warning
                          const phaseLower = (b.phase || "").toLowerCase();
                          let kcalColor;
                          if (phaseLower.includes("cut")) {
                            kcalColor = diff <= 100 ? "#10b981" : diff <= 300 ? "#f59e0b" : "#ef4444";
                          } else if (phaseLower.includes("bulk")) {
                            kcalColor = diff >= -100 ? "#10b981" : diff >= -300 ? "#f59e0b" : "#ef4444";
                          } else {
                            // Maintain / Recomp / unknown — symmetric tolerance
                            kcalColor = Math.abs(diff) < 200 ? "#10b981" : Math.abs(diff) < 400 ? "#f59e0b" : "#ef4444";
                          }
                          // Protein adequacy — goal-agnostic. Target = 1.8 g/kg bodyweight (or fall back to profile.weight or 70kg).
                          const proteinTarget = Math.round((profile.weight || 70) * 1.8);
                          const pPct = proteinTarget > 0 ? (log.proteinEaten / proteinTarget) : 0;
                          const proteinColor = pPct >= 0.9 ? "#10b981" : pPct >= 0.7 ? "#f59e0b" : "#ef4444";
                          return (
                            <div key={d} className={`flex items-center justify-between p-2.5 ${theme.surface} rounded-lg`}>
                              <div>
                                <div className={`text-sm font-semibold ${theme.text}`}>{new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</div>
                                <div className={`text-[11px] ${theme.textMuted}`}>
                                  <span style={{ color: proteinColor, fontWeight: 600 }}>P{log.proteinEaten}</span>
                                  <span> · F{log.fatEaten} · C{log.carbsEaten}</span>
                                </div>
                              </div>
                              <div className="text-right">
                                <div className={`font-bold ${theme.text}`}>{log.kcalEaten.toLocaleString()}</div>
                                <div className="text-[10px] font-semibold" style={{ color: kcalColor }}>{diff > 0 ? "+" : ""}{diff}</div>
                              </div>
                            </div>
                          );
                        })}
                        {b.blockDays.length > 14 && (
                          <div className={`text-[10px] ${theme.textMuted} text-center pt-2 italic`}>+ {b.blockDays.length - 14} more days</div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </>
        )}
        {section === "weight" && weights.length > 1 && (() => {
          const start = weights[weights.length - 1].weightValue;
          const now = weights[0].weightValue;
          const change = now - start;
          // Goal-aware: cut wants change negative, bulk wants positive, maintain wants ~0
          const goal = (profile.goal || "").toLowerCase();
          let weightColor = "#94a3b8"; // grey neutral default
          if (goal.includes("cut") || goal.includes("loss")) {
            weightColor = change < -0.2 ? "#10b981" : change < 0.2 ? "#f59e0b" : "#ef4444";
          } else if (goal.includes("bulk") || goal.includes("gain")) {
            weightColor = change > 0.2 ? "#10b981" : change > -0.2 ? "#f59e0b" : "#ef4444";
          } else {
            // Maintain / Recomp — within ±0.5kg is good
            weightColor = Math.abs(change) <= 0.5 ? "#10b981" : Math.abs(change) <= 1.5 ? "#f59e0b" : "#ef4444";
          }
          return (
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
              <h3 className={`font-semibold mb-3 ${theme.text}`}>Weight</h3>
              <div className="grid grid-cols-3 gap-3 text-center mb-3">
                <div><div className={`text-[10px] ${theme.textMuted} uppercase`}>Start</div><div className={`text-xl font-bold ${theme.text}`}>{start.toFixed(1)}</div></div>
                <div><div className={`text-[10px] ${theme.textMuted} uppercase`}>Now</div><div className={`text-xl font-bold ${theme.text}`}>{now.toFixed(1)}</div></div>
                <div><div className={`text-[10px] ${theme.textMuted} uppercase`}>Change</div><div className="text-xl font-bold" style={{ color: weightColor }}>{change > 0 ? "+" : ""}{change.toFixed(1)}</div></div>
              </div>
              <Sparkline data={weights.slice().reverse().map(w => w.weightValue)} target={profile.targetWeight} />
            </div>
          );
        })()}
        {section === "weight" && weights.length <= 1 && (
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-5 text-sm ${theme.textMuted} text-center`}>Need more weight data to show trend.</div>
        )}
        {section === "body" && <BodyMeasurements session={session} themeCtx={themeCtx} />}
        {section === "review" && <WeeklyReview session={session} profile={profile} themeCtx={themeCtx} />}
      </div>
    </div>
  );
}

// ============================================================
// BODY MEASUREMENTS
// ============================================================
function BodyMeasurements({ session, themeCtx }) {
  const { theme } = themeCtx;
  const [history, setHistory] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [m, setM] = useState({ waist: 0, chest: 0, leftArm: 0, rightArm: 0, leftThigh: 0, rightThigh: 0, hip: 0 });

  useEffect(() => {
    storage.list(userKey(session.id, "measure:")).then(async keys => {
      const data = await Promise.all(keys.map(k => storage.get(k).then(v => ({ date: k.split(":measure:")[1], ...v }))));
      setHistory(data.filter(d => d).sort((a, b) => b.date.localeCompare(a.date)));
    });
  }, [session.id]);

  const save = async () => {
    const today = new Date().toISOString().split("T")[0];
    await storage.set(userKey(session.id, `measure:${today}`), m);
    const keys = await storage.list(userKey(session.id, "measure:"));
    const data = await Promise.all(keys.map(k => storage.get(k).then(v => ({ date: k.split(":measure:")[1], ...v }))));
    setHistory(data.filter(d => d).sort((a, b) => b.date.localeCompare(a.date)));
    setShowLog(false);
  };

  const latest = history[0];
  const prev = history[1];

  return (
    <div className="space-y-3">
      <button onClick={() => setShowLog(true)} className="w-full h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>+ Log measurements</button>
      {latest ? (
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
          <h3 className={`font-semibold mb-3 ${theme.text}`}>Latest <span className={`text-xs font-normal ${theme.textMuted}`}>({latest.date})</span></h3>
          <div className="grid grid-cols-2 gap-3">
            {[
              { key: "waist", label: "Waist" }, { key: "chest", label: "Chest" }, { key: "hip", label: "Hips" },
              { key: "leftArm", label: "Left arm" }, { key: "rightArm", label: "Right arm" },
              { key: "leftThigh", label: "Left thigh" }, { key: "rightThigh", label: "Right thigh" },
            ].map(({ key, label }) => {
              const cur = latest[key], old = prev?.[key];
              const diff = (cur && old) ? cur - old : null;
              return (
                <div key={key} className={`${theme.surface} rounded-lg p-3`}>
                  <div className={`text-[10px] ${theme.textMuted} uppercase tracking-wide`}>{label}</div>
                  <div className={`text-lg font-bold ${theme.text}`}>{cur ? `${cur} cm` : "—"}</div>
                  {diff !== null && diff !== 0 && (
                    <div className="text-[11px] font-semibold" style={{ color: diff < 0 ? "#10b981" : ORANGE }}>{diff > 0 ? "+" : ""}{diff.toFixed(1)} cm</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-5 text-sm ${theme.textMuted} text-center`}>
          No measurements yet. Track waist weekly — it's a better fat-loss indicator than the scale.
        </div>
      )}
      {history.length > 1 && (
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
          <h3 className={`font-semibold mb-3 ${theme.text}`}>History</h3>
          <div className="space-y-2 text-sm">
            {history.slice(0, 8).map(h => (
              <div key={h.date} className="flex justify-between">
                <span className={theme.textMuted}>{h.date}</span>
                <span className={`font-medium ${theme.text}`}>Waist {h.waist || "—"} cm</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {showLog && (
        <Modal title="Log measurements" onClose={() => setShowLog(false)} theme={theme}>
          <p className={`text-xs ${theme.textMuted} mb-3`}>All in cm. Skip any you don't measure.</p>
          <NumInput label="Waist" value={m.waist} setValue={v => setM({ ...m, waist: v })} suffix="cm" step={0.5} theme={theme} />
          <NumInput label="Chest" value={m.chest} setValue={v => setM({ ...m, chest: v })} suffix="cm" step={0.5} theme={theme} />
          <NumInput label="Hips" value={m.hip} setValue={v => setM({ ...m, hip: v })} suffix="cm" step={0.5} theme={theme} />
          <NumInput label="Left arm" value={m.leftArm} setValue={v => setM({ ...m, leftArm: v })} suffix="cm" step={0.5} theme={theme} />
          <NumInput label="Right arm" value={m.rightArm} setValue={v => setM({ ...m, rightArm: v })} suffix="cm" step={0.5} theme={theme} />
          <NumInput label="Left thigh" value={m.leftThigh} setValue={v => setM({ ...m, leftThigh: v })} suffix="cm" step={0.5} theme={theme} />
          <NumInput label="Right thigh" value={m.rightThigh} setValue={v => setM({ ...m, rightThigh: v })} suffix="cm" step={0.5} theme={theme} />
          <button onClick={save} className="w-full h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// WEEKLY REVIEW with recommendations
// ============================================================
function WeeklyReview({ session, profile, themeCtx }) {
  const { theme } = themeCtx;
  const [logs, setLogs] = useState({});
  const targets = useMemo(() => calculateTargets(profile), [profile]);

  useEffect(() => { storage.get(userKey(session.id, "logs")).then(v => setLogs(v || {})); }, [session.id]);

  const dates = Object.keys(logs).sort().reverse();
  const last7 = dates.slice(0, 7).map(d => ({ date: d, ...logs[d] }));
  const prev7 = dates.slice(7, 14).map(d => ({ date: d, ...logs[d] }));

  const avg = (arr, key) => {
    const vals = arr.filter(d => d[key]).map(d => d[key]);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const avgWt7 = avg(last7.filter(d => d.weight), "weightValue");
  const avgWt14 = avg(prev7.filter(d => d.weight), "weightValue");
  const wtChange = avgWt7 && avgWt14 ? avgWt7 - avgWt14 : null;
  const avgKcal = avg(last7.filter(d => d.food), "kcalEaten");
  const adherence = last7.length ? Math.round((last7.filter(d => d.food && Math.abs(d.kcalEaten - targets.calTarget) < 200).length / last7.length) * 100) : 0;
  const workouts = last7.filter(d => d.workout).length;

  // Recommendation engine
  let rec = "Need 2 weeks of data for a recommendation.", recColor = "bg-slate-50 border-slate-200 text-slate-700";
  if (wtChange !== null) {
    if (targets.ratePerWeekKg < 0) {
      // Cutting
      if (wtChange >= 0) { rec = "Stalled this week. Try reducing daily calories by 100 OR adding 1,500 steps."; recColor = "bg-amber-50 border-amber-200 text-amber-900"; }
      else if (wtChange < targets.ratePerWeekKg * 1.5) { rec = "Losing too fast. Increase calories by 150/day to protect muscle."; recColor = "bg-amber-50 border-amber-200 text-amber-900"; }
      else { rec = "On track — keep doing what you're doing."; recColor = "bg-emerald-50 border-emerald-200 text-emerald-900"; }
    } else if (targets.ratePerWeekKg > 0) {
      if (wtChange <= 0) { rec = "Not gaining as expected. Increase calories by 150/day."; recColor = "bg-amber-50 border-amber-200 text-amber-900"; }
      else { rec = "On track — keep going."; recColor = "bg-emerald-50 border-emerald-200 text-emerald-900"; }
    } else {
      rec = `Maintaining. Weekly change: ${wtChange > 0 ? "+" : ""}${wtChange.toFixed(2)}kg.`; recColor = "bg-emerald-50 border-emerald-200 text-emerald-900";
    }
  }

  return (
    <div className="space-y-3">
      <div className={`border-2 rounded-2xl p-4 ${recColor}`}>
        <h3 className="font-semibold text-sm mb-1">This week's recommendation</h3>
        <p className="text-sm leading-relaxed">{rec}</p>
      </div>
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
        <h3 className={`font-semibold mb-3 ${theme.text}`}>7-day summary</h3>
        <div className="space-y-2 text-sm">
          {/* Days logged: 7/7 = green, 5-6 = amber, <5 = red */}
          {(() => {
            const daysLogged = last7.filter(d => d.food).length;
            const daysColor = daysLogged >= 7 ? "#10b981" : daysLogged >= 5 ? "#f59e0b" : "#ef4444";
            return <Row theme={theme} l="Days food logged" v={`${daysLogged} / 7`} valueColor={daysColor} />;
          })()}
          {/* Adherence already tiered */}
          <Row theme={theme} l="Adherence" v={`${adherence}%`}
            valueColor={adherence >= 70 ? "#10b981" : adherence >= 40 ? "#f59e0b" : "#ef4444"} />
          {/* Avg calories — within ±150 = green, ±300 = amber, beyond = red */}
          {(() => {
            if (!avgKcal) return <Row theme={theme} l="Avg calories" v="—" />;
            const diff = Math.abs(avgKcal - targets.calTarget);
            const c = diff < 150 ? "#10b981" : diff < 300 ? "#f59e0b" : "#ef4444";
            return <Row theme={theme} l="Avg calories" v={`${Math.round(avgKcal).toLocaleString()} / ${targets.calTarget.toLocaleString()}`} valueColor={c} />;
          })()}
          <Row theme={theme} l="Avg weight" v={avgWt7 ? `${avgWt7.toFixed(1)} kg` : "—"} />
          {/* Weekly change — colour by goal direction match */}
          {(() => {
            if (wtChange === null) return <Row theme={theme} l="Weekly change" v="—" />;
            // Compare actual change vs target rate. Within 50% of target rate = green; opposite direction or >2x rate = red.
            let c = "#94a3b8";
            const tgt = targets.ratePerWeekKg;
            if (tgt < 0) {
              // Cutting target
              c = wtChange <= tgt * 0.5 ? "#10b981" : wtChange <= 0 ? "#f59e0b" : "#ef4444";
            } else if (tgt > 0) {
              // Bulk target
              c = wtChange >= tgt * 0.5 ? "#10b981" : wtChange >= 0 ? "#f59e0b" : "#ef4444";
            } else {
              // Maintain
              c = Math.abs(wtChange) <= 0.2 ? "#10b981" : Math.abs(wtChange) <= 0.5 ? "#f59e0b" : "#ef4444";
            }
            return <Row theme={theme} l="Weekly change" v={`${wtChange > 0 ? "+" : ""}${wtChange.toFixed(2)} kg (target ${tgt > 0 ? "+" : ""}${tgt})`} valueColor={c} />;
          })()}
          {/* Workouts: hit target = green, missed by 1 = amber, missed by 2+ = red */}
          {(() => {
            const tgt = profile.daysPerWeek;
            const missed = tgt - workouts;
            const c = missed <= 0 ? "#10b981" : missed === 1 ? "#f59e0b" : "#ef4444";
            return <Row theme={theme} l="Workouts" v={`${workouts} / ${tgt}`} valueColor={c} />;
          })()}
        </div>
      </div>
    </div>
  );
}

function Sparkline({ data, target }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data, target ?? Infinity) - 0.5;
  const max = Math.max(...data, target ?? -Infinity) + 0.5;
  const range = max - min || 1;
  const w = 320, h = 80;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      {target !== null && (() => {
        const ty = h - ((target - min) / range) * h;
        return <line x1="0" y1={ty} x2={w} y2={ty} stroke={ORANGE} strokeWidth="1.5" strokeDasharray="3,3" />;
      })()}
      <polyline fill="none" stroke={NAVY} strokeWidth="2.5" points={pts} />
      {data.map((v, i) => <circle key={i} cx={(i / (data.length - 1)) * w} cy={h - ((v - min) / range) * h} r="2" fill={NAVY} />)}
    </svg>
  );
}

function TrainingPreview({ profile, themeCtx, session }) {
  const { theme } = themeCtx;
  const [lifts, setLifts] = useState({});
  const [completions, setCompletions] = useState({});
  const today = new Date().toISOString().split("T")[0];
  const [viewDate, setViewDate] = useState(today);
  // editingSet = { exerciseName, setIndex, draft: {weight, reps, rir} } or null
  const [editingSet, setEditingSet] = useState(null);

  useEffect(() => {
    (async () => {
      setLifts((await storage.get(userKey(session.id, "lifts"))) || {});
      setCompletions((await storage.get(userKey(session.id, "session-completions"))) || {});
    })();
  }, [session.id]);

  const isViewingToday = viewDate === today;
  const stepDate = (delta) => {
    const d = new Date(viewDate); d.setDate(d.getDate() + delta);
    const next = d.toISOString().split("T")[0];
    if (next > today) return;
    setViewDate(next);
  };

  // Modify (or delete) a single set in the lifts store. setIndex < 0 → add new set.
  // setUpdate === null → delete the set.
  const updateSet = async (exerciseName, setIndex, setUpdate) => {
    const next = { ...lifts };
    if (!next[exerciseName]) return;
    next[exerciseName] = { ...next[exerciseName], history: [...(next[exerciseName].history || [])] };
    const sessionIdx = next[exerciseName].history.findIndex(s => s.date === viewDate);
    if (sessionIdx === -1) return;
    const sessionCopy = { ...next[exerciseName].history[sessionIdx], sets: [...next[exerciseName].history[sessionIdx].sets] };
    if (setUpdate === null) {
      // Delete the set
      sessionCopy.sets.splice(setIndex, 1);
    } else if (setIndex < 0) {
      // Append new set
      sessionCopy.sets.push(setUpdate);
    } else {
      // Replace
      sessionCopy.sets[setIndex] = setUpdate;
    }
    // If session has no sets left, remove the session entry entirely
    if (sessionCopy.sets.length === 0) {
      next[exerciseName].history.splice(sessionIdx, 1);
    } else {
      next[exerciseName].history[sessionIdx] = sessionCopy;
    }
    await storage.set(userKey(session.id, "lifts"), next);
    setLifts(next);
  };

  // Build "what was logged on viewDate" from the lifts data: each lift has a
  // history of sessions, each with a date. Pull out all sets logged on viewDate
  // across all exercises.
  const sessionForDate = useMemo(() => {
    const exercises = [];
    Object.entries(lifts).forEach(([name, data]) => {
      const session = (data.history || []).find(s => s.date === viewDate);
      if (session && session.sets && session.sets.length > 0) {
        exercises.push({ name, sets: session.sets });
      }
    });
    return exercises;
  }, [lifts, viewDate]);

  // Find the most recent session date (for "Jump to last workout")
  const lastSessionDate = useMemo(() => {
    let latest = "";
    Object.values(lifts).forEach(d => {
      (d.history || []).forEach(s => {
        if (s.date && s.date > latest && s.date <= today && s.sets?.length > 0) latest = s.date;
      });
    });
    return latest;
  }, [lifts, today]);

  // List of all dates with logged exercises, for the date-list view
  const datesWithSessions = useMemo(() => {
    const set = new Set();
    Object.values(lifts).forEach(d => {
      (d.history || []).forEach(s => { if (s.sets?.length > 0) set.add(s.date); });
    });
    return Array.from(set).sort().reverse();
  }, [lifts]);

  return (
    <div className="pb-4">
      <div className="relative overflow-hidden text-white" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
        <div className="absolute inset-0" style={{
          backgroundImage: `url(${HERO_SQUAT_B64})`,
          backgroundSize: "cover",
          backgroundPosition: "center right",
          opacity: 0.35,
          mixBlendMode: "luminosity",
        }} />
        <div className="absolute inset-0" style={{
          background: `linear-gradient(90deg, ${theme.headerStart}ee 0%, ${theme.headerStart}aa 50%, ${theme.headerEnd}55 100%)`,
        }} />
        <div className="relative px-5 pt-10 pb-6">
          <Wordmark />
          <h1 className="text-2xl font-bold mt-3">Training</h1>
          <p className="text-blue-100 text-sm mt-1">{profile.split} · {profile.daysPerWeek} days</p>
        </div>
      </div>
      <div className="px-4 pt-3 space-y-3">

        {/* Date stepper — same pattern as Food tab */}
        <div className={`flex items-center justify-between ${theme.card} rounded-xl border ${theme.border} p-2`}>
          <button onClick={() => stepDate(-1)} className={`w-10 h-10 ${theme.surface} ${theme.surfaceText} rounded-lg font-bold`}>‹</button>
          <div className="text-center">
            <div className={`text-sm font-bold ${theme.text}`}>
              {isViewingToday ? "Today" : new Date(viewDate).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}
            </div>
            {!isViewingToday && (
              <button onClick={() => setViewDate(today)} className="text-[10px] underline" style={{ color: ORANGE }}>Jump to today</button>
            )}
            {isViewingToday && sessionForDate.length === 0 && lastSessionDate && (
              <button onClick={() => setViewDate(lastSessionDate)} className="text-[10px] underline" style={{ color: ORANGE }}>Last workout: {new Date(lastSessionDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</button>
            )}
          </div>
          <button onClick={() => stepDate(1)} disabled={isViewingToday}
            className={`w-10 h-10 ${theme.surface} ${theme.surfaceText} rounded-lg font-bold disabled:opacity-30`}>›</button>
        </div>

        {/* Session for this date */}
        {sessionForDate.length === 0 ? (
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-6 text-center`}>
            <div className="mb-3 flex justify-center">
              <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ backgroundColor: `${ORANGE}1a` }}>
                <BrandIcon name="workout" size={28} color={ORANGE} strokeWidth={1.6} />
              </div>
            </div>
            <h3 className={`font-bold text-base mb-2 ${theme.text}`}>
              {isViewingToday ? "No workout logged yet today" : "Rest day"}
            </h3>
            <p className={`text-xs ${theme.textMuted} leading-relaxed`}>
              {isViewingToday
                ? "Log a workout in the standalone Training artifact. Sets are written here automatically and viewable on past dates."
                : "Nothing was logged on this day."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className={`text-[10px] font-bold uppercase tracking-wider ${theme.textMuted} px-1`}>
              {sessionForDate.length} {sessionForDate.length === 1 ? "exercise" : "exercises"} · {sessionForDate.reduce((sum, e) => sum + e.sets.length, 0)} total sets
            </div>
            {sessionForDate.map((ex, idx) => {
              const totalVolume = ex.sets.reduce((sum, s) => {
                const base = (s.weight || 0) * (s.reps || 0);
                const dropV = (s.drops || []).reduce((d, x) => d + (x.weight || 0) * (x.reps || 0), 0);
                return sum + base + dropV;
              }, 0);
              return (
                <div key={idx} className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
                  <div className="flex items-start justify-between mb-2">
                    <h4 className={`font-bold text-sm ${theme.text}`}>{ex.name}</h4>
                    <span className={`text-[10px] font-semibold ${theme.textMuted}`}>{totalVolume.toLocaleString()} kg vol</span>
                  </div>
                  <div className="space-y-1">
                    {ex.sets.map((s, si) => (
                      <div key={si}>
                        <button
                          onClick={() => setEditingSet({ exerciseName: ex.name, setIndex: si, draft: { weight: s.weight, reps: s.reps, rir: s.rir ?? 2 } })}
                          className={`w-full flex items-center justify-between p-2 ${theme.surface} rounded-lg text-xs active:opacity-70`}>
                          <span className={`font-bold ${theme.text} w-12 text-left flex items-center gap-1`}>
                            Set {si + 1}
                            {s.drops?.length > 0 && (
                              <span className="text-[8px] font-bold px-1 py-0.5 rounded" style={{ backgroundColor: "#15803d33", color: "#15803d" }}>+{s.drops.length}D</span>
                            )}
                          </span>
                          <span className={`flex-1 text-center ${theme.text}`}>{s.weight}kg × {s.reps} reps</span>
                          <span className={`w-16 text-right text-[10px] font-semibold ${s.rir === 0 ? "text-red-500" : theme.textMuted}`}>
                            RIR {s.rir != null ? s.rir : "—"} ›
                          </span>
                        </button>
                        {/* Drops rendered inline beneath the set */}
                        {s.drops?.length > 0 && (
                          <div className="ml-12 mt-0.5 space-y-0.5">
                            {s.drops.map((d, di) => (
                              <div key={di} className="flex items-center gap-1.5 text-[10px]" style={{ color: "#15803d" }}>
                                <span>↳</span>
                                <span className="font-semibold">Drop {di + 1}:</span>
                                <span>{d.weight}kg × {d.reps} reps</span>
                                <span style={{ opacity: 0.7 }}>({(d.weight * d.reps).toLocaleString()}kg)</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                    <button onClick={() => {
                      // Seed new set with the last set's values for convenience
                      const last = ex.sets[ex.sets.length - 1] || { weight: 20, reps: 8, rir: 2 };
                      setEditingSet({ exerciseName: ex.name, setIndex: -1, draft: { weight: last.weight, reps: last.reps, rir: last.rir ?? 2 } });
                    }} className={`w-full h-9 rounded-lg text-[11px] font-semibold border-2 border-dashed`}
                      style={{ borderColor: `${ORANGE}55`, color: ORANGE }}>
                      + Add set
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Recent sessions quick-jump (only if there are sessions and we're on a day with no data) */}
        {sessionForDate.length === 0 && datesWithSessions.length > 0 && (
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
            <h3 className={`text-[10px] font-bold uppercase tracking-wider ${theme.textMuted} mb-2`}>Recent sessions</h3>
            <div className="space-y-1.5">
              {datesWithSessions.slice(0, 8).map(d => {
                const dt = new Date(d);
                const exCount = Object.values(lifts).filter(lf => (lf.history || []).some(s => s.date === d && s.sets?.length > 0)).length;
                return (
                  <button key={d} onClick={() => setViewDate(d)}
                    className={`w-full flex items-center justify-between p-2.5 ${theme.surface} rounded-lg text-sm active:opacity-70`}>
                    <span className={`font-semibold ${theme.text}`}>
                      {dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                    </span>
                    <span className={`text-xs ${theme.textMuted}`}>{exCount} {exCount === 1 ? "exercise" : "exercises"} →</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className={`${theme.card} rounded-2xl border ${theme.border} p-3 text-center`}>
          <p className={`text-[11px] ${theme.textMuted} italic`}>
            Tap any set to edit weight / reps / RIR or delete it.
          </p>
        </div>
      </div>

      {/* Set editor modal */}
      {editingSet && (
        <Modal
          title={editingSet.setIndex < 0 ? `Add set — ${editingSet.exerciseName}` : `Edit set ${editingSet.setIndex + 1} — ${editingSet.exerciseName}`}
          onClose={() => setEditingSet(null)} theme={theme}>
          <NumInput label="Weight" value={editingSet.draft.weight}
            setValue={v => setEditingSet({ ...editingSet, draft: { ...editingSet.draft, weight: v } })}
            suffix="kg" step={2.5} theme={theme} />
          <NumInput label="Reps" value={editingSet.draft.reps}
            setValue={v => setEditingSet({ ...editingSet, draft: { ...editingSet.draft, reps: v } })}
            suffix="reps" step={1} theme={theme} />
          <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>RIR (reps in reserve)</label>
          <div className="grid grid-cols-5 gap-1.5 mb-3">
            {[0, 1, 2, 3, 4].map(r => (
              <button key={r}
                onClick={() => setEditingSet({ ...editingSet, draft: { ...editingSet.draft, rir: r } })}
                className="h-10 rounded-lg text-xs font-semibold"
                style={{ backgroundColor: editingSet.draft.rir === r ? ORANGE : "", color: editingSet.draft.rir === r ? "white" : "" }}>
                <div className={editingSet.draft.rir === r ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{r}</div>
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            {editingSet.setIndex >= 0 && (
              <button onClick={async () => {
                await updateSet(editingSet.exerciseName, editingSet.setIndex, null);
                setEditingSet(null);
              }} className="h-12 px-4 rounded-xl font-semibold text-sm" style={{ color: "#ef4444", backgroundColor: "#ef444415" }}>
                Delete
              </button>
            )}
            <button onClick={() => setEditingSet(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
            <button onClick={async () => {
              await updateSet(editingSet.exerciseName, editingSet.setIndex, editingSet.draft);
              setEditingSet(null);
            }} disabled={!(editingSet.draft.weight > 0 && editingSet.draft.reps > 0)}
              className="flex-1 h-12 text-white rounded-xl font-semibold disabled:opacity-50"
              style={{ backgroundColor: ORANGE }}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================================================
// ANALYTICS — embedded as a tab, reads cross-artifact data via shared storage
// ============================================================

// Brzycki 1RM estimation
function estimate1RM(weight, reps) {
  if (!weight || !reps || reps >= 37) return 0;
  return Math.round((weight * (36 / (37 - reps))) * 10) / 10;
}

function linearTrend(points) {
  if (points.length < 2) return { slope: 0, intercept: points[0]?.y || 0 };
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) || 0;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function correlation(xs, ys) {
  if (xs.length < 3 || xs.length !== ys.length) return 0;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = xs[i] - mx, ay = ys[i] - my;
    num += ax * ay; dx += ax * ax; dy += ay * ay;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

const A_GREEN = "#10b981";
const A_BLUE = "#3b82f6";
const A_PURPLE = "#a855f7";
const A_RED = "#ef4444";

const MUSCLE_MAP = {
  // Chest
  "Barbell Bench Press": "Chest", "Dumbbell Bench Press": "Chest", "Machine Chest Press": "Chest",
  "Incline Dumbbell Press": "Chest", "Incline Barbell Press": "Chest", "Incline Machine Press": "Chest",
  "Decline Bench Press": "Chest", "Decline Dumbbell Press": "Chest",
  "Cable Fly": "Chest", "Dumbbell Fly": "Chest", "Pec Deck": "Chest",
  "Dips": "Chest", "Assisted Dips": "Chest", "Push-ups": "Chest", "Incline Push-ups": "Chest",
  "Svend Press": "Chest",
  // Back
  "Barbell Row": "Back", "Dumbbell Row": "Back", "Pendlay Row": "Back", "T-Bar Row": "Back",
  "Chest-Supported Row": "Back", "Seal Row": "Back",
  "Lat Pulldown": "Back", "Wide-Grip Pulldown": "Back", "Neutral-Grip Pulldown": "Back",
  "Pull-ups": "Back", "Chin-ups": "Back", "Assisted Pull-ups": "Back",
  "Cable Row": "Back", "Seated Cable Row": "Back", "Single-Arm Cable Row": "Back",
  "Straight-Arm Pulldown": "Back", "Dumbbell Pullover": "Back",
  "Face Pull": "Back", "Reverse Pec Deck": "Back", "Rear Delt Fly": "Back",
  "Conventional Deadlift": "Back", "Trap Bar Deadlift": "Back", "Sumo Deadlift": "Back", "Rack Pull": "Back",
  "Barbell Shrug": "Back", "Dumbbell Shrug": "Back",
  // Legs / Quads
  "Barbell Squat": "Legs", "Front Squat": "Quads", "Goblet Squat": "Legs",
  "Box Squat": "Legs", "Pause Squat": "Legs",
  "Leg Press": "Legs", "Single-Leg Press": "Legs", "Hack Squat": "Legs", "Smith Machine Squat": "Legs",
  "Sissy Squat": "Quads",
  "Bulgarian Split Squat": "Legs", "Lunges": "Legs", "Walking Lunges": "Legs", "Reverse Lunges": "Legs", "Step-up": "Legs",
  "Leg Extension": "Quads",
  // Hamstrings
  "Romanian Deadlift": "Hamstrings", "DB Romanian Deadlift": "Hamstrings", "Single-Leg RDL": "Hamstrings",
  "Good Morning": "Hamstrings", "Lying Hamstring Curl": "Hamstrings", "Seated Hamstring Curl": "Hamstrings",
  "Hamstring Curl": "Hamstrings", "Nordic Curl": "Hamstrings",
  // Glutes
  "Hip Thrust": "Glutes", "B-Stance Hip Thrust": "Glutes", "Single-Leg Hip Thrust": "Glutes",
  "Glute Bridge": "Glutes", "Cable Pull-Through": "Glutes",
  "Cable Glute Kickback": "Glutes", "Glute Kickback Machine": "Glutes", "Abduction Machine": "Glutes",
  "Sumo Squat": "Glutes", "Curtsy Lunge": "Glutes",
  // Calves
  "Standing Calf Raise": "Calves", "Seated Calf Raise": "Calves", "Bodyweight Calf Raise": "Calves",
  "Single-Leg Calf Raise": "Calves", "Donkey Calf Raise": "Calves", "Leg Press Calf Raise": "Calves",
  // Shoulders
  "Overhead Press": "Shoulders", "Seated Overhead Press": "Shoulders", "Dumbbell Shoulder Press": "Shoulders",
  "Arnold Press": "Shoulders", "Machine Shoulder Press": "Shoulders", "Landmine Press": "Shoulders",
  "Lateral Raise": "Shoulders", "Cable Lateral Raise": "Shoulders", "Machine Lateral Raise": "Shoulders",
  "Upright Row": "Shoulders", "Cable Upright Row": "Shoulders",
  "Front Raise": "Shoulders", "Cable Front Raise": "Shoulders", "Plate Front Raise": "Shoulders",
  // Biceps
  "Barbell Curl": "Biceps", "EZ-Bar Curl": "Biceps", "Dumbbell Curl": "Biceps", "Incline Dumbbell Curl": "Biceps",
  "Concentration Curl": "Biceps", "Preacher Curl": "Biceps", "Spider Curl": "Biceps",
  "Cable Curl": "Biceps", "Hammer Curl": "Biceps", "Cable Hammer Curl": "Biceps", "Concentration Hammer": "Biceps",
  // Triceps
  "Tricep Pushdown": "Triceps", "Rope Pushdown": "Triceps", "Single-Arm Pushdown": "Triceps",
  "Skull Crushers": "Triceps", "EZ-Bar Skull Crushers": "Triceps", "Close-Grip Bench Press": "Triceps",
  "Overhead Tricep Extension": "Triceps", "Cable Overhead Extension": "Triceps",
  "Tricep Kickback": "Triceps", "Cable Kickback": "Triceps", "Bench Dips": "Triceps", "Diamond Push-ups": "Triceps",
  // Forearms
  "Wrist Curl": "Forearms", "Reverse Wrist Curl": "Forearms", "Reverse Curl": "Forearms", "Farmers Carry": "Forearms",
  // Core
  "Plank": "Core", "Side Plank": "Core", "Hanging Leg Raise": "Core", "Hanging Knee Raise": "Core",
  "Cable Crunch": "Core", "Crunch Machine": "Core", "Sit-ups": "Core",
  "Russian Twist": "Core", "Cable Woodchop": "Core",
  "Ab Wheel Rollout": "Core", "Dead Bug": "Core", "V-ups": "Core", "Hollow Hold": "Core",
};

const OPTIMAL_VOLUME = {
  "Chest": [10, 18], "Back": [10, 20], "Legs": [10, 18], "Quads": [10, 18],
  "Hamstrings": [6, 12], "Glutes": [8, 16],
  "Shoulders": [8, 16], "Biceps": [8, 14], "Triceps": [8, 14], "Core": [6, 16],
  "Calves": [8, 16], "Forearms": [4, 10],
};

// Minimum effective dose — even at very low capacity, going below this means a muscle won't grow.
const MIN_EFFECTIVE_DOSE = 4;
// Working sets per minute of session (typical hypertrophy pacing: ~1 set per 2.5 min)
const SETS_PER_MINUTE = 0.4;

// Goal-aware multipliers on volume. Cuts and recomps benefit from less volume
// (lower recovery capacity in deficit / maintenance). Bulks and maintain run textbook.
const GOAL_VOLUME_MULTIPLIER = {
  "Cut": 0.75,
  "Weight Loss": 0.75,
  "Recomp": 0.85,
  "Maintain": 1.0,
  "Lean Bulk": 1.0,
  "Bulk": 1.0,
};

// Focus areas mapping — onboarding terms may be aspirational ("Glutes")
// but our muscle taxonomy is broader. Map to the closest matching muscle group.
const FOCUS_TO_MUSCLE = {
  "Glutes": "Legs",
  "Quads": "Legs",
  "Hamstrings": "Hamstrings",
  "Calves": "Calves",
  "Core": "Core",
  "Abs": "Core",
  "Chest": "Chest",
  "Back": "Back",
  "Shoulders": "Shoulders",
  "Arms": "Biceps", // covers both arms — biceps is the proxy
  "Biceps": "Biceps",
  "Triceps": "Triceps",
  "Upper Body": null, // multi — handled separately
  "Lower Body": null,
};
const UPPER_MUSCLES = ["Chest", "Back", "Shoulders", "Biceps", "Triceps"];
const LOWER_MUSCLES = ["Legs", "Hamstrings", "Calves"];

/**
 * Returns capacity-, goal-, and focus-area-aware weekly set ranges for each muscle.
 * - Capacity: scales the textbook upper-bound to fit the user's planned weekly minutes
 * - Goal: cut (0.75), recomp (0.85), maintain/bulk (1.0) — fewer sets in a deficit
 * - FocusAreas: +25% on focus muscles, -10% on others (then floor-checked)
 *
 * Returns: { ranges, weeklyCapacity, scalingFactor, goalMultiplier, focusMuscles }
 */
function getScaledOptimalVolume(profile) {
  const daysPerWeek = (profile && profile.daysPerWeek) || 4;
  const sessionLength = (profile && profile.sessionLength) || 60;
  const goal = (profile && profile.goal) || "Maintain";
  const focusAreas = (profile && profile.focusAreas) || [];

  const weeklyCapacity = daysPerWeek * sessionLength * SETS_PER_MINUTE;
  const textbookTotal = Object.values(OPTIMAL_VOLUME).reduce((s, [, hi]) => s + hi, 0);
  const capacityFactor = Math.min(1, weeklyCapacity / textbookTotal);
  const goalMultiplier = GOAL_VOLUME_MULTIPLIER[goal] ?? 1.0;

  // Resolve focusAreas to a Set of muscle names
  const focusMuscles = new Set();
  for (const area of focusAreas) {
    if (area === "Upper Body") UPPER_MUSCLES.forEach(m => focusMuscles.add(m));
    else if (area === "Lower Body") LOWER_MUSCLES.forEach(m => focusMuscles.add(m));
    else if (FOCUS_TO_MUSCLE[area]) focusMuscles.add(FOCUS_TO_MUSCLE[area]);
  }

  const ranges = {};
  for (const [muscle, [lo, hi]] of Object.entries(OPTIMAL_VOLUME)) {
    const focusMult = focusMuscles.size > 0
      ? (focusMuscles.has(muscle) ? 1.25 : 0.9)
      : 1.0;
    const totalMult = capacityFactor * goalMultiplier * focusMult;
    const scaledLo = Math.max(MIN_EFFECTIVE_DOSE, Math.round(lo * totalMult));
    const scaledHi = Math.max(scaledLo + 1, Math.round(hi * totalMult));
    ranges[muscle] = [scaledLo, scaledHi];
  }
  return { ranges, weeklyCapacity, scalingFactor: capacityFactor, goalMultiplier, focusMuscles: Array.from(focusMuscles) };
}

// Compound vs isolation classification — drives reorder suggestions
const COMPOUND_EXERCISES = new Set([
  "Barbell Squat", "Romanian Deadlift", "Barbell Bench Press", "Overhead Press",
  "Barbell Row", "Pull-ups", "Leg Press", "Hack Squat", "Bulgarian Split Squat",
  "Dumbbell Bench Press", "Incline Dumbbell Press", "Dumbbell Shoulder Press",
  "Machine Shoulder Press", "Machine Chest Press", "Lat Pulldown", "Cable Row",
]);

// ============================================================
// FATIGUE ANALYSIS — the heart of the new feature
// ============================================================
function analyseFatigue(lifts) {
  // For each exercise, look at how performance degrades across sets within a session
  // Metrics:
  // - Avg RIR drop from set 1 to last set
  // - Avg rep drop from set 1 to last set
  // - Failure rate on later sets (RIR=0 in set 3+)
  // - Score: higher = more fatiguing (you struggle more on later sets)

  const result = [];
  for (const [name, data] of Object.entries(lifts || {})) {
    const sessions = data?.history || [];
    if (sessions.length < 2) continue;

    const dropSamples = [];
    let lateFailures = 0, lateOpportunities = 0;
    let totalSets = 0;

    for (const s of sessions) {
      if (!s.sets || s.sets.length < 2) continue;
      const first = s.sets[0];
      const last = s.sets[s.sets.length - 1];

      // RIR drop (set 1 should have higher RIR than last)
      const rirDrop = (first.rir ?? 2) - (last.rir ?? 0);
      // Rep drop
      const repDrop = (first.reps ?? 0) - (last.reps ?? 0);
      dropSamples.push({ rirDrop, repDrop });

      // Late-set failures (3rd set or later, RIR 0 = failure)
      for (let i = 2; i < s.sets.length; i++) {
        lateOpportunities++;
        if ((s.sets[i].rir ?? 2) === 0) lateFailures++;
      }
      totalSets += s.sets.length;
    }

    if (dropSamples.length === 0) continue;

    const avgRirDrop = dropSamples.reduce((s, d) => s + d.rirDrop, 0) / dropSamples.length;
    const avgRepDrop = dropSamples.reduce((s, d) => s + d.repDrop, 0) / dropSamples.length;
    const lateFailRate = lateOpportunities > 0 ? lateFailures / lateOpportunities : 0;

    // Composite fatigue score (0-100)
    // Heavy weight: RIR drop > 1.5 = fatigued. Rep drop > 2 = fatigued. Late fail rate > 0.4 = fatigued
    const score = Math.min(100, Math.round(
      (Math.max(0, avgRirDrop) * 20) +
      (Math.max(0, avgRepDrop) * 8) +
      (lateFailRate * 60)
    ));

    result.push({
      name,
      muscle: MUSCLE_MAP[name],
      isCompound: COMPOUND_EXERCISES.has(name),
      avgRirDrop: Math.round(avgRirDrop * 10) / 10,
      avgRepDrop: Math.round(avgRepDrop * 10) / 10,
      lateFailRate: Math.round(lateFailRate * 100),
      score,
      sessionsAnalysed: sessions.length,
      avgSetsPerSession: Math.round(totalSets / sessions.length),
    });
  }

  return result.sort((a, b) => b.score - a.score);
}

function parseRepRange(repStr) {
  if (typeof repStr !== "string") return { bottom: 8, top: 12 };
  const m = repStr.match(/(\d+)\s*-\s*(\d+)/);
  if (m) return { bottom: parseInt(m[1]), top: parseInt(m[2]) };
  const single = parseInt(repStr);
  if (!isNaN(single)) return { bottom: single, top: single };
  return { bottom: 8, top: 12 };
}

// Exercise-specific rep range defaults (mirrors what splits prescribe)
// Used so dashboard suggestions reference the right rep targets per exercise.
const EXERCISE_REP_DEFAULTS = {
  "Barbell Bench Press": "6-8", "Barbell Squat": "6-8", "Barbell Row": "6-8",
  "Romanian Deadlift": "6-8", "Overhead Press": "6-8",
  "Dumbbell Bench Press": "8-10", "Incline Dumbbell Press": "8-10", "Pull-ups": "6-8",
  "Lat Pulldown": "8-10", "Cable Row": "8-10", "Dumbbell Shoulder Press": "8-10",
  "Machine Shoulder Press": "8-10", "Machine Chest Press": "10-12", "Cable Fly": "12-15",
  "Leg Press": "10-12", "Hack Squat": "8-10", "Bulgarian Split Squat": "8-10",
  "Lunges": "8-10", "Leg Extension": "10-12", "Hamstring Curl": "10-12",
  "Standing Calf Raise": "10-15", "Lateral Raise": "12-15", "Cable Lateral Raise": "12-15",
  "Face Pull": "12-15", "Barbell Curl": "8-10", "Dumbbell Curl": "10-12",
  "Cable Curl": "10-12", "Hammer Curl": "10-12",
  "Tricep Pushdown": "10-12", "Skull Crushers": "8-10", "Overhead Tricep Extension": "10-12",
  "Plank": "30-60s", "Hanging Leg Raise": "10-15", "Cable Crunch": "12-15",
  "Push-ups": "8-12", "Goblet Squat": "10-12",
};

// Per-session progression suggestions
function analyseProgressForDashboard(lifts, profile) {
  const out = [];
  for (const [name, data] of Object.entries(lifts || {})) {
    const sessions = data?.history || [];
    if (sessions.length < 2) continue;
    const last = sessions[sessions.length - 1];
    const prev = sessions[sessions.length - 2];
    const prescribedRepRange = EXERCISE_REP_DEFAULTS[name] || "8-10";
    const range = parseRepRange(prescribedRepRange);

    const lastSetsAtTop = last.sets.every(s => s.reps >= range.top);
    const lastAvgRir = last.sets.reduce((sum, s) => sum + (s.rir ?? 0), 0) / last.sets.length;

    if (lastSetsAtTop && lastAvgRir >= 1 && last.sets[0].weight > 0) {
      const currentWt = last.sets[0].weight;
      const incr = currentWt < 30 ? 2.5 : currentWt < 80 ? 2.5 : 5;
      out.push({
        id: `prog-wt-${name}-${last.date}`,
        exerciseName: name,
        type: "increase_weight",
        current: currentWt,
        suggested: currentWt + incr,
        reason: `Hit ${range.top} reps (top of ${range.bottom}-${range.top}) on every set with ${lastAvgRir.toFixed(1)} reps in tank — time to add ${incr}kg.`,
        severity: "med",
        createdAt: last.date,
      });
      continue;
    }

    // Increase reps: in range, RIR ≥ 2, not at top
    const allInRange = last.sets.every(s => s.reps >= range.bottom);
    if (allInRange && lastAvgRir >= 2 && !lastSetsAtTop) {
      const maxReps = Math.max(...last.sets.map(s => s.reps));
      out.push({
        id: `prog-reps-${name}-${last.date}`,
        exerciseName: name,
        type: "increase_reps",
        current: maxReps,
        suggested: Math.min(range.top, maxReps + 1),
        reason: `Reps in ${range.bottom}-${range.top} range with ${lastAvgRir.toFixed(1)} RIR — squeeze 1 more rep next session before adding weight.`,
        severity: "low",
        createdAt: last.date,
      });
      continue;
    }

    const both = [last, prev];
    const tooHeavy = both.every(s => s.sets[0]?.reps < range.bottom && (s.sets[0]?.rir ?? 2) === 0);
    if (tooHeavy && last.sets[0].weight > 0) {
      const currentWt = last.sets[0].weight;
      const decr = currentWt < 40 ? 2.5 : 5;
      out.push({
        id: `prog-dec-${name}-${last.date}`,
        exerciseName: name,
        type: "decrease_weight",
        current: currentWt,
        suggested: currentWt - decr,
        reason: `First set falling below ${range.bottom} reps at failure for 2 sessions. The weight is past your sweet spot — drop ${decr}kg to unlock more total reps and better growth stimulus.`,
        severity: "high",
        createdAt: last.date,
      });
      continue;
    }

    // ─── 4. SWEET-SPOT TUNE — first set in range, last set fails FAR below ───
    // First set works (in range), but late sets crash hard. Means weight is right at first
    // but fatigue hits too fast. Slight weight drop = more total reps = better stimulus.
    // This is the new "sweet spot" trigger — extracts MORE total reps, not protects.
    const firstSetOk = last.sets[0]?.reps >= range.bottom && prev.sets[0]?.reps >= range.bottom;
    const lastSetCrash = (() => {
      if (last.sets.length < 3) return false;
      const lL = last.sets[last.sets.length - 1];
      const pL = prev.sets[prev.sets.length - 1];
      return lL && pL && (lL.rir ?? 2) === 0 && (pL.rir ?? 2) === 0
        && lL.reps < range.bottom - 2 && pL.reps < range.bottom - 2;
    })();
    if (firstSetOk && lastSetCrash && last.sets[0].weight > 0) {
      const currentWt = last.sets[0].weight;
      const decr = currentWt < 40 ? 2.5 : currentWt < 80 ? 2.5 : 5;
      const lastReps = last.sets[last.sets.length - 1].reps;
      out.push({
        id: `prog-sweet-${name}-${last.date}`,
        exerciseName: name,
        type: "tune_weight",
        current: currentWt,
        suggested: currentWt - decr,
        reason: `Set 1 in range but final set crashing to ${lastReps} reps. Drop ${decr}kg — you'll likely gain 4-6 total reps across the session for better growth stimulus.`,
        severity: "med",
        createdAt: last.date,
      });
      continue;
    }

    // ─── 5. ADD SET — only 2 sets, all cushy ───
    // Note: we DO NOT auto-suggest reducing sets just because the last set fails.
    // Failure on the last set with reps near the bottom is the IDEAL stimulus — that's where growth happens.
    // Only the sweet-spot rule above fires when failure is so severe that total reps drop.
    if (last.sets.length === 2) {
      const cushy = both.every(s => s.sets.every(set => set.reps >= range.bottom && (set.rir ?? 0) >= 3));
      if (cushy) {
        out.push({
          id: `prog-addset-${name}-${last.date}`,
          exerciseName: name,
          type: "add_set",
          current: last.sets.length,
          suggested: last.sets.length + 1,
          reason: `All sets clearly in tank (RIR 3+) for 2 sessions — stimulus is too light. Add a set.`,
          severity: "low",
          createdAt: last.date,
        });
      }
    }
  }
  return out;
}

// Monthly check-in: structural recommendations that surface on the dashboard
function generateMonthlyCheckin(lifts, completions, profile) {
  const out = [];
  const today = new Date();
  const fourWeeksAgo = new Date(today); fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const cutoff = fourWeeksAgo.toISOString().split("T")[0];

  // 1. Stalled exercises
  for (const [name, data] of Object.entries(lifts || {})) {
    const sessions = data?.history || [];
    const recent = sessions.filter(s => s.date >= cutoff);
    if (recent.length < 3) continue;
    const e1RMs = recent.map(s => s.sets.reduce((m, set) => Math.max(m, set.weight && set.reps ? set.weight * (36 / Math.max(1, 37 - set.reps)) : 0), 0));
    const first = e1RMs[0], last = e1RMs[e1RMs.length - 1];
    if (first > 0) {
      const growthPct = ((last - first) / first) * 100;
      if (growthPct < 1.5) {
        out.push({
          id: `monthly-stall-${name}-${today.toISOString().split("T")[0]}`,
          type: "swap_exercise",
          exerciseName: name,
          reason: `Only ${growthPct.toFixed(1)}% strength growth over 4 weeks. Time to rotate this lift for a fresh stimulus.`,
          severity: "med",
          createdAt: today.toISOString().split("T")[0],
        });
      }
    }
  }

  // 2. Adherence
  let workoutDays = 0;
  for (let i = 0; i < 28; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = d.toISOString().split("T")[0];
    if (completions[ds]?.length > 0) workoutDays++;
  }
  const expected = (profile.daysPerWeek || 4) * 4;
  if (expected > 0 && workoutDays / expected < 0.6) {
    out.push({
      id: `monthly-adherence-${today.toISOString().split("T")[0]}`,
      type: "schedule_review",
      reason: `Only ${workoutDays} of ${expected} planned workouts hit in 4 weeks. Consider dropping to ${Math.max(1, profile.daysPerWeek - 1)} days/week — consistency beats ambition.`,
      severity: "med",
      createdAt: today.toISOString().split("T")[0],
    });
  }

  // 3. Volume — undertrained muscle groups
  const cutoff7 = new Date(today); cutoff7.setDate(cutoff7.getDate() - 7);
  const cutoff7Str = cutoff7.toISOString().split("T")[0];
  const weeklyByMuscle = {};
  for (const [name, data] of Object.entries(lifts || {})) {
    const muscle = MUSCLE_MAP[name];
    if (!muscle) continue;
    const sets = (data?.history || []).filter(s => s.date >= cutoff7Str).reduce((s, ses) => s + ses.sets.length, 0);
    weeklyByMuscle[muscle] = (weeklyByMuscle[muscle] || 0) + sets;
  }
  for (const [muscle, sets] of Object.entries(weeklyByMuscle)) {
    const ideal = OPTIMAL_VOLUME[muscle];
    if (!ideal || sets === 0) continue;
    if (sets < ideal[0]) {
      out.push({
        id: `monthly-vol-${muscle}-${today.toISOString().split("T")[0]}`,
        type: "increase_volume",
        muscle,
        reason: `${muscle}: ${sets} sets/week, ideal is ${ideal[0]}-${ideal[1]}. Adding sets to existing exercises will speed gains.`,
        severity: "med",
        createdAt: today.toISOString().split("T")[0],
      });
    }
  }

  return out;
}

// Fatigue suggestions: which exercises need set reductions, which sessions need reordering
function generateFatigueRecommendations(fatigueData, lifts) {
  const recs = [];

  // Set reduction: high fatigue + late failures + currently running 4+ sets
  const reductionCandidates = fatigueData.filter(f =>
    f.score >= 60 && f.lateFailRate >= 50 && f.avgSetsPerSession >= 4
  );
  for (const ex of reductionCandidates) {
    recs.push({
      type: "reduce_sets",
      exerciseName: ex.name,
      currentSets: ex.avgSetsPerSession,
      suggestedSets: ex.avgSetsPerSession - 1,
      reason: `${ex.lateFailRate}% of your 3rd+ sets hit failure. Drop a set, hit better quality reps.`,
      severity: ex.score >= 75 ? "high" : "med",
    });
  }

  // Order suggestion: compound exercises with high fatigue should go first
  // If we see isolations early in the muscle pattern, flag it
  const fatigueByMuscle = {};
  for (const f of fatigueData) {
    if (!f.muscle) continue;
    if (!fatigueByMuscle[f.muscle]) fatigueByMuscle[f.muscle] = [];
    fatigueByMuscle[f.muscle].push(f);
  }
  // For each muscle, top fatigue exercises should be compounds
  for (const [muscle, exercises] of Object.entries(fatigueByMuscle)) {
    const top = exercises.slice(0, 3);
    const isolationsFirst = top.find(e => !e.isCompound && e.score >= 50);
    const compoundsBack = top.find(e => e.isCompound && e.score < 30);
    if (isolationsFirst && compoundsBack) {
      recs.push({
        type: "reorder",
        muscle,
        fatigued: isolationsFirst.name,
        compound: compoundsBack.name,
        reason: `${isolationsFirst.name} is wearing you out before you hit the heavier ${compoundsBack.name}. Try compounds first.`,
        severity: "med",
      });
    }
  }

  return recs;
}

// ============================================================
// ANALYTICS TAB COMPONENT
// ============================================================
function AnalyticsTab({ session, profile, themeCtx }) {
  const { theme } = themeCtx;
  const [logs, setLogs] = useState({});
  const [lifts, setLifts] = useState({});
  const [blocks, setBlocks] = useState([]);
  const [completions, setCompletions] = useState({});
  const [customTasks, setCustomTasks] = useState([]);
  const [taskResponses, setTaskResponses] = useState({});
  const [subTab, setSubTab] = useState("overview");

  useEffect(() => {
    (async () => {
      setLogs((await storage.get(userKey(session.id, "logs"))) || {});
      setLifts((await storage.get(userKey(session.id, "lifts"))) || {});
      setBlocks((await storage.get(userKey(session.id, "blocks"))) || []);
      setCompletions((await storage.get(userKey(session.id, "session-completions"))) || {});
      const taskStore = (await storage.get(userKey(session.id, "custom-tasks"))) || { tasks: [] };
      setCustomTasks(taskStore.tasks || []);
      setTaskResponses((await storage.get(userKey(session.id, "custom-task-responses"))) || {});
    })();
  }, [session.id]);

  // Listen for external requests to focus a specific sub-tab (e.g. Home overrun → Logs)
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.subTab) setSubTab(e.detail.subTab);
    };
    window.addEventListener("sinc:analytics-tab-focus", handler);
    return () => window.removeEventListener("sinc:analytics-tab-focus", handler);
  }, []);

  // Re-fetch when window regains focus (user might have updated data in another tab/artifact)
  useEffect(() => {
    const refresh = async () => {
      setLogs((await storage.get(userKey(session.id, "logs"))) || {});
      setLifts((await storage.get(userKey(session.id, "lifts"))) || {});
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [session.id]);

  return (
    <div>
      <div className="px-5 pt-10 pb-5 text-white relative overflow-hidden" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
        <img src={HERO_SPRINTER_B64} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ opacity: 0.28, mixBlendMode: "luminosity" }} />
        <div className="relative">
          <Wordmark />
          <div className="mt-4">
            <h1 className="text-2xl font-bold flex items-center gap-2">
              Analytics
              <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded border inline-flex items-center gap-1" style={{ color: ORANGE, borderColor: ORANGE }}>
                <BrandIcon name="beaker" size={11} color={ORANGE} strokeWidth={2.2} />
                LAB
              </span>
            </h1>
            <p className="text-blue-100 text-xs mt-1 italic">Deep insights. Smarter training.</p>
          </div>
        </div>
      </div>

      <div className="px-3 pt-3 mb-3 overflow-x-auto">
        <div className="flex gap-1.5 pb-1">
          {[
            { id: "overview", l: "Overview", icon: "target" },
            { id: "fatigue", l: "Fatigue", icon: "warning" },
            { id: "strength", l: "Strength", icon: "barbell" },
            { id: "volume", l: "Volume", icon: "up" },
            { id: "nutrition", l: "Nutrition", icon: "apple" },
            { id: "tasks", l: "Tasks", icon: "task" },
            { id: "logs", l: "Logs", icon: "calendar" },
          ].map(t => {
            const isActive = subTab === t.id;
            return (
              <button key={t.id} onClick={() => setSubTab(t.id)}
                className={`px-3 h-10 rounded-lg font-semibold text-xs whitespace-nowrap flex-shrink-0 flex items-center gap-1.5 ${isActive ? "" : `${theme.surface} ${theme.surfaceText}`}`}
                style={{ backgroundColor: isActive ? ORANGE : "", color: isActive ? "white" : "" }}>
                <BrandIcon name={t.icon} size={14} color={isActive ? "white" : "currentColor"} strokeWidth={2} />
                <span>{t.l}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="px-4 space-y-3">
        {subTab === "overview" && <AnOverview profile={profile} logs={logs} lifts={lifts} blocks={blocks} completions={completions} theme={theme} onJump={setSubTab} />}
        {subTab === "fatigue" && <AnFatigue lifts={lifts} theme={theme} />}
        {subTab === "strength" && <AnStrength lifts={lifts} theme={theme} />}
        {subTab === "volume" && <AnVolume lifts={lifts} profile={profile} theme={theme} />}
        {subTab === "nutrition" && <AnNutrition profile={profile} logs={logs} lifts={lifts} blocks={blocks} theme={theme} />}
        {subTab === "tasks" && <AnTasks tasks={customTasks} responses={taskResponses} theme={theme} blocks={blocks} />}
        {subTab === "logs" && <HistoryEmbed session={session} profile={profile} themeCtx={themeCtx} />}
      </div>
    </div>
  );
}

// Overview
function AnOverview({ profile, logs, lifts, blocks, completions, theme, onJump }) {
  const stats = useMemo(() => {
    let strengthScore = 50;
    const liftEntries = Object.entries(lifts).filter(([_, d]) => d?.history?.length >= 3);
    if (liftEntries.length > 0) {
      const growthRates = liftEntries.map(([_, d]) => {
        const h = d.history;
        const first = h[0].sets.reduce((m, s) => Math.max(m, estimate1RM(s.weight, s.reps)), 0);
        const last = h[h.length - 1].sets.reduce((m, s) => Math.max(m, estimate1RM(s.weight, s.reps)), 0);
        return first > 0 ? ((last - first) / first) * 100 : 0;
      });
      const avgGrowth = growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
      strengthScore = Math.max(0, Math.min(100, 50 + avgGrowth * 5));
    }

    let adherenceScore = 50;
    const dates = Object.keys(logs).filter(d => logs[d].food).sort();
    const last14 = dates.slice(-14);
    if (last14.length >= 7) {
      const tdee = calculateTargets(profile).calTarget;
      const within = last14.filter(d => Math.abs((logs[d].kcalEaten || 0) - tdee) < 250).length;
      adherenceScore = Math.round((within / last14.length) * 100);
    }

    let consistencyScore = 50;
    const today = new Date();
    let workoutDays = 0;
    for (let i = 0; i < 28; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split("T")[0];
      if (completions[ds]?.length > 0 || logs[ds]?.workout) workoutDays++;
    }
    const expected = (profile.daysPerWeek || 4) * 4;
    consistencyScore = Math.min(100, Math.round((workoutDays / expected) * 100));

    const performanceScore = Math.round((strengthScore * 0.4) + (adherenceScore * 0.3) + (consistencyScore * 0.3));

    const fatigue = analyseFatigue(lifts);
    const avgFatigue = fatigue.length > 0 ? Math.round(fatigue.reduce((s, f) => s + f.score, 0) / fatigue.length) : 0;
    const recoveryScore = 100 - avgFatigue;

    return { performanceScore, strengthScore: Math.round(strengthScore), adherenceScore, consistencyScore, recoveryScore, avgFatigue };
  }, [profile, logs, lifts, completions]);

  const topExercise = useMemo(() => {
    const candidates = ["Barbell Bench Press", "Barbell Squat", "Barbell Row", "Romanian Deadlift", "Overhead Press"];
    return candidates.find(e => lifts[e]?.history?.length >= 3) || Object.keys(lifts)[0];
  }, [lifts]);

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <AnKpi label="Performance Score" value={`${stats.performanceScore}`} unit="/100" accent={ORANGE} ring={stats.performanceScore} theme={theme} />
        <AnKpi label="Strength Trend" value={stats.strengthScore >= 60 ? "Upward" : stats.strengthScore >= 40 ? "Steady" : "Watch"} sub={stats.strengthScore >= 60 ? "Strong gains" : "Holding"} accent={stats.strengthScore >= 60 ? A_GREEN : ORANGE} theme={theme} />
        <AnKpi label="Adherence" value={`${stats.adherenceScore}%`} sub="last 14 days" accent={stats.adherenceScore >= 70 ? A_GREEN : stats.adherenceScore >= 40 ? ORANGE : A_RED} theme={theme} />
        <AnKpi label="Recovery" value={`${stats.recoveryScore}%`} sub={stats.avgFatigue > 60 ? "Fatigue high" : stats.avgFatigue > 30 ? "Moderate" : "Fresh"} accent={stats.recoveryScore >= 60 ? A_GREEN : ORANGE} theme={theme} />
      </div>

      {topExercise && (
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
          <div className="flex items-center justify-between mb-3">
            <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted}`}>Strength preview</div>
            <button onClick={() => onJump("strength")} className="text-[10px] font-semibold flex items-center gap-1" style={{ color: ORANGE }}>
              All exercises →
            </button>
          </div>
          <AnStrengthMini exerciseName={topExercise} lifts={lifts} theme={theme} />
        </div>
      )}

      {/* Fatigue preview */}
      {Object.keys(lifts).length > 0 && (
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
          <div className="flex items-center justify-between mb-3">
            <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted}`}>Top fatigue concerns</div>
            <button onClick={() => onJump("fatigue")} className="text-[10px] font-semibold flex items-center gap-1" style={{ color: ORANGE }}>
              See all →
            </button>
          </div>
          {(() => {
            const top = analyseFatigue(lifts).slice(0, 3);
            if (top.length === 0) return <div className={`text-xs ${theme.textMuted} text-center py-3`}>Need more session data.</div>;
            return (
              <div className="space-y-2">
                {top.map(f => (
                  <div key={f.name} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs font-semibold ${theme.text} truncate`}>{f.name}</div>
                      <div className={`text-[10px] ${theme.textMuted}`}>RIR drop {f.avgRirDrop} · {f.lateFailRate}% late fails</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-bold" style={{ color: f.score >= 60 ? A_RED : f.score >= 30 ? ORANGE : A_GREEN }}>{f.score}</div>
                      <div className={`text-[9px] ${theme.textMuted}`}>fatigue</div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      <AnInsightsStrip profile={profile} logs={logs} lifts={lifts} blocks={blocks} theme={theme} />
    </>
  );
}

function AnKpi({ label, value, unit, sub, accent, ring, theme }) {
  return (
    <div className={`${theme.card} rounded-2xl border ${theme.border} p-3 relative overflow-hidden`}>
      <div className="text-[10px] font-medium" style={{ color: theme.textMuted.includes("400") ? "#94a3b8" : "#64748b" }}>{label}</div>
      <div className="flex items-baseline gap-1 mt-1">
        <div className={`text-2xl font-bold ${theme.text}`}>{value}</div>
        {unit && <div className={`text-xs ${theme.textMuted}`}>{unit}</div>}
      </div>
      {ring !== undefined && (
        <div className="absolute top-2.5 right-2.5">
          <svg viewBox="0 0 36 36" width="32" height="32" className="-rotate-90">
            <circle cx="18" cy="18" r="14" fill="none" stroke={theme.bg.includes("950") ? "#1e293b" : "#e2e8f0"} strokeWidth="3" />
            <circle cx="18" cy="18" r="14" fill="none" stroke={accent} strokeWidth="3"
              strokeDasharray={`${(ring / 100) * 87.96} 87.96`} strokeLinecap="round" />
          </svg>
        </div>
      )}
      {sub && <div className={`text-[10px] ${theme.textMuted} mt-0.5`}>{sub}</div>}
    </div>
  );
}

function AnStrengthMini({ exerciseName, lifts, theme }) {
  const data = lifts[exerciseName];
  if (!data?.history) return null;
  const series = data.history.map(s => ({
    date: s.date,
    value: s.sets.reduce((m, set) => Math.max(m, estimate1RM(set.weight, set.reps)), 0),
  }));
  const current = series[series.length - 1];
  const earliest = series[0];
  const change = current.value - earliest.value;
  const changePct = earliest.value > 0 ? (change / earliest.value) * 100 : 0;

  return (
    <>
      <div className="flex items-baseline gap-2 mb-1">
        <span className={`text-xl font-bold ${theme.text}`}>{current.value.toFixed(1)} kg</span>
        <span className={`text-[10px] ${theme.textMuted}`}>{exerciseName}</span>
      </div>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[11px] font-bold flex items-center gap-0.5" style={{ color: change >= 0 ? A_GREEN : A_RED }}>
          {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)} kg ({Math.abs(changePct).toFixed(1)}%)
        </span>
      </div>
      <AnStrengthChart series={series} mini theme={theme} />
    </>
  );
}

function AnStrengthChart({ series, projection, mini, theme }) {
  const [tappedIdx, setTappedIdx] = useState(null);

  if (!series || series.length < 2) {
    return <div className={`text-xs ${theme.textMuted} text-center py-6`}>Need at least 2 sessions for chart</div>;
  }
  const w = 320, h = mini ? 100 : 180;
  const pad = { top: 10, right: 16, bottom: 24, left: 32 };
  const cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;
  const values = series.map(s => s.value);
  const minV = Math.floor(Math.min(...values) * 0.95);
  const maxV = Math.ceil(Math.max(...values) * 1.05);
  const range = maxV - minV || 1;
  const points = series.map((s, i) => ({
    x: pad.left + (i / (series.length - 1)) * cw,
    y: pad.top + (1 - (s.value - minV) / range) * ch,
    value: s.value,
    date: s.date,
  }));
  const linePts = points.map(p => `${p.x},${p.y}`).join(" ");
  const areaPts = `${pad.left},${pad.top + ch} ${linePts} ${pad.left + cw},${pad.top + ch}`;
  const trendStart = projection?.intercept;
  const trendEnd = projection ? projection.intercept + projection.slope * (series.length - 1) : null;
  const yLabels = mini ? [] : [minV, Math.round((minV + maxV) / 2), maxV];
  const xLabels = !mini && series.length > 1 ? [
    { idx: 0, date: series[0].date },
    { idx: Math.floor(series.length / 2), date: series[Math.floor(series.length / 2)].date },
    { idx: series.length - 1, date: series[series.length - 1].date },
  ] : [];

  const tapped = tappedIdx !== null ? points[tappedIdx] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={mini ? 80 : "auto"}
        onClick={() => setTappedIdx(null)}>
      <defs>
        <linearGradient id="strGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ORANGE} stopOpacity="0.4" />
          <stop offset="100%" stopColor={ORANGE} stopOpacity="0" />
        </linearGradient>
      </defs>
      {!mini && yLabels.map((v, i) => {
        const y = pad.top + (1 - (v - minV) / range) * ch;
        return <line key={i} x1={pad.left} y1={y} x2={pad.left + cw} y2={y} stroke={theme.border.includes("800") ? "#1e293b" : "#e2e8f0"} strokeWidth="0.5" strokeDasharray="2,2" />;
      })}
      {!mini && projection && (
        <line x1={pad.left} y1={pad.top + (1 - (trendStart - minV) / range) * ch}
          x2={pad.left + cw} y2={pad.top + (1 - (trendEnd - minV) / range) * ch}
          stroke={theme.textMuted.includes("400") ? "#475569" : "#94a3b8"} strokeWidth="1" strokeDasharray="3,3" />
      )}
      <polygon points={areaPts} fill="url(#strGrad)" />
      <polyline fill="none" stroke={ORANGE} strokeWidth="2" points={linePts} strokeLinejoin="round" />

      {/* Tap targets — wider invisible circles for easier mobile interaction */}
      {!mini && points.map((p, i) => (
        <circle key={`tap-${i}`} cx={p.x} cy={p.y} r="14" fill="transparent"
          onClick={(e) => { e.stopPropagation(); setTappedIdx(i === tappedIdx ? null : i); }}
          style={{ cursor: "pointer" }} />
      ))}

      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={i === tappedIdx ? 5 : i === points.length - 1 ? 4 : 2.5}
          fill={i === tappedIdx ? "white" : i === points.length - 1 ? ORANGE : theme.bg.includes("950") ? "#0f172a" : "white"}
          stroke={ORANGE} strokeWidth="1.5" pointerEvents="none" />
      ))}
      {!mini && tappedIdx === null && (
        <g>
          <rect x={points[points.length - 1].x - 22} y={points[points.length - 1].y - 22}
            width="40" height="16" rx="3" fill={ORANGE} />
          <text x={points[points.length - 1].x - 2} y={points[points.length - 1].y - 10}
            fontSize="10" fontWeight="bold" fill="white" textAnchor="middle">
            {points[points.length - 1].value.toFixed(1)}
          </text>
        </g>
      )}
      {/* Tap details popup */}
      {!mini && tapped && (
        <g pointerEvents="none">
          <line x1={tapped.x} y1={pad.top} x2={tapped.x} y2={pad.top + ch} stroke={ORANGE} strokeWidth="0.5" strokeDasharray="2,2" />
          {(() => {
            const labelX = Math.max(pad.left + 30, Math.min(pad.left + cw - 60, tapped.x - 30));
            const labelY = Math.max(pad.top + 4, tapped.y - 32);
            return (
              <>
                <rect x={labelX} y={labelY} width="60" height="26" rx="3" fill={NAVY} stroke={ORANGE} strokeWidth="1" />
                <text x={labelX + 30} y={labelY + 11} fontSize="10" fontWeight="bold" fill="white" textAnchor="middle">{tapped.value.toFixed(1)} kg</text>
                <text x={labelX + 30} y={labelY + 22} fontSize="8" fill={ORANGE} textAnchor="middle">{new Date(tapped.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</text>
              </>
            );
          })()}
        </g>
      )}
      {yLabels.map((v, i) => {
        const y = pad.top + (1 - (v - minV) / range) * ch;
        return <text key={i} x={pad.left - 6} y={y + 3} fontSize="9" fill={theme.textMuted.includes("400") ? "#64748b" : "#94a3b8"} textAnchor="end">{v}</text>;
      })}
      {xLabels.map((l, i) => {
        const x = pad.left + (l.idx / (series.length - 1)) * cw;
        return (
          <text key={i} x={x} y={h - 8} fontSize="9" fill={theme.textMuted.includes("400") ? "#64748b" : "#94a3b8"} textAnchor="middle">
            {new Date(l.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
          </text>
        );
      })}
      </svg>
      {!mini && (
        <p className={`text-[9px] ${theme.textMuted} italic text-center mt-1`}>Tap any point for details</p>
      )}
    </div>
  );
}

// FATIGUE TAB — main new feature
function AnFatigue({ lifts, theme }) {
  const fatigueData = useMemo(() => analyseFatigue(lifts), [lifts]);
  const recommendations = useMemo(() => generateFatigueRecommendations(fatigueData, lifts), [fatigueData, lifts]);

  if (fatigueData.length === 0) {
    return (
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-8 text-center`}>
        <div className="mb-2 flex justify-center"><BrandIcon name="warning" size={28} color={ORANGE} strokeWidth={1.6} /></div>
        <div className={`text-sm font-semibold ${theme.text}`}>Not enough data yet</div>
        <div className={`text-xs ${theme.textMuted} mt-1`}>Log 2+ sessions per exercise to see fatigue patterns.</div>
      </div>
    );
  }

  // Avg fatigue across all
  const avgScore = Math.round(fatigueData.reduce((s, f) => s + f.score, 0) / fatigueData.length);
  const highFatigue = fatigueData.filter(f => f.score >= 60).length;
  const fresh = fatigueData.filter(f => f.score < 30).length;

  return (
    <>
      {/* Summary */}
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
        <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-3`}>Overall fatigue picture</div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className={`text-2xl font-bold ${theme.text}`}>{avgScore}</div>
            <div className={`text-[9px] ${theme.textMuted} uppercase tracking-wide`}>Avg score</div>
          </div>
          <div>
            <div className="text-2xl font-bold" style={{ color: A_RED }}>{highFatigue}</div>
            <div className={`text-[9px] ${theme.textMuted} uppercase tracking-wide`}>High fatigue</div>
          </div>
          <div>
            <div className="text-2xl font-bold" style={{ color: A_GREEN }}>{fresh}</div>
            <div className={`text-[9px] ${theme.textMuted} uppercase tracking-wide`}>Fresh</div>
          </div>
        </div>
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className={`${theme.card} rounded-2xl border-2 p-4`} style={{ borderColor: ORANGE }}>
          <div className="flex items-center gap-1.5 mb-3" style={{ color: ORANGE }}>
            <BrandIcon name="target" size={13} color={ORANGE} strokeWidth={2.2} />
            <span className="text-[10px] font-bold uppercase tracking-wide">Adjustments to try</span>
          </div>
          <div className="space-y-3">
            {recommendations.map((r, i) => (
              <div key={i} className={`${theme.surface} rounded-lg p-3`}>
                {r.type === "reduce_sets" ? (
                  <>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-base">📉</span>
                      <span className={`text-xs font-bold ${theme.text}`}>{r.exerciseName}</span>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: ORANGE, color: "white" }}>
                        {r.currentSets} → {r.suggestedSets} SETS
                      </span>
                    </div>
                    <p className={`text-[11px] ${theme.textSubtle} leading-snug`}>{r.reason}</p>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-1">
                      <BrandIcon name="swap" size={16} color="currentColor" strokeWidth={2} />
                      <span className={`text-xs font-bold ${theme.text}`}>{r.muscle} session order</span>
                    </div>
                    <p className={`text-[11px] ${theme.textSubtle} leading-snug`}>{r.reason}</p>
                  </>
                )}
              </div>
            ))}
          </div>
          <p className={`text-[9px] ${theme.textMuted} italic mt-3`}>
            Adjust manually in Edit Training Plan, or accept these suggestions next block.
          </p>
        </div>
      )}

      {/* Per-exercise breakdown */}
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
        <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-3`}>By exercise</div>
        <p className={`text-[10px] ${theme.textMuted} mb-3 leading-snug`}>
          Higher score = more fatigue accumulating across sets. Considers RIR drop, rep drop, and late-set failures.
        </p>
        <div className="space-y-2">
          {fatigueData.map(f => {
            const color = f.score >= 60 ? A_RED : f.score >= 30 ? ORANGE : A_GREEN;
            return (
              <div key={f.name}>
                <div className="flex items-center justify-between mb-1">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs font-semibold ${theme.text} truncate`}>{f.name}</span>
                      {f.isCompound && <span className="text-[8px] font-bold px-1 py-0.5 rounded flex-shrink-0" style={{ backgroundColor: `${A_PURPLE}33`, color: A_PURPLE }}>COMPOUND</span>}
                    </div>
                    <div className={`text-[10px] ${theme.textMuted}`}>RIR drop {f.avgRirDrop} · {f.lateFailRate}% late fails</div>
                  </div>
                  <div className="text-sm font-bold flex-shrink-0" style={{ color }}>{f.score}</div>
                </div>
                <div className="h-1 bg-slate-700/30 rounded-full overflow-hidden">
                  <div className="h-full" style={{ width: `${f.score}%`, backgroundColor: color }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// STRENGTH (lite version for embedded — full version stays in standalone artifact)
function AnStrength({ lifts, theme }) {
  const tracked = useMemo(() => Object.entries(lifts)
    .filter(([_, d]) => d?.history?.length >= 2)
    .sort((a, b) => (b[1].history?.length || 0) - (a[1].history?.length || 0))
    .map(([name]) => name), [lifts]);
  const [selected, setSelected] = useState(tracked[0]);
  useEffect(() => { if (!selected && tracked[0]) setSelected(tracked[0]); }, [tracked, selected]);

  if (!tracked.length) {
    return (
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-8 text-center`}>
        <div className="mb-2 flex justify-center"><BrandIcon name="workout" size={28} color={ORANGE} strokeWidth={1.6} /></div>
        <div className={`text-sm font-semibold ${theme.text}`}>No lift history yet</div>
      </div>
    );
  }

  const data = lifts[selected];
  const series = data?.history?.map(s => ({
    date: s.date,
    value: s.sets.reduce((m, set) => Math.max(m, estimate1RM(set.weight, set.reps)), 0),
  })) || [];
  const current = series[series.length - 1];
  const indexed = series.map((s, i) => ({ x: i, y: s.value }));
  const { slope, intercept } = linearTrend(indexed);
  const projection4w = series.length > 0 ? Math.round((intercept + slope * (series.length + 3)) * 10) / 10 : 0;
  const fourWeeksAgo = series.length >= 5 ? series[series.length - 5] : series[0];
  const change = current && fourWeeksAgo ? current.value - fourWeeksAgo.value : 0;
  const changePct = fourWeeksAgo?.value > 0 ? (change / fourWeeksAgo.value) * 100 : 0;

  return (
    <>
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-3`}>
        <div className="overflow-x-auto -mx-1 px-1">
          <div className="flex gap-1.5 pb-1">
            {tracked.map(ex => (
              <button key={ex} onClick={() => setSelected(ex)}
                className={`px-3 h-9 rounded-lg font-semibold text-xs whitespace-nowrap flex-shrink-0 flex items-center ${selected === ex ? "" : `${theme.surface} ${theme.surfaceText}`}`}
                style={{ backgroundColor: selected === ex ? NAVY : "", color: selected === ex ? "white" : "" }}>
                {ex}
              </button>
            ))}
          </div>
        </div>
      </div>

      {selected && current && (
        <>
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
            <div className="flex items-baseline gap-2 mb-1">
              <div className={`text-3xl font-bold ${theme.text}`}>{current.value.toFixed(1)}</div>
              <div className={`text-sm ${theme.textMuted}`}>kg e1RM</div>
            </div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-bold flex items-center gap-0.5" style={{ color: change >= 0 ? A_GREEN : A_RED }}>
                {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)} kg ({Math.abs(changePct).toFixed(1)}%)
              </span>
              <span className={`text-[10px] ${theme.textMuted}`}>vs ~4 wks ago</span>
            </div>
            <AnStrengthChart series={series} projection={{ slope, intercept }} theme={theme} />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-3`}>
              <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted}`}>1RM Projection</div>
              <div className="text-2xl font-bold mt-1" style={{ color: ORANGE }}>{projection4w.toFixed(1)} <span className={`text-xs font-normal ${theme.textMuted}`}>kg</span></div>
              <div className={`text-[10px] ${theme.textMuted} mt-0.5`}>4 weeks at current trend</div>
            </div>
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-3`}>
              <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted}`}>Sessions</div>
              <div className={`text-2xl font-bold mt-1 ${theme.text}`}>{series.length}</div>
              <div className={`text-[10px] ${theme.textMuted} mt-0.5`}>logged total</div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// VOLUME TAB
// ============================================================
// MUSCLE MAP DIAGRAM — front/back body silhouette colour-coded
// by weekly volume vs capacity-, goal-, and focus-aware ranges.
// ============================================================
function MuscleMapDiagram({ weeklyVolume, profile, theme }) {
  // Placeholder card. Live anatomical body map will land via react-body-highlighter
  // after we deploy off-artifact. The npm package isn't available in Claude's runtime,
  // so for now we show what's coming and surface the data textually below.
  const trainedCount = Object.values(weeklyVolume).filter(v => v.sets > 0).length;
  const totalSets = Object.values(weeklyVolume).reduce((s, v) => s + v.sets, 0);
  return (
    <div className={`${theme.card} rounded-2xl border ${theme.border} p-4 overflow-hidden relative`}>
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-full flex-shrink-0 flex items-center justify-center" style={{ backgroundColor: `${ORANGE}15` }}>
          <BrandIcon name="user" size={24} color={ORANGE} strokeWidth={1.8} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className={`text-sm font-bold ${theme.text}`}>Visual body map</h4>
            <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded" style={{ backgroundColor: `${ORANGE}33`, color: ORANGE }}>SOON</span>
          </div>
          <p className={`text-[11px] ${theme.textMuted} leading-snug mb-2`}>
            An anatomical front/back diagram will show muscle groups heat-mapped by weekly volume — pale for undertrained, bright for hammered. Tappable for details. Available after deployment.
          </p>
          <div className={`flex gap-3 text-[10px] ${theme.textMuted}`}>
            <span><span className={`font-bold ${theme.text}`}>{trainedCount}</span> muscles trained this week</span>
            <span>·</span>
            <span><span className={`font-bold ${theme.text}`}>{totalSets}</span> total sets</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AnVolume({ lifts, profile, theme }) {
  const scaledOptimal = useMemo(() => getScaledOptimalVolume(profile), [profile]);
  const weeklyVolume = useMemo(() => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().split("T")[0];
    const byMuscle = {};
    for (const [name, data] of Object.entries(lifts)) {
      const muscle = MUSCLE_MAP[name] || "Other";
      const recentSessions = (data?.history || []).filter(s => s.date >= cutoffStr);
      const sets = recentSessions.reduce((sum, s) => sum + s.sets.length, 0);
      if (!byMuscle[muscle]) byMuscle[muscle] = { sets: 0 };
      byMuscle[muscle].sets += sets;
    }
    return byMuscle;
  }, [lifts]);

  return (
    <div className="space-y-3">
      {/* Visual muscle map (front/back diagram) */}
      <MuscleMapDiagram weeklyVolume={weeklyVolume} profile={profile} theme={theme} />

      {/* Numeric breakdown */}
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
        <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-3`}>Weekly Sets per Muscle</div>
        <div className="space-y-2">
          {Object.entries(weeklyVolume).sort((a, b) => b[1].sets - a[1].sets).map(([muscle, data]) => {
            const optimal = scaledOptimal.ranges[muscle] || [MIN_EFFECTIVE_DOSE, 12];
            const inRange = data.sets >= optimal[0] && data.sets <= optimal[1];
            const tooLow = data.sets < optimal[0];
            const pct = Math.min(100, (data.sets / (optimal[1] * 1.5)) * 100);
            const color = inRange ? A_GREEN : tooLow ? ORANGE : A_RED;
            const isFocus = scaledOptimal.focusMuscles.includes(muscle);
            return (
              <div key={muscle}>
                <div className="flex items-center justify-between mb-0.5">
                  <span className={`text-xs font-semibold ${theme.text} flex items-center gap-1.5`}>
                    {muscle}
                    {isFocus && <span className="text-[8px] px-1 py-0.5 rounded font-bold" style={{ backgroundColor: `${ORANGE}30`, color: ORANGE }}>FOCUS</span>}
                  </span>
                  <span className="text-xs" style={{ color }}>
                    <span className="font-bold">{data.sets}</span>
                    <span className={`text-[10px] ml-1 ${theme.textMuted}`}>/ {optimal[0]}-{optimal[1]} target</span>
                  </span>
                </div>
                <div className="h-1.5 bg-slate-700/30 rounded-full overflow-hidden">
                  <div className="h-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                </div>
              </div>
            );
          })}
          {Object.keys(weeklyVolume).length === 0 && (
            <div className={`text-xs ${theme.textMuted} text-center py-4`}>No training data this week</div>
          )}
        </div>
      </div>
    </div>
  );
}

// NUTRITION TAB
function AnNutrition({ profile, logs, lifts, blocks, theme }) {
  // ── Compute base 30-day stats ──
  const stats = useMemo(() => {
    const dates = Object.keys(logs).filter(d => logs[d].food && logs[d].kcalEaten).sort();
    if (dates.length === 0) return null;
        const last30 = dates.slice(-30);
    const days = last30.map(d => {
      const log = logs[d] || {};
      const block = blocks?.find(b => d >= b.startDate && (!b.endDate || d < b.endDate));
      const target = block ? block.calTarget : calculateTargets(profile).calTarget;
      return { date: d, kcal: log.kcalEaten || 0, protein: log.proteinEaten || 0, fat: log.fatEaten || 0, carbs: log.carbsEaten || 0, target };
          });
    const avgKcal = Math.round(days.reduce((s, d) => s + d.kcal, 0) / days.length);
    const avgProtein = Math.round(days.reduce((s, d) => s + d.protein, 0) / days.length);
    const avgCarbs = Math.round(days.reduce((s, d) => s + d.carbs, 0) / days.length);
    const avgFat = Math.round(days.reduce((s, d) => s + d.fat, 0) / days.length);
    const adherent = days.filter(d => Math.abs(d.kcal - d.target) < 200).length;
    const adherence = Math.round((adherent / days.length) * 100);
    return { days, avgKcal, avgProtein, avgCarbs, avgFat, adherence };
  }, [logs, profile, blocks]);

  // ── Pair training days with same-day & day-before nutrition ──
  // Aggregate by date — one point per workout DAY (session), with per-exercise breakdown for drilldown
  const nutritionPerformancePairs = useMemo(() => {
    const byDate = {};
    for (const [name, data] of Object.entries(lifts || {})) {
      for (const session of data?.history || []) {
        const dayLog = logs[session.date];
        if (!dayLog?.food || !dayLog.kcalEaten) continue;
        const sessionVol = session.sets.reduce((s, set) => s + (set.weight || 0) * (set.reps || 0), 0);
        const sessionBest1RM = session.sets.reduce((m, set) => Math.max(m, estimate1RM(set.weight, set.reps)), 0);
        if (!byDate[session.date]) {
          const prevDay = new Date(session.date); prevDay.setDate(prevDay.getDate() - 1);
          const prevLog = logs[prevDay.toISOString().split("T")[0]];
          const block = blocks?.find(b => session.date >= b.startDate && (!b.endDate || session.date < b.endDate));
          const target = block ? block.calTarget : calculateTargets(profile).calTarget;
          byDate[session.date] = {
            date: session.date,
            volume: 0,
            best1RM: 0,
            kcal: dayLog.kcalEaten,
            protein: dayLog.proteinEaten || 0,
            carbs: dayLog.carbsEaten || 0,
            fat: dayLog.fatEaten || 0,
            surplus: dayLog.kcalEaten - target,
            prevCarbs: prevLog?.carbsEaten || 0,
            prevKcal: prevLog?.kcalEaten || 0,
            dayOfWeek: new Date(session.date).getDay(),
            exercises: [],
          };
        }
        byDate[session.date].volume += sessionVol;
        byDate[session.date].best1RM = Math.max(byDate[session.date].best1RM, sessionBest1RM);
        byDate[session.date].exercises.push({ name, volume: sessionVol, e1RM: sessionBest1RM, sets: session.sets });
      }
    }
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  }, [logs, lifts, profile, blocks]);

  if (!stats) {
    return (
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-8 text-center`}>
        <div className="mb-2 flex justify-center"><BrandIcon name="apple" size={28} color={ORANGE} strokeWidth={1.6} /></div>
        <div className={`text-sm font-semibold ${theme.text}`}>No food logs yet</div>
      </div>
    );
  }

  const macroPct = {
    protein: Math.round((stats.avgProtein * 4 / stats.avgKcal) * 100) || 0,
    carbs: Math.round((stats.avgCarbs * 4 / stats.avgKcal) * 100) || 0,
    fat: Math.round((stats.avgFat * 9 / stats.avgKcal) * 100) || 0,
  };

  const proteinPerKg = profile.weight > 0 ? +(stats.avgProtein / profile.weight).toFixed(2) : 0;
  const proteinAdequacy = proteinPerKg >= 1.6 ? "high" : proteinPerKg >= 1.2 ? "moderate" : "low";

  return (
    <>
      {/* === Card 1: Daily Average + Macro Split === */}
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
        <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-1`}>Last 30 days · Daily Average</div>
        <div className={`text-3xl font-bold ${theme.text}`}>{stats.avgKcal.toLocaleString()} <span className={`text-sm font-normal ${theme.textMuted}`}>kcal</span></div>
        <div className="text-[11px] mt-0.5" style={{ color: stats.adherence >= 70 ? A_GREEN : ORANGE }}>
          {stats.adherence}% within ±200 of target
        </div>
        <div className="mt-4">
          <div className="h-3 rounded-full overflow-hidden flex">
            <div style={{ width: `${macroPct.protein}%`, backgroundColor: A_GREEN }} />
            <div style={{ width: `${macroPct.carbs}%`, backgroundColor: A_BLUE }} />
            <div style={{ width: `${macroPct.fat}%`, backgroundColor: A_PURPLE }} />
          </div>
          <div className="grid grid-cols-3 gap-2 mt-2 text-center">
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wide" style={{ color: A_GREEN }}>Protein</div>
              <div className={`text-sm font-bold ${theme.text}`}>{stats.avgProtein}g</div>
              <div className={`text-[10px] ${theme.textMuted}`}>{macroPct.protein}%</div>
            </div>
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wide" style={{ color: A_BLUE }}>Carbs</div>
              <div className={`text-sm font-bold ${theme.text}`}>{stats.avgCarbs}g</div>
              <div className={`text-[10px] ${theme.textMuted}`}>{macroPct.carbs}%</div>
            </div>
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wide" style={{ color: A_PURPLE }}>Fat</div>
              <div className={`text-sm font-bold ${theme.text}`}>{stats.avgFat}g</div>
              <div className={`text-[10px] ${theme.textMuted}`}>{macroPct.fat}%</div>
            </div>
          </div>
        </div>
      </div>

      {/* === Card 2: Protein Adequacy === */}
      <ProteinAdequacyCard proteinPerKg={proteinPerKg} adequacy={proteinAdequacy} avgProtein={stats.avgProtein} weight={profile.weight} theme={theme} />

      {/* === Card 3: Same-day Carbs vs Workout Volume === */}
      {nutritionPerformancePairs.length >= 5 && (
        <NutritionVsPerformanceScatter
          pairs={nutritionPerformancePairs}
          xKey="carbs"
          yKey="volume"
          xLabel="Same-day carbs (g)"
          yLabel="Workout volume (kg)"
          title="Same-day Carbs vs Workout Volume"
          theme={theme}
        />
      )}

      {/* === Card 4: Day-Before Carbs vs Workout Volume === */}
      {nutritionPerformancePairs.filter(p => p.prevCarbs > 0).length >= 5 && (
        <NutritionVsPerformanceScatter
          pairs={nutritionPerformancePairs.filter(p => p.prevCarbs > 0)}
          xKey="prevCarbs"
          yKey="volume"
          xLabel="Carbs day before (g)"
          yLabel="Workout volume (kg)"
          title="Day-Before Carbs vs Performance"
          subtitle="Yesterday's fuelling shows up in today's session"
          theme={theme}
        />
      )}

      {/* === Card 5: Calorie Surplus/Deficit vs Strength === */}
      {nutritionPerformancePairs.length >= 5 && (
        <SurplusVsStrengthCard pairs={nutritionPerformancePairs} theme={theme} />
      )}

      {/* === Card 6: Day-of-Week Performance === */}
      {nutritionPerformancePairs.length >= 7 && (
        <DayOfWeekCard pairs={nutritionPerformancePairs} theme={theme} />
      )}

      {/* === Card 7: Bodyweight vs Strength Trend === */}
      <BodyweightVsStrengthCard logs={logs} lifts={lifts} theme={theme} />
    </>
  );
}

// Protein adequacy block
function ProteinAdequacyCard({ proteinPerKg, adequacy, avgProtein, weight, theme }) {
  const targetPerKg = 1.8; // recommended for resistance training
  const targetGrams = Math.round(targetPerKg * weight);
  const pct = Math.min(100, (proteinPerKg / targetPerKg) * 100);
  const color = adequacy === "high" ? A_GREEN : adequacy === "moderate" ? ORANGE : A_RED;

  return (
    <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
      <div className="flex items-center justify-between mb-2">
        <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted}`}>Protein Adequacy</div>
        <div className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase" style={{ backgroundColor: `${color}20`, color }}>
          {adequacy}
        </div>
      </div>
      <div className="flex items-baseline gap-2 mb-1">
        <div className={`text-3xl font-bold ${theme.text}`}>{proteinPerKg}</div>
        <div className={`text-xs ${theme.textMuted}`}>g per kg bodyweight</div>
      </div>
      <div className={`text-[11px] ${theme.textMuted} mb-3`}>
        {avgProtein}g avg · target {targetGrams}g ({targetPerKg}g/kg for muscle gain)
      </div>
      <div className="h-2 bg-slate-700/30 rounded-full overflow-hidden mb-2">
        <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <p className={`text-[11px] ${theme.textSubtle} leading-snug`}>
        {adequacy === "high" && "Comfortably above the muscle-building threshold. Strong foundation for gains."}
        {adequacy === "moderate" && `Below the optimal range. Adding ~${targetGrams - avgProtein}g/day would improve recovery and muscle synthesis.`}
        {adequacy === "low" && `Significantly under-eating protein. Aim for ${targetGrams}g daily — this is the single biggest lever for strength gains.`}
      </p>
    </div>
  );
}

// Generic scatter plot for nutrition × performance
function NutritionVsPerformanceScatter({ pairs, xKey, yKey, xLabel, yLabel, title, subtitle, theme }) {
  const [tappedIdx, setTappedIdx] = useState(null);
  const xs = pairs.map(p => p[xKey]);
  const ys = pairs.map(p => p[yKey]);
  const corr = correlation(xs, ys);

  // Top 20% performers — what's their X average?
  const sortedByY = [...pairs].sort((a, b) => b[yKey] - a[yKey]);
  const top20 = sortedByY.slice(0, Math.max(1, Math.floor(pairs.length * 0.2)));
  const top20AvgX = Math.round(top20.reduce((s, p) => s + p[xKey], 0) / top20.length);

  const w = 320, h = 200;
  const pad = { top: 14, right: 12, bottom: 38, left: 38 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const minX = Math.min(...xs) * 0.9, maxX = Math.max(...xs) * 1.05;
  const minY = Math.min(...ys) * 0.9, maxY = Math.max(...ys) * 1.05;
  const xRange = maxX - minX || 1, yRange = maxY - minY || 1;
  const points = pairs.map(p => ({
    cx: pad.left + ((p[xKey] - minX) / xRange) * cw,
    cy: pad.top + (1 - (p[yKey] - minY) / yRange) * ch,
    data: p,
  }));

  // Best-fit line
  const { slope, intercept } = linearTrend(xs.map((x, i) => ({ x, y: ys[i] })));
  const lineX1 = minX, lineX2 = maxX;
  const lineY1 = slope * lineX1 + intercept;
  const lineY2 = slope * lineX2 + intercept;
  const trendStart = { x: pad.left, y: pad.top + (1 - (lineY1 - minY) / yRange) * ch };
  const trendEnd = { x: pad.left + cw, y: pad.top + (1 - (lineY2 - minY) / yRange) * ch };

  const tapped = tappedIdx !== null ? points[tappedIdx] : null;
  const corrLabel = Math.abs(corr) > 0.5 ? "Strong" : Math.abs(corr) > 0.3 ? "Moderate" : Math.abs(corr) > 0.15 ? "Weak" : "None";
  const corrColor = Math.abs(corr) > 0.3 ? A_GREEN : ORANGE;

  return (
    <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
      <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-1`}>{title}</div>
      {subtitle && <div className={`text-[10px] ${theme.textMuted} mb-2 italic`}>{subtitle}</div>}

      <div className="flex items-center gap-3 mb-3">
        <div>
          <div className="text-2xl font-bold" style={{ color: corrColor }}>{corr >= 0 ? "+" : ""}{corr.toFixed(2)}</div>
          <div className={`text-[9px] ${theme.textMuted} uppercase tracking-wide`}>Correlation</div>
        </div>
        <div className="flex-1">
          <div className={`text-[10px] uppercase tracking-wide font-bold`} style={{ color: corrColor }}>{corrLabel}</div>
          <div className={`text-[10px] ${theme.textMuted}`}>across {pairs.length} sessions</div>
        </div>
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${w} ${h}`} width="100%" onClick={() => setTappedIdx(null)}>
          {/* Grid */}
          <line x1={pad.left} y1={pad.top + ch} x2={pad.left + cw} y2={pad.top + ch} stroke={theme.border.includes("800") ? "#1e293b" : "#e2e8f0"} strokeWidth="0.5" />
          <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + ch} stroke={theme.border.includes("800") ? "#1e293b" : "#e2e8f0"} strokeWidth="0.5" />

          {/* Trend line */}
          {Math.abs(corr) > 0.15 && (
            <line x1={trendStart.x} y1={trendStart.y} x2={trendEnd.x} y2={trendEnd.y}
              stroke={corrColor} strokeWidth="1.5" strokeDasharray="4,3" opacity="0.6" />
          )}

          {/* Tap targets */}
          {points.map((p, i) => (
            <circle key={`t-${i}`} cx={p.cx} cy={p.cy} r="14" fill="transparent"
              onClick={(e) => { e.stopPropagation(); setTappedIdx(i === tappedIdx ? null : i); }}
              style={{ cursor: "pointer" }} />
          ))}

          {/* Points */}
          {points.map((p, i) => (
            <circle key={i} cx={p.cx} cy={p.cy} r={i === tappedIdx ? 6 : 4}
              fill={i === tappedIdx ? "white" : ORANGE} fillOpacity={i === tappedIdx ? 1 : 0.6}
              stroke={ORANGE} strokeWidth="1.5" pointerEvents="none" />
          ))}

          {/* Tap details */}
          {tapped && (() => {
            const labelW = 130, labelH = 36;
            const labelX = Math.max(pad.left, Math.min(pad.left + cw - labelW, tapped.cx - labelW / 2));
            const labelY = Math.max(pad.top + 2, tapped.cy - labelH - 10);
            return (
              <g pointerEvents="none">
                <line x1={tapped.cx} y1={pad.top} x2={tapped.cx} y2={pad.top + ch} stroke={ORANGE} strokeWidth="0.5" strokeDasharray="2,2" />
                <rect x={labelX} y={labelY} width={labelW} height={labelH} rx="3" fill={NAVY} stroke={ORANGE} strokeWidth="1" />
                <text x={labelX + labelW / 2} y={labelY + 13} fontSize="10" fontWeight="bold" fill="white" textAnchor="middle">
                  {new Date(tapped.data.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                </text>
                <text x={labelX + labelW / 2} y={labelY + 26} fontSize="9" fill={ORANGE} textAnchor="middle">
                  {tapped.data[xKey]}{xKey.includes("kcal") ? " kcal" : "g"} · {Math.round(tapped.data[yKey]).toLocaleString()}kg vol
                </text>
              </g>
            );
          })()}

          {/* Axis labels */}
          <text x={pad.left + cw / 2} y={h - 4} fontSize="9" fill={theme.textMuted.includes("400") ? "#64748b" : "#94a3b8"} textAnchor="middle">{xLabel}</text>
          <text x={8} y={pad.top + ch / 2} fontSize="9" fill={theme.textMuted.includes("400") ? "#64748b" : "#94a3b8"} textAnchor="middle" transform={`rotate(-90, 8, ${pad.top + ch / 2})`}>{yLabel}</text>

          {/* Min/max ticks */}
          <text x={pad.left} y={h - 18} fontSize="8" fill={theme.textMuted.includes("400") ? "#64748b" : "#94a3b8"} textAnchor="start">{Math.round(minX)}</text>
          <text x={pad.left + cw} y={h - 18} fontSize="8" fill={theme.textMuted.includes("400") ? "#64748b" : "#94a3b8"} textAnchor="end">{Math.round(maxX)}</text>
        </svg>
        <p className={`text-[9px] ${theme.textMuted} italic text-center mt-1`}>
          {tapped ? "Tap chart again to dismiss" : `Tap any point — each is one session (${pairs.length} total)`}
        </p>
      </div>

      {/* Drilldown — exercise breakdown for tapped session */}
      {tapped && tapped.data.exercises && tapped.data.exercises.length > 0 && (
        <div className={`mt-3 ${theme.surface} rounded-lg p-3`}>
          <div className="flex items-center justify-between mb-2">
            <span className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted}`}>Session breakdown</span>
            <span className={`text-[10px] ${theme.textMuted}`}>{tapped.data.exercises.length} exercises</span>
          </div>
          <div className="space-y-1.5">
            {[...tapped.data.exercises].sort((a, b) => b.volume - a.volume).map((ex, i) => {
              const sessionPct = (ex.volume / tapped.data.volume) * 100;
              return (
                <div key={i}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className={`text-[11px] font-semibold ${theme.text} truncate`}>{ex.name}</span>
                    <span className={`text-[10px] font-bold`} style={{ color: ORANGE }}>{Math.round(ex.volume).toLocaleString()}kg</span>
                  </div>
                  <div className="h-1 bg-slate-700/30 rounded-full overflow-hidden mb-0.5">
                    <div className="h-full" style={{ width: `${sessionPct}%`, backgroundColor: ORANGE }} />
                  </div>
                  <div className={`text-[9px] ${theme.textMuted}`}>
                    {ex.sets.length} sets · best e1RM {ex.e1RM.toFixed(1)}kg
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-lg p-3 mt-3" style={{ backgroundColor: `${ORANGE}15`, border: `1px solid ${ORANGE}55` }}>
        <div className="flex items-start gap-2">
          <BrandIcon name="lightbulb" size={16} color={ORANGE} strokeWidth={2} />
          <p className={`text-xs ${theme.textSubtle} leading-snug`}>
            Your top 20% sessions (by volume) average <span className="font-bold" style={{ color: ORANGE }}>{top20AvgX}g {xKey === "kcal" ? "calories" : xKey === "prevCarbs" ? "carbs the day before" : "carbs same-day"}</span>.
          </p>
        </div>
      </div>
    </div>
  );
}

// Calorie surplus/deficit vs strength
function SurplusVsStrengthCard({ pairs, theme }) {
  // Bucket: deep deficit (-500+), moderate deficit (-499 to -100), maintenance (±100), moderate surplus (+100 to +499), big surplus (+500+)
  const buckets = [
    { label: "Deep deficit", min: -Infinity, max: -500, color: A_RED, points: [] },
    { label: "Mod deficit", min: -500, max: -100, color: ORANGE, points: [] },
    { label: "Maintenance", min: -100, max: 100, color: A_BLUE, points: [] },
    { label: "Mod surplus", min: 100, max: 500, color: A_GREEN, points: [] },
    { label: "Big surplus", min: 500, max: Infinity, color: A_PURPLE, points: [] },
  ];
  for (const p of pairs) {
    const b = buckets.find(b => p.surplus >= b.min && p.surplus < b.max);
    if (b) b.points.push(p);
  }
  const populated = buckets.filter(b => b.points.length >= 2);
  if (populated.length < 2) return null;

  const maxAvgVol = Math.max(...populated.map(b => b.points.reduce((s, p) => s + p.volume, 0) / b.points.length));

  return (
    <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
      <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-1`}>Energy Balance vs Performance</div>
      <div className={`text-[10px] ${theme.textMuted} mb-3`}>Avg workout volume by calorie surplus/deficit</div>
      <div className="space-y-2">
        {populated.map(b => {
          const avgVol = b.points.reduce((s, p) => s + p.volume, 0) / b.points.length;
          const pct = (avgVol / maxAvgVol) * 100;
          return (
            <div key={b.label}>
              <div className="flex items-center justify-between mb-0.5">
                <span className={`text-xs font-semibold ${theme.text}`}>{b.label}</span>
                <span className="text-xs">
                  <span className="font-bold" style={{ color: b.color }}>{Math.round(avgVol)}kg</span>
                  <span className={`text-[10px] ml-1 ${theme.textMuted}`}>· {b.points.length} sess</span>
                </span>
              </div>
              <div className="h-2 bg-slate-700/30 rounded-full overflow-hidden">
                <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: b.color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Day-of-week performance
function DayOfWeekCard({ pairs, theme }) {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byDay = Array.from({ length: 7 }, () => ({ volumes: [], carbs: [], count: 0 }));
  for (const p of pairs) {
    byDay[p.dayOfWeek].volumes.push(p.volume);
    byDay[p.dayOfWeek].carbs.push(p.carbs);
    byDay[p.dayOfWeek].count++;
  }
  const dayData = byDay.map((d, i) => ({
    day: dayNames[i],
    avgVol: d.volumes.length ? Math.round(d.volumes.reduce((s, v) => s + v, 0) / d.volumes.length) : 0,
    avgCarbs: d.carbs.length ? Math.round(d.carbs.reduce((s, v) => s + v, 0) / d.carbs.length) : 0,
    count: d.count,
  })).filter(d => d.count > 0);

  if (dayData.length < 3) return null;

  const maxVol = Math.max(...dayData.map(d => d.avgVol));
  const bestDay = dayData.reduce((b, d) => d.avgVol > b.avgVol ? d : b, dayData[0]);

  return (
    <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
      <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-1`}>Day-of-Week Performance</div>
      <div className={`text-[10px] ${theme.textMuted} mb-3`}>Best volume tends to land on certain days</div>
      <div className="grid grid-cols-7 gap-1 mb-3">
        {dayData.map(d => {
          const pct = (d.avgVol / maxVol) * 100;
          const isBest = d.day === bestDay.day;
          return (
            <div key={d.day} className="text-center">
              <div className="h-20 flex items-end justify-center mb-1 relative">
                <div className="w-full rounded-t transition-all" style={{
                  height: `${pct}%`,
                  backgroundColor: isBest ? ORANGE : A_BLUE,
                  opacity: isBest ? 1 : 0.5
                }} />
              </div>
              <div className={`text-[9px] font-bold ${isBest ? "" : theme.textMuted}`} style={{ color: isBest ? ORANGE : "" }}>
                {d.day}
              </div>
              <div className={`text-[8px] ${theme.textMuted}`}>{d.avgVol}</div>
            </div>
          );
        })}
      </div>
      <div className="rounded-lg p-3" style={{ backgroundColor: `${ORANGE}15`, border: `1px solid ${ORANGE}55` }}>
        <p className={`text-xs ${theme.textSubtle} leading-snug`}>
          <span className="font-bold" style={{ color: ORANGE }}>{bestDay.day}</span> is your strongest day — avg {bestDay.avgVol}kg volume on {bestDay.avgCarbs}g carbs.
        </p>
      </div>
    </div>
  );
}

// Bodyweight vs Strength trend overlay
function BodyweightVsStrengthCard({ logs, lifts, theme }) {
  // Build weight series (last 30 days)
  const weightDates = Object.keys(logs).filter(d => logs[d].weight && logs[d].weightValue).sort();
  const weightSeries = weightDates.slice(-30).map(d => ({ date: d, value: logs[d].weightValue }));

  // Build strength series — average e1RM across all lifts per session date
  const strengthByDate = {};
  for (const data of Object.values(lifts || {})) {
    for (const s of data?.history || []) {
      const e1RM = s.sets.reduce((m, set) => Math.max(m, estimate1RM(set.weight, set.reps)), 0);
      if (!strengthByDate[s.date]) strengthByDate[s.date] = [];
      strengthByDate[s.date].push(e1RM);
    }
  }
  const strengthSeries = Object.keys(strengthByDate).sort().map(d => ({
    date: d,
    value: strengthByDate[d].reduce((s, v) => s + v, 0) / strengthByDate[d].length,
  }));

  if (weightSeries.length < 5 || strengthSeries.length < 3) return null;

  // Trends
  const wTrend = linearTrend(weightSeries.map((p, i) => ({ x: i, y: p.value })));
  const sTrend = linearTrend(strengthSeries.map((p, i) => ({ x: i, y: p.value })));

  const wDirection = wTrend.slope > 0.05 ? "up" : wTrend.slope < -0.05 ? "down" : "flat";
  const sDirection = sTrend.slope > 0.1 ? "up" : sTrend.slope < -0.1 ? "down" : "flat";

  let verdict, color;
  if (wDirection === "up" && sDirection === "up") {
    verdict = "Productive bulk — gaining weight AND strength. Lean tissue is being added.";
    color = A_GREEN;
  } else if (wDirection === "down" && sDirection === "up") {
    verdict = "Recomp in progress — losing weight WHILE gaining strength. Best-case scenario.";
    color = A_GREEN;
  } else if (wDirection === "down" && sDirection === "flat") {
    verdict = "Solid cut — losing weight while holding strength. Muscle is being preserved.";
    color = A_GREEN;
  } else if (wDirection === "down" && sDirection === "down") {
    verdict = "Under-fuelled — losing weight AND strength. Likely too aggressive a deficit, or low protein.";
    color = A_RED;
  } else if (wDirection === "up" && sDirection === "down") {
    verdict = "Gaining weight without strength gains — surplus may be excessive or programming needs review.";
    color = A_RED;
  } else if (wDirection === "up" && sDirection === "flat") {
    verdict = "Weight up, strength flat — risk of fat-only gain. Add intensity or check sleep/recovery.";
    color = ORANGE;
  } else {
    verdict = "Weight and strength both stable — maintenance phase or plateau.";
    color = A_BLUE;
  }

  // Mini chart with both lines
  const w = 320, h = 140;
  const pad = { top: 14, right: 16, bottom: 22, left: 32 };
  const cw = w - pad.left - pad.right, ch = h - pad.top - pad.bottom;

  const wMin = Math.min(...weightSeries.map(p => p.value)) * 0.99;
  const wMax = Math.max(...weightSeries.map(p => p.value)) * 1.01;
  const sMin = Math.min(...strengthSeries.map(p => p.value)) * 0.95;
  const sMax = Math.max(...strengthSeries.map(p => p.value)) * 1.05;

  const wPts = weightSeries.map((p, i) => {
    const x = pad.left + (i / (weightSeries.length - 1)) * cw;
    const y = pad.top + (1 - (p.value - wMin) / (wMax - wMin || 1)) * ch;
    return `${x},${y}`;
  }).join(" ");
  const sPts = strengthSeries.map((p, i) => {
    const x = pad.left + (i / (strengthSeries.length - 1)) * cw;
    const y = pad.top + (1 - (p.value - sMin) / (sMax - sMin || 1)) * ch;
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
      <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-1`}>Bodyweight vs Strength Trend</div>
      <div className={`text-[10px] ${theme.textMuted} mb-3`}>Reading both together tells you what your body is actually doing</div>

      <svg viewBox={`0 0 ${w} ${h}`} width="100%" className="mb-2">
        <line x1={pad.left} y1={pad.top + ch} x2={pad.left + cw} y2={pad.top + ch} stroke={theme.border.includes("800") ? "#1e293b" : "#e2e8f0"} strokeWidth="0.5" />
        <polyline fill="none" stroke={A_BLUE} strokeWidth="2" points={wPts} strokeLinejoin="round" />
        <polyline fill="none" stroke={ORANGE} strokeWidth="2" points={sPts} strokeLinejoin="round" />
        <text x={pad.left} y={10} fontSize="9" fill={A_BLUE} fontWeight="bold">— Weight</text>
        <text x={pad.left + 60} y={10} fontSize="9" fill={ORANGE} fontWeight="bold">— Avg e1RM</text>
      </svg>

      <div className="rounded-lg p-3" style={{ backgroundColor: `${color}15`, border: `1px solid ${color}55` }}>
        <p className={`text-xs ${theme.textSubtle} leading-snug`}>{verdict}</p>
      </div>
    </div>
  );
}

// Insights strip
function AnInsightsStrip({ profile, logs, lifts, blocks, theme }) {
  const insights = useMemo(() => {
    const out = [];
    const liftEntries = Object.entries(lifts).filter(([_, d]) => d?.history?.length >= 3);
    if (liftEntries.length > 0) {
      const growing = liftEntries.filter(([_, d]) => {
        const h = d.history;
        const first = h[0].sets.reduce((m, s) => Math.max(m, estimate1RM(s.weight, s.reps)), 0);
        const last = h[h.length - 1].sets.reduce((m, s) => Math.max(m, estimate1RM(s.weight, s.reps)), 0);
        return last > first * 1.02;
      }).length;
      const growthPct = Math.round((growing / liftEntries.length) * 100);
      if (growthPct >= 60) out.push({ icon: "up", color: A_GREEN, title: "Most lifts trending up", body: `${growthPct}% of tracked exercises gaining strength.` });
      else if (growthPct < 30) out.push({ icon: "warning", color: ORANGE, title: "Strength stalling", body: `Only ${growthPct}% of exercises growing. Consider rotating or checking recovery.` });
    }

    // Carbs correlation
    const trainingDays = [];
    for (const [_, data] of Object.entries(lifts)) {
      for (const s of data?.history || []) {
        const log = logs[s.date];
        if (log?.food && log.carbsEaten) {
          const vol = s.sets.reduce((sum, set) => sum + set.weight * set.reps, 0);
          trainingDays.push({ vol, carbs: log.carbsEaten });
        }
      }
    }
    if (trainingDays.length >= 8) {
      const corr = correlation(trainingDays.map(p => p.carbs), trainingDays.map(p => p.vol));
      if (corr > 0.35) {
        const top = [...trainingDays].sort((a, b) => b.vol - a.vol).slice(0, Math.max(1, Math.floor(trainingDays.length * 0.2)));
        const avgCarbs = Math.round(top.reduce((s, d) => s + d.carbs, 0) / top.length);
        out.push({ icon: "apple", color: A_GREEN, title: "Carbs help your performance", body: `Top 20% workouts happen at carbs > ${avgCarbs}g.` });
      }
    }

    // Adherence
    const dates = Object.keys(logs).filter(d => logs[d].food).sort();
    if (dates.length >= 14) {
      const last14 = dates.slice(-14);
      const within = last14.filter(d => {
        const block = blocks?.find(b => d >= b.startDate && (!b.endDate || d < b.endDate));
        const target = block ? block.calTarget : calculateTargets(profile).calTarget;
        return Math.abs((logs[d].kcalEaten || 0) - target) < 200;
      }).length;
      const adherence = Math.round((within / last14.length) * 100);
      if (adherence >= 80) out.push({ icon: "target", color: A_GREEN, title: "Dialled in on calories", body: `${adherence}% of last 14 days within ±200.` });
      else if (adherence < 40) out.push({ icon: "down", color: ORANGE, title: "Calorie variability is high", body: `Only ${adherence}% within target range.` });
    }

    // Fatigue insight
    const fatigue = analyseFatigue(lifts);
    if (fatigue.length > 0) {
      const top = fatigue[0];
      if (top.score >= 60) {
        out.push({ icon: "warning", color: ORANGE, title: `${top.name} fatiguing fast`, body: `RIR drops by ${top.avgRirDrop} from set 1 to last. Consider fewer sets or moving it earlier.` });
      }
    }

    if (out.length === 0) {
      out.push({ icon: "lightbulb", color: A_BLUE, title: "Building your data picture", body: "Log more sessions and food to unlock pattern-based insights." });
    }
    return out.slice(0, 5);
  }, [profile, logs, lifts, blocks]);

  return (
    <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-bold uppercase tracking-wide flex items-center gap-1.5" style={{ color: ORANGE }}>
          Insights for You
        </div>
        <div className={`text-[10px] ${theme.textMuted}`}>{insights.length} found</div>
      </div>
      <div className="space-y-2">
        {insights.map((i, idx) => (
          <div key={idx} className={`${theme.surface} rounded-lg p-3 flex items-start gap-3`}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${i.color}20` }}>
              <BrandIcon name={i.icon} size={18} color={i.color} strokeWidth={2} />
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-bold ${theme.text}`}>{i.title}</div>
              <div className={`text-[11px] ${theme.textMuted} mt-0.5 leading-snug`}>{i.body}</div>
            </div>
          </div>
        ))}
      </div>
      <p className={`text-[9px] ${theme.textMuted} italic mt-3 text-center`}>
        Based on patterns in your logged data — not medical advice.
      </p>
    </div>
  );
}

// ============================================================
// FOOD TAB — dedicated nutrition tab with API search + barcode lookup
// ============================================================

// Built-in food database — works offline and in sandboxed environments.
// Used as a fallback when the OFF API is unreachable, and as an instant-results
// layer for very common foods (faster than network).
const BUILTIN_FOOD_DB = [
  // Proteins
  { id: "bi-chicken-breast", name: "Chicken breast", brand: "Generic", per100g: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 } },
  { id: "bi-chicken-thigh", name: "Chicken thigh (skinless)", brand: "Generic", per100g: { kcal: 209, protein: 26, carbs: 0, fat: 11 } },
  { id: "bi-beef-mince-5", name: "Beef mince 5% fat", brand: "Generic", per100g: { kcal: 137, protein: 21, carbs: 0, fat: 5 } },
  { id: "bi-beef-mince-20", name: "Beef mince 20% fat", brand: "Generic", per100g: { kcal: 254, protein: 17, carbs: 0, fat: 20 } },
  { id: "bi-salmon", name: "Salmon fillet", brand: "Generic", per100g: { kcal: 208, protein: 20, carbs: 0, fat: 13 } },
  { id: "bi-tuna-can", name: "Tuna in spring water (drained)", brand: "Generic", per100g: { kcal: 116, protein: 26, carbs: 0, fat: 1 } },
  { id: "bi-cod", name: "Cod fillet", brand: "Generic", per100g: { kcal: 82, protein: 18, carbs: 0, fat: 0.7 } },
  { id: "bi-egg", name: "Egg, large (whole)", brand: "Generic", per100g: { kcal: 155, protein: 13, carbs: 1.1, fat: 11 } },
  { id: "bi-egg-white", name: "Egg whites", brand: "Generic", per100g: { kcal: 52, protein: 11, carbs: 0.7, fat: 0.2 } },
  { id: "bi-greek-yog-0", name: "Greek yoghurt 0% fat", brand: "Generic", per100g: { kcal: 59, protein: 10, carbs: 4, fat: 0 } },
  { id: "bi-greek-yog-full", name: "Greek yoghurt (full fat)", brand: "Generic", per100g: { kcal: 97, protein: 9, carbs: 4, fat: 5 } },
  { id: "bi-cottage", name: "Cottage cheese", brand: "Generic", per100g: { kcal: 98, protein: 11, carbs: 3.4, fat: 4.3 } },
  { id: "bi-protein-whey", name: "Whey protein (1 scoop, 30g)", brand: "Generic", per100g: { kcal: 380, protein: 80, carbs: 7, fat: 5 } },
  { id: "bi-tofu", name: "Tofu (firm)", brand: "Generic", per100g: { kcal: 144, protein: 17, carbs: 2.8, fat: 8.7 } },
  { id: "bi-tempeh", name: "Tempeh", brand: "Generic", per100g: { kcal: 192, protein: 20, carbs: 7.6, fat: 11 } },

  // Carbs
  { id: "bi-rice-white", name: "White rice (cooked)", brand: "Generic", per100g: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 } },
  { id: "bi-rice-brown", name: "Brown rice (cooked)", brand: "Generic", per100g: { kcal: 111, protein: 2.6, carbs: 23, fat: 0.9 } },
  { id: "bi-pasta", name: "Pasta (cooked)", brand: "Generic", per100g: { kcal: 131, protein: 5, carbs: 25, fat: 1.1 } },
  { id: "bi-bread-white", name: "White bread", brand: "Generic", per100g: { kcal: 265, protein: 9, carbs: 49, fat: 3.2 } },
  { id: "bi-bread-brown", name: "Wholemeal bread", brand: "Generic", per100g: { kcal: 247, protein: 13, carbs: 41, fat: 4.2 } },
  { id: "bi-oats", name: "Oats (dry)", brand: "Generic", per100g: { kcal: 389, protein: 16.9, carbs: 66, fat: 6.9 } },
  { id: "bi-potato", name: "Potato (boiled)", brand: "Generic", per100g: { kcal: 87, protein: 1.9, carbs: 20, fat: 0.1 } },
  { id: "bi-sweet-potato", name: "Sweet potato (baked)", brand: "Generic", per100g: { kcal: 90, protein: 2, carbs: 21, fat: 0.2 } },
  { id: "bi-quinoa", name: "Quinoa (cooked)", brand: "Generic", per100g: { kcal: 120, protein: 4.4, carbs: 21, fat: 1.9 } },
  { id: "bi-couscous", name: "Couscous (cooked)", brand: "Generic", per100g: { kcal: 112, protein: 3.8, carbs: 23, fat: 0.2 } },
  { id: "bi-cornflakes", name: "Cornflakes", brand: "Generic", per100g: { kcal: 357, protein: 7, carbs: 84, fat: 0.4 } },

  // Fruit
  { id: "bi-banana", name: "Banana", brand: "Generic", per100g: { kcal: 89, protein: 1.1, carbs: 23, fat: 0.3 } },
  { id: "bi-apple", name: "Apple", brand: "Generic", per100g: { kcal: 52, protein: 0.3, carbs: 14, fat: 0.2 } },
  { id: "bi-orange", name: "Orange", brand: "Generic", per100g: { kcal: 47, protein: 0.9, carbs: 12, fat: 0.1 } },
  { id: "bi-blueberries", name: "Blueberries", brand: "Generic", per100g: { kcal: 57, protein: 0.7, carbs: 14, fat: 0.3 } },
  { id: "bi-strawberries", name: "Strawberries", brand: "Generic", per100g: { kcal: 32, protein: 0.7, carbs: 7.7, fat: 0.3 } },
  { id: "bi-grapes", name: "Grapes", brand: "Generic", per100g: { kcal: 69, protein: 0.7, carbs: 18, fat: 0.2 } },
  { id: "bi-pineapple", name: "Pineapple", brand: "Generic", per100g: { kcal: 50, protein: 0.5, carbs: 13, fat: 0.1 } },
  { id: "bi-mango", name: "Mango", brand: "Generic", per100g: { kcal: 60, protein: 0.8, carbs: 15, fat: 0.4 } },
  { id: "bi-avocado", name: "Avocado", brand: "Generic", per100g: { kcal: 160, protein: 2, carbs: 9, fat: 15 } },

  // Veg
  { id: "bi-broccoli", name: "Broccoli (steamed)", brand: "Generic", per100g: { kcal: 35, protein: 2.4, carbs: 7.2, fat: 0.4 } },
  { id: "bi-spinach", name: "Spinach", brand: "Generic", per100g: { kcal: 23, protein: 2.9, carbs: 3.6, fat: 0.4 } },
  { id: "bi-kale", name: "Kale", brand: "Generic", per100g: { kcal: 49, protein: 4.3, carbs: 9, fat: 0.9 } },
  { id: "bi-tomato", name: "Tomato", brand: "Generic", per100g: { kcal: 18, protein: 0.9, carbs: 3.9, fat: 0.2 } },
  { id: "bi-cucumber", name: "Cucumber", brand: "Generic", per100g: { kcal: 16, protein: 0.7, carbs: 3.6, fat: 0.1 } },
  { id: "bi-pepper", name: "Bell pepper", brand: "Generic", per100g: { kcal: 31, protein: 1, carbs: 6, fat: 0.3 } },
  { id: "bi-carrot", name: "Carrot", brand: "Generic", per100g: { kcal: 41, protein: 0.9, carbs: 10, fat: 0.2 } },
  { id: "bi-onion", name: "Onion", brand: "Generic", per100g: { kcal: 40, protein: 1.1, carbs: 9, fat: 0.1 } },

  // Fats
  { id: "bi-olive-oil", name: "Olive oil", brand: "Generic", per100g: { kcal: 884, protein: 0, carbs: 0, fat: 100 } },
  { id: "bi-butter", name: "Butter", brand: "Generic", per100g: { kcal: 717, protein: 0.9, carbs: 0.1, fat: 81 } },
  { id: "bi-peanut-butter", name: "Peanut butter", brand: "Generic", per100g: { kcal: 588, protein: 25, carbs: 20, fat: 50 } },
  { id: "bi-almonds", name: "Almonds", brand: "Generic", per100g: { kcal: 579, protein: 21, carbs: 22, fat: 50 } },
  { id: "bi-cashews", name: "Cashews", brand: "Generic", per100g: { kcal: 553, protein: 18, carbs: 30, fat: 44 } },
  { id: "bi-walnuts", name: "Walnuts", brand: "Generic", per100g: { kcal: 654, protein: 15, carbs: 14, fat: 65 } },

  // Dairy
  { id: "bi-milk-skim", name: "Milk, skimmed", brand: "Generic", per100g: { kcal: 35, protein: 3.4, carbs: 5, fat: 0.1 } },
  { id: "bi-milk-whole", name: "Milk, whole", brand: "Generic", per100g: { kcal: 60, protein: 3.2, carbs: 4.7, fat: 3.3 } },
  { id: "bi-cheddar", name: "Cheddar cheese", brand: "Generic", per100g: { kcal: 402, protein: 25, carbs: 1.3, fat: 33 } },
  { id: "bi-mozzarella", name: "Mozzarella", brand: "Generic", per100g: { kcal: 280, protein: 28, carbs: 3.1, fat: 17 } },
  { id: "bi-feta", name: "Feta", brand: "Generic", per100g: { kcal: 264, protein: 14, carbs: 4.1, fat: 21 } },

  // Snacks / treats
  { id: "bi-choc-milk", name: "Milk chocolate bar", brand: "Generic", per100g: { kcal: 535, protein: 7.6, carbs: 59, fat: 30 } },
  { id: "bi-choc-dark", name: "Dark chocolate (70%)", brand: "Generic", per100g: { kcal: 598, protein: 7.8, carbs: 46, fat: 43 } },
  { id: "bi-crisps", name: "Potato crisps", brand: "Generic", per100g: { kcal: 536, protein: 6.6, carbs: 53, fat: 35 } },
  { id: "bi-popcorn", name: "Popcorn (air-popped)", brand: "Generic", per100g: { kcal: 387, protein: 13, carbs: 78, fat: 4.5 } },
  { id: "bi-icecream", name: "Vanilla ice cream", brand: "Generic", per100g: { kcal: 207, protein: 3.5, carbs: 24, fat: 11 } },
  { id: "bi-pizza", name: "Cheese pizza (slice average)", brand: "Generic", per100g: { kcal: 266, protein: 11, carbs: 33, fat: 10 } },
  { id: "bi-burger", name: "Cheeseburger", brand: "Generic", per100g: { kcal: 295, protein: 17, carbs: 24, fat: 14 } },

  // Drinks
  { id: "bi-beer", name: "Beer (pint, ~4.5%)", brand: "Generic", per100g: { kcal: 43, protein: 0.5, carbs: 3.6, fat: 0 } },
  { id: "bi-wine-red", name: "Red wine", brand: "Generic", per100g: { kcal: 85, protein: 0.1, carbs: 2.6, fat: 0 } },
  { id: "bi-coke", name: "Cola (sugar)", brand: "Generic", per100g: { kcal: 42, protein: 0, carbs: 11, fat: 0 } },
  { id: "bi-coke-zero", name: "Cola (diet/zero)", brand: "Generic", per100g: { kcal: 0, protein: 0, carbs: 0, fat: 0 } },
  { id: "bi-orange-juice", name: "Orange juice", brand: "Generic", per100g: { kcal: 45, protein: 0.7, carbs: 10, fat: 0.2 } },
  { id: "bi-coffee-black", name: "Black coffee", brand: "Generic", per100g: { kcal: 1, protein: 0.1, carbs: 0, fat: 0 } },
];

function searchBuiltinDB(query) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  return BUILTIN_FOOD_DB
    .filter(f => f.name.toLowerCase().includes(q))
    .map(f => ({ ...f, source: "builtin" }))
    .slice(0, 20);
}

// Open Food Facts API — public, no API key required.
// Uses v2 search endpoint (more reliable CORS than legacy cgi).
async function offSearchByName(query) {
  if (!query || query.length < 2) return [];
  try {
    const url = `https://world.openfoodfacts.org/api/v2/search?search_terms=${encodeURIComponent(query)}&page_size=20&fields=code,product_name,brands,nutriments,quantity,image_small_url`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.products || [])
      .filter(p => p.product_name && p.nutriments?.["energy-kcal_100g"])
      .map(p => ({ ...offProductToFood(p), source: "off" }));
  } catch (e) {
    console.warn("OFF search failed:", e.message);
    return null; // null = network failure (vs [] = no results)
  }
}

async function offFetchByBarcode(barcode) {
  if (!barcode) return null;
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=code,product_name,brands,nutriments,quantity,image_small_url`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.status !== 1 || !data.product) return null;
    return offProductToFood(data.product);
  } catch (e) {
    console.warn("OFF barcode failed:", e.message);
    return { error: e.message || "Network error" };
  }
}

// Normalise an Open Food Facts product into our food shape (per-100g defaults)
function offProductToFood(p) {
  const n = p.nutriments || {};
  return {
    id: p.code || `off-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    barcode: p.code,
    name: p.product_name || "Unknown product",
    brand: p.brands || "",
    image: p.image_small_url || null,
    quantity: p.quantity || "",
    // Per-100g values
    per100g: {
      kcal: Math.round(n["energy-kcal_100g"] || 0),
      protein: +(n["proteins_100g"] || 0).toFixed(1),
      carbs: +(n["carbohydrates_100g"] || 0).toFixed(1),
      fat: +(n["fat_100g"] || 0).toFixed(1),
      sugar: +(n["sugars_100g"] || 0).toFixed(1),
      fibre: +(n["fiber_100g"] || 0).toFixed(1),
    },
    // Per-serving if available
    perServing: n["energy-kcal_serving"] ? {
      kcal: Math.round(n["energy-kcal_serving"]),
      protein: +(n["proteins_serving"] || 0).toFixed(1),
      carbs: +(n["carbohydrates_serving"] || 0).toFixed(1),
      fat: +(n["fat_serving"] || 0).toFixed(1),
      servingSize: n.serving_size || "",
    } : null,
  };
}

// Task analytics: completion rate (last 30d) and current streak per task
function AnTasks({ tasks, responses, theme, blocks }) {
  const today = new Date().toISOString().split("T")[0];
  const activeBlockEnd = useMemo(() => {
    const current = blocks?.find(b => b.startDate <= today && b.endDate >= today);
    return current?.endDate || null;
  }, [blocks, today]);

  // For each non-archived task, calculate completion rate (% of active days
  // completed) and current streak (consecutive days backwards from today
  // that are either complete OR not-active-on-that-day).
  const stats = useMemo(() => {
    return tasks.filter(t => !t.archived).map(t => {
      // Look back 30 days
      const activeDays = [];
      const completedDays = [];
      for (let i = 0; i < 30; i++) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const ds = d.toISOString().split("T")[0];
        if (taskIsActiveOn(t, ds, activeBlockEnd)) {
          activeDays.push(ds);
          const r = getTaskResponse(responses, ds, t.id);
          if (taskIsComplete(t, r)) completedDays.push(ds);
        }
      }
      const rate = activeDays.length > 0 ? (completedDays.length / activeDays.length) * 100 : 0;

      // Streak: walk back from today; each active day must be complete to continue.
      // Non-active days are skipped (don't break the streak).
      let streak = 0;
      let broke = false;
      for (let i = 0; i < 60 && !broke; i++) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const ds = d.toISOString().split("T")[0];
        if (!taskIsActiveOn(t, ds, activeBlockEnd)) continue;
        const r = getTaskResponse(responses, ds, t.id);
        if (taskIsComplete(t, r)) streak++;
        else broke = true;
      }

      // Best streak in window (last 60 days)
      let best = 0, run = 0;
      for (let i = 59; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const ds = d.toISOString().split("T")[0];
        if (!taskIsActiveOn(t, ds, activeBlockEnd)) continue;
        const r = getTaskResponse(responses, ds, t.id);
        if (taskIsComplete(t, r)) { run++; if (run > best) best = run; }
        else run = 0;
      }

      // For number-type tasks, also compute average value over completed days
      let avgValue = null;
      if (t.type === "number" && completedDays.length > 0) {
        const sum = completedDays.reduce((acc, ds) => {
          const r = getTaskResponse(responses, ds, t.id);
          const v = typeof r === "object" ? r.value : r;
          return acc + (Number(v) || 0);
        }, 0);
        avgValue = sum / completedDays.length;
      }

      return { task: t, rate, completedDays: completedDays.length, activeDays: activeDays.length, streak, best, avgValue };
    });
  }, [tasks, responses, activeBlockEnd, today]);

  if (stats.length === 0) {
    return (
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-8 text-center`}>
        <div className="mb-3 flex justify-center"><BrandIcon name="task" size={32} color={ORANGE} strokeWidth={1.6} /></div>
        <h3 className={`font-bold text-base mb-1 ${theme.text}`}>No custom tasks yet</h3>
        <p className={`text-xs ${theme.textMuted} leading-relaxed`}>
          Create tasks in More → Custom tasks. Once you have some, this view tracks your completion rate and streak per task.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className={`text-[11px] ${theme.textMuted} px-1 -mt-1 leading-snug`}>
        Completion rate is over the last 30 days, counting only days the task was scheduled. Streak counts consecutive scheduled days completed (non-scheduled days skipped).
      </p>
      {stats.map(({ task, rate, completedDays, activeDays, streak, best, avgValue }) => {
        const rateColor = rate >= 80 ? "#10b981" : rate >= 50 ? "#f59e0b" : "#ef4444";
        return (
          <div key={task.id} className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex-1 min-w-0">
                <h4 className={`font-bold text-sm ${theme.text}`}>{task.name}</h4>
                <p className={`text-[10px] ${theme.textMuted}`}>
                  {task.type === "tick" ? "Tick" : task.type === "number" ? `Number${task.target ? ` (target ${task.target}${task.unit || ""})` : ""}` : "Note"}
                  {task.countsTowardStreak === false && " · not counted in streak"}
                </p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold" style={{ color: rateColor }}>{Math.round(rate)}%</div>
                <div className={`text-[10px] ${theme.textMuted}`}>{completedDays} / {activeDays} days</div>
              </div>
            </div>

            {/* Completion-rate bar */}
            <div className="h-2 bg-slate-700/30 rounded-full overflow-hidden mb-3">
              <div className="h-full transition-all" style={{ width: `${rate}%`, backgroundColor: rateColor }} />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className={`${theme.surface} rounded-lg p-2 text-center`}>
                <div className={`text-[9px] font-bold uppercase tracking-wider ${theme.textMuted}`}>Streak</div>
                <div className="text-lg font-bold" style={{ color: streak > 0 ? ORANGE : "" }}>
                  <span className={streak > 0 ? "" : theme.textMuted}>{streak}</span>
                </div>
                <div className={`text-[9px] ${theme.textMuted}`}>{streak === 1 ? "day" : "days"}</div>
              </div>
              <div className={`${theme.surface} rounded-lg p-2 text-center`}>
                <div className={`text-[9px] font-bold uppercase tracking-wider ${theme.textMuted}`}>Best</div>
                <div className={`text-lg font-bold ${theme.text}`}>{best}</div>
                <div className={`text-[9px] ${theme.textMuted}`}>{best === 1 ? "day" : "days"}</div>
              </div>
              {task.type === "number" && avgValue !== null ? (
                <div className={`${theme.surface} rounded-lg p-2 text-center`}>
                  <div className={`text-[9px] font-bold uppercase tracking-wider ${theme.textMuted}`}>Avg</div>
                  <div className={`text-lg font-bold ${theme.text}`}>{avgValue.toFixed(1)}</div>
                  <div className={`text-[9px] ${theme.textMuted}`}>{task.unit || ""}</div>
                </div>
              ) : (
                <div className={`${theme.surface} rounded-lg p-2 text-center`}>
                  <div className={`text-[9px] font-bold uppercase tracking-wider ${theme.textMuted}`}>Sched</div>
                  <div className={`text-xs font-bold ${theme.text} mt-1`}>
                    {task.schedule?.kind === "daily" ? "Daily" : task.schedule?.kind === "weekly" ? "Weekly" : `${(task.schedule?.days || []).length}/wk`}
                  </div>
                  <div className={`text-[9px] ${theme.textMuted}`}>
                    {task.schedule?.endKind === "forever" ? "ongoing" : task.schedule?.endKind === "block" ? "this block" : "to date"}
                  </div>
                </div>
              )}
            </div>

            {/* Last 14 days strip — green=done, grey=missed-and-scheduled, dim=not scheduled */}
            <div className="mt-3">
              <div className={`text-[9px] font-bold uppercase tracking-wider ${theme.textMuted} mb-1`}>Last 14 days</div>
              <div className="flex gap-1">
                {Array.from({ length: 14 }, (_, i) => 13 - i).map(daysBack => {
                  const d = new Date(today); d.setDate(d.getDate() - daysBack);
                  const ds = d.toISOString().split("T")[0];
                  const active = taskIsActiveOn(task, ds, activeBlockEnd);
                  if (!active) {
                    return <div key={daysBack} className="flex-1 h-5 rounded" style={{ backgroundColor: "#94a3b815" }} title={`${ds} · not scheduled`} />;
                  }
                  const r = getTaskResponse(responses, ds, task.id);
                  const done = taskIsComplete(task, r);
                  return <div key={daysBack} className="flex-1 h-5 rounded" style={{ backgroundColor: done ? "#10b981" : "#ef444455" }} title={`${ds} · ${done ? "done" : "missed"}`} />;
                })}
              </div>
              <div className="flex justify-between mt-0.5">
                <span className={`text-[9px] ${theme.textMuted}`}>14d ago</span>
                <span className={`text-[9px] ${theme.textMuted}`}>today</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Lightweight wrapper: render History without its top gradient header (because Insights already has one)
function HistoryEmbed({ session, profile, themeCtx }) {
  return <History session={session} profile={profile} themeCtx={themeCtx} hideHeader />;
}

function FoodTab({ session, profile, themeCtx }) {
  const { theme } = themeCtx;
  const [logs, setLogs] = useState({});
  const [savedFoods, setSavedFoods] = useState([]);
  const [recentFoods, setRecentFoods] = useState([]);
  const [subTab, setSubTab] = useState("today"); // today | search | saved | history
  const [searchMode, setSearchMode] = useState("text"); // text | barcode
  const [searchQuery, setSearchQuery] = useState("");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedFood, setSelectedFood] = useState(null);

  // The day currently being viewed/edited. Defaults to today.
  // Stepper lets user go back to see/edit past days' meals.
  const today = new Date().toISOString().split("T")[0];
  const [viewDate, setViewDate] = useState(today);
  const [showQuickAdd, setShowQuickAdd] = useState(false); // free-form FoodLogger modal
  const targets = useMemo(() => calculateTargets(profile), [profile]);

  // Load logs + saved foods
  useEffect(() => {
    (async () => {
      setLogs((await storage.get(userKey(session.id, "logs"))) || {});
      setSavedFoods((await storage.get(userKey(session.id, "saved-foods"))) || []);
      setRecentFoods((await storage.get(userKey(session.id, "recent-foods"))) || []);
    })();
  }, [session.id]);

  // Listen for Home Food card requesting to jump to a specific date
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.date) setViewDate(e.detail.date);
      if (e.detail?.quickAdd) setShowQuickAdd(true);
    };
    window.addEventListener("sinc:food-tab-focus", handler);
    return () => window.removeEventListener("sinc:food-tab-focus", handler);
  }, []);

  const todayLog = logs[viewDate] || { kcalEaten: 0, proteinEaten: 0, fatEaten: 0, carbsEaten: 0, meals: [] };
  const isViewingToday = viewDate === today;

  // Step the viewed date by N days (negative = backward)
  const stepDate = (deltaDays) => {
    const d = new Date(viewDate);
    d.setDate(d.getDate() + deltaDays);
    const next = d.toISOString().split("T")[0];
    // Don't allow stepping forward past today
    if (next > today) return;
    setViewDate(next);
  };

  const reload = async () => {
    setLogs((await storage.get(userKey(session.id, "logs"))) || {});
    setRecentFoods((await storage.get(userKey(session.id, "recent-foods"))) || []);
  };

  // Add a food to the currently-viewed day's log (defaults to today via viewDate)
  const addFoodToLog = async (food, grams, mealType = "Snack") => {
    const factor = grams / 100;
    const kcal = Math.round(food.per100g.kcal * factor);
    const protein = +(food.per100g.protein * factor).toFixed(1);
    const carbs = +(food.per100g.carbs * factor).toFixed(1);
    const fat = +(food.per100g.fat * factor).toFixed(1);

    const next = { ...logs };
    if (!next[viewDate]) next[viewDate] = { food: false, kcalEaten: 0, proteinEaten: 0, fatEaten: 0, carbsEaten: 0, weight: false, weightValue: 0, meals: [] };
    next[viewDate] = {
      ...next[viewDate],
      food: true,
      kcalEaten: (next[viewDate].kcalEaten || 0) + kcal,
      proteinEaten: +((next[viewDate].proteinEaten || 0) + protein).toFixed(1),
      carbsEaten: +((next[viewDate].carbsEaten || 0) + carbs).toFixed(1),
      fatEaten: +((next[viewDate].fatEaten || 0) + fat).toFixed(1),
      meals: [...(next[viewDate].meals || []), {
        name: mealType,
        food: food.name,
        brand: food.brand,
        grams,
        kcal, protein, carbs, fat,
        addedAt: new Date().toISOString(),
      }],
    };
    await storage.set(userKey(session.id, "logs"), next);
    setLogs(next);
    // Notify other components (Home) to refresh their copy of logs
    window.dispatchEvent(new CustomEvent("sinc:logs-changed"));

    // Update recent foods (most recent first, max 20, dedup by id)
    const recents = [food, ...recentFoods.filter(f => f.id !== food.id)].slice(0, 20);
    await storage.set(userKey(session.id, "recent-foods"), recents);
    setRecentFoods(recents);

    setSelectedFood(null);
  };

  // Save a food to favorites
  const toggleSaved = async (food) => {
    const exists = savedFoods.find(f => f.id === food.id);
    const next = exists ? savedFoods.filter(f => f.id !== food.id) : [...savedFoods, food];
    await storage.set(userKey(session.id, "saved-foods"), next);
    setSavedFoods(next);
  };

  // Search trigger
  const doSearch = async () => {
    setSearching(true);
    setSearchError("");
    try {
      if (searchMode === "barcode" && barcodeInput) {
        const result = await offFetchByBarcode(barcodeInput.trim());
        if (result?.error) {
          setSearchError(`Couldn't reach Open Food Facts (${result.error}). In production this works — the artifact preview blocks some external requests.`);
          setSearchResults([]);
        } else if (result) {
          setSearchResults([{ ...result, source: "off" }]);
        } else {
          setSearchError("Barcode not found in Open Food Facts. Try text search instead.");
          setSearchResults([]);
        }
      } else if (searchMode === "text" && searchQuery.length >= 2) {
        // Always check built-in DB first — instant, works offline
        const builtin = searchBuiltinDB(searchQuery);
        // Try OFF in parallel
        const offResults = await offSearchByName(searchQuery);
        if (offResults === null) {
          // Network failure — show builtin only
          if (builtin.length > 0) {
            setSearchResults(builtin);
            setSearchError("Couldn't reach Open Food Facts — showing built-in foods only. (Online API works in the production app.)");
          } else {
            setSearchResults([]);
            setSearchError("Couldn't reach Open Food Facts and no built-in match. Try a simpler query like 'chicken' or 'rice'. (Online API works in the production app.)");
          }
        } else {
          // Combine: builtin first (verified), then OFF (community-sourced)
          const combined = [...builtin, ...offResults];
          setSearchResults(combined);
          if (combined.length === 0) setSearchError("No matches found. Try a different term.");
        }
      }
    } catch (e) {
      setSearchError(`Search error: ${e.message}`);
      setSearchResults([]);
    }
    setSearching(false);
  };

  return (
    <div>
      {/* Header */}
      <div className="px-5 pt-10 pb-5 text-white relative overflow-hidden" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
        <img src={HERO_CURL_B64} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ opacity: 0.30, mixBlendMode: "luminosity" }} />
        <div className="relative">
          <Wordmark />
          <div className="mt-4">
            <h1 className="text-2xl font-bold flex items-center gap-2">
              Food
              <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded border" style={{ color: ORANGE, borderColor: ORANGE }}>
                OPEN FOOD FACTS
              </span>
            </h1>
            <p className="text-blue-100 text-xs mt-1 italic">Track meals. Search 3M+ foods. Scan barcodes.</p>
          </div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="px-3 pt-3 mb-3 overflow-x-auto">
        <div className="flex gap-1.5 pb-1">
          {[
            { id: "today", l: "Day", icon: "calendar" },
            { id: "search", l: "Search", icon: "search" },
            { id: "saved", l: "Saved", icon: "star" },
            { id: "history", l: "History", icon: "up" },
          ].map(t => (
            <button key={t.id} onClick={() => setSubTab(t.id)}
              className={`px-3 h-10 rounded-lg font-semibold text-xs whitespace-nowrap flex-shrink-0 flex items-center gap-1.5 ${subTab === t.id ? "" : `${theme.surface} ${theme.surfaceText}`}`}
              style={{ backgroundColor: subTab === t.id ? ORANGE : "", color: subTab === t.id ? "white" : "" }}>
              <BrandIcon name={t.icon} size={14} color={subTab === t.id ? "white" : "currentColor"} strokeWidth={2} />
              <span>{t.l}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 space-y-3">
        {subTab === "today" && (
          <>
            {/* Date stepper — tap arrows to view past days. Can't go forward past today. */}
            <div className={`flex items-center justify-between ${theme.card} rounded-xl border ${theme.border} p-2`}>
              <button onClick={() => stepDate(-1)} className={`w-10 h-10 ${theme.surface} ${theme.surfaceText} rounded-lg font-bold`}>‹</button>
              <div className="text-center">
                <div className={`text-sm font-bold ${theme.text}`}>
                  {isViewingToday ? "Today" : new Date(viewDate).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}
                </div>
                {!isViewingToday && (
                  <button onClick={() => setViewDate(today)} className="text-[10px] underline" style={{ color: ORANGE }}>Jump to today</button>
                )}
              </div>
              <button onClick={() => stepDate(1)} disabled={isViewingToday}
                className={`w-10 h-10 ${theme.surface} ${theme.surfaceText} rounded-lg font-bold disabled:opacity-30`}>›</button>
            </div>

            <FoodTodayView log={todayLog} targets={targets} theme={theme}
              onQuickAdd={() => setSubTab("search")}
              onFreeForm={() => setShowQuickAdd(true)}
              isPast={!isViewingToday}
              onRemoveMeal={async (idx) => {
                const meal = todayLog.meals?.[idx]; if (!meal) return;
                const next = { ...logs };
                next[viewDate] = {
                  ...next[viewDate],
                  kcalEaten: Math.max(0, (next[viewDate].kcalEaten || 0) - (meal.kcal || 0)),
                  proteinEaten: Math.max(0, (next[viewDate].proteinEaten || 0) - (meal.protein || meal.p || 0)),
                  carbsEaten: Math.max(0, (next[viewDate].carbsEaten || 0) - (meal.carbs || meal.c || 0)),
                  fatEaten: Math.max(0, (next[viewDate].fatEaten || 0) - (meal.fat || meal.f || 0)),
                  meals: (next[viewDate].meals || []).filter((_, i) => i !== idx),
                };
                await storage.set(userKey(session.id, "logs"), next);
                setLogs(next);
                window.dispatchEvent(new CustomEvent("sinc:logs-changed"));
              }}
            />
          </>
        )}

        {subTab === "search" && (
          <FoodSearchView
            searchMode={searchMode} setSearchMode={setSearchMode}
            searchQuery={searchQuery} setSearchQuery={setSearchQuery}
            barcodeInput={barcodeInput} setBarcodeInput={setBarcodeInput}
            searchResults={searchResults} searching={searching} searchError={searchError}
            onSearch={doSearch}
            recentFoods={recentFoods} savedFoods={savedFoods}
            onPick={setSelectedFood}
            theme={theme}
          />
        )}

        {subTab === "saved" && (
          <FoodSavedView savedFoods={savedFoods} onPick={setSelectedFood} onUnsave={toggleSaved} theme={theme} />
        )}

        {subTab === "history" && (
          <FoodHistoryView logs={logs} targets={targets} theme={theme} />
        )}
      </div>

      {/* Add-food modal */}
      {selectedFood && (
        <FoodAddModal
          food={selectedFood}
          isSaved={savedFoods.some(f => f.id === selectedFood.id)}
          onAdd={addFoodToLog}
          onSave={toggleSaved}
          onClose={() => setSelectedFood(null)}
          theme={theme}
        />
      )}

      {/* Quick-add free-form meal logger (estimate from text, templates, manual entry) */}
      {showQuickAdd && (
        <FoodLogger
          session={session}
          existing={todayLog}
          dayLabel={isViewingToday ? "today" : new Date(viewDate).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}
          onSave={async (data) => {
            const next = { ...logs };
            next[viewDate] = { ...next[viewDate], ...data, food: true };
            await storage.set(userKey(session.id, "logs"), next);
            setLogs(next);
            window.dispatchEvent(new CustomEvent("sinc:logs-changed"));
            setShowQuickAdd(false);
          }}
          onClose={() => setShowQuickAdd(false)}
          theme={theme}
        />
      )}
    </div>
  );
}

// ── Day view: progress + meals list ──
function FoodTodayView({ log, targets, theme, onQuickAdd, onRemoveMeal, onFreeForm, isPast }) {
  const meals = log.meals || [];
  const kcalPct = targets.calTarget > 0 ? Math.min(100, (log.kcalEaten / targets.calTarget) * 100) : 0;
  const remaining = targets.calTarget - (log.kcalEaten || 0);

  // Group meals by name
  const byMeal = {};
  meals.forEach((m, idx) => {
    if (!byMeal[m.name]) byMeal[m.name] = [];
    byMeal[m.name].push({ ...m, idx });
  });

  return (
    <>
      {/* Today summary */}
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
        <div className="flex items-center justify-between mb-2">
          <div className={`text-[10px] uppercase tracking-wider font-bold ${theme.textMuted}`}>Today's Intake</div>
          <div className="text-[10px] font-bold" style={{ color: remaining > 0 ? A_GREEN : remaining < -200 ? A_RED : ORANGE }}>
            {remaining > 0 ? `${remaining} left` : remaining === 0 ? "On target" : `${Math.abs(remaining)} over`}
          </div>
        </div>
        <div className="flex items-baseline gap-2 mb-3">
          <div className={`text-4xl font-bold ${theme.text}`}>{Math.round(log.kcalEaten || 0).toLocaleString()}</div>
          <div className={`text-sm ${theme.textMuted}`}>/ {targets.calTarget.toLocaleString()} kcal</div>
        </div>
        <div className="h-2 bg-slate-700/30 rounded-full overflow-hidden mb-4">
          <div className="h-full transition-all" style={{ width: `${kcalPct}%`, backgroundColor: kcalPct > 100 ? A_RED : ORANGE }} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <FoodMacroBar label="Protein" value={log.proteinEaten || 0} target={targets.protein} color={A_GREEN} unit="g" />
          <FoodMacroBar label="Carbs" value={log.carbsEaten || 0} target={targets.carbs} color={A_BLUE} unit="g" />
          <FoodMacroBar label="Fat" value={log.fatEaten || 0} target={targets.fat} color={A_PURPLE} unit="g" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button onClick={onQuickAdd} className="h-14 rounded-xl font-bold text-base text-white flex items-center justify-center gap-2"
          style={{ backgroundColor: ORANGE }}>
          <span>+ Search food</span>
        </button>
        <button onClick={onFreeForm} className={`h-14 rounded-xl font-bold text-base ${theme.surface} ${theme.surfaceText} flex items-center justify-center gap-2 border-2`}
          style={{ borderColor: ORANGE }}>
          <span style={{ color: ORANGE }}>✦ Quick add</span>
        </button>
      </div>
      <div className={`text-[10px] ${theme.textMuted} text-center -mt-1`}>
        Search = structured (kcal/macros from DB). Quick add = free-form, estimate from text, meal templates.
      </div>

      {/* Meals list */}
      {meals.length === 0 ? (
        log.kcalEaten > 0 ? (
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-5 text-center`}>
            <div className="mb-2 flex justify-center"><BrandIcon name="lightbulb" size={28} color={ORANGE} strokeWidth={1.6} /></div>
            <div className={`text-sm font-semibold ${theme.text}`}>Totals logged, no item breakdown</div>
            <div className={`text-xs ${theme.textMuted} mt-2 leading-snug max-w-xs mx-auto`}>
              The day's calories were logged from a quick estimate or older entry. Tap "Add food" to log specific items going forward.
            </div>
          </div>
        ) : (
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-8 text-center`}>
            <div className="mb-2 flex justify-center"><BrandIcon name="food" size={28} color={ORANGE} strokeWidth={1.6} /></div>
            <div className={`text-sm font-semibold ${theme.text}`}>Nothing logged yet</div>
            <div className={`text-xs ${theme.textMuted} mt-1`}>Tap "Add food" to search or scan a barcode.</div>
          </div>
        )
      ) : (
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
          <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-3`}>Today's Meals</div>
          <div className="space-y-3">
            {Object.entries(byMeal).map(([mealName, items]) => {
              const totalKcal = items.reduce((s, m) => s + m.kcal, 0);
              return (
                <div key={mealName}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`text-xs font-bold ${theme.text}`}>{mealName}</span>
                    <span className={`text-[10px] font-semibold ${theme.textMuted}`}>{totalKcal} kcal</span>
                  </div>
                  <div className="space-y-1.5">
                    {items.map((m) => {
                      // Handle both shapes: Food tab (food/brand/grams/protein/carbs/fat)
                      // and FoodLogger free-form (just name/kcal/p/f/c).
                      const isStructured = m.food != null;
                      const label = isStructured ? m.food : (m.name || "Meal");
                      const protein = m.protein != null ? m.protein : (m.p || 0);
                      const carbs = m.carbs != null ? m.carbs : (m.c || 0);
                      const fat = m.fat != null ? m.fat : (m.f || 0);
                      return (
                        <div key={m.idx} className={`${theme.surface} rounded-lg p-2.5 flex items-center gap-2`}>
                          <div className="flex-1 min-w-0">
                            <div className={`text-xs font-semibold ${theme.text} truncate`}>{label}</div>
                            <div className={`text-[10px] ${theme.textMuted}`}>
                              {isStructured ? `${m.grams}g${m.brand ? ` · ${m.brand}` : ""} · ${m.kcal} kcal` : `Free-form · ${m.kcal} kcal`}
                            </div>
                            <div className={`text-[9px] ${theme.textMuted} mt-0.5`}>
                              P {protein}g · C {carbs}g · F {fat}g
                            </div>
                          </div>
                          <button onClick={() => onRemoveMeal(m.idx)} className="w-7 h-7 rounded-lg flex items-center justify-center text-base" style={{ color: A_RED }}>
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function FoodMacroBar({ label, value, target, color, unit }) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-0.5">
        <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color }}>{label}</span>
        <span className="text-[10px] font-bold" style={{ color }}>{Math.round(value)}{unit}</span>
      </div>
      <div className="h-1.5 bg-slate-700/30 rounded-full overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <div className="text-[9px] mt-0.5 opacity-60">/ {target}{unit}</div>
    </div>
  );
}

// ── Search view ──
function FoodSearchView({ searchMode, setSearchMode, searchQuery, setSearchQuery, barcodeInput, setBarcodeInput, searchResults, searching, searchError, onSearch, recentFoods, savedFoods, onPick, theme }) {
  return (
    <>
      {/* Mode toggle */}
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-3`}>
        <div className="grid grid-cols-2 gap-1.5 mb-3">
          <button onClick={() => setSearchMode("text")} className="h-10 rounded-lg font-semibold text-xs"
            style={{ backgroundColor: searchMode === "text" ? NAVY : "", color: searchMode === "text" ? "white" : "" }}>
            <div className={searchMode === "text" ? "flex items-center justify-center gap-1" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center gap-1 rounded-lg`}>
              Text search
            </div>
          </button>
          <button onClick={() => setSearchMode("barcode")} className="h-10 rounded-lg font-semibold text-xs"
            style={{ backgroundColor: searchMode === "barcode" ? NAVY : "", color: searchMode === "barcode" ? "white" : "" }}>
            <div className={searchMode === "barcode" ? "flex items-center justify-center gap-1" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center gap-1 rounded-lg`}>
              📷 Barcode
            </div>
          </button>
        </div>

        {searchMode === "text" ? (
          <>
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && onSearch()}
              placeholder="e.g. greek yoghurt, chicken breast..."
              className={`w-full h-12 px-4 text-base border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg`} />
            <button onClick={onSearch} disabled={searching || searchQuery.length < 2}
              className="w-full mt-2 h-11 text-white rounded-lg font-semibold text-sm disabled:opacity-40"
              style={{ backgroundColor: ORANGE }}>
              {searching ? "Searching..." : "Search Open Food Facts"}
            </button>
          </>
        ) : (
          <>
            <input type="tel" inputMode="numeric" value={barcodeInput} onChange={e => setBarcodeInput(e.target.value.replace(/\D/g, ""))}
              onKeyDown={e => e.key === "Enter" && onSearch()}
              placeholder="Enter barcode digits..."
              className={`w-full h-14 px-4 text-2xl font-mono border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg text-center tracking-wider`} />
            <p className={`text-[10px] ${theme.textMuted} mt-1.5 text-center italic`}>
              Type the digits below the barcode (8-13 digits). Camera scanning isn't yet supported in this build.
            </p>
            <button onClick={onSearch} disabled={searching || barcodeInput.length < 8}
              className="w-full mt-2 h-11 text-white rounded-lg font-semibold text-sm disabled:opacity-40"
              style={{ backgroundColor: ORANGE }}>
              {searching ? "Looking up..." : "Look up barcode"}
            </button>
          </>
        )}

        {searchError && (
          <div className="mt-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs" style={{ color: theme.text === "text-slate-100" ? "#fbbf24" : "#a16207" }}>
            {searchError}
          </div>
        )}
      </div>

      {/* Search results */}
      {searchResults.length > 0 && (
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-3`}>
          <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-2 px-1`}>
            {searchResults.length} {searchResults.length === 1 ? "match" : "matches"}
          </div>
          <div className="space-y-1.5">
            {searchResults.map(food => <FoodResultRow key={food.id} food={food} onPick={() => onPick(food)} theme={theme} />)}
          </div>
        </div>
      )}

      {/* Recent foods (when no search active) */}
      {searchResults.length === 0 && recentFoods.length > 0 && (
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-3`}>
          <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-2 px-1`}>Recently used</div>
          <div className="space-y-1.5">
            {recentFoods.slice(0, 8).map(food => <FoodResultRow key={food.id} food={food} onPick={() => onPick(food)} theme={theme} />)}
          </div>
        </div>
      )}
    </>
  );
}

function FoodResultRow({ food, onPick, theme }) {
  return (
    <button onClick={onPick} className={`w-full ${theme.surface} rounded-lg p-2.5 flex items-center gap-3 text-left active:opacity-70`}>
      {food.image ? (
        <img src={food.image} alt="" className="w-11 h-11 rounded object-cover flex-shrink-0 bg-slate-700" />
      ) : (
        <div className="w-11 h-11 rounded flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${ORANGE}20` }}><BrandIcon name="food" size={20} color={ORANGE} /></div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <div className={`text-xs font-bold ${theme.text} truncate`}>{food.name}</div>
          {food.source === "builtin" && (
            <span className="text-[8px] font-bold px-1 py-0.5 rounded flex-shrink-0" style={{ backgroundColor: `${A_GREEN}33`, color: A_GREEN }}>VERIFIED</span>
          )}
        </div>
        {food.brand && <div className={`text-[10px] ${theme.textMuted} truncate`}>{food.brand}</div>}
        <div className={`text-[10px] ${theme.textMuted} mt-0.5`}>
          <span className="font-semibold">{food.per100g.kcal}</span> kcal / 100g · P {food.per100g.protein} · C {food.per100g.carbs} · F {food.per100g.fat}
        </div>
      </div>
      <span className={`text-base ${theme.textMuted}`}>›</span>
    </button>
  );
}

// ── Saved view ──
function FoodSavedView({ savedFoods, onPick, onUnsave, theme }) {
  if (savedFoods.length === 0) {
    return (
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-8 text-center`}>
        <div className="mb-2 flex justify-center"><BrandIcon name="star" size={28} color={ORANGE} strokeWidth={1.6} /></div>
        <div className={`text-sm font-semibold ${theme.text}`}>No saved foods yet</div>
        <div className={`text-xs ${theme.textMuted} mt-1`}>When you find a food you eat often, tap the star to save it for one-tap re-logging.</div>
      </div>
    );
  }
  return (
    <div className={`${theme.card} rounded-2xl border ${theme.border} p-3`}>
      <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-2 px-1`}>{savedFoods.length} saved</div>
      <div className="space-y-1.5">
        {savedFoods.map(food => (
          <div key={food.id} className="flex items-center gap-1.5">
            <div className="flex-1">
              <FoodResultRow food={food} onPick={() => onPick(food)} theme={theme} />
            </div>
            <button onClick={() => onUnsave(food)} className={`${theme.surface} ${theme.surfaceText} w-11 h-11 rounded-lg flex items-center justify-center text-lg`}><BrandIcon name="star" size={16} color={ORANGE} strokeWidth={2} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── History view ──
function FoodHistoryView({ logs, targets, theme }) {
  const dates = Object.keys(logs).filter(d => logs[d].food && logs[d].kcalEaten).sort().reverse();
  const last30 = dates.slice(0, 30);

  if (last30.length === 0) {
    return (
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-8 text-center`}>
        <div className="mb-2 flex justify-center"><BrandIcon name="up" size={28} color={ORANGE} strokeWidth={1.6} /></div>
        <div className={`text-sm font-semibold ${theme.text}`}>No history yet</div>
      </div>
    );
  }

  // Weekly avg (last 7) vs prior 7
  const last7 = dates.slice(0, 7).map(d => logs[d]);
  const prior7 = dates.slice(7, 14).map(d => logs[d]);
  const avg = (arr, key) => arr.length > 0 ? Math.round(arr.reduce((s, l) => s + (l[key] || 0), 0) / arr.length) : 0;
  const last7Avg = avg(last7, "kcalEaten");
  const prior7Avg = avg(prior7, "kcalEaten");
  const delta = prior7Avg > 0 ? ((last7Avg - prior7Avg) / prior7Avg) * 100 : 0;

  return (
    <>
      {/* Weekly comparison */}
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
        <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-2`}>Weekly Average</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className={`text-2xl font-bold ${theme.text}`}>{last7Avg.toLocaleString()}</div>
            <div className={`text-[10px] ${theme.textMuted}`}>kcal · last 7 days</div>
          </div>
          <div>
            <div className={`text-2xl font-bold ${theme.textMuted}`}>{prior7Avg.toLocaleString()}</div>
            <div className={`text-[10px] ${theme.textMuted}`}>kcal · prior 7 days</div>
          </div>
        </div>
        {prior7Avg > 0 && (
          <div className="text-[11px] mt-2" style={{ color: Math.abs(delta) < 5 ? A_BLUE : delta > 0 ? ORANGE : A_GREEN }}>
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}% vs prior week
          </div>
        )}
      </div>

      {/* Day-by-day list */}
      <div className={`${theme.card} rounded-2xl border ${theme.border} p-3`}>
        <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-2 px-1`}>Last {last30.length} days</div>
               <div className="space-y-1">
          {last30.map(d => {
            const log = logs[d] || {};
            const target = targets.calTarget;
            const overUnder = (log.kcalEaten || 0) - target;
            const within = Math.abs(overUnder) < 200;
            return (
              <div key={d} className={`flex items-center gap-3 py-2 px-2 border-b ${theme.border} last:border-0`}>
                <div className="w-12 flex-shrink-0">
                  <div className={`text-[10px] font-semibold ${theme.textMuted}`}>{new Date(d).toLocaleDateString("en-GB", { weekday: "short" })}</div>
                  <div className={`text-[10px] ${theme.textMuted}`}>{new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-xs font-bold ${theme.text}`}>{Math.round(log.kcalEaten).toLocaleString()} kcal</div>
                  <div className={`text-[10px] ${theme.textMuted}`}>P {Math.round(log.proteinEaten || 0)}g · C {Math.round(log.carbsEaten || 0)}g · F {Math.round(log.fatEaten || 0)}g</div>
                </div>
                <div className="text-[10px] font-bold flex-shrink-0" style={{ color: within ? A_GREEN : overUnder > 0 ? A_RED : ORANGE }}>
                  {overUnder >= 0 ? "+" : ""}{overUnder}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ── Add food modal ──
function FoodAddModal({ food, isSaved, onAdd, onSave, onClose, theme }) {
  const [grams, setGrams] = useState(food.perServing?.servingSize ? parseInt(food.perServing.servingSize) || 100 : 100);
  const [mealType, setMealType] = useState("Snack");
  const factor = grams / 100;
  const computed = {
    kcal: Math.round(food.per100g.kcal * factor),
    protein: +(food.per100g.protein * factor).toFixed(1),
    carbs: +(food.per100g.carbs * factor).toFixed(1),
    fat: +(food.per100g.fat * factor).toFixed(1),
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div className={`${theme.card} w-full max-w-md rounded-t-2xl sm:rounded-2xl max-h-[90vh] overflow-y-auto`} style={{ WebkitOverflowScrolling: "touch" }}>
        <div className={`sticky top-0 ${theme.card} border-b ${theme.border} px-4 py-3 flex items-center justify-between`}>
          <button onClick={onClose} className={`${theme.surface} ${theme.surfaceText} w-9 h-9 rounded-full flex items-center justify-center text-lg`}>×</button>
          <button onClick={() => onSave(food)} className={`${theme.surface} ${theme.surfaceText} px-3 h-9 rounded-full flex items-center justify-center text-base`}>
            {isSaved ? "★" : "☆"}
          </button>
        </div>

        <div className="p-4">
          <div className="flex items-start gap-3 mb-4">
            {food.image ? (
              <img src={food.image} alt="" className="w-16 h-16 rounded-lg object-cover flex-shrink-0 bg-slate-700" />
            ) : (
              <div className="w-16 h-16 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${ORANGE}20` }}><BrandIcon name="food" size={28} color={ORANGE} /></div>
            )}
            <div className="flex-1 min-w-0">
              <h3 className={`text-base font-bold ${theme.text}`}>{food.name}</h3>
              {food.brand && <p className={`text-xs ${theme.textMuted}`}>{food.brand}</p>}
              {food.quantity && <p className={`text-[10px] ${theme.textMuted} mt-0.5`}>Pack: {food.quantity}</p>}
              {food.barcode && <p className={`text-[9px] ${theme.textMuted} font-mono mt-0.5`}>{food.barcode}</p>}
            </div>
          </div>

          {/* Per-100g reference */}
          <div className={`${theme.surface} rounded-lg p-3 mb-4`}>
            <div className={`text-[9px] font-bold uppercase tracking-wide ${theme.textMuted} mb-1`}>
              Per 100g · source: {food.source === "builtin" ? "verified database" : "Open Food Facts"}
            </div>
            <div className="grid grid-cols-4 gap-1 text-center">
              <div><div className={`text-sm font-bold ${theme.text}`}>{food.per100g.kcal}</div><div className={`text-[9px] ${theme.textMuted}`}>kcal</div></div>
              <div><div className="text-sm font-bold" style={{ color: A_GREEN }}>{food.per100g.protein}</div><div className={`text-[9px] ${theme.textMuted}`}>protein</div></div>
              <div><div className="text-sm font-bold" style={{ color: A_BLUE }}>{food.per100g.carbs}</div><div className={`text-[9px] ${theme.textMuted}`}>carbs</div></div>
              <div><div className="text-sm font-bold" style={{ color: A_PURPLE }}>{food.per100g.fat}</div><div className={`text-[9px] ${theme.textMuted}`}>fat</div></div>
            </div>
          </div>

          {/* Quick portion buttons */}
          <label className={`block text-xs font-medium ${theme.textSubtle} mb-1.5`}>Portion (g)</label>
          <div className="grid grid-cols-5 gap-1.5 mb-2">
            {[50, 100, 150, 200, 250].map(g => (
              <button key={g} onClick={() => setGrams(g)} className="h-10 rounded-lg font-semibold text-xs"
                style={{ backgroundColor: grams === g ? NAVY : "", color: grams === g ? "white" : "" }}>
                <div className={grams === g ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{g}g</div>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 mb-4">
            <button onClick={() => setGrams(Math.max(1, grams - 10))} className={`${theme.surface} ${theme.surfaceText} w-12 h-12 rounded-lg font-bold text-lg`}>−</button>
            <input type="tel" inputMode="numeric" value={grams} onChange={e => setGrams(Math.max(0, parseInt(e.target.value) || 0))}
              className={`flex-1 h-12 px-4 text-2xl font-bold text-center border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg`} />
            <button onClick={() => setGrams(grams + 10)} className={`${theme.surface} ${theme.surfaceText} w-12 h-12 rounded-lg font-bold text-lg`}>+</button>
          </div>
          {food.perServing && (
            <button onClick={() => setGrams(parseInt(food.perServing.servingSize) || 100)} className={`text-[10px] ${theme.textMuted} underline mb-3`}>
              Use suggested serving ({food.perServing.servingSize})
            </button>
          )}

          {/* Meal selector */}
          <label className={`block text-xs font-medium ${theme.textSubtle} mb-1.5`}>Add to</label>
          <div className="grid grid-cols-4 gap-1.5 mb-4">
            {["Breakfast", "Lunch", "Dinner", "Snack"].map(m => (
              <button key={m} onClick={() => setMealType(m)} className="h-10 rounded-lg font-semibold text-xs"
                style={{ backgroundColor: mealType === m ? ORANGE : "", color: mealType === m ? "white" : "" }}>
                <div className={mealType === m ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{m}</div>
              </button>
            ))}
          </div>

          {/* Computed totals */}
          <div className="rounded-lg p-3 mb-4" style={{ backgroundColor: `${ORANGE}15`, border: `1px solid ${ORANGE}55` }}>
            <div className={`text-[9px] font-bold uppercase tracking-wide mb-1`} style={{ color: ORANGE }}>You'll log</div>
            <div className="grid grid-cols-4 gap-1 text-center">
              <div><div className={`text-base font-bold ${theme.text}`}>{computed.kcal}</div><div className={`text-[9px] ${theme.textMuted}`}>kcal</div></div>
              <div><div className="text-base font-bold" style={{ color: A_GREEN }}>{computed.protein}g</div><div className={`text-[9px] ${theme.textMuted}`}>protein</div></div>
              <div><div className="text-base font-bold" style={{ color: A_BLUE }}>{computed.carbs}g</div><div className={`text-[9px] ${theme.textMuted}`}>carbs</div></div>
              <div><div className="text-base font-bold" style={{ color: A_PURPLE }}>{computed.fat}g</div><div className={`text-[9px] ${theme.textMuted}`}>fat</div></div>
            </div>
          </div>

          <button onClick={() => onAdd(food, grams, mealType)} disabled={grams <= 0}
            className="w-full h-12 text-white rounded-xl font-bold disabled:opacity-40"
            style={{ backgroundColor: ORANGE }}>
            Add {computed.kcal} kcal to {mealType}
          </button>
        </div>
      </div>
    </div>
  );
}

function Settings({ session, profile, setProfile, themeCtx, onLogout }) {
  const { theme, dark, toggle } = themeCtx;
  const targets = useMemo(() => calculateTargets(profile), [profile]);
  const [linkedPT, setLinkedPT] = useState(null);
  const [showPTModal, setShowPTModal] = useState(false);
  const [ptUsername, setPtUsername] = useState("");
  const [ptError, setPtError] = useState("");
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [showSecondaryTreat, setShowSecondaryTreat] = useState(false);
  const [secondaryTreatDraft, setSecondaryTreatDraft] = useState(null);
  // Local draft for target overrides editor (kept separate so user can edit before saving)
  const [overrideDraft, setOverrideDraft] = useState(profile.targetOverrides || {});
  const [overrideEditing, setOverrideEditing] = useState(false);

  // Custom tasks management
  const [customTasks, setCustomTasks] = useState([]);
  const [editingTask, setEditingTask] = useState(null); // null | {task object being built or edited}
  useEffect(() => {
    storage.get(userKey(session.id, "custom-tasks")).then(v => setCustomTasks(v?.tasks || []));
  }, [session.id]);
  const saveTasks = async (tasks) => {
    await storage.set(userKey(session.id, "custom-tasks"), { tasks });
    setCustomTasks(tasks);
  };

  // Training intensification (engine-suggested supersets & dropsets)
  const [exercisePrefs, setExercisePrefs] = useState(null);
  useEffect(() => {
    storage.get(userKey(session.id, "exercise-prefs")).then(v => setExercisePrefs(v || {}));
  }, [session.id]);
  const intensificationEnabled = exercisePrefs?.intensificationEnabled || { supersets: true, dropsets: true };
  const setIntensification = async (key, value) => {
    const next = {
      ...(exercisePrefs || {}),
      intensificationEnabled: { ...intensificationEnabled, [key]: value },
    };
    await storage.set(userKey(session.id, "exercise-prefs"), next);
    setExercisePrefs(next);
  };

      

  const openEdit = () => {
    setEditForm({ ...profile });
    setShowEditProfile(true);
  };

  const saveEdit = async () => {
    await storage.set(userKey(session.id, "profile"), editForm);
    setProfile(editForm);
    setShowEditProfile(false);
  };

      const linkPT = async () => {
    setPtError("");
    const uname = ptUsername.trim();
    if (uname.length < 3) { setPtError("Enter a username (3+ characters)"); return; }
    try {
      const sbKey = Object.keys(localStorage).find(k => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const token = sbKey ? JSON.parse(localStorage.getItem(sbKey))?.access_token : null;
      const headers = { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY };
      if (token) headers["Authorization"] = "Bearer " + token;
      // Step 1: look up PT by username via RPC function
      const lookup = await fetch(`${SUPABASE_URL}/rest/v1/rpc/find_user_by_username`, {
        method: "POST",
        headers,
        body: JSON.stringify({ p_username: uname }),
      });
      if (!lookup.ok) {
        const txt = await lookup.text();
        console.error("username lookup failed", txt);
        setPtError("Lookup failed — try again"); return;
      }
      const found = await lookup.json();
      if (!found[0]) { setPtError("No user with that username"); return; }
      const ptId = found[0].user_id;
      const ptRole = found[0].role;
      if (ptId === session.id) { setPtError("That's you — can't link to yourself"); return; }
      if (ptRole !== "PT") { setPtError("That account isn't a trainer"); return; }
      // Step 2: create the link
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/pt_links`, {
        method: "POST",
        headers: { ...headers, "Prefer": "return=representation" },
        body: JSON.stringify({ pt_user_id: ptId, client_user_id: session.id, status: "active" }),
      });
      if (!ins.ok) {
        const txt = await ins.text();
        console.error("link insert failed", txt);
        setPtError("Failed to link — try again"); return;
      }
      setLinkedPT({ id: ptId, username: uname });
      setShowPTModal(false);
      setPtUsername("");
    } catch (e) {
      console.error("linkPT threw", e);
      setPtError(e.message || String(e));
    }
  };


    const unlinkPT = async () => {
    if (!confirm("Remove your PT?")) return;
    try {
      const sbKey = Object.keys(localStorage).find(k => k.startsWith("sb-") && k.endsWith("-auth-token"));
      const token = sbKey ? JSON.parse(localStorage.getItem(sbKey))?.access_token : null;
      const headers = { "apikey": SUPABASE_ANON_KEY };
      if (token) headers["Authorization"] = "Bearer " + token;
      await fetch(`${SUPABASE_URL}/rest/v1/pt_links?client_user_id=eq.${session.id}`, {
        method: "DELETE",
        headers,
      });
    } catch (e) { console.warn("unlinkPT failed", e); }
    setLinkedPT(null);
  };


  return (
    <div className="pb-4">
      <div className="px-5 pt-10 pb-6 text-white relative overflow-hidden" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
        <img src={HERO_SPRINT_W_B64} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ opacity: 0.30, mixBlendMode: "luminosity" }} />
        <div className="relative">
          <Wordmark />
          <h1 className="text-2xl font-bold mt-3">More</h1>
          <p className="text-blue-100 text-sm mt-1">@{session.username}</p>
        </div>
      </div>
      <div className="px-4 pt-3 space-y-3">
        {/* PT linking */}
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
          <h3 className={`font-semibold mb-2 ${theme.text}`}>Personal Trainer</h3>
          {linkedPT ? (
            <div>
              <div className="rounded-lg p-3 mb-3" style={{ backgroundColor: `${ORANGE}15`, border: `1px solid ${ORANGE}55` }}>
                <div className={`text-sm font-semibold ${theme.text}`}>👤 {linkedPT.username}</div>
                <div className={`text-xs ${theme.textMuted} mt-1`}>Sees your progress and can adjust your training plan.</div>
              </div>
              <button onClick={unlinkPT} className="w-full h-10 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm font-semibold">Remove PT</button>
            </div>
          ) : (
            <div>
              <p className={`text-xs ${theme.textMuted} mb-3`}>Link a PT to get tailored plans and progress oversight.</p>
              <button onClick={() => setShowPTModal(true)} className="w-full h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>+ Link a PT</button>
            </div>
          )}
        </div>

        <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
          <div className="flex justify-between items-center mb-3">
            <h3 className={`font-semibold ${theme.text}`}>Your plan</h3>
            <button onClick={openEdit} className="text-xs font-bold px-3 py-1.5 rounded-lg" style={{ backgroundColor: `${ORANGE}15`, color: ORANGE }}>Edit</button>
          </div>
          <div className="space-y-2 text-sm">
            <Row theme={theme} l="Current weight" v={`${profile.weight} kg`} />
            <Row theme={theme} l="Goal" v={profile.targetWeight ? `${profile.goal} → ${profile.targetWeight} kg` : profile.goal} />
            {profile.targetDate && <Row theme={theme} l="Target date" v={new Date(profile.targetDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} />}
            <Row theme={theme} l="Pace" v={targets.intensityLabel} />
            <Row theme={theme} l="Calories" v={`${targets.calTarget.toLocaleString()} kcal`} />
            <Row theme={theme} l="Macros" v={`P${targets.protein} F${targets.fat} C${targets.carbs}`} />
            <Row theme={theme} l="Training" v={`${profile.split}, ${profile.daysPerWeek}d/wk`} />
          </div>
        </div>
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
          <h3 className={`font-semibold mb-2 ${theme.text}`}>Calorie banking window</h3>
          <p className={`text-xs ${theme.textMuted} mb-3`}>How many days of surplus/deficit roll into your daily bank. Shorter = more responsive day-to-day, longer = smoother averaging.</p>
          <div className="grid grid-cols-7 gap-1.5">
            {[1, 2, 3, 4, 5, 6, 7].map(n => (
              <button key={n}
                onClick={async () => {
                  const next = { ...profile, rollingWindow: n };
                  await storage.set(userKey(session.id, "profile"), next);
                  setProfile(next);
                }}
                className="h-11 rounded-lg font-bold text-sm"
                style={{ backgroundColor: (profile.rollingWindow || 7) === n ? ORANGE : "", color: (profile.rollingWindow || 7) === n ? "white" : "" }}>
                <div className={(profile.rollingWindow || 7) === n ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{n}d</div>
              </button>
            ))}
          </div>
          <p className={`text-[10px] ${theme.textMuted} mt-2 leading-snug italic`}>
            Example: at 4 days, eating −100 kcal/day for 4 days banks 400 kcal — distributed as +100/day going forward on a rolling basis.
          </p>
        </div>

        {/* Daily target overrides — manual control over calories & macros */}
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
          <div className="flex items-center justify-between mb-2">
            <h3 className={`text-sm font-bold ${theme.text}`}>Daily targets</h3>
            {targets.overridden && (
              <span className="text-[9px] font-bold tracking-wider px-2 py-0.5 rounded" style={{ color: ORANGE, backgroundColor: `${ORANGE}20` }}>OVERRIDDEN</span>
            )}
          </div>
          <p className={`text-[11px] ${theme.textMuted} mb-3 leading-snug`}>
            Targets are calculated from your stats, goal, and timeline. Override individual values if you want different numbers — leave blank to use the calculated value. Setting a custom calorie target won't auto-adjust macros (and vice versa).
          </p>

          {/* Show current effective targets at the top */}
          <div className={`grid grid-cols-4 gap-1.5 mb-3 ${theme.surface} rounded-lg p-2`}>
            <TargetCell label="kcal" value={targets.calTarget} base={targets.baseline.calTarget} theme={theme} />
            <TargetCell label="P (g)" value={targets.protein} base={targets.baseline.protein} theme={theme} />
            <TargetCell label="F (g)" value={targets.fat} base={targets.baseline.fat} theme={theme} />
            <TargetCell label="C (g)" value={targets.carbs} base={targets.baseline.carbs} theme={theme} />
          </div>

          {!overrideEditing ? (
            <button onClick={() => { setOverrideDraft(profile.targetOverrides || {}); setOverrideEditing(true); }}
              className={`w-full h-10 rounded-lg border-2 text-xs font-semibold flex items-center justify-center`}
              style={{ color: ORANGE, borderColor: ORANGE }}>
              {targets.overridden ? "Edit overrides" : "Set custom targets"}
            </button>
          ) : (
            <div className="space-y-2">
              <OverrideInput label="Calories" base={targets.baseline.calTarget} unit="kcal"
                value={overrideDraft.calTarget} theme={theme}
                onChange={v => setOverrideDraft({ ...overrideDraft, calTarget: v })} />
              <OverrideInput label="Protein" base={targets.baseline.protein} unit="g"
                value={overrideDraft.protein} theme={theme}
                onChange={v => setOverrideDraft({ ...overrideDraft, protein: v })} />
              <OverrideInput label="Fat" base={targets.baseline.fat} unit="g"
                value={overrideDraft.fat} theme={theme}
                onChange={v => setOverrideDraft({ ...overrideDraft, fat: v })} />
              <OverrideInput label="Carbs" base={targets.baseline.carbs} unit="g"
                value={overrideDraft.carbs} theme={theme}
                onChange={v => setOverrideDraft({ ...overrideDraft, carbs: v })} />

              {/* Macro-calorie consistency hint */}
              {(() => {
                const c = overrideDraft.calTarget || targets.baseline.calTarget;
                const p = overrideDraft.protein || targets.baseline.protein;
                const f = overrideDraft.fat || targets.baseline.fat;
                const cb = overrideDraft.carbs || targets.baseline.carbs;
                const macroKcal = p * 4 + f * 9 + cb * 4;
                const delta = macroKcal - c;
                if (Math.abs(delta) < 80) return null;
                return (
                  <div className="rounded-lg p-2 text-[10px] leading-snug" style={{ backgroundColor: `${STATUS_STATIC}15`, color: STATUS_STATIC }}>
                    Heads up: your macros add up to <strong>{macroKcal}</strong> kcal but your calorie target is <strong>{c}</strong> ({delta > 0 ? "+" : ""}{delta} kcal mismatch). They don't need to match exactly, but a big gap may confuse the daily progress UI.
                  </div>
                );
              })()}

              <div className="flex gap-2 pt-1">
                <button onClick={() => { setOverrideEditing(false); setOverrideDraft(profile.targetOverrides || {}); }}
                  className={`flex-1 h-10 ${theme.surface} ${theme.surfaceText} rounded-lg font-semibold text-xs`}>Cancel</button>
                {targets.overridden && (
                                    <button onClick={async () => {
                    const next = { ...profile };
                    delete next.targetOverrides;
                    await storage.set(userKey(session.id, "profile"), next);
                    setProfile(next);
                    // Restore active block to calculated targets (without overrides)
                    const newTargets = calculateTargets(next);
                    const currentBlocks = (await storage.get(userKey(session.id, "blocks"))) || [];
                    const updatedBlocks = currentBlocks.map(b => !b.endDate ? {
                      ...b,
                      calTarget: newTargets.calTarget,
                      protein: newTargets.protein,
                      fat: newTargets.fat,
                      carbs: newTargets.carbs,
                    } : b);
                    await storage.set(userKey(session.id, "blocks"), updatedBlocks);
                    setBlocks(updatedBlocks);
                    setOverrideDraft({});
                    setOverrideEditing(false);
                  }} className="flex-1 h-10 rounded-lg font-semibold text-xs"
                    style={{ backgroundColor: `${A_RED}15`, color: A_RED, border: `1px solid ${A_RED}55` }}>
                    Reset all
                  </button>
                )}
                                <button onClick={async () => {
                  // Strip empty values so we don't store {calTarget: null} junk
                  const clean = {};
                  if (overrideDraft.calTarget > 0) clean.calTarget = Number(overrideDraft.calTarget);
                  if (overrideDraft.protein > 0) clean.protein = Number(overrideDraft.protein);
                  if (overrideDraft.fat > 0) clean.fat = Number(overrideDraft.fat);
                  if (overrideDraft.carbs > 0) clean.carbs = Number(overrideDraft.carbs);
                  const next = { ...profile, targetOverrides: Object.keys(clean).length > 0 ? clean : undefined };
                  if (Object.keys(clean).length === 0) delete next.targetOverrides;
                  await storage.set(userKey(session.id, "profile"), next);
                  setProfile(next);
                  // Propagate the new targets to the active block so all read sites pick them up
                  const newTargets = calculateTargets(next);
                  const currentBlocks = (await storage.get(userKey(session.id, "blocks"))) || [];
                  const updatedBlocks = currentBlocks.map(b => !b.endDate ? {
                    ...b,
                    calTarget: newTargets.calTarget,
                    protein: newTargets.protein,
                    fat: newTargets.fat,
                    carbs: newTargets.carbs,
                  } : b);
                  await storage.set(userKey(session.id, "blocks"), updatedBlocks);
                  setBlocks(updatedBlocks);
                  setOverrideEditing(false);
                }} className="flex-1 h-10 text-white rounded-lg font-semibold text-xs" style={{ backgroundColor: ORANGE }}>Save</button>
              </div>
            </div>
          )}
        </div>

        {/* Custom tasks — user-defined daily/weekly items */}
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
          <div className="flex items-center justify-between mb-2">
            <h3 className={`text-sm font-bold ${theme.text}`}>Custom tasks</h3>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ backgroundColor: `${ORANGE}1a`, color: ORANGE }}>
              {customTasks.filter(t => !t.archived).length} active
            </span>
          </div>
          <p className={`text-[11px] ${theme.textMuted} mb-3 leading-snug`}>
            Add your own tasks alongside Food/Weight/Steps/Workout. Pick the type (tick / number / note), the days it appears on, and how long it runs for.
          </p>

          {customTasks.filter(t => !t.archived).length > 0 && (
            <div className="space-y-1.5 mb-3">
              {customTasks.filter(t => !t.archived).map(t => (
                <div key={t.id} className={`${theme.surface} rounded-lg p-2.5 flex items-center gap-2`}>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-semibold ${theme.text} truncate`}>{t.name}</div>
                    <div className={`text-[10px] ${theme.textMuted}`}>
                      {t.type === "tick" ? "Tick" : t.type === "number" ? `Number${t.target ? ` · target ${t.target}${t.unit ? " " + t.unit : ""}` : ""}` : "Note"}
                      {" · "}
                      {t.schedule?.kind === "daily" ? "Every day" : t.schedule?.kind === "weekly" ? "Weekly" : `${(t.schedule?.days || []).map(d => DOW_LABELS[d - 1]).join(" ")}`}
                      {t.schedule?.endKind === "block" && " · this block"}
                      {t.schedule?.endKind === "date" && t.schedule?.endDate && ` · until ${new Date(t.schedule.endDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`}
                    </div>
                  </div>
                  <button onClick={() => setEditingTask({ ...t })} className="text-[10px] underline" style={{ color: ORANGE }}>Edit</button>
                  <button onClick={async () => {
                    const next = customTasks.map(x => x.id === t.id ? { ...x, archived: true } : x);
                    await saveTasks(next);
                  }} className="text-[10px] underline text-red-500">Remove</button>
                </div>
              ))}
            </div>
          )}

          <button onClick={() => setEditingTask({
            id: genTaskId(),
            name: "",
            type: "tick",
            target: 0,
            unit: "",
            schedule: { kind: "daily", days: [1,2,3,4,5,6,7], endKind: "forever", endDate: "" },
            countsTowardStreak: true,
            createdAt: new Date().toISOString().split("T")[0],
            _isNew: true,
          })} className={`w-full h-10 rounded-lg border-2 text-xs font-semibold flex items-center justify-center`}
            style={{ color: ORANGE, borderColor: ORANGE }}>
            + Create new task
          </button>
        </div>

        {/* Training intensification — engine-suggested supersets & dropsets */}
        <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
          <h3 className={`text-sm font-bold ${theme.text} mb-2`}>Training intensification</h3>
          <p className={`text-[11px] ${theme.textMuted} mb-3 leading-snug`}>
            When you're past the beginner phase (level 3+), the engine layers supersets and dropsets onto your sessions to mix stimulus and save time. Antagonist pairs only, never on heavy compounds, capped per session so it doesn't compound fatigue. Disable entirely or skip per-session in the Training app.
          </p>

          <div className="space-y-2">
            <button onClick={() => setIntensification("supersets", !intensificationEnabled.supersets)}
              className={`w-full flex items-center justify-between p-3 ${theme.surface} rounded-lg`}>
              <div className="text-left">
                <div className={`text-sm font-semibold ${theme.text}`}>App-suggested supersets</div>
                <div className={`text-[10px] ${theme.textMuted}`}>Antagonist pairs (e.g. chest + back). Up to {(profile.experience || 3) >= 4 ? 2 : 1} pair per session.</div>
              </div>
              <div className="w-10 h-6 rounded-full relative transition-colors"
                style={{ backgroundColor: intensificationEnabled.supersets ? ORANGE : "#94a3b855" }}>
                <div className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
                  style={{ left: intensificationEnabled.supersets ? "calc(100% - 22px)" : "2px" }} />
              </div>
            </button>

            <button onClick={() => setIntensification("dropsets", !intensificationEnabled.dropsets)}
              className={`w-full flex items-center justify-between p-3 ${theme.surface} rounded-lg`}>
              <div className="text-left">
                <div className={`text-sm font-semibold ${theme.text}`}>App-suggested dropsets</div>
                <div className={`text-[10px] ${theme.textMuted}`}>On isolation lifts late in the session, last set only. Up to {(profile.experience || 3) >= 4 ? 2 : 1} per session.</div>
              </div>
              <div className="w-10 h-6 rounded-full relative transition-colors"
                style={{ backgroundColor: intensificationEnabled.dropsets ? ORANGE : "#94a3b855" }}>
                <div className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
                  style={{ left: intensificationEnabled.dropsets ? "calc(100% - 22px)" : "2px" }} />
              </div>
            </button>
          </div>

          {(profile.experience || 3) < 3 && (
            <div className="mt-3 p-2.5 rounded-lg" style={{ backgroundColor: `${STATUS_STATIC}15` }}>
              <p className="text-[10px] leading-snug" style={{ color: STATUS_STATIC }}>
                You're at experience level {profile.experience || 3}. Intensification is paused at level 1-2 regardless of these toggles — straight sets build the form base. Bump experience to 3+ in profile to enable.
              </p>
            </div>
          )}
        </div>

        <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
          <div className="flex items-center justify-between mb-3">
            <h3 className={`text-sm font-bold ${theme.text}`}>Treats</h3>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ backgroundColor: `${ORANGE}1a`, color: ORANGE }}>
              {(profile.treat ? 1 : 0) + (profile.secondaryTreat ? 1 : 0)} / 2
            </span>
          </div>
          <p className={`text-[11px] ${theme.textMuted} mb-3 leading-snug`}>
            Each treat adds a small daily deduction (kcal × ambition ÷ 7) to your target. Hit your weekly target → bank one of each. Two treats means a slightly tighter daily target but flexibility on what you bank.
          </p>
          {profile.treat && (
            <div className={`p-3 rounded-lg ${theme.surface} mb-2 flex items-center gap-3`}>
              <div className="text-2xl">{profile.treat.emoji || "🍫"}</div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-semibold ${theme.text}`}>{profile.treat.name === "Custom" ? (profile.treat.customName || "Custom treat") : profile.treat.name}</div>
                <div className={`text-[10px] ${theme.textMuted}`}>{profile.treat.kcal} kcal · {profile.treat.ambition}× / week · −{Math.round((profile.treat.kcal * profile.treat.ambition)/7)} kcal/day</div>
              </div>
              <span className="text-[9px] px-1.5 py-0.5 rounded font-bold" style={{ backgroundColor: `${ORANGE}30`, color: ORANGE }}>PRIMARY</span>
            </div>
          )}
          {profile.secondaryTreat && (
            <div className={`p-3 rounded-lg ${theme.surface} mb-2 flex items-center gap-3`}>
              <div className="text-2xl">{profile.secondaryTreat.emoji || "🍫"}</div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-semibold ${theme.text}`}>{profile.secondaryTreat.name === "Custom" ? (profile.secondaryTreat.customName || "Custom treat") : profile.secondaryTreat.name}</div>
                <div className={`text-[10px] ${theme.textMuted}`}>{profile.secondaryTreat.kcal} kcal · {profile.secondaryTreat.ambition}× / week · −{Math.round((profile.secondaryTreat.kcal * profile.secondaryTreat.ambition)/7)} kcal/day</div>
              </div>
              <button
                onClick={async () => {
                  if (!confirm("Remove this secondary treat?")) return;
                  const next = { ...profile };
                  delete next.secondaryTreat;
                  await storage.set(userKey(session.id, "profile"), next);
                  setProfile(next);
                }}
                className="text-[10px] text-red-500 underline">Remove</button>
            </div>
          )}
          {!profile.secondaryTreat && profile.treat && (
            <button
              onClick={() => {
                const defaults = profile.treat.name === "Pint of beer"
                  ? { name: "Chocolate bar", kcal: 230, emoji: "🍫", ambition: 1 }
                  : { name: "Pint of beer", kcal: 220, emoji: "🍺", ambition: 1 };
                setSecondaryTreatDraft(defaults);
                setShowSecondaryTreat(true);
              }}
              className={`w-full h-10 rounded-lg border-2 ${theme.border} text-xs font-semibold flex items-center justify-center gap-1`}
              style={{ color: ORANGE, borderColor: ORANGE }}>
              + Add secondary treat
            </button>
          )}
        </div>

        <button onClick={toggle} className={`w-full h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold text-sm`}>
          {dark ? "☀️  Light mode" : "🌙  Dark mode"}
        </button>
        <button onClick={onLogout} className={`w-full h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Log out</button>

      </div>

               {showPTModal && (
        <Modal title="Link a PT" onClose={() => setShowPTModal(false)} theme={theme}>
          <p className={`text-sm ${theme.textMuted} mb-3`}>Enter your PT's username. They'll be able to see your progress and adjust your training.</p>
          <TextInput label="PT username" value={ptUsername} setValue={setPtUsername} theme={theme} placeholder="e.g. coach_dave" />
          {ptError && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-3">{ptError}</div>}
          <button onClick={linkPT} className="w-full h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Link PT</button>
        </Modal>
      )}

      {showEditProfile && editForm && (
        <Modal title="Edit profile" onClose={() => setShowEditProfile(false)} theme={theme}>
          <NumInput label="Current weight" value={editForm.weight} setValue={v => setEditForm({ ...editForm, weight: v })} suffix="kg" step={0.1} theme={theme} />
          <NumInput label="Height" value={editForm.height} setValue={v => setEditForm({ ...editForm, height: v })} suffix="cm" theme={theme} />
          <NumInput label="Daily steps target" value={editForm.steps} setValue={v => setEditForm({ ...editForm, steps: v })} suffix="steps" step={500} theme={theme} />
          <NumInput label="Daily water target" value={editForm.waterTarget || 2.5} setValue={v => setEditForm({ ...editForm, waterTarget: v })} suffix="L" step={0.25} theme={theme} />

          {/* Training experience — drives complexity-aware exercise selection */}
          <div className="mb-3">
            <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Training experience</label>
            <div className="grid grid-cols-5 gap-1.5">
              {[1, 2, 3, 4, 5].map(n => {
                const sel = (editForm.experience || 3) === n;
                return (
                  <button key={n} onClick={() => setEditForm({ ...editForm, experience: n })}
                    className="h-10 rounded-lg font-bold text-sm"
                    style={{ backgroundColor: sel ? ORANGE : "", color: sel ? "white" : "" }}>
                    <div className={sel ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{n}</div>
                  </button>
                );
              })}
            </div>
            <p className={`text-[10px] ${theme.textMuted} mt-1.5 leading-snug italic`}>
              {(editForm.experience || 3) === 1 && "1 — Brand new to lifting. Avoids complex barbell lifts; favours machines and dumbbells."}
              {(editForm.experience || 3) === 2 && "2 — Some experience, still building form on heavy compounds. Avoids advanced lifts."}
              {(editForm.experience || 3) === 3 && "3 — Comfortable with most lifts. Heavy barbell work introduced cautiously."}
              {(editForm.experience || 3) === 4 && "4 — Trained for years. All lifts available; programming variety prioritised."}
              {(editForm.experience || 3) === 5 && "5 — Advanced lifter. Complex movements (barbell squat, OHP, pull-ups) actively recommended."}
            </p>
          </div>

          <div className={`my-3 pt-3 border-t ${theme.border}`}>
            <p className={`text-xs font-bold uppercase tracking-wide ${theme.textMuted} mb-2`}>Goal</p>
          </div>
          <div className="mb-3">
            <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Goal type</label>
            <div className="grid grid-cols-3 gap-2">
              {["Cut", "Recomp", "Maintain"].map(g => (
                <button key={g} onClick={() => setEditForm({ ...editForm, goal: g })} className="h-10 rounded-lg font-medium text-xs"
                  style={{ backgroundColor: editForm.goal === g ? NAVY : "", color: editForm.goal === g ? "white" : "" }}>
                  <div className={editForm.goal === g ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{g}</div>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              {["Lean Bulk", "Bulk"].map(g => (
                <button key={g} onClick={() => setEditForm({ ...editForm, goal: g })} className="h-10 rounded-lg font-medium text-xs"
                  style={{ backgroundColor: editForm.goal === g ? NAVY : "", color: editForm.goal === g ? "white" : "" }}>
                  <div className={editForm.goal === g ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{g}</div>
                </button>
              ))}
            </div>
          </div>

          {editForm.goal !== "Maintain" && (
            <>
              <div className={`text-xs ${theme.textMuted} mb-2 italic`}>Set a target weight, target date, or both. Leave blank if not applicable.</div>
              <NumInput label="Target weight (optional)" value={editForm.targetWeight || 0} setValue={v => setEditForm({ ...editForm, targetWeight: v || null })} suffix="kg" step={0.5} theme={theme} />
              <div className="mb-4">
                <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Target date (optional)</label>
                <div className="flex gap-2">
                  <input type="date" value={editForm.targetDate || ""} onChange={e => setEditForm({ ...editForm, targetDate: e.target.value || null })}
                    className={`flex-1 h-12 px-4 text-base font-medium border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg`} />
                  {editForm.targetDate && (
                    <button onClick={() => setEditForm({ ...editForm, targetDate: null })} className={`h-12 px-3 ${theme.surface} ${theme.surfaceText} rounded-lg text-xs font-semibold`}>Clear</button>
                  )}
                </div>
              </div>
              {!editForm.targetWeight && !editForm.targetDate && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg p-2.5 mb-3">
                  No target set — defaulting to maintenance pace.
                </div>
              )}
            </>
          )}

          <div className={`my-3 pt-3 border-t ${theme.border}`}>
            <p className={`text-xs font-bold uppercase tracking-wide ${theme.textMuted} mb-2`}>Activity</p>
          </div>
          <div className="space-y-2 mb-3">
            {[{ l: "Sedentary", v: 1.25 }, { l: "Light", v: 1.4 }, { l: "Moderate", v: 1.6 }, { l: "Very active", v: 1.8 }].map(o => (
              <button key={o.v} onClick={() => setEditForm({ ...editForm, activity: o.v })} className="w-full p-2.5 rounded-lg border-2 text-left text-sm"
                style={{ borderColor: editForm.activity === o.v ? ORANGE : "", backgroundColor: editForm.activity === o.v ? `${ORANGE}15` : "" }}>
                <span className={`font-medium ${theme.text}`}>{o.l}</span>
              </button>
            ))}
          </div>

          <div className="flex gap-2 mt-2">
            <button onClick={() => setShowEditProfile(false)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
            <button onClick={saveEdit} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
          </div>
        </Modal>
      )}

      {editingTask && (
        <Modal title={editingTask._isNew ? "New task" : "Edit task"} onClose={() => setEditingTask(null)} theme={theme}>
          <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Name</label>
          <input type="text" value={editingTask.name}
            onChange={e => setEditingTask({ ...editingTask, name: e.target.value })}
            placeholder="e.g. Drink 3L water"
            className={`w-full h-12 px-4 text-base border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg mb-3`} />

          <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Type</label>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {[
              { v: "tick", l: "Tick", sub: "Done / not done" },
              { v: "number", l: "Number", sub: "With target" },
              { v: "text", l: "Note", sub: "Free text" },
            ].map(o => (
              <button key={o.v} onClick={() => setEditingTask({ ...editingTask, type: o.v })}
                className="p-2 rounded-lg border-2 text-center"
                style={{ borderColor: editingTask.type === o.v ? ORANGE : "", backgroundColor: editingTask.type === o.v ? `${ORANGE}15` : "" }}>
                <div className={`text-sm font-semibold ${theme.text}`}>{o.l}</div>
                <div className={`text-[9px] ${theme.textMuted}`}>{o.sub}</div>
              </button>
            ))}
          </div>

          {editingTask.type === "number" && (
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className={`block text-[10px] font-medium ${theme.textSubtle} mb-1`}>Target (optional)</label>
                <input type="number" inputMode="decimal" value={editingTask.target || ""}
                  onChange={e => setEditingTask({ ...editingTask, target: Number(e.target.value) || 0 })}
                  placeholder="e.g. 3"
                  className={`w-full h-10 px-3 text-sm border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg`} />
              </div>
              <div>
                <label className={`block text-[10px] font-medium ${theme.textSubtle} mb-1`}>Unit (optional)</label>
                <input type="text" value={editingTask.unit || ""}
                  onChange={e => setEditingTask({ ...editingTask, unit: e.target.value.slice(0, 10) })}
                  placeholder="e.g. L, hrs"
                  className={`w-full h-10 px-3 text-sm border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg`} />
              </div>
            </div>
          )}

          <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Schedule</label>
          <div className="grid grid-cols-3 gap-2 mb-2">
            {[
              { v: "daily", l: "Daily" },
              { v: "weekly", l: "Weekly" },
              { v: "custom-days", l: "Specific days" },
            ].map(o => (
              <button key={o.v} onClick={() => setEditingTask({
                ...editingTask,
                schedule: { ...editingTask.schedule, kind: o.v, days: o.v === "custom-days" ? (editingTask.schedule.days?.length ? editingTask.schedule.days : [1,2,3,4,5]) : [1,2,3,4,5,6,7] },
              })}
                className="h-10 rounded-lg text-xs font-semibold"
                style={{ backgroundColor: editingTask.schedule.kind === o.v ? ORANGE : "", color: editingTask.schedule.kind === o.v ? "white" : "" }}>
                <div className={editingTask.schedule.kind === o.v ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{o.l}</div>
              </button>
            ))}
          </div>

          {editingTask.schedule.kind === "custom-days" && (
            <div className="grid grid-cols-7 gap-1 mb-3">
              {DOW_LABELS.map((lbl, idx) => {
                const dow = idx + 1;
                const isSel = (editingTask.schedule.days || []).includes(dow);
                return (
                  <button key={dow}
                    onClick={() => {
                      const days = isSel
                        ? (editingTask.schedule.days || []).filter(d => d !== dow)
                        : [...(editingTask.schedule.days || []), dow].sort();
                      setEditingTask({ ...editingTask, schedule: { ...editingTask.schedule, days } });
                    }}
                    className="h-9 rounded-md text-[10px] font-semibold"
                    style={{ backgroundColor: isSel ? ORANGE : "", color: isSel ? "white" : "" }}>
                    <div className={isSel ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-md`}>{lbl.slice(0, 1)}</div>
                  </button>
                );
              })}
            </div>
          )}

          <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5 mt-2`}>Runs until</label>
          <div className="grid grid-cols-3 gap-2 mb-2">
            {[
              { v: "forever", l: "Forever" },
              { v: "block", l: "This block" },
              { v: "date", l: "A date" },
            ].map(o => (
              <button key={o.v} onClick={() => setEditingTask({
                ...editingTask,
                schedule: { ...editingTask.schedule, endKind: o.v },
              })}
                className="h-10 rounded-lg text-xs font-semibold"
                style={{ backgroundColor: editingTask.schedule.endKind === o.v ? ORANGE : "", color: editingTask.schedule.endKind === o.v ? "white" : "" }}>
                <div className={editingTask.schedule.endKind === o.v ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{o.l}</div>
              </button>
            ))}
          </div>

          {editingTask.schedule.endKind === "date" && (
            <input type="date" value={editingTask.schedule.endDate || ""}
              min={new Date().toISOString().split("T")[0]}
              onChange={e => setEditingTask({ ...editingTask, schedule: { ...editingTask.schedule, endDate: e.target.value } })}
              className={`w-full h-10 px-3 text-sm border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg mb-3`} />
          )}

          <label className="flex items-center gap-2 mb-3 mt-2 cursor-pointer">
            <input type="checkbox" checked={editingTask.countsTowardStreak !== false}
              onChange={e => setEditingTask({ ...editingTask, countsTowardStreak: e.target.checked })}
              className="w-4 h-4" />
            <span className={`text-xs ${theme.text}`}>Count toward daily streak/adherence</span>
          </label>

          <div className="flex gap-2">
            <button onClick={() => setEditingTask(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
            <button onClick={async () => {
              if (!editingTask.name.trim()) return;
              const clean = { ...editingTask };
              delete clean._isNew;
              const exists = customTasks.find(t => t.id === clean.id);
              const next = exists
                ? customTasks.map(t => t.id === clean.id ? clean : t)
                : [...customTasks, clean];
              await saveTasks(next);
              setEditingTask(null);
            }} disabled={!editingTask.name.trim()}
              className="flex-1 h-12 text-white rounded-xl font-semibold disabled:opacity-50"
              style={{ backgroundColor: ORANGE }}>Save</button>
          </div>
        </Modal>
      )}

      {showSecondaryTreat && secondaryTreatDraft && (
        <Modal title="Pick a second treat" onClose={() => setShowSecondaryTreat(false)} theme={theme}>
          <p className={`text-xs ${theme.textMuted} mb-3`}>This stacks with your primary treat — total daily deduction goes up. You'll bank one of each per qualifying week.</p>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {[
              { name: "Chocolate bar", kcal: 230, emoji: "🍫" },
              { name: "Pint of beer", kcal: 220, emoji: "🍺" },
              { name: "Glass of wine", kcal: 130, emoji: "🍷" },
              { name: "Slice of pizza", kcal: 285, emoji: "🍕" },
              { name: "Ice cream", kcal: 270, emoji: "🍨" },
              { name: "Pastry", kcal: 320, emoji: "🥐" },
              { name: "Coffee w/ milk", kcal: 120, emoji: "☕" },
              { name: "Custom", kcal: 200, emoji: "✨" },
            ].map(t => {
              const sel = secondaryTreatDraft.name === t.name;
              const isPrimary = profile.treat?.name === t.name && t.name !== "Custom";
              return (
                <button key={t.name}
                  onClick={() => !isPrimary && setSecondaryTreatDraft({ name: t.name, kcal: t.kcal, emoji: t.emoji, ambition: secondaryTreatDraft.ambition || 1 })}
                  disabled={isPrimary}
                  className="p-3 rounded-lg border-2 text-left active:opacity-80 disabled:opacity-30"
                  style={{ borderColor: sel ? ORANGE : "", backgroundColor: sel ? `${ORANGE}15` : "" }}>
                  <div className="text-xl">{t.emoji}</div>
                  <div className={`text-sm font-semibold ${theme.text}`}>{t.name}{isPrimary && " (primary)"}</div>
                  <div className={`text-[10px] ${theme.textMuted}`}>~{t.kcal} kcal</div>
                </button>
              );
            })}
          </div>
          {secondaryTreatDraft.name === "Custom" && (
            <>
              <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Treat name</label>
              <input type="text" value={secondaryTreatDraft.customName || ""} placeholder="e.g. Chinese takeaway"
                onChange={e => setSecondaryTreatDraft({ ...secondaryTreatDraft, customName: e.target.value })}
                className={`w-full h-12 px-4 text-base border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg mb-3`} />
              <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>Calories</label>
              <input type="number" inputMode="numeric" value={secondaryTreatDraft.kcal}
                onChange={e => setSecondaryTreatDraft({ ...secondaryTreatDraft, kcal: Number(e.target.value) || 0 })}
                className={`w-full h-12 px-4 text-base border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg mb-3`} />
            </>
          )}
          <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>How many per week?</label>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {[{ v: 0.5, l: "0.5x" }, { v: 1, l: "1x" }, { v: 2, l: "2x" }].map(o => (
              <button key={o.v} onClick={() => setSecondaryTreatDraft({ ...secondaryTreatDraft, ambition: o.v })} className="h-10 rounded-lg font-medium text-xs"
                style={{ backgroundColor: secondaryTreatDraft.ambition === o.v ? ORANGE : "", color: secondaryTreatDraft.ambition === o.v ? "white" : "" }}>
                <div className={secondaryTreatDraft.ambition === o.v ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{o.l}</div>
              </button>
            ))}
          </div>
          <div className={`text-[11px] ${theme.textMuted} mb-3 leading-snug`}>
            Daily extra: <span className="font-bold" style={{ color: ORANGE }}>−{Math.round((secondaryTreatDraft.kcal * secondaryTreatDraft.ambition) / 7)} kcal</span>
            {profile.treat && (
              <span> (+{Math.round((profile.treat.kcal * profile.treat.ambition) / 7)} from primary = {Math.round((profile.treat.kcal * profile.treat.ambition + secondaryTreatDraft.kcal * secondaryTreatDraft.ambition) / 7)} total)</span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowSecondaryTreat(false)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
            <button onClick={async () => {
              const next = { ...profile, secondaryTreat: secondaryTreatDraft };
              await storage.set(userKey(session.id, "profile"), next);
              setProfile(next);
              setShowSecondaryTreat(false);
            }} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Add treat</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Row({ l, v, theme, valueColor }) {
  return (
    <div className="flex justify-between">
      <span className={theme.textMuted}>{l}</span>
      <span className="font-medium" style={{ color: valueColor || (theme.text === "text-slate-100" ? "#f1f5f9" : "#0f172a") }}>{v}</span>
    </div>
  );
}

// Small target display cell for Settings — shows current effective value with
// "calc'd" or "custom" label and the calculated baseline beneath if overridden.
function TargetCell({ label, value, base, theme }) {
  const isOverride = value !== base;
  return (
    <div className="text-center">
      <div className={`text-[9px] font-bold uppercase tracking-wider ${theme.textMuted}`}>{label}</div>
      <div className={`text-sm font-bold ${theme.text}`} style={isOverride ? { color: ORANGE } : {}}>{value}</div>
      {isOverride && <div className={`text-[8px] ${theme.textMuted}`} style={{ textDecoration: "line-through" }}>{base}</div>}
    </div>
  );
}

// Numeric override input — empty string means "use baseline"
function OverrideInput({ label, base, unit, value, theme, onChange }) {
  // Use a local string state so the user can type freely (including transient
  // states like "" or partial entries) without controlled-input fights.
  const [text, setText] = useState(value != null ? String(value) : "");
  // If the parent value changes externally (e.g. reset), sync the local text
  useEffect(() => {
    setText(value != null ? String(value) : "");
  }, [value]);

  const handleChange = (raw) => {
    setText(raw);
    if (raw === "") {
      onChange(undefined);
    } else {
      const n = Number(raw);
      if (!Number.isNaN(n)) onChange(n);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1">
        <label className={`text-[10px] font-bold uppercase tracking-wider ${theme.textMuted}`}>{label}</label>
        <div className={`text-[10px] ${theme.textMuted}`}>Calculated: <span className={theme.text}>{base} {unit}</span></div>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          inputMode="numeric"
          placeholder={String(base)}
          value={text}
          onChange={e => handleChange(e.target.value)}
          className={`w-20 h-10 px-2 text-right text-sm border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg`} />
        <span className={`text-[10px] ${theme.textMuted} w-8`}>{unit}</span>
      </div>
    </div>
  );
}

// ============================================================
// PT APP
// ============================================================
function PTApp({ session, themeCtx, onLogout }) {
  const { theme } = themeCtx;
  const [view, setView] = useState("clients");
  const [active, setActive] = useState(null);

  if (view === "client" && active) return <PTClient client={active} themeCtx={themeCtx} onBack={() => { setView("clients"); setActive(null); }} />;
  return <PTList session={session} themeCtx={themeCtx} onLogout={onLogout} onPick={c => { setActive(c); setView("client"); }} />;
}

function PTList({ session, themeCtx, onLogout, onPick }) {
  const { theme, dark, toggle } = themeCtx;
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);

    useEffect(() => {
    (async () => {
      try {
        const sbKey = Object.keys(localStorage).find(k => k.startsWith("sb-") && k.endsWith("-auth-token"));
        const token = sbKey ? JSON.parse(localStorage.getItem(sbKey))?.access_token : null;
        const headers = { "apikey": SUPABASE_ANON_KEY };
        if (token) headers["Authorization"] = "Bearer " + token;
        const linksRes = await fetch(`${SUPABASE_URL}/rest/v1/pt_links?select=client_user_id&pt_user_id=eq.${session.id}&status=eq.active`, { headers });
        const links = linksRes.ok ? await linksRes.json() : [];
        const ids = links.map(l => l.client_user_id);
        const all = await Promise.all(ids.map(async id => {
          const profileRow = await supaGet(id, "profile");
          if (!profileRow) return null;
          const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=data&user_id=eq.${id}&limit=1`, { headers });
          const profArr = pr.ok ? await pr.json() : [];
          const username = profArr[0]?.data?.username || "client";
          const logs = (await supaGet(id, "logs")) || {};
          const dates = Object.keys(logs).sort().reverse();
          let latest = null, days7 = 0, weekAgo = null;
          for (let i = 0; i < Math.min(7, dates.length); i++) {
            if (logs[dates[i]]?.food) days7++;
            if (latest === null && logs[dates[i]]?.weight) latest = logs[dates[i]].weightValue;
          }
          for (let i = 6; i < Math.min(14, dates.length); i++) {
            if (logs[dates[i]]?.weight) { weekAgo = logs[dates[i]].weightValue; break; }
          }
          return { id, username, profile: profileRow, latest, days7, weekAgo };
        }));
        setClients(all.filter(Boolean));
      } catch (e) {
        console.error("PTList load failed", e);
      }
      setLoading(false);
    })();
  }, [session.id]);

  return (
    <div className={`min-h-screen ${theme.bg} pb-4`}>
      <div className="max-w-md mx-auto">
        <div className="px-5 pt-10 pb-6 text-white" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
          <Wordmark />
          <p className="text-blue-100 text-sm mt-3">PT Dashboard</p>
          <h1 className="text-2xl font-bold mt-1">Hi, {session.username}</h1>
        </div>
        <div className="px-4 pt-3">
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-4 mb-3`}>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div><div className={`text-2xl font-bold ${theme.text}`}>{clients.length}</div><div className={`text-[10px] uppercase ${theme.textMuted}`}>Clients</div></div>
              <div><div className="text-2xl font-bold text-emerald-600">{clients.filter(c => c.days7 >= 5).length}</div><div className={`text-[10px] uppercase ${theme.textMuted}`}>On track</div></div>
              <div><div className="text-2xl font-bold" style={{ color: ORANGE }}>{clients.filter(c => c.days7 < 5).length}</div><div className={`text-[10px] uppercase ${theme.textMuted}`}>Attention</div></div>
            </div>
          </div>
          {loading ? <div className={`text-center text-sm ${theme.textMuted} py-8`}>Loading...</div> : (
            <div className="space-y-2">
              {clients.map(c => {
                const t = calculateTargets(c.profile);
                const onTrack = c.days7 >= 5;
                const trend = c.latest && c.weekAgo ? c.latest - c.weekAgo : null;
                return (
                  <button key={c.id} onClick={() => onPick(c)} className={`w-full ${theme.card} rounded-2xl border-2 ${theme.border} p-4 text-left active:opacity-80`}>
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <h3 className={`font-semibold ${theme.text}`}>{c.profile.name}</h3>
                        <div className={`text-xs ${theme.textMuted}`}>{c.profile.goal} · target {c.profile.targetWeight}kg</div>
                      </div>
                      <div className="text-xs font-bold px-2 py-1 rounded" style={{ backgroundColor: onTrack ? "#dcfce7" : "#fef3c7", color: onTrack ? "#15803d" : "#a16207" }}>{c.days7}/7</div>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className={theme.textMuted}>
                        {c.latest ? `${c.latest}kg` : "—"}
                        {trend !== null && <span className="ml-1 font-semibold" style={{ color: (c.profile.goal === "Cut" && trend < 0) || (c.profile.goal.includes("Bulk") && trend > 0) ? "#10b981" : ORANGE }}>({trend > 0 ? "+" : ""}{trend.toFixed(1)}/wk)</span>}
                      </span>
                      <span className={theme.textMuted}>{t.calTarget.toLocaleString()} kcal</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <button onClick={toggle} className={`w-full h-11 ${theme.surface} ${theme.surfaceText} rounded-xl text-xs font-semibold mt-4`}>{dark ? "☀️ Light" : "🌙 Dark"}</button>
          <button onClick={onLogout} className={`w-full h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold mt-2`}>Log out</button>
        </div>
      </div>
    </div>
  );
}

function PTClient({ client, themeCtx, onBack }) {
  const { theme } = themeCtx;
  const [logs, setLogs] = useState({});
  const [lifts, setLifts] = useState({});
  const [completions, setCompletions] = useState({});
  const [suggestions, setSuggestions] = useState({ pending: [], accepted: [], rejected: [] });
  const [ptNote, setPtNote] = useState("");
  const [savedPtNote, setSavedPtNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [noteSavedAt, setNoteSavedAt] = useState(null);
  // Local mirror of the client's profile so PT edits update immediately.
  // Initialised from the prop and re-loaded from storage on mount.
  const [profile, setProfile] = useState(client.profile);
  // Edit modal state — { field: "calories" | "macros" | "goal" | "schedule" | "experience" | "water" | "focus" | "treat", draft: ... }
  const [editing, setEditing] = useState(null);
  // PT-side editing: plan-overrides (weight/rep hints, set counts, swaps) and exercise-prefs
  const [planOverrides, setPlanOverrides] = useState({});
  const [exercisePrefs, setExercisePrefs] = useState({});
  // Edit modal for a specific exercise's hints — { exerciseName, draft: {weight, reps, sets} }
  const [editingHint, setEditingHint] = useState(null);
  // Swap modal: { fromName, currentSwap } — picks a replacement exercise
  const [editingSwap, setEditingSwap] = useState(null);
  // Edit modal for an individual logged set
  const [editingSet, setEditingSet] = useState(null);

  const targets = useMemo(() => calculateTargets(profile), [profile]);

  // Save profile back to storage AND keep the client object's profile in sync
  // so other parts of PT view see the new values.
  const saveProfile = async (next) => {
    setProfile(next);
    await storage.set(userKey(client.id, "profile"), next);
    // Update the underlying client object too so badges in PTList re-render correctly next mount
    client.profile = next;
  };

  // Save plan-overrides (hints + set counts that drive future plan generation for the client)
  const savePlanOverrides = async (next) => {
    setPlanOverrides(next);
    await storage.set(userKey(client.id, "plan-overrides"), next);
  };

  // Save exercise-prefs (blockSwaps, ratings, etc. that drive future plan generation)
  const saveExercisePrefs = async (next) => {
    setExercisePrefs(next);
    await storage.set(userKey(client.id, "exercise-prefs"), next);
  };

  // Modify a single logged set in the client's lifts history
  const updateClientSet = async (exerciseName, date, setIndex, setUpdate) => {
    const next = { ...lifts };
    if (!next[exerciseName]) return;
    next[exerciseName] = { ...next[exerciseName], history: [...(next[exerciseName].history || [])] };
    const sessionIdx = next[exerciseName].history.findIndex(s => s.date === date);
    if (sessionIdx === -1) return;
    const sessionCopy = { ...next[exerciseName].history[sessionIdx], sets: [...next[exerciseName].history[sessionIdx].sets] };
    if (setUpdate === null) {
      sessionCopy.sets.splice(setIndex, 1);
    } else {
      sessionCopy.sets[setIndex] = setUpdate;
    }
    if (sessionCopy.sets.length === 0) {
      next[exerciseName].history.splice(sessionIdx, 1);
    } else {
      next[exerciseName].history[sessionIdx] = sessionCopy;
    }
    await storage.set(userKey(client.id, "lifts"), next);
    setLifts(next);
  };

  useEffect(() => {
    (async () => {
      setLogs((await storage.get(userKey(client.id, "logs"))) || {});
      setLifts((await storage.get(userKey(client.id, "lifts"))) || {});
      setCompletions((await storage.get(userKey(client.id, "session-completions"))) || {});
      setSuggestions((await storage.get(userKey(client.id, "suggestions"))) || { pending: [], accepted: [], rejected: [] });
      const note = (await storage.get(userKey(client.id, "pt-note"))) || "";
      setPtNote(note);
      setSavedPtNote(note);
      // Pull the latest profile — the client object may be stale if user changed something
      const storedProfile = await storage.get(userKey(client.id, "profile"));
      if (storedProfile) setProfile(storedProfile);
      // Plan overrides drive what the client sees when their plan generates
      setPlanOverrides((await storage.get(userKey(client.id, "plan-overrides"))) || {
        setOverrides: {}, weightHints: {}, repHints: {}, swapList: [], volumeNudges: {}
      });
      setExercisePrefs((await storage.get(userKey(client.id, "exercise-prefs"))) || {});
    })();
  }, [client.id]);

  const dates = Object.keys(logs).sort().reverse();
  const last7 = dates.slice(0, 7).map(d => logs[d]);
  const adherence = last7.filter(l => l.food && Math.abs(l.kcalEaten - targets.calTarget) < 200).length;
  const avgKcal = last7.filter(l => l.kcalEaten).map(l => l.kcalEaten);
  const avg = avgKcal.length ? Math.round(avgKcal.reduce((a, b) => a + b, 0) / avgKcal.length) : 0;
  const weights = dates.map(d => logs[d]).filter(l => l.weight && l.weightValue);

  // Workout adherence: sessions completed in last 7 days vs daysPerWeek target
  const sevenDayCutoff = new Date(); sevenDayCutoff.setDate(sevenDayCutoff.getDate() - 7);
  const completedSessions = Object.entries(completions).filter(([d]) => new Date(d) >= sevenDayCutoff);
  const sessionsThisWeek = completedSessions.reduce((sum, [, v]) => sum + (Array.isArray(v) ? v.length : 0), 0);
  const targetSessions = profile.daysPerWeek || 4;
  const sessionPct = Math.min(100, Math.round((sessionsThisWeek / targetSessions) * 100));

  // Strength trend: pick the user's most-logged compound lift, compute % change in top set e1RM
  // over the last 4 weeks.
  const strengthTrend = useMemo(() => {
    const compoundOrder = ["Barbell Squat", "Barbell Bench Press", "Barbell Row", "Romanian Deadlift", "Overhead Press"];
    const fourWkAgo = new Date(); fourWkAgo.setDate(fourWkAgo.getDate() - 28);
    const fourWkAgoStr = fourWkAgo.toISOString().split("T")[0];
    for (const lift of compoundOrder) {
      const history = lifts[lift]?.history || [];
      if (history.length < 3) continue;
      const recent = history.filter(s => s.date >= fourWkAgoStr);
      if (recent.length < 2) continue;
      // Top set e1RM = weight × (1 + reps/30)
      const e1rm = (s) => {
        const top = s.sets.reduce((m, st) => st.weight * (1 + st.reps / 30) > m ? st.weight * (1 + st.reps / 30) : m, 0);
        return top;
      };
      const first = e1rm(recent[0]);
      const last = e1rm(recent[recent.length - 1]);
      if (first === 0) continue;
      const pct = ((last - first) / first) * 100;
      return { lift, pct, sessions: recent.length, latestE1RM: last };
    }
    return null;
  }, [lifts]);

  const saveNote = async () => {
    setSavingNote(true);
    await storage.set(userKey(client.id, "pt-note"), ptNote);
    setSavedPtNote(ptNote);
    setNoteSavedAt(new Date());
    setSavingNote(false);
    setTimeout(() => setNoteSavedAt(null), 3000);
  };
  const noteIsDirty = ptNote !== savedPtNote;

  return (
    <div className={`min-h-screen ${theme.bg} pb-4`}>
      <div className="max-w-md mx-auto">
        <div className="px-5 pt-10 pb-6 text-white" style={{ background: `linear-gradient(135deg, ${theme.headerStart}, ${theme.headerEnd})` }}>
          <button onClick={onBack} className="text-blue-100 text-sm mb-3">← Back to clients</button>
          <h1 className="text-2xl font-bold">{profile.name}</h1>
          <p className="text-blue-100 text-sm">@{client.username} · {profile.goal}</p>
        </div>
        <div className="px-4 pt-3 space-y-3">

          {/* Quick metrics row */}
          <div className="grid grid-cols-2 gap-2">
            <div className={`${theme.card} rounded-xl border ${theme.border} p-3`}>
              <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted}`}>Food adherence</div>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-2xl font-bold" style={{ color: adherence >= 5 ? "#10b981" : adherence >= 3 ? "#f59e0b" : "#ef4444" }}>{Math.round((adherence / 7) * 100)}%</span>
                <span className={`text-[10px] ${theme.textMuted}`}>last 7</span>
              </div>
            </div>
            <div className={`${theme.card} rounded-xl border ${theme.border} p-3`}>
              <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted}`}>Workouts</div>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-2xl font-bold" style={{ color: sessionPct >= 100 ? "#10b981" : sessionPct >= 60 ? "#f59e0b" : "#ef4444" }}>{sessionsThisWeek}</span>
                <span className={`text-xs ${theme.textMuted}`}>/ {targetSessions} planned</span>
              </div>
            </div>
          </div>

          {/* Strength trend */}
          {strengthTrend && (
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
              <div className="flex items-center justify-between mb-1">
                <h3 className={`font-semibold text-sm ${theme.text}`}>Strength trend (4 wks)</h3>
                <span className="text-xs font-bold" style={{ color: strengthTrend.pct > 1 ? "#10b981" : strengthTrend.pct < -1 ? "#ef4444" : ORANGE }}>
                  {strengthTrend.pct > 0 ? "+" : ""}{strengthTrend.pct.toFixed(1)}%
                </span>
              </div>
              <div className={`text-xs ${theme.textMuted}`}>
                {strengthTrend.lift}: e1RM ~{strengthTrend.latestE1RM.toFixed(0)} kg over {strengthTrend.sessions} sessions
              </div>
            </div>
          )}

          {/* PT note — visible to client on their home */}
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
            <h3 className={`font-semibold text-sm ${theme.text} mb-2`}>Note to {profile.name}</h3>
            <p className={`text-[11px] ${theme.textMuted} mb-2`}>This shows on their home screen. Keep it short and actionable.</p>
            <textarea value={ptNote}
              onChange={e => setPtNote(e.target.value.slice(0, 280))}
              placeholder="e.g. Great squat session yesterday — push for +2.5kg next time. Make sure protein hits 140+ on training days."
              rows={3}
              className={`w-full p-3 text-sm border-2 ${theme.border} ${theme.inputBg} ${theme.text} rounded-lg`} />
            <div className="flex items-center justify-between mt-2">
              <span className={`text-[10px] ${theme.textMuted}`}>{ptNote.length}/280 chars</span>
              <div className="flex items-center gap-2">
                {noteSavedAt && <span className="text-[10px] text-emerald-500">Saved</span>}
                <button onClick={saveNote} disabled={!noteIsDirty || savingNote}
                  className="h-9 px-4 text-white rounded-lg text-xs font-semibold disabled:opacity-40"
                  style={{ backgroundColor: ORANGE }}>
                  {savingNote ? "Saving…" : noteIsDirty ? "Save note" : "Saved"}
                </button>
              </div>
            </div>
          </div>

          {/* Pending suggestions for client */}
          {suggestions.pending && suggestions.pending.length > 0 && (
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-4`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className={`font-semibold text-sm ${theme.text}`}>Pending suggestions</h3>
                <span className="text-xs font-bold px-2 py-0.5 rounded" style={{ backgroundColor: `${ORANGE}20`, color: ORANGE }}>{suggestions.pending.length}</span>
              </div>
              <div className="space-y-1.5">
                {suggestions.pending.slice(0, 5).map((s, i) => (
                  <div key={i} className={`text-xs p-2 ${theme.surface} rounded`}>
                    <div className={`font-semibold ${theme.text}`}>{s.title || s.type}</div>
                    {s.body && <div className={`${theme.textMuted} text-[11px] mt-0.5`}>{s.body}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className={`font-semibold ${theme.text}`}>Plan</h3>
              <span className={`text-[10px] ${theme.textMuted} italic`}>tap to edit</span>
            </div>
            <div className="space-y-1.5 text-sm">
              <button onClick={() => setEditing({ field: "goal", draft: { goal: profile.goal, targetWeight: profile.targetWeight, paceLabel: targets.intensityLabel } })}
                className={`w-full flex items-center justify-between p-2.5 ${theme.surface} rounded-lg`}>
                <span className={`${theme.textMuted} text-xs`}>Goal</span>
                <span className={`${theme.text} font-semibold flex items-center gap-1.5`}>
                  {profile.goal}{profile.targetWeight ? ` → ${profile.targetWeight}kg` : ""} <span style={{ color: ORANGE }}>›</span>
                </span>
              </button>
              <div className={`flex items-center justify-between p-2.5 ${theme.surface} rounded-lg`}>
                <span className={`${theme.textMuted} text-xs`}>Pace</span>
                <span className={`${theme.text} font-semibold text-xs`}>{targets.intensityLabel}</span>
              </div>
              <button onClick={() => setEditing({ field: "calories", draft: { value: profile.targetOverrides?.calTarget ?? "", base: targets.baseline.calTarget } })}
                className={`w-full flex items-center justify-between p-2.5 ${theme.surface} rounded-lg`}>
                <span className={`${theme.textMuted} text-xs`}>Calories</span>
                <span className={`${theme.text} font-semibold flex items-center gap-1.5`}>
                  {targets.calTarget.toLocaleString()} kcal
                  {profile.targetOverrides?.calTarget && <span className="text-[8px] px-1 py-0.5 rounded font-bold" style={{ backgroundColor: `${ORANGE}33`, color: ORANGE }}>OVR</span>}
                  <span style={{ color: ORANGE }}>›</span>
                </span>
              </button>
              <button onClick={() => setEditing({
                field: "macros",
                draft: {
                  p: profile.targetOverrides?.protein ?? "",
                  f: profile.targetOverrides?.fat ?? "",
                  c: profile.targetOverrides?.carbs ?? "",
                  base: { p: targets.baseline.protein, f: targets.baseline.fat, c: targets.baseline.carbs },
                },
              })}
                className={`w-full flex items-center justify-between p-2.5 ${theme.surface} rounded-lg`}>
                <span className={`${theme.textMuted} text-xs`}>Macros</span>
                <span className={`${theme.text} font-semibold flex items-center gap-1.5`}>
                  P{targets.protein} F{targets.fat} C{targets.carbs}
                  {(profile.targetOverrides?.protein || profile.targetOverrides?.fat || profile.targetOverrides?.carbs) && <span className="text-[8px] px-1 py-0.5 rounded font-bold" style={{ backgroundColor: `${ORANGE}33`, color: ORANGE }}>OVR</span>}
                  <span style={{ color: ORANGE }}>›</span>
                </span>
              </button>
              <button onClick={() => setEditing({ field: "schedule", draft: { daysPerWeek: profile.daysPerWeek, sessionLength: profile.sessionLength, split: profile.split } })}
                className={`w-full flex items-center justify-between p-2.5 ${theme.surface} rounded-lg`}>
                <span className={`${theme.textMuted} text-xs`}>Schedule</span>
                <span className={`${theme.text} font-semibold flex items-center gap-1.5`}>
                  {profile.daysPerWeek}× {profile.sessionLength}min · {profile.split} <span style={{ color: ORANGE }}>›</span>
                </span>
              </button>
              <button onClick={() => setEditing({ field: "focus", draft: { focusAreas: [...(profile.focusAreas || [])] } })}
                className={`w-full flex items-center justify-between p-2.5 ${theme.surface} rounded-lg`}>
                <span className={`${theme.textMuted} text-xs`}>Focus</span>
                <span className={`${theme.text} font-semibold flex items-center gap-1.5 text-xs`}>
                  {profile.focusAreas?.length > 0 ? profile.focusAreas.join(", ") : <span className={theme.textMuted}>None</span>}
                  <span style={{ color: ORANGE }}>›</span>
                </span>
              </button>
              <button onClick={() => setEditing({ field: "experience", draft: { experience: profile.experience || 3 } })}
                className={`w-full flex items-center justify-between p-2.5 ${theme.surface} rounded-lg`}>
                <span className={`${theme.textMuted} text-xs`}>Experience</span>
                <span className={`${theme.text} font-semibold flex items-center gap-1.5`}>Level {profile.experience || 3} <span style={{ color: ORANGE }}>›</span></span>
              </button>
              <button onClick={() => setEditing({ field: "water", draft: { waterTarget: profile.waterTarget || 2.5 } })}
                className={`w-full flex items-center justify-between p-2.5 ${theme.surface} rounded-lg`}>
                <span className={`${theme.textMuted} text-xs`}>Water target</span>
                <span className={`${theme.text} font-semibold flex items-center gap-1.5`}>{profile.waterTarget || 2.5}L <span style={{ color: ORANGE }}>›</span></span>
              </button>
            </div>
          </div>
          {weights.length > 1 && (
            <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
              <h3 className={`font-semibold mb-3 ${theme.text}`}>Weight trend</h3>
              <Sparkline data={weights.slice().reverse().map(w => w.weightValue)} target={profile.targetWeight} />
            </div>
          )}

          {/* Training history — last 14 days of logged sessions, sets editable inline */}
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className={`font-semibold ${theme.text}`}>Training history</h3>
              <span className={`text-[10px] ${theme.textMuted} italic`}>tap a set to edit</span>
            </div>
            {(() => {
              const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14);
              const cutoffStr = cutoff.toISOString().split("T")[0];
              const byDate = {};
              for (const [name, data] of Object.entries(lifts)) {
                for (const s of (data?.history || [])) {
                  if (s.date < cutoffStr) continue;
                  if (!byDate[s.date]) byDate[s.date] = [];
                  byDate[s.date].push({ name, sets: s.sets });
                }
              }
              const dates = Object.keys(byDate).sort().reverse();
              if (dates.length === 0) {
                return <p className={`text-xs ${theme.textMuted} italic`}>No logged sessions in the last 14 days.</p>;
              }
              return (
                <div className="space-y-3">
                  {dates.map(d => (
                    <div key={d}>
                      <div className={`text-[11px] font-bold uppercase tracking-wider ${theme.textMuted} mb-1.5`}>
                        {new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                      </div>
                      <div className="space-y-1.5">
                        {byDate[d].map((ex, exi) => {
                          const totalVol = ex.sets.reduce((s, x) => {
                            const base = (x.weight || 0) * (x.reps || 0);
                            const drops = (x.drops || []).reduce((dv, dx) => dv + (dx.weight || 0) * (dx.reps || 0), 0);
                            return s + base + drops;
                          }, 0);
                          return (
                            <div key={exi} className={`${theme.surface} rounded-lg p-2.5`}>
                              <div className="flex items-center justify-between mb-1.5">
                                <div className={`flex items-center gap-1.5 min-w-0`}>
                                  <div className={`font-semibold text-sm ${theme.text} truncate`}>{ex.name}</div>
                                  {exercisePrefs.blockSwaps?.[ex.name] && (
                                    <span className="text-[8px] font-bold px-1 py-0.5 rounded flex-shrink-0" style={{ backgroundColor: `${ORANGE}33`, color: ORANGE }} title={`Swapped to ${exercisePrefs.blockSwaps[ex.name]}`}>SWAP</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  <button onClick={() => setEditingSwap({ fromName: ex.name, currentSwap: exercisePrefs.blockSwaps?.[ex.name] || null })}
                                    className="text-[10px] font-semibold px-2 py-1 rounded" style={{ backgroundColor: `${NAVY}15`, color: NAVY }}>
                                    Swap
                                  </button>
                                  <button onClick={() => setEditingHint({ exerciseName: ex.name, draft: { weight: planOverrides.weightHints?.[ex.name] ?? "", reps: planOverrides.repHints?.[ex.name] ?? "", sets: planOverrides.setOverrides?.[ex.name] ?? "" } })}
                                    className="text-[10px] font-semibold px-2 py-1 rounded" style={{ backgroundColor: `${ORANGE}20`, color: ORANGE }}>
                                    Hint
                                  </button>
                                </div>
                              </div>
                              <div className="space-y-1">
                                {ex.sets.map((s, si) => (
                                  <button key={si}
                                    onClick={() => setEditingSet({ exerciseName: ex.name, date: d, setIndex: si, draft: { weight: s.weight, reps: s.reps, rir: s.rir ?? 2 } })}
                                    className={`w-full flex items-center gap-2 p-1.5 ${theme.card} rounded text-[11px] active:opacity-70`}>
                                    <span className={`font-bold ${theme.text} w-12 text-left`}>Set {si + 1}</span>
                                    <span className={`flex-1 text-left ${theme.text}`}>{s.weight}kg × {s.reps} reps</span>
                                    {s.drops?.length > 0 && (
                                      <span className="text-[8px] font-bold px-1 py-0.5 rounded" style={{ backgroundColor: "#15803d33", color: "#15803d" }}>+{s.drops.length}D</span>
                                    )}
                                    <span className={`text-[9px] font-semibold ${s.rir === 0 ? "text-red-500" : theme.textMuted}`}>RIR {s.rir != null ? s.rir : "—"} ›</span>
                                  </button>
                                ))}
                              </div>
                              <div className={`text-[9px] ${theme.textMuted} mt-1 text-right`}>{totalVol.toLocaleString()} kg vol</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* Preferences — read-only summary of what the client has configured */}
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
            <h3 className={`font-semibold mb-3 ${theme.text}`}>Client preferences</h3>
            <div className="space-y-2 text-xs">
              <div className="flex items-start justify-between gap-3">
                <span className={theme.textMuted}>Treats</span>
                <span className={`${theme.text} text-right`}>
                  {profile.treat ? <span>{profile.treat.emoji} {profile.treat.name} ({profile.treat.kcal} kcal)</span> : <span className={theme.textMuted}>None</span>}
                  {profile.secondaryTreat && <span><br/>{profile.secondaryTreat.emoji} {profile.secondaryTreat.name} ({profile.secondaryTreat.kcal} kcal)</span>}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className={theme.textMuted}>Steps target</span>
                <span className={theme.text}>{(profile.steps || 0).toLocaleString()}/day</span>
              </div>
              <div className="flex items-center justify-between">
                <span className={theme.textMuted}>Activity level</span>
                <span className={theme.text}>{profile.activity || "—"}× BMR</span>
              </div>
              <div className="flex items-center justify-between">
                <span className={theme.textMuted}>Sex / Age</span>
                <span className={theme.text}>{profile.sex} · {profile.age}y</span>
              </div>
              <div className="flex items-center justify-between">
                <span className={theme.textMuted}>Height / Weight</span>
                <span className={theme.text}>{profile.height}cm · {profile.weight}kg</span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className={theme.textMuted}>Intensification</span>
                <span className={`${theme.text} text-right`}>
                  Supersets {exercisePrefs.intensificationEnabled?.supersets !== false ? "✓" : "✗"} ·
                  Dropsets {exercisePrefs.intensificationEnabled?.dropsets !== false ? "✓" : "✗"}
                </span>
              </div>
              {Object.keys(exercisePrefs.ratings || {}).length > 0 && (() => {
                const ratings = exercisePrefs.ratings || {};
                const loved = Object.entries(ratings).filter(([, r]) => r === 5).map(([n]) => n);
                const hated = Object.entries(ratings).filter(([, r]) => r === 1).map(([n]) => n);
                return (
                  <>
                    {loved.length > 0 && (
                      <div className="flex items-start justify-between gap-3">
                        <span className={theme.textMuted}>Loves</span>
                        <span className={`${theme.text} text-right`} style={{ color: "#10b981" }}>{loved.slice(0, 3).join(", ")}{loved.length > 3 ? ` +${loved.length - 3}` : ""}</span>
                      </div>
                    )}
                    {hated.length > 0 && (
                      <div className="flex items-start justify-between gap-3">
                        <span className={theme.textMuted}>Hates</span>
                        <span className={`${theme.text} text-right`} style={{ color: "#ef4444" }}>{hated.slice(0, 3).join(", ")}{hated.length > 3 ? ` +${hated.length - 3}` : ""}</span>
                      </div>
                    )}
                  </>
                );
              })()}
              {exercisePrefs.unavailable?.length > 0 && (
                <div className="flex items-start justify-between gap-3">
                  <span className={theme.textMuted}>Unavailable</span>
                  <span className={`${theme.text} text-right`}>{exercisePrefs.unavailable.slice(0, 3).join(", ")}{exercisePrefs.unavailable.length > 3 ? ` +${exercisePrefs.unavailable.length - 3}` : ""}</span>
                </div>
              )}
              {Object.keys(planOverrides.weightHints || {}).length > 0 && (
                <div className="flex items-start justify-between gap-3">
                  <span className={theme.textMuted}>Active hints</span>
                  <span className={`${theme.text} text-right`}>{Object.keys(planOverrides.weightHints).length} weight, {Object.keys(planOverrides.setOverrides || {}).length} set overrides</span>
                </div>
              )}
              {Object.keys(exercisePrefs.blockSwaps || {}).length > 0 && (
                <div className="flex items-start justify-between gap-3">
                  <span className={theme.textMuted}>Active swaps</span>
                  <span className={`${theme.text} text-right text-[11px]`}>
                    {Object.entries(exercisePrefs.blockSwaps).slice(0, 3).map(([from, to]) => `${from}→${to}`).join(", ")}
                    {Object.keys(exercisePrefs.blockSwaps).length > 3 ? ` +${Object.keys(exercisePrefs.blockSwaps).length - 3}` : ""}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Development areas — weekly volume per muscle group vs targets, growth trends */}
          <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
            <h3 className={`font-semibold mb-3 ${theme.text}`}>Development</h3>
            {(() => {
              // Build weekly volume per muscle group
              const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
              const cutoffStr = cutoff.toISOString().split("T")[0];
              const byMuscle = {};
              for (const [name, data] of Object.entries(lifts)) {
                const muscle = MUSCLE_MAP[name] || "Other";
                const recentSessions = (data?.history || []).filter(s => s.date >= cutoffStr);
                const sets = recentSessions.reduce((sum, s) => sum + s.sets.length, 0);
                if (!byMuscle[muscle]) byMuscle[muscle] = { sets: 0 };
                byMuscle[muscle].sets += sets;
              }
              const scaled = getScaledOptimalVolume(profile);
              const sorted = Object.entries(byMuscle).sort((a, b) => b[1].sets - a[1].sets);
              if (sorted.length === 0) {
                return <p className={`text-xs ${theme.textMuted} italic`}>No training data yet — encourage the client to log some sessions.</p>;
              }
              return (
                <div className="space-y-2">
                  <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-1`}>Weekly volume vs target</div>
                  {sorted.slice(0, 8).map(([muscle, data]) => {
                    const optimal = scaled.ranges[muscle] || [MIN_EFFECTIVE_DOSE, 12];
                    const inRange = data.sets >= optimal[0] && data.sets <= optimal[1];
                    const tooLow = data.sets < optimal[0];
                    const pct = Math.min(100, (data.sets / (optimal[1] * 1.2)) * 100);
                    const color = inRange ? "#10b981" : tooLow ? ORANGE : "#ef4444";
                    return (
                      <div key={muscle}>
                        <div className="flex items-center justify-between text-[11px] mb-0.5">
                          <span className={`font-semibold ${theme.text}`}>{muscle}</span>
                          <span style={{ color }}>{data.sets} sets · target {optimal[0]}-{optimal[1]}</span>
                        </div>
                        <div className={`h-1.5 ${theme.surface} rounded-full overflow-hidden`}>
                          <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            {strengthTrend && (
              <div className={`mt-3 pt-3 border-t ${theme.border}`}>
                <div className={`text-[10px] font-bold uppercase tracking-wide ${theme.textMuted} mb-1`}>Top lift trend</div>
                <div className="flex items-center justify-between text-xs">
                  <span className={`font-semibold ${theme.text}`}>{strengthTrend.lift}</span>
                  <span className="font-bold" style={{ color: strengthTrend.pct > 1 ? "#10b981" : strengthTrend.pct < -1 ? "#ef4444" : ORANGE }}>
                    {strengthTrend.pct > 0 ? "+" : ""}{strengthTrend.pct.toFixed(1)}% · e1RM {strengthTrend.latestE1RM.toFixed(0)}kg
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className={`${theme.card} rounded-2xl border ${theme.border} p-5`}>
            <h3 className={`font-semibold mb-3 ${theme.text}`}>Recent log</h3>
            <div className="space-y-1.5">
              {dates.slice(0, 10).map(d => (
                <div key={d} className={`flex justify-between p-2.5 ${theme.surface} rounded-lg text-sm`}>
                  <div>
                    <div className={`font-semibold ${theme.text}`}>{new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</div>
                    <div className={`text-[11px] ${theme.textMuted}`}>P{logs[d].proteinEaten || 0} F{logs[d].fatEaten || 0} C{logs[d].carbsEaten || 0}</div>
                  </div>
                  <div className={`font-bold ${theme.text}`}>{(logs[d].kcalEaten || 0).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Edit modal — switches body content based on which field is being edited */}
      {editing && (
        <Modal
          title={(() => {
            const titles = { goal: "Edit goal", calories: "Override calories", macros: "Override macros", schedule: "Edit schedule", focus: "Edit focus areas", experience: "Training experience", water: "Water target" };
            return titles[editing.field] || "Edit";
          })()}
          onClose={() => setEditing(null)}
          theme={theme}>

          {editing.field === "goal" && (
            <div>
              <label className={`text-[10px] font-bold uppercase tracking-wider ${theme.textMuted}`}>Goal</label>
              <div className="grid grid-cols-3 gap-2 mt-1 mb-3">
                {["Cut", "Recomp", "Lean Bulk"].map(g => {
                  const sel = editing.draft.goal === g;
                  return (
                    <button key={g} onClick={() => setEditing({ ...editing, draft: { ...editing.draft, goal: g } })}
                      className="h-12 rounded-lg font-semibold text-xs"
                      style={{ backgroundColor: sel ? ORANGE : "", color: sel ? "white" : "" }}>
                      <div className={sel ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{g}</div>
                    </button>
                  );
                })}
              </div>
              <NumInput label="Target weight (kg)" value={editing.draft.targetWeight || 0}
                setValue={v => setEditing({ ...editing, draft: { ...editing.draft, targetWeight: v } })}
                suffix="kg" step={0.5} theme={theme} />
              <div className="flex gap-2 mt-2">
                <button onClick={() => setEditing(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
                <button onClick={async () => {
                  await saveProfile({ ...profile, goal: editing.draft.goal, targetWeight: editing.draft.targetWeight || profile.targetWeight });
                  setEditing(null);
                }} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
              </div>
            </div>
          )}

          {editing.field === "calories" && (
            <div>
              <p className={`text-[11px] ${theme.textMuted} mb-2`}>
                Calculated baseline: <span className={theme.text}>{editing.draft.base} kcal</span>. Set a number to override, or leave blank to use the calculated value.
              </p>
              <NumInput label="Calorie target" value={editing.draft.value === "" ? 0 : editing.draft.value}
                setValue={v => setEditing({ ...editing, draft: { ...editing.draft, value: v } })}
                suffix="kcal" step={50} theme={theme} />
              <div className="flex gap-2 mt-2">
                {profile.targetOverrides?.calTarget && (
                  <button onClick={async () => {
                    const overrides = { ...(profile.targetOverrides || {}) };
                    delete overrides.calTarget;
                    await saveProfile({ ...profile, targetOverrides: overrides });
                    setEditing(null);
                  }} className="h-12 px-4 rounded-xl font-semibold text-sm" style={{ color: "#ef4444", backgroundColor: "#ef444415" }}>Clear</button>
                )}
                <button onClick={() => setEditing(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
                <button onClick={async () => {
                  const overrides = { ...(profile.targetOverrides || {}) };
                  if (editing.draft.value && editing.draft.value > 0) overrides.calTarget = editing.draft.value;
                  else delete overrides.calTarget;
                  await saveProfile({ ...profile, targetOverrides: overrides });
                  setEditing(null);
                }} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
              </div>
            </div>
          )}

          {editing.field === "macros" && (
            <div>
              <p className={`text-[11px] ${theme.textMuted} mb-2`}>
                Calculated baseline: <span className={theme.text}>P{editing.draft.base.p} F{editing.draft.base.f} C{editing.draft.base.c}</span>. Override any field; leave 0 to use calculated.
              </p>
              <NumInput label="Protein" value={editing.draft.p === "" ? 0 : editing.draft.p} setValue={v => setEditing({ ...editing, draft: { ...editing.draft, p: v } })} suffix="g" step={5} theme={theme} />
              <NumInput label="Fat" value={editing.draft.f === "" ? 0 : editing.draft.f} setValue={v => setEditing({ ...editing, draft: { ...editing.draft, f: v } })} suffix="g" step={5} theme={theme} />
              <NumInput label="Carbs" value={editing.draft.c === "" ? 0 : editing.draft.c} setValue={v => setEditing({ ...editing, draft: { ...editing.draft, c: v } })} suffix="g" step={5} theme={theme} />
              <div className="flex gap-2 mt-2">
                <button onClick={() => setEditing(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
                <button onClick={async () => {
                  const overrides = { ...(profile.targetOverrides || {}) };
                  if (editing.draft.p > 0) overrides.protein = editing.draft.p; else delete overrides.protein;
                  if (editing.draft.f > 0) overrides.fat = editing.draft.f; else delete overrides.fat;
                  if (editing.draft.c > 0) overrides.carbs = editing.draft.c; else delete overrides.carbs;
                  await saveProfile({ ...profile, targetOverrides: overrides });
                  setEditing(null);
                }} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
              </div>
            </div>
          )}

          {editing.field === "schedule" && (
            <div>
              <NumInput label="Days per week" value={editing.draft.daysPerWeek} setValue={v => setEditing({ ...editing, draft: { ...editing.draft, daysPerWeek: Math.max(1, Math.min(7, v)) } })} suffix="days" step={1} theme={theme} />
              <NumInput label="Session length" value={editing.draft.sessionLength} setValue={v => setEditing({ ...editing, draft: { ...editing.draft, sessionLength: Math.max(15, v) } })} suffix="min" step={15} theme={theme} />
              <label className={`text-[10px] font-bold uppercase tracking-wider ${theme.textMuted}`}>Split</label>
              <div className="grid grid-cols-2 gap-2 mt-1">
                {["Full Body", "Upper-Lower", "PPL", "Bro Split"].map(s => {
                  const sel = editing.draft.split === s;
                  return (
                    <button key={s} onClick={() => setEditing({ ...editing, draft: { ...editing.draft, split: s } })}
                      className="h-11 rounded-lg font-semibold text-xs"
                      style={{ backgroundColor: sel ? ORANGE : "", color: sel ? "white" : "" }}>
                      <div className={sel ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{s}</div>
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2 mt-3">
                <button onClick={() => setEditing(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
                <button onClick={async () => {
                  await saveProfile({ ...profile, daysPerWeek: editing.draft.daysPerWeek, sessionLength: editing.draft.sessionLength, split: editing.draft.split });
                  setEditing(null);
                }} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
              </div>
            </div>
          )}

          {editing.field === "focus" && (
            <div>
              <p className={`text-[11px] ${theme.textMuted} mb-2`}>Tap muscle groups to bias volume toward them. Max 3 for best results.</p>
              <div className="grid grid-cols-3 gap-1.5 mb-3">
                {["Chest", "Back", "Shoulders", "Arms", "Biceps", "Triceps", "Glutes", "Quads", "Hamstrings", "Calves", "Core", "Upper Body", "Lower Body"].map(m => {
                  const sel = editing.draft.focusAreas.includes(m);
                  return (
                    <button key={m} onClick={() => {
                      const next = sel ? editing.draft.focusAreas.filter(x => x !== m) : [...editing.draft.focusAreas, m];
                      setEditing({ ...editing, draft: { focusAreas: next } });
                    }}
                      className="h-10 rounded-lg font-semibold text-[11px]"
                      style={{ backgroundColor: sel ? ORANGE : "", color: sel ? "white" : "" }}>
                      <div className={sel ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{m}</div>
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <button onClick={() => setEditing(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
                <button onClick={async () => {
                  await saveProfile({ ...profile, focusAreas: editing.draft.focusAreas });
                  setEditing(null);
                }} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
              </div>
            </div>
          )}

          {editing.field === "experience" && (
            <div>
              <p className={`text-[11px] ${theme.textMuted} mb-2`}>Training experience drives plan complexity and intensification rules.</p>
              <div className="grid grid-cols-5 gap-1.5 mb-2">
                {[1, 2, 3, 4, 5].map(n => {
                  const sel = editing.draft.experience === n;
                  return (
                    <button key={n} onClick={() => setEditing({ ...editing, draft: { experience: n } })}
                      className="h-12 rounded-lg font-bold"
                      style={{ backgroundColor: sel ? ORANGE : "", color: sel ? "white" : "" }}>
                      <div className={sel ? "" : `${theme.surface} ${theme.surfaceText} h-full flex items-center justify-center rounded-lg`}>{n}</div>
                    </button>
                  );
                })}
              </div>
              <p className={`text-[10px] ${theme.textMuted} italic leading-snug mb-3`}>
                {editing.draft.experience === 1 && "1 — Brand new. Avoids complex barbell lifts."}
                {editing.draft.experience === 2 && "2 — Some experience. Still building form."}
                {editing.draft.experience === 3 && "3 — Most lifts available. Light intensification."}
                {editing.draft.experience === 4 && "4 — Years trained. Full intensification."}
                {editing.draft.experience === 5 && "5 — Advanced. Complex movements + doubled intensification."}
              </p>
              <div className="flex gap-2">
                <button onClick={() => setEditing(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
                <button onClick={async () => {
                  await saveProfile({ ...profile, experience: editing.draft.experience });
                  setEditing(null);
                }} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
              </div>
            </div>
          )}

          {editing.field === "water" && (
            <div>
              <NumInput label="Daily water target" value={editing.draft.waterTarget}
                setValue={v => setEditing({ ...editing, draft: { waterTarget: Math.max(0.5, v) } })}
                suffix="L" step={0.25} theme={theme} />
              <p className={`text-[10px] ${theme.textMuted} italic mb-3`}>Typical: 2.5L (M) / 2L (F). Adjust for climate and training load.</p>
              <div className="flex gap-2">
                <button onClick={() => setEditing(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
                <button onClick={async () => {
                  await saveProfile({ ...profile, waterTarget: editing.draft.waterTarget });
                  setEditing(null);
                }} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
              </div>
            </div>
          )}

        </Modal>
      )}

      {/* Per-exercise hint editor — sets weight/rep/set-count hints in plan-overrides */}
      {editingHint && (
        <Modal
          title={editingHint.exerciseName}
          onClose={() => setEditingHint(null)}
          theme={theme}>
          <p className={`text-[11px] ${theme.textMuted} mb-3 leading-snug`}>
            Set hints for {editingHint.exerciseName}. The client will see these as starting targets in their logger. Leave blank to clear.
          </p>
          <NumInput label="Weight hint" value={editingHint.draft.weight === "" ? 0 : editingHint.draft.weight}
            setValue={v => setEditingHint({ ...editingHint, draft: { ...editingHint.draft, weight: v } })}
            suffix="kg" step={2.5} theme={theme} />
          <NumInput label="Rep hint" value={editingHint.draft.reps === "" ? 0 : editingHint.draft.reps}
            setValue={v => setEditingHint({ ...editingHint, draft: { ...editingHint.draft, reps: v } })}
            suffix="reps" step={1} theme={theme} />
          <NumInput label="Set count override" value={editingHint.draft.sets === "" ? 0 : editingHint.draft.sets}
            setValue={v => setEditingHint({ ...editingHint, draft: { ...editingHint.draft, sets: v } })}
            suffix="sets" step={1} theme={theme} />
          <div className="flex gap-2 mt-2">
            <button onClick={() => setEditingHint(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
            <button onClick={async () => {
              const next = {
                setOverrides: { ...(planOverrides.setOverrides || {}) },
                weightHints: { ...(planOverrides.weightHints || {}) },
                repHints: { ...(planOverrides.repHints || {}) },
                swapList: planOverrides.swapList || [],
                volumeNudges: planOverrides.volumeNudges || {},
              };
              if (editingHint.draft.weight > 0) next.weightHints[editingHint.exerciseName] = editingHint.draft.weight;
              else delete next.weightHints[editingHint.exerciseName];
              if (editingHint.draft.reps > 0) next.repHints[editingHint.exerciseName] = editingHint.draft.reps;
              else delete next.repHints[editingHint.exerciseName];
              if (editingHint.draft.sets > 0) next.setOverrides[editingHint.exerciseName] = editingHint.draft.sets;
              else delete next.setOverrides[editingHint.exerciseName];
              await savePlanOverrides(next);
              setEditingHint(null);
            }} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
          </div>
        </Modal>
      )}

      {/* Swap exercise — picks a same-muscle replacement, persists to blockSwaps */}
      {editingSwap && (
        <Modal
          title={`Swap ${editingSwap.fromName}`}
          onClose={() => setEditingSwap(null)}
          theme={theme}>
          {(() => {
            const fromMuscle = MUSCLE_MAP[editingSwap.fromName];
            if (!fromMuscle) {
              return (
                <p className={`text-xs ${theme.textMuted} italic mb-3`}>
                  No alternatives available for this exercise.
                </p>
              );
            }
            const candidates = Object.entries(MUSCLE_MAP)
              .filter(([name, muscle]) => muscle === fromMuscle && name !== editingSwap.fromName)
              .map(([name]) => name);
            return (
              <>
                <p className={`text-[11px] ${theme.textMuted} mb-3 leading-snug`}>
                  Swap with another <span className={theme.text}>{fromMuscle}</span> exercise. The substitution will apply next time the client's plan generates.
                </p>
                {editingSwap.currentSwap && (
                  <div className={`mb-3 p-2.5 rounded-lg flex items-center justify-between`} style={{ backgroundColor: `${ORANGE}15`, border: `1px solid ${ORANGE}33` }}>
                    <div>
                      <div className={`text-[10px] uppercase tracking-wider font-bold`} style={{ color: ORANGE }}>Current swap</div>
                      <div className={`text-sm ${theme.text}`}>{editingSwap.currentSwap}</div>
                    </div>
                    <button onClick={async () => {
                      const next = { ...exercisePrefs, blockSwaps: { ...(exercisePrefs.blockSwaps || {}) } };
                      delete next.blockSwaps[editingSwap.fromName];
                      await saveExercisePrefs(next);
                      setEditingSwap(null);
                    }} className="text-[10px] font-bold px-2 py-1 rounded" style={{ color: "#ef4444", backgroundColor: "#ef444415" }}>
                      Remove
                    </button>
                  </div>
                )}
                <div className="space-y-1.5 mb-3">
                  {candidates.length === 0 && (
                    <p className={`text-xs ${theme.textMuted} italic`}>No same-muscle alternatives in the catalog.</p>
                  )}
                  {candidates.map(name => {
                    const sel = editingSwap.currentSwap === name;
                    return (
                      <button key={name} onClick={async () => {
                        const next = { ...exercisePrefs, blockSwaps: { ...(exercisePrefs.blockSwaps || {}) } };
                        next.blockSwaps[editingSwap.fromName] = name;
                        await saveExercisePrefs(next);
                        setEditingSwap(null);
                      }}
                        className={`w-full p-3 rounded-lg text-left flex items-center justify-between ${theme.surface}`}
                        style={{ border: sel ? `2px solid ${ORANGE}` : "2px solid transparent" }}>
                        <span className={`text-sm ${theme.text}`}>{name}</span>
                        <span style={{ color: ORANGE }}>{sel ? "✓" : "→"}</span>
                      </button>
                    );
                  })}
                </div>
                <button onClick={() => setEditingSwap(null)} className={`w-full h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
              </>
            );
          })()}
        </Modal>
      )}

      {/* Individual set editor — modify or delete a logged set */}
      {editingSet && (
        <Modal
          title={`${editingSet.exerciseName} · Set ${editingSet.setIndex + 1}`}
          onClose={() => setEditingSet(null)}
          theme={theme}>
          <NumInput label="Weight" value={editingSet.draft.weight}
            setValue={v => setEditingSet({ ...editingSet, draft: { ...editingSet.draft, weight: v } })}
            suffix="kg" step={2.5} theme={theme} />
          <NumInput label="Reps" value={editingSet.draft.reps}
            setValue={v => setEditingSet({ ...editingSet, draft: { ...editingSet.draft, reps: v } })}
            suffix="reps" step={1} theme={theme} />
          <label className={`block text-sm font-medium ${theme.textSubtle} mb-1.5`}>RIR</label>
          <div className="grid grid-cols-4 gap-1.5 mb-3">
            {[
              { v: 0, l: "0", sub: "failure" },
              { v: 1, l: "1", sub: "1 left" },
              { v: 2, l: "2", sub: "2 left" },
              { v: 3, l: "2+", sub: "loads left" },
            ].map(o => {
              const sel = editingSet.draft.rir === o.v;
              return (
                <button key={o.v} onClick={() => setEditingSet({ ...editingSet, draft: { ...editingSet.draft, rir: o.v } })}
                  className="h-12 rounded-lg font-bold text-sm"
                  style={{ backgroundColor: sel ? NAVY : "", color: sel ? "white" : "" }}>
                  <div className={sel ? "flex flex-col items-center justify-center h-full" : `${theme.surface} ${theme.surfaceText} h-full flex flex-col items-center justify-center rounded-lg`}>
                    <div>{o.l}</div>
                    <div className="text-[8px] font-normal opacity-70">{o.sub}</div>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button onClick={async () => {
              await updateClientSet(editingSet.exerciseName, editingSet.date, editingSet.setIndex, null);
              setEditingSet(null);
            }} className="h-12 px-4 rounded-xl font-semibold text-sm" style={{ color: "#ef4444", backgroundColor: "#ef444415" }}>
              Delete
            </button>
            <button onClick={() => setEditingSet(null)} className={`flex-1 h-12 ${theme.surface} ${theme.surfaceText} rounded-xl font-semibold`}>Cancel</button>
            <button onClick={async () => {
              await updateClientSet(editingSet.exerciseName, editingSet.date, editingSet.setIndex, editingSet.draft);
              setEditingSet(null);
            }} className="flex-1 h-12 text-white rounded-xl font-semibold" style={{ backgroundColor: ORANGE }}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
