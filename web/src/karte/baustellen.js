// Baustellen auf Autobahnen: Verkehrsmeldungen des ASTRA (/api/baustellen, vom Server alle 10 Min.; nur die jetzt
// gültigen). Herausgezoomt eine orange Linie mit Punkt (Hinweis mit dem Meldungstext). Nah (ab Zoom 14) eine kleine
// Baustelle auf der Fahrbahn: Leitbaken zwischen den Fahrstreifen (am Anfang schräg eingeschwenkt), Signalanhänger mit
// Blinklichtern am Anfang, Baumaschinen auf dem gesperrten Streifen. Die Autos wechseln davor auf den offenen Streifen.
// Lage: die Meldung nennt TMC-Punkte (Anschlüsse, oft einige 100 m neben der Fahrbahn); auf die Fahrbahnen aus verkehr.js
// (Ketten je Richtung) wird gelegt, was ≤ 150 m von der Meldungslinie liegt und in der gemeldeten Richtung fährt.
import { K } from "./karte.js";
import { VK } from "./verkehr.js";
import { ladeThree, gemeinsamerZeichner, sonnenLicht } from "./drei.js";
import { VOR_3D } from "./tageszeit.js";
import { lichtAnmelden } from "./lichter.js";
import { ebene } from "../ui/ebenen.js";
import { fc, an, istHandy, bildIn } from "../util.js";

export const BST = { liste: [], an: true, zonen: 0, teile: 0 };
const mc = ll => maplibregl.MercatorCoordinate.fromLngLat(ll);
const Z_3D = 14, UMKREIS = 3500, ABSTAND = 150;
function hash(a, b) { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const kurz = s => String(s || "").replace(/\s+/g, " ").replace(/[^\u0000-ÿ]/g, "-").trim();

async function laden() {
  try { const r = await fetch("/api/baustellen"); if (!r.ok) return; const j = await r.json(); BST.liste = (j.b || []).filter(b => b.linie && b.linie.length); karteZeichnen(); zonen(); } catch (e) { }
}
function karteZeichnen() {
  const src = K.map && K.map.getSource("baustellen"); if (!src) return; const fs = [];
  if (BST.an) for (const b of BST.liste) {
    const n = kurz(b.text || ((b.strasse || "") + " " + (b.von || "") + " - " + (b.nach || ""))).slice(0, 220);
    if (b.linie.length > 1) fs.push({ type: "Feature", properties: { n }, geometry: { type: "LineString", coordinates: b.linie } });
    fs.push({ type: "Feature", properties: { n }, geometry: { type: "Point", coordinates: b.linie[b.linie.length >> 1] } });
  }
  src.setData(fc(fs));
}

// ---- Zonen auf den Fahrbahnketten: k.bz = [[s0, s1, Baustelle], …] ----
function zonen() {
  const c0 = K.map.getCenter(), kx = Math.cos(c0.lat * Math.PI / 180) * 111320, ky = 110574;
  const L = BST.an ? BST.liste.map(b => ({ b, p: b.linie.map(q => [(q[0] - c0.lng) * kx, (q[1] - c0.lat) * ky]) })) : [];
  let nz = 0;
  for (const k of VK.ketten) {
    k.bz = null; if (!L.length || k.rampe || !k.einweg) continue;
    const n = k.pts.length, drin = new Uint8Array(n), wer = new Array(n);
    for (const { b, p } of L) {
      for (let i = 0; i < n; i++) {
        const x = (k.pts[i][0] - c0.lng) * kx, y = (k.pts[i][1] - c0.lat) * ky, j = Math.min(n - 1, i + 1), h = Math.max(0, j - 1);
        const fx = (k.pts[j][0] - k.pts[h][0]) * kx, fy = (k.pts[j][1] - k.pts[h][1]) * ky, fl = Math.hypot(fx, fy) || 1;
        let bd = 1e9, bc = 0;
        if (p.length === 1) { bd = Math.hypot(x - p[0][0], y - p[0][1]) - 250; bc = 1; }
        else for (let s = 1; s < p.length; s++) {
          const ax = p[s - 1][0], ay = p[s - 1][1], ex = p[s][0] - ax, ey = p[s][1] - ay, l2 = ex * ex + ey * ey || 1e-9;
          let t = ((x - ax) * ex + (y - ay) * ey) / l2; const aussen = (t < 0 ? -t : t > 1 ? t - 1 : 0) * Math.sqrt(l2); t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(ax + ex * t - x, ay + ey * t - y) + aussen * 2;   // über die Enden hinaus nur knapp
          if (d < bd) { bd = d; bc = (ex * fx + ey * fy) / (Math.sqrt(l2) * fl); }
        }
        if (bd > ABSTAND) continue;
        if (b.richtung !== "both" && bc < .3) continue;   // Meldungslinie läuft in Fahrtrichtung
        if (b.richtung === "both" && Math.abs(bc) < .3) continue;
        drin[i] = 1; wer[i] = b;
      }
    }
    const z = []; for (let i = 0; i < n;) { if (!drin[i]) { i++; continue; } let j = i; while (j + 1 < n && drin[j + 1]) j++; const s0 = k.cum[i], s1 = k.cum[j]; if (s1 - s0 >= 40) z.push([s0, s1, wer[i]]); i = j + 1; }
    if (z.length) { k.bz = z; nz += z.length; }
  }
  BST.zonen = nz; BST.v = (BST.v || 0) + 1; K.map.triggerRepaint();
}
// Spur für die Autos: auf Einbahn-Ketten wechselt der linke Streifen (spur < 0) vor und in der Baustelle nach rechts
VK.spurBei = (k, s, spur) => {
  if (!k.bz || spur >= 0) return spur;
  for (const [s0, s1] of k.bz) { if (s > s1 + 20 || s < s0 - 250) continue; const u = s < s0 ? 1 - (s0 - s) / 250 : s > s1 ? 1 - (s - s1) / 20 : 1; return spur + (1.75 - spur) * Math.max(0, Math.min(1, u)); }
  return spur;
};

// ---- Modelle (eine Geometrie je Teil, Farbe je Ecke) ----
function teile(liste) {   // [[lx, ly, lz, x, y, z, farbe], …] (Mitte unten bei z)
  const pos = [], nor = [], col = [], C = new THREE.Color();
  for (const [lx, ly, lz, x, y, z, f] of liste) {
    const g = new THREE.BoxGeometry(lx, ly, lz).toNonIndexed(); g.translate(x, y, z + lz / 2); C.set(f);
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); for (let i = 0; i < g.attributes.position.count; i++) col.push(C.r, C.g, C.b);
  }
  const m = new THREE.BufferGeometry(); m.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); m.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); return m;
}
const ROT = "#d9480f", WEISS = "#f1f3f5", GELB = "#f2b705", SCHWARZ = "#1f2326", GRAU = "#6c737a";
function modelle() {
  return {
    // Leitbake: Fuss, rot-weiss gestreiftes Brett
    bake: teile([[.5, .5, .12, 0, 0, 0, SCHWARZ], [.08, .32, .2, 0, 0, .12, ROT], [.08, .32, .2, 0, 0, .32, WEISS], [.08, .32, .2, 0, 0, .52, ROT], [.08, .32, .2, 0, 0, .72, WEISS], [.08, .32, .2, 0, 0, .92, ROT]]),
    // Signalanhänger: gelber Anhänger mit schwarzer Tafel (Pfeil gelb), quer zur Fahrbahn
    anhaenger: teile([[3.2, 2, .9, 0, 0, .35, GELB], [.3, .3, .35, -1.2, .8, 0, SCHWARZ], [.3, .3, .35, -1.2, -.8, 0, SCHWARZ], [.15, 2.3, 2.1, -1.4, 0, 1.25, SCHWARZ],
      [.05, .25, 1.1, -1.49, .25, 1.75, GELB], [.05, .9, .22, -1.49, -.2, 2.55, GELB], [.05, .9, .22, -1.49, -.2, 1.65, GELB]]),   // Tafel hinten (gegen den Verkehr)
    // Lastwagen (Baustelle): Kabine gelb, Mulde grau
    lkw: teile([[2.2, 2.4, 2.6, 2.6, 0, .5, GELB], [5, 2.4, 1.4, -1.2, 0, .9, GRAU], [5.2, 2.2, .5, -1.1, 0, .4, SCHWARZ], [.9, .5, .9, 2.6, 0.9, 0, SCHWARZ], [.9, .5, .9, -2.6, .9, 0, SCHWARZ]]),
    // Bagger: Raupen, Oberwagen, Ausleger
    bagger: teile([[4, .7, .9, 0, 1.05, 0, SCHWARZ], [4, .7, .9, 0, -1.05, 0, SCHWARZ], [3.2, 2.5, 1.2, -.2, 0, .9, GELB], [1.3, 1.2, 1.4, .6, .55, 2.1, GELB], [3.6, .4, .45, 2.6, -.3, 2.4, GELB], [.5, .4, 2.2, 4.3, -.3, .4, GELB], [.7, 1, .6, 4.3, -.3, .1, GRAU]]),
    // Walze
    walze: teile([[1.2, 2.1, 1.2, 1.6, 0, 0, GRAU], [2.6, 1.8, 1.3, -.4, 0, .4, GELB], [1.2, 1.2, 1.1, -.6, 0, 1.7, GELB], [1.2, 2.1, 1.2, -2, 0, 0, GRAU]]),
    // Absperrgitter rot-weiss quer zur gesperrten Spur
    gitter: teile([[.1, 3, .25, 0, 0, .75, ROT], [.1, 3, .2, 0, 0, .45, WEISS], [.12, .12, 1, 0, 1.4, 0, GRAU], [.12, .12, 1, 0, -1.4, 0, GRAU]]),
    // Kegel
    kegel: teile([[.4, .4, .06, 0, 0, 0, SCHWARZ], [.28, .28, .25, 0, 0, .06, ROT], [.2, .2, .15, 0, 0, .31, WEISS], [.12, .12, .25, 0, 0, .46, ROT]]),
  };
}

// ---- Aufstellen: je Zone Baken, Anhänger, Maschinen (Lage relativ zum Anker in Metern, y nach Süden wie verkehr.js) ----
function aufstellen(map, anker, ms) {
  const L = { bake: [], anhaenger: [], lkw: [], bagger: [], walze: [], gitter: [], kegel: [], licht: [] }, c = mc(map.getCenter());
  for (const k of VK.ketten) {
    if (!k.bz) continue;
    for (const [s0, s1, b] of k.bz) {
      const id = String(b.id || "").split("").reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7);
      const punkt = (s, q) => {   // Lage auf der Kette bei s, q Meter seitlich (rechts +)
        let lo = 0, hi = k.cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k.cum[m] <= s) lo = m; else hi = m; }
        const u = (s - k.cum[lo]) / ((k.cum[hi] - k.cum[lo]) || 1), dx = (k.x[hi] - k.x[lo]) / ms, dy = (k.y[hi] - k.y[lo]) / ms, l = Math.hypot(dx, dy) || 1;
        const x = (k.x[lo] + (k.x[hi] - k.x[lo]) * u - anker.x) / ms - dy / l * q, y = (k.y[lo] + (k.y[hi] - k.y[lo]) * u - anker.y) / ms + dx / l * q;
        return { x, y, z: k.z[lo] + (k.z[hi] - k.z[lo]) * u, w: Math.atan2(dy, dx), tun: k.tun[lo] && k.tun[hi], mx: k.x[lo], my: k.y[lo] };
      };
      // nur nahe der Bildmitte
      const m0 = punkt((s0 + s1) / 2, 0); if (Math.hypot(m0.mx - c.x, m0.my - c.y) / ms > UMKREIS + (s1 - s0) / 2) continue;
      const ein = Math.min(80, (s1 - s0) * .3);   // Verschwenkung: Baken von links aussen (−3.6) zur Mitte (0)
      for (let s = s0, i = 0; s <= s1; s += s - s0 < ein ? 6 : 12, i++) {
        const q = s - s0 < ein ? -3.6 + 3.6 * (s - s0) / ein : 0, p = punkt(s, q); if (p.tun) continue;
        L.bake.push(p); if (s - s0 < ein && i % 2 === 0) L.licht.push({ ...p, z: p.z + 1.25, blink: i * .07 });
      }
      const a = punkt(s0 - 40, -1.75); if (!a.tun) { L.anhaenger.push(a); L.licht.push({ ...a, z: a.z + 2.9, blink: 0, gross: 1 }); }
      const g = punkt(s0 + ein + 6, -1.75); if (!g.tun) L.gitter.push(g);
      // Maschinen auf dem gesperrten Streifen: etwa alle 180 m eine Gruppe, fester Zufall aus Meldung und Lage
      for (let s = s0 + ein + 40, j = 0; s < s1 - 20; s += 140 + 120 * hash(id, j), j++) {
        const h = hash(id, j + 99), p = punkt(s, -1.9); if (p.tun) continue;
        (h < .4 ? L.lkw : h < .75 ? L.bagger : L.walze).push(p);
        for (let t = 0; t < 3; t++) { const kp = punkt(s - 8 - t * 2.5, -.6); if (!kp.tun) L.kegel.push(kp); }
      }
      const e = punkt(s1, -1.75); if (!e.tun) L.gitter.push(e);
    }
  }
  return L;
}

function ebene3d() {
  let M = null, IM = {}, licht = null, lichtSzene = null, lichtM = null, gebaut = -1, anker = null, ms = 1, ankerZoom = 0, lichtN = 0;
  return {
    id: "baustellen3d", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      this.cam = new THREE.Camera(); this.szene = new THREE.Scene(); this.szene.add(new THREE.HemisphereLight(0xffffff, 0x7d8a96, 1.8)); this.szene.add(sonnenLicht(1.3));
      this.r = gemeinsamerZeichner(m, gl); M = modelle(); const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      for (const [n, g] of Object.entries(M)) { const N = n === "bake" ? 4000 : n === "kegel" ? 1500 : 400; IM[n] = new THREE.InstancedMesh(g, mat, N); IM[n].count = 0; IM[n].frustumCulled = false; this.szene.add(IM[n]); }
      // Warnlichter (gelb, blinkend): Tag und Nacht sichtbar, nachts nach der Abdunkelung hell
      this.lp = new Float32Array(3000 * 3); this.lb = new Float32Array(3000); this.lg = new THREE.BufferGeometry();
      this.lg.setAttribute("position", new THREE.BufferAttribute(this.lp, 3)); this.lg.setAttribute("blink", new THREE.BufferAttribute(this.lb, 1));
      this.lmat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uT: { value: 0 }, uGr: { value: 6 }, uA: { value: 1 } },
        vertexShader: "attribute float blink; varying float vB; uniform float uT; uniform float uGr; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; float f = fract(uT - blink); vB = f < 0.35 ? 1.0 : 0.0; gl_PointSize = uGr; }",
        fragmentShader: "uniform float uA; varying float vB; void main(){ if (vB < 0.5) discard; vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.1, length(d)); gl_FragColor = vec4(vec3(1.0, 0.78, 0.15) * a * uA, a * uA); }" });
      licht = new THREE.Points(this.lg, this.lmat); licht.frustumCulled = false; this.szene.add(licht);
      lichtSzene = new THREE.Scene(); const licht2 = new THREE.Points(this.lg, this.lmat); licht2.frustumCulled = false; lichtSzene.add(licht2); lichtM = new THREE.Matrix4();
      lichtAnmelden({ aktiv: () => lichtN > 0, szene: lichtSzene, matrix: lichtM });
      this.O = new THREE.Object3D();
    },
    render(gl, args) {
      const map = K.map, z = map.getZoom();
      if (!BST.an || z < Z_3D || !BST.zonen) { for (const x of Object.values(IM)) x.count = 0; lichtN = 0; return; }
      const c = mc(map.getCenter());
      // neu aufstellen, wenn Zonen neu sind oder die Mitte weit weg ist
      if (gebaut !== BST.v || !anker || Math.hypot(c.x - anker.x, c.y - anker.y) / ms > 1500 || Math.abs(z - ankerZoom) > 2) {
        gebaut = BST.v; anker = c; ms = c.meterInMercatorCoordinateUnits(); ankerZoom = z;
        const L = aufstellen(map, anker, ms); let nt = 0;
        for (const [n, liste] of Object.entries(L)) {
          if (n === "licht") continue; const im = IM[n], N = Math.min(liste.length, im.instanceMatrix.count);
          for (let i = 0; i < N; i++) { const p = liste[i]; this.O.position.set(p.x, p.y, p.z); this.O.rotation.set(0, 0, p.w); this.O.updateMatrix(); im.setMatrixAt(i, this.O.matrix); }
          im.count = N; im.instanceMatrix.needsUpdate = true; nt += N;
        }
        const Lz = L.licht.slice(0, 3000); lichtN = Lz.length; Lz.forEach((p, i) => { this.lp[i * 3] = p.x; this.lp[i * 3 + 1] = p.y; this.lp[i * 3 + 2] = p.z; this.lb[i] = p.blink; });
        this.lg.setDrawRange(0, lichtN); this.lg.attributes.position.needsUpdate = true; this.lg.attributes.blink.needsUpdate = true; BST.teile = nt;
      }
      const t = performance.now() / 1000; this.lmat.uniforms.uT.value = t * 1.1; this.lmat.uniforms.uGr.value = (istHandy() ? 5 : 7) * Math.min(2, devicePixelRatio || 1) * Math.max(.5, Math.min(1.6, (z - 13) / 2));
      const mm = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix), lm = new THREE.Matrix4().makeTranslation(anker.x, anker.y, 0).scale(new THREE.Vector3(ms, ms, ms));
      lichtM.copy(lm);
      this.cam.projectionMatrix = mm.multiply(lm); this.r.resetState(); this.r.render(this.szene, this.cam);
      if (lichtN) bildIn(map, 120);   // Blinken
    },
  };
}

export function baustellenStarten() {
  const map = K.map;
  map.addSource("baustellen", { type: "geojson", data: fc([]) });
  map.addLayer({ id: "baustellen-linie", type: "line", source: "baustellen", filter: ["==", ["geometry-type"], "LineString"], minzoom: 7, layout: { "line-cap": "round" },
    paint: { "line-color": "#f08c00", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 2.5, 12, 5], "line-dasharray": [1.2, 1], "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, .9, 13.5, .9, 15, 0] } });
  map.addLayer({ id: "baustellen-pkt", type: "circle", source: "baustellen", filter: ["==", ["geometry-type"], "Point"], minzoom: 7, maxzoom: 15,
    paint: { "circle-color": "#f08c00", "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 4, 12, 7], "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5, "circle-pitch-alignment": "viewport" } });
  ladeThree().then(() => { try { map.addLayer(ebene3d(), VOR_3D()); } catch (e) { console.error(e); } });
  an("verkehrKetten", zonen);
  ebene({ id: "baustellen", name: "Baustellen (Autobahn)", an: true, setze: v => { BST.an = v; for (const id of ["baustellen-linie", "baustellen-pkt"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v ? "visible" : "none"); karteZeichnen(); if (VK.ketten) zonen(); } });
  laden(); setInterval(laden, 5 * 60e3);
  BST.test = l => { BST.liste = l; karteZeichnen(); zonen(); };   // für Tests
  window.__bst = BST;
}
