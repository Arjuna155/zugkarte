// Lebendiger Boden: eine Rasterebene «ls-boden» aus Kacheln, die die Seite selbst erzeugt (Protokoll boden://).
// - Felder und Wiesen: Parzellen (Voronoi-Zellen, je Gegend in eine Richtung gestreckt) in Wiesen- und Ackertönen
//   nach Jahreszeit, mit dunklen Rainen dazwischen. Nur im flachen Land (Neigung < ~12°) und unter ~1250 m – Höhe und
//   Neigung aus dem Geländemodell (Mapterhorn z10, dieselbe Quelle wie das Gelände).
// - Flecken: helle und dunkle Stellen in zwei Grössen (~350 m, ~60 m), überall (auch Alpweiden).
// Die Ebene liegt unter Wald, Siedlung, Wasser und Strassen; alles ist fest an den Ort gebunden (Zufall aus der Lage).
// Alles Rechnen läuft in einem Web Worker (eigener Faden), sonst ruckelt die Karte beim Laden der Kacheln.
// Der Worker entsteht aus dem Quelltext dieser Funktion (Blob) – sie darf deshalb nichts von aussen benutzen.
function werk() {
  const DEM_URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";   // wie landschaft.js

  const N = 128;                                   // Pixel je Kachel (als 256er-Kachel ausgeliefert, weich vergrössert)
  const ERDE = 40075016.7;
  const hash = (x, y) => { let h = (x | 0) * 374761393 + (y | 0) * 668265263; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const glatt = t => t * t * (3 - 2 * t);
  function rausch(x, y) {   // Wertrauschen 0–1
    const ix = Math.floor(x), iy = Math.floor(y), u = glatt(x - ix), v = glatt(y - iy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  // Farben nach Jahreszeit: Wiesen (häufiger) und Äcker
  function palette() {
    const m = new Date().getMonth() + 1;
    const wiese = [[150, 186, 104], [163, 192, 116], [141, 174, 96], [172, 196, 122]];
    const acker = m >= 3 && m <= 5 ? [[132, 166, 84], [196, 196, 84], [146, 124, 92], [118, 158, 80]]
      : m >= 6 && m <= 8 ? [[210, 188, 110], [196, 178, 120], [110, 150, 72], [222, 204, 140]]
      : m >= 9 && m <= 11 ? [[146, 122, 90], [160, 136, 102], [130, 166, 90], [176, 160, 116]]
      : [[150, 140, 112], [138, 126, 100], [142, 160, 112], [128, 150, 104]];
    return { wiese, acker };
  }

  // Geländemodell z10 (512 px, ~76 m je Pixel) zwischengespeichert
  const dem = new Map();
  function demKachel(x, y) {
    const k = x + "/" + y; if (dem.has(k)) return dem.get(k);
    const p = fetch(DEM_URL.replace("{z}", 10).replace("{x}", x).replace("{y}", y)).then(r => r.ok ? r.blob() : null).then(b => b ? createImageBitmap(b) : null).then(bm => {
      if (!bm) return null; const c = new OffscreenCanvas(bm.width, bm.height), g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bm, 0, 0);
      const d = g.getImageData(0, 0, bm.width, bm.height).data, n = bm.width, e = new Float32Array(n * n);
      for (let i = 0; i < n * n; i++) e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
      return { e, n };
    }).catch(() => null);
    dem.set(k, p); if (dem.size > 40) dem.delete(dem.keys().next().value);
    return p;
  }
  // Höhe an einer Weltstelle (0–1) aus den geladenen z10-Kacheln
  function hoeheBei(D, X, Y) {
    const tx = Math.floor(X * 1024), ty = Math.floor(Y * 1024), t = D.get(tx + "/" + ty); if (!t) return null;
    const n = t.n, fx = (X * 1024 - tx) * n - .5, fy = (Y * 1024 - ty) * n - .5, ix = Math.max(0, Math.min(n - 2, Math.floor(fx))), iy = Math.max(0, Math.min(n - 2, Math.floor(fy)));
    const u = Math.min(1, Math.max(0, fx - ix)), v = Math.min(1, Math.max(0, fy - iy)), e = t.e, i = iy * n + ix;
    return e[i] * (1 - u) * (1 - v) + e[i + 1] * u * (1 - v) + e[i + n] * (1 - u) * v + e[i + n + 1] * u * v;
  }

  async function kachel(z, x, y) {
    const Z = 2 ** z, X0 = x / Z, Y0 = y / Z, st = 1 / (Z * N);
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (Y0 + .5 / Z)))), M = ERDE * Math.cos(lat);   // Meter je Welteinheit
    // Geländemodell: alle z10-Kacheln, die diese Kachel berührt (meist eine)
    const D = new Map();
    for (const [a, b] of [[X0, Y0], [X0 + 1 / Z, Y0], [X0, Y0 + 1 / Z], [X0 + 1 / Z, Y0 + 1 / Z]]) {
      const tx = Math.min(1023, Math.floor(a * 1024)), ty = Math.min(1023, Math.floor(b * 1024)), k = tx + "/" + ty;
      if (!D.has(k)) D.set(k, await demKachel(tx, ty));
    }
    // Höhe und Neigung auf einem groben Gitter (17 × 17), dazwischen linear
    const G = 16, mask = new Float32Array((G + 1) * (G + 1)), dS = 60 / M;   // Neigung über ± 60 m
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
      const X = X0 + i / G / Z, Y = Y0 + j / G / Z, e = hoeheBei(D, X, Y);
      if (e == null) { mask[j * (G + 1) + i] = .5; continue; }
      const ex = (hoeheBei(D, X + dS, Y) ?? e) - (hoeheBei(D, X - dS, Y) ?? e), ey = (hoeheBei(D, X, Y + dS) ?? e) - (hoeheBei(D, X, Y - dS) ?? e);
      const neig = Math.hypot(ex, ey) / 120, hoch = Math.min(1, Math.max(0, (1250 - e) / 300)), flach = Math.min(1, Math.max(0, (.22 - neig) / .1));
      mask[j * (G + 1) + i] = e < 250 ? 0 : hoch * flach;   // unter 250 m: Seen (Genfersee, Lago Maggiore) – Wasser liegt ohnehin darüber
    }
    const { wiese, acker } = palette(), bild = new ImageData(N, N), P = bild.data, ZELLE = 120;
    const feldStaerke = Math.min(1, Math.max(0, (z - 11.5) / 1.5));
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const mx = (X0 + (i + .5) * st) * M, my = (Y0 + (j + .5) * st) * M;
      let r = 0, g = 0, b = 0, a = 0;
      const over = (cr, cg, cb, ca) => { const na = ca + a * (1 - ca); if (na <= 0) return; r = (cr * ca + r * a * (1 - ca)) / na; g = (cg * ca + g * a * (1 - ca)) / na; b = (cb * ca + b * a * (1 - ca)) / na; a = na; };
      // Parzellen
      const gx = i / N * G, gy = j / N * G, ix = Math.min(G - 1, gx | 0), iy = Math.min(G - 1, gy | 0), u = gx - ix, v = gy - iy, k = iy * (G + 1) + ix;
      const ms = (mask[k] * (1 - u) * (1 - v) + mask[k + 1] * u * (1 - v) + mask[k + G + 1] * (1 - u) * v + mask[k + G + 2] * u * v) * feldStaerke;
      if (ms > .01) {
        // Gegend (unregelmässige Zellen ~3 km) mit eigener Richtung; gedreht wird um den Mittelpunkt der Gegend
        const RG = 3000, rx = mx / RG, ry = my / RG, rcx = Math.floor(rx), rcy = Math.floor(ry); let rd = 9, rpx = 0, rpy = 0, rw = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { const zx = rcx + ox, zy = rcy + oy, px = zx + hash(zx * 3 + 1, zy * 7 + 2), py = zy + hash(zx * 11 + 4, zy * 5 + 9), d = (px - rx) ** 2 + (py - ry) ** 2; if (d < rd) { rd = d; rpx = px; rpy = py; rw = hash(zx + 77, zy - 31); } }
        const w = rw * 3.1416, cw = Math.cos(w), sw = Math.sin(w), lx = mx - rpx * RG, ly = my - rpy * RG;
        const qx = (lx * cw + ly * sw) / ZELLE * .55 + rw * 1000, qy = (-lx * sw + ly * cw) / ZELLE * 1.3;   // gestreckt: lange, schmale Parzellen
        const cx = Math.floor(qx), cy = Math.floor(qy); let d1 = 9, d2 = 9, h1 = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const zx = cx + ox, zy = cy + oy, px = zx + .15 + .7 * hash(zx, zy * 7 + 3), py = zy + .15 + .7 * hash(zx * 5 + 1, zy), d = (px - qx) ** 2 + (py - qy) ** 2;
          if (d < d1) { d2 = d1; d1 = d; h1 = hash(zx * 13 + 7, zy * 11 + 5); } else if (d < d2) d2 = d;
        }
        const f = h1 < .58 ? wiese[Math.floor(h1 / .58 * 4) % 4] : acker[Math.floor((h1 - .58) / .42 * 4) % 4];
        over(f[0], f[1], f[2], ms * (h1 < .58 ? .32 : .5));
        const rain = (Math.sqrt(d2) - Math.sqrt(d1)) * ZELLE;   // Abstand zur Parzellengrenze (ungefähr in m)
        if (rain < 3) over(92, 116, 66, ms * .28 * (1 - rain / 3));
      }
      // Flecken (hell/dunkel) überall
      const n = rausch(mx / 350, my / 350) * .6 + rausch(mx / 60 + 17, my / 60) * .4 - .5;
      if (n > 0) over(250, 246, 205, .2 * n); else over(38, 58, 28, .26 * -n);
      const o = (j * N + i) * 4; P[o] = r; P[o + 1] = g; P[o + 2] = b; P[o + 3] = a * 255;
    }
    const c = new OffscreenCanvas(N, N); c.getContext("2d").putImageData(bild, 0, 0);
    return await (await c.convertToBlob({ type: "image/png" })).arrayBuffer();
  }
  self.onmessage = async e => { const { id, z, x, y } = e.data; try { const buf = await kachel(z, x, y); self.postMessage({ id, buf }, [buf]); } catch (err) { self.postMessage({ id, fehler: String(err) }); } };
}

let worker = [], warten = new Map(), nr = 0, rr = 0;
const kachel = (z, x, y) => new Promise((ok, nein) => { const id = ++nr; warten.set(id, { ok, nein }); worker[rr++ % worker.length].postMessage({ id, z, x, y }); });
export const BODEN = { an: false, kachel };
export function bodenProtokoll() {
  if (BODEN.an || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined" || typeof Worker === "undefined") return BODEN.an;
  try {
    const url = URL.createObjectURL(new Blob(["(" + werk.toString() + ")()"], { type: "text/javascript" }));
    for (let i = 0; i < ((navigator.hardwareConcurrency || 2) >= 6 ? 2 : 1); i++) { const w = new Worker(url); w.onmessage = e => { const { id, buf, fehler } = e.data, p = warten.get(id); if (!p) return; warten.delete(id); fehler ? p.nein(new Error(fehler)) : p.ok(buf); }; worker.push(w); }
  } catch (e) { console.error(e); return false; }
  BODEN.an = true;
  window.__boden = BODEN;
  maplibregl.addProtocol("boden", async p => { const m = /boden:\/\/(\d+)\/(\d+)\/(\d+)/.exec(p.url); return { data: await kachel(+m[1], +m[2], +m[3]) }; });
  return true;
}
export const BODEN_QUELLE = { type: "raster", tiles: ["boden://{z}/{x}/{y}"], tileSize: 256, minzoom: 11, maxzoom: 16, bounds: [5.8, 45.7, 10.6, 47.9] };
