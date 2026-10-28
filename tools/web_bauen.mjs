// Baut die neue Website aus web/ (ES-Module) mit esbuild: app/public/karte.html + app/public/js/app.<hash>.js
// Aufruf: node tools/web_bauen.mjs   (vorher python3 tools/build.py für die Daten in app/public/daten/)
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "app", "public");
const r = await build({ entryPoints: [path.join(ROOT, "web", "src", "main.js")], bundle: true, minify: !process.env.ZK_LESBAR, format: "iife", target: "es2020", write: false, legalComments: "none" });
const js = r.outputFiles[0].contents, h = createHash("sha1").update(js).digest("hex").slice(0, 10);
fs.mkdirSync(path.join(OUT, "js"), { recursive: true });
for (const f of fs.readdirSync(path.join(OUT, "js"))) if (/^app\.[0-9a-f]+\.js$/.test(f) && f !== `app.${h}.js`) fs.unlinkSync(path.join(OUT, "js", f));
fs.writeFileSync(path.join(OUT, "js", `app.${h}.js`), js);
const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8").replace("__APP__", `js/app.${h}.js`);
fs.writeFileSync(path.join(OUT, "karte.html"), html);
console.log(`app/public/karte.html, app/public/js/app.${h}.js: ${(js.length / 1024).toFixed(0)} KB`);
