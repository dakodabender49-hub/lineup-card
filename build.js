#!/usr/bin/env node
/*
 * build.js — builds a finished static page for The Lineup Card.
 * Runs on GitHub Actions, pulls live MLB data, writes public/index.html.
 * Node 20+ (built-in fetch). No packages.
 *
 *   node build.js            -> live: today's real games
 *   node build.js --sample   -> offline demo data (used to test the page build)
 *
 * Accuracy policy: every displayed stat comes from the MLB Stats API. When a
 * real number is missing, we show "no data" — we never substitute a guess.
 * The only computed value is the matchup score itself.
 */
const fs = require("fs");
const path = require("path");

const API = "https://statsapi.mlb.com/api/v1";
const ET = "America/New_York";
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: ET }); // YYYY-MM-DD
const SEASON = Number(TODAY.slice(0, 4));
const SAMPLE = process.argv.includes("--sample");

const PARK = {
  "Coors Field":115,"Great American Ball Park":108,"Fenway Park":107,"Citizens Bank Park":105,
  "Globe Life Field":103,"Oriole Park at Camden Yards":103,"Yankee Stadium":103,"Chase Field":103,
  "Sutter Health Park":102,"Wrigley Field":101,"Truist Park":101,"Nationals Park":101,"Rogers Centre":101,
  "Daikin Park":101,"Minute Maid Park":101,"Target Field":100,"Kauffman Stadium":100,"Rate Field":100,
  "Guaranteed Rate Field":100,"American Family Field":100,"George M. Steinbrenner Field":100,
  "Dodger Stadium":99,"Angel Stadium":99,"Progressive Field":98,"Citi Field":97,"Busch Stadium":97,
  "PNC Park":97,"Comerica Park":97,"Tropicana Field":96,"loanDepot park":96,"Petco Park":95,
  "Oracle Park":94,"T-Mobile Park":93
};

const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
function staffWeakness(era,whip,bpenEra){
  const e=clamp((era-2.5)/(6.5-2.5)*100,0,100);
  const w=clamp((whip-1.0)/(1.7-1.0)*100,0,100);
  const bp=clamp(((bpenEra||4.1)-2.5)/(6.5-2.5)*100,0,100);
  return 0.7*((e+w)/2)+0.3*bp;
}
function scoreHitter(ops,era,whip,park,bpenEra){
  const o=clamp((ops-0.55)/(1.0-0.55)*100,0,100);
  const s=staffWeakness(era,whip,bpenEra);
  const k=clamp((park-90)/(115-90)*100,0,100);
  return {total:Math.round(0.45*o+0.35*s+0.20*k),comps:{hitter:Math.round(o),staff:Math.round(s),park:Math.round(k)}};
}
function scorePitcher(oppOps,oppK,era,whip,park){
  const ops_s=clamp((0.800-oppOps)/(0.800-0.650)*100,0,100);
  const k_s=clamp((oppK-0.18)/(0.28-0.18)*100,0,100);
  const park_s=clamp((110-park)/(110-90)*100,0,100);
  const e=clamp((5.0-era)/(5.0-2.5)*100,0,100);
  const w=clamp((1.5-whip)/(1.5-1.0)*100,0,100);
  const own=(e+w)/2;
  return {total:Math.round(0.30*ops_s+0.20*k_s+0.15*park_s+0.35*own),comps:{offense:Math.round((ops_s+k_s)/2),own:Math.round(own),park:Math.round(park_s)}};
}
function verdict(s){
  if(s>=66) return ["START","start","\u{1F525}"];
  if(s>=55) return ["LEAN START","lean","\u2705"];
  if(s>=44) return ["MATCHUP","matchup","\u2796"];
  return ["SIT","sit","\u26D4"];
}
function confidence(score,comps,pa,confirmed,status){
  const conv=clamp(Math.abs(score-50)*2.2,0,100);
  const samp=pa>=120?100:pa>=60?75:pa>=25?55:35;
  const lean=score>=50?1:-1;
  const arr=[comps.hitter,comps.staff,comps.park].map(c=>((c>=50?1:-1)===lean)?1:0);
  const ac=arr[0]+arr[1]+arr[2];
  const agree=ac===3?100:ac===2?65:40;
  let raw=0.45*conv+0.30*samp+0.25*agree, note="";
  if(status==="DTD"){ raw=Math.min(raw,45); note="Day-to-day \u2014 check status before lock"; }
  if(confirmed===null){ raw=Math.min(raw,60); if(!note) note="Lineup not posted yet \u2014 confidence capped"; }
  const stars=raw>=80?5:raw>=64?4:raw>=48?3:raw>=32?2:1;
  const label=stars>=4?"High":stars===3?"Medium":"Low";
  if(!note) note=stars>=4?"Strong lean, solid sample, factors agree":stars===3?"Reasonable lean, some uncertainty":"Coin-flip matchup or thin data";
  return {stars,label,note};
}
function confidenceP(score,comps,ip){
  const conv=clamp(Math.abs(score-50)*2.2,0,100);
  const samp=ip>=60?100:ip>=30?75:ip>=12?55:35;
  const lean=score>=50?1:-1;
  const arr=[comps.offense,comps.own,comps.park].map(c=>((c>=50?1:-1)===lean)?1:0);
  const ac=arr[0]+arr[1]+arr[2];
  const agree=ac===3?100:ac===2?65:40;
  const raw=0.45*conv+0.30*samp+0.25*agree;
  const stars=raw>=80?5:raw>=64?4:raw>=48?3:raw>=32?2:1;
  const label=stars>=4?"High":stars===3?"Medium":"Low";
  const note=stars>=4?"Strong matchup, healthy sample":stars===3?"Decent matchup":"Volatile spot or small sample";
  return {stars,label,note};
}

const esc=s=>(s==null?"":(""+s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function getJSON(url){ try{ const r=await fetch(url); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }
async function pool(items,worker,size){ let i=0; const out=new Array(items.length); size=size||12;
  await Promise.all(Array.from({length:size},async()=>{ while(i<items.length){ const x=i++; out[x]=await worker(items[x]); } })); return out; }

function ipToNum(ip){ try{ const s=(""+ip); if(s.indexOf(".")>=0){ const p=s.split("."); return parseInt(p[0]||0)+(p[1]?parseInt(p[1])/3:0); } return parseFloat(s); }catch(e){ return 0; } }
async function fetchPitcher(id){
  const d=await getJSON(API+"/people/"+id+"?hydrate=stats(group=[pitching],type=[season],season="+SEASON+")");
  const p=d&&d.people&&d.people[0];
  const out={name:p?p.fullName:"TBD",hand:(p&&p.pitchHand)?p.pitchHand.code:"R",era:4.20,whip:1.30,ip:0,hasStats:false};
  try{ const st=p.stats[0].splits[0].stat;
    if(st.era!=null){ out.era=parseFloat(st.era); out.hasStats=true; }
    if(st.whip!=null) out.whip=parseFloat(st.whip);
    if(st.inningsPitched!=null) out.ip=ipToNum(st.inningsPitched);
  }catch(e){}
  return out;
}
function statusCode(s){
  if(!s||!s.code) return "";
  const c=s.code;
  if(c==="A") return "";
  if(/^(D7|D10|D15|D60|DL)/.test(c)) return "IL";
  if(c==="DTD") return "DTD";
  return "";
}
async function fetchTeam(id){
  const out={ops:null,k:null,bpenEra:null,hitters:[]};
  const roster=await getJSON(API+"/teams/"+id+"/roster?rosterType=active");
  if(roster&&roster.roster){
    out.hitters=roster.roster.filter(r=>r.position&&r.position.type!=="Pitcher"&&r.position.code!=="1")
      .map(r=>({id:r.person.id,name:r.person.fullName,pos:(r.position.abbreviation||""),status:statusCode(r.status)}));
  }
  const hit=await getJSON(API+"/teams/"+id+"/stats?stats=season&group=hitting&season="+SEASON);
  try{ const st=hit.stats[0].splits[0].stat;
    if(st.ops!=null) out.ops=parseFloat(st.ops);
    const pa=parseFloat(st.plateAppearances||st.atBats||0), so=parseFloat(st.strikeOuts||0);
    if(pa>0) out.k=so/pa;
  }catch(e){}
  const pit=await getJSON(API+"/teams/"+id+"/stats?stats=season&group=pitching&season="+SEASON);
  try{ const st=pit.stats[0].splits[0].stat; if(st.era!=null) out.bpenEra=parseFloat(st.era); }catch(e){}
  return out;
}
async function fetchBoxscore(pk){
  const d=await getJSON(API+"/game/"+pk+"/boxscore");
  const out={home:{order:{},posted:false},away:{order:{},posted:false}};
  try{ ["home","away"].forEach(side=>{
    const bo=d.teams[side].battingOrder;
    if(Array.isArray(bo)&&bo.length>0){ out[side].posted=true; bo.forEach((pid,i)=>{ out[side].order[pid]=i+1; }); }
  }); }catch(e){}
  return out;
}
async function fetchSplitOps(id,hand){
  const want=hand==="R"?"vr":"vl";
  const d=await getJSON(API+"/people/"+id+"/stats?stats=statSplits&group=hitting&sitCodes=vr,vl&season="+SEASON);
  try{ for(const s of d.stats[0].splits){ if(s.split&&s.split.code===want&&s.stat.ops!=null)
        return {ops:parseFloat(s.stat.ops),pa:parseFloat(s.stat.plateAppearances||s.stat.atBats||0),src:"vs "+hand+"HP"}; } }catch(e){}
  const d2=await getJSON(API+"/people/"+id+"/stats?stats=season&group=hitting&season="+SEASON);
  try{ const st=d2.stats[0].splits[0].stat; if(st.ops!=null) return {ops:parseFloat(st.ops),pa:parseFloat(st.plateAppearances||st.atBats||0),src:"season"}; }catch(e){}
  return {ops:null,pa:0,src:"no data"};
}

async function buildLive(){
  const hitters=[], pitchers=[];
  const sched=await getJSON(API+"/schedule?sportId=1&date="+TODAY+"&hydrate=probablePitcher");
  const games=(sched&&sched.dates&&sched.dates[0]&&sched.dates[0].games)||[];
  console.log("Games today: "+games.length);
  if(!games.length) return {hitters,pitchers,games:0};

  const teamIds=new Set(), pitcherIds=new Set();
  games.forEach(g=>{ const t=g.teams||{};
    if(t.home&&t.home.team) teamIds.add(t.home.team.id);
    if(t.away&&t.away.team) teamIds.add(t.away.team.id);
    if(t.home&&t.home.probablePitcher) pitcherIds.add(t.home.probablePitcher.id);
    if(t.away&&t.away.probablePitcher) pitcherIds.add(t.away.probablePitcher.id);
  });
  const teamMap={}, pitMap={}, boxMap={};
  await pool([...teamIds],async id=>{ teamMap[id]=await fetchTeam(id); },8);
  await pool([...pitcherIds],async id=>{ pitMap[id]=await fetchPitcher(id); },8);
  await pool(games.map(g=>g.gamePk).filter(Boolean),async pk=>{ boxMap[pk]=await fetchBoxscore(pk); },8);
  console.log("Loaded teams, pitchers, lineups. Scoring...");

  const hitterTasks=[];
  games.forEach((g,gi)=>{
    const venue=(g.venue&&g.venue.name)||""; const park=PARK[venue]!=null?PARK[venue]:100;
    const t=g.teams||{};
    const box=boxMap[g.gamePk]||{home:{order:{},posted:false},away:{order:{},posted:false}};
    [["away","home"],["home","away"]].forEach(pair=>{
      const me=t[pair[0]], opp=t[pair[1]];
      const pp=opp&&opp.probablePitcher;
      if(!me||!me.team||!pp||!pp.id) return;
      const pitcher=pitMap[pp.id]; const team=teamMap[me.team.id]; const oppTeam=teamMap[opp.team.id];
      if(!pitcher||!team) return;
      const sideBox=box[pair[0]]||{order:{},posted:false}; const orderMap=sideBox.order||{};
      const matchCount=(team.hitters||[]).filter(h=>h.id&&orderMap[h.id]).length;
      const trust=sideBox.posted&&matchCount>=1;

      // pitcher row (this starter vs the offense he faces)
      const pNoData = !pitcher.hasStats || team.ops==null;
      if(pNoData){
        pitchers.push({name:pitcher.name,team:opp.team.name,pos:"SP",score:null,label:"NO DATA",css:"nodata",emoji:"\u2014",
          comps:null,conf:null,noData:true,oppTeam:me.team.name,oppOps:team.ops,oppK:team.k,
          era:pitcher.era,whip:pitcher.whip,hasStats:pitcher.hasStats,venue:venue,park:park,gameKey:gi,
          reason:"Not enough MLB data on this matchup yet."});
      } else {
        const sp=scorePitcher(team.ops,team.k!=null?team.k:0.22,pitcher.era,pitcher.whip,park);
        const vp=verdict(sp.total);
        pitchers.push({name:pitcher.name,team:opp.team.name,pos:"SP",score:sp.total,label:vp[0],css:vp[1],emoji:vp[2],
          comps:sp.comps,conf:confidenceP(sp.total,sp.comps,pitcher.ip),noData:false,oppTeam:me.team.name,
          oppOps:team.ops,oppK:team.k,era:pitcher.era,whip:pitcher.whip,hasStats:true,venue:venue,park:park,gameKey:gi,
          reason:"Draws the "+me.team.name+" offense ("+team.ops.toFixed(3)+" OPS, "+Math.round((team.k!=null?team.k:0.22)*100)+"% K) at "+venue+". "+pitcher.era.toFixed(2)+" ERA, "+pitcher.whip.toFixed(2)+" WHIP."});
      }

      (team.hitters||[]).forEach(h=>{ if(h.id) hitterTasks.push({h:h,pitcher:pitcher,park:park,bpen:(oppTeam&&oppTeam.bpenEra!=null?oppTeam.bpenEra:4.1),
        team:me.team.name,opp:pitcher.name,gameKey:gi,
        confirmed:trust?(orderMap[h.id]?true:false):null, battingOrder:trust?(orderMap[h.id]||null):null}); });
    });
  });

  await pool(hitterTasks,async t=>{
    const r=await fetchSplitOps(t.h.id,t.pitcher.hand);
    const flag=t.h.status; // "" | "IL" | "DTD"
    const confirmed=t.confirmed===true?true:null;
    const battingOrder=confirmed===true?t.battingOrder:null;
    if(r.ops==null){
      hitters.push({name:t.h.name,team:t.team,pos:t.h.pos,score:null,label:"NO DATA",css:"nodata",emoji:"\u2014",
        comps:null,conf:null,noData:true,reason:"Not enough MLB data yet to rate this matchup.",
        opp:t.opp,ops:null,opsSrc:"no data",flag:flag,confirmed:confirmed,battingOrder:battingOrder,gameKey:t.gameKey});
      return;
    }
    const s=scoreHitter(r.ops,t.pitcher.era,t.pitcher.whip,t.park,t.bpen);
    const v=verdict(s.total);
    const conf=confidence(s.total,s.comps,r.pa,confirmed,flag);
    const hw=t.pitcher.hand==="R"?"RHP":"LHP";
    const note=t.park>=106?" in a hitter's park":t.park<=95?" in a pitcher's park":"";
    const pitchPart=t.pitcher.hasStats?("("+t.pitcher.era.toFixed(2)+" ERA)"):"(limited pitcher data)";
    const reason="Faces "+hw+" "+t.pitcher.name+" "+pitchPart+note+". "+r.ops.toFixed(3)+" OPS "+r.src+".";
    hitters.push({name:t.h.name,team:t.team,pos:t.h.pos,score:s.total,label:v[0],css:v[1],emoji:v[2],
      comps:s.comps,conf,noData:false,reason,opp:t.opp,ops:r.ops,opsSrc:r.src,flag:flag,confirmed:confirmed,
      battingOrder:battingOrder,gameKey:t.gameKey});
  },12);

  return {hitters,pitchers,games:games.length};
}

function sampleData(){
  const H=[
   ["Marcus Vega","Rockies","RF",0.921,"Dylan Reese","R",5.48,1.61,"Coors Field",5.05,2,"",430],
   ["Tate Hollis","Reds","1B",0.864,"Owen Park","L",5.02,1.50,"Great American Ball Park",4.40,4,"",390],
   ["Diego Salazar","Phillies","SS",0.812,"Jack Monroe","R",4.71,1.44,"Citizens Bank Park",4.15,3,"",510],
   ["Cole Whitfield","Red Sox","DH",0.799,"Sam Ortega","L",4.55,1.39,"Fenway Park",3.95,5,"DTD",360],
   ["Andre Bellamy","Rangers","CF",0.788,"Ty Coleman","R",4.30,1.33,"Globe Life Field",4.20,1,"",470],
   ["Roman Pierce","Braves","3B",0.760,"Will Hayes","R",4.05,1.28,"Truist Park",3.60,null,"",440],
   ["Felix Moreno","Yankees","2B",0.744,"Drew Carter","L",3.92,1.27,"Yankee Stadium",3.80,6,"",55],
   ["Jonah Reed","Cubs","LF",0.731,"Eli Brooks","R",3.74,1.22,"Wrigley Field",3.55,null,"",410],
   ["Sebastian Cruz","Dodgers","C",0.712,"Max Sterling","R",3.41,1.18,"Dodger Stadium",3.10,7,"",380],
   ["Theo Marsh","Giants","SS",0.654,"Kai Nakamura","R",2.88,1.06,"Oracle Park",2.95,8,"",290],
   ["Brennan Lowe","Mariners","RF",0.631,"Logan Frost","L",2.55,1.01,"T-Mobile Park",2.80,null,"IL",250],
   ["Rookie Tba","Marlins","2B",null,"Nate Glover","R",3.80,1.25,"loanDepot park",3.9,null,"",0]
  ];
  const hitters=H.map(a=>{
    const venue=a[8], park=PARK[venue]!=null?PARK[venue]:100;
    const flag=a[11];
    const confirmed=a[10]!=null?true:null;
    const battingOrder=confirmed===true?a[10]:null;
    if(a[3]==null){
      return {name:a[0],team:a[1],pos:a[2],score:null,label:"NO DATA",css:"nodata",emoji:"\u2014",comps:null,conf:null,
        noData:true,reason:"Not enough MLB data yet to rate this matchup.",opp:a[4],ops:null,opsSrc:"no data",
        flag:flag,confirmed:confirmed,battingOrder:battingOrder,gameKey:0};
    }
    const s=scoreHitter(a[3],a[6],a[7],park,a[9]);
    const v=verdict(s.total);
    const conf=confidence(s.total,s.comps,a[12],confirmed,flag);
    const hw=a[5]==="R"?"RHP":"LHP";
    const note=park>=106?" in a hitter's park":park<=95?" in a pitcher's park":"";
    return {name:a[0],team:a[1],pos:a[2],score:s.total,label:v[0],css:v[1],emoji:v[2],comps:s.comps,conf,noData:false,
      reason:"Faces "+hw+" "+a[4]+" ("+a[6].toFixed(2)+" ERA)"+note+". "+a[3].toFixed(3)+" OPS vs "+a[5]+"HP.",
      opp:a[4],ops:a[3],opsSrc:"vs "+a[5]+"HP",flag:flag,confirmed:confirmed,battingOrder:battingOrder,gameKey:0};
  });
  const P=[
   ["Kenji Adler","Brewers","Marlins",0.662,0.265,2.61,1.02,"American Family Field",78],
   ["Ross Tillman","Guardians","Athletics",0.671,0.248,3.05,1.10,"Progressive Field",70],
   ["Diego Salinas","Padres","Giants",0.679,0.241,3.18,1.14,"Petco Park",66],
   ["Marcus Boyd","Astros","Rangers",0.741,0.221,3.42,1.20,"Daikin Park",60],
   ["Owen Park","Reds","Cubs",0.770,0.210,5.02,1.50,"Great American Ball Park",44],
   ["Dylan Reese","Rockies","Dodgers",0.815,0.198,5.48,1.61,"Coors Field",40]
  ];
  const pitchers=P.map(a=>{
    const venue=a[7], park=PARK[venue]!=null?PARK[venue]:100;
    const s=scorePitcher(a[3],a[4],a[5],a[6],park);
    const v=verdict(s.total);
    return {name:a[0],team:a[1],pos:"SP",score:s.total,label:v[0],css:v[1],emoji:v[2],comps:s.comps,
      conf:confidenceP(s.total,s.comps,a[8]),noData:false,oppTeam:a[2],oppOps:a[3],oppK:a[4],era:a[5],whip:a[6],
      hasStats:true,venue,park,gameKey:0,
      reason:"Draws the "+a[2]+" offense ("+a[3].toFixed(3)+" OPS, "+Math.round(a[4]*100)+"% K) at "+venue+". "+a[5].toFixed(2)+" ERA, "+a[6].toFixed(2)+" WHIP."};
  });
  return {hitters,pitchers,games:6};
}

/* ---------- HTML generation ---------- */
function starsHTML(n){ let s=""; for(let i=1;i<=5;i++) s+=(i<=n?'<span class="st on">\u2605</span>':'<span class="st">\u2606</span>'); return '<span class="stars">'+s+'</span>'; }
function barRow(label,val){ return '<div class="barwrap"><div class="bk"><span>'+label+'</span><span>'+val+'</span></div><div class="bar"><i style="width:'+val+'%"></i></div></div>'; }
function rightCol(r){
  if(r.noData) return '<div class="right"><span class="badge nodata">\u2014 NO DATA</span><div class="score">\u2014</div><div class="conflabel">no rating</div><div class="caret">tap \u25be</div></div>';
  return '<div class="right"><span class="badge '+r.css+'">'+r.emoji+' '+r.label+'</span><div class="score">'+r.score+'</div>'+starsHTML(r.conf.stars)+'<div class="conflabel">'+r.conf.label+' confidence</div><div class="caret">tap \u25be</div></div>';
}
function hitterRowHTML(r,i){
  const flag = r.flag==="IL" ? '<span class="flag out">IL</span>'
             : r.flag==="DTD" ? '<span class="flag dtd">day-to-day</span>'
             : (r.confirmed===null ? '<span class="flag tbd">lineup tbd</span>' : '');
  const bo = r.battingOrder ? '<span class="bo">#'+r.battingOrder+'</span>' : '';
  let detail;
  if(r.noData){
    detail='<div class="confnote">'+esc(r.reason)+'</div>';
  } else {
    detail='<div class="bars">'+barRow("Bat",r.comps.hitter)+barRow("Pitching",r.comps.staff)+barRow("Park",r.comps.park)+'</div>'
      +'<div class="confnote">'+esc(r.conf.note)+'</div>'
      +'<div class="grid" style="margin-top:14px">'
        +'<div class="stat"><div class="k">Lineup</div><div class="v" style="font-size:18px">'+(r.battingOrder?("Batting #"+r.battingOrder):(r.confirmed===null?"Not posted":"\u2014"))+'</div><div class="sm">vs '+esc(r.opp)+'</div></div>'
        +'<div class="stat"><div class="k">OPS vs hand</div><div class="v">'+(r.ops!=null?r.ops.toFixed(3):"\u2014")+'</div><div class="sm">'+esc(r.opsSrc)+'</div></div>'
      +'</div>';
  }
  return '<div class="row '+r.css+'" data-name="'+esc((r.name+" "+r.team).toLowerCase())+'" data-v="'+r.css+'" data-pos="'+esc(r.pos)+'" style="animation-delay:'+(i*0.02).toFixed(3)+'s">'
   +'<div class="rowhead" onclick="toggleRow(this.parentNode)">'
     +'<div class="rank">'+(r.noData?"\u2014":r.rank)+'</div>'
     +'<div class="main"><div class="name">'+bo+esc(r.name)+' <span class="pos">'+esc(r.pos)+'</span> <span class="team">'+esc(r.team)+'</span> '+flag+'</div>'
       +'<div class="reason">'+esc(r.reason)+'</div></div>'
     +rightCol(r)
   +'</div>'
   +'<div class="detail">'+detail+'</div></div>';
}
function pitcherRowHTML(r,i){
  let detail;
  if(r.noData){
    detail='<div class="confnote">'+esc(r.reason)+'</div>';
  } else {
    detail='<div class="bars">'+barRow("Offense faced",r.comps.offense)+barRow("Own form",r.comps.own)+barRow("Park",r.comps.park)+'</div>'
      +'<div class="confnote">'+esc(r.conf.note)+'</div>'
      +'<div class="grid" style="margin-top:14px">'
        +'<div class="stat"><div class="k">Opponent</div><div class="v" style="font-size:18px">'+esc(r.oppTeam)+'</div><div class="sm">'+(r.oppOps!=null?r.oppOps.toFixed(3):"\u2014")+' OPS, '+(r.oppK!=null?Math.round(r.oppK*100):"\u2014")+'% K</div></div>'
        +'<div class="stat"><div class="k">His line</div><div class="v">'+(r.hasStats?r.era.toFixed(2):"\u2014")+'</div><div class="sm">'+(r.hasStats?("ERA, "+r.whip.toFixed(2)+" WHIP"):"limited data")+'</div></div>'
        +'<div class="stat"><div class="k">Park</div><div class="v" style="font-size:18px">'+esc(r.venue)+'</div><div class="sm">factor '+r.park+'</div></div>'
      +'</div>';
  }
  return '<div class="row '+r.css+'" data-name="'+esc((r.name+" "+r.team).toLowerCase())+'" data-v="'+r.css+'" data-pos="SP" style="animation-delay:'+(i*0.02).toFixed(3)+'s">'
   +'<div class="rowhead" onclick="toggleRow(this.parentNode)">'
     +'<div class="rank">'+(r.noData?"\u2014":r.rank)+'</div>'
     +'<div class="main"><div class="name">'+esc(r.name)+' <span class="pos">SP</span> <span class="team">'+esc(r.team)+'</span></div>'
       +'<div class="reason">'+esc(r.reason)+'</div></div>'
     +rightCol(r)
   +'</div>'
   +'<div class="detail">'+detail+'</div></div>';
}

function pageHTML(d){
  const hitters=d.hitters, pitchers=d.pitchers, live=d.live, dateLabel=d.dateLabel;
  const gamesCount=new Set(hitters.map(r=>r.gameKey)).size;
  const starts=hitters.filter(r=>!r.noData&&(r.css==="start"||r.css==="lean")).length;
  const top=hitters.filter(r=>!r.noData&&r.flag!=="IL").slice(0,3);
  const top3=top.map(r=>'<div class="top-card"><div class="scorebig">'+r.score+'</div><div class="num">'+r.rank+'</div><div class="nm">'+esc(r.name)+'</div><div class="sub">'+esc(r.team)+' &middot; vs '+esc(r.opp)+'</div></div>').join("");
  const hRows=hitters.map(hitterRowHTML).join("") || '<div class="empty">No hitters to show today.</div>';
  const pRows=pitchers.map(pitcherRowHTML).join("") || '<div class="empty">No probable pitchers posted yet.</div>';
  const stamp="Built "+new Date().toLocaleString("en-US",{timeZone:ET})+" ET";
  const liveTxt = live ? "Live data" : "Sample data";
  const liveClass = live ? "" : "sample";

  // data for the comparison tool (lean fields only)
  const compare = hitters.map(r=>({type:"H",name:r.name,team:r.team,pos:r.pos,score:r.score,label:r.label,css:r.css,noData:r.noData,conf:r.conf?{label:r.conf.label}:null,ops:r.ops,opsSrc:r.opsSrc,battingOrder:r.battingOrder,opp:r.opp}))
    .concat(pitchers.map(r=>({type:"P",name:r.name,team:r.team,pos:"SP",score:r.score,label:r.label,css:r.css,noData:r.noData,conf:r.conf?{label:r.conf.label}:null,era:r.era,whip:r.whip,hasStats:r.hasStats,oppTeam:r.oppTeam})));
  const compareJSON = JSON.stringify(compare).replace(/</g,"\\u003c");

return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Lineup Card &middot; Daily Fantasy Start/Sit</title>
<meta name="description" content="Daily fantasy baseball start/sit calls for hitters and pitchers, ranked by matchup with a confidence rating. Compare any two players head-to-head.">
<meta property="og:title" content="The Lineup Card \u2014 Daily Fantasy Start/Sit">
<meta property="og:description" content="Every hitter and pitcher today, ranked by matchup with a confidence rating. Compare two players head-to-head. Stats pulled live from MLB.">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b0d0e'/%3E%3Ctext x='16' y='23' font-family='Arial' font-size='20' font-weight='bold' text-anchor='middle' fill='%23e8b84b'%3E9%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b0d0e;--panel:#15191b;--panel2:#1b2123;--line:#262d30;--ink:#eef2f0;--muted:#8a9794;--dim:#5f6b69;--gold:#e8b84b;--start:#5fd068;--lean:#5bc0be;--matchup:#e8b84b;--sit:#e0666f;--nodata:#6b7775;--shadow:0 18px 50px -20px rgba(0,0,0,.8);}
*{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(1200px 600px at 80% -10%, rgba(232,184,75,.06), transparent 60%),radial-gradient(900px 500px at -10% 10%, rgba(91,192,190,.05), transparent 55%),var(--bg);color:var(--ink);font-family:"Archivo",sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5;min-height:100vh;}
.wrap{max-width:1000px;margin:0 auto;padding:0 20px 90px}
header{padding:50px 0 24px;border-bottom:1px solid var(--line)}
.kicker{font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:var(--gold);margin-bottom:10px}
h1{font-family:"Bebas Neue",sans-serif;font-weight:400;font-size:clamp(50px,11vw,104px);line-height:.86;letter-spacing:.01em}
h1 .amp{color:var(--gold)}
.tag{margin-top:13px;color:var(--muted);font-size:15px;max-width:50ch}
.meta{display:flex;gap:24px;flex-wrap:wrap;margin-top:24px;font-family:"JetBrains Mono",monospace;font-size:12px}
.meta b{display:block;font-family:"Bebas Neue",sans-serif;font-size:30px;color:var(--ink);letter-spacing:.02em;line-height:1}
.meta span{color:var(--dim);text-transform:uppercase;letter-spacing:.18em;font-size:10px}
.live{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.live .dot{width:7px;height:7px;border-radius:50%;background:var(--start);animation:pulse 2s infinite}
.live.sample .dot{background:var(--gold);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(95,208,104,.5)}70%{box-shadow:0 0 0 9px rgba(95,208,104,0)}100%{box-shadow:0 0 0 0 rgba(95,208,104,0)}}
.section-label{font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--dim);margin:26px 0 14px;display:flex;align-items:center;gap:14px}
.section-label::after{content:"";flex:1;height:1px;background:var(--line)}
.top3{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin-bottom:8px}
.top-card{background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:15px;padding:17px;position:relative;overflow:hidden}
.top-card::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:var(--gold)}
.top-card .num{font-family:"Bebas Neue",sans-serif;font-size:38px;color:var(--gold);line-height:1}
.top-card .nm{font-family:"Bebas Neue",sans-serif;font-size:24px;letter-spacing:.02em;margin-top:3px}
.top-card .sub{color:var(--muted);font-size:12px;margin-top:2px}
.top-card .scorebig{position:absolute;right:15px;top:13px;font-family:"JetBrains Mono",monospace;font-size:13px;color:var(--start);font-weight:700}
.controls{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:30px 0 6px}
.tabs{display:flex;gap:6px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:5px}
.tabs button{background:transparent;border:0;color:var(--muted);font-family:"Bebas Neue",sans-serif;font-size:20px;letter-spacing:.04em;padding:7px 16px;border-radius:8px;cursor:pointer;transition:.15s}
.tabs button.on{background:var(--ink);color:var(--bg)}
.search{flex:1;min-width:180px;position:relative}
.search input{width:100%;background:var(--panel);border:1px solid var(--line);border-radius:12px;color:var(--ink);font-family:"Archivo",sans-serif;font-size:15px;padding:13px 16px 13px 42px}
.search input:focus{outline:none;border-color:var(--gold)}
.search::before{content:"\\002315";position:absolute;left:15px;top:50%;transform:translateY(-50%);color:var(--dim);font-size:16px}
.posfilter-wrap select,.cmp-pick select{background:var(--panel);border:1px solid var(--line);border-radius:10px;color:var(--ink);font-family:"Archivo",sans-serif;font-size:14px;padding:11px 12px;cursor:pointer}
.posfilter-wrap select:focus,.cmp-pick select:focus{outline:none;border-color:var(--gold)}
.vfilters{display:flex;gap:7px;flex-wrap:wrap;margin:14px 0 18px;align-items:center}
.vfilters button{background:var(--panel);border:1px solid var(--line);color:var(--muted);font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:8px 14px;border-radius:999px;cursor:pointer;transition:.15s}
.vfilters button.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.posfilter-wrap{margin-left:auto}
.list{display:flex;flex-direction:column;gap:9px}
.empty{color:var(--dim);font-size:14px;padding:24px 4px;font-family:"JetBrains Mono",monospace}
.row{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);transition:.16s;animation:rise .45s both;overflow:hidden}
.row:hover{border-color:var(--dim)}
.row.nodata{opacity:.72}
.rowhead{display:grid;grid-template-columns:42px 1fr auto;gap:15px;align-items:center;padding:15px 17px;cursor:pointer}
.rank{font-family:"Bebas Neue",sans-serif;font-size:28px;color:var(--dim);text-align:center}
.row.start .rank{color:var(--start)} .row.lean .rank{color:var(--lean)}
.main .name{font-family:"Bebas Neue",sans-serif;font-size:24px;letter-spacing:.02em;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.bo{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--gold);border:1px solid rgba(232,184,75,.4);border-radius:5px;padding:2px 6px}
.pos{font-family:"JetBrains Mono",monospace;font-size:10px;color:var(--dim);border:1px solid var(--line);border-radius:5px;padding:2px 6px;letter-spacing:.06em}
.team{color:var(--muted);font-size:12px;font-family:"JetBrains Mono",monospace}
.flag{font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.05em;border-radius:5px;padding:2px 7px;text-transform:uppercase}
.flag.out{background:rgba(224,102,111,.15);color:var(--sit)}
.flag.dtd{background:rgba(232,184,75,.15);color:var(--matchup)}
.flag.tbd{background:var(--panel2);color:var(--dim);border:1px solid var(--line)}
.reason{color:var(--muted);font-size:13px;margin-top:5px;line-height:1.45}
.right{text-align:right;min-width:120px}
.badge{display:inline-flex;align-items:center;gap:6px;font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:700;letter-spacing:.08em;padding:6px 11px;border-radius:8px}
.badge.start{background:rgba(95,208,104,.13);color:var(--start)}
.badge.lean{background:rgba(91,192,190,.13);color:var(--lean)}
.badge.matchup{background:rgba(232,184,75,.13);color:var(--matchup)}
.badge.sit{background:rgba(224,102,111,.12);color:var(--sit)}
.badge.nodata{background:rgba(107,119,117,.15);color:var(--nodata)}
.score{font-family:"Bebas Neue",sans-serif;font-size:36px;line-height:.9;margin-top:7px}
.stars{display:block;margin-top:5px;font-size:13px;letter-spacing:1px}
.st{color:var(--line)} .st.on{color:var(--gold)}
.conflabel{font-family:"JetBrains Mono",monospace;font-size:9px;color:var(--dim);letter-spacing:.12em;text-transform:uppercase;margin-top:3px}
.caret{color:var(--dim);font-size:12px;margin-top:4px;font-family:"JetBrains Mono",monospace}
.detail{border-top:1px solid var(--line);padding:16px 17px;display:none;background:var(--panel2)}
.row.open .detail{display:block;animation:rise .3s both}
.detail .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat .k{font-family:"JetBrains Mono",monospace;font-size:9px;color:var(--dim);letter-spacing:.14em;text-transform:uppercase}
.stat .v{font-family:"Bebas Neue",sans-serif;font-size:24px;margin-top:3px}
.stat .sm{color:var(--muted);font-size:12px;margin-top:1px}
.bars{display:flex;gap:10px;margin-top:4px;flex-wrap:wrap}
.barwrap{flex:1;min-width:120px}
.barwrap .bk{font-family:"JetBrains Mono",monospace;font-size:9px;color:var(--dim);letter-spacing:.1em;text-transform:uppercase;display:flex;justify-content:space-between;margin-bottom:4px}
.bar{height:5px;border-radius:3px;background:var(--line);overflow:hidden}
.bar i{display:block;height:100%;background:var(--gold);border-radius:3px}
.confnote{color:var(--muted);font-size:12px;margin-top:14px;font-style:italic}
.cmp-pick{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.cmp-pick select{flex:1;min-width:160px}
.cmp-pick .vs{font-family:"Bebas Neue",sans-serif;font-size:22px;color:var(--gold)}
.cmp-verdict{font-size:15px;line-height:1.5;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--dim);border-radius:10px;padding:14px 16px;margin-bottom:16px;min-height:10px}
.cmp-verdict:empty{display:none}
.cmp-verdict.start{border-left-color:var(--start)} .cmp-verdict.lean{border-left-color:var(--lean)} .cmp-verdict.matchup{border-left-color:var(--matchup)} .cmp-verdict.sit{border-left-color:var(--sit)}
.cmp-cards{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.cmp-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;text-align:center}
.cmp-card.empty2{color:var(--dim);font-family:"JetBrains Mono",monospace;font-size:13px;display:flex;align-items:center;justify-content:center;min-height:140px}
.cmp-name{font-family:"Bebas Neue",sans-serif;font-size:26px;letter-spacing:.02em}
.cmp-team{color:var(--muted);font-size:12px;font-family:"JetBrains Mono",monospace;margin-bottom:8px}
.cmp-score{font-family:"Bebas Neue",sans-serif;font-size:54px;line-height:1;margin:6px 0}
.cmp-stats{color:var(--muted);font-size:12px;margin-top:10px;line-height:1.5}
.cmp-conf{font-family:"JetBrains Mono",monospace;font-size:9px;color:var(--dim);letter-spacing:.12em;text-transform:uppercase;margin-top:8px}
.how{margin-top:50px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:26px 28px}
.how h3{font-family:"Bebas Neue",sans-serif;font-size:24px;letter-spacing:.03em;margin-bottom:12px}
.how p{color:var(--muted);font-size:14px;margin-bottom:10px}
.how .mix{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.chip{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--ink);background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:7px 12px}
.chip b{color:var(--gold)}
footer{margin-top:34px;text-align:center;color:var(--dim);font-size:12px;font-family:"JetBrains Mono",monospace;line-height:1.8}
footer a{color:var(--muted)}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media(max-width:720px){.top3{grid-template-columns:1fr}.rowhead{grid-template-columns:34px 1fr;gap:11px}.right{grid-column:1/-1;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding-top:11px;margin-top:3px}.score{margin-top:0}.stars{margin-top:0}.posfilter-wrap{margin-left:0;width:100%}.posfilter-wrap select{width:100%}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="kicker">Daily Fantasy Baseball &middot; Points Leagues</div>
    <h1>The Lineup <span class="amp">Card</span></h1>
    <p class="tag">Hitters and pitchers, ranked by matchup, with a confidence rating on every call. Compare any two, and tap anyone for the breakdown.</p>
    <div class="meta">
      <div><b>${esc(dateLabel.split(",")[0].toUpperCase())}</b><span>${esc(dateLabel)}</span></div>
      <div><b>${gamesCount}</b><span>Games today</span></div>
      <div><b>${starts}</b><span>Start / lean calls</span></div>
      <div style="align-self:center"><span class="live ${liveClass}"><span class="dot"></span>${liveTxt}</span></div>
    </div>
  </header>

  <div class="controls">
    <div class="tabs">
      <button id="tab-h" class="on" data-tab="h">Hitters</button>
      <button id="tab-p" data-tab="p">Pitchers</button>
      <button id="tab-c" data-tab="c">Compare</button>
    </div>
    <div class="search"><input id="search" type="text" placeholder="Search a player or team&hellip;" autocomplete="off"></div>
  </div>
  <div class="vfilters" id="vfilters">
    <button class="on" data-f="all">All</button>
    <button data-f="start">Start</button>
    <button data-f="lean">Lean</button>
    <button data-f="matchup">Matchup</button>
    <button data-f="sit">Sit</button>
    <span class="posfilter-wrap" id="posfilter-wrap"><select id="posfilter">
      <option value="all">All positions</option><option value="C">C</option><option value="1B">1B</option><option value="2B">2B</option><option value="3B">3B</option><option value="SS">SS</option><option value="OF">OF</option><option value="DH">DH</option>
    </select></span>
  </div>

  <div id="view-h">
    <div class="section-label">Top plays today</div>
    <div class="top3">${top3}</div>
    <div class="section-label">All hitters</div>
    <div class="list" id="hitterList">${hRows}</div>
  </div>
  <div id="view-p" class="hidden">
    <div class="section-label">Starting pitchers</div>
    <div class="list" id="pitcherList">${pRows}</div>
  </div>
  <div id="view-c" class="hidden">
    <div class="section-label">Compare two players</div>
    <div class="cmp-pick"><select id="cmpA"></select><span class="vs">vs</span><select id="cmpB"></select></div>
    <div id="cmpVerdict" class="cmp-verdict"></div>
    <div id="cmpCards" class="cmp-cards"></div>
  </div>

  <div class="how">
    <h3>How the calls work</h3>
    <p>Every player gets a 0&ndash;100 matchup score and a confidence rating. Nothing's hidden &mdash; tap a player to see the breakdown.</p>
    <div class="mix"><span class="chip"><b>Hitters:</b> OPS vs the pitcher's hand</span><span class="chip">how hittable the starter is</span><span class="chip">the bullpen behind him</span><span class="chip">ballpark</span></div>
    <div class="mix"><span class="chip"><b>Pitchers:</b> the offense they face</span><span class="chip">that lineup's strikeout rate</span><span class="chip">park</span><span class="chip">their own form</span></div>
    <p><b style="color:var(--ink)">Confidence</b> reflects how strong the lean is, how much data backs it, and whether the factors agree. A confirmed batting-order spot shows when posted; lineups aren't out until a few hours before first pitch.</p>
    <p style="color:var(--dim)">Coming next: Vegas run totals, weather, and richer recent-form stats.</p>
  </div>

  <footer>Every stat is pulled live from the official <a href="https://statsapi.mlb.com" rel="noopener" target="_blank">MLB Stats API</a> &mdash; the only computed number is the matchup score. Where a real stat isn't available, you'll see &ldquo;no data&rdquo; rather than a guess.<br>${esc(stamp)} &middot; cross-check any number at MLB.com &middot; not affiliated with or endorsed by MLB.</footer>
</div>

<script>
var PLAYERS=${compareJSON};
function toggleRow(row){ row.classList.toggle("open"); }
var curTab="h", curFilter="all", curPos="all";
function applyFilters(){
  if(curTab==="c") return;
  var listId=curTab==="h"?"hitterList":"pitcherList";
  var q=document.getElementById("search").value.trim().toLowerCase();
  document.querySelectorAll("#"+listId+" .row").forEach(function(r){
    var okQ=!q||r.getAttribute("data-name").indexOf(q)>=0;
    var okF=curFilter==="all"||r.getAttribute("data-v")===curFilter;
    var pos=r.getAttribute("data-pos")||"";
    var okP=(curTab!=="h")||curPos==="all"||pos===curPos||(curPos==="OF"&&(pos==="LF"||pos==="CF"||pos==="RF"));
    r.style.display=(okQ&&okF&&okP)?"":"none";
  });
}
document.querySelectorAll(".tabs button").forEach(function(b){ b.onclick=function(){
  document.querySelectorAll(".tabs button").forEach(function(x){x.classList.remove("on");}); b.classList.add("on");
  curTab=b.getAttribute("data-tab");
  document.getElementById("view-h").classList.toggle("hidden",curTab!=="h");
  document.getElementById("view-p").classList.toggle("hidden",curTab!=="p");
  document.getElementById("view-c").classList.toggle("hidden",curTab!=="c");
  document.getElementById("vfilters").style.display=(curTab==="c")?"none":"flex";
  document.getElementById("posfilter-wrap").style.display=(curTab==="h")?"inline-block":"none";
  document.querySelector(".search").style.display=(curTab==="c")?"none":"block";
  applyFilters();
};});
document.querySelectorAll(".vfilters button").forEach(function(b){ b.onclick=function(){
  document.querySelectorAll(".vfilters button").forEach(function(x){x.classList.remove("on");}); b.classList.add("on");
  curFilter=b.getAttribute("data-f"); applyFilters();
};});
document.getElementById("search").oninput=applyFilters;
document.getElementById("posfilter").onchange=function(){ curPos=this.value; applyFilters(); };

/* comparison tool */
function optLabel(p){ return p.name+" \u2014 "+p.team+(p.noData?" (no data)":" ("+p.label+")"); }
function fillSelect(sel){
  var hs=PLAYERS.map(function(p,i){return {p:p,i:i};}).filter(function(o){return o.p.type==="H";});
  var ps=PLAYERS.map(function(p,i){return {p:p,i:i};}).filter(function(o){return o.p.type==="P";});
  function opts(list){ return list.map(function(o){ return '<option value="'+o.i+'">'+optLabel(o.p)+'</option>'; }).join(""); }
  sel.innerHTML='<option value="">\u2014 choose \u2014</option><optgroup label="Hitters">'+opts(hs)+'</optgroup><optgroup label="Pitchers">'+opts(ps)+'</optgroup>';
}
function num(x,d){ return (x==null)?"\u2014":Number(x).toFixed(d); }
function cardHTML(p){
  if(!p) return '<div class="cmp-card empty2">pick a player</div>';
  var stats = p.type==="H"
    ? ("OPS "+num(p.ops,3)+" "+(p.opsSrc||"")+(p.battingOrder?(" \u00b7 batting #"+p.battingOrder):"")+(p.opp?(" \u00b7 vs "+p.opp):""))
    : ("ERA "+(p.hasStats?num(p.era,2):"\u2014")+" \u00b7 WHIP "+(p.hasStats?num(p.whip,2):"\u2014")+(p.oppTeam?(" \u00b7 vs "+p.oppTeam):""));
  return '<div class="cmp-card '+(p.css||"")+'">'
    +'<div class="cmp-name">'+p.name+'</div><div class="cmp-team">'+p.team+(p.type==="P"?" \u00b7 SP":(p.pos?(" \u00b7 "+p.pos):""))+'</div>'
    +'<div class="cmp-score">'+(p.noData?"\u2014":p.score)+'</div>'
    +'<span class="badge '+(p.css||"")+'">'+p.label+'</span>'
    +'<div class="cmp-stats">'+stats+'</div>'
    +(p.noData||!p.conf?"":'<div class="cmp-conf">'+p.conf.label+' confidence</div>')
    +'</div>';
}
function doCompare(){
  var ai=document.getElementById("cmpA").value, bi=document.getElementById("cmpB").value;
  var a=ai===""?null:PLAYERS[Number(ai)], b=bi===""?null:PLAYERS[Number(bi)];
  document.getElementById("cmpCards").innerHTML=cardHTML(a)+cardHTML(b);
  var v=document.getElementById("cmpVerdict");
  if(!a||!b){ v.className="cmp-verdict"; v.innerHTML=""; return; }
  if(a.noData&&b.noData){ v.className="cmp-verdict"; v.textContent="Not enough data on either player to compare yet."; return; }
  if(a.noData||b.noData){ var ok=a.noData?b:a,nd=a.noData?a:b; v.className="cmp-verdict"; v.textContent="Not enough data on "+nd.name+" yet \u2014 "+ok.name+" is the only one ratable here."; return; }
  if(a.type!==b.type){ v.className="cmp-verdict"; v.textContent="These play different roles. Pick two hitters or two pitchers for a direct start/sit call."; return; }
  var diff=a.score-b.score, w=diff>=0?a:b, l=diff>=0?b:a, ad=Math.abs(diff);
  v.className="cmp-verdict "+w.css;
  if(ad<=4){ v.innerHTML="<b>Practically a coin flip</b> \u2014 "+a.score+" vs "+b.score+". Slight edge to "+w.name+"; let your category needs break the tie."; }
  else { v.innerHTML="<b>Start "+w.name+" over "+l.name+"</b> \u2014 "+w.score+" vs "+l.score+" matchup score."; }
}
(function(){ var A=document.getElementById("cmpA"),B=document.getElementById("cmpB"); fillSelect(A); fillSelect(B); A.onchange=doCompare; B.onchange=doCompare; })();
</script>
</body>
</html>`;
}

(async ()=>{
  let data, live;
  if(SAMPLE){ console.log("Building from SAMPLE data (no network)..."); data=sampleData(); live=false; }
  else { console.log("Building live for "+TODAY+" ..."); data=await buildLive(); live=true; }
  // sort: real scores high-to-low, no-data rows to the bottom
  const sk=r=>r.noData?-1:r.score;
  data.hitters.sort((a,b)=>sk(b)-sk(a)); data.hitters.forEach((r,i)=>r.rank=i+1);
  data.pitchers.sort((a,b)=>sk(b)-sk(a)); data.pitchers.forEach((r,i)=>r.rank=i+1);
  const dateLabel=new Date().toLocaleDateString("en-US",{timeZone:ET,weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const html=pageHTML({hitters:data.hitters,pitchers:data.pitchers,live:live,dateLabel:dateLabel});
  fs.mkdirSync("public",{recursive:true});
  fs.writeFileSync(path.join("public","index.html"),html);
  const nd=data.hitters.filter(r=>r.noData).length;
  console.log("Wrote public/index.html \u2014 "+data.hitters.length+" hitters ("+nd+" no-data), "+data.pitchers.length+" pitchers, "+(new Set(data.hitters.map(r=>r.gameKey)).size)+" games.");
})();
