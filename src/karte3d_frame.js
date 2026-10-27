// Fahrzeuge zeichnen: GeoJSON-Ebene «fz», etwa 15-mal pro Sekunde neu
let colors={};
function readColors(){const cs=getComputedStyle(document.documentElement);const g=n=>cs.getPropertyValue(n).trim();
  colors={d0:g("--ok"),d1:g("--late"),d2:"#e5484d",dn:"#9aa5ab",late:g("--late"),fv:g("--tfv"),rv:g("--trv"),s:g("--ts"),tr:g("--ttr"),sch:g("--tsch"),sel:"#e3a008"}}
readColors();try{matchMedia("(prefers-color-scheme: dark)").addEventListener("change",readColors)}catch(e){}
new MutationObserver(readColors).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme"]});
let visible=[], sel=null, slowT=0, fzT=0, lateN=0, cancN=0;
const REIHE="trschsrvfv";
function frame(now){const dt=Math.min(now-lastReal,1000);lastReal=now;simMs+=dt*speed;
  sperrHeute=SPERR.teile.size>0&&SPERR.datum===zh(simMs).date;
  $("clk").textContent=clockSec(simMs);
  if(mapBereit&&now-fzT>=66){fzT=now;
    const counts={fv:0,rv:0,s:0,tr:0,sch:0},dcount={d0:0,d1:0,d2:0,dn:0},fs=[],seen=new Set();visible=[];lateN=0;cancN=0;
    const b=map.getBounds(),W0=b.getWest()-.05,E0=b.getEast()+.05,S0=b.getSouth()-.05,N0=b.getNorth()+.05,zoom=map.getZoom();
    const mit3dZ=zoom>=Z3D;if(mit3dZ)z3Laden();const z3=mit3dZ&&Z3.bereit;Z3.liste=[];Z3.hBudget=6;if(z3)Z3.ursprung=maplibregl.MercatorCoordinate.fromLngLat(map.getCenter());
    for(const sv of services(simMs)){const t=sv.t;
      for(const tr of sv.runs){const rt=rtFor(tr,sv.o);if(rt&&rt.canc){if(t>=rt.t0-5&&t<=rt.t1)cancN++;continue}const T0=rt?rt.t0:tr.t0,T1=rt?rt.t1:tr.t1;if(t<T0||t>T1)continue;
        const p=trainPos(tr,t,rt);if(!p)continue;const dl=delayNow(rt,p);if(dl>=180)lateN++;
        const sk=tr.label+"|"+tr.st[0].i+"|"+(tr.t0-sv.o);if(sv.o){seen.add(sk)}else if(seen.has(sk))continue;
        counts[tr.cls]++;if(!onTr[tr.cls])continue;if(tr.cls==="tr"&&zoom<11)continue;
        const ll=wgs(p.x,p.y);if(ll[0]<W0||ll[0]>E0||ll[1]<S0||ll[1]>N0)continue;
        const dc=DCLS(rt?dl:null);dcount[dc]++;const isSel=!!sel&&tr===sel.tr,isLate=colMode!=="vsp"&&dl>=180;
        const d3=z3&&tr.cls!=="tr"&&tr.cls!=="sch"&&z3Zug(tr,sv.o,p,isSel)?1:0;
        fs.push({type:"Feature",properties:{k:visible.length,c:tr.cls,f:colMode==="vsp"?colors[dc]:colors[tr.cls],r:isSel?colors.sel:isLate?colors.late:"#ffffff",
          w:isSel?3.5:isLate?2.4:1.3,d3,g:(tr.cls==="tr"?0.72:1)*(isSel?1.5:1),o:isSel?1:0,l:(tr.label+(dl>=60?" "+fmtDelay(dl):"")).replace(/[^\x00-\xff]/g,"'"),z:tr.to},geometry:{type:"Point",coordinates:ll}});
        visible.push({tr,o:sv.o,p,dl,rt})}}
    fs.sort((a,b)=>a.properties.o-b.properties.o||REIHE.indexOf(a.properties.c)-REIHE.indexOf(b.properties.c));
    map.getSource("fz").setData(fc(fs));lastCounts=counts;lastD=dcount;if(Z3.bereit)map.triggerRepaint()}
  if(now-slowT>500){slowT=now;const counts=lastCounts,dcount=lastD;
    $("live").textContent=`· ${counts.fv+counts.rv+counts.s+counts.tr+counts.sch} unterwegs`+(rtStats.on?` · ${lateN} verspätet · ${cancN} fallen aus`:"");
    document.querySelectorAll("#tlegend .n").forEach((n,j)=>n.textContent=colMode==="vsp"?dcount[["d0","d1","d2","dn"][j]]:counts[KLASSEN[j]]);
    const z=zh(simMs);fpBrauche(simMs);$("daytype").textContent=DATED[z.date]?`Fahrplan vom ${+z.date.slice(8)}.${+z.date.slice(5,7)}.${z.date.slice(0,4)}`:`Fahrplan ${DAYNAME[dayType(z.wd)]}`;
    if(sel)showTrain(sel.tr,sel.o,false);else if(selSt&&$("deps"))renderDeps(selSt)}
  requestAnimationFrame(frame)}
requestAnimationFrame(frame);
