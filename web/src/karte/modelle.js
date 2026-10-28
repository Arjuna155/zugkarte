// 3D-Zugmodelle: jede Baureihe ist ein Parametersatz (Masse, Form der Front, Fenster, Türen, Bemalung).
// bauWagen() erzeugt daraus die Geometrie eines Wagens (three.js BufferGeometry, Farbe je Fläche).
// Koordinaten eines Wagens: x längs (vorne = +x), y quer (links = +y), z hoch; Ursprung Wagenmitte auf Schienenoberkante; Meter.
const ZM=(()=>{
const hex=h=>{const n=parseInt(h.slice(1),16);return [(n>>16&255)/255,(n>>8&255)/255,(n&255)/255]};
const lin=c=>c.map(v=>v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4));   // three.js rechnet in linearen Farben
const FARBE={};const F=h=>FARBE[h]||(FARBE[h]=lin(hex(h)));

// ---- Grundbausteine: Dreiecke sammeln ----
function Puffer(){this.p=[];this.n=[];this.c=[]}
Puffer.prototype.dreieck=function(a,b,c,na,nb,nc,col){this.p.push(...a,...b,...c);this.n.push(...na,...nb,...nc);for(let i=0;i<3;i++)this.c.push(...col)};
Puffer.prototype.viereck=function(a,b,c,d,na,nb,nc,nd,col){this.dreieck(a,b,c,na,nb,nc,col);this.dreieck(a,c,d,na,nc,nd,col)};
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],kreuz=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=v=>{const l=Math.hypot(v[0],v[1],v[2])||1;return [v[0]/l,v[1]/l,v[2]/l]};
// Quader (achsenparallel), optional nur sichtbare Seiten
Puffer.prototype.kiste=function(x0,x1,y0,y1,z0,z1,col,ohneBoden=true){const P=(x,y,z)=>[x,y,z];
  const s=[[[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1],[1,0,0]],[[x0,y1,z0],[x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[-1,0,0]],
    [[x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[0,1,0]],[[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],[0,-1,0]],
    [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],[0,0,1]]];
  if(!ohneBoden)s.push([[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0],[0,0,-1]]);
  for(const [a,b,c,d,n] of s)this.viereck(a,b,c,d,n,n,n,n,F(col))};
// schräger Stab von A nach B (Stromabnehmer), quadratischer Querschnitt d
Puffer.prototype.stab=function(A,B,d,col){const r=norm(sub(B,A));let u=Math.abs(r[2])<.9?norm(kreuz(r,[0,0,1])):norm(kreuz(r,[1,0,0]));const v=kreuz(r,u);
  const ec=(P,s,t)=>[P[0]+(u[0]*s+v[0]*t)*d/2,P[1]+(u[1]*s+v[1]*t)*d/2,P[2]+(u[2]*s+v[2]*t)*d/2];
  const k=[[1,1],[-1,1],[-1,-1],[1,-1]];for(let i=0;i<4;i++){const [s0,t0]=k[i],[s1,t1]=k[(i+1)%4];const n=norm([u[0]*(s0+s1)+v[0]*(t0+t1),u[1]*(s0+s1)+v[1]*(t0+t1),u[2]*(s0+s1)+v[2]*(t0+t1)]);
    this.viereck(ec(A,s0,t0),ec(B,s0,t0),ec(B,s1,t1),ec(A,s1,t1),n,n,n,n,F(col))}};

// ---- Querschnitt (halbe Seite, von unten Mitte über die Seitenwand zum Dach Mitte) ----
// Punkte an allen Farbgrenzen (zKanten), damit Bänder scharf sind
function profil(T,zKanten){const w=T.b/2,z0=T.boden,zt=T.hoehe,rU=.22,rD=Math.min(T.dachR||.6,w*.5),kr=.12,ze=zt-rD-kr,P=[];
  P.push([0,z0],[w-rU,z0]);
  for(const g of [-60,-30])P.push([w-rU+rU*Math.cos(g*Math.PI/180),z0+rU+rU*Math.sin(g*Math.PI/180)]);
  const za=z0+rU,mitte=[za,ze,...zKanten.filter(z=>z>za+.02&&z<ze-.02)];for(let z=za+.5;z<ze;z+=.5)if(!mitte.some(q=>Math.abs(q-z)<.12))mitte.push(z);
  mitte.sort((a,b)=>a-b);for(const z of mitte)P.push([w,z]);
  for(const g of [18,36,54,72])P.push([w-rD+rD*Math.cos(g*Math.PI/180),ze+rD*Math.sin(g*Math.PI/180)]);
  const ys=w-rD,zs=ze+rD;for(let i=1;i<=3;i++){const t=i/3;P.push([ys*(1-t),zs+kr*Math.sin(t*Math.PI/2)])}
  return P}

// ---- Wagenkasten ----
// W: {L (Kastenlänge), kabV, kabH (Führerstand vorne/hinten), T (Baureihe), rolle}
function kasten(B,W){const T=W.T,L=W.L,lv=T.lack;
  const zK=[...(lv.baender||[]).flatMap(b=>[b.z0,b.z1]),...(lv.fenster||[]).flatMap(f=>[f.z0,f.z1]),lv.dachZ||0,T.front&&T.front.scheibe?T.front.scheibe[0]:0,T.front&&T.front.scheibe?T.front.scheibe[1]:0].filter(Boolean);
  const Pr=profil(T,zK),nP=Pr.length,fr=T.front||{art:"flach",len:.5};
  // Schnitte längs: gleichmässig + Kanten von Türen/Fenstern
  const Ln=fr.len,xs=new Set();const x0=-L/2,x1=L/2;
  const kanten=[];(W.tueren||[]).forEach(t=>kanten.push(t-T.tuerB/2,t+T.tuerB/2));
  const aV=W.kabV?x1-Ln:x1,aH=W.kabH?x0+Ln:x0;
  for(let x=aH;x<=aV+1e-6;x+=Math.max(.6,(aV-aH)/Math.ceil((aV-aH)/1.2)))xs.add(+x.toFixed(3));xs.add(+aV.toFixed(3));
  kanten.forEach(x=>{if(x>aH+.05&&x<aV-.05)xs.add(+x.toFixed(3))});
  if(T.fensterTeilung)for(let x=aH+T.fensterTeilung/2;x<aV;x+=T.fensterTeilung){xs.add(+(x-.12).toFixed(3));xs.add(+(x+.12).toFixed(3))}
  let mid=[...xs].sort((a,b)=>a-b).map(x=>({x,t:1,e:0}));
  // Nase: t=0 Spitze … t=1 voller Querschnitt
  const nN=fr.art==="flach"?4:18,nase=e=>{const r=[];for(let i=0;i<=nN;i++){const t=i/nN;r.push({t:Math.pow(t,fr.art==="flach"?1:1.25),e})}return r};
  let sl=[];if(W.kabH)sl.push(...nase(-1).slice(0,-1));else sl.push({x:x0,t:1,e:0,ende:-1});
  sl.push(...mid.filter(s=>s.x>(W.kabH?aH-1e-6:x0+.01)&&s.x<(W.kabV?aV+1e-6:x1-.01)));
  if(W.kabV)sl.push(...nase(1).reverse().slice(1));else sl.push({x:x1,t:1,e:0,ende:1});
  if(!W.kabH&&sl[1]&&sl[1].x<=x0)sl.splice(1,1);
  // Lage eines Profilpunkts in einem Schnitt
  const zf0=fr.scheibe?fr.scheibe[0]:T.hoehe*.55;
  const pos=(s,[py,pz])=>{if(!s.e)return [s.x,py,pz];
    const t=s.t,u=Ln*t,hu=Math.max(0,(pz-zf0)/(T.hoehe-zf0));   // hu: 0 unten … 1 oben
    const fw=fr.breiteSpitze+(1-fr.breiteSpitze)*Math.sqrt(t),schr=(fr.schraeg||0)*hu*hu*(1-t)+(fr.unten||0)*(1-Math.min(1,(pz-T.boden)/.8))*(1-t);
    const zz=T.boden+(pz-T.boden)*(fr.hoeheSpitze+(1-fr.hoeheSpitze)*Math.sqrt(t));
    return [s.e*(L/2-u-schr),py*fw,zz]};
  // Gitter beider Seiten (rechts: y gespiegelt)
  const G=sl.map(s=>{const r=Pr.map(p=>pos(s,p));const l=Pr.map(p=>pos(s,[-p[0],p[1]]));return {s,r,l}});
  const nrm=(Gi,j,seite)=>{const A=G[Math.max(0,Gi-1)][seite],Bq=G[Math.min(G.length-1,Gi+1)][seite];const S=G[Gi][seite];
    const tx=sub(Bq[j],A[j]),tz=sub(S[Math.min(nP-1,j+1)],S[Math.max(0,j-1)]);let n=norm(seite==="r"?kreuz(tz,tx):kreuz(tx,tz));
    if(n[0]===0&&n[1]===0&&n[2]===0)n=[0,0,1];return n};
  const N={r:G.map((g,i)=>g.r.map((_,j)=>nrm(i,j,"r"))),l:G.map((g,i)=>g.l.map((_,j)=>nrm(i,j,"l")))};
  const farbe=(i,j,seite)=>{const a=G[i][seite][j],b=G[i+1][seite][j+1],xm=(a[0]+b[0])/2,zm=(a[2]+b[2])/2;
    const s0=G[i].s,s1=G[i+1].s,inNase=(s0.e&&s0.t<1)||(s1.e&&s1.t<1),tm=inNase?((s0.e?s0.t:1)+(s1.e?s1.t:1))/2:1;
    const py=(Pr[j][0]+Pr[j+1][0])/2,dach=py<T.b/2-.15&&Pr[j][1]>T.hoehe-.6;
    return F(lack(T,W,{x:xm,z:zm,nase:inNase?tm:1,e:s0.e||s1.e,dach,unten:Pr[j][1]<=T.boden+.01&&Pr[j+1][1]<=T.boden+.01}))};
  for(let i=0;i<G.length-1;i++)for(let j=0;j<nP-1;j++){
    const R=G[i].r,R2=G[i+1].r,Lq=G[i].l,L2=G[i+1].l;
    B.viereck(R[j],R2[j],R2[j+1],R[j+1],N.r[i][j],N.r[i+1][j],N.r[i+1][j+1],N.r[i][j+1],farbe(i,j,"r"));
    B.viereck(Lq[j],Lq[j+1],L2[j+1],L2[j],N.l[i][j],N.l[i][j+1],N.l[i+1][j+1],N.l[i+1][j],farbe(i,j,"l"))}
  // Stirnflächen: Spitze der Nase bzw. flaches Wagenende
  for(const [k,e] of [[0,-1],[G.length-1,1]]){const g=G[k];const c=[e*Math.abs(g.r[0][0]),0,(T.boden+T.hoehe)/2];const n=[e,0,0];
    const col=F(g.s.e?(lv.front||lv.grund):(lv.ende||"#3a3d40"));
    for(let j=0;j<nP-1;j++){if(e>0){B.dreieck(c,g.r[j],g.r[j+1],n,n,n,col);B.dreieck(c,g.l[j+1],g.l[j],n,n,n,col)}else{B.dreieck(c,g.r[j+1],g.r[j],n,n,n,col);B.dreieck(c,g.l[j],g.l[j+1],n,n,n,col)}}}
  // Übergang (Faltenbalg) an Enden ohne Führerstand
  for(const e of [-1,1]){if((e>0&&W.kabV)||(e<0&&W.kabH))continue;const xa=e*L/2,xb=e*(L/2+(W.spalt||.3)/2+.02);
    B.kiste(Math.min(xa,xb),Math.max(xa,xb),-T.b*.36,T.b*.36,T.boden+.15,T.hoehe-.35,"#26292c")}
}

// ---- Bemalung: Farbe an einer Stelle ----
// o: {x, z, nase (0 Spitze … 1 voller Querschnitt), e (Ende ±1/0), dach, unten}
function lack(T,W,o){const lv=T.lack,z=o.z;
  if(o.unten)return lv.unten||"#2a2c2e";
  if((o.dach||z>=(lv.dachZ||T.hoehe-.25))&&o.nase>.8)return lv.dach||"#8b9094";
  if(o.nase<1&&T.front){const fr=T.front;
    if(fr.scheibe&&z>=fr.scheibe[0]&&z<=fr.scheibe[1]&&o.nase<(fr.scheibeT||.75))return lv.glas||"#1b2127";
    if(lv.nase)for(const b of lv.nase)if(z>=b.z0&&z<b.z1&&o.nase<=(b.t||1))return b.c}
  for(const t of W.tueren||[])if(Math.abs(o.x-t)<T.tuerB/2){if(lv.tuerFenster&&z>=lv.tuerFenster[0]&&z<=lv.tuerFenster[1])return lv.glas||"#1b2127";
    if(z>=T.boden+.05&&z<=(T.tuerH||T.boden+2.1))return lv.tuer||lv.grund}
  if(W.rolle!=="lok"&&o.nase>=.98)for(const f of lv.fenster||[])if(z>=f.z0&&z<f.z1){
    if(T.fensterTeilung){const p=((o.x%T.fensterTeilung)+T.fensterTeilung)%T.fensterTeilung;if(p<.12||p>T.fensterTeilung-.12)return lv.steg||lv.glas||"#1b2127"}
    return lv.glas||"#1b2127"}
  for(const b of lv.baender||[])if(z>=b.z0&&z<b.z1)return b.c;
  return lv.grund}

// ---- Drehgestelle, Stromabnehmer, Dachaufbauten ----
function fahrwerk(B,W){const T=W.T,L=W.L,ab=T.dgAbstand||Math.min(L/2-2.6,L*.35);
  const dg=W.jakobs?[]:[ab,-ab];if(W.jakobs){if(W.jakobs.v)dg.push(L/2+(W.spalt||.3)/2);if(W.jakobs.h)dg.push(-L/2-(W.spalt||.3)/2);if(!W.jakobs.v)dg.push(L/2-2.4);if(!W.jakobs.h)dg.push(-L/2+2.4)}
  const s=T.spur||1.435,rr=T.rad||.46;
  for(const x of dg){B.kiste(x-1.3,x+1.3,-s/2-.18,s/2+.18,.3,Math.min(T.boden,.95),"#303336");
    for(const dx of [-.95,.95])for(const sy of [-1,1])B.kiste(x+dx-rr*.8,x+dx+rr*.8,sy*s/2-.08,sy*s/2+.08,.02,rr*1.6,"#1f2123")}}
function stromabnehmer(B,T,x){const z=T.hoehe+.05,hz=z+1.1;
  B.kiste(x-.9,x+.9,-.45,.45,z-.05,z+.25,"#55595d");
  B.stab([x-.7,-.35,z+.25],[x+.35,-.25,z+.95],.07,"#3b3f43");B.stab([x-.7,.35,z+.25],[x+.35,.25,z+.95],.07,"#3b3f43");
  B.stab([x+.35,0,z+.95],[x-.25,0,hz],.06,"#3b3f43");B.kiste(x-.35,x-.15,-.95,.95,hz,hz+.08,"#2a2d30")}
function dachKiste(B,T,x0,x1,b,h,col){B.kiste(x0,x1,-b/2,b/2,T.hoehe-.08,T.hoehe+h,col||"#9aa0a4")}

// ---- Baureihen ----
// Masse nach Fahrzeugdaten (Breite b, Höhe über Schiene, Wagenboden), Bemalung vereinfacht
const SBB_FV={grund:"#eef0f1",dach:"#7d8387",unten:"#2b2e31",glas:"#16191c",tuer:"#e8eaeb",ende:"#33373a"};
const SBB_RV={grund:"#f2f3f4",dach:"#80878c",unten:"#2b2e31",glas:"#16191c",tuer:"#c8102e",ende:"#33373a"};
const ROT="#d5001c";
const T={};
const def=(id,o)=>{T[id]=Object.assign({id,b:2.9,boden:1.05,hoehe:4.0,tuerB:1.3,spur:1.435},o);return T[id]};
// Fernverkehr SBB
def("giruno",{jak:true,name:"Giruno (RABe 501)",b:2.9,boden:.75,hoehe:4.15,front:{art:"stromlinie",len:6.5,breiteSpitze:0.3,hoeheSpitze:0.45,schraeg:2.2,unten:.6,scheibe:[2.1,3.25],scheibeT:.8},
  tuerB:1.0,lack:{...SBB_FV,fenster:[{z0:1.55,z1:2.75}],baender:[{z0:.75,z1:1.0,c:"#3a3e42"}],nase:[{z0:0,z1:1.3,c:ROT,t:.45}],tuerFenster:[1.9,2.75]},strom:true,typischL:[27.5,18.3,18.3,18.3,18.3,18.3,18.3,18.3,18.3,18.3,27.5]});
def("fvdosto",{name:"FV-Dosto (RABe 502)",b:2.8,boden:.6,hoehe:4.6,front:{art:"stromlinie",len:4.2,breiteSpitze:0.45,hoeheSpitze:0.6,schraeg:1.6,unten:.3,scheibe:[2.55,3.6],scheibeT:.8},
  tuerB:1.35,lack:{...SBB_FV,fenster:[{z0:1.05,z1:1.95},{z0:2.85,z1:3.75}],baender:[{z0:.6,z1:.85,c:"#3a3e42"}],nase:[{z0:0,z1:1.6,c:ROT,t:.5}],tuerFenster:[1.15,2.0]},strom:true,typischL:[26.8,25,25,25,25,25,25,26.8]});
def("ic2000",{name:"IC2000-Doppelstockwagen",b:2.8,boden:.55,hoehe:4.65,front:{art:"stumpf",len:2.6,breiteSpitze:.8,hoeheSpitze:.85,schraeg:1.2,unten:.2,scheibe:[2.9,3.7],scheibeT:.85},
  tuerB:1.3,lack:{...SBB_FV,fenster:[{z0:1.05,z1:1.9},{z0:2.85,z1:3.7}],baender:[{z0:.55,z1:.8,c:"#3a3e42"}],nase:[{z0:0,z1:2.6,c:ROT,t:.6}],tuerFenster:[1.15,2.0]},typischL:[26.8]});
def("ew4",{name:"Einheitswagen IV",b:2.83,boden:1.15,hoehe:4.03,front:{art:"stumpf",len:2,breiteSpitze:.82,hoeheSpitze:.85,schraeg:.9,scheibe:[2.5,3.2]},
  tuerB:1.1,fensterTeilung:2.3,lack:{...SBB_FV,fenster:[{z0:2.05,z1:3.0}],baender:[{z0:1.15,z1:1.4,c:"#3a3e42"}],nase:[{z0:0,z1:2.5,c:ROT,t:.6}],tuerFenster:[2.1,3.0]},typischL:[26.4]});
def("re460",{name:"Re 460",b:3.0,boden:1.2,hoehe:4.2,front:{art:"stromlinie",len:2.6,breiteSpitze:0.55,hoeheSpitze:0.7,schraeg:1.5,unten:.4,scheibe:[2.75,3.55],scheibeT:.85},
  lack:{grund:ROT,dach:"#5d6266",unten:"#2b2e31",glas:"#16191c",front:ROT,baender:[{z0:1.2,z1:1.45,c:"#2b2e31"}],fenster:[]},rolle:"lok",strom:2,typischL:[18.5]});
def("icn",{name:"ICN (RABDe 500)",b:2.83,boden:1.15,hoehe:4.0,front:{art:"stromlinie",len:4.5,breiteSpitze:0.35,hoeheSpitze:0.5,schraeg:1.6,unten:.5,scheibe:[2.3,3.3],scheibeT:.8},
  tuerB:1.1,lack:{...SBB_FV,fenster:[{z0:2.05,z1:3.0}],baender:[{z0:1.15,z1:1.4,c:"#3a3e42"}],nase:[{z0:0,z1:1.8,c:ROT,t:.5}],tuerFenster:[2.1,3.0]},strom:true,typischL:[27.1,24.7,24.7,24.7,24.7,24.7,27.1]});
def("astoro",{name:"Astoro (RABe 503)",b:2.8,boden:1.15,hoehe:4.05,front:{art:"stromlinie",len:6,breiteSpitze:0.25,hoeheSpitze:0.4,schraeg:2.5,unten:.8,scheibe:[2.3,3.3],scheibeT:.8},
  tuerB:1.0,lack:{...SBB_FV,fenster:[{z0:2.0,z1:2.95}],baender:[{z0:1.15,z1:1.4,c:"#3a3e42"}],nase:[{z0:0,z1:2.0,c:ROT,t:.55}],tuerFenster:[2.05,2.95]},strom:true,typischL:[27.7,25.9,25.9,25.9,25.9,25.9,27.7]});
// Regionalverkehr SBB
def("dosto_rv",{name:"Dosto RV (KISS RABe 511/512)",b:2.8,boden:.6,hoehe:4.6,front:{art:"stromlinie",len:3.6,breiteSpitze:0.48,hoeheSpitze:0.62,schraeg:1.5,unten:.3,scheibe:[2.5,3.6],scheibeT:.8},
  tuerB:1.4,lack:{...SBB_RV,fenster:[{z0:1.05,z1:1.95},{z0:2.85,z1:3.75}],baender:[{z0:.6,z1:.85,c:"#3a3e42"}],nase:[{z0:0,z1:1.6,c:ROT,t:.5}],tuerFenster:[1.15,2.0]},strom:true,typischL:[26.2,25,25,26.2]});
def("dtz",{name:"DTZ (RABe 514)",b:2.8,boden:.6,hoehe:4.6,front:{art:"stromlinie",len:3.4,breiteSpitze:0.5,hoeheSpitze:0.65,schraeg:1.4,unten:.3,scheibe:[2.5,3.6],scheibeT:.8},
  tuerB:1.4,lack:{...SBB_RV,tuer:"#2f3b8f",fenster:[{z0:1.05,z1:1.95},{z0:2.85,z1:3.75}],baender:[{z0:.6,z1:.85,c:"#3a3e42"}],nase:[{z0:0,z1:1.6,c:"#2f3b8f",t:.5}],tuerFenster:[1.15,2.0]},strom:true,typischL:[25.7,24.6,24.6,25.7]});
def("flirt",{jak:true,name:"FLIRT",b:2.88,boden:.6,hoehe:4.15,front:{art:"stromlinie",len:3.0,breiteSpitze:0.5,hoeheSpitze:0.65,schraeg:1.3,unten:.35,scheibe:[2.0,3.3],scheibeT:.8},
  tuerB:1.3,lack:{...SBB_RV,fenster:[{z0:1.45,z1:2.6}],baender:[{z0:.6,z1:.85,c:"#3a3e42"}],nase:[{z0:0,z1:1.3,c:ROT,t:.5}],tuerFenster:[1.45,2.6]},strom:true,typischL:[19.5,15.5,15.5,19.5]});
def("gtw",{jak:true,name:"GTW",b:2.95,boden:.6,hoehe:3.95,front:{art:"stumpf",len:1.8,breiteSpitze:.75,hoeheSpitze:.82,schraeg:.9,unten:.2,scheibe:[1.9,3.1],scheibeT:.85},
  tuerB:1.3,lack:{...SBB_RV,fenster:[{z0:1.45,z1:2.55}],baender:[{z0:.6,z1:.85,c:"#3a3e42"}],nase:[{z0:0,z1:1.3,c:ROT,t:.55}],tuerFenster:[1.45,2.55]},typischL:[17.2,5,17.2]});
def("domino",{name:"Domino / NPZ (RBDe 560)",b:2.82,boden:1.15,hoehe:4.0,front:{art:"stumpf",len:2.2,breiteSpitze:.82,hoeheSpitze:.86,schraeg:.9,unten:.2,scheibe:[2.35,3.2],scheibeT:.85},
  tuerB:1.3,fensterTeilung:2.0,lack:{...SBB_RV,fenster:[{z0:2.05,z1:2.95}],baender:[{z0:1.15,z1:1.4,c:"#3a3e42"}],nase:[{z0:0,z1:2.3,c:ROT,t:.6}],tuerFenster:[2.1,2.95]},strom:true,typischL:[25,24.5,25]});
def("mutz",{name:"MUTZ (BLS RABe 515)",b:2.8,boden:.6,hoehe:4.6,front:{art:"stromlinie",len:3.4,breiteSpitze:0.48,hoeheSpitze:0.62,schraeg:1.5,unten:.3,scheibe:[2.5,3.6],scheibeT:.8},
  tuerB:1.4,lack:{grund:"#e9ecec",dach:"#80878c",unten:"#2b2e31",glas:"#16191c",tuer:"#79b928",ende:"#33373a",fenster:[{z0:1.05,z1:1.95},{z0:2.85,z1:3.75}],baender:[{z0:.6,z1:.85,c:"#3f4448"}],nase:[{z0:0,z1:4.7,c:"#79b928",t:.35}],tuerFenster:[1.15,2.0]},strom:true,typischL:[26.2,25,25,26.2]});
def("bls_flirt",{jak:true,name:"BLS FLIRT/NINA",b:2.88,boden:.6,hoehe:4.15,front:{art:"stromlinie",len:3.0,breiteSpitze:0.5,hoeheSpitze:0.65,schraeg:1.3,unten:.35,scheibe:[2.0,3.3],scheibeT:.8},
  tuerB:1.3,lack:{grund:"#e9ecec",dach:"#80878c",unten:"#2b2e31",glas:"#16191c",tuer:"#79b928",ende:"#33373a",fenster:[{z0:1.45,z1:2.6}],baender:[{z0:.6,z1:.85,c:"#3f4448"}],nase:[{z0:0,z1:4.2,c:"#79b928",t:.35}],tuerFenster:[1.45,2.6]},strom:true,typischL:[19.5,15.5,15.5,19.5]});
def("traverso",{jak:true,name:"Traverso (SOB RABe 526)",b:2.88,boden:.6,hoehe:4.15,front:{art:"stromlinie",len:3.0,breiteSpitze:0.5,hoeheSpitze:0.65,schraeg:1.3,unten:.35,scheibe:[2.0,3.3],scheibeT:.8},
  tuerB:1.3,lack:{grund:"#4a2e22",dach:"#6b6f72",unten:"#2b2e31",glas:"#16191c",tuer:"#b9b1a8",ende:"#33373a",fenster:[{z0:1.45,z1:2.6}],baender:[{z0:.6,z1:.85,c:"#2f2420"}],nase:[{z0:0,z1:4.2,c:"#4a2e22",t:1}],tuerFenster:[1.45,2.6]},strom:true,typischL:[19.5,15.5,15.5,15.5,15.5,15.5,15.5,19.5]});
def("thurbo",{jak:true,name:"Thurbo GTW",b:2.95,boden:.6,hoehe:3.95,front:{art:"stumpf",len:1.8,breiteSpitze:.75,hoeheSpitze:.82,schraeg:.9,unten:.2,scheibe:[1.9,3.1],scheibeT:.85},
  tuerB:1.3,lack:{grund:"#e9eaeb",dach:"#80878c",unten:"#2b2e31",glas:"#16191c",tuer:"#6a6b6d",ende:"#33373a",fenster:[{z0:1.45,z1:2.55}],baender:[{z0:.6,z1:1.1,c:"#6a6b6d"}],nase:[{z0:0,z1:3.2,c:"#e3001b",t:.4}],tuerFenster:[1.45,2.55]},typischL:[17.2,5,17.2]});
// Meterspur
const RHB={grund:"#c4161c",dach:"#6b7074",unten:"#2b2e31",glas:"#16191c",tuer:"#c4161c",ende:"#33373a"};
def("allegra",{jak:true,name:"Allegra (RhB ABe 8/12)",b:2.65,boden:.6,hoehe:3.7,spur:1.0,rad:.37,front:{art:"stumpf",len:2.0,breiteSpitze:.72,hoeheSpitze:.8,schraeg:.9,unten:.2,scheibe:[1.8,2.8],scheibeT:.85},
  tuerB:1.2,lack:{...RHB,fenster:[{z0:1.3,z1:2.4}],baender:[{z0:.6,z1:.85,c:"#2b2e31"}],tuerFenster:[1.3,2.4]},strom:true,typischL:[17.5,14,17.5]});
def("rhb_wagen",{name:"RhB-Wagen",b:2.65,boden:1.0,hoehe:3.6,spur:1.0,rad:.37,front:{art:"stumpf",len:1.5,breiteSpitze:.8,hoeheSpitze:.86,schraeg:.6,scheibe:[2.0,2.8]},
  tuerB:1.0,fensterTeilung:1.8,lack:{...RHB,fenster:[{z0:1.85,z1:2.75}],baender:[{z0:1.0,z1:1.2,c:"#2b2e31"}],tuerFenster:[1.9,2.75]},typischL:[18.5]});
def("rhb_lok",{name:"RhB Ge 4/4",b:2.65,boden:1.05,hoehe:3.7,spur:1.0,rad:.45,front:{art:"stumpf",len:1.8,breiteSpitze:.72,hoeheSpitze:.82,schraeg:1.0,unten:.3,scheibe:[2.3,3.0],scheibeT:.85},
  lack:{...RHB,front:"#c4161c",baender:[{z0:1.05,z1:1.25,c:"#2b2e31"}],fenster:[]},rolle:"lok",strom:2,typischL:[16]});
def("zb",{jak:true,name:"zb ADLER/FINK",b:2.65,boden:.6,hoehe:3.75,spur:1.0,rad:.37,front:{art:"stromlinie",len:2.6,breiteSpitze:0.5,hoeheSpitze:0.62,schraeg:1.2,unten:.3,scheibe:[1.8,2.85],scheibeT:.8},
  tuerB:1.2,lack:{grund:"#eceeee",dach:"#80878c",unten:"#2b2e31",glas:"#16191c",tuer:"#ad1a2b",ende:"#33373a",fenster:[{z0:1.3,z1:2.4}],baender:[{z0:.6,z1:.85,c:"#ad1a2b"}],nase:[{z0:0,z1:3.8,c:"#ad1a2b",t:.3}],tuerFenster:[1.3,2.4]},strom:true,typischL:[17.6,14.2,14.2,14.2,17.6]});
def("schmalspur",{name:"Schmalspur-Triebzug",b:2.65,boden:.6,hoehe:3.7,spur:1.0,rad:.37,front:{art:"stumpf",len:2.0,breiteSpitze:.72,hoeheSpitze:.8,schraeg:.9,unten:.2,scheibe:[1.8,2.8],scheibeT:.85},
  tuerB:1.2,lack:{grund:"#eceeee",dach:"#80878c",unten:"#2b2e31",glas:"#16191c",tuer:"#e2001a",ende:"#33373a",fenster:[{z0:1.3,z1:2.4}],baender:[{z0:.6,z1:.85,c:"#e2001a"}],nase:[{z0:0,z1:3.8,c:"#e2001a",t:.3}],tuerFenster:[1.3,2.4]},strom:true,typischL:[17.5,14,17.5]});
// Ausland
def("tgv",{jak:true,name:"TGV Lyria",b:2.9,boden:1.1,hoehe:4.1,front:{art:"stromlinie",len:7,breiteSpitze:.3,hoeheSpitze:.45,schraeg:2.6,unten:1.2,scheibe:[2.3,3.3],scheibeT:.8},
  tuerB:.9,lack:{grund:"#efefef",dach:"#8a8f93",unten:"#2b2e31",glas:"#16191c",tuer:"#efefef",ende:"#33373a",fenster:[{z0:2.0,z1:2.9}],baender:[{z0:1.1,z1:1.5,c:"#b0003a"}],nase:[{z0:0,z1:4.2,c:"#b0003a",t:.2}],tuerFenster:[2.0,2.9]},strom:true,typischL:[22.2,21.8,18.7,18.7,18.7,18.7,18.7,18.7,21.8,22.2]});
def("ice",{name:"ICE",b:3.0,boden:1.1,hoehe:3.9,front:{art:"stromlinie",len:6,breiteSpitze:.4,hoeheSpitze:.5,schraeg:2.4,unten:1.0,scheibe:[2.2,3.2],scheibeT:.8},
  tuerB:.9,lack:{grund:"#f3f3f3",dach:"#9aa0a4",unten:"#2b2e31",glas:"#16191c",tuer:"#f3f3f3",ende:"#33373a",fenster:[{z0:1.85,z1:2.8}],baender:[{z0:1.1,z1:1.35,c:"#ec0016"}],tuerFenster:[1.9,2.8]},strom:true,typischL:[25.8,24.8,24.8,24.8,24.8,24.8,24.8,25.8]});
def("railjet",{name:"Railjet",b:2.9,boden:1.15,hoehe:4.05,front:{art:"stumpf",len:2.4,breiteSpitze:.8,hoeheSpitze:.85,schraeg:1.1,unten:.2,scheibe:[2.4,3.3],scheibeT:.85},
  tuerB:1.0,lack:{grund:"#8a1538",dach:"#7d8387",unten:"#2b2e31",glas:"#16191c",tuer:"#3c3f42",ende:"#33373a",fenster:[{z0:2.0,z1:2.95}],baender:[],tuerFenster:[2.0,2.95]},typischL:[26.5]});
// Trams und Metro (Niederflur, Gelenkwagen aus kurzen Modulen; Meterspur)
const TRAM=(id,name,lack,L,o={})=>def(id,Object.assign({name,b:2.4,boden:.35,hoehe:3.45,dachR:.3,spur:1.0,rad:.3,jak:true,tram:true,spalt:.15,strom:true,tuerB:1.3,fensterTeilung:1.5,
  front:{art:"stumpf",len:1.4,breiteSpitze:.78,hoeheSpitze:.9,schraeg:.8,unten:.3,scheibe:[.95,2.75],scheibeT:.85},
  lack:Object.assign({dach:"#c9cdd0",unten:"#2b2e31",glas:"#1d2328",ende:"#33373a",fenster:[{z0:1.05,z1:2.45}],tuerFenster:[.95,2.45]},lack,{steg:lack.steg||lack.grund}),typischL:L},o));
TRAM("tram_vbz","VBZ-Tram (Flexity/Cobra)",{grund:"#f3f4f6",tuer:"#0a59a8",baender:[{z0:.35,z1:.85,c:"#0a59a8"},{z0:2.6,z1:2.75,c:"#0a59a8"}],nase:[{z0:.35,z1:1.0,c:"#0a59a8",t:1}]},[6.4,5.4,7.2,5.4,7.2,5.4,6.4]);
TRAM("tram_cobra","VBZ Cobra",{grund:"#f3f4f6",tuer:"#0a59a8",baender:[{z0:.35,z1:.85,c:"#0a59a8"},{z0:2.6,z1:2.75,c:"#0a59a8"}],nase:[{z0:.35,z1:1.0,c:"#0a59a8",t:1}]},[8.2,6.4,6.6,6.4,8.2]);
TRAM("tram_bvb","BVB-Tram (Flexity)",{grund:"#1f8a3c",tuer:"#e9ecec",baender:[{z0:.35,z1:.7,c:"#156c2d"},{z0:2.6,z1:2.8,c:"#e9ecec"}]},[6.3,5.6,7.0,5.6,7.0,5.6,6.3],{b:2.3});
TRAM("tram_blt","BLT-Tram (Tango)",{grund:"#ffcf00",tuer:"#d0021b",baender:[{z0:.35,z1:.8,c:"#d0021b"}],nase:[{z0:.35,z1:1.0,c:"#d0021b",t:1}]},[9.5,6.3,9.3,6.3,9.5],{b:2.4,boden:.38});
TRAM("tram_bern","Bernmobil-Tram (Combino)",{grund:"#dc0018",tuer:"#e9ecec",baender:[{z0:.35,z1:.7,c:"#8f1018"},{z0:2.6,z1:2.8,c:"#e9ecec"}]},[7.3,5.7,6.2,5.7,6.2,5.7,7.3],{b:2.3});
TRAM("tram_tpg","TPG-Tram",{grund:"#eceeee",tuer:"#d6001c",baender:[{z0:.35,z1:.85,c:"#d6001c"}],nase:[{z0:.35,z1:1.0,c:"#d6001c",t:1}]},[8.0,6.0,8.0,6.0,8.0],{b:2.3});
TRAM("tram_lb","Limmattalbahn (Flexity)",{grund:"#f3f4f6",tuer:"#009aa6",baender:[{z0:.35,z1:.85,c:"#009aa6"}],nase:[{z0:.35,z1:1.0,c:"#009aa6",t:1}]},[6.4,5.4,7.2,5.4,7.2,5.4,6.4]);
TRAM("tram","Tram",{grund:"#eceeee",tuer:"#5b6670",baender:[{z0:.35,z1:.8,c:"#5b6670"}]},[7.5,6.0,7.5,6.0,7.5]);
TRAM("metro","Metro (m1/m2)",{grund:"#f1f2f3",tuer:"#e2001a",baender:[{z0:.35,z1:.9,c:"#e2001a"}],nase:[{z0:.35,z1:1.1,c:"#e2001a",t:1}]},[15.3,15.3],{b:2.45,hoehe:3.3,front:{art:"stromlinie",len:2.2,breiteSpitze:.6,hoeheSpitze:.75,schraeg:1.1,unten:.3,scheibe:[1.05,2.6],scheibeT:.85},jak:false,spalt:.3});
// Trams nach Unternehmen (GTFS agency_id)
const TRAM_AG={"3849":"tram_vbz","849":"tram_vbz","773":"tram_cobra","823":"tram_bvb","37":"tram_blt","827":"tram_bern","41":"tram_lb","151":"metro","881":"tram_tpg"};

// ---- Schiffe: Rumpf mit spitzem Bug, Deckhäuser mit Fenstern, Dampfer mit Schaufelradkästen und Kamin, Fähren mit Autodeck ----
// Ursprung = Wasserlinie Mitte; Länge L, Breite b (Rumpf), Freibord fb
function flaeche(B,P,col,innen){const n0=norm(kreuz(sub(P[1],P[0]),sub(P[2],P[0])));const m=P.reduce((a,q)=>[a[0]+q[0]/P.length,a[1]+q[1]/P.length,a[2]+q[2]/P.length],[0,0,0]);
  const n=(n0[0]*(m[0]-innen[0])+n0[1]*(m[1]-innen[1])+n0[2]*(m[2]-innen[2]))<0?[-n0[0],-n0[1],-n0[2]]:n0;
  if(P.length===3)B.dreieck(P[0],P[1],P[2],n,n,n,F(col));else B.viereck(P[0],P[1],P[2],P[3],n,n,n,n,F(col))}
function zylinder(B,cx,cy,r,z0,z1,col,deckel,n=12){for(let i=0;i<n;i++){const a=i/n*2*Math.PI,b=(i+1)/n*2*Math.PI,ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(b),sb=Math.sin(b);
  const na=[ca,sa,0],nb=[cb,sb,0];B.viereck([cx+r*ca,cy+r*sa,z0],[cx+r*cb,cy+r*sb,z0],[cx+r*cb,cy+r*sb,z1],[cx+r*ca,cy+r*sa,z1],na,nb,nb,na,F(col));
  if(deckel)B.dreieck([cx,cy,z1],[cx+r*ca,cy+r*sa,z1],[cx+r*cb,cy+r*sb,z1],[0,0,1],[0,0,1],[0,0,1],F(deckel))}}
function rumpf(B,S){const L=S.L,hb=S.b/2,N=32,fa=S.farben,X=[],Wd=[],Z=[];
  for(let i=0;i<=N;i++){const t=i/N;let w;
    if(S.art==="faehre"){const e=Math.min(t,1-t);w=hb*(e<.08?.55+.45*e/.08:1)}
    else if(t>.66){const u=(t-.66)/.34;w=hb*Math.sqrt(Math.max(0,1-u*u))}
    else if(t<.1)w=hb*(.7+.3*Math.sin(t/.1*Math.PI/2));else w=hb;
    X.push(-L/2+t*L);Wd.push(Math.max(w,.04));Z.push(S.fb+(S.art!=="faehre"&&t>.6?.8*((t-.6)/.4)**2:0))}
  for(let i=0;i<N;i++){const j=i+1,xa=X[i],xb=X[j],wa=Wd[i],wb=Wd[j],innen=[(xa+xb)/2,0,S.fb/2];
    const baender=[[()=>-.5,()=>.18,fa.boden],[()=>.18,k=>Z[k]-.5,fa.rumpf],[k=>Z[k]-.5,k=>Z[k],fa.streifen]];
    for(const sd of [1,-1])for(const [u,o,c] of baender)flaeche(B,[[xa,sd*wa,u(i)],[xb,sd*wb,u(j)],[xb,sd*wb,o(j)],[xa,sd*wa,o(i)]],c,innen);
    flaeche(B,[[xa,-wa,Z[i]],[xb,-wb,Z[j]],[xb,wb,Z[j]],[xa,wa,Z[i]]],fa.deck,[innen[0],0,-5]);
    // Reling (helle Brüstung) am Deckrand
    for(const sd of [1,-1])flaeche(B,[[xa,sd*(wa-.03),Z[i]],[xb,sd*(wb-.03),Z[j]],[xb,sd*(wb-.03),Z[j]+.95],[xa,sd*(wa-.03),Z[i]+.95]],fa.reling,innen)}
  const heck=k=>flaeche(B,[[X[k],-Wd[k],-.5],[X[k],Wd[k],-.5],[X[k],Wd[k],Z[k]],[X[k],-Wd[k],Z[k]]],fa.rumpf,[0,0,S.fb/2]);
  heck(0);if(S.art==="faehre")heck(N);return {X,Wd,Z}}
// Deckhaus mit Fensterband (einzelne Scheiben), Dach mit Überstand
function haus(B,x0,x1,b,z0,h,fa,fe,ohneDach){B.kiste(x0,x1,-b/2,b/2,z0,z0+h,fa.wand);
  if(fe){const f0=z0+fe[0],f1=z0+fe[1],tl=fe[2]||1.25,sp=fe[3]||.3;
    for(let x=x0+.5;x+tl<=x1-.3;x+=tl+sp){B.kiste(x,x+tl,b/2,b/2+.04,f0,f1,fa.glas);B.kiste(x,x+tl,-b/2-.04,-b/2,f0,f1,fa.glas)}
    B.kiste(x1,x1+.04,-b/2+.3,b/2-.3,f0,f1,fa.glas);B.kiste(x0-.04,x0,-b/2+.5,b/2-.5,f0,f1,fa.glas)}
  if(!ohneDach)B.kiste(x0-.3,x1+.3,-b/2-.3,b/2+.3,z0+h,z0+h+.18,fa.dach,false)}
function flagge(B,x,z){B.stab([x,0,z],[x,0,z+3.2],.07,"#d8d8d8");B.kiste(x-1.3,x-.05,-.02,.02,z+2.25,z+3.1,"#d52b1e",false);
  B.kiste(x-.83,x-.52,-.03,.03,z+2.45,z+2.9,"#ffffff",false);B.kiste(x-.9,x-.45,-.03,.03,z+2.6,z+2.75,"#ffffff",false)}
function bauSchiff(W){const S=W.T,L=W.L,hb=S.b/2,fa=S.farben,B=new Puffer();const R=rumpf(B,{...S,L});const fb=S.fb;
  if(S.art==="faehre"){
    const yh=hb*.42;B.kiste(-L*.3,L*.3,yh,hb-.15,fb,fb+2.6,fa.wand);   // Aufbau an der Seite
    for(let x=-L*.3+.6;x<L*.3-1.5;x+=1.6)B.kiste(x,x+1.2,yh-.04,yh,fb+1.1,fb+2.1,fa.glas);
    B.kiste(-L*.32,L*.32,yh-.2,hb+.1,fb+2.6,fb+2.78,fa.dach,false);
    B.kiste(-L*.06,L*.06,-hb+.3,hb-.2,fb+4.6,fb+6.6,fa.wand);B.kiste(-L*.06-.04,L*.06+.04,-hb+.6,hb-.5,fb+5.4,fb+6.3,fa.glas);   // Brücke quer über das Deck
    B.kiste(-L*.07,L*.07,-hb+.2,hb-.1,fb+6.6,fb+6.8,fa.dach,false);B.kiste(-L*.03,L*.03,-hb+.3,-hb+1.0,fb,fb+4.6,fa.wand);
    const autos=["#b3121b","#2a2d30","#d7d9db","#1f4e8c","#8a8f94","#e6e6e6","#3b5f3a","#5a3b2a"];let k=0;
    for(let y=-hb+1.7;y<yh-1.3;y+=2.5)for(let x=-L*.42;x<L*.42-4.5;x+=5.6){if((k*7+3)%5===0){k++;continue}const c=autos[k++%autos.length];
      B.kiste(x,x+4.4,y-.9,y+.9,fb,fb+.8,c);B.kiste(x+1.1,x+3.4,y-.8,y+.8,fb+.8,fb+1.45,c);B.kiste(x+1.15,x+3.35,y-.82,y+.82,fb+.9,fb+1.35,"#20262b")}
    return B}
  if(S.art==="klein"){haus(B,-L*.32,L*.26,S.b*.78,fb,2.2,fa,[.7,1.85,1.1,.25]);flagge(B,-L/2+.5,fb);return B}
  if(S.art==="dampfer"){
    // Schaufelradkästen (halbe Scheiben quer zum Schiff)
    const xc=-L*.02,Rk=2.7,zc=.2,n=10;for(const sd of [1,-1]){const y0=sd*hb,y1=sd*(hb+1.7);
      for(let i=0;i<n;i++){const a=i/n*Math.PI,b=(i+1)/n*Math.PI,pa=[xc+Rk*Math.cos(a),zc+Rk*Math.sin(a)],pb=[xc+Rk*Math.cos(b),zc+Rk*Math.sin(b)];
        flaeche(B,[[pa[0],y0,pa[1]],[pb[0],y0,pb[1]],[pb[0],y1,pb[1]],[pa[0],y1,pa[1]]],fa.rumpf,[xc,(y0+y1)/2,zc]);
        flaeche(B,[[xc,y1,zc],[pa[0],y1,pa[1]],[pb[0],y1,pb[1]]],i%2?fa.rumpf:fa.streifen,[xc,y0,zc])}}
    haus(B,-L*.38,L*.3,S.b*.86,fb,2.5,fa,[.85,2.0,1.4,.35]);
    haus(B,-L*.2,L*.06,S.b*.62,fb+2.68,2.2,fa,[.7,1.7,1.2,.3]);
    B.kiste(xc-.9,xc+.9,-hb-1.7,hb+1.7,fb+2.68,fb+2.95,fa.dach,false);B.kiste(xc-1.1,xc+1.1,-1.3,1.3,fb+2.95,fb+4.8,fa.wand);B.kiste(xc+1.1,xc+1.14,-1.0,1.0,fb+3.7,fb+4.5,fa.glas);
    zylinder(B,xc-3.2,0,.85,fb+2.6,fb+8.6,fa.kamin);zylinder(B,xc-3.2,0,.87,fb+8.6,fb+9.4,"#1d1d1d","#111111");
    B.stab([L*.36,0,R.Z[28]],[L*.36,0,R.Z[28]+6],.12,"#cfcfcf");flagge(B,-L/2+.6,fb);return B}
  // Motorschiff
  haus(B,-L*.4,L*.22,S.b*.84,fb,2.5,fa,[.85,2.05]);
  haus(B,-L*.28,L*.1,S.b*.7,fb+2.68,2.3,fa,[.8,1.85]);
  haus(B,L*.03,L*.14,S.b*.46,fb+5.16,1.9,fa,[.75,1.55,1.0,.2]);
  B.stab([L*.12,0,fb+7.24],[L*.12,0,fb+10.2],.12,"#d0d0d0");flagge(B,-L/2+.6,fb);return B}
const SCHIFF_FARBEN=(streifen,o={})=>Object.assign({rumpf:"#f3f3f1",streifen,boden:"#26292c",deck:"#9a9fa4",reling:"#e9eaea",wand:"#f1f1ee",glas:"#1d2328",dach:"#d6d9da",kamin:"#d9a92f"},o);
// Unternehmen (GTFS agency_id) → Grösse, Farben, Anteil Raddampfer (welches Schiff auf einer Fahrt läuft, steht nicht im Fahrplan)
const SCHIFF_AG={"185":[50,9.5,"#1b3d7a",.25],"194":[50,9,"#0a59a8",.15],"183":[42,8.2,"#1f6f43",.1],"192":[46,8.6,"#1f6f43",.08],"184":[56,10,"#c4161c",.35],
  "189":[40,8,"#1c4f9c"],"188":[36,7.4,"#003d7c"],"190":[36,7.4,"#003d7c"],"360":[52,10,"#c8102e"],"195":[50,9.6,"#c8102e"],"199":[16,4.6,"#e8b400",0,"klein"],
  "182":[42,8,"#0067b1"],"181":[33,7,"#2a7ab0"],"197":[32,7,"#0a4f8a"],"3181":[22,5.5,"#2f6f9f",0,"klein"],"186":[38,7.5,"#005ca9"],"179":[29,6.5,"#1f6b9a"],
  "191":[56,9.5,"#1b4d9b"],"180":[28,6.4,"#2a6f97"],"193":[40,7.8,"#2e7d32"],"3183":[24,5.6,"#1e5f8c",0,"klein"],"3199":[24,6,"#0e4c7a",0,"klein"],"3182":[13,4.5,"#3c8d2f",0,"klein"]};
const FAEHRE_AG={"196":[60,14],"3190":[44,11],"360":[70,16],"195":[70,16]};
function schiffTyp(ag,fae,schluesselZahl){const a=SCHIFF_AG[ag]||[34,7,"#2b5d8a"];
  let art=a[4]||"ms",L=a[0],b=a[1];if(fae){art="faehre";const f=FAEHRE_AG[ag]||[40,10.5];L=f[0];b=f[1]}
  else if(a[3]&&(schluesselZahl%1000)/1000<a[3]){art="dampfer";L=Math.max(L,58);b=Math.max(8.4,b*.9)}
  const id="schiff_"+ag+"_"+art;if(!T[id])def(id,{name:art==="dampfer"?"Raddampfer":art==="faehre"?"Autofähre":"Motorschiff",schiff:true,art,b,fb:art==="faehre"?1.25:art==="klein"?.9:1.45,
    farben:SCHIFF_FARBEN(a[2],art==="dampfer"?{wand:"#f2ead6",deck:"#a8865a",dach:"#efe7d2"}:art==="faehre"?{deck:"#5a5f64",streifen:"#2b2e31"}:{}),typischL:[L]});return id}

// ---- Bergbahnen: Standseilbahnwagen (wird beim Zeichnen geschert, Wände bleiben senkrecht), Kabinen und Sessel ----
// Kabinen: Ursprung = Tragseil (z = 0), die Kabine hängt darunter.
function bauBergbahn(W){const S=W.T,B=new Puffer(),L=W.L,b=S.b;
  if(S.art==="FUN"){const fa={wand:S.farbe,glas:"#1d2328",dach:"#d6d9da"};
    B.kiste(-L/2+.6,L/2-.6,-b/2+.3,b/2-.3,.1,.75,"#2b2e31");B.kiste(-L/2,L/2,-b/2,b/2,.75,1.5,S.farbe);B.kiste(-L/2,L/2,-b/2,b/2,1.5,3.25,"#f2f2f0");
    for(let x=-L/2+.4;x+1.1<=L/2-.3;x+=1.5){B.kiste(x,x+1.1,b/2,b/2+.04,1.75,2.95,fa.glas);B.kiste(x,x+1.1,-b/2-.04,-b/2,1.75,2.95,fa.glas)}
    for(const e of [-1,1])B.kiste(e>0?L/2:-L/2-.04,e>0?L/2+.04:-L/2,-b/2+.3,b/2-.3,1.7,3.0,fa.glas);
    B.kiste(-L/2-.05,L/2+.05,-b/2-.05,b/2+.05,3.25,3.42,fa.dach,false);return B}
  // Laufwerk am Seil und Gehänge
  const hz=S.haenge;B.kiste(-S.lw/2,S.lw/2,-.25,.25,-.35,.35,"#4a4f54",false);B.stab([0,0,-.2],[0,0,-hz],.18,"#5b6166");
  if(S.art==="SL"){B.kiste(-.35,.35,-b/2,b/2,-hz-.1,-hz+.05,"#3a3f44",false);B.kiste(-.45,.35,-b/2,b/2,-hz-.55,-hz-.4,S.farbe,false);B.kiste(-.5,-.38,-b/2,b/2,-hz-.4,-hz+.2,S.farbe,false);
    B.kiste(.35,.75,-b/2,b/2,-hz-1.25,-hz-1.15,"#3a3f44",false);B.kiste(-.05,.05,-b/2,-b/2+.08,-hz-.05,-hz+1.2,"#3a3f44",false);return B}
  const kh=S.kh,z1=-hz,z0=z1-kh;
  B.kiste(-L/2,L/2,-b/2,b/2,z0,z0+.5,S.farbe,false);B.kiste(-L/2,L/2,-b/2,b/2,z0+.5,z1-.35,"#c9d3d8",false);B.kiste(-L/2+.1,L/2-.1,-b/2+.1,b/2-.1,z1-.35,z1,S.farbe,false);
  const gl="#22303a";for(const e of [-1,1]){B.kiste(-L/2+.15,L/2-.15,e>0?b/2:-b/2-.04,e>0?b/2+.04:-b/2,z0+.65,z1-.5,gl);B.kiste(e>0?L/2:-L/2-.04,e>0?L/2+.04:-L/2,-b/2+.15,b/2-.15,z0+.65,z1-.5,gl)}
  return B}
const BB_TYP={FUN:{art:"FUN",b:2.7,L:16,farbe:"#c8102e"},PB:{art:"PB",b:3.0,L:6.5,haenge:5.2,kh:2.7,lw:4.5,farbe:"#c8102e"},GB:{art:"GB",b:1.9,L:2.3,haenge:2.4,kh:2.1,lw:.9,farbe:"#d01f2a"},
  SL:{art:"SL",b:3.6,L:1.2,haenge:2.4,lw:.7,farbe:"#e8761a"},LB:"PB",SB:"PB",KB:"GB"};
const GONDEL_FARBEN=["#d01f2a","#1f5fae","#e8a317","#2f8f46","#9aa5ab"];
function bergbahnTyp(cat,zahl){let t=BB_TYP[cat];if(typeof t==="string")t=BB_TYP[t];if(!t)t=BB_TYP.PB;
  const farbe=t.art==="GB"?GONDEL_FARBEN[zahl%GONDEL_FARBEN.length]:t.farbe,id="bb_"+t.art+"_"+farbe.slice(1);
  if(!T[id])def(id,Object.assign({name:{FUN:"Standseilbahn",PB:"Luftseilbahn",GB:"Gondelbahn",SL:"Sesselbahn"}[t.art],bergbahn:true,typischL:[t.L]},t,{farbe}));return id}

// Rückfall: unbekannter Wagen
def("wagen",{name:"Personenwagen",b:2.85,boden:1.15,hoehe:4.0,front:{art:"stumpf",len:2,breiteSpitze:.82,hoeheSpitze:.86,schraeg:.9,scheibe:[2.4,3.2]},
  tuerB:1.1,fensterTeilung:2.2,lack:{...SBB_FV,fenster:[{z0:2.05,z1:2.95}],baender:[{z0:1.15,z1:1.4,c:"#3a3e42"}],tuerFenster:[2.1,2.95]},typischL:[26.4]});
def("lok",{name:"Lokomotive",b:3.0,boden:1.2,hoehe:4.2,front:{art:"stumpf",len:2.0,breiteSpitze:.75,hoeheSpitze:.82,schraeg:1.1,unten:.3,scheibe:[2.75,3.5],scheibeT:.85},
  lack:{grund:ROT,dach:"#5d6266",unten:"#2b2e31",glas:"#16191c",front:ROT,baender:[{z0:1.2,z1:1.45,c:"#2b2e31"}],fenster:[]},rolle:"lok",strom:2,typischL:[18.5]});

// Fahrzeugtyp aus der Formation (typeCodeName, z. B. «RABe511_1», «Re460», «Bt») → Baureihe
const REGELN=[
  [/RABe?_?501|Giruno/i,"giruno"],[/RABD?e_?502|Twindexx|FV.?Dosto/i,"fvdosto"],[/RABD?e_?500|ICN/i,"icn"],[/RABe?_?503|ETR.?610|Astoro/i,"astoro"],
  [/RABe?_?51[12]|KISS/i,"dosto_rv"],[/RABe?_?514|DTZ/i,"dtz"],[/RABe?_?515|MUTZ/i,"mutz"],[/RABe?_?525|NINA|RABe?_?52[78]|MIKA|RABe?_?535|Lötschberger/i,"bls_flirt"],
  [/RABe?_?52[1234]|FLIRT/i,"flirt"],[/RABe?_?526.?[012]\d\d|Traverso/i,"traverso"],[/RABe?_?52[06]|GTW/i,"gtw"],[/RBDe?_?56[0-2]|Domino|NPZ/i,"domino"],
  [/Re_?4[6]0|Re_?465/i,"re460"],[/Re_?4[24]0|Re_?474|Re_?482|Re_?620|Re_?4\/4|Lok/i,"lok"],
  [/ABe_?8\/12|Allegra|ABe_?4\/16|Capricorn/i,"allegra"],[/Ge_?4\/4/i,"rhb_lok"],[/ABe_?1[3-6]0|ADLER|FINK|SPATZ/i,"zb"],
  [/TGV|Lyria|Euroduplex/i,"tgv"],[/ICE|BR_?4\d\d/i,"ice"],[/Railjet|RJ|Taurus|1116|1216/i,"railjet"],
  [/IC2000|IC.?2000|DB?z|AB?z|Bt_?IC|DPZ|Doppelstock/i,"ic2000"],[/EW.?IV|Bpm|Apm|WRm|Bt/i,"ew4"]];
// Rückfall nach Unternehmen / Linie, wenn keine Formation bekannt ist
const AG_FAMILIE={"11":"flirt","65":"thurbo","33":"bls_flirt","82":"traverso","72":"allegra","86":"zb","78":"flirt","22":"schmalspur","88":"schmalspur","35":"schmalspur","48":"schmalspur","93":"schmalspur","55":"schmalspur","23":"schmalspur","43":"schmalspur","29":"schmalspur","53":"schmalspur"};

// Zug ohne Formation: aus Kategorie, Linie und Unternehmen eine plausible Zusammensetzung
function rueckfall(cat,linie,ag,zahl){const fv=/^(IC|IR|EC|ICE|TGV|RJX|RJ|EN|NJ)$/.test(cat);
  if(BB_TYP[cat]){const f=bergbahnTyp(cat,Math.abs(zahl|0));return [{f,L:T[f].typischL[0]+(T[f].art==="FUN"?0:.6),k:"2",g:0}]}
  if(/^(BAT|FAE|SCH|Schiff)$/i.test(cat)){const f=schiffTyp(ag,/^FAE$/i.test(cat),Math.abs(zahl|0)*2654435761>>>0);return [{f,L:T[f].typischL[0],k:"2",g:0}]}
  if(cat==="Tram"||cat==="M"){let f=cat==="M"?"metro":TRAM_AG[ag]||(/gen[eè]v|tpg/i.test(ag)?"tram_tpg":"tram");
    if(f==="tram_vbz"&&(+linie)%2===1)f="tram_cobra";   // Zürich: grob Flexity und Cobra gemischt
    return T[f].typischL.map(L=>({f,L,k:"2",g:0}))}
  let f=AG_FAMILIE[ag]||"flirt";
  if(cat==="TGV")f="tgv";else if(cat==="ICE")f="ice";else if(cat==="RJX"||cat==="RJ")f="railjet";
  else if(ag==="11"&&fv){if(cat==="IC"&&/^(5|51|61)$/.test(linie))f="icn";else if(cat==="IC"&&/^(2|21)$/.test(linie))f="giruno";else if(cat==="EC")f="giruno";else if(cat==="IR"&&/^(13|70)$/.test(linie))f="fvdosto";else f="ic2000"}
  else if(ag==="11"&&cat==="S"&&/^(2|3|5|6|7|8|9|11|12|14|15|16|19|20|21|23|24|25|26|29|30|35|36|40|41)$/.test(linie))f="dtz";
  else if(ag==="11"&&(cat==="RE"||cat==="R")&&/^(2|3|5|6|7|8)$/.test(linie))f="dosto_rv";
  else if(ag==="11"&&cat==="IR")f="ic2000";
  const t=T[f];let wagen=t.typischL.map((L,i)=>({f,L,k:"2",g:0}));
  if(f==="ic2000")wagen=[{f:"re460",L:18.5,k:"X",g:0},...Array.from({length:8},(_,i)=>({f:"ic2000",L:26.8,k:i<2?"1":"2",g:1+i}))];
  if(f==="railjet")wagen=[{f:"lok",L:19.3,k:"X",g:0},...Array.from({length:7},(_,i)=>({f:"railjet",L:26.5,k:"2",g:1+i}))];
  return wagen}
// Formation (Kompaktformat vom Server) → Wagenliste
function ausFormation(s){if(!s)return null;const w=s.split(";").map(q=>{const a=q.split(",");return {typ:a[0],L:+a[1]||0,k:a[2]||"2",g:+a[3]||0,von:a[4]?+a[4]:0,bis:a[5]?+a[5]:0}});
  for(const v of w){v.f=(REGELN.find(r=>r[0].test(v.typ))||[0,v.k==="X"?"lok":"wagen"])[1];if(!v.L)v.L=T[v.f].typischL[0]}
  return w}

// Wagenliste → Bauteile: je Wagen Baureihe, Länge, Führerstände, Türen, Drehgestelle
function wagenTeile(wagen){const n=wagen.length;
  return wagen.map((v,i)=>{const t=T[v.f],vorher=wagen[i-1],nachher=wagen[i+1];
    const gleichV=vorher&&vorher.g===v.g&&vorher.f===v.f,gleichH=nachher&&nachher.g===v.g&&nachher.f===v.f;
    const istLok=t.rolle==="lok";
    // Führerstand: Triebzug an den Einheitsenden; Lok immer; Wagenzug: Steuerwagen (Bt/«t» im Typ) am Zugende
    let kabV=istLok||(!gleichV&&t.strom&&!istLok),kabH=istLok||(!gleichH&&t.strom&&!istLok);
    if(!t.strom&&!istLok){const steuer=/t(_|$)|Bt|ABt/i.test(v.typ||"");if(steuer){kabV=!vorher;kabH=!nachher&&!kabV}}
    const sp=t.spalt||.3,L=Math.max(3,v.L-sp*1.7),art=!!t.jak;   // Kasten etwas kürzer als über Puffer
    const tuerAbst=L>20?L/2-3.2:L/2-2.2,tueren=t.tram?(L>=4?[kabV?-.8:kabH?.8:0]:[]):istLok?[]:L<8?[]:t.id==="ew4"||t.id==="wagen"||t.id==="rhb_wagen"?[L/2-.9,-L/2+.9]:[tuerAbst,-tuerAbst];
    return {T:t,L,kabV,kabH,tueren,rolle:istLok?"lok":"wagen",jakobs:art?{v:gleichV,h:gleichH}:null,spalt:sp,strom:t.strom===2||(t.strom&&i===mitteDerEinheit(wagen,i))?1:0}})}
function mitteDerEinheit(w,i){let a=i,b=i;while(a>0&&w[a-1].g===w[i].g&&w[a-1].f===w[i].f)a--;while(b<w.length-1&&w[b+1].g===w[i].g&&w[b+1].f===w[i].f)b++;return Math.floor((a+b)/2)}

// Geometrie eines Wagens (zwischengespeichert nach Baureihe, Länge und Führerständen)
const CACHE={};
const schluessel=W=>W._k||(W._k=[W.T.id,W.L.toFixed(1),+W.kabV,+W.kabH,W.jakobs?(+W.jakobs.v)+""+(+W.jakobs.h):"-",W.strom].join("|"));
function bauWagen(W){const k=schluessel(W);if(CACHE[k])return CACHE[k];
  const sonder=W.T.schiff||W.T.bergbahn,B=W.T.schiff?bauSchiff(W):W.T.bergbahn?bauBergbahn(W):new Puffer();if(!sonder){kasten(B,W);fahrwerk(B,W);}
  if(W.strom&&!sonder)stromabnehmer(B,W.T,W.T.tram?0:W.rolle==="lok"?W.L/2-4:W.L/4);
  if(!sonder&&W.rolle!=="lok"&&W.T.strom&&W.L>8)dachKiste(B,W.T,-W.L/2+3,-W.L/2+6,1.6,.35);
  const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(B.p,3));g.setAttribute("normal",new THREE.Float32BufferAttribute(B.n,3));g.setAttribute("color",new THREE.Float32BufferAttribute(B.c,3));
  g.computeBoundingSphere();return CACHE[k]=g}
return {T,bauWagen,schluessel,wagenTeile,ausFormation,rueckfall,REGELN}})();

export { ZM };
