"use strict";
// Opening. "VIIRS · Analyze. Study. Observe.": an experience in scenes, one screen at a time over a field of stars,
// through the satellite, its sensor and what it can see, in NASA's own imagery (static/media), then the two products
// (the café menu) to choose from. In it:
// - the scenes: Enter (or Space, ← ↓ PageDown, the wheel, a swipe up, the hint at the bottom) goes on, Shift+Enter
//   (→ ↑ PageUp) back, the dots and data-goto jump; one scene is shown at a time, the others inert. Going on, the
//   scene leaving grows past the viewer and fades, the next one comes in from the distance, the stars streak by; going
//   back, the other way round. Inside a scene its parts come in one after another;
// - 01 the satellite: its orbit drawn around the globe, a satellite riding it, the numbers counting up;
// - 02 the spectrum: Planck's law for the ground (300 K) and a source whose temperature the slider sets (it sweeps up
//   from the ground to a gas flare when the scene opens), on a log scale, with VIIRS's bands as windows on it, and how
//   much brighter the source is than the ground in M10 and in M15;
// - 03 the moon: one gulf by full moon and by new moon, the line sweeping across once, then to drag;
// - 04 the map: a pin on each country with data on this computer, dropping in one after another;
// - 07 the products, with each product's nights (from /api/countries);
// - the globe's video plays only while its scene is shown, and nothing moves for reduced motion.
// Choosing a product (its card, Enter on the last scene, or key 1 or 2 from anywhere) plays its animation:
//   TEMPER       the tamper stamps down, embers burst from its face, the wordmark burns in
//   LIGHT ROAST  the emblem powers on like a neon sign, a lightning flash, pixel city lights switch on and rise,
//                the wordmark charges in with a gold sweep
// A click, the wheel or any key skips the animation. Reduced-motion users get a short still frame.
// When it ends it fires "intro-done" on document with detail.product; js/main.js switches the country opened behind
// the opening to that product. Text built here in both languages goes through I18N.pick and is rebuilt on "langchange".
(()=>{
  const intro=document.getElementById("intro");if(!intro)return;
  if(new URLSearchParams(location.search).has("chart")){intro.remove();return;}   // the graph in its own tab: no opening
  const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
  const L=(he,en)=>typeof I18N!=="undefined"?I18N.pick(he,en):he;
  const PRODUCTS={
    temper:{emblem:"brand/temper-emblem.png",word:"brand/temper-wordmark.png",palette:["#ffe08a","#ffb347","#ff8a1f","#f0641a"],length:2900},
    lightroast:{emblem:"brand/lightroast-emblem.png",word:"brand/lightroast-wordmark.png",palette:["#ffe08a","#f5b83d","#8ec5ff","#4f8cff"],length:3000}};
  const tiles=[...intro.querySelectorAll(".launch-tile")];
  let product=null;

  // ---------- the stars: a field to travel through, streaking when the scene changes ----------
  const stars=(()=>{
    const cv=intro.querySelector(".exp-stars");if(!cv)return {warp(){},stop(){}};
    const c=cv.getContext("2d"),N=reduced?260:420,CRUISE=.08;let W=1,H=1,pts=[],v=CRUISE,want=CRUISE,raf=0,live=true;
    const one=(far)=>({x:Math.random()*2-1,y:Math.random()*2-1,z:far?.6+Math.random()*.4:.05+Math.random()*.95,tw:Math.random()*6.3,b:.45+Math.random()*.55});
    function size(){const dpr=Math.min(2,devicePixelRatio||1);W=cv.clientWidth||innerWidth;H=cv.clientHeight||innerHeight;cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);c.setTransform(dpr,0,0,dpr,0,0);}
    function draw(t){
      c.clearRect(0,0,W,H);const cx=W/2,cy=H/2,f=Math.max(W,H)*.55;
      for(const p of pts){
        const z0=p.z;p.z-=v*.0035;
        if(p.z<.03||p.z>1){Object.assign(p,one(v>0));if(v<0)p.z=.05+Math.random()*.1;continue;}
        const x1=cx+p.x/p.z*f,y1=cy+p.y/p.z*f,x0=cx+p.x/z0*f,y0=cy+p.y/z0*f;
        if(x1<-20||x1>W+20||y1<-20||y1>H+20){Object.assign(p,one(true));continue;}
        const near=1-p.z,a=Math.min(1,near*1.25)*p.b*(.75+.25*Math.sin(t/900+p.tw));
        c.strokeStyle="rgba(214,226,255,"+a.toFixed(3)+")";c.lineWidth=Math.max(.5,near*1.9);c.lineCap="round";
        c.beginPath();c.moveTo(x0,y0);c.lineTo(Math.abs(x1-x0)+Math.abs(y1-y0)<.6?x1+.6:x1,y1);c.stroke();}}
    function frame(t){if(!live)return;v+=(want-v)*.07;want+=(CRUISE-want)*.035;draw(t);raf=requestAnimationFrame(frame);}
    size();for(let i=0;i<N;i++)pts.push(one(false));addEventListener("resize",size);
    if(reduced){v=0;draw(0);}else raf=requestAnimationFrame(frame);
    return {warp(dir){if(!reduced)want=dir>0?4.2:-3.4;},stop(){live=false;cancelAnimationFrame(raf);}};
  })();

  // ---------- the scenes ----------
  const scenes=[...intro.querySelectorAll(".ch")],dots=[...intro.querySelectorAll(".exp-nav button")],video=intro.querySelector(".exp-video");
  const hint=intro.querySelector(".exp-hint-text"),bar=intro.querySelector(".exp-progress i");
  // each scene's parts come in one after another (app.css: .rise, by --i)
  for(const sc of scenes){let i=0;
    for(const el of sc.querySelectorAll(".exp-hero-text > *, .exp-copy > *, .exp-copy .exp-facts > div, figure.exp-fig, figure.spectrum, figure.compare, figure.exp-map, .exp-card, .sig-table tbody tr, .launch-col, .exp-foot")){
      el.classList.add("rise");el.style.setProperty("--i",i++);}}
  if(video&&reduced){video.removeAttribute("autoplay");video.pause();}
  if(video){const ready=()=>video.classList.add("ready");if(video.readyState>=3)ready();else{video.addEventListener("playing",ready,{once:true});video.addEventListener("loadeddata",ready,{once:true});setTimeout(ready,2500);}}
  let cur=-1,lock=0;
  function show(i,dir){
    i=Math.max(0,Math.min(scenes.length-1,i));if(i===cur||product)return;
    dir=dir||(i>cur?1:-1);const from=scenes[cur],to=scenes[i];
    if(from){from.classList.remove("on","near");from.classList.add(dir>0?"gone":"back");from.inert=true;setTimeout(()=>from.classList.remove("gone","back"),1200);}
    to.classList.remove("gone","back");
    if(dir<0&&cur>=0){to.classList.add("near");void to.offsetWidth;to.classList.remove("near");}   // going back: it comes from in front
    to.classList.add("on");to.inert=false;to.scrollTop=0;
    cur=i;if(from)stars.warp(dir);
    for(const d of dots)d.classList.toggle("on",d.dataset.goto===to.id);
    const last=i===scenes.length-1;
    bar?.style.setProperty("--p",(i/(scenes.length-1)).toFixed(3));
    if(hint)hint.textContent=last?L("לבחירה · או 1 · 2","to choose · or 1 · 2"):i===0?L("להתחיל","to begin"):L("להמשך","to go on");
    intro.querySelector(".exp-hint").classList.toggle("last",last);intro.querySelector(".exp-hint").classList.toggle("first",i===0);
    if(video&&!reduced){if(to.id==="ch-hero")video.play().catch(()=>{});else video.pause();}
    clearTimeout(enterTimer);enterTimer=setTimeout(()=>enter(to),reduced?0:450);
    if(last)defaultTile()?.focus({preventScroll:true});
  }
  let enterTimer;
  const next=()=>show(cur+1,1),prev=()=>show(cur-1,-1);
  const go=id=>{const i=scenes.findIndex(s=>s.id===id);if(i>=0)show(i);};
  for(const b of intro.querySelectorAll("[data-goto]"))b.addEventListener("click",()=>go(b.dataset.goto));
  for(const b of intro.querySelectorAll("[data-next]"))b.addEventListener("click",()=>cur===scenes.length-1?choose(defaultTile()?.dataset.product||"temper"):next());
  // what a scene does when it opens
  function enter(sc){
    if(sc.id==="ch-sat")countUp(sc);
    if(sc.id==="ch-sense")sweepSpectrum();
    if(sc.id==="ch-moon")sweepMoon();}
  function ease(t){return t<.5?4*t*t*t:1-(-2*t+2)**3/2;}
  function tween(ms,step,done){if(reduced){step(1);done?.();return ()=>{};}let stop=false;const t0=performance.now();
    const f=t=>{if(stop)return;const k=Math.min(1,(t-t0)/ms);step(ease(k));if(k<1)requestAnimationFrame(f);else done?.();};requestAnimationFrame(f);return ()=>{stop=true;};}
  function countUp(sc){for(const dd of sc.querySelectorAll("dd[data-count]")){const n=+dd.dataset.count,unit=dd.dataset.unit??(dd.dataset.unit=dd.textContent.replace(/[\d,.\s]+/,"").trim());
    tween(1500,k=>{dd.textContent=Math.round(n*k).toLocaleString("en-US")+" "+unit;});}}
  let stopSpec=()=>{},specTouched=false;
  function sweepSpectrum(){const input=document.getElementById("specT");if(!input||specTouched)return;stopSpec();
    stopSpec=tween(2600,k=>{input.value=Math.round((300+1500*k)/10)*10;updateSpectrum();});}
  let stopMoon=()=>{},moonTouched=false;
  function sweepMoon(){const box=document.getElementById("moonCompare"),range=box?.querySelector(".cmp-range");if(!range||moonTouched)return;stopMoon();
    stopMoon=tween(3400,k=>{const v=k<.55?100-92*(k/.55):8+42*((k-.55)/.45);range.value=v;box.style.setProperty("--cut",v+"%");});}
  // keys: Enter goes on (on the last scene it chooses), with Shift back; the arrows and Page keys, Home and End
  window.addEventListener("keydown",e=>{
    if(product||e.ctrlKey||e.altKey||e.metaKey)return;
    const t=e.target,onTile=t.closest?.(".launch-tile"),onRange=t.matches?.("input[type=range]"),onControl=t.closest?.("button,select,textarea,input:not([type=range])");
    const back=["ArrowRight","ArrowUp","PageUp"],on=["ArrowLeft","ArrowDown","PageDown"];
    if(e.key==="Enter"){if(e.shiftKey){e.preventDefault();prev();return;}if(onTile)return;e.preventDefault();if(cur===scenes.length-1)choose(defaultTile()?.dataset.product||"temper");else next();return;}
    if(e.key===" "&&!onControl){e.preventDefault();e.shiftKey?prev():next();return;}
    if(onRange||t.closest?.("select,textarea,input"))return;   // a slider or a field keeps its arrows
    if(on.includes(e.key)){e.preventDefault();next();}else if(back.includes(e.key)){e.preventDefault();prev();}
    else if(e.key==="Home"){e.preventDefault();show(0);}else if(e.key==="End"){e.preventDefault();show(scenes.length-1);}});
  // the wheel: one gesture, one scene (a scene taller than the screen scrolls first)
  let acc=0,accT=0;
  intro.addEventListener("wheel",e=>{if(product)return;const sc=scenes[cur],dy=e.deltaY;
    if(sc&&sc.scrollHeight>sc.clientHeight+4){const end=sc.scrollTop+sc.clientHeight>=sc.scrollHeight-2,top=sc.scrollTop<=0;if(dy>0&&!end||dy<0&&!top)return;}
    e.preventDefault();const now=Date.now();if(now-accT>220)acc=0;accT=now;acc+=dy;
    if(now<lock||Math.abs(acc)<50)return;lock=now+900;acc=0;dy>0?next():prev();},{passive:false});
  let touchY=null;
  intro.addEventListener("touchstart",e=>{touchY=e.touches[0]?.clientY??null;},{passive:true});
  intro.addEventListener("touchend",e=>{if(touchY==null||product)return;const dy=touchY-(e.changedTouches[0]?.clientY??touchY);touchY=null;if(Math.abs(dy)>50)dy>0?next():prev();},{passive:true});

  // ---------- 01: how long it has been up ----------
  function age(){
    const el=document.getElementById("expAge");if(!el)return;
    const now=new Date(),y=now.getUTCFullYear()-2011-(now.getUTCMonth()<9||(now.getUTCMonth()===9&&now.getUTCDate()<28)?1:0);
    const today=now.getUTCMonth()===9&&now.getUTCDate()===28;
    el.textContent=today?L("היום בדיוק "+y+" שנה במסלול: שוגר מוונדנברג ב־28 באוקטובר 2011.","Exactly "+y+" years in orbit today: launched from Vandenberg on 28 October 2011.")
      :L(y+" שנה במסלול, הרבה מעבר לחמש השנים שתוכננו לו.",y+" years in orbit, far beyond the five it was designed for.");}

  // ---------- 02: the spectrum ----------
  // Planck: spectral radiance in W m-2 sr-1 µm-1. Bands (µm): DNB 0.5-0.9, M10 1.58-1.64, M11 2.225-2.275,
  // M15 10.263-11.263, M16 11.538-12.488.
  const C1=1.191042972e8,C2=1.438776877e4,planck=(um,t)=>C1/um**5/Math.expm1(C2/(um*t));
  const BANDS=[["DNB",.5,.9,"#8ec5ff"],["M10",1.58,1.64,"#ff8a3d"],["M11",2.225,2.275,"#ff8a3d"],["M15",10.263,11.263,"#c8ccd6"],["M16",11.538,12.488,"#c8ccd6"]];
  const SV={x0:70,x1:975,y0:24,y1:276,l0:Math.log10(.4),l1:Math.log10(14),b0:-6,b1:6};
  const X=um=>SV.x0+(Math.log10(um)-SV.l0)/(SV.l1-SV.l0)*(SV.x1-SV.x0);
  const Y=b=>{const v=Math.log10(Math.max(b,1e-30));return SV.y1-(Math.max(SV.b0,Math.min(SV.b1,v))-SV.b0)/(SV.b1-SV.b0)*(SV.y1-SV.y0);};
  const NS="http://www.w3.org/2000/svg",el=(tag,attrs,text)=>{const e=document.createElementNS(NS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);if(text!=null)e.textContent=text;return e;};
  function curve(t){let d="";for(let i=0;i<=360;i++){const um=10**(SV.l0+(SV.l1-SV.l0)*i/360),b=planck(um,t);if(Math.log10(b)<SV.b0-.5){d+="";continue;}d+=(d?"L":"M")+X(um).toFixed(1)+" "+Y(b).toFixed(1);}return d;}
  function drawSpectrum(){
    const svg=document.getElementById("specSvg");if(!svg)return;svg.replaceChildren();
    for(const [name,a,b,color] of BANDS){
      svg.append(el("rect",{x:X(a).toFixed(1),y:SV.y0,width:Math.max(3,X(b)-X(a)).toFixed(1),height:SV.y1-SV.y0,fill:color,"fill-opacity":name==="DNB"?.10:.18}));
      svg.append(el("text",{x:((X(a)+X(b))/2).toFixed(1),y:SV.y0-8,"text-anchor":"middle",class:"spec-band",fill:color},name));}
    for(const um of [.5,1,2,5,10]){const x=X(um).toFixed(1);svg.append(el("line",{x1:x,x2:x,y1:SV.y1,y2:SV.y1+5,class:"spec-axis"}));svg.append(el("text",{x,y:SV.y1+20,"text-anchor":"middle",class:"spec-tick"},um+" µm"));}
    for(let p=SV.b0;p<=SV.b1;p+=3){const y=Y(10**p).toFixed(1);svg.append(el("line",{x1:SV.x0,x2:SV.x1,y1:y,y2:y,class:"spec-grid"}));svg.append(el("text",{x:SV.x0-8,y:+y+4,"text-anchor":"end",class:"spec-tick"},"10"+(p<0?"⁻":"")+String(Math.abs(p)).split("").map(c=>"⁰¹²³⁴⁵⁶⁷⁸⁹"[+c]).join("")));}
    svg.append(el("line",{x1:SV.x0,x2:SV.x1,y1:SV.y1,y2:SV.y1,class:"spec-axis"}));
    svg.append(el("text",{x:(SV.x0+SV.x1)/2,y:SV.y1+44,"text-anchor":"middle",class:"spec-label"},L("אורך גל, לוגריתמי","wavelength, log scale")));
    svg.append(el("text",{x:14,y:(SV.y0+SV.y1)/2,"text-anchor":"middle",class:"spec-label",transform:"rotate(-90 14 "+((SV.y0+SV.y1)/2)+")"},L("קרינה, לוגריתמי","radiance, log scale")));
    svg.append(el("path",{d:curve(300),class:"spec-ground"}));
    svg.append(el("text",{x:X(9.7)-6,y:Y(planck(9.7,300))-10,"text-anchor":"middle",class:"spec-name ground"},L("קרקע · ⁦27°C⁩","ground · 27°C")));
    svg.append(el("path",{id:"specHot",class:"spec-hot"}));
    svg.append(el("circle",{id:"specPeak",r:4,class:"spec-peak"}));
    svg.append(el("text",{id:"specHotName","text-anchor":"middle",class:"spec-name hot"}));
    updateSpectrum();}
  // a ratio in words: 6.1e10 -> "60 מיליארד" / "60 billion"
  function times(r){
    const units=[[1e12,"טריליון","trillion"],[1e9,"מיליארד","billion"],[1e6,"מיליון","million"],[1e3,"אלף","thousand"]];
    for(const [v,he,en] of units)if(r>=v){const n=r/v,s=n>=100?Math.round(n/10)*10:n>=10?Math.round(n):+n.toPrecision(2);return L(s.toLocaleString("en-US")+" "+he,s.toLocaleString("en-US")+" "+en);}
    return r>=10?String(Math.round(r)):(+r.toPrecision(2)).toString();}
  function updateSpectrum(){
    const input=document.getElementById("specT");if(!input)return;const t=+input.value;
    document.getElementById("specTout").textContent=t+" K · "+Math.round(t-273.15).toLocaleString("en-US")+" °C";
    const hot=document.getElementById("specHot");if(!hot)return;
    hot.setAttribute("d",curve(t));
    const peak=2897.77/t;const pk=document.getElementById("specPeak");pk.setAttribute("cx",X(peak).toFixed(1));pk.setAttribute("cy",Y(planck(peak,t)).toFixed(1));
    const nm=document.getElementById("specHotName");nm.setAttribute("x",X(peak).toFixed(1));nm.setAttribute("y",(Y(planck(peak,t))-12).toFixed(1));
    nm.textContent=t<=320?"":L("המקור · ","source · ")+"⁦"+Math.round(t-273.15).toLocaleString("en-US")+"°C⁩";
    const r10=planck(1.61,t)/planck(1.61,300),r15=planck(10.76,t)/planck(10.76,300),box=document.getElementById("specRead");
    box.replaceChildren();
    const row=(k,v)=>{const p=document.createElement("p"),b=document.createElement("b");b.textContent=v;p.append(k+" ",b);box.append(p);};
    row(L("שיא הפליטה:","Peak emission:"),"⁦"+(peak>=10?peak.toFixed(1):peak.toFixed(2))+" µm⁩");
    if(t>320){
      row(L("ב־M10 (1.61 µm), מ״ר של המקור מאיר כמו","At M10 (1.61 µm), a square metre of it shines like"),L(times(r10)+" מ״ר של קרקע",times(r10)+" m² of ground"));
      row(L("ב־M15 (10.8 µm), רק כמו","At M15 (10.8 µm), only like"),L(times(r15)+" מ״ר",times(r15)+" m²"));}
    else row(L("הקרקע מאירה בעיקר בתרמי, ובאינפרא־אדום הקצר היא כמעט חשוכה.","The ground shines mostly in the thermal infrared; at short-wave infrared it is almost dark."),"");}
  {
    const input=document.getElementById("specT");
    if(input){input.addEventListener("input",()=>{specTouched=true;stopSpec();updateSpectrum();});
      for(const b of intro.querySelectorAll(".spec-presets button"))b.addEventListener("click",()=>{specTouched=true;stopSpec();
        const from=+input.value,to=+b.dataset.t;tween(900,k=>{input.value=Math.round((from+(to-from)*k)/10)*10;updateSpectrum();});});}
  }

  // ---------- 03: the moon ----------
  {
    const box=document.getElementById("moonCompare"),range=box?.querySelector(".cmp-range");
    const set=()=>box.style.setProperty("--cut",range.value+"%");
    if(range){range.addEventListener("input",()=>{moonTouched=true;stopMoon();set();});set();}
  }

  // ---------- 04: the pins, and each product's nights on this computer ----------
  {let i=0;for(const pin of intro.querySelectorAll(".map-pin")){
    pin.style.setProperty("--x",((+pin.dataset.lon-24)/42*100).toFixed(2)+"%");
    pin.style.setProperty("--y",((42-+pin.dataset.lat)/34*100).toFixed(2)+"%");pin.style.setProperty("--i",i++);}}
  // Under each product: from its first night to its last, and each country as a chip whose tooltip has its own nights.
  const day=s=>new Date(s+"T12:00:00").toLocaleDateString(typeof I18N!=="undefined"?I18N.locale():"he-IL",{day:"numeric",month:"short",year:"numeric"});
  const span=(a,b)=>a===b?L("ב־","on ")+day(a):L("מ־","from ")+day(a)+L(" עד "," to ")+day(b);
  let countries=null;
  function renderRanges(){
    if(!countries)return;
    const names=new Set(countries.map(c=>c.name));
    for(const pin of intro.querySelectorAll(".map-pin"))pin.hidden=!names.has(pin.dataset.country);
    for(const[p,first,last,count]of[["temper","first","last","nights"],["lightroast","lightroast_first","lightroast_last","lightroast_nights"]]){
      const box=intro.querySelector('.launch-range[data-product="'+p+'"]');if(!box)continue;
      const rows=countries.filter(c=>c[first]),when=document.createElement("p"),ul=document.createElement("ul");when.className="when";
      if(!rows.length){when.textContent=L("אין נתונים במחשב הזה","No data on this computer");box.replaceChildren(when);continue;}
      when.textContent=L("נתונים ","Data ")+span(rows.map(c=>c[first]).sort()[0],rows.map(c=>c[last]).sort().reverse()[0]);
      for(const c of rows){const li=document.createElement("li");li.textContent=L(c.name_he,c.name);
        li.title=(c[count]?c[count].toLocaleString("en-US")+L(" לילות, "," nights, "):"")+span(c[first],c[last]);ul.append(li);}
      box.replaceChildren(when,ul);}}
  fetch("/api/countries").then(r=>r.ok?r.json():null).then(list=>{if(!list)return;countries=list.countries;renderRanges();}).catch(()=>{});
  document.addEventListener("langchange",()=>{age();drawSpectrum();renderRanges();const c=cur;cur=-2;show(c<0?0:c);});
  age();drawSpectrum();
  let lastProduct=null;try{lastProduct=localStorage.getItem("viewer-product");}catch{}
  function defaultTile(){return tiles.find(t=>t===document.activeElement)||tiles.find(t=>t.dataset.product===lastProduct)||tiles[0];}
  for(const sc of scenes)sc.inert=true;
  show(0,1);intro.querySelector(".exp-go")?.focus({preventScroll:true});

  // ---------- choosing: the product's animation ----------
  let finished=false,timer;
  const skip=e=>{if(!product)return;e.preventDefault();e.stopImmediatePropagation();finish();};
  function finish(){if(finished)return;finished=true;clearTimeout(timer);window.removeEventListener("keydown",skip,true);intro.removeEventListener("pointerdown",skip);intro.removeEventListener("wheel",skip);
    intro.classList.add("done");document.getElementById("brand")?.classList.add("arrive");document.dispatchEvent(new CustomEvent("intro-done",{detail:{product}}));setTimeout(()=>intro.remove(),reduced?0:650);}

  function sparks(p){
    const box=intro.querySelector(".intro-sparks");box.replaceChildren();const palette=PRODUCTS[p].palette;
    for(let i=0;i<(p==="lightroast"?44:36);i++){const s=document.createElement("i");s.className="spark";s.style.setProperty("--c",palette[i%palette.length]);
      if(p==="lightroast"){   // pixel lights over the emblem's skyline and around it, switching on one after another, then rising
        s.style.setProperty("--x",(Math.random()*520-260).toFixed(0)+"px");s.style.setProperty("--y",(-Math.random()*300+70).toFixed(0)+"px");
        s.style.setProperty("--dx",(Math.random()*16-8).toFixed(1)+"px");s.style.setProperty("--dy",(-30-Math.random()*70).toFixed(1)+"px");
        s.style.setProperty("--s",(4+Math.round(Math.random()*4))+"px");s.style.setProperty("--d",(Math.random()*1.1).toFixed(2)+"s");s.style.setProperty("--t",(1.3+Math.random()*.6).toFixed(2)+"s");}
      else{   // embers: a fast sideways burst at impact, and a few slower ones rising after it
        const rising=i%3===0,angle=-Math.PI*(.05+.9*Math.random()),dist=rising?140+Math.random()*160:90+Math.random()*170;
        s.style.setProperty("--dx",(Math.cos(angle)*dist*(rising?.35:1.4)).toFixed(1)+"px");s.style.setProperty("--dy",(Math.sin(angle)*dist*(rising?1.6:.6)).toFixed(1)+"px");
        s.style.setProperty("--s",(rising?5:6+Math.round(Math.random()*6))+"px");s.style.setProperty("--d",(rising?.2+Math.random()*.5:Math.random()*.08).toFixed(2)+"s");s.style.setProperty("--t",(rising?1.7:.8+Math.random()*.4).toFixed(2)+"s");}
      box.append(s);}
  }

  function choose(p){if(product)return;product=p;try{localStorage.setItem("viewer-product",p);}catch{}
    video?.pause();stars.stop();stopSpec();stopMoon();
    document.body.dataset.product=p;   // the page behind takes the product's theme at once
    intro.querySelector(".intro-emblem").src=PRODUCTS[p].emblem;intro.querySelector(".intro-word").src=PRODUCTS[p].word;
    intro.classList.remove("launch");intro.classList.add("anim");intro.classList.toggle("lr",p==="lightroast");sparks(p);
    window.addEventListener("keydown",skip,true);intro.addEventListener("pointerdown",skip);intro.addEventListener("wheel",skip,{passive:false});
    // Start once both images are decoded, so the animation never plays as an empty frame; never wait more than 1.5 s.
    const ready=Promise.all([...intro.querySelectorAll(".intro-lockup img")].map(img=>img.decode().catch(()=>{})));
    Promise.race([ready,new Promise(r=>setTimeout(r,1500))]).then(()=>{if(finished)return;intro.classList.add("play");timer=setTimeout(finish,reduced?700:PRODUCTS[p].length);});}
  for(const t of tiles)t.addEventListener("click",()=>choose(t.dataset.product));
  // Keys 1 and 2 choose, as printed on the cards, from anywhere in the opening.
  window.addEventListener("keydown",e=>{if(product||e.ctrlKey||e.altKey||e.metaKey||e.target.closest?.("input:not([type=range]),select,textarea"))return;const i=["1","2"].indexOf(e.key);if(i>=0&&tiles[i]){e.preventDefault();choose(tiles[i].dataset.product);}});
})();
