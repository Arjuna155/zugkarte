// ===== 3D-Züge: echte Zusammensetzung (Formation-Dienst), jeder Wagen folgt dem Gleis =====
// Ab Zoom Z3D werden Fernverkehr, Regio und S-Bahn als 3D-Modelle gezeichnet (three.js, eigene Ebene in MapLibre).
// Zusammensetzung: /api/formation (Server lädt sie im Hintergrund), sonst typischer Zug der Linie (ZM.rueckfall).
// Vorschau: nur mit ?zuege3d in der Adresse (bleibt gespeichert, ?zuege3d=aus schaltet ab)
const Z3D_AN=(()=>{try{const q=new URLSearchParams(location.search).get("zuege3d");if(q!==null)localStorage.setItem("zk_zuege3d",q==="aus"?"aus":"an");return localStorage.getItem("zk_zuege3d")==="an"}catch(e){return /zuege3d/.test(location.search)}})();
const Z3D=Z3D_AN?13.2:99;
const FO={};   // Datum → {evu, f, z, t, v}
async function foLaden(d){const o=FO[d];if(!fpAn||(o&&(o.lauf||Date.now()-o.t<5*60000)))return;
  if(o)o.lauf=true;else FO[d]={lauf:true,t:0,v:0,f:[],z:{},evu:{}};
  try{const r=await fetch("/api/formation?d="+d);if(!r.ok)throw 0;const j=await r.json();FO[d]={evu:j.evu||{},f:j.f||[],z:j.z||{},t:Date.now(),v:(o?o.v:0)+1}}
  catch(e){FO[d]=Object.assign(FO[d]||{},{lauf:false,t:Date.now()})}}
function foWunsch(tr,o){const d=zh(simMs-(o?86400000:0)).date,F=FO[d];if(!fpAn||!F||!F.evu||!F.evu[tr.ag]||!tr.zn)return;
  const k=F.evu[tr.ag]+":"+tr.zn;if(F.z[k]&&F.z[k][1])return;fetch("/api/formation?d="+d+"&w="+encodeURIComponent(k)).catch(()=>{})}
// Wagenliste eines Zuges (zwischengespeichert, bis neue Formationsdaten kommen). Wagen, die nur einen Teil des Laufs
// mitfahren (Flügelzüge, Verstärkung), haben von/bis-Halte: kv/kb = Index im Lauf (−1 bzw. 1e9 = ganzer Lauf).
function wagenVon(tr,o){const d=zh(simMs-(o?86400000:0)).date;foLaden(d);const F=FO[d],ver=F?F.v:0;
  if(tr._wg&&tr._wgv===ver)return tr._wg;
  let w=null,echt=-1;const key=F&&F.evu&&F.evu[tr.ag]&&tr.zn?F.evu[tr.ag]+":"+tr.zn:null;
  if(key&&F.z[key]){const [i,e]=F.z[key];w=ZM.ausFormation(F.f[i]);echt=e}
  if(!w||!w.length){w=ZM.rueckfall(tr.cat,tr.num,tr.ag);echt=-1}
  const halt=u=>{const si=UIC2IDX[u];if(si===undefined)return -2;return tr.st.findIndex(S=>S.i===si)};
  for(const v of w){const a=v.von?halt(v.von):-1,b=v.bis?halt(v.bis):-1;v.kv=a>=0?a:-1;v.kb=b>=0?b:1e9}
  tr._wg={w,echt,sub:{}};tr._wgv=ver;return tr._wg}
// Wagen, die auf dem aktuellen Abschnitt mitfahren (stehend: alle, die an diesem Halt im Zug sind) → Bauteile mit Lage im Zug
function wagenJetzt(Z,p){const j=p.j,m=p.moving;let maske="";
  for(const v of Z.w)maske+=(m?v.kv<=j&&v.kb>=j+1:v.kv<=j&&v.kb>=j)?"1":"0";
  let S=Z.sub[maske];if(S)return S;
  let w=Z.w.filter((v,i)=>maske[i]==="1");if(!w.length)w=Z.w;
  let off=0;const teile=ZM.wagenTeile(w).map((W,i)=>{const L=w[i].L/100,s=off+L/2;off+=L;return {W,L,s}});
  return Z.sub[maske]={teile,L:off}}

// Laufweg eines Zuges als Linienzüge mit Längen (Kartenkoordinaten). An Kopfbahnhöfen (Zug wendet, z. B. Zürich HB,
// Luzern) beginnt ein neuer Abschnitt – so steht der Zug am Bahnsteig, statt sich um den Bahnhof zu knicken.
function pfad(tr){if(tr._pf!==undefined)return tr._pf;const LG=legs(tr);if(!LG.length||LG.some(x=>!x))return tr._pf=null;
  const teile=[],legSec=[],legS0=[],legS1=[];let T=null;
  const richtung=(pts,vonEnde)=>{const n=pts.length;let A=vonEnde?pts[n-1]:pts[0],B=A,acc=0;for(let q=1;q<n&&acc<2;q++){const P=vonEnde?pts[n-1-q]:pts[q];acc+=Math.hypot(P[0]-B[0],P[1]-B[1]);B=P}
    const d=Math.hypot(B[0]-A[0],B[1]-A[1])||1;return vonEnde?[(A[0]-B[0])/d,(A[1]-B[1])/d]:[(B[0]-A[0])/d,(B[1]-A[1])/d]};
  LG.forEach((P,k)=>{
    if(T&&T.pts.length>1){const a=richtung(T.pts,true),b=richtung(P.pts,false);if(a[0]*b[0]+a[1]*b[1]<-.35)T=null}   // Wende
    if(!T){T={pts:[],cum:[],h:{}};teile.push(T)}
    legSec.push(teile.length-1);legS0.push(T.cum.length?T.cum[T.cum.length-1]:0);
    for(const p of P.pts){if(T.pts.length){const q=T.pts[T.pts.length-1],d=Math.hypot(p[0]-q[0],p[1]-q[1]);if(d<1e-4)continue;T.cum.push(T.cum[T.cum.length-1]+d)}else T.cum.push(0);T.pts.push(p)}
    legS1.push(T.cum[T.cum.length-1])});
  if(teile.some(t=>t.pts.length<2))return tr._pf=null;return tr._pf={teile,legSec,legS0,legS1}}
function punkt(pf,s){const c=pf.cum,n=c.length,E=c[n-1];
  // ausserhalb des Laufwegs (Zug steht am Anfangs-/Endbahnhof): gerade weiter in der Richtung der letzten 100 m
  if(s<0||s>E){const a=s<0?0:E,b=s<0?Math.min(E,1):Math.max(0,E-1),A=punkt(pf,a),B=punkt(pf,b),d=Math.hypot(A[0]-B[0],A[1]-B[1])||1,k=(s<0?-s:s-E)/d;
    return [A[0]+(A[0]-B[0])*k,A[1]+(A[1]-B[1])*k]}
  let lo=0,hi=n-1;while(hi-lo>1){const m=(lo+hi)>>1;if(c[m]<=s)lo=m;else hi=m}const u=(s-c[lo])/((c[hi]-c[lo])||1);
  const A=pf.pts[lo],B=pf.pts[hi];return [A[0]+(B[0]-A[0])*u,A[1]+(B[1]-A[1])*u]}
// Höhe des Gleises aus dem Gelände. Brücken: kurze Stellen, an denen das Gelände tiefer liegt, als es die Steigung
// erlaubt (bis 800 m lang), werden gerade überspannt; Tunnels: Stellen unter dem Gelände gerade unterfahren (Zug verdeckt).
// Sonst liegt der Zug auf dem Gelände – nichts schwebt. Abschnittsweise je 4 km, beim Hineinzoomen genauer neu berechnet.
const H_SCHRITT=.25,H_STUECK=160,H_RAND=40;
function hoehe(pf,s,steil){const T=map.getTerrain(),ex=T?T.exaggeration||1:0;if(!ex)return 0;
  const k=Math.floor(s/(H_SCHRITT*H_STUECK)),zs=Math.min(14,Math.floor(map.getZoom()));let h=pf.h[k];
  if((!h||h.z<zs||h.ex!==ex)&&Z3.hBudget>0){Z3.hBudget--;const neu=gleisHoehe(pf,k,steil,ex);if(neu){neu.z=zs;neu.ex=ex;pf.h[k]=h=neu}}
  if(!h)return null;
  const f=(s-h.s0)/H_SCHRITT,i=Math.max(0,Math.min(h.length-2,Math.floor(f))),u=f-i;return h[i]*(1-u)+h[i+1]*u}
function gleisHoehe(pf,k,steil,ex){
  const n=H_STUECK+2*H_RAND+1,s0=(k*H_STUECK-H_RAND)*H_SCHRITT,dem=new Float32Array(n);
  for(let i=0;i<n;i++){const p=punkt(pf,s0+i*H_SCHRITT),e=map.queryTerrainElevation(wgs(p[0],p[1]));if(e===null||e===undefined)return null;dem[i]=e}
  // Steigungsgrenze (Normalspur 5 %, Schmalspur/Zahnrad 25 %), vorwärts und rückwärts
  const g=(steil?.25:.05)*ex*H_SCHRITT*100,v=new Float32Array(n),r=new Float32Array(n),h=new Float32Array(n);
  v[0]=dem[0];for(let i=1;i<n;i++)v[i]=Math.min(Math.max(dem[i],v[i-1]-g),v[i-1]+g);
  r[n-1]=dem[n-1];for(let i=n-2;i>=0;i--)r[i]=Math.min(Math.max(dem[i],r[i+1]-g),r[i+1]+g);
  const lage=new Int8Array(n);for(let i=0;i<n;i++){const d=dem[i];lage[i]=v[i]>d+1.5&&r[i]>d+1.5?1:v[i]<d-1.5&&r[i]<d-1.5?-1:0;h[i]=d}
  for(let i=0;i<n;){if(!lage[i]){i++;continue}const L=lage[i];let j=i;while(j+1<n&&lage[j+1]===L)j++;
    const a=i>0?dem[i-1]:(v[i]+r[i])/2,b=j<n-1?dem[j+1]:(v[j]+r[j])/2,m=j-i+2;
    if(L<0||(j-i+1)*H_SCHRITT<=8)for(let q=i;q<=j;q++){const lin=a+(b-a)*(q-i+1)/m;h[q]=L>0?Math.max(lin,dem[q]):Math.min(lin,dem[q])}
    i=j+1}
  h.s0=s0;return h}

// Unternehmen mit Normalspur (sonst: Schmal-/Zahnradbahn, steilere Strecken erlaubt)
const NORMALSPUR=new Set(["11","33","65","82","78","351","81____","87_LEX","06____","800693","L7____","817000"]);
// ---- three.js-Ebene ----
const Z3={laden:false,bereit:false,liste:[],zuege:[],ursprung:null,hBudget:0,sel:null};
// Bei jedem Bild: Lage aller 3D-Züge zur aktuellen Zeit neu (flüssige Fahrt; welche Züge 3D sind, bestimmt frame() ~15×/s)
function z3Bild(){const t0=zh(simMs).t;Z3.liste=[];Z3.ursprung=maplibregl.MercatorCoordinate.fromLngLat(map.getCenter());if(Z3.hBudget<2)Z3.hBudget=2;
  for(const z of Z3.zuege){const p=trainPos(z.tr,t0+z.o,z.rt);if(p)z3Zug(z.tr,z.o,p,z.sel)}
  map.triggerRepaint()}
function z3Laden(){if(Z3.laden)return;Z3.laden=true;const s=document.createElement("script");s.src="lib/three.min.js";
  s.onload=()=>{try{map.addLayer(z3Ebene(),"fz");Z3.bereit=true}catch(e){console.error(e)}};document.head.appendChild(s)}
function z3Ebene(){return {id:"zuege3d",type:"custom",renderingMode:"3d",
  onAdd(m,gl){this.cam=new THREE.Camera();this.szene=new THREE.Scene();
    this.szene.add(new THREE.HemisphereLight(0xffffff,0x7d8a96,1.7));const d=new THREE.DirectionalLight(0xffffff,1.5);d.position.set(-.5,-.4,.9);this.szene.add(d);
    this.r=new THREE.WebGLRenderer({canvas:m.getCanvas(),context:gl,antialias:true});this.r.autoClear=false;this.r.outputColorSpace=THREE.SRGBColorSpace;
    this.mat=new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide});this.netze=new Map()},
  render(gl,args){const L=Z3.liste,o=Z3.ursprung;if(!o){return}
    const zahl=new Map();for(const c of L)zahl.set(c.g,(zahl.get(c.g)||0)+1);
    for(const [g,n] of this.netze)if(!zahl.has(g)){n.count=0}
    const M=new THREE.Matrix4(),Q=new THREE.Quaternion(),E=new THREE.Euler(0,0,0,"ZYX"),V=new THREE.Vector3(),S=new THREE.Vector3(1,1,1),weiss=new THREE.Color(1,1,1),gelb=new THREE.Color(1,.82,.35),idx=new Map();
    for(const c of L){let n=this.netze.get(c.g);const bedarf=zahl.get(c.g);
      if(!n||n.instanceMatrix.count<bedarf){if(n){this.szene.remove(n);n.dispose()}n=new THREE.InstancedMesh(c.geo,this.mat,Math.max(8,bedarf*2));n.frustumCulled=false;
        n.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(n.instanceMatrix.count*3).fill(1),3);this.netze.set(c.g,n);this.szene.add(n)}
      const i=idx.get(c.g)||0;idx.set(c.g,i+1);E.set(0,-c.neig,c.dreh);Q.setFromEuler(E);V.set(c.x,c.y,c.z);M.compose(V,Q,S);n.setMatrixAt(i,M);n.setColorAt(i,c.sel?gelb:weiss)}
    for(const [g,n] of this.netze)if(zahl.has(g)){n.count=zahl.get(g);n.instanceMatrix.needsUpdate=true;n.instanceColor.needsUpdate=true}
    const s=o.meterInMercatorCoordinateUnits();
    const m=new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix),l=new THREE.Matrix4().makeTranslation(o.x,o.y,o.z).scale(new THREE.Vector3(s,s,s));   // lokal: x Ost, y Süd, z hoch (Meter)
    this.cam.projectionMatrix=m.multiply(l);this.r.resetState();this.r.render(this.szene,this.cam)}}}

// Wagen eines Zuges berechnen (aus frame()): Lage, Richtung und Neigung jedes Wagens
function z3Zug(tr,o,p,isSel){const PF=pfad(tr);if(!PF||p.j===undefined)return false;const Z=wagenJetzt(wagenVon(tr,o),p);
  // fahrend: auf dem Abschnitt j→j+1; stehend: Zugmitte am Bahnsteig (Abschnitt der Weiterfahrt, am Ziel der Ankunft)
  const nL=PF.legSec.length,j=p.moving?p.j:Math.min(p.j,nL-1),amEnde=!p.moving&&p.j>=nL;
  const pf=PF.teile[PF.legSec[j]],kopf=(amEnde?PF.legS1[j]:PF.legS0[j]+(PF.legS1[j]-PF.legS0[j])*(p.moving?p.f:0))+Z.L/2;
  const os=Z3.ursprung,ms=os.meterInMercatorCoordinateUnits(),aus=[];
  for(const t of Z.teile){const sc=kopf-t.s,h=t.L*.42;
    const pv=punkt(pf,sc+h),ph=punkt(pf,sc-h),pm=punkt(pf,sc);
    const steil=t.W.T.spur<1.2||!NORMALSPUR.has(tr.ag),zv=hoehe(pf,sc+h,steil),zh_=hoehe(pf,sc-h,steil);if(zv===null||zh_===null)return false;
    const mv=maplibregl.MercatorCoordinate.fromLngLat(wgs(pv[0],pv[1])),mh=maplibregl.MercatorCoordinate.fromLngLat(wgs(ph[0],ph[1])),mm=maplibregl.MercatorCoordinate.fromLngLat(wgs(pm[0],pm[1]));
    const dx=(mv.x-mh.x)/ms,dy=(mv.y-mh.y)/ms,len=Math.hypot(dx,dy)||1;
    aus.push({g:ZM.schluessel(t.W),geo:ZM.bauWagen(t.W),x:(mm.x-os.x)/ms,y:(mm.y-os.y)/ms,z:(zv+zh_)/2,dreh:Math.atan2(dy,dx),neig:Math.atan2(zv-zh_,len),sel:isSel})}
  for(const c of aus)Z3.liste.push(c);return true}
