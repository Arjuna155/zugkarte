// Schweizer Uhrzeit (unabhängig von der Zeitzone des Geräts); Zeiten in Minuten ab Mitternacht
import { pad } from "../util.js";
const ZF = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
const zCache = new Map();
export function zh(ms) {
  const key = Math.floor(ms / 60000); let z = zCache.get(key);
  if (!z) {
    const p = {}; ZF.formatToParts(new Date(key * 60000)).forEach(x => p[x.type] = x.value);
    z = { wd: p.weekday, date: p.year + "-" + p.month + "-" + p.day, min: +p.hour * 60 + +p.minute };
    if (zCache.size > 5000) zCache.clear(); zCache.set(key, z);
  }
  return { wd: z.wd, date: z.date, t: z.min + (ms - key * 60000) / 60000 };
}
export const dayType = wd => wd === "Sat" ? "sa" : wd === "Sun" ? "su" : "wd";
export const DAYNAME = { wd: "Montag–Freitag", sa: "Samstag", su: "Sonntag" };
export function clock(ms) { const m = Math.floor(zh(ms).t); return pad(Math.floor(m / 60) % 24) + ":" + pad(m % 60); }
export function clockSec(ms) { const s = Math.floor(zh(ms).t * 60); return pad(Math.floor(s / 3600) % 24) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60); }
export const fmtDelay = s => { const m = Math.round(s / 60); return m >= 1 ? "+" + m + "′" : ""; };
