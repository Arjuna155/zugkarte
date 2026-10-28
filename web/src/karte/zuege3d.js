// 3D-Züge: jeder Wagen folgt dem Gleis (three.js als eigene Ebene in MapLibre, three.js wird erst bei Bedarf geladen).
// Vorschau: nur mit ?zuege3d in der Adresse (bleibt gespeichert, ?zuege3d=aus schaltet ab)
import { legs } from "../kern/wege.js";
import { wagenVon, wagenJetzt } from "../kern/formation.js";
import { ZM } from "./modelle.js";
import { K } from "./karte.js";
import { wgs } from "../util.js";
import { ladeThree, szeneMitLicht } from "./drei.js";
import { ebene } from "../ui/ebenen.js";

// Ein-/ausschalten über die Ebenen in der Seitenleiste (alte Adresse ?zuege3d=aus schaltet weiterhin ab)
export let Z3D = 13.2;
try { if (new URLSearchParams(location.search).get("zuege3d") === "aus") localStorage.setItem("zk_ebenen", JSON.stringify({ ...JSON.parse(localStorage.getItem("zk_ebenen") || "{}"), zuege3d: false })); } catch (e) { }
export function zuege3dSchalter() { ebene({ id: "zuege3d", name: "Züge in 3D (beim Hineinzoomen)", an: true, setze: an => { Z3D = an ? 13.2 : 99; if (!an) { Z3.liste = []; K.map && K.map.triggerRepaint(); } } }); }
export const Z3 = { laden: false, bereit: false, liste: [], ursprung: null, ms: 1, hBudget: 0, wagenBei: () => null };

// Laufweg eines Zuges als Linienzüge mit Längen (Kartenkoordinaten). An Kopfbahnhöfen (Zug wendet, z. B. Zürich HB,
// Luzern) beginnt ein neuer Abschnitt – so steht der Zug am Bahnsteig, statt sich um den Bahnhof zu knicken.
function pfad(tr) {
  if (tr._pf !== undefined) return tr._pf; const LG = legs(tr); if (!LG.length || LG.some(x => !x)) return tr._pf = null;
  const teile = [], legSec = [], legS0 = [], legS1 = []; let T = null;
  const richtung = (pts, vonEnde) => {
    const n = pts.length; let A = vonEnde ? pts[n - 1] : pts[0], Bq = A, acc = 0;
    for (let q = 1; q < n && acc < 2; q++) { const P = vonEnde ? pts[n - 1 - q] : pts[q]; acc += Math.hypot(P[0] - Bq[0], P[1] - Bq[1]); Bq = P; }
    const d = Math.hypot(Bq[0] - A[0], Bq[1] - A[1]) || 1; return vonEnde ? [(A[0] - Bq[0]) / d, (A[1] - Bq[1]) / d] : [(Bq[0] - A[0]) / d, (Bq[1] - A[1]) / d];
  };
  LG.forEach(P => {
    if (T && T.pts.length > 1) { const a = richtung(T.pts, true), b = richtung(P.pts, false); if (a[0] * b[0] + a[1] * b[1] < -.35) T = null; }   // Wende
    if (!T) { T = { pts: [], cum: [], h: {} }; teile.push(T); }
    legSec.push(teile.length - 1); legS0.push(T.cum.length ? T.cum[T.cum.length - 1] : 0);
    for (const p of P.pts) { if (T.pts.length) { const q = T.pts[T.pts.length - 1], d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < 1e-4) continue; T.cum.push(T.cum[T.cum.length - 1] + d); } else T.cum.push(0); T.pts.push(p); }
    legS1.push(T.cum[T.cum.length - 1]);
  });
  if (teile.some(t => t.pts.length < 2)) return tr._pf = null; return tr._pf = { teile, legSec, legS0, legS1 };
}
function punkt(pf, s) {
  const c = pf.cum, n = c.length, E = c[n - 1];
  // ausserhalb des Laufwegs (Zug steht am Anfangs-/Endbahnhof): gerade weiter in der Richtung der letzten 100 m
  if (s < 0 || s > E) { const a = s < 0 ? 0 : E, b = s < 0 ? Math.min(E, 1) : Math.max(0, E - 1), A = punkt(pf, a), Bq = punkt(pf, b), d = Math.hypot(A[0] - Bq[0], A[1] - Bq[1]) || 1, k = (s < 0 ? -s : s - E) / d; return [A[0] + (A[0] - Bq[0]) * k, A[1] + (A[1] - Bq[1]) * k]; }
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
  const u = (s - c[lo]) / ((c[hi] - c[lo]) || 1), A = pf.pts[lo], Bq = pf.pts[hi]; return [A[0] + (Bq[0] - A[0]) * u, A[1] + (Bq[1] - A[1]) * u];
}
// Höhe des Gleises aus dem Gelände. Brücken (Senken bis 800 m) gerade überspannt, Tunnels gerade unterfahren, sonst auf dem
// Gelände. Abschnittsweise je 4 km, beim Hineinzoomen genauer neu berechnet.
const H_SCHRITT = .25, H_STUECK = 160, H_RAND = 40;
function hoehe(pf, s, steil) {
  const map = K.map, T = map.getTerrain(), ex = T ? T.exaggeration || 1 : 0; if (!ex) return 0;
  const k = Math.floor(s / (H_SCHRITT * H_STUECK)), zs = Math.min(14, Math.floor(map.getZoom())); let h = pf.h[k];
  if ((!h || h.z < zs || h.ex !== ex) && Z3.hBudget > 0) { Z3.hBudget--; const neu = gleisHoehe(pf, k, steil, ex); if (neu) { neu.z = zs; neu.ex = ex; pf.h[k] = h = neu; } }
  if (!h) return null;
  const f = (s - h.s0) / H_SCHRITT, i = Math.max(0, Math.min(h.length - 2, Math.floor(f))), u = f - i; return h[i] * (1 - u) + h[i + 1] * u;
}
function gleisHoehe(pf, k, steil, ex) {
  const map = K.map, n = H_STUECK + 2 * H_RAND + 1, s0 = (k * H_STUECK - H_RAND) * H_SCHRITT, dem = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = punkt(pf, s0 + i * H_SCHRITT), e = map.queryTerrainElevation(wgs(p[0], p[1])); if (e === null || e === undefined) return null; dem[i] = e; }
  const g = (steil ? .25 : .05) * ex * H_SCHRITT * 100, v = new Float32Array(n), r = new Float32Array(n), h = new Float32Array(n);
  v[0] = dem[0]; for (let i = 1; i < n; i++)v[i] = Math.min(Math.max(dem[i], v[i - 1] - g), v[i - 1] + g);
  r[n - 1] = dem[n - 1]; for (let i = n - 2; i >= 0; i--)r[i] = Math.min(Math.max(dem[i], r[i + 1] - g), r[i + 1] + g);
  const lage = new Int8Array(n); for (let i = 0; i < n; i++) { const d = dem[i]; lage[i] = v[i] > d + 1.5 && r[i] > d + 1.5 ? 1 : v[i] < d - 1.5 && r[i] < d - 1.5 ? -1 : 0; h[i] = d; }
  for (let i = 0; i < n;) {
    if (!lage[i]) { i++; continue; } const L = lage[i]; let j = i; while (j + 1 < n && lage[j + 1] === L) j++;
    const a = i > 0 ? dem[i - 1] : (v[i] + r[i]) / 2, b = j < n - 1 ? dem[j + 1] : (v[j] + r[j]) / 2, m = j - i + 2;
    if (L < 0 || (j - i + 1) * H_SCHRITT <= 8) for (let q = i; q <= j; q++) { const lin = a + (b - a) * (q - i + 1) / m; h[q] = L > 0 ? Math.max(lin, dem[q]) : Math.min(lin, dem[q]); }
    i = j + 1;
  }
  h.s0 = s0; return h;
}
// Unternehmen mit Normalspur (sonst: Schmal-/Zahnradbahn, steilere Strecken erlaubt)
const NORMALSPUR = new Set(["11", "33", "65", "82", "78", "351", "81____", "87_LEX", "06____", "800693", "L7____", "817000"]);

export function z3Laden() {
  if (Z3.laden) return; Z3.laden = true;
  ladeThree().then(() => { try { K.map.addLayer(z3Ebene(), "fz"); Z3.bereit = true; } catch (e) { console.error(e); } });
}
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
export function z3Beginn() { Z3.liste = []; Z3.ursprung = mc(K.map.getCenter()); Z3.ms = Z3.ursprung.meterInMercatorCoordinateUnits(); if (Z3.hBudget < 3) Z3.hBudget = 3; }
export function z3Ende() { }
// Wagen eines Zuges: Lage, Richtung und Neigung jedes Wagens
export function z3Zug(tr, o, p, isSel) {
  const PF = pfad(tr); if (!PF || p.j === undefined) return false; const Z = wagenJetzt(wagenVon(tr, o), p);
  // fahrend: auf dem Abschnitt j→j+1; stehend: Zugmitte am Bahnsteig (Abschnitt der Weiterfahrt, am Ziel der Ankunft)
  const nL = PF.legSec.length, j = p.moving ? p.j : Math.min(p.j, nL - 1), amEnde = !p.moving && p.j >= nL;
  const pf = PF.teile[PF.legSec[j]], kopf = (amEnde ? PF.legS1[j] : PF.legS0[j] + (PF.legS1[j] - PF.legS0[j]) * (p.moving ? p.f : 0)) + Z.L / 2;
  const os = Z3.ursprung, ms = Z3.ms, aus = [];
  for (const t of Z.teile) {
    const sc = kopf - t.s, h = t.L * .42, pv = punkt(pf, sc + h), ph = punkt(pf, sc - h), pm = punkt(pf, sc);
    const steil = t.W.T.spur < 1.2 || !NORMALSPUR.has(tr.ag), zv = hoehe(pf, sc + h, steil), zh_ = hoehe(pf, sc - h, steil); if (zv === null || zh_ === null) return false;
    const llm = wgs(pm[0], pm[1]), mv = mc(wgs(pv[0], pv[1])), mh = mc(wgs(ph[0], ph[1])), mm = mc(llm);
    const dx = (mv.x - mh.x) / ms, dy = (mv.y - mh.y) / ms, len = Math.hypot(dx, dy) || 1;
    aus.push({ g: ZM.schluessel(t.W), geo: ZM.bauWagen(t.W), x: (mm.x - os.x) / ms, y: (mm.y - os.y) / ms, z: (zv + zh_) / 2, dreh: Math.atan2(dy, dx), neig: Math.atan2(zv - zh_, len), sel: isSel, ll: llm, tr, o });
  }
  for (const c of aus) Z3.liste.push(c); return true;
}
// Klick auf einen Wagen
Z3.wagenBei = pt => { let best = null, bd = 30 * 30; for (const c of Z3.liste) { const q = K.map.project(c.ll), d = (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2; if (d < bd) { bd = d; best = c; } } return best; };

function z3Ebene() {
  return {
    id: "zuege3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = szeneMitLicht();
      this.r = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true }); this.r.autoClear = false; this.r.outputColorSpace = THREE.SRGBColorSpace;
      this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }); this.netze = new Map();
      this.M = new THREE.Matrix4(); this.Q = new THREE.Quaternion(); this.E = new THREE.Euler(0, 0, 0, "ZYX"); this.V = new THREE.Vector3(); this.S = new THREE.Vector3(1, 1, 1);
      this.weiss = new THREE.Color(1, 1, 1); this.gelb = new THREE.Color(1, .82, .35);
    },
    render(gl, args) {
      const L = Z3.liste, o = Z3.ursprung; if (!o) return;
      const zahl = new Map(); for (const c of L) zahl.set(c.g, (zahl.get(c.g) || 0) + 1);
      for (const [g, n] of this.netze) if (!zahl.has(g)) n.count = 0;
      const idx = new Map();
      for (const c of L) {
        let n = this.netze.get(c.g); const bedarf = zahl.get(c.g);
        if (!n || n.instanceMatrix.count < bedarf) {
          if (n) { this.szene.remove(n); n.dispose(); }
          n = new THREE.InstancedMesh(c.geo, this.mat, Math.max(8, bedarf * 2)); n.frustumCulled = false;
          n.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n.instanceMatrix.count * 3).fill(1), 3); this.netze.set(c.g, n); this.szene.add(n);
        }
        const i = idx.get(c.g) || 0; idx.set(c.g, i + 1); this.E.set(0, -c.neig, c.dreh); this.Q.setFromEuler(this.E); this.V.set(c.x, c.y, c.z); this.M.compose(this.V, this.Q, this.S);
        n.setMatrixAt(i, this.M); n.setColorAt(i, c.sel ? this.gelb : this.weiss);
      }
      for (const [g, n] of this.netze) if (zahl.has(g)) { n.count = zahl.get(g); n.instanceMatrix.needsUpdate = true; n.instanceColor.needsUpdate = true; }
      const s = o.meterInMercatorCoordinateUnits();
      const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), l = new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).scale(new THREE.Vector3(s, s, s));   // lokal: x Ost, y Süd, z hoch (Meter)
      this.cam.projectionMatrix = m.multiply(l); this.r.resetState(); this.r.render(this.szene, this.cam);
    }
  };
}
