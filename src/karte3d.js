// ===== Karte: MapLibre GL mit swisstopo-Grundkarte und 3D-Gelände (Mapterhorn) =====
// Kartenkoordinaten (LV95/100) → WGS84 (Näherungsformeln swisstopo)
function wgs(x,y){const E=x*100+2480000,N=1300000-y*100,yy=(E-2600000)/1e6,xx=(N-1200000)/1e6;
  const l=2.6779094+4.728982*yy+0.791484*yy*xx+0.1306*yy*xx*xx-0.0436*yy*yy*yy;
  const p=16.9023892+3.238272*xx-0.270978*yy*yy-0.002528*xx*xx-0.0447*yy*yy*xx-0.0140*xx*xx*xx;
  return [Math.round(l*100/36*1e6)/1e6,Math.round(p*100/36*1e6)/1e6]}
const wrap=$("wrap");
let moved=false;
const names=Object.keys(ST).sort((a,b)=>tier(b)-tier(a));
const CH_BOX=[[5.95,45.82],[10.49,47.81]];
maplibregl.setWorkerUrl("lib/maplibre-gl-csp-worker.js?v="+((window.ZK_LOCAL&&window.ZK_LOCAL.version)||"1"));
let mit3d=true;try{mit3d=localStorage.getItem("zk3d")!=="aus"}catch(e){}
const map=new maplibregl.Map({container:"map",style:"https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json",
  bounds:CH_BOX,fitBoundsOptions:{padding:20},pitch:mit3d?35:0,maxPitch:80,
  attributionControl:{compact:true,customAttribution:"Gelände © <a href='https://mapterhorn.com/attribution'>Mapterhorn</a> · Fahrplan opentransportdata.swiss · Tram/Schiff © OpenStreetMap"}});
map.addControl(new maplibregl.ScaleControl({unit:"metric"}),"bottom-left");
let mapBereit=false;
function apply(){}   // die 2D-Karte zeichnet hier neu; MapLibre macht das selbst
function fit(box){const a=wgs(box[0],box[3]),b=wgs(box[2],box[1]);map.fitBounds([a,b],{padding:60,maxZoom:14,duration:900})}
function hinZu(x,y,z){map.easeTo({center:wgs(x,y),zoom:Math.max(map.getZoom(),z),duration:900})}
function setze3d(an){mit3d=an;try{localStorage.setItem("zk3d",an?"an":"aus")}catch(e){}$("z3d").setAttribute("aria-pressed",an);if(!mapBereit)return;
  if(an){map.setTerrain({source:"dem",exaggeration:1.3});if(map.getPitch()<20)map.easeTo({pitch:55,duration:900})}else{map.setTerrain(null);map.easeTo({pitch:0,bearing:0,duration:900})}}
$("zin").onclick=()=>map.zoomIn();$("zout").onclick=()=>map.zoomOut();
$("zreset").onclick=()=>map.fitBounds(CH_BOX,{padding:20,pitch:mit3d?35:0,bearing:0,duration:1000});
$("z3d").setAttribute("aria-pressed",mit3d);$("z3d").onclick=()=>setze3d(!mit3d);
// Ebenen-Daten
const fc=f=>({type:"FeatureCollection",features:f});
const bahnFC=fc(LINES.map((L,i)=>({type:"Feature",id:i,properties:{i,t:L.type,n:L.name},geometry:{type:"MultiLineString",coordinates:L.parts.map(p=>p.map(q=>wgs(q[0],q[1])))}})));
const stFC=fc(names.map((n,j)=>({type:"Feature",id:j,properties:{n,t:tier(n)},geometry:{type:"Point",coordinates:wgs(X(ST[n]),Y(ST[n]))}})));
const oevFC=a=>fc(OEV[a].map(k=>({type:"Feature",properties:{n:k.replace("|"," – ")},geometry:{type:"LineString",coordinates:decK(KANTEN[k]).map(q=>wgs(q[0],q[1]))}})));
const FARBE_LN={fv:"#16222b",rv:"#22808f",sm:"#b5612a"};
const SCHRIFT="Frutiger Neue Condensed Bold", SCHRIFT_M="Frutiger Neue Condensed Medium";
map.on("load",()=>{
  map.addSource("dem",{type:"raster-dem",tiles:["https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"],encoding:"terrarium",tileSize:512,maxzoom:14});
  try{map.setSky({"sky-color":"#bcd7ea","horizon-color":"#e8eef2","fog-color":"#e8eef2","sky-horizon-blend":0.6,"horizon-fog-blend":0.4,"fog-ground-blend":0.6})}catch(e){}
  map.addSource("schiff",{type:"geojson",data:MIT_OEV?oevFC("s"):fc([])});
  map.addSource("tram",{type:"geojson",data:MIT_OEV?oevFC("t"):fc([])});
  map.addSource("bahn",{type:"geojson",data:bahnFC});
  map.addSource("sperren",{type:"geojson",data:fc([])});
  map.addSource("st",{type:"geojson",data:stFC});
  map.addSource("fz",{type:"geojson",data:fc([])});
  map.addLayer({id:"schiff",type:"line",source:"schiff",paint:{"line-color":"#3d86b8","line-width":1.4,"line-dasharray":[3,2],"line-opacity":.8}});
  map.addLayer({id:"tram",type:"line",source:"tram",minzoom:11,paint:{"line-color":"#5f7380","line-width":["interpolate",["linear"],["zoom"],11,.8,16,2.5],"line-opacity":.75}});
  map.addLayer({id:"bahn-hl",type:"line",source:"bahn",filter:["==",["get","i"],-1],layout:{"line-join":"round","line-cap":"round"},paint:{"line-color":"#e3a008","line-width":["interpolate",["linear"],["zoom"],7,6,14,10]}});
  map.addLayer({id:"bahn",type:"line",source:"bahn",layout:{"line-join":"round","line-cap":"round"},paint:{"line-color":["match",["get","t"],"fv",FARBE_LN.fv,"sm",FARBE_LN.sm,FARBE_LN.rv],
    "line-width":["interpolate",["linear"],["zoom"],7,["match",["get","t"],"fv",2,1.4],14,["match",["get","t"],"fv",4.5,3.2]],
    "line-opacity":["case",["boolean",["feature-state","dim"],false],.18,1]}});
  map.addLayer({id:"sperren",type:"line",source:"sperren",filter:["==",["geometry-type"],"LineString"],paint:{"line-color":"#e5484d","line-width":["interpolate",["linear"],["zoom"],7,3,14,6],"line-dasharray":[2,1.5]}});
  map.addLayer({id:"sperren-z",type:"circle",source:"sperren",filter:["==",["geometry-type"],"Point"],paint:{"circle-color":"#e5484d","circle-radius":7,"circle-stroke-color":"#ffffff","circle-stroke-width":1.5,"circle-pitch-alignment":"viewport"}});
  map.addLayer({id:"sperren-zt",type:"symbol",source:"sperren",filter:["==",["geometry-type"],"Point"],layout:{"text-field":"-","text-font":[SCHRIFT],"text-size":18,"text-allow-overlap":true,"text-ignore-placement":true},paint:{"text-color":"#ffffff"}});
  // Achtung: Schriften der Grundkarte nur für Zeichen bis U+00FF – andere Zeichen lassen ganze Ebenen ausfallen
  // Bahnhöfe in drei Stufen (wichtige zuerst sichtbar)
  for(const t of [2,1,0])map.addLayer({id:"st"+t,type:"circle",source:"st",filter:["==",["get","t"],t],minzoom:[10,8,0][t],paint:{
    "circle-color":["case",["boolean",["feature-state","sel"],false],"#e3a008","#ffffff"],"circle-stroke-color":"#16222b",
    "circle-radius":["interpolate",["linear"],["zoom"],7,[4.5,3.5,2.5][t],13,[7,5.5,4.5][t]],"circle-stroke-width":[2,1.6,1.2][t],"circle-pitch-alignment":"viewport"}});
  for(const t of [2,1,0])map.addLayer({id:"stl"+t,type:"symbol",source:"st",filter:["==",["get","t"],t],minzoom:[11.5,9,6.5][t],layout:{"text-field":["get","n"],
    "text-font":[t===0?SCHRIFT:SCHRIFT_M],"text-size":[14,12.5,11.5][t],"text-anchor":"left","text-offset":[0.8,0],"text-optional":true},
    paint:{"text-color":"#16222b","text-halo-color":"#ffffff","text-halo-width":1.6}});
  // Fahrzeuge (Daten aus frame())
  map.addLayer({id:"fz",type:"circle",source:"fz",paint:{"circle-color":["get","f"],"circle-stroke-color":["get","r"],"circle-stroke-width":["get","w"],"circle-pitch-alignment":"viewport",
    "circle-radius":["interpolate",["linear"],["zoom"],7,["*",["get","g"],2.6],11,["*",["get","g"],4.4],15,["*",["get","g"],7]]}});
  map.addLayer({id:"fz-l",type:"symbol",source:"fz",minzoom:12.5,filter:["any",["!=",["get","c"],"tr"],[">=",["zoom"],14.5]],layout:{"text-field":["get","l"],"text-font":[SCHRIFT],"text-size":11,
    "text-anchor":"bottom-left","text-offset":[0.6,-0.4],"text-optional":true},paint:{"text-color":"#16222b","text-halo-color":"#ffffff","text-halo-width":1.5}});
  // Bedienung: Hinweise beim Überfahren, Klick wählt Fahrzeug, Bahnhof oder Strecke
  const tipAn=(L,txt)=>{map.on("mousemove",L,e=>{map.getCanvas().style.cursor="pointer";showTip(txt(e.features[0]),e.originalEvent)});map.on("mouseleave",L,()=>{map.getCanvas().style.cursor="";hideTip()})};
  for(const t of [0,1,2])tipAn("st"+t,f=>f.properties.n);
  tipAn("bahn",f=>f.properties.n);tipAn("fz",f=>f.properties.l+" → "+f.properties.z);tipAn("tram",f=>"Tram: "+f.properties.n);tipAn("schiff",f=>"Schiff: "+f.properties.n);
  for(const L of ["sperren","sperren-z"])tipAn(L,()=>"Gesperrt: heute kein Zugverkehr (Bahnersatz)");
  map.on("click",e=>{const p=e.point,box=[[p.x-8,p.y-8],[p.x+8,p.y+8]];
    const f=map.queryRenderedFeatures(box,{layers:["fz"]})[0];if(f){const v=visible[f.properties.k];if(v)showTrain(v.tr,v.o,false);return}
    const s=map.queryRenderedFeatures(box,{layers:["st0","st1","st2"]})[0];if(s){selectStation(s.properties.n);return}
    const l=map.queryRenderedFeatures(box,{layers:["bahn"]})[0];if(l){selectLine(l.properties.i);return}
    sel=null;clearSel()});
  map.on("movestart",hideTip);
  mapBereit=true;setze3d(mit3d);kartenAuswahl();sperrenKarte();
});
let stSel=null;
function markSt(n){if(mapBereit&&stSel!==null&&stSel>=0)map.setFeatureState({source:"st",id:stSel},{sel:false});stSel=n===null?null:names.indexOf(n);
  if(mapBereit&&stSel!==null&&stSel>=0)map.setFeatureState({source:"st",id:stSel},{sel:true})}
// Auswahl und Filter der Strecken auf die Karte übertragen (ersetzt refreshLines der 2D-Karte)
function kartenAuswahl(){if(!mapBereit)return;
  map.setFilter("bahn",["in",["get","t"],["literal",Object.keys(onT).filter(t=>onT[t])]]);
  map.setFilter("bahn-hl",["==",["get","i"],selLn===null?-1:selLn]);
  LINES.forEach((L,i)=>map.setFeatureState({source:"bahn",id:i},{dim:(selLn!==null&&selLn!==i)||(!!selSt&&!byStation[selSt].lines.has(i))}))}
// Gesperrte Abschnitte (Bahnersatz): rote Linie mit Zeichen in der Mitte
function sperrenKarte(){const namen=new Set(),fs=[];
  for(const id of SPERR.teile){const [i,j]=id.split(":").map(Number),L=LINES[i];if(!L||!L.parts[j])continue;const pt=L.parts[j];namen.add(L.name);
    fs.push({type:"Feature",properties:{},geometry:{type:"LineString",coordinates:pt.map(q=>wgs(q[0],q[1]))}});
    let tot=0;for(let q=1;q<pt.length;q++)tot+=Math.hypot(pt[q][0]-pt[q-1][0],pt[q][1]-pt[q-1][1]);let acc=0,m=pt[0];
    for(let q=1;q<pt.length;q++){const d=Math.hypot(pt[q][0]-pt[q-1][0],pt[q][1]-pt[q-1][1]);if(acc+d>=tot/2){const u=(tot/2-acc)/(d||1);m=[pt[q-1][0]+(pt[q][0]-pt[q-1][0])*u,pt[q-1][1]+(pt[q][1]-pt[q-1][1])*u];break}acc+=d}
    fs.push({type:"Feature",properties:{},geometry:{type:"Point",coordinates:wgs(m[0],m[1])}})}
  if(mapBereit)map.getSource("sperren").setData(fc(fs));
  const box=$("sperrInfo");if(SPERR.teile.size&&box){box.hidden=false;box.innerHTML=`<span aria-hidden="true">⚠</span><span><b>Heute gesperrt</b> (Bahnersatz): ${[...namen].sort().join(", ")}. Auf diesen Abschnitten fahren heute keine Züge.</span>`}else if(box)box.hidden=true}

