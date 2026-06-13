#!/usr/bin/env node
/*
 * build.js — builds the finished static page for The Lineup Card.
 * Runs on GitHub Actions, pulls live MLB data, writes public/index.html.
 * Node 20+ (built-in fetch). No packages.
 *
 *   node build.js            -> live: today's real games
 *   node build.js --sample   -> offline demo data (used to test the page build)
 *
 * Accuracy policy: every displayed stat comes from the MLB Stats API (and, when
 * an ODDS_API_KEY is configured, game totals from The Odds API). When a real
 * number isn't available we show "no data" — never a guess. The only computed
 * values on the page are the matchup score and the graded fantasy points on
 * yesterday's scoreboard (formula shown on the page).
 *
 * Reliability policy: if the MLB schedule can't be fetched, or the schedule
 * loads but no player can be graded (API outage mid-build), this script exits
 * with an error ON PURPOSE so GitHub Actions fails the build and the previous
 * good page stays live. A stale page beats an empty one.
 *
 * Track record: every live build saves the day's pre-game calls to
 * data/calls-YYYY-MM-DD.json (the workflow commits it). The next day's build
 * reads that file, pulls the real box scores, and grades the calls on the
 * "Yesterday's scoreboard" panel. Once a player's game has started, their
 * saved call is frozen — later builds never rewrite a call with hindsight.
 */
const fs = require("fs");
const path = require("path");

const API = "https://statsapi.mlb.com/api/v1";
const ET = "America/New_York";
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: ET }); // YYYY-MM-DD
const SEASON = Number(TODAY.slice(0, 4));
const SAMPLE = process.argv.includes("--sample");

// Vegas game totals (optional). Set the ODDS_API_KEY repo secret to enable.
const ODDS_KEY = (process.env.ODDS_API_KEY || "").trim();
// Visitor analytics (optional). Sign up free at goatcounter.com, then put your
// site code here, e.g. "lineupcard" if your dashboard is lineupcard.goatcounter.com
const GOATCOUNTER = "";

// last-14-days window (inclusive of today)
function shiftDate(ymd, delta){ const p=ymd.split("-").map(Number); const dt=new Date(Date.UTC(p[0],p[1]-1,p[2])); dt.setUTCDate(dt.getUTCDate()+delta);
  return dt.getUTCFullYear()+"-"+String(dt.getUTCMonth()+1).padStart(2,"0")+"-"+String(dt.getUTCDate()).padStart(2,"0"); }
const END14 = TODAY, START14 = shiftDate(TODAY, -13);
const YESTERDAY = shiftDate(TODAY, -1);
const DATA_DIR = "data";

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

/* ---------- scoring ---------- */
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function staffWeakness(era,whip,bpenEra){
  const e=clamp((era-2.5)/(6.5-2.5)*100,0,100), w=clamp((whip-1.0)/(1.7-1.0)*100,0,100), bp=clamp(((bpenEra||4.1)-2.5)/(6.5-2.5)*100,0,100);
  return 0.7*((e+w)/2)+0.3*bp;
}
// vegasTotal is the game's over/under; null when odds aren't available.
function scoreHitter(ops,era,whip,park,bpenEra,vegasTotal){
  const o=clamp((ops-0.55)/(1.0-0.55)*100,0,100), s=staffWeakness(era,whip,bpenEra), k=clamp((park-90)/(115-90)*100,0,100);
  if(vegasTotal!=null){
    const v=clamp((vegasTotal-7)/(11-7)*100,0,100);
    return {total:Math.round(0.40*o+0.30*s+0.15*k+0.15*v),comps:{hitter:Math.round(o),staff:Math.round(s),park:Math.round(k),vegas:Math.round(v)}};
  }
  return {total:Math.round(0.45*o+0.35*s+0.20*k),comps:{hitter:Math.round(o),staff:Math.round(s),park:Math.round(k)}};
}
function scorePitcher(oppOps,oppK,era,whip,park,vegasTotal){
  const ops_s=clamp((0.800-oppOps)/(0.800-0.650)*100,0,100), k_s=clamp((oppK-0.18)/(0.28-0.18)*100,0,100),
        park_s=clamp((110-park)/(110-90)*100,0,100), e=clamp((5.0-era)/(5.0-2.5)*100,0,100), w=clamp((1.5-whip)/(1.5-1.0)*100,0,100), own=(e+w)/2;
  if(vegasTotal!=null){
    const v=clamp((10-vegasTotal)/(10-7)*100,0,100);
    return {total:Math.round(0.25*ops_s+0.15*k_s+0.15*park_s+0.30*own+0.15*v),comps:{offense:Math.round((ops_s+k_s)/2),own:Math.round(own),park:Math.round(park_s),vegas:Math.round(v)}};
  }
  return {total:Math.round(0.30*ops_s+0.20*k_s+0.15*park_s+0.35*own),comps:{offense:Math.round((ops_s+k_s)/2),own:Math.round(own),park:Math.round(park_s)}};
}
function verdict(s){ if(s>=66) return ["START","start","\u{1F525}"]; if(s>=55) return ["LEAN START","lean","\u2705"]; if(s>=44) return ["MATCHUP","matchup","\u2796"]; return ["SIT","sit","\u26D4"]; }
// agreement: do the factor components lean the same way as the overall call?
function agreeScore(comps,score){
  const lean=score>=50?1:-1; const ks=Object.keys(comps); let m=0;
  ks.forEach(k=>{ if(((comps[k]>=50?1:-1)===lean)) m++; });
  const f=ks.length?m/ks.length:0;
  return f>=1?100:f>=0.75?78:f>=0.5?60:40;
}
function confidence(score,comps,pa,confirmed,status){
  const conv=clamp(Math.abs(score-50)*2.2,0,100), samp=pa>=120?100:pa>=60?75:pa>=25?55:35;
  const agree=agreeScore(comps,score);
  let raw=0.45*conv+0.30*samp+0.25*agree, note="";
  if(status==="DTD"){ raw=Math.min(raw,45); note="Day-to-day \u2014 check status before lock"; }
  if(confirmed===null){ raw=Math.min(raw,60); if(!note) note="Lineup not posted yet \u2014 confidence capped"; }
  const stars=raw>=80?5:raw>=64?4:raw>=48?3:raw>=32?2:1, label=stars>=4?"High":stars===3?"Medium":"Low";
  if(!note) note=stars>=4?"Strong lean, solid sample, factors agree":stars===3?"Reasonable lean, some uncertainty":"Coin-flip matchup or thin data";
  return {stars,label,note};
}
function confidenceP(score,comps,ip){
  const conv=clamp(Math.abs(score-50)*2.2,0,100), samp=ip>=60?100:ip>=30?75:ip>=12?55:35;
  const agree=agreeScore(comps,score);
  const raw=0.45*conv+0.30*samp+0.25*agree, stars=raw>=80?5:raw>=64?4:raw>=48?3:raw>=32?2:1, label=stars>=4?"High":stars===3?"Medium":"Low";
  const note=stars>=4?"Strong matchup, healthy sample":stars===3?"Decent matchup":"Volatile spot or small sample";
  return {stars,label,note};
}

/* ---------- fantasy points (yesterday's scoreboard) ----------
 * Generic points-league scoring, shown verbatim on the page:
 *   Hitters:  total bases + R + RBI + BB + HBP + 2*SB     (1B=1 2B=2 3B=3 HR=4)
 *   Pitchers: 3*IP + K - 2*ER - BB - H   (wins/saves excluded for simplicity)
 */
function batPoints(st){
  if(!st) return null;
  const h=+st.hits||0, d2=+st.doubles||0, d3=+st.triples||0, hr=+st.homeRuns||0;
  const pa=+st.plateAppearances||0, ab=+st.atBats||0, bb=+st.baseOnBalls||0, hbp=+st.hitByPitch||0;
  if(pa<=0 && ab<=0 && bb<=0 && hbp<=0) return null; // didn't bat
  const singles=Math.max(0,h-d2-d3-hr);
  return singles+2*d2+3*d3+4*hr+(+st.runs||0)+(+st.rbi||0)+bb+hbp+2*(+st.stolenBases||0);
}
function pitPoints(st){
  if(!st||st.inningsPitched==null) return null;
  const ip=ipToNum(st.inningsPitched);
  if(!(ip>0) && !(+st.battersFaced>0)) return null; // didn't pitch
  return 3*ip+(+st.strikeOuts||0)-2*(+st.earnedRuns||0)-(+st.baseOnBalls||0)-(+st.hits||0);
}

/* ---------- helpers ---------- */
const esc=s=>(s==null?"":(""+s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function getJSON(url){ try{ const r=await fetch(url); if(!r.ok) return null; return await r.json(); }catch(e){ return null; } }
async function pool(items,worker,size){ let i=0; const out=new Array(items.length); size=size||10;
  await Promise.all(Array.from({length:size},async()=>{ while(i<items.length){ const x=i++; out[x]=await worker(items[x]); } })); return out; }
function ipToNum(ip){ try{ const s=(""+ip); if(s.indexOf(".")>=0){ const p=s.split("."); return parseInt(p[0]||0)+(p[1]?parseInt(p[1])/3:0); } return parseFloat(s); }catch(e){ return 0; } }

// stat-line builders: keep raw numbers; return null when there's truly nothing
function hittingLine(st){
  if(!st) return null;
  const line={ avg:st.avg!=null?parseFloat(st.avg):null, obp:st.obp!=null?parseFloat(st.obp):null, slg:st.slg!=null?parseFloat(st.slg):null,
    ops:st.ops!=null?parseFloat(st.ops):null, hr:st.homeRuns!=null?+st.homeRuns:null, rbi:st.rbi!=null?+st.rbi:null,
    r:st.runs!=null?+st.runs:null, sb:st.stolenBases!=null?+st.stolenBases:null, bb:st.baseOnBalls!=null?+st.baseOnBalls:null,
    so:st.strikeOuts!=null?+st.strikeOuts:null, ab:st.atBats!=null?+st.atBats:null, pa:st.plateAppearances!=null?+st.plateAppearances:null };
  if(line.ops==null && line.ab==null && line.pa==null) return null;
  return line;
}
function pitchingLine(st){
  if(!st) return null;
  const line={ era:st.era!=null?parseFloat(st.era):null, whip:st.whip!=null?parseFloat(st.whip):null, ip:st.inningsPitched!=null?(""+st.inningsPitched):null,
    so:st.strikeOuts!=null?+st.strikeOuts:null, bb:st.baseOnBalls!=null?+st.baseOnBalls:null, w:st.wins!=null?+st.wins:null, l:st.losses!=null?+st.losses:null,
    k9:st.strikeoutsPer9Inn!=null?(""+st.strikeoutsPer9Inn):null };
  if(line.era==null && line.ip==null) return null;
  return line;
}

/* ---------- Vegas game totals (The Odds API, optional) ---------- */
async function fetchOdds(){
  if(!ODDS_KEY) return null;
  const d=await getJSON("https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey="+encodeURIComponent(ODDS_KEY)+"&regions=us&markets=totals&oddsFormat=american");
  if(!Array.isArray(d)||!d.length){ console.log("Odds: no usable response (key invalid, quota out, or no events). Building without Vegas."); return null; }
  const evs=[];
  d.forEach(ev=>{ try{
    const pts=[];
    (ev.bookmakers||[]).forEach(bk=>{ (bk.markets||[]).forEach(m=>{ if(m.key==="totals"){ (m.outcomes||[]).forEach(o=>{ if(o.name==="Over"&&o.point!=null) pts.push(+o.point); }); } }); });
    if(!pts.length) return;
    pts.sort((a,b)=>a-b);
    const med=pts[Math.floor(pts.length/2)]; // median across books
    evs.push({home:ev.home_team||"",away:ev.away_team||"",t:Date.parse(ev.commence_time||"")||0,total:med});
  }catch(e){} });
  console.log("Odds: loaded totals for "+evs.length+" games.");
  return evs.length?evs:null;
}
function teamNameMatch(a,b){ a=(a||"").toLowerCase().trim(); b=(b||"").toLowerCase().trim(); if(!a||!b) return false; return a===b||a.indexOf(b)>=0||b.indexOf(a)>=0; }
function matchTotal(odds,homeName,awayName,gameDate){
  if(!odds) return null;
  const gt=Date.parse(gameDate||"")||0; let best=null,bd=Infinity;
  odds.forEach(o=>{ if(teamNameMatch(o.home,homeName)&&teamNameMatch(o.away,awayName)){ const dd=Math.abs(o.t-gt); if(dd<bd){bd=dd;best=o;} } });
  return (best&&bd<=8*3600*1000)?best.total:null; // must be within 8h of the scheduled game (handles doubleheaders)
}

/* ---------- live fetch ---------- */
async function fetchPitcher(id){
  const d=await getJSON(API+"/people/"+id+"?hydrate=stats(group=[pitching],type=[season],season="+SEASON+")");
  const p=d&&d.people&&d.people[0];
  const out={name:p?p.fullName:"TBD",hand:(p&&p.pitchHand)?p.pitchHand.code:"R",era:4.20,whip:1.30,ip:0,hasStats:false,season:null,last14:null};
  try{ const st=p.stats[0].splits[0].stat;
    if(st.era!=null){ out.era=parseFloat(st.era); out.hasStats=true; }
    if(st.whip!=null) out.whip=parseFloat(st.whip);
    if(st.inningsPitched!=null) out.ip=ipToNum(st.inningsPitched);
    out.season=pitchingLine(st);
  }catch(e){}
  try{ const d2=await getJSON(API+"/people/"+id+"/stats?stats=byDateRange&group=pitching&startDate="+START14+"&endDate="+END14+"&season="+SEASON);
    out.last14=pitchingLine(d2.stats[0].splits[0].stat);
  }catch(e){}
  return out;
}
function statusCode(s){ if(!s||!s.code) return ""; const c=s.code; if(c==="A") return ""; if(/^(D7|D10|D15|D60|DL)/.test(c)) return "IL"; if(c==="DTD") return "DTD"; return ""; }
async function fetchTeam(id){
  const out={ops:null,k:null,bpenEra:null,hitters:[]};
  const roster=await getJSON(API+"/teams/"+id+"/roster?rosterType=active");
  if(roster&&roster.roster){
    out.hitters=roster.roster.filter(r=>r.position&&r.position.type!=="Pitcher"&&r.position.code!=="1")
      .map(r=>({id:r.person.id,name:r.person.fullName,pos:(r.position.abbreviation||""),status:statusCode(r.status)}));
  }
  const hit=await getJSON(API+"/teams/"+id+"/stats?stats=season&group=hitting&season="+SEASON);
  try{ const st=hit.stats[0].splits[0].stat; if(st.ops!=null) out.ops=parseFloat(st.ops);
    const pa=parseFloat(st.plateAppearances||st.atBats||0), so=parseFloat(st.strikeOuts||0); if(pa>0) out.k=so/pa; }catch(e){}
  const pit=await getJSON(API+"/teams/"+id+"/stats?stats=season&group=pitching&season="+SEASON);
  try{ const st=pit.stats[0].splits[0].stat; if(st.era!=null) out.bpenEra=parseFloat(st.era); }catch(e){}
  return out;
}
async function fetchBoxscore(pk){
  const d=await getJSON(API+"/game/"+pk+"/boxscore");
  const out={home:{order:{},posted:false},away:{order:{},posted:false}};
  try{ ["home","away"].forEach(side=>{ const bo=d.teams[side].battingOrder;
    if(Array.isArray(bo)&&bo.length>0){ out[side].posted=true; bo.forEach((pid,i)=>{ out[side].order[pid]=i+1; }); } }); }catch(e){}
  return out;
}
// 3 calls per hitter: platoon split (scoring) + season line + last-14 line
async function fetchHitter(id,hand){
  const out={split:{ops:null,pa:0,src:"no data"},season:null,last14:null};
  const want=hand==="R"?"vr":"vl";
  try{ const d=await getJSON(API+"/people/"+id+"/stats?stats=statSplits&group=hitting&sitCodes=vr,vl&season="+SEASON);
    for(const s of d.stats[0].splits){ if(s.split&&s.split.code===want&&s.stat.ops!=null){
      out.split={ops:parseFloat(s.stat.ops),pa:parseFloat(s.stat.plateAppearances||s.stat.atBats||0),src:"vs "+hand+"HP"}; break; } }
  }catch(e){}
  try{ const d=await getJSON(API+"/people/"+id+"/stats?stats=season&group=hitting&season="+SEASON);
    const st=d.stats[0].splits[0].stat; out.season=hittingLine(st);
    if(out.split.ops==null && st.ops!=null) out.split={ops:parseFloat(st.ops),pa:parseFloat(st.plateAppearances||st.atBats||0),src:"season"};
  }catch(e){}
  try{ const d=await getJSON(API+"/people/"+id+"/stats?stats=byDateRange&group=hitting&startDate="+START14+"&endDate="+END14+"&season="+SEASON);
    out.last14=hittingLine(d.stats[0].splits[0].stat);
  }catch(e){}
  return out;
}

async function buildLive(){
  const hitters=[], pitchers=[];
  const sched=await getJSON(API+"/schedule?sportId=1&date="+TODAY+"&hydrate=probablePitcher");
  if(sched===null){
    console.error("FATAL: could not reach the MLB schedule API. Exiting with an error so the previous page stays live.");
    process.exit(1);
  }
  const games=(sched.dates&&sched.dates[0]&&sched.dates[0].games)||[];
  console.log("Games today: "+games.length);
  if(!games.length) return {hitters,pitchers,games:0,oddsUsed:false,statusByPk:{}};

  const odds=await fetchOdds();
  let oddsUsed=false;

  const statusByPk={};
  games.forEach(g=>{ if(g.gamePk) statusByPk[g.gamePk]=(g.status&&g.status.abstractGameState)||""; });

  const teamIds=new Set(), pitcherIds=new Set();
  games.forEach(g=>{ const t=g.teams||{};
    if(t.home&&t.home.team) teamIds.add(t.home.team.id);
    if(t.away&&t.away.team) teamIds.add(t.away.team.id);
    if(t.home&&t.home.probablePitcher) pitcherIds.add(t.home.probablePitcher.id);
    if(t.away&&t.away.probablePitcher) pitcherIds.add(t.away.probablePitcher.id); });
  const teamMap={}, pitMap={}, boxMap={};
  await pool([...teamIds],async id=>{ teamMap[id]=await fetchTeam(id); },8);
  await pool([...pitcherIds],async id=>{ pitMap[id]=await fetchPitcher(id); },8);
  await pool(games.map(g=>g.gamePk).filter(Boolean),async pk=>{ boxMap[pk]=await fetchBoxscore(pk); },8);
  console.log("Loaded teams, pitchers, lineups. Pulling player stats + scoring...");

  const hitterTasks=[];
  games.forEach((g,gi)=>{
    const venue=(g.venue&&g.venue.name)||"", park=PARK[venue]!=null?PARK[venue]:100, t=g.teams||{};
    const box=boxMap[g.gamePk]||{home:{order:{},posted:false},away:{order:{},posted:false}};
    const vt=matchTotal(odds,(t.home&&t.home.team)?t.home.team.name:"",(t.away&&t.away.team)?t.away.team.name:"",g.gameDate);
    if(vt!=null) oddsUsed=true;
    [["away","home"],["home","away"]].forEach(pair=>{
      const me=t[pair[0]], opp=t[pair[1]], pp=opp&&opp.probablePitcher;
      if(!me||!me.team||!pp||!pp.id) return;
      const pitcher=pitMap[pp.id], team=teamMap[me.team.id], oppTeam=teamMap[opp.team.id];
      if(!pitcher||!team) return;
      const sideBox=box[pair[0]]||{order:{},posted:false}, orderMap=sideBox.order||{};
      const matchCount=(team.hitters||[]).filter(h=>h.id&&orderMap[h.id]).length, trust=sideBox.posted&&matchCount>=1;

      const pNoData=!pitcher.hasStats||team.ops==null;
      if(pNoData){
        pitchers.push({id:pp.id,gamePk:g.gamePk,name:pitcher.name,team:opp.team.name,pos:"SP",score:null,label:"NO DATA",css:"nodata",emoji:"\u2014",comps:null,conf:null,noData:true,
          oppTeam:me.team.name,oppOps:team.ops,oppK:team.k,era:pitcher.era,whip:pitcher.whip,hasStats:pitcher.hasStats,venue,park,vegasTotal:vt,gameKey:gi,
          season:pitcher.season,last14:pitcher.last14,reason:"Not enough MLB data on this matchup yet."});
      } else {
        const sp=scorePitcher(team.ops,team.k!=null?team.k:0.22,pitcher.era,pitcher.whip,park,vt), vp=verdict(sp.total);
        pitchers.push({id:pp.id,gamePk:g.gamePk,name:pitcher.name,team:opp.team.name,pos:"SP",score:sp.total,label:vp[0],css:vp[1],emoji:vp[2],comps:sp.comps,
          conf:confidenceP(sp.total,sp.comps,pitcher.ip),noData:false,oppTeam:me.team.name,oppOps:team.ops,oppK:team.k,
          era:pitcher.era,whip:pitcher.whip,hasStats:true,venue,park,vegasTotal:vt,gameKey:gi,season:pitcher.season,last14:pitcher.last14,
          reason:"Draws the "+me.team.name+" offense ("+team.ops.toFixed(3)+" OPS, "+Math.round((team.k!=null?team.k:0.22)*100)+"% K) at "+venue+"."+(vt!=null?(" O/U "+vt+"."):"")+" "+pitcher.era.toFixed(2)+" ERA, "+pitcher.whip.toFixed(2)+" WHIP."});
      }

      (team.hitters||[]).forEach(h=>{ if(h.id) hitterTasks.push({h,pitcher,park,vt,gamePk:g.gamePk,bpen:(oppTeam&&oppTeam.bpenEra!=null?oppTeam.bpenEra:4.1),
        team:me.team.name,opp:pitcher.name,gameKey:gi,confirmed:trust?(orderMap[h.id]?true:false):null,battingOrder:trust?(orderMap[h.id]||null):null}); });
    });
  });

  await pool(hitterTasks,async t=>{
    const r=await fetchHitter(t.h.id,t.pitcher.hand), split=r.split, flag=t.h.status;
    const confirmed=t.confirmed===true?true:null, battingOrder=confirmed===true?t.battingOrder:null;
    if(split.ops==null){
      hitters.push({id:t.h.id,gamePk:t.gamePk,name:t.h.name,team:t.team,pos:t.h.pos,score:null,label:"NO DATA",css:"nodata",emoji:"\u2014",comps:null,conf:null,noData:true,
        reason:"Not enough MLB data yet to rate this matchup.",opp:t.opp,ops:null,opsSrc:"no data",flag,confirmed,battingOrder,vegasTotal:t.vt,gameKey:t.gameKey,
        season:r.season,last14:r.last14}); return;
    }
    const s=scoreHitter(split.ops,t.pitcher.era,t.pitcher.whip,t.park,t.bpen,t.vt), v=verdict(s.total), conf=confidence(s.total,s.comps,split.pa,confirmed,flag);
    const hw=t.pitcher.hand==="R"?"RHP":"LHP", note=t.park>=106?" in a hitter's park":t.park<=95?" in a pitcher's park":"";
    const pitchPart=t.pitcher.hasStats?("("+t.pitcher.era.toFixed(2)+" ERA)"):"(limited pitcher data)";
    hitters.push({id:t.h.id,gamePk:t.gamePk,name:t.h.name,team:t.team,pos:t.h.pos,score:s.total,label:v[0],css:v[1],emoji:v[2],comps:s.comps,conf,noData:false,
      reason:"Faces "+hw+" "+t.pitcher.name+" "+pitchPart+note+". "+split.ops.toFixed(3)+" OPS "+split.src+"."+(t.vt!=null?(" O/U "+t.vt+"."):""),
      opp:t.opp,ops:split.ops,opsSrc:split.src,flag,confirmed,battingOrder,vegasTotal:t.vt,gameKey:t.gameKey,season:r.season,last14:r.last14});
  },10);

  return {hitters,pitchers,games:games.length,oddsUsed,statusByPk};
}

/* ---------- track record: save today's calls, grade yesterday's ---------- */
function saveCalls(d){
  if(SAMPLE||!d||!d.games) return;
  try{
    fs.mkdirSync(DATA_DIR,{recursive:true});
    const file=path.join(DATA_DIR,"calls-"+TODAY+".json");
    let prev=null; try{ prev=JSON.parse(fs.readFileSync(file,"utf8")); }catch(e){}
    const prevH={}, prevP={};
    if(prev){ (prev.hitters||[]).forEach(x=>{ if(x&&x.id!=null) prevH[x.id]=x; }); (prev.pitchers||[]).forEach(x=>{ if(x&&x.id!=null) prevP[x.id]=x; }); }
    const mk=(rows,prevMap)=>{ const out=[], seen={};
      (rows||[]).forEach(r=>{ if(!r||r.noData||r.id==null||!r.gamePk) return;
        const started=(d.statusByPk[r.gamePk]||"")!=="Preview";
        let e;
        if(started) e=prevMap[r.id]||null;                 // game underway/over: freeze whatever we said pre-game
        else e={id:r.id,name:r.name,team:r.team,css:r.css,verdict:r.label,score:r.score,gamePk:r.gamePk};
        if(e&&!seen[e.id]){ seen[e.id]=1; out.push(e); } });
      Object.keys(prevMap).forEach(id=>{ if(!seen[id]){ seen[id]=1; out.push(prevMap[id]); } }); // keep earlier calls for anyone who dropped off
      return out; };
    const payload={date:TODAY,savedAt:new Date().toISOString(),
      scoring:"H: TB + R + RBI + BB + HBP + 2xSB. P: 3xIP + K - 2xER - BB - H.",
      hitters:mk(d.hitters,prevH),pitchers:mk(d.pitchers,prevP)};
    fs.writeFileSync(file,JSON.stringify(payload));
    console.log("Saved "+payload.hitters.length+" hitter calls and "+payload.pitchers.length+" pitcher calls to "+file);
  }catch(e){ console.log("Could not save calls file: "+(e&&e.message?e.message:e)); }
}
async function gradeYesterday(){
  let calls=null;
  try{ calls=JSON.parse(fs.readFileSync(path.join(DATA_DIR,"calls-"+YESTERDAY+".json"),"utf8")); }catch(e){ return null; }
  if(!calls||(!((calls.hitters||[]).length)&&!((calls.pitchers||[]).length))) return null;
  const sched=await getJSON(API+"/schedule?sportId=1&date="+YESTERDAY);
  const games=(sched&&sched.dates&&sched.dates[0]&&sched.dates[0].games)||[];
  if(!games.length) return null;
  const bat={}, pit={};
  await pool(games.map(g=>g.gamePk).filter(Boolean),async pk=>{
    const d=await getJSON(API+"/game/"+pk+"/boxscore"); if(!d||!d.teams) return;
    ["home","away"].forEach(side=>{ try{
      const pl=(d.teams[side]&&d.teams[side].players)||{};
      Object.keys(pl).forEach(k=>{ const p=pl[k]; if(!p||!p.person||p.person.id==null) return;
        const id=p.person.id, st=p.stats||{};
        const bp=batPoints(st.batting); if(bp!=null) bat[id]=(bat[id]||0)+bp;
        const pp2=pitPoints(st.pitching); if(pp2!=null) pit[id]=(pit[id]||0)+pp2; });
    }catch(e){} });
  },8);
  function agg(list,map){
    const tiers={start:{sum:0,n:0},lean:{sum:0,n:0},matchup:{sum:0,n:0},sit:{sum:0,n:0}}; let best=null;
    (list||[]).forEach(c=>{ if(!c||!tiers[c.css]) return; const p=map[c.id]; if(p==null) return; // didn't play -> excluded
      tiers[c.css].sum+=p; tiers[c.css].n++;
      if((c.css==="start"||c.css==="lean")&&(best==null||p>best.pts)) best={name:c.name,team:c.team,pts:p,verdict:c.verdict}; });
    const out={}; Object.keys(tiers).forEach(k=>{ out[k]=tiers[k].n?{avg:tiers[k].sum/tiers[k].n,n:tiers[k].n}:null; });
    return {tiers:out,best:best};
  }
  const h=agg(calls.hitters,bat), p=agg(calls.pitchers,pit);
  const any=Object.keys(h.tiers).some(k=>h.tiers[k])||Object.keys(p.tiers).some(k=>p.tiers[k]);
  if(!any) return null;
  console.log("Graded yesterday's calls ("+YESTERDAY+").");
  return {date:calls.date||YESTERDAY,h,p};
}
function sampleScoreboard(){
  return {date:YESTERDAY,
    h:{tiers:{start:{avg:9.4,n:38},lean:{avg:7.8,n:31},matchup:{avg:6.1,n:55},sit:{avg:4.2,n:47}},best:{name:"Marcus Vega",team:"Rockies",pts:19,verdict:"START"}},
    p:{tiers:{start:{avg:15.3,n:6},lean:{avg:11.0,n:4},matchup:{avg:7.2,n:3},sit:{avg:1.4,n:2}},best:null}};
}

/* ---------- sample data (offline page test only) ---------- */
function synthHit(ops,hr,scale){
  const slg=ops*0.56, obp=ops*0.44, avg=Math.max(0.15,obp-0.06);
  return {avg,obp,slg,ops,hr:Math.round(hr*scale),rbi:Math.round(hr*scale*2.4),r:Math.round(hr*scale*2.1),
    sb:Math.round(3*scale),bb:Math.round(20*scale),so:Math.round(42*scale),ab:Math.round(330*scale),pa:Math.round(372*scale)};
}
function synthPit(era,whip,scale){
  return {era,whip,ip:(Math.round(150*scale*10)/10).toFixed(1),so:Math.round(150*scale),bb:Math.round(40*scale),
    w:Math.round(11*scale),l:Math.round(7*scale),k9:(150/150*9).toFixed(2)};
}
function sampleData(){
  const H=[
   // name, team, pos, opsVsHand, opsRecent, hr, pitcher, hand, era, whip, venue, bpenEra, battingOrder, status, vegasTotal
   ["Marcus Vega","Rockies","RF",0.921,0.905,28,"Dylan Reese","R",5.48,1.61,"Coors Field",5.05,2,"",11.5],
   ["Tate Hollis","Reds","1B",0.864,0.940,24,"Owen Park","L",5.02,1.50,"Great American Ball Park",4.40,4,"",10],
   ["Diego Salazar","Phillies","SS",0.812,0.770,19,"Jack Monroe","R",4.71,1.44,"Citizens Bank Park",4.15,3,"",9],
   ["Cole Whitfield","Red Sox","DH",0.799,0.815,21,"Sam Ortega","L",4.55,1.39,"Fenway Park",3.95,5,"DTD",9.5],
   ["Andre Bellamy","Rangers","CF",0.788,0.700,15,"Ty Coleman","R",4.30,1.33,"Globe Life Field",4.20,1,"",8.5],
   ["Roman Pierce","Braves","3B",0.760,0.690,17,"Will Hayes","R",4.05,1.28,"Truist Park",3.60,null,"",8.5],
   ["Felix Moreno","Yankees","2B",0.744,0.900,12,"Drew Carter","L",3.92,1.27,"Yankee Stadium",3.80,6,"",8],
   ["Jonah Reed","Cubs","LF",0.731,0.640,11,"Eli Brooks","R",3.74,1.22,"Wrigley Field",3.55,null,"",8],
   ["Sebastian Cruz","Dodgers","C",0.712,0.730,14,"Max Sterling","R",3.41,1.18,"Dodger Stadium",3.10,7,"",7.5],
   ["Theo Marsh","Giants","SS",0.654,0.610,8,"Kai Nakamura","R",2.88,1.06,"Oracle Park",2.95,8,"",7],
   ["Brennan Lowe","Mariners","RF",0.631,null,6,"Logan Frost","L",2.55,1.01,"T-Mobile Park",2.80,null,"IL",7],
   ["Rookie Tba","Marlins","2B",null,null,0,"Nate Glover","R",3.80,1.25,"loanDepot park",3.9,null,"",8]
  ];
  const hitters=H.map(a=>{
    const venue=a[10], park=PARK[venue]!=null?PARK[venue]:100, flag=a[13], vt=a[14];
    const confirmed=a[12]!=null?true:null, battingOrder=confirmed===true?a[12]:null;
    const season=a[3]!=null?synthHit(a[3]*0.98,a[5],1):null;
    const last14=a[4]!=null?synthHit(a[4],a[5],0.13):null;
    if(a[3]==null){
      return {name:a[0],team:a[1],pos:a[2],score:null,label:"NO DATA",css:"nodata",emoji:"\u2014",comps:null,conf:null,noData:true,
        reason:"Not enough MLB data yet to rate this matchup.",opp:a[6],ops:null,opsSrc:"no data",flag,confirmed,battingOrder,vegasTotal:vt,gameKey:0,season,last14};
    }
    const s=scoreHitter(a[3],a[8],a[9],park,a[11],vt), v=verdict(s.total), conf=confidence(s.total,s.comps,420,confirmed,flag);
    const hw=a[7]==="R"?"RHP":"LHP", note=park>=106?" in a hitter's park":park<=95?" in a pitcher's park":"";
    return {name:a[0],team:a[1],pos:a[2],score:s.total,label:v[0],css:v[1],emoji:v[2],comps:s.comps,conf,noData:false,
      reason:"Faces "+hw+" "+a[6]+" ("+a[8].toFixed(2)+" ERA)"+note+". "+a[3].toFixed(3)+" OPS vs "+a[7]+"HP."+(vt!=null?(" O/U "+vt+"."):""),
      opp:a[6],ops:a[3],opsSrc:"vs "+a[7]+"HP",flag,confirmed,battingOrder,vegasTotal:vt,gameKey:0,season,last14};
  });
  const P=[
   ["Kenji Adler","Brewers","Marlins",0.662,0.265,2.61,1.02,"American Family Field",2.45,7.5],
   ["Ross Tillman","Guardians","Athletics",0.671,0.248,3.05,1.10,"Progressive Field",3.20,7.5],
   ["Diego Salinas","Padres","Giants",0.679,0.241,3.18,1.14,"Petco Park",2.90,7],
   ["Marcus Boyd","Astros","Rangers",0.741,0.221,3.42,1.20,"Daikin Park",3.95,8.5],
   ["Owen Park","Reds","Cubs",0.770,0.210,5.02,1.50,"Great American Ball Park",4.70,10],
   ["Dylan Reese","Rockies","Dodgers",0.815,0.198,5.48,1.61,"Coors Field",6.10,11.5]
  ];
  const pitchers=P.map(a=>{
    const venue=a[7], park=PARK[venue]!=null?PARK[venue]:100, vt=a[9], s=scorePitcher(a[3],a[4],a[5],a[6],park,vt), v=verdict(s.total);
    return {name:a[0],team:a[1],pos:"SP",score:s.total,label:v[0],css:v[1],emoji:v[2],comps:s.comps,conf:confidenceP(s.total,s.comps,90),noData:false,
      oppTeam:a[2],oppOps:a[3],oppK:a[4],era:a[5],whip:a[6],hasStats:true,venue,park,vegasTotal:vt,gameKey:0,
      season:synthPit(a[5],a[6],1),last14:synthPit(a[8],a[6]*1.02,0.16),
      reason:"Draws the "+a[2]+" offense ("+a[3].toFixed(3)+" OPS, "+Math.round(a[4]*100)+"% K) at "+venue+"."+(vt!=null?(" O/U "+vt+"."):"")+" "+a[5].toFixed(2)+" ERA, "+a[6].toFixed(2)+" WHIP."};
  });
  return {hitters,pitchers,games:6,oddsUsed:true,statusByPk:{}};
}

/* ---------- HTML ---------- */
function f3(x){ if(x==null) return null; let s=Number(x).toFixed(3); if(s.indexOf("0.")===0) s=s.slice(1); else if(s.indexOf("-0.")===0) s="-"+s.slice(2); return s; }
function f2(x){ return x==null?null:Number(x).toFixed(2); }
function f1(x){ return x==null?null:Number(x).toFixed(1); }
function cell(k,v){ return '<div class="sl"><div class="slk">'+k+'</div><div class="slv">'+(v==null?"\u2014":v)+'</div></div>'; }
function hitStrip(l){ if(!l) return '<div class="nostat">No data for this stretch.</div>';
  return '<div class="strip">'+cell("AVG",f3(l.avg))+cell("OBP",f3(l.obp))+cell("SLG",f3(l.slg))+cell("OPS",f3(l.ops))+cell("HR",l.hr)+cell("RBI",l.rbi)+cell("R",l.r)+cell("SB",l.sb)+'</div>'; }
function pitStrip(l){ if(!l) return '<div class="nostat">No data for this stretch.</div>';
  const wl=(l.w!=null||l.l!=null)?((l.w!=null?l.w:0)+"-"+(l.l!=null?l.l:0)):null;
  return '<div class="strip">'+cell("ERA",f2(l.era))+cell("WHIP",f2(l.whip))+cell("IP",l.ip)+cell("SO",l.so)+cell("BB",l.bb)+cell("W-L",wl)+'</div>'; }
function starsHTML(n){ let s=""; for(let i=1;i<=5;i++) s+=(i<=n?'<span class="st on">\u2605</span>':'<span class="st">\u2606</span>'); return '<span class="stars">'+s+'</span>'; }
function barRow(label,val){ return '<div class="barwrap"><div class="bk"><span>'+label+'</span><span>'+val+'</span></div><div class="bar"><i style="width:'+val+'%"></i></div></div>'; }
function vegasCard(vt){ return vt==null?'':'<div class="stat"><div class="k">Vegas total</div><div class="v">'+vt+'</div><div class="sm">game over/under</div></div>'; }
function rightCol(r){
  if(r.noData) return '<div class="right"><span class="badge nodata">\u2014 NO DATA</span><div class="score">\u2014</div><div class="conflabel">no rating</div><div class="caret">stats \u25be</div></div>';
  return '<div class="right"><span class="badge '+r.css+'">'+r.emoji+' '+r.label+'</span><div class="score">'+r.score+'</div>'+starsHTML(r.conf.stars)+'<div class="conflabel">'+r.conf.label+' confidence</div><div class="caret">stats \u25be</div></div>';
}
function hitterRowHTML(r,i){
  const flag=r.flag==="IL"?'<span class="flag out">IL</span>':r.flag==="DTD"?'<span class="flag dtd">day-to-day</span>':(r.confirmed===null?'<span class="flag tbd">lineup tbd</span>':'');
  const bo=r.battingOrder?'<span class="bo">#'+r.battingOrder+'</span>':'';
  let detail;
  if(r.noData){ detail='<div class="confnote">'+esc(r.reason)+'</div>'
      +'<div class="statblock"><div class="stlabel">Season</div>'+hitStrip(r.season)+'</div>'
      +'<div class="statblock"><div class="stlabel">Last 14 days</div>'+hitStrip(r.last14)+'</div>'; }
  else { detail='<div class="bars">'+barRow("Bat",r.comps.hitter)+barRow("Pitching",r.comps.staff)+barRow("Park",r.comps.park)+(r.comps.vegas!=null?barRow("Vegas",r.comps.vegas):'')+'</div>'
      +'<div class="confnote">'+esc(r.conf.note)+'</div>'
      +'<div class="statblock"><div class="stlabel">Season</div>'+hitStrip(r.season)+'</div>'
      +'<div class="statblock"><div class="stlabel">Last 14 days</div>'+hitStrip(r.last14)+'</div>'
      +'<div class="grid">'
        +'<div class="stat"><div class="k">Lineup</div><div class="v" style="font-size:18px">'+(r.battingOrder?("Batting #"+r.battingOrder):(r.confirmed===null?"Not posted":"\u2014"))+'</div><div class="sm">vs '+esc(r.opp)+'</div></div>'
        +'<div class="stat"><div class="k">OPS vs hand</div><div class="v">'+(r.ops!=null?f3(r.ops):"\u2014")+'</div><div class="sm">'+esc(r.opsSrc)+'</div></div>'
        +vegasCard(r.vegasTotal)
      +'</div>'; }
  return '<div class="row '+r.css+'" data-name="'+esc((r.name+" "+r.team).toLowerCase())+'" data-v="'+r.css+'" data-pos="'+esc(r.pos)+'" data-conf="'+(r.confirmed===true?"1":"0")+'" style="animation-delay:'+(Math.min(i,30)*0.018).toFixed(3)+'s">'
   +'<div class="rowhead" onclick="toggleRow(this.parentNode)"><div class="rank">'+(r.noData?"\u2014":r.rank)+'</div>'
   +'<div class="main"><div class="name">'+bo+esc(r.name)+' <span class="pos">'+esc(r.pos)+'</span> <span class="team">'+esc(r.team)+'</span> '+flag+'</div>'
   +'<div class="reason">'+esc(r.reason)+'</div></div>'+rightCol(r)+'</div><div class="detail">'+detail+'</div></div>';
}
function pitcherRowHTML(r,i){
  let detail;
  if(r.noData){ detail='<div class="confnote">'+esc(r.reason)+'</div>'
      +'<div class="statblock"><div class="stlabel">Season</div>'+pitStrip(r.season)+'</div>'
      +'<div class="statblock"><div class="stlabel">Last 14 days</div>'+pitStrip(r.last14)+'</div>'; }
  else { detail='<div class="bars">'+barRow("Offense faced",r.comps.offense)+barRow("Own form",r.comps.own)+barRow("Park",r.comps.park)+(r.comps.vegas!=null?barRow("Vegas",r.comps.vegas):'')+'</div>'
      +'<div class="confnote">'+esc(r.conf.note)+'</div>'
      +'<div class="statblock"><div class="stlabel">Season</div>'+pitStrip(r.season)+'</div>'
      +'<div class="statblock"><div class="stlabel">Last 14 days</div>'+pitStrip(r.last14)+'</div>'
      +'<div class="grid">'
        +'<div class="stat"><div class="k">Opponent</div><div class="v" style="font-size:18px">'+esc(r.oppTeam)+'</div><div class="sm">'+(r.oppOps!=null?f3(r.oppOps):"\u2014")+' OPS, '+(r.oppK!=null?Math.round(r.oppK*100):"\u2014")+'% K</div></div>'
        +'<div class="stat"><div class="k">Park</div><div class="v" style="font-size:18px">'+esc(r.venue)+'</div><div class="sm">factor '+r.park+'</div></div>'
        +vegasCard(r.vegasTotal)
      +'</div>'; }
  return '<div class="row '+r.css+'" data-name="'+esc((r.name+" "+r.team).toLowerCase())+'" data-v="'+r.css+'" data-pos="SP" style="animation-delay:'+(Math.min(i,30)*0.018).toFixed(3)+'s">'
   +'<div class="rowhead" onclick="toggleRow(this.parentNode)"><div class="rank">'+(r.noData?"\u2014":r.rank)+'</div>'
   +'<div class="main"><div class="name">'+esc(r.name)+' <span class="pos">SP</span> <span class="team">'+esc(r.team)+'</span></div>'
   +'<div class="reason">'+esc(r.reason)+'</div></div>'+rightCol(r)+'</div><div class="detail">'+detail+'</div></div>';
}
function scoreboardHTML(sb){
  if(!sb) return "";
  const cellSB=(label,css,t)=>'<div class="sb-cell '+css+'"><b>'+(t?f1(t.avg):"\u2014")+'</b><span>'+label+(t?(' \u00b7 '+t.n+' played'):'')+'</span></div>';
  const lead=(sb.h.tiers.start&&sb.h.tiers.sit)
    ? 'Our hitter STARTs averaged <b>'+f1(sb.h.tiers.start.avg)+'</b> pts. Our SITs averaged <b>'+f1(sb.h.tiers.sit.avg)+'</b>.'
    : 'How yesterday\u2019s calls actually scored.';
  const pbits=["start","lean","matchup","sit"].filter(k=>sb.p.tiers[k]).map(k=>k.toUpperCase()+" "+f1(sb.p.tiers[k].avg)+" ("+sb.p.tiers[k].n+")").join(" \u00b7 ");
  return '<div class="section-label">Yesterday\u2019s scoreboard \u2014 '+esc(sb.date)+'</div>'
    +'<div class="sboard"><p class="sb-lead">'+lead+'</p>'
    +'<div class="sb-grid">'+cellSB("Start avg pts","start",sb.h.tiers.start)+cellSB("Lean avg pts","lean",sb.h.tiers.lean)+cellSB("Matchup avg pts","matchup",sb.h.tiers.matchup)+cellSB("Sit avg pts","sit",sb.h.tiers.sit)+'</div>'
    +(pbits?'<p class="sb-p">Pitchers: '+pbits+' pts avg</p>':'')
    +(sb.h.best?'<p class="sb-best">Best call: <b>'+esc(sb.h.best.name)+'</b> ('+esc(sb.h.best.team)+') \u2014 '+f1(sb.h.best.pts)+' pts as a '+esc(sb.h.best.verdict)+'.</p>':'')
    +'<p class="sb-note">Graded against real MLB box scores with generic points-league scoring \u2014 hitters: total bases + R + RBI + BB + HBP + 2\u00d7SB &middot; pitchers: 3\u00d7IP + K \u2212 2\u00d7ER \u2212 BB \u2212 H. Calls are frozen at first pitch; players who didn\u2019t play are excluded.</p></div>';
}

function pageHTML(d){
  const hitters=d.hitters, pitchers=d.pitchers, live=d.live, dateLabel=d.dateLabel;
  const gamesCount=new Set(hitters.map(r=>r.gameKey)).size;
  const starts=hitters.filter(r=>!r.noData&&(r.css==="start"||r.css==="lean")).length;
  const cand=hitters.filter(r=>!r.noData&&r.flag!=="IL");
  const confCand=cand.filter(r=>r.confirmed===true);
  const top=(confCand.length>=3?confCand:cand).slice(0,3);
  const top3=top.map(r=>'<div class="top-card"><div class="tnum">'+r.rank+'</div><div class="tscore">'+r.score+'</div><div class="tnm">'+esc(r.name)+'</div><div class="tsub">'+esc(r.team)+' &middot; vs '+esc(r.opp)+'</div><span class="badge '+r.css+'">'+r.emoji+' '+r.label+'</span></div>').join("");
  const hRows=hitters.map(hitterRowHTML).join("")||'<div class="empty">No hitters to show today.</div>';
  const pRows=pitchers.map(pitcherRowHTML).join("")||'<div class="empty">No probable pitchers posted yet.</div>';
  const sbHTML=scoreboardHTML(d.scoreboard);
  const stamp="Built "+new Date().toLocaleString("en-US",{timeZone:ET})+" ET";
  const liveTxt=live?"Live data":"Sample data", liveClass=live?"":"sample";
  const oddsCredit=d.oddsUsed?' &middot; game totals via <a href="https://the-odds-api.com" rel="noopener" target="_blank">The Odds API</a>':'';
  const gcTag=GOATCOUNTER?('<script data-goatcounter="https://'+GOATCOUNTER+'.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></scr'+'ipt>'):'';

  // comparison data (curated fields)
  const cmpH=hitters.map(r=>({type:"H",disp:r.name+" ("+r.team+")",name:r.name,team:r.team,pos:r.pos,score:r.score,label:r.label,css:r.css,noData:r.noData,
    conf:r.conf?r.conf.label:null,opsHand:r.ops,sOPS:r.season?r.season.ops:null,sAVG:r.season?r.season.avg:null,sHR:r.season?r.season.hr:null,sRBI:r.season?r.season.rbi:null,
    lOPS:r.last14?r.last14.ops:null,lAVG:r.last14?r.last14.avg:null,battingOrder:r.battingOrder,opp:r.opp}));
  const cmpP=pitchers.map(r=>({type:"P",disp:r.name+" ("+r.team+")",name:r.name,team:r.team,pos:"SP",score:r.score,label:r.label,css:r.css,noData:r.noData,
    conf:r.conf?r.conf.label:null,sERA:r.season?r.season.era:null,sWHIP:r.season?r.season.whip:null,sK:r.season?r.season.so:null,sIP:r.season?r.season.ip:null,
    lERA:r.last14?r.last14.era:null,lWHIP:r.last14?r.last14.whip:null,oppTeam:r.oppTeam}));
  const compareJSON=JSON.stringify(cmpH.concat(cmpP)).replace(/</g,"\\u003c");

return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Lineup Card &middot; Daily Fantasy Start/Sit</title>
<meta name="description" content="Daily fantasy baseball start/sit calls for every hitter and pitcher, ranked by matchup with a confidence rating. Yesterday's calls graded against real box scores. Compare any two players head-to-head. Stats pulled live from MLB.">
<meta property="og:title" content="The Lineup Card \u2014 Daily Fantasy Start/Sit">
<meta property="og:description" content="Every hitter and pitcher today, ranked by matchup. Yesterday's calls graded against real box scores. Season + last-14-day stats on every player. Stats pulled live from MLB.">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b0d0e'/%3E%3Crect x='1.2' y='1.2' width='29.6' height='29.6' rx='6' fill='none' stroke='%23e8b84b' stroke-width='1.4'/%3E%3Ctext x='16' y='23' font-family='Arial' font-size='19' font-weight='bold' text-anchor='middle' fill='%23e8b84b'%3E9%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b0d0e;--bg2:#0e1112;--panel:#15191b;--panel2:#1a2022;--line:#262d30;--line2:#323a3d;--ink:#f0f3f1;--muted:#8a9794;--dim:#5f6b69;--gold:#e8b84b;--gold2:#f4cf72;--start:#5fd068;--lean:#5bc0be;--matchup:#e8b84b;--sit:#e0666f;--nodata:#6b7775;--shadow:0 20px 55px -24px rgba(0,0,0,.85);}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--ink);font-family:"Archivo",sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5;min-height:100vh;position:relative;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(1100px 560px at 82% -8%,rgba(232,184,75,.07),transparent 58%),radial-gradient(820px 480px at -8% 8%,rgba(91,192,190,.05),transparent 55%),linear-gradient(180deg,var(--bg2),var(--bg) 40%)}
.grain{position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.045;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.wrap{position:relative;z-index:2;max-width:1010px;margin:0 auto;padding:0 20px 90px}
.brandbar{display:flex;justify-content:space-between;align-items:center;padding:14px 0;font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line)}
.brandbar .b{display:flex;align-items:center;gap:9px;color:var(--ink)}
.brandbar .dia{color:var(--gold);font-size:9px}
.brandbar .r{color:var(--dim)}
header{padding:44px 0 26px;border-bottom:1px solid var(--line);position:relative}
.kicker{font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.34em;text-transform:uppercase;color:var(--gold);margin-bottom:14px}
.wordmark{font-family:"Bebas Neue",sans-serif;font-weight:400;font-size:clamp(64px,15vw,150px);line-height:.82;letter-spacing:.005em;display:flex;align-items:baseline;gap:.06em;flex-wrap:wrap}
.wordmark .slash{color:var(--gold);transform:translateY(-.02em)}
.wordmark .sit{color:var(--ink);-webkit-text-stroke:1.5px var(--line2);color:transparent}
.subbrand{font-family:"Bebas Neue",sans-serif;font-size:clamp(22px,4vw,30px);letter-spacing:.18em;color:var(--muted);margin-top:6px}
.tag{margin-top:15px;color:var(--muted);font-size:15px;max-width:54ch}
.statbar{display:grid;grid-template-columns:repeat(4,1fr);gap:0;margin-top:30px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:linear-gradient(180deg,var(--panel),var(--bg2))}
.statbar .cellb{padding:16px 18px;border-right:1px solid var(--line)}
.statbar .cellb:last-child{border-right:0}
.statbar b{display:block;font-family:"Bebas Neue",sans-serif;font-size:34px;color:var(--ink);letter-spacing:.02em;line-height:1}
.statbar span{display:block;color:var(--dim);text-transform:uppercase;letter-spacing:.16em;font-size:9px;font-family:"JetBrains Mono",monospace;margin-top:6px}
.statbar .live{display:inline-flex;align-items:center;gap:7px;font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:500}
.statbar .live .dot{width:7px;height:7px;border-radius:50%;background:var(--start);animation:pulse 2s infinite}
.statbar .live.sample .dot{background:var(--gold);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(95,208,104,.5)}70%{box-shadow:0 0 0 9px rgba(95,208,104,0)}100%{box-shadow:0 0 0 0 rgba(95,208,104,0)}}
.sboard{background:linear-gradient(158deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:16px;padding:20px 22px;animation:rise .5s both}
.sb-lead{font-size:15px;color:var(--ink)}
.sb-lead b{color:var(--gold);font-family:"Bebas Neue",sans-serif;font-size:20px;letter-spacing:.02em}
.sb-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}
.sb-cell{background:var(--bg);border:1px solid var(--line);border-top:3px solid var(--line2);border-radius:11px;padding:12px 14px}
.sb-cell.start{border-top-color:var(--start)}.sb-cell.lean{border-top-color:var(--lean)}.sb-cell.matchup{border-top-color:var(--matchup)}.sb-cell.sit{border-top-color:var(--sit)}
.sb-cell b{display:block;font-family:"Bebas Neue",sans-serif;font-size:30px;line-height:1}
.sb-cell span{display:block;font-family:"JetBrains Mono",monospace;font-size:9px;letter-spacing:.13em;text-transform:uppercase;color:var(--dim);margin-top:5px}
.sb-p,.sb-best{color:var(--muted);font-size:13px;margin-top:12px;font-family:"JetBrains Mono",monospace}
.sb-best{font-family:"Archivo",sans-serif}
.sb-best b{color:var(--ink)}
.sb-note{color:var(--dim);font-size:11px;font-family:"JetBrains Mono",monospace;margin-top:12px;line-height:1.6}
.toolbar{position:sticky;top:0;z-index:20;margin:0 -20px;padding:13px 20px;background:rgba(11,13,14,.8);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid var(--line);display:flex;gap:13px;align-items:center;flex-wrap:wrap}
.tabs{display:flex;gap:5px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:5px}
.tabs button{background:transparent;border:0;color:var(--muted);font-family:"Bebas Neue",sans-serif;font-size:21px;letter-spacing:.05em;padding:7px 17px;border-radius:8px;cursor:pointer;transition:.15s}
.tabs button:hover{color:var(--ink)}
.tabs button.on{background:var(--ink);color:var(--bg)}
.search{flex:1;min-width:170px;position:relative}
.search input{width:100%;background:var(--panel);border:1px solid var(--line);border-radius:11px;color:var(--ink);font-family:"Archivo",sans-serif;font-size:15px;padding:12px 15px 12px 40px}
.search input:focus{outline:none;border-color:var(--gold)}
.search::before{content:"\\002315";position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--dim);font-size:15px}
.vfilters{display:flex;gap:7px;flex-wrap:wrap;margin:18px 0 18px;align-items:center}
.vfilters button{background:var(--panel);border:1px solid var(--line);color:var(--muted);font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;padding:8px 14px;border-radius:999px;cursor:pointer;transition:.15s}
.vfilters button:hover{border-color:var(--line2);color:var(--ink)}
.vfilters button.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.vfilters button#lineupOnly.on{background:var(--gold);border-color:var(--gold);color:var(--bg)}
.posfilter-wrap{margin-left:auto}
.posfilter-wrap select{background:var(--panel);border:1px solid var(--line);border-radius:10px;color:var(--ink);font-family:"Archivo",sans-serif;font-size:14px;padding:10px 12px;cursor:pointer}
.posfilter-wrap select:focus{outline:none;border-color:var(--gold)}
.section-label{font-family:"JetBrains Mono",monospace;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--dim);margin:26px 0 14px;display:flex;align-items:center;gap:14px}
.section-label::after{content:"";flex:1;height:1px;background:var(--line)}
.top3{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}
.top-card{background:linear-gradient(158deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:15px;padding:18px;position:relative;overflow:hidden;animation:rise .5s both}
.top-card::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--gold),var(--gold2))}
.top-card:nth-child(2){animation-delay:.06s}.top-card:nth-child(3){animation-delay:.12s}
.top-card .tnum{font-family:"Bebas Neue",sans-serif;font-size:40px;color:var(--gold);line-height:1}
.top-card .tscore{position:absolute;right:16px;top:15px;font-family:"JetBrains Mono",monospace;font-size:14px;color:var(--start);font-weight:700}
.top-card .tnm{font-family:"Bebas Neue",sans-serif;font-size:26px;letter-spacing:.02em;margin-top:4px}
.top-card .tsub{color:var(--muted);font-size:12px;margin:2px 0 11px}
.list{display:flex;flex-direction:column;gap:9px}
.empty{color:var(--dim);font-size:14px;padding:24px 4px;font-family:"JetBrains Mono",monospace}
.row{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);transition:border-color .16s,transform .16s;animation:rise .45s both;overflow:hidden}
.row:hover{border-color:var(--line2);transform:translateY(-1px)}
.row.nodata{opacity:.72}
.rowhead{display:grid;grid-template-columns:44px 1fr auto;gap:15px;align-items:center;padding:15px 17px;cursor:pointer}
.rank{font-family:"Bebas Neue",sans-serif;font-size:29px;color:var(--dim);text-align:center}
.row.start .rank{color:var(--start)}.row.lean .rank{color:var(--lean)}
.main .name{font-family:"Bebas Neue",sans-serif;font-size:25px;letter-spacing:.02em;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.bo{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--gold);border:1px solid rgba(232,184,75,.4);border-radius:5px;padding:2px 6px}
.pos{font-family:"JetBrains Mono",monospace;font-size:10px;color:var(--dim);border:1px solid var(--line);border-radius:5px;padding:2px 6px;letter-spacing:.06em}
.team{color:var(--muted);font-size:12px;font-family:"JetBrains Mono",monospace}
.flag{font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.05em;border-radius:5px;padding:2px 7px;text-transform:uppercase}
.flag.out{background:rgba(224,102,111,.15);color:var(--sit)}.flag.dtd{background:rgba(232,184,75,.15);color:var(--matchup)}.flag.tbd{background:var(--panel2);color:var(--dim);border:1px solid var(--line)}
.reason{color:var(--muted);font-size:13px;margin-top:5px;line-height:1.45}
.right{text-align:right;min-width:122px}
.badge{display:inline-flex;align-items:center;gap:6px;font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:700;letter-spacing:.08em;padding:6px 11px;border-radius:8px}
.badge.start{background:rgba(95,208,104,.13);color:var(--start)}.badge.lean{background:rgba(91,192,190,.13);color:var(--lean)}.badge.matchup{background:rgba(232,184,75,.13);color:var(--matchup)}.badge.sit{background:rgba(224,102,111,.12);color:var(--sit)}.badge.nodata{background:rgba(107,119,117,.15);color:var(--nodata)}
.score{font-family:"Bebas Neue",sans-serif;font-size:37px;line-height:.9;margin-top:7px}
.stars{display:block;margin-top:5px;font-size:13px;letter-spacing:1px}
.st{color:var(--line2)}.st.on{color:var(--gold)}
.conflabel{font-family:"JetBrains Mono",monospace;font-size:9px;color:var(--dim);letter-spacing:.12em;text-transform:uppercase;margin-top:3px}
.caret{color:var(--dim);font-size:11px;margin-top:5px;font-family:"JetBrains Mono",monospace;letter-spacing:.08em}
.detail{border-top:1px solid var(--line);padding:16px 17px;display:none;background:var(--panel2)}
.row.open .detail{display:block;animation:rise .3s both}
.bars{display:flex;gap:10px;flex-wrap:wrap}
.barwrap{flex:1;min-width:120px}
.barwrap .bk{font-family:"JetBrains Mono",monospace;font-size:9px;color:var(--dim);letter-spacing:.1em;text-transform:uppercase;display:flex;justify-content:space-between;margin-bottom:4px}
.bar{height:5px;border-radius:3px;background:var(--line);overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--gold),var(--gold2));border-radius:3px}
.confnote{color:var(--muted);font-size:12px;margin-top:13px;font-style:italic}
.statblock{margin-top:15px}
.stlabel{font-family:"JetBrains Mono",monospace;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);display:flex;align-items:center;gap:9px;margin-bottom:2px}
.stlabel::after{content:"";flex:1;height:1px;background:var(--line)}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(56px,1fr));gap:6px;margin-top:8px}
.sl{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 4px;text-align:center}
.slk{font-family:"JetBrains Mono",monospace;font-size:8px;letter-spacing:.1em;color:var(--dim);text-transform:uppercase}
.slv{font-family:"Bebas Neue",sans-serif;font-size:22px;line-height:1;margin-top:3px}
.nostat{color:var(--dim);font-family:"JetBrains Mono",monospace;font-size:12px;padding:9px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-top:15px}
.stat{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat .k{font-family:"JetBrains Mono",monospace;font-size:9px;color:var(--dim);letter-spacing:.14em;text-transform:uppercase}
.stat .v{font-family:"Bebas Neue",sans-serif;font-size:24px;margin-top:3px}
.stat .sm{color:var(--muted);font-size:12px;margin-top:1px}
/* compare */
.cmp-pick{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.cmp-field{flex:1;min-width:200px}
.cmp-field label{display:block;font-family:"JetBrains Mono",monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
.cmp-field input{width:100%;background:var(--panel);border:1px solid var(--line);border-radius:11px;color:var(--ink);font-family:"Archivo",sans-serif;font-size:15px;padding:12px 14px}
.cmp-field input:focus{outline:none;border-color:var(--gold)}
.cmp-vs{font-family:"Bebas Neue",sans-serif;font-size:26px;color:var(--gold);align-self:flex-end;padding-bottom:6px}
.cmp-verdict{font-size:15px;line-height:1.55;color:var(--ink);background:linear-gradient(158deg,var(--panel2),var(--panel));border:1px solid var(--line);border-left:3px solid var(--dim);border-radius:12px;padding:15px 17px;margin-bottom:16px}
.cmp-verdict:empty{display:none}
.cmp-verdict.start{border-left-color:var(--start)}.cmp-verdict.lean{border-left-color:var(--lean)}.cmp-verdict.matchup{border-left-color:var(--matchup)}.cmp-verdict.sit{border-left-color:var(--sit)}
.cmp-cards{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:6px}
.cmp-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;text-align:center;position:relative;overflow:hidden}
.cmp-card.empty2{color:var(--dim);font-family:"JetBrains Mono",monospace;font-size:13px;display:flex;align-items:center;justify-content:center;min-height:150px}
.cmp-card .cap{position:absolute;inset:0 0 auto 0;height:3px}
.cmp-card.start .cap{background:var(--start)}.cmp-card.lean .cap{background:var(--lean)}.cmp-card.matchup .cap{background:var(--matchup)}.cmp-card.sit .cap{background:var(--sit)}.cmp-card.nodata .cap{background:var(--nodata)}
.cmp-name{font-family:"Bebas Neue",sans-serif;font-size:27px;letter-spacing:.02em;margin-top:4px}
.cmp-team{color:var(--muted);font-size:12px;font-family:"JetBrains Mono",monospace;margin-bottom:8px}
.cmp-score{font-family:"Bebas Neue",sans-serif;font-size:56px;line-height:1;margin:4px 0}
.cmp-conf{font-family:"JetBrains Mono",monospace;font-size:9px;color:var(--dim);letter-spacing:.12em;text-transform:uppercase;margin-top:8px}
.ctab{width:100%;border-collapse:collapse;margin-top:6px;font-family:"JetBrains Mono",monospace;font-size:13px;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.ctab th{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:11px 10px;border-bottom:1px solid var(--line2);text-align:center;background:var(--panel2)}
.ctab th:first-child{text-align:left}
.ctab td{padding:10px;text-align:center;border-bottom:1px solid var(--line)}
.ctab tr:last-child td{border-bottom:0}
.ctab td.lbl{text-align:left;color:var(--dim);font-size:10px;letter-spacing:.06em;text-transform:uppercase}
.ctab td.win{color:var(--gold);font-weight:700;position:relative}
.ctab td.win::after{content:"";position:absolute;left:8px;right:8px;bottom:5px;height:2px;background:var(--gold);opacity:.45;border-radius:2px}
.cmp-hint{color:var(--dim);font-size:12px;font-family:"JetBrains Mono",monospace;margin-top:14px;text-align:center}
.how{margin-top:50px;background:linear-gradient(158deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:16px;padding:26px 28px}
.how h3{font-family:"Bebas Neue",sans-serif;font-size:26px;letter-spacing:.03em;margin-bottom:12px}
.how p{color:var(--muted);font-size:14px;margin-bottom:10px}
.how .mix{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.chip{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 12px}
.chip b{color:var(--gold)}
footer{margin-top:34px;text-align:center;color:var(--dim);font-size:12px;font-family:"JetBrains Mono",monospace;line-height:1.85}
footer a{color:var(--muted)}
.hidden{display:none}
@keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
@media(max-width:720px){.statbar{grid-template-columns:repeat(2,1fr)}.statbar .cellb:nth-child(2){border-right:0}.statbar .cellb:nth-child(1),.statbar .cellb:nth-child(2){border-bottom:1px solid var(--line)}.sb-grid{grid-template-columns:repeat(2,1fr)}.top3{grid-template-columns:1fr}.cmp-cards{grid-template-columns:1fr}.rowhead{grid-template-columns:34px 1fr;gap:11px}.right{grid-column:1/-1;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding-top:11px;margin-top:3px}.score,.stars{margin-top:0}.posfilter-wrap{margin-left:0;width:100%}.posfilter-wrap select{width:100%}.cmp-vs{align-self:center;padding:0}}
</style>
</head>
<body>
<div class="grain"></div>
<div class="wrap">
  <div class="brandbar"><div class="b"><span class="dia">\u25C6</span> THE LINEUP CARD</div><div class="r">MLB &middot; ${esc(dateLabel.split(",").slice(0,2).join(","))}</div></div>
  <header>
    <div class="kicker">Daily Fantasy Baseball &middot; Points Leagues</div>
    <div class="wordmark">START<span class="slash">/</span><span class="sit">SIT</span></div>
    <div class="subbrand">THE DAILY DESK</div>
    <p class="tag">Every hitter and pitcher today, ranked by matchup with a confidence rating. Season and last-14-day stats on every player. Tap anyone for the full breakdown.</p>
    <div class="statbar">
      <div class="cellb"><b>${esc(dateLabel.split(",")[0].toUpperCase())}</b><span>${esc(dateLabel.split(",").slice(1).join(",").trim())}</span></div>
      <div class="cellb"><b>${gamesCount}</b><span>Games today</span></div>
      <div class="cellb"><b>${starts}</b><span>Start / lean calls</span></div>
      <div class="cellb" style="display:flex;align-items:center"><span class="live ${liveClass}"><span class="dot"></span>${liveTxt}</span></div>
    </div>
  </header>

  ${sbHTML}

  <div class="toolbar">
    <div class="tabs"><button id="tab-h" class="on" data-tab="h">Hitters</button><button id="tab-p" data-tab="p">Pitchers</button><button id="tab-c" data-tab="c">Compare</button></div>
    <div class="search"><input id="search" type="text" placeholder="Search a player or team&hellip;" autocomplete="off"></div>
  </div>
  <div class="vfilters" id="vfilters">
    <button class="on" data-f="all">All</button><button data-f="start">Start</button><button data-f="lean">Lean</button><button data-f="matchup">Matchup</button><button data-f="sit">Sit</button>
    <button id="lineupOnly" title="Show only hitters with a confirmed spot in a posted lineup">In lineup only</button>
    <span class="posfilter-wrap" id="posfilter-wrap"><select id="posfilter"><option value="all">All positions</option><option value="C">C</option><option value="1B">1B</option><option value="2B">2B</option><option value="3B">3B</option><option value="SS">SS</option><option value="OF">OF</option><option value="DH">DH</option></select></span>
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
    <div class="section-label">Head-to-head &mdash; which do I start?</div>
    <div class="cmp-pick">
      <div class="cmp-field"><label>Player A</label><input id="cmpA" list="playerlist" type="text" placeholder="Type a name&hellip;" autocomplete="off"></div>
      <span class="cmp-vs">vs</span>
      <div class="cmp-field"><label>Player B</label><input id="cmpB" list="playerlist" type="text" placeholder="Type a name&hellip;" autocomplete="off"></div>
    </div>
    <datalist id="playerlist"></datalist>
    <div id="cmpVerdict" class="cmp-verdict"></div>
    <div id="cmpCards" class="cmp-cards"></div>
    <div id="cmpTable"></div>
    <div class="cmp-hint">Tip: compare two hitters or two pitchers for a direct start/sit call. Winner of each stat is highlighted in gold.</div>
  </div>

  <div class="how">
    <h3>How the calls work</h3>
    <p>Every player gets a 0&ndash;100 matchup score and a confidence rating. Nothing's hidden &mdash; tap a player to see the factor breakdown plus their season and last-14-day stats.</p>
    <div class="mix"><span class="chip"><b>Hitters:</b> OPS vs the pitcher's hand</span><span class="chip">how hittable the starter is</span><span class="chip">the bullpen behind him</span><span class="chip">ballpark</span><span class="chip">Vegas game total (when posted)</span></div>
    <div class="mix"><span class="chip"><b>Pitchers:</b> the offense they face</span><span class="chip">that lineup's strikeout rate</span><span class="chip">park</span><span class="chip">their own form</span><span class="chip">Vegas game total (when posted)</span></div>
    <p><b style="color:var(--ink)">Confidence</b> reflects how strong the lean is, how much data backs it, and whether the factors agree. A confirmed batting-order spot shows once lineups post, a few hours before first pitch &mdash; the &ldquo;In lineup only&rdquo; filter then narrows the board to confirmed starters.</p>
    <p><b style="color:var(--ink)">Yesterday's scoreboard</b> grades the previous day's calls against real box scores. Calls are saved before first pitch and never rewritten after the fact.</p>
    <p style="color:var(--dim)">Coming next: weather folded into the scoring.</p>
  </div>

  <footer>Every stat is pulled live from the official <a href="https://statsapi.mlb.com" rel="noopener" target="_blank">MLB Stats API</a>${oddsCredit} &mdash; the only computed numbers are the matchup score and the graded points on yesterday's scoreboard (formula shown there). Where a real stat isn't available you'll see &ldquo;no data,&rdquo; never a guess.<br>${esc(stamp)} &middot; cross-check any number at MLB.com &middot; not affiliated with or endorsed by MLB.</footer>
</div>

<script>
var PLAYERS=${compareJSON};
function toggleRow(row){ row.classList.toggle("open"); }
var curTab="h",curFilter="all",curPos="all",curLineup=false;
function applyFilters(){
  if(curTab==="c") return;
  var listId=curTab==="h"?"hitterList":"pitcherList", q=document.getElementById("search").value.trim().toLowerCase();
  document.querySelectorAll("#"+listId+" .row").forEach(function(r){
    var okQ=!q||r.getAttribute("data-name").indexOf(q)>=0, okF=curFilter==="all"||r.getAttribute("data-v")===curFilter, pos=r.getAttribute("data-pos")||"";
    var okP=(curTab!=="h")||curPos==="all"||pos===curPos||(curPos==="OF"&&(pos==="LF"||pos==="CF"||pos==="RF"));
    var okL=(curTab!=="h")||!curLineup||r.getAttribute("data-conf")==="1";
    r.style.display=(okQ&&okF&&okP&&okL)?"":"none";
  });
}
document.querySelectorAll(".tabs button").forEach(function(b){ b.onclick=function(){
  document.querySelectorAll(".tabs button").forEach(function(x){x.classList.remove("on");}); b.classList.add("on"); curTab=b.getAttribute("data-tab");
  document.getElementById("view-h").classList.toggle("hidden",curTab!=="h");
  document.getElementById("view-p").classList.toggle("hidden",curTab!=="p");
  document.getElementById("view-c").classList.toggle("hidden",curTab!=="c");
  document.getElementById("vfilters").style.display=(curTab==="c")?"none":"flex";
  document.getElementById("posfilter-wrap").style.display=(curTab==="h")?"inline-block":"none";
  document.getElementById("lineupOnly").style.display=(curTab==="h")?"":"none";
  document.querySelector(".search").style.display=(curTab==="c")?"none":"block";
  applyFilters();
};});
document.querySelectorAll(".vfilters button[data-f]").forEach(function(b){ b.onclick=function(){
  document.querySelectorAll(".vfilters button[data-f]").forEach(function(x){x.classList.remove("on");}); b.classList.add("on"); curFilter=b.getAttribute("data-f"); applyFilters();
};});
document.getElementById("lineupOnly").onclick=function(){ curLineup=!curLineup; this.classList.toggle("on",curLineup); applyFilters(); };
document.getElementById("search").oninput=applyFilters;
document.getElementById("posfilter").onchange=function(){ curPos=this.value; applyFilters(); };

/* ----- head-to-head compare ----- */
function f3(n){ if(n==null) return "\u2014"; var s=Number(n).toFixed(3); return s.replace(/^0\\./,".").replace(/^-0\\./,"-."); }
function f2(n){ return n==null?"\u2014":Number(n).toFixed(2); }
function iv(n){ return n==null?"\u2014":(""+n); }
var byDisp={}; PLAYERS.forEach(function(p){ byDisp[p.disp]=p; });
(function(){ var dl=document.getElementById("playerlist");
  dl.innerHTML=PLAYERS.map(function(p){ return '<option value="'+p.disp.replace(/"/g,"&quot;")+'">'+(p.noData?"no data":p.label)+'</option>'; }).join(""); })();
function cardHTML(p){
  if(!p) return '<div class="cmp-card empty2">type a player above</div>';
  return '<div class="cmp-card '+(p.css||"")+'"><span class="cap"></span>'
    +'<div class="cmp-name">'+p.name+'</div><div class="cmp-team">'+p.team+(p.type==="P"?" \u00b7 SP":(p.pos?(" \u00b7 "+p.pos):""))+'</div>'
    +'<div class="cmp-score">'+(p.noData?"\u2014":p.score)+'</div>'
    +'<span class="badge '+(p.css||"")+'">'+p.label+'</span>'
    +(p.noData||!p.conf?"":'<div class="cmp-conf">'+p.conf+' confidence</div>')+'</div>';
}
function rowsFor(a,b){
  if(a.type==="H"){ return [
    {l:"Matchup score",a:a.score,b:b.score,d:"hi",f:iv},
    {l:"OPS vs hand",a:a.opsHand,b:b.opsHand,d:"hi",f:f3},
    {l:"Season OPS",a:a.sOPS,b:b.sOPS,d:"hi",f:f3},
    {l:"Season AVG",a:a.sAVG,b:b.sAVG,d:"hi",f:f3},
    {l:"Season HR",a:a.sHR,b:b.sHR,d:"hi",f:iv},
    {l:"Season RBI",a:a.sRBI,b:b.sRBI,d:"hi",f:iv},
    {l:"Last 14 OPS",a:a.lOPS,b:b.lOPS,d:"hi",f:f3},
    {l:"Last 14 AVG",a:a.lAVG,b:b.lAVG,d:"hi",f:f3}
  ]; }
  return [
    {l:"Matchup score",a:a.score,b:b.score,d:"hi",f:iv},
    {l:"Season ERA",a:a.sERA,b:b.sERA,d:"lo",f:f2},
    {l:"Season WHIP",a:a.sWHIP,b:b.sWHIP,d:"lo",f:f2},
    {l:"Season K",a:a.sK,b:b.sK,d:"hi",f:iv},
    {l:"Last 14 ERA",a:a.lERA,b:b.lERA,d:"lo",f:f2},
    {l:"Last 14 WHIP",a:a.lWHIP,b:b.lWHIP,d:"lo",f:f2}
  ];
}
function tableHTML(a,b){
  var rows=rowsFor(a,b), body=rows.map(function(r){
    var aw="",bw=""; if(r.a!=null&&r.b!=null&&r.a!==r.b){ var aWins=r.d==="hi"?(r.a>r.b):(r.a<r.b); if(aWins) aw=" class=\\"win\\""; else bw=" class=\\"win\\""; }
    return '<tr><td class="lbl">'+r.l+'</td><td'+aw+'>'+r.f(r.a)+'</td><td'+bw+'>'+r.f(r.b)+'</td></tr>';
  }).join("");
  return '<table class="ctab"><thead><tr><th></th><th>'+a.name.split(" ").slice(-1)[0]+'</th><th>'+b.name.split(" ").slice(-1)[0]+'</th></tr></thead><tbody>'+body+'</tbody></table>';
}
function doCompare(){
  var a=byDisp[document.getElementById("cmpA").value]||null, b=byDisp[document.getElementById("cmpB").value]||null;
  document.getElementById("cmpCards").innerHTML=cardHTML(a)+cardHTML(b);
  var v=document.getElementById("cmpVerdict"), tb=document.getElementById("cmpTable");
  if(!a||!b){ v.className="cmp-verdict"; v.innerHTML=""; tb.innerHTML=""; return; }
  if(a.noData&&b.noData){ v.className="cmp-verdict"; v.textContent="Not enough data on either player to compare yet."; tb.innerHTML=""; return; }
  if(a.noData||b.noData){ var ok=a.noData?b:a,nd=a.noData?a:b; v.className="cmp-verdict"; v.textContent="Not enough data on "+nd.name+" yet \u2014 "+ok.name+" is the only one ratable here."; tb.innerHTML=""; return; }
  if(a.type!==b.type){ v.className="cmp-verdict"; v.textContent="These play different roles. Pick two hitters or two pitchers for a direct start/sit call."; tb.innerHTML=tableHTML(a,b); return; }
  var diff=a.score-b.score, w=diff>=0?a:b, l=diff>=0?b:a, ad=Math.abs(diff);
  v.className="cmp-verdict "+w.css;
  if(ad<=4) v.innerHTML="<b>Practically a coin flip</b> \u2014 "+a.score+" vs "+b.score+". Slight edge to "+w.name+"; let your category needs break the tie.";
  else v.innerHTML="<b>Start "+w.name+" over "+l.name+"</b> \u2014 "+w.score+" vs "+l.score+" matchup score.";
  tb.innerHTML=tableHTML(a,b);
}
document.getElementById("cmpA").addEventListener("input",doCompare);
document.getElementById("cmpB").addEventListener("input",doCompare);
/* preload the top two hitters so the tab is obviously working */
(function(){ var hs=PLAYERS.filter(function(p){return p.type==="H"&&!p.noData;});
  if(hs.length>=2){ document.getElementById("cmpA").value=hs[0].disp; document.getElementById("cmpB").value=hs[1].disp; doCompare(); } })();
</script>
${gcTag}
</body>
</html>`;
}

(async ()=>{
  let data, live, sb=null;
  if(SAMPLE){ console.log("Building from SAMPLE data (no network)..."); data=sampleData(); live=false; sb=sampleScoreboard(); }
  else {
    console.log("Building live for "+TODAY+" (last-14 window "+START14+" \u2192 "+END14+") ...");
    data=await buildLive(); live=true;
    if(data.games>0 && !data.hitters.some(r=>!r.noData) && !data.pitchers.some(r=>!r.noData)){
      console.error("FATAL: schedule loaded ("+data.games+" games) but no player could be graded \u2014 likely an MLB API outage mid-build. Exiting with an error so the previous page stays live.");
      process.exit(1);
    }
    sb=await gradeYesterday();
    saveCalls(data);
  }
  const sk=r=>r.noData?-1:r.score;
  data.hitters.sort((a,b)=>sk(b)-sk(a)); data.hitters.forEach((r,i)=>r.rank=i+1);
  data.pitchers.sort((a,b)=>sk(b)-sk(a)); data.pitchers.forEach((r,i)=>r.rank=i+1);
  const dateLabel=new Date().toLocaleDateString("en-US",{timeZone:ET,weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const html=pageHTML({hitters:data.hitters,pitchers:data.pitchers,live,dateLabel,scoreboard:sb,oddsUsed:!!data.oddsUsed});
  fs.mkdirSync("public",{recursive:true});
  fs.writeFileSync(path.join("public","index.html"),html);
  const nd=data.hitters.filter(r=>r.noData).length;
  console.log("Wrote public/index.html \u2014 "+data.hitters.length+" hitters ("+nd+" no-data), "+data.pitchers.length+" pitchers, "+(new Set(data.hitters.map(r=>r.gameKey)).size)+" games."+(sb?" Scoreboard: graded "+sb.date+".":" No scoreboard yet (needs a saved calls file from a previous day)."));
})();
