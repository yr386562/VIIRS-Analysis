"use strict";
// The tour (?, top bar, and the question after the opening), learned by doing and then read. Each step has two parts:
// - do: one control of the viewer is ringed, with an arrow and a line saying what to click and why; the rest of the
//   screen dims and takes no clicks. The click does what it would, at once, from data worked out ahead (the server's
//   lab for the country, /api/lab: the places, the change, the related places, the search, the period's composite,
//   the network, a point layer).
// - read: the tour stops on what the click showed. Numbered marks sit on its parts (the shaded band, the dashed line,
//   the chip's buttons, the list's columns...) and the card says what each one is, then how to do it on one's own;
//   "Got it" goes on.
// Where the country has a story (static/story.json: one real place chosen from the data) the steps follow it: open
// the point, find its change in the graph, read its heat and its light, the scale, the chip, what is related
// (right-click, Related places), the step search; then the tools (a period, an area, the personal analysis, points,
// the network, the graphs' window, coordinates, the download, the top bar). Without a story they start from the
// country's strongest change. What a step showed stays until the next step is done. While the tour runs the server's
// background waits (/api/tour). After the opening the viewer asks whether to take it ("don't ask again" in the
// question; ? always opens it); the tour taken at the opening ends on the country picker. "Show me" does a step after
// two misses. Written in both languages (I18N.pick), not in the dictionary; text in **...** is bold.
(()=>{
/* i18n-pairs: written in both languages (I18N.pick), no dictionary entries */
const pick=(he,en)=>typeof I18N!=="undefined"?I18N.pick(he,en):he;
const P=x=>Array.isArray(x)?pick(...x):x||"";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Waits for f(), at most ms; false at once when the tour has moved on.
async function until(f,ms=10000){const t=Date.now(),my=seq;while(Date.now()-t<ms){if(my!==seq)return false;try{if(f())return true;}catch{}await sleep(100);}return false;}
const when=e=>{const d=s=>typeof displayDate==="function"?displayDate(s,true):s;return e.onset===e.last?d(e.onset):d(e.onset)+" – "+d(e.last);};
const country=()=>state.meta?countryName(state.meta):"";
const loaded=()=>state.windows.length>0&&!state.windows.some(w=>w.loading);
const num=n=>Number(n).toLocaleString("en-US");
// The change logs of both products, once per country: only for a country without a lab (the tour then asks live).
const demo={for:null,lists:{}};
async function loadLists(){
  if(!state.meta||demo.for===state.meta.id)return;
  const id=state.meta.id,lists={};
  for(const p of ["temper","lightroast"]){
    if(p==="lightroast"&&!(state.meta.lightroast&&state.meta.lightroast.available))continue;
    try{lists[p]=(await api("/api/events?"+new URLSearchParams({product:p}))).events;}catch{lists[p]=[];}}
  if(state.meta?.id!==id)return;
  demo.for=id;demo.lists=lists;}
// The lab (server: /api/lab).
const lab={for:null,data:null};
async function loadLab(){
  if(!state.meta||lab.for===state.meta.id&&lab.data)return;
  const id=state.meta.id;let d=null;
  try{d=await api("/api/lab");}catch{}
  if(state.meta?.id!==id)return;
  lab.for=id;lab.data=d&&d.places?d:null;}
// From the lab, at once: a place (its series and area analysis there already), a change (shaded and marked), the
// related places asked for, a behaviour search.
function labPlace(key,add){const p=lab.data?.places?.[key];if(!p)return false;
  openPlace([p.x,p.y],{size:p.size_km,add,prepared:p});if(lrMeta()&&!state.compare)setCompare(true);return true;}
function labChange(e,key,add){if(!e)return false;const ok=labPlace(key||e.id,add);state.events.active=e;renderList();renderMap();renderChart();return ok;}
function labRelated(seed,r){state.similar={seed,night:seed.onset||state.date,ask:seed.ask||null,target:seed.product,regional:false,result:clipRelated(r),raw:r,busy:false,error:null,active:null,seq:0};
  showSide("list");renderSimilar();renderMap();}
function labSearch(q,data){srch.shape=(q.match(/shape = (\w+)/)||[])[1]||"step";srch.dir=(q.match(/direction = (up|down)/)||[])[1]||"";
  Object.assign(srch,{data,group:null,active:null,busy:false,error:null});showSide("search");renderSearch();$("queryText").value=q;renderMap();}
const strongest=(p,skip=0)=>{const l=demo.lists[p]||[],firm=l.filter(e=>e.sig?.level!=="weak");return (firm[skip]||l[skip])||null;};
const label=e=>pick({new:"נדלק",off:"כבה",brighter:"התחזק",dimmer:"נחלש"}[e.kind]||"שינוי",{new:"lit",off:"went out",brighter:"grew",dimmer:"weakened"}[e.kind]||"change")+" · "+when(e);
// The story (static/story.json), for the open country.
const story={for:null,data:null};
async function loadStory(){
  if(!state.meta||story.for===state.meta.id)return;
  const id=state.meta.id;let data=null;
  try{data=(await (await fetch("story.json")).json())[state.meta.name]||null;}catch{}
  if(state.meta?.id!==id)return;
  story.for=id;story.data=data;}
// A story text's first sentence (what the data show there), in both languages.
const first=line=>line.map(t=>t.split(/(?<=\.)\s+/)[0]);
// The graph's time, zoomed to the story's weeks (or back to all of it).
function zoomTo(w){$("rangeFrom").value=w?w[0]:"";$("rangeTo").value=w?w[1]:"";setRange();fitChart(true);}
function centre(x,y,f=400){state.cx=x;state.cy=y;state.zoom=Math.max(state.fitZoom,Math.min(state.fitZoom*f,state.width/60000));renderMap();}

// ---------- where: a control, a point on the map, nights or a panel of the graph; and the marks on a result ----------
const el=sel=>{const e=typeof sel==="function"?sel():document.querySelector(sel);return e&&e.offsetParent!==null&&e.getBoundingClientRect().width>0&&!e.disabled?e:null;};
const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};};
const elBox=sel=>()=>box(el(sel));
const union=(...fs)=>()=>{const rs=fs.map(f=>f()).filter(Boolean);if(!rs.length)return null;const l=Math.min(...rs.map(r=>r.left)),t=Math.min(...rs.map(r=>r.top)),
  r=Math.max(...rs.map(r=>r.left+r.width)),b=Math.max(...rs.map(r=>r.top+r.height));return {left:l,top:t,width:r-l,height:b-t};};
function mapPoint(x,y,r=22){if(!state.meta)return null;const c=canvas.getBoundingClientRect(),[sx,sy]=screen(x,y);
  if(sx<0||sy<0||sx>c.width||sy>c.height)return null;return {left:c.left+sx-r,top:c.top+sy-r,width:2*r,height:2*r,round:true};}
function chartBand(d0,d1){if(!state.chartX||state.popped)return null;const c=chart.getBoundingClientRect(),g=chartGeometry();let a=state.chartX(d0),b=state.chartX(d1||d0);
  if(!isFinite(a)||!isFinite(b))return null;if(b-a<36){const m=(a+b)/2;a=m-18;b=m+18;}
  return {left:c.left+a-4,top:c.top+g.top-2,width:b-a+8,height:g.bottom-g.top+4};}
function chartPanel(p){if(state.popped)return null;const c=chart.getBoundingClientRect(),panel=(state.chartPanels||[]).find(x=>x.product===p);if(!panel)return null;
  const g=panel.g;return {left:c.left+g.left-4,top:c.top+g.top-4,width:g.right-g.left+8,height:g.bottom-g.top+8};}
const inside=(r,x,y,pad=4)=>r&&x>=r.left-pad&&x<=r.left+r.width+pad&&y>=r.top-pad&&y<=r.top+r.height+pad;
// Anchors for the numbered marks: a point on an element (fx, fy: where across and down it), a rect, the graph at a
// night, the map at a place.
const at=(f,fx=.5,fy=0)=>()=>{const r=typeof f==="string"?box(el(f)):f();return r?{x:r.left+r.width*fx,y:r.top+r.height*fy}:null;};
const atNight=(d,p,fy)=>()=>{const pr=chartPanel(p);if(!pr||!state.chartX||!d)return null;const x=chart.getBoundingClientRect().left+state.chartX(d);return isFinite(x)?{x,y:pr.top+pr.height*fy}:null;};
const atMap=(x,y)=>()=>{const r=mapPoint(x,y,0);return r?{x:r.left,y:r.top}:null;};

// ---------- the steps ----------
// A step: do (what to click and why, one line) and where: el (a control) or rect (a point on the map, nights in the
// graph); kind: click, context (a right-click) or shift (Shift+click); pass: the click goes to the viewer as it is and
// done() says it worked, else it is taken here and run() shows it from the lab; read (what it showed: a title, a lead
// line, focus (the part lit), marks [anchor, text] numbered on it, own: how to do it on one's own), or nothing (a
// small step: on to the next); before/after (what it sets up, and puts back after the next step); when (taken only if
// true).
const SHAPES={step:["מדרגה","Step"],trend:["מגמה","Trend"],fluct:["תנודתי","Swinging"],spike:["קפיצות","Spikes"]};
const pts0={};
const T_=(he,en)=>[he,en];
// What the first opened place shows: shared by the story and the strongest change.
const placeRead=(lead,own)=>({title:T_("המקום לאורך זמן","A place over time"),lead,focus:union(elBox("#seriesPanel"),elBox("#areaCard")),marks:[
  [at("#seriesLegend .win-chip",.5,0),T_("**השבב** של המקום: #1, גודל החלון סביבו, והערך של הלילה שעל המפה, בכל מוצר.","The place's **chip**: #1, the window around it, and tonight's value in each product.")],
  [at(()=>chartPanel("temper"),.06,.15),T_("למעלה **החום**, TEMPER: נקודה לכל לילה, לאורך כל השנה.","Above, **heat**, TEMPER: a dot for each night, over the whole year.")],
  [at(()=>chartPanel("lightroast"),.06,.15),T_("למטה **האור**, LIGHT ROAST: כמה אור יוצא מהמקום, ב־nW.","Below, **light**, LIGHT ROAST: how much light the place gives off, in nW.")],
  [()=>atNight(state.date,"lightroast",.9)(),T_("**הקו האנכי**: הלילה שעל המפה. לחיצה על לילה בגרף מעבירה אליו את המפה.","**The vertical line**: the night on the map. A click on a night in the graph moves the map to it.")],
  [at("#areaCard",.5,0),T_("**ניתוח האזור**: כמה המקום עקבי, האם אור וחום זזים יחד, ומי קשור אליו.","**The area analysis**: how steady the place is, whether light and heat move together, and what is related to it.")]],
  own:own||T_("לחיצה על כל מקום במפה פותחת אותו כך. **Shift**+לחיצה או **A** מוסיפים מקום לצד הפתוחים, עד 4.","A click anywhere on the map opens it like this. **Shift**+click or **A** adds a place beside the open ones, up to 4.")});
const PIN={do:T_("לחצו על **הסיכה** בשבב: נעיצת המקום בגרף.","Click the **pin** on the chip: pin the place in the graph."),el:"#seriesLegend .chip-pin:not(.on)",pass:true,done:()=>state.windows.some(w=>w.kept),
  when:()=>!!el("#seriesLegend .chip-pin:not(.on)"),
  read:{title:T_("השבב: נעיצה, שמירה, צבע","The chip: pin, save, colour"),focus:elBox("#seriesLegend .win-chip"),marks:[
    [at("#seriesLegend .win-chip .chip-pin",.5,0),T_("**הסיכה** (דלוקה עכשיו): המקום נשאר בגרף כשנפתח מקום אחר, בלי לשמור אותו.","**The pin** (on now): the place stays in the graph when another opens, without saving it.")],
    [at("#seriesLegend .win-chip .chip-save",.5,0),T_("**☆**: שמירה בניתוח האישי, בשם שלכם, במחשב הזה.","**☆**: save it in the personal analysis, under your name, on this computer.")],
    [at("#seriesLegend .win-chip > i",.5,0),T_("**הנקודה הצבעונית**: צבע אחר למקום. **צבעים** בכותרת: פלטה לכולם.","**The coloured dot**: another colour for the place. **Colours** in the header: a palette for all.")],
    [at("#seriesLegend .win-chip > button:last-child",.5,0),T_("**×**: הוצאה מהגרף.","**×**: out of the graph.")]]}};
const SCALE=(lead)=>({do:T_("לחצו **שינוי** בסקאלה: כך משווים מקומות בהירים וחשוכים.","Click **Change** on the scale: that is how bright and dark places compare."),el:'#chartMode [data-mode="change"]',pass:true,done:()=>chartMode==="change",when:()=>chartMode!=="change",
  read:{title:T_("סקאלת הערכים","The values' scale"),lead,focus:elBox("#seriesPanel"),marks:[
    [at('#chartMode [data-mode="fixed"]',.5,0),T_("**קבועה**: מ־0. רואים כמה בהיר המקום באמת.","**Fixed**: from 0. You see how bright the place really is.")],
    [at('#chartMode [data-mode="view"]',.5,0),T_("**לפי התצוגה**: מתאימה את עצמה לתקופה שבגרף, כשמגדילים בזמן.","**By view**: fits itself to the period in the graph, when you zoom in time.")],
    [at('#chartMode [data-mode="change"]',.5,0),T_("**שינוי** (עכשיו): כל מקום באחוזים מול החציון של עצמו. 0% הוא הרגיל שלו.","**Change** (now): each place in percent against its own median. 0% is its usual.")],
    [at(()=>chartPanel("lightroast"),.02,.5),T_("הציר באחוזים: שינוי קטן ממלא את הגובה, גם במקום חשוך.","The axis in percent: a small change fills the height, even at a dark place.")]],
    own:T_("גלגלת על הגרף: זום בזמן. **Shift**+גלגלת: זום בערכים. לחיצה כפולה: הכל.","Wheel on the graph: zoom in time. **Shift**+wheel: zoom in values. Double-click: all of it.")}});
const RELATED_READ=(lead)=>({title:T_("מקומות קשורים","Related places"),lead,focus:elBox(".list-panel"),marks:[
  [()=>at(el("#simAnswer")?"#simAnswer":"#similarSeed",.5,0)(),T_("**למעלה**: מה נשאל, ולמה: שינוי בלילה מסוים, או מה זז איתו לאורך השנה.","**At the top**: what was asked, and why: a change on a given night, or what moves with it over the year.")],
  [at("#simPos li .chg-item",.15,.5),T_("**שורה**: מקום קשור, כמה חזק הקשר, ובאיזה מרחק. לחיצה מראה אותו במפה.","**A row**: a related place, how strong the link, and how far. A click shows it on the map.")],
  [at("#simPos li .hot-add",.5,0),T_("**לגרף**: המקום הקשור לצד הזה, בשני הגרפים.","**To the graph**: the related place beside this one, in both graphs.")],
  [at('.sim-col[data-sign="neg"] h3',.5,.5),T_("**נעים הפוך**: עולים כשהמקום יורד, ולהפך.","**Moving opposite**: they rise when the place falls, and the other way round.")],
  [at(()=>box([...document.querySelectorAll("#seriesLegend .win-chip")].pop()),.5,0),T_("בגרף: **#2**, הקשור הראשון, לצד #1.","In the graph: **#2**, the first related place, beside #1.")]],
  own:T_("לחיצה ימנית על המפה ← **מקומות קשורים**, או **≈** בשורה ברשימה.","Right-click the map → **Related places**, or **≈** on a row in the list.")});
const SEARCH_READ=()=>({title:T_("חיפוש לפי התנהגות","Search by behaviour"),
  lead:T_("נמצאו **"+num(srch.data?.total||0)+"** מקומות, צבועים במפה.","**"+num(srch.data?.total||0)+"** places found, coloured on the map."),focus:elBox(".list-panel"),marks:[
  [at("#qShape",.5,0),T_("**הצורה** של השנה: מדרגה (שינוי שנשאר), מגמה, תנודתי, קפיצות.","**The shape** of the year: step (a change that stays), trend, swinging, spikes.")],
  [at("#qDir",.5,0),T_("**כיוון**, ולידו פי כמה, מתי ואיפה.","**Direction**, and beside it how much, when and where.")],
  [at("#queryText",.5,0),T_("**השאילתה** שהכפתורים כתבו. אפשר לערוך ולחפש.","**The query** the buttons wrote. You can edit it and search.")],
  [at("#searchList li",.2,.5),T_("**תוצאה**: כמה השתנה ומתי. לחיצה פותחת אותה בגרף.","**A result**: how much it changed and when. A click opens it in the graph.")],
  [()=>document.querySelector("#searchGroups")?.children.length?at("#searchGroups",.5,0)():null,T_("**קבוצות**: מקומות שהשתנו באותם ימים, כנראה סיפור אחד.","**Groups**: places that changed on the same days, probably one story.")]],
  own:T_("בגרף, הקו המקווקו של כל מקום הוא הצורה שבזכותה נמצא.","In the graph, each place's dashed line is the shape it was found by.")});
function storySteps(st){const T=st.steps,L=lab.data?.story,seed=st.seed,shape=(st.search.query.match(/shape = (\w+)/)||[])[1]||"step",nm=SHAPES[shape]||SHAPES.step;return [
  {do:T_("לחצו על הנקודה המהבהבת במפה, כדי לפתוח אותה לאורך זמן.","Click the glowing point on the map, to open it over time."),rect:()=>mapPoint(seed.x,seed.y),
    before:()=>{showSide("list");for(const w of state.windows.filter(w=>!w.kept))removeWindow(w);state.events.active=null;centre(seed.x,seed.y);},
    run:async()=>{demo.first={x:seed.x,y:seed.y,lonlat:seed.lonlat};if(!(L&&labPlace(L.seed,false))){openPlace([seed.x,seed.y],{size:seed.size_km});if(lrMeta()&&!state.compare)setCompare(true);}await until(loaded,30000);},
    read:placeRead(T_("ריבוע של "+seed.size_km+" ק״מ סביב הנקודה: הממוצע של הפיקסלים שבו, בכל לילה.","A "+seed.size_km+" km square around the point: the mean of its pixels, each night."))},
  {do:T_("בגרף: לחצו על הלילות שבהם הקו קופץ. שם קרה השינוי.","In the graph: click the nights where the line jumps. That is where the change happened."),rect:()=>L?.change?chartBand(L.change.onset,L.change.last):null,
    miss:T_("לא שם: חפשו איפה הקו קופץ לגובה אחר ונשאר.","Not there: look for where the line jumps to another level and stays."),
    run:()=>{if(L?.change){state.events.active=L.change;renderList();renderMap();renderChart();}},
    read:{title:T_("נקודת השינוי","The change point"),lead:first(T.change[0]),focus:elBox("#chartWrap"),marks:[
      [()=>L?.change?at(()=>chartBand(L.change.onset,L.change.last),.5,.05)():null,T_("**הרצועה המוצללת**: הלילות שבהם יומן השינויים מצא את השינוי.","**The shaded band**: the nights on which the change log found the change.")],
      [atMap(seed.x,seed.y),T_("**על המפה**: הסימון של השינוי. המקרא בצד אומר איזה סוג.","**On the map**: the change's mark. The legend at the side says which kind.")],
      [at("#evDays",.5,0),T_("**ברשימה**: **הכל** מראה כל שינוי מאז תחילת הנתונים; חזק, בינוני או חלש לפי ההיסטוריה של המקום.","**In the list**: **All** shows every change since the data began; strong, medium or weak by the place's own history.")]],
      own:T_("שינוי מוצאים ברשימה, בסימון על המפה, או בלחיצה בגרף על הלילה שבו הקו קופץ.","Find a change in the list, by its mark on the map, or by clicking the night in the graph where the line jumps.")}},
  {do:T_("לחצו על **גרף החום** (TEMPER, למעלה) כדי לקרוא אותו.","Click **the heat graph** (TEMPER, above) to read it."),rect:()=>chartPanel("temper"),run:()=>{},
    read:{title:T_("לקרוא את החום","Reading the heat"),lead:first(T.heat[0]),focus:()=>chartPanel("temper"),marks:[
      [at(()=>chartPanel("temper"),.03,.45),T_("**הציר**: קרינה ב־SWIR מעל הרעש של החיישן, מתוקנת לזווית הצילום. סביב 0: אין מקור חום.","**The axis**: SWIR radiance above the sensor's noise, corrected for the view angle. Around 0: no heat source.")],
      [at(()=>chartPanel("temper"),.5,.12),T_("**נקודה שבולטת** הרבה מעל הקו: להבה או אש באותו לילה, מסומנת גם במפה.","**A dot standing** far above the line: a flame or fire that night, marked on the map too.")],
      [at(()=>chartPanel("temper"),.75,.97),T_("**סימן קטן בתחתית**: לילה מעונן, בלי מדידה. **עיגול חלול**: נמדד רק בחלקו.","**A small tick at the bottom**: a cloudy night, no measurement. **A hollow circle**: measured only in part.")]],
      own:T_("**טמפ׳** בכלי הגרף: טמפרטורת המקור במקום קרינה, בלילות שבהם האש חזקה בשני הערוצים.","**Temp.** in the graph's tools: the source's temperature instead of radiance, on nights the fire is strong in both bands.")}},
  {do:T_("לחצו על **גרף האור** (LIGHT ROAST, למטה) כדי לקרוא אותו.","Click **the light graph** (LIGHT ROAST, below) to read it."),rect:()=>chartPanel("lightroast"),run:()=>{},
    read:{title:T_("לקרוא את האור","Reading the light"),lead:first(T.light[0]),focus:()=>chartPanel("lightroast"),marks:[
      [at(()=>chartPanel("lightroast"),.03,.45),T_("**הציר**: אור ב־nW, אחרי ניקוי ירח, ענן ואטמוספרה (Black Marble).","**The axis**: light in nW, cleaned of moon, cloud and atmosphere (Black Marble).")],
      [()=>atNight(L?.change?.last||L?.change?.onset,"lightroast",.3)(),T_("**הקו המקווקו**: הצורה שנמצאה לשנה של המקום. כאן מדרגה: הרמה לפני ואחרי.","**The dashed line**: the shape found for the place's year. Here a step: the level before and after.")],
      [at(()=>chartPanel("lightroast"),.99,.5),T_("**בקצה**: מספר המקום, בצבע שלו כמו במפה ובשבב.","**At the end**: the place's number, in its colour as on the map and the chip.")]],
      own:T_("**צורה** בכותרת הגרף מציגה או מסתירה את הקו המקווקו.","**Shape** in the graph's header shows or hides the dashed line.")}},
  SCALE(),
  PIN,
  {do:T_("מה זז יחד איתו? לחיצה **ימנית** על הנקודה במפה.","What moves with it? **Right**-click the point on the map."),rect:()=>mapPoint(seed.x,seed.y),kind:"context",pass:true,done:()=>!$("mapMenu").hidden,
    before:()=>centre(seed.x,seed.y)},
  {do:T_("בתפריט: **מקומות קשורים**.","In the menu: **Related places**."),el:"#menuSimilar",
    run:async()=>{closeMenu();const r=st.related,p=st.partner,s={x:r.x,y:r.y,size_km:r.size_km,product:r.seed,label:pick("המקום של הסיור","The tour's place"),onset:r.onset,last:r.last,kind:r.kind||null,lonlat:seed.lonlat,ask:r.ask||null};
      if(L?.related&&!L.related.error){labRelated(s,L.related);if(!state.windows.some(w=>Math.hypot(w.center[0]-p.x,w.center[1]-p.y)<1))labPlace(L.partner,true);}
      else{findSimilar(s);openPlace([p.x,p.y],{size:p.size_km,add:true});await until(()=>state.similar&&!state.similar.busy&&loaded(),90000);}
      setChartMode("change");if(st.window)zoomTo(st.window);},
    read:RELATED_READ(T_("הגרף הוגדל לחודשים סביב השינוי: #1 ו־#2 עולים יחד.","The graph zoomed to the months around the change: #1 and #2 rise together.")),
    after:()=>{if(state.similar)closeSimilar();if(st.window)zoomTo(null);}},
  {do:T_("פתחו את לשונית **חיפוש**: מקומות לפי הצורה של השנה שלהם.","Open the **Search** tab: places by the shape of their year."),el:"#sideSearch",pass:true,done:()=>state.side==="search",before:()=>{demo.shapes??=showShapes;if(!showShapes)$("shapeToggle").click();}},
  {do:T_("לחצו **"+nm[0]+"**: מקומות שהשתנו פעם אחת ונשארו כך.","Click **"+nm[1]+"**: places that changed once and stayed so."),el:'#qShape [data-v="'+shape+'"]',
    run:async()=>{if(L?.search){labSearch(L.search.query,L.search.data);return;}
      srch.shape=shape;srch.dir=(st.search.query.match(/direction = (up|down)/)||[])[1]||"";renderSearch();$("queryText").value=st.search.query;runSearch();await until(()=>srch.data&&!srch.busy,90000);},
    read:SEARCH_READ,after:()=>{Object.assign(srch,{data:null,group:null,active:null});renderSearch();showSide("list");}}];}
// Without a story: from the strongest change (the lab's, else the change log's).
function changeSteps(){const p0=state.product,f=lab.data?.first?.[p0]?.[0]||(strongest(p0)&&{event:strongest(p0)});if(!f)return [];
  const other=p0==="temper"?(lrMeta()?"lightroast":null):"temper",second=(other&&lab.data?.first?.[other]?.[0])||lab.data?.first?.[p0]?.[1]||(strongest(other||p0,other?0:1)&&{event:strongest(other||p0,other?0:1)});
  const e=f.event,S=lab.data?.search?.[p0],shape=S?(S.query.match(/shape = (\w+)/)||[])[1]||"step":"step",nm=SHAPES[shape]||SHAPES.step;demo.first=e;return [
  {do:T_("לחצו על הנקודה המהבהבת במפה: השינוי החזק ביותר ב־"+country()+".","Click the glowing point on the map: the strongest change in "+country()+"."),rect:()=>mapPoint(e.x,e.y),
    before:()=>{showSide("list");for(const w of state.windows.filter(w=>!w.kept))removeWindow(w);centre(e.x,e.y,250);},
    run:async()=>{if(!(f.place&&labChange(e,f.place,false))){selectEvent(e,false);await until(loaded,20000);}},
    read:placeRead(T_("**"+label(e)+"**: הלילות שלו מוצללים בגרף.","**"+label(e)+"**: its nights are shaded in the graph."))},
  PIN,
  ...(second?[{do:T_("עוד מקום לגרף: החזיקו **Shift** ולחצו על הנקודה המהבהבת.","One more place in the graph: hold **Shift** and click the glowing point."),rect:()=>mapPoint(second.event.x,second.event.y),kind:"shift",
    before:()=>centre(second.event.x,second.event.y,250),
    run:async()=>{if(!(second.place&&labChange(second.event,second.place,true))){selectEvent(second.event,true);await until(loaded,20000);}},
    read:{title:T_("השוואה","Comparing"),focus:elBox("#seriesPanel"),marks:[
      [at(()=>box([...document.querySelectorAll("#seriesLegend .win-chip")].pop()),.5,0),T_("**#2** לצד #1: כל מקום בצבע שלו, במפה, בשבב ובשני הגרפים.","**#2** beside #1: each place in its colour, on the map, its chip and both graphs.")],
      [at(()=>chartPanel("lightroast"),.99,.5),T_("**בקצה**: המספרים מראים איזה קו של מי. ריחוף מעל מספר: רק הקו הזה.","**At the end**: the numbers say which line is whose. Hover a number: only that line.")]],
      own:T_("**Shift**+לחיצה, או **A** עם הסמן על מקום, שורה או סימון. עד 4 מקומות.","**Shift**+click, or **A** with the pointer on a place, a row or a mark. Up to 4 places.")}}]:[]),
  SCALE(),
  {do:T_("מה קשור אליו? לחיצה **ימנית** על המקום הראשון במפה.","What is related to it? **Right**-click the first place on the map."),rect:()=>mapPoint(e.x,e.y),kind:"context",pass:true,done:()=>!$("mapMenu").hidden,before:()=>centre(e.x,e.y,250)},
  {do:T_("בתפריט: **מקומות קשורים**.","In the menu: **Related places**."),el:"#menuSimilar",
    run:async()=>{closeMenu();const r=lab.data?.related?.[e.id],s={x:e.x,y:e.y,size_km:typeof clusterSize==="function"?clusterSize(e.detail):3,product:p0,label:label(e),onset:e.onset,last:e.last,kind:e.kind,lonlat:e.lonlat};
      if(r&&!r.error){labRelated(s,r);return;}findSimilar(s);await until(()=>state.similar&&!state.similar.busy,60000);},
    read:RELATED_READ(null),after:()=>{if(state.similar)closeSimilar();}},
  {do:T_("פתחו את לשונית **חיפוש**: מקומות לפי הצורה של השנה שלהם.","Open the **Search** tab: places by the shape of their year."),el:"#sideSearch",pass:true,done:()=>state.side==="search"},
  {do:T_("לחצו **"+nm[0]+"**.","Click **"+nm[1]+"**."),el:'#qShape [data-v="'+shape+'"]',
    run:async()=>{if(S){labSearch(S.query,S.data);return;}srch.shape=shape;srch.dir="";renderSearch();runSearch();await until(()=>srch.data&&!srch.busy,60000);},
    read:SEARCH_READ,after:()=>{Object.assign(srch,{data:null,group:null,active:null});renderSearch();showSide("list");}}];}
// The tools, each used once and read.
function toolSteps(){return [
  {do:T_("לחצו **16 יום** במקרא: כמה לילות יחד, בלי חורים של ענן.","Click **16 days** in the legend: several nights together, without cloud gaps."),el:'#periodSeg [data-days="16"]',
    when:()=>!!lab.data?.period?.images?.[isLR()?"lightroast":"temper"]&&periodAllowed(),
    run:async()=>{const img=lab.data.period.images[isLR()?"lightroast":"temper"],bytes=Uint8Array.from(atob(img),ch=>ch.charCodeAt(0)),bmp=await createImageBitmap(new Blob([bytes],{type:"image/png"}));
      demo.map={image:state.image,title:$("mapTitle").textContent};state.image=bmp;$("mapTitle").textContent=pick("הרכב · ","Composite · ")+periodName(16,lab.data.night);
      for(const b of document.querySelectorAll("#periodSeg button"))b.classList.toggle("active",b.dataset.days==="16");fitMap();},
    read:{title:T_("לילה, או תקופה","A night, or a period"),lead:T_("עכשיו המפה מראה את מחזור 16 הימים של הלילה: מחזור מסלול אחד, כל זווית צילום פעם אחת.","The map now shows the night's 16-day cycle: one orbit cycle, every view angle once."),focus:elBox("#mapWrap"),marks:[
      [at("#periodSeg",.5,0),T_("**לילה · שבוע · 16 יום · חודש · שנה**: בלוק בלוח השנה שבו הלילה.","**Night · Week · 16 days · Month · Year**: the calendar block holding the night.")],
      [at(elBox("#mapWrap"),.5,.35),T_("ב־TEMPER: **הלילה החזק** של כל פיקסל. ב־LIGHT ROAST: **החציון** של הלילות הבהירים.","In TEMPER: each pixel's **strongest night**. In LIGHT ROAST: the **median** of the clear nights.")],
      [at("#exportButton",.5,0),T_("**GeoTIFF** מוריד את אותה תקופה.","**GeoTIFF** downloads the same period.")]],
      own:T_("לילה אחר באותה תקופה מראה את אותה תמונה, בלי לטעון מחדש.","Another night in the same period shows the same picture, without reloading.")},
    after:()=>{if(demo.map){state.image?.close?.();state.image=demo.map.image;$("mapTitle").textContent=demo.map.title;demo.map=null;renderPeriod();renderMap();}}},
  {do:T_("לחצו **אזור לניתוח**: לעבוד רק בתוך אזור שתבחרו.","Click **Area to analyse**: work only inside an area of your choosing."),el:"#focusDraw",when:()=>!!demo.first,
    run:async()=>{const e=demo.first,h=40000,[x,y]=[e.x,e.y];showSide("list");if(lab.data)srch.data=null;
      setWorkArea({id:"tour-demo",name:pick("אזור לדוגמה","An example area"),center:[x,y],size_km:80,kind:"polygon",geometry:{type:"Polygon",coordinates:[[[x-h,y-h*.8],[x+h*.6,y-h],[x+h,y+h*.3],[x+h*.2,y+h],[x-h*.9,y+h*.7],[x-h,y-h*.8]]]}},{temp:true});
      await sleep(100);await until(()=>!state.events.busy&&state.events.data,20000);},
    read:{title:T_("עבודה בתוך אזור","Working inside an area"),lead:T_("ציירתי אזור לדוגמה סביב המקום.","I drew an example area around the place."),focus:elBox("#mapWrap"),marks:[
      [at("#focusBar",.5,0),T_("**הפס**: שם האזור ומה בתוכו; **התאמה** למפה, **GeoTIFF** רק שלו, ו־**✕** חזרה.","**The bar**: the area's name and what is inside; **Fit** the map, a **GeoTIFF** of it only, and **✕** back.")],
      [at(elBox("#mapWrap"),.5,.5),T_("**המפה** מראה רק את האזור.","**The map** shows only the area.")],
      [at("#listTitle",.5,0),T_("**הרשימה**, החיפוש והמקומות הקשורים: רק מה שבתוכו.","**The list**, the search and related places: only what is inside it.")]],
      own:T_("**אזור לניתוח**: לחיצה לכל פינה, לחיצה כפולה לסיום, ושם. נשמר בניתוח האישי.","**Area to analyse**: a click for each corner, a double-click to finish, and a name. Kept in the personal analysis.")}},
  {do:T_("חזרה לכל המדינה: **✕** בפס של האזור.","Back to the whole country: **✕** on the area's bar."),el:"#focusExit",pass:true,done:()=>!state.focusTemp,when:()=>!!state.focusTemp,
    after:()=>{if(state.focusTemp)setWorkArea(null);}},
  {do:T_("פתחו **ניתוח אישי**: המקומות והאזורים ששמרתם.","Open **Personal analysis**: the places and areas you saved."),el:"#sideAreas",pass:true,done:()=>state.side==="areas",
    read:{title:T_("ניתוח אישי","Personal analysis"),focus:elBox(".list-panel"),marks:[
      [at("#areaFromPlace",.5,0),T_("**☆ שמירת המקום**: המקום שבגרף, בשם שלכם.","**☆ Save the place**: the place in the graph, under your name.")],
      [at("#areaDraw",.5,0),T_("**ציור אזור**: פוליגון חופשי על המפה.","**Draw area**: a free polygon on the map.")],
      [()=>at(el("#areasList li")?"#areasList li":"#areasEmpty",.5,0)(),T_("**כל אזור**: לחיצה מציגה אותו בגרפים עם ניתוח האזור; **◎** עובד בתוכו.","**Each area**: a click shows it in the graphs with its area analysis; **◎** works inside it.")],
      [at("#areasView .list-foot",.5,0),T_("**ייצוא** של כולם, ל־GIS.","**Export** them all, for GIS.")]],
      own:T_("שמור במחשב הזה, לכל מדינה בנפרד.","Kept on this computer, per country.")}},
  {do:T_("פתחו **נקודות**: שכבת נקודות מקובץ שלכם.","Open **Points**: a layer of points from a file of yours."),el:"#sidePoints",pass:true,done:()=>state.side==="points",
    done2:()=>{const P2=lab.data?.points;if(!P2)return;pts0.saved??={list:pts.list,data:pts.data,dates:pts.dates,filter:pts.filter,active:pts.active};
      Object.assign(pts,{list:P2.names.map((n,i)=>({name:pick(...n),x:P2.xy[i][0],y:P2.xy[i][1],lonlat:P2.lonlat[i],inside:true})),data:P2.data.points,dates:P2.data.dates,filter:null,active:-1});renderPoints();renderMap();},
    read:{title:T_("שכבת נקודות","A layer of points"),lead:T_("לדוגמה, המקומות של הסיור כנקודות.","For example, the tour's places as points."),focus:elBox(".list-panel"),marks:[
      [at("#pointsImport",.5,0),T_("**ייבוא**: Shapefile, GeoJSON, או CSV עם lat ו־lon.","**Import**: a Shapefile, GeoJSON, or a CSV with lat and lon.")],
      [at("#pointsList .point-spark",.5,0),T_("**בשורה**: כחול, האור לאורך השנה; כתום, החום, רק איפה שבער.","**In a row**: blue, the light over the year; orange, the heat, only where it burned.")],
      [at("#pointsShapes",.5,0),T_("**סינון** לפי צורת השנה של האור.","**Filter** by the shape of the light's year.")],
      [at("#pointsSort",.5,0),T_("**סדר**: כמו בקובץ, השינוי הגדול באור, הכי הרבה לילות חום.","**Order**: as in the file, the largest change in light, the most nights with heat.")],
      [at("#pointsCsv",.5,0),T_("**CSV**: הצורה של כל נקודה, לטבלה.","**CSV**: each point's shapes, as a table.")]],
      own:T_("לחיצה על שורה פותחת את הנקודה בגרף.","A click on a row opens the point in the graph.")},
    after:()=>{if(pts0.saved){Object.assign(pts,pts0.saved);pts0.saved=null;renderPoints();renderMap();}showSide("list");}},
  {do:T_("לחצו **רשת ↗**: איך כל המקומות הקשורים קשורים זה לזה.","Click **Network ↗**: how all the related places are linked to each other."),el:"#similarNet",
    when:()=>!!(lab.data?.network&&!lab.data.network.error),
    before:()=>{const st=story.data,L=lab.data?.story;
      if(st&&L?.related&&!L.related.error){const r=st.related;labRelated({x:r.x,y:r.y,size_km:r.size_km,product:r.seed,label:pick("המקום של הסיור","The tour's place"),onset:r.onset,last:r.last,kind:r.kind||null,lonlat:st.seed.lonlat,ask:r.ask||null},L.related);return;}
      const e=demo.first,r=e&&lab.data?.related?.[e.id];if(r&&!r.error)labRelated({x:e.x,y:e.y,size_km:3,product:state.product,label:label(e),onset:e.onset,last:e.last,kind:e.kind,lonlat:e.lonlat},r);},
    run:()=>{demo.netWin=window.open("network.html?lab=1","viirs-network","popup,width=1200,height=800");},
    read:{title:T_("רשת","The network"),lead:T_("נפתח חלון. כך קוראים אותו:","A window opened. This is how to read it:"),marks:[
      [null,T_("**כל עיגול** הוא מקום; ★ המקום שממנו התחלתם. המספר: הדירוג.","**Each circle** is a place; ★ the one you started from. The number: its rank.")],
      [null,T_("**קו כחול**: עולים ויורדים יחד. **אדום**: הפוך. עבה יותר: קשר חזק יותר.","**A blue line**: they rise and fall together. **Red**: the opposite. Thicker: a stronger link.")],
      [null,T_("**עיגול גדול**: מרכזי, קשור למקומות שהם עצמם קשורים. גוש כחול צפוף: כנראה סיפור אחד.","**A big circle**: central, linked to places that are themselves linked. A dense blue knot: probably one story.")],
      [null,T_("**לפי המפה**: אותם מקומות במקומם. לחיצה על מקום שם פותחת אותו כאן.","**By the map**: the same places where they are. A click on a place there opens it here.")]],
      own:T_("למעלה בחלון בוחרים מה מחפשים. יש בו גם **איך לקרוא את הרשת**. הוא נסגר בצעד הבא.","Up in the window you choose what to look for. It has **How to read the network** too. It closes at the next step.")},
    after:()=>{try{demo.netWin?.close();}catch{}demo.netWin=null;if(state.similar)closeSimilar();}},
  {do:T_("לחצו **↗** בכלי הגרף: הגרפים בחלון משלהם, למסך שני.","Click **↗** in the graph's tools: the graphs in a window of their own, for a second screen."),el:"#chartPop",pass:true,done:()=>!!state.popped,when:()=>state.windows.length>0,
    read:{title:T_("הגרף בחלון משלו","The graph in its own window"),lead:T_("נפתח חלון עם הגרפים.","A window opened with the graphs."),marks:[
      [null,T_("**למעלה** בחלון: **איך לקרוא**, ההסבר של הגרף.","**At the top** of the window: **How to read it**, the graph's guide.")],
      [null,T_("**מה שנפתח כאן** מופיע שם; **לחיצה שם** על לילה מעבירה את המפה כאן.","**What opens here** appears there; **a click there** on a night moves the map here.")],
      [at("#popBar",.5,0),T_("**כאן** נשאר פס: הגרפים בחלון נפרד, ו־**החזרה לכאן**.","**Here** a bar stays: the graphs are in a separate window, and **Bring back**.")]],
      own:null}},
  {do:T_("החזירו אותם: **החזרה לכאן**.","Bring them back: **Bring back**."),el:"#popBack",pass:true,done:()=>!state.popped,when:()=>!!state.popped,after:()=>{if(state.popped)$("popBack").click();}},
  {do:T_("כתבתי נקודה בחיפוש הקואורדינטות. לחצו **🔍**.","I typed a point in the coordinates search. Click **🔍**."),el:"#coordFind button",pass:true,done:()=>typeof coord!=="undefined"&&!!coord.pin,
    when:()=>!!demo.first?.lonlat,before:()=>{const e=demo.first;$("coordInput").value=e.lonlat[1].toFixed(4)+", "+e.lonlat[0].toFixed(4);},
    read:{title:T_("קואורדינטות","Coordinates"),lead:T_("המפה עברה לנקודה וסימנה אותה.","The map moved to the point and marked it."),focus:elBox("#coordBox"),marks:[
      [at("#coordSys",.5,0),T_("**המערכת**: GEO, DMS, UTM, MGRS, ITM או GRID.","**The system**: GEO, DMS, UTM, MGRS, ITM or GRID.")],
      [at("#coordLive",.5,0),T_("**המספר**: הנקודה שמתחת לסמן, או מרכז המפה. לחיצה מעתיקה.","**The number**: the point under the pointer, or the map's centre. A click copies it.")],
      [at("#coordInput",.5,0),T_("**חיפוש**: כל מערכת מזוהה לבד.","**Search**: every system is recognised by itself.")],
      [at("#coordHit",.5,0),T_("**פתיחה בגרף**: הנקודה שנמצאה, לאורך זמן.","**Open in graph**: the point found, over time.")]],
      own:null},
    after:()=>{if(typeof coord!=="undefined"&&coord.pin){coord.pin=null;renderCoordHit();$("coordInput").value="";renderMap();}}},
  {do:T_("לחצו **GeoTIFF** בפינת המפה: להוריד את הלילה כקובץ.","Click **GeoTIFF** in the map's corner: download the night as a file."),el:"#exportButton",run:()=>{},
    read:{title:T_("הורדה כ־GeoTIFF","Download as GeoTIFF"),focus:elBox("#exportButton"),marks:[
      [null,T_("**מה**: התמונה המחוברת מכל המעברים של הלילה (או התקופה), על המלבן שסביב המדינה.","**What**: the image joined from all the night's passes (or the period's), over the rectangle around the country.")],
      [null,T_("**בוחרים**: מוצר, לילה או תקופה, היטל (הרשת של 750 מ׳, או מעלות) ושכבות.","**You choose**: the product, the night or period, the projection (the 750 m grid, or degrees) and the layers.")],
      [null,T_("**בתוך אזור**: חתוך אליו, ומחוץ לו NaN.","**Inside an area**: cut to it, NaN outside.")]],own:null}},
  {do:T_("לחצו **?**: הסיור הזה, בכל רגע.","Click **?**: this tour, at any time."),el:"#helpButton",run:()=>{},
    read:{title:T_("השורה העליונה","The top bar"),focus:elBox(".top-end"),marks:[
      [at("#countryButton",.5,1),T_("**שם המדינה**: מעבר למדינה אחרת.","**The country's name**: switch to another country.")],
      [at("#productTemper",1,1),T_("**TEMPER | LIGHT ROAST**: מעבר מוצר; המקומות והלילה נשארים.","**TEMPER | LIGHT ROAST**: switch product; the places and the night stay.")],
      [at(".top-lang",.5,1),T_("**עב | EN**: שפה.","**עב | EN**: language.")],
      [at("#uiMode",.5,1),T_("**פשוט | מלא**: בפשוט, רק הכלים העיקריים.","**Simple | Full**: Simple shows only the main tools.")],
      [at("#settingsButton",.5,1),T_("**⚙**: חלון ההשוואה, הערוצים הגולמיים, תקופת הבסיס.","**⚙**: the comparison window, the raw bands, the baseline period.")]],own:null}}];}
function steps(){return [...(story.data?storySteps(story.data):changeSteps()),...toolSteps()];}
const ARROW='<svg viewBox="0 0 40 50" aria-hidden="true"><path d="M14 2h12v24h11L20 48 3 26h11z" fill="var(--accent)" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>';
const RIGHT=["לחיצה **ימנית**: הכפתור הימני של העכבר.","A **right** click: the mouse's right button."];
const MISS=["לא שם: לחצו על מה שמסומן.","Not there: click what is marked."];

// ---------- the screen: the dimming with a hole, a ring and an arrow on the control, numbered marks on a result, and
// the card ----------
let root=null,ALL=[],at_=0,seq=0,armed=null,reading=null,atStart=false,raf=0,bypass=false,pending=null;
// What a step showed stays on screen until the next step is done; then what it set up only to show is put back.
function flush(){const f=pending;pending=null;try{f?.();}catch(e){console.warn("tour",e);}}
function build(){
  root=document.createElement("div");root.className="tq";root.hidden=true;
  root.innerHTML='<div class="tq-spot"></div><div class="tq-ring" hidden></div><div class="tq-hand" hidden>'+ARROW+'</div><div class="tq-marks"></div>'+
    '<div class="tq-card tq-ui" role="dialog" aria-live="polite" data-i18n-skip><header><span class="tq-count"></span><button class="tq-skip"></button></header>'+
    '<h3 class="tq-title" hidden></h3><p class="tq-lead" hidden></p><ol class="tq-points" hidden></ol><p class="tq-own" hidden></p><p class="tq-do" hidden></p><p class="tq-miss" hidden></p><div class="tq-acts"></div></div>';
  document.body.append(root);root.querySelector(".tq-skip").onclick=()=>close();}
function parts(text){const out=[];String(text).split("**").forEach((t,i)=>{if(!t)return;if(i%2){const b=document.createElement("b");b.textContent=t;out.push(b);}else out.push(t);});return out;}
const fill=(node,t)=>{node.hidden=!t;node.replaceChildren(...(t?parts(P(t)):[]));};
// The card: the step's number; in a do, what to click; in a read, its title, lead, the numbered parts, how to do it
// on one's own, and Got it.
function card({todo=null,title=null,lead=null,points=null,own=null,buttons=[]}){
  const c=root.querySelector(".tq-card"),acts=c.querySelector(".tq-acts"),ol=c.querySelector(".tq-points");
  c.querySelector(".tq-count").textContent=ALL.length&&at_<ALL.length?(at_+1)+" / "+ALL.length:"";c.querySelector(".tq-skip").textContent=pick("סגירת הסיור","Close the tour");
  fill(c.querySelector(".tq-title"),title);fill(c.querySelector(".tq-lead"),lead);fill(c.querySelector(".tq-do"),todo);
  const o=c.querySelector(".tq-own");o.hidden=!own;o.replaceChildren(...(own?[Object.assign(document.createElement("b"),{className:"tq-own-h",textContent:pick("בעצמכם: ","On your own: ")}),...parts(P(own))]:[]));
  ol.hidden=!points?.length;ol.replaceChildren(...(points||[]).map((t,i)=>{const li=document.createElement("li"),n=document.createElement("i"),s=document.createElement("span");n.textContent=i+1;s.append(...parts(P(t)));li.append(n,s);return li;}));
  c.querySelector(".tq-miss").hidden=true;acts.replaceChildren();c.classList.toggle("reading",!!points);
  for(const [t,fn,cls] of buttons){const x=document.createElement("button");x.className=cls||"tq-btn";x.textContent=t;x.onclick=fn;acts.append(x);}
  c.classList.remove("in");void c.offsetWidth;c.classList.add("in");acts.querySelector(".tq-btn:not(.ghost)")?.focus({preventScroll:true});lastKey="";place(true);}
function targetRect(){if(armed){const t=armed.step;if(t.rect)return t.rect();const e=el(t.el);return e?box(e):null;}
  if(reading?.focus)return reading.focus();return null;}
let lastKey="";
function place(force){if(!root||root.hidden)return;const r=targetRect(),spot=root.querySelector(".tq-spot"),ring=root.querySelector(".tq-ring"),hand=root.querySelector(".tq-hand"),c=root.querySelector(".tq-card"),W=innerWidth,H=innerHeight;
  // the marks follow their parts every frame
  if(reading)for(const [m,f] of reading.marks){const p=f?safe(f):null;m.hidden=!p;if(p){m.style.setProperty("left",p.x+"px");m.style.setProperty("top",p.y+"px");}}
  const key=(r?[r.left,r.top,r.width,r.height].map(Math.round).join():"none")+(armed?"a":"r");if(key===lastKey&&!force)return;lastKey=key;
  const pad=r?.round?2:6;
  if(r){for(const [k,v] of [["left",r.left-pad],["top",r.top-pad],["width",r.width+2*pad],["height",r.height+2*pad]]){spot.style.setProperty(k,v+"px");ring.style.setProperty(k,v+"px");}}
  else{spot.style.setProperty("left",W/2+"px");spot.style.setProperty("top",H/2+"px");spot.style.setProperty("width","0px");spot.style.setProperty("height","0px");}
  spot.classList.toggle("round",!!r?.round);ring.classList.toggle("round",!!r?.round);ring.hidden=!r||!armed;hand.hidden=!r||!armed;
  const cw=c.offsetWidth,ch=c.offsetHeight;
  if(!r){c.style.setProperty("left",Math.max(16,(W-cw)/2)+"px");c.style.setProperty("top",Math.max(16,(H-ch)/2)+"px");return;}
  const up=r.top<80;hand.classList.toggle("up",up);hand.style.setProperty("left",(r.left+r.width/2-20)+"px");hand.style.setProperty("top",(up?r.top+r.height+6:r.top-58)+"px");
  if(reading&&!armed){cardClear(r,c,cw,ch,W,H);return;}
  // the card: on the side of the part with the most room (clear of the arrow), else over the part's far corner
  const room={below:H-r.top-r.height,above:r.top,left:r.left,right:W-r.left-r.width},gap=armed?(up?70:18):14;
  const fits={below:room.below>=ch+gap,above:room.above>=ch+gap,left:room.left>=cw+24,right:room.right>=cw+24};
  const side=Object.entries(room).filter(([k])=>fits[k]).sort((a,b)=>b[1]-a[1])[0]?.[0];let x,y;
  if(side==="below"){x=r.left+r.width/2-cw/2;y=r.top+r.height+gap;}else if(side==="above"){x=r.left+r.width/2-cw/2;y=r.top-ch-(armed?(up?18:70):14);}
  else if(side==="left"){x=r.left-cw-24;y=r.top+r.height/2-ch/2;}else if(side==="right"){x=r.left+r.width+24;y=r.top+r.height/2-ch/2;}
  else{x=W-cw-16;y=H-ch-16;}   // nowhere free: the lower corner
  c.style.setProperty("left",Math.max(12,Math.min(W-cw-12,x))+"px");c.style.setProperty("top",Math.max(12,Math.min(H-ch-12,y))+"px");}
// A read's card: by the part (below, above, beside) or in a corner of the screen, the first place that covers none of
// its marks; failing that, the one covering the fewest, and the least of the part.
function cardClear(r,c,cw,ch,W,H){
  const marks=reading.marks.filter(([m])=>!m.hidden).map(([m])=>m.getBoundingClientRect()),m=12;
  const spots=[[r.left+r.width/2-cw/2,r.top+r.height+14],[r.left+r.width/2-cw/2,r.top-ch-14],[r.left-cw-20,r.top+r.height/2-ch/2],[r.left+r.width+20,r.top+r.height/2-ch/2],
    [W-cw-16,H-ch-16],[16,H-ch-16],[W-cw-16,74],[16,74],[(W-cw)/2,H-ch-16],[(W-cw)/2,74]];
  const over=(x,y,b,pad)=>Math.max(0,Math.min(x+cw,b.right+pad)-Math.max(x,b.left-pad))*Math.max(0,Math.min(y+ch,b.bottom+pad)-Math.max(y,b.top-pad));
  let best=null,score=Infinity;
  for(let [x,y] of spots){x=Math.max(m,Math.min(W-cw-m,x));y=Math.max(m,Math.min(H-ch-m,y));
    const s=marks.filter(b=>over(x,y,b,8)>0).length*1e9+over(x,y,{left:r.left,top:r.top,right:r.left+r.width,bottom:r.top+r.height},0);
    if(s<score-1){score=s;best=[x,y];}}
  c.style.setProperty("left",best[0]+"px");c.style.setProperty("top",best[1]+"px");}
function loop(){place(false);raf=requestAnimationFrame(loop);}

// ---------- the flow ----------
const safe=f=>{try{return f();}catch{return null;}};
async function go(i){
  while(i<ALL.length&&ALL[i].when&&!safe(ALL[i].when))i++;
  if(i>=ALL.length){end();return;}
  at_=i;const s=ALL[at_],my=++seq;armed=null;clearMarks();
  if(s.before)try{await s.before();}catch(e){console.warn("tour",e);}
  if(my!==seq)return;await sleep(60);if(my!==seq)return;
  root.querySelector(".tq-ring").classList.remove("ok");armed={step:s,my,misses:0};card({todo:s.do});
  setTimeout(()=>{if(armed?.my===my&&!targetRect())showMe();},2500);}
function showMe(){if(!armed)return;const acts=root.querySelector(".tq-acts");if(acts.querySelector(".show-me"))return;
  const b=document.createElement("button");b.className="tq-btn ghost show-me";b.textContent=pick("הראו לי","Show me");b.onclick=doFor;acts.append(b);}
// "Show me": the step done as the user's click would do it.
function doFor(){if(!armed)return;const t=armed.step,r=targetRect(),x=r?r.left+r.width/2:innerWidth/2,y=r?r.top+r.height/2:innerHeight/2;
  if(!t.pass)return done({clientX:x,clientY:y,shiftKey:true});
  bypass=true;try{if(t.kind==="context")canvas.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:x,clientY:y,button:2}));else el(t.el)?.click();}finally{bypass=false;}
  check();}
async function check(){const a=armed;if(!a)return;if(await until(()=>safe(a.step.done),1500)&&armed===a)done(null);}
// Done: the ring flashes, the step shows what it does (from the lab), and then its read, or the next step.
async function done(e){const a=armed;if(!a||a.busy)return;a.busy=true;const s=a.step,my=a.my;
  const ring=root.querySelector(".tq-ring");ring.classList.remove("ok");void ring.offsetWidth;ring.classList.add("ok");
  flush();
  if(!s.pass&&s.run)try{await s.run(e||{});}catch(err){console.warn("tour",err);}
  if(s.pass)try{s.done2?.();}catch{}
  pending=s.after||null;armed=null;
  if(my!==seq)return;await sleep(s.read?350:250);if(my!==seq)return;
  if(s.read)read(s);else go(at_+1);}
// The read: the part lit, the numbered marks on it, and the card.
function clearMarks(){reading=null;root?.querySelector(".tq-marks").replaceChildren();}
function read(s){const r=typeof s.read==="function"?s.read():s.read,layer=root.querySelector(".tq-marks");clearMarks();
  const marks=(r.marks||[]).map(([f],i)=>{const m=document.createElement("b");m.className="tq-mark";m.textContent=i+1;m.style.setProperty("--i",i);layer.append(m);return [m,f];});
  reading={focus:r.focus||null,marks};
  card({title:r.title,lead:r.lead,points:(r.marks||[]).map(m=>m[1]),own:r.own,buttons:[[at_===ALL.length-1?pick("סיום ▸","Finish ▸"):pick("הבנתי ▸","Got it ▸"),()=>go(at_+1)]]});}
function miss(e,text){if(!armed||armed.busy)return;const now=Date.now();if(now-(miss.t||0)<500)return;miss.t=now;armed.misses++;
  const m=root.querySelector(".tq-miss");m.replaceChildren(...parts(P(text||armed.step.miss||MISS)));m.hidden=false;
  const hand=root.querySelector(".tq-hand");hand.classList.remove("nudge");void hand.offsetWidth;hand.classList.add("nudge");
  if(armed.misses>=2)showMe();place(true);}
// Clicks: the card takes its own; the marked control takes its click (through to the viewer, or done here from the
// lab); any other click is stopped (with "not there" while a click is awaited). The map and the graph do not zoom
// meanwhile; keys are held, but Enter goes on from a read.
const CLICKS=["pointerdown","pointerup","mousedown","mouseup","click","dblclick","contextmenu","auxclick"];
function guard(e){if(!root||root.hidden||bypass)return;if(e.target.closest?.(".tq-ui"))return;
  const t=armed?.step,r=t?targetRect():null;
  if(t&&inside(r,e.clientX,e.clientY,r?.round?10:4)){
    const fire=t.kind==="context"?e.type==="contextmenu":e.type==="click";
    if(t.kind==="context"&&(e.type==="pointerdown"||e.type==="mousedown")&&e.button===0){e.preventDefault();e.stopImmediatePropagation();if(e.type==="pointerdown")miss(e,RIGHT);return;}
    if(t.pass){if(fire)setTimeout(check,30);return;}
    e.preventDefault();e.stopImmediatePropagation();
    if(fire){if(t.kind==="shift"&&!e.shiftKey){miss(e,["החזיקו **Shift** בזמן הלחיצה.","Hold **Shift** while clicking."]);return;}done(e);}
    return;}
  e.preventDefault();e.stopImmediatePropagation();
  if(e.type==="pointerdown")miss(e);}
for(const t of CLICKS)addEventListener(t,guard,true);
addEventListener("wheel",e=>{if(!root||root.hidden||e.target.closest?.(".tq-ui"))return;if(e.target===canvas||e.target===chart){e.preventDefault();e.stopImmediatePropagation();}},{capture:true,passive:false});
addEventListener("keydown",e=>{if(!root||root.hidden)return;
  if(e.key==="Escape"){e.preventDefault();e.stopImmediatePropagation();const ask=root.querySelector(".tq-ask");ask&&!ask.hidden?answer(false):close();return;}
  if(e.target.closest?.(".tq-ui")&&(e.key==="Enter"||e.key===" "||e.key==="Tab"))return;   // the card's own buttons
  e.stopImmediatePropagation();if(!/^F\d+$/.test(e.key))e.preventDefault();
  if(e.key==="Enter"&&!armed)root.querySelector(".tq-acts .tq-btn:not(.ghost)")?.click();},true);
addEventListener("resize",()=>place(true));

// ---------- start, end, and the question after the opening ----------
async function open(){if(!root)build();root.querySelector(".tq-ask")?.remove();root.hidden=false;document.body.classList.add("touring");armed=null;clearMarks();
  api("/api/tour",{active:true}).catch(()=>{});   // a sandbox: nothing is prepared behind it
  ALL=[];at_=0;card({todo:["רגע…","One moment…"]});cancelAnimationFrame(raf);loop();
  await Promise.all([loadLab(),loadStory()]);if(!lab.data)await loadLists();if(root.hidden)return;
  ALL=steps();at_=-1;go(0);}
function end(){flush();armed=null;clearMarks();at_=ALL.length;lastKey="";
  card({title:atStart?["זה הכל. בוחרים מדינה ומתחילים.","That's all. Choose a country and start."]:["זה הכל.","That's all."],lead:["**?** למעלה מחזיר את הסיור בכל רגע.","**?** up top brings the tour back at any time."],
    buttons:[[atStart?pick("בחירת מדינה ▸","Choose a country ▸"):pick("סגירה","Close"),close]]});}
function close(){if(!root||root.hidden)return;const s=armed?.step;seq++;armed=null;clearMarks();flush();try{s?.after?.();}catch{}
  if(pts0.saved){Object.assign(pts,pts0.saved);pts0.saved=null;renderPoints();}
  root.hidden=true;cancelAnimationFrame(raf);document.body.classList.remove("touring");ALL=[];
  try{demo.netWin?.close();}catch{}if(state.popped)$("popBack").click();
  api("/api/tour",{active:false}).catch(()=>{});   // over: the background starts
  if(atStart){atStart=false;clearTour();state.pickFresh=true;openCountries();}}
function clearTour(){for(const w of [...state.windows])removeWindow(w);state.events.active=null;if(state.similar)closeSimilar();
  Object.assign(srch,{data:null,group:null,active:null});renderSearch();if(state.focusTemp)setWorkArea(null);if(state.rangeFrom||state.rangeTo)zoomTo(null);
  if(typeof coord!=="undefined"&&coord.pin){coord.pin=null;renderCoordHit();}showSide("list");fitMap();renderList();renderChart();
  const ds=productDates();if(ds.length&&state.date!==ds[ds.length-1])setDay(ds[ds.length-1]);}
// After the opening: take the tour, or go straight to work. "Don't ask again" skips the question (? still opens it).
const ASK_KEY="viewer-tour-ask";
function ask(){if(!root)build();root.hidden=false;document.body.classList.add("touring");armed=null;clearMarks();ALL=[];lastKey="";place(true);
  root.querySelector(".tq-card").hidden=true;root.querySelector(".tq-ask")?.remove();
  const box=document.createElement("div");box.className="tq-ask tq-ui";box.dataset.i18nSkip="";box.setAttribute("role","dialog");box.setAttribute("aria-modal","true");
  const prod=isLR()?"LIGHT ROAST":"TEMPER",img=document.createElement("img");img.src=isLR()?"brand/lightroast-emblem.png":"brand/temper-emblem.png";img.alt="";
  const h=document.createElement("h2"),p=document.createElement("p"),acts=document.createElement("div"),yes=document.createElement("button"),no=document.createElement("button"),off=document.createElement("label"),cb=document.createElement("input");
  h.textContent=pick("סיור ב־"+prod+"?","A tour of "+prod+"?");
  p.textContent=pick("לוחצים בעצמכם על כל כלי, על דוגמה מוכנה מ־"+country()+", ורואים איך קוראים את מה שהוא מראה. כעשר דקות.","You click each tool yourself, on a ready example from "+country()+", and see how to read what it shows. About ten minutes.");
  acts.className="tq-ask-acts";yes.className="tq-btn";yes.textContent=pick("לסיור ▸","Take the tour ▸");no.className="tq-btn ghost";no.textContent=pick("ישר לעבודה","Straight to work");
  cb.type="checkbox";off.className="tq-ask-off";off.append(cb," "+pick("לא לשאול שוב","Don't ask again"));
  yes.onclick=()=>answer(true);no.onclick=()=>answer(false);acts.append(yes,no);box.append(img,h,p,acts,off);root.append(box);yes.focus();}
function answer(take){const box=root.querySelector(".tq-ask");if(box?.querySelector("input")?.checked)try{localStorage.setItem(ASK_KEY,"0");}catch{}
  box?.remove();root.querySelector(".tq-card").hidden=false;
  if(take){open();return;}
  root.hidden=true;document.body.classList.remove("touring");api("/api/tour",{active:false}).catch(()=>{});   // no tour: the background starts
  if(atStart){atStart=false;clearTour();state.pickFresh=true;openCountries();}}
// When the first country opens (behind the opening): its lab and story load at once; after the opening, the question.
let asked=false;
document.addEventListener("country-open",async()=>{loadLab().then(()=>{if(!lab.data)loadLists();});loadStory();if(asked)return;asked=true;let off=false;try{off=localStorage.getItem(ASK_KEY)==="0";}catch{}if(off)return;
  if(typeof afterIntro==="function")await afterIntro();setTimeout(()=>{atStart=true;ask();},400);});
// Another language: the card's words again, nothing redone.
document.addEventListener("langchange",()=>{if(!root||root.hidden)return;if(root.querySelector(".tq-ask")){ask();return;}
  if(armed){const m=armed.misses;card({todo:armed.step.do});if(m>=2)showMe();}else if(reading)read(ALL[at_]);else if(at_>=ALL.length&&ALL.length)end();});
document.getElementById("helpButton").onclick=()=>{atStart=false;open();};
window.openTour=open;
/* /i18n-pairs */
})();
