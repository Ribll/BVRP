import { useState, useEffect } from "react";
import * as XLSX from "xlsx";
import { supabase } from "./lib/supabase";
import {
  fetchProfiles,
  fetchGroups,
  fetchAttendance,
  upsertAttendance,
  createGroup,
  deleteGroup,
  deleteProfile,
  adminCreateUser,
} from "./lib/db";

// Rende XLSX disponibile come window.XLSX per il codice di export esistente
if (typeof window !== "undefined") window.XLSX = XLSX;

const STATUS = {
  presente:    {label:"Presente",    short:"Ufficio",   color:"#34d399",bg:"rgba(52,211,153,.1)",  dot:"#34d399"},
  smartworking:{label:"Smart Working",short:"Remote",  color:"#60a5fa",bg:"rgba(96,165,250,.1)",  dot:"#60a5fa"},
  ferie:       {label:"Ferie",        short:"Ferie",    color:"#fbbf24",bg:"rgba(251,191,36,.1)",  dot:"#fbbf24"},
  trasferta:   {label:"Trasferta",    short:"Trasferta",color:"#a78bfa",bg:"rgba(167,139,250,.1)", dot:"#a78bfa"},
  permesso:    {label:"Permesso",     short:"Permesso", color:"#f472b6",bg:"rgba(244,114,182,.1)", dot:"#f472b6"},
  assente:     {label:"—",            short:"—",        color:"#3a3f55",bg:"transparent",          dot:"#3a3f55"},
};

const fmtKey=(uid,date)=>`${uid}_${(date instanceof Date?date.toISOString():date).split("T")[0]}`;
const fmtDate=d=>d.toISOString().split("T")[0];
const isToday=d=>fmtDate(d)===fmtDate(new Date());
const itShortDay=d=>d.toLocaleDateString("it-IT",{weekday:"short"}).replace(".","").toUpperCase();
const itLongDay=d=>d.toLocaleDateString("it-IT",{weekday:"long"}).replace(/^\w/,c=>c.toUpperCase());
const itDate=d=>d.toLocaleDateString("it-IT",{day:"numeric",month:"short"});

function getWeekDays(date){
  const d=new Date(date),day=d.getDay();
  const diff=d.getDate()-day+(day===0?-6:1);
  const mon=new Date(d.setDate(diff));
  return Array.from({length:7},(_,i)=>{const dd=new Date(mon);dd.setDate(mon.getDate()+i);return dd;});
}

// Calcola Pasqua con algoritmo di Gauss/Meeus
function easterDate(year){
  const a=year%19,b=Math.floor(year/100),c=year%100;
  const d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25);
  const g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30;
  const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7;
  const m=Math.floor((a+11*h+22*l)/451);
  const month=Math.floor((h+l-7*m+114)/31)-1;
  const day=((h+l-7*m+114)%31)+1;
  return new Date(year,month,day);
}

function getItalianHolidays(year){
  const e=easterDate(year);
  const eMonday=new Date(e); eMonday.setDate(e.getDate()+1);
  const fixed=[
    `${year}-01-01`,`${year}-01-06`,`${year}-04-25`,
    `${year}-05-01`,`${year}-06-02`,`${year}-08-15`,
    `${year}-11-01`,`${year}-12-08`,`${year}-12-25`,`${year}-12-26`,
  ];
  const fmt=d=>d.toISOString().split("T")[0];
  return new Set([...fixed, fmt(e), fmt(eMonday)]);
}

const HOLIDAY_NAMES={
  "01-01":"Capodanno","01-06":"Epifania","04-25":"Liberazione",
  "05-01":"Festa Lavoro","06-02":"Rep. Italiana","08-15":"Ferragosto",
  "11-01":"Ognissanti","12-08":"Immacolata","12-25":"Natale","12-26":"S. Stefano",
};
function getHolidayName(date,holidays){
  const fmt=date.toISOString().split("T")[0];
  if(!holidays.has(fmt)) return null;
  const mmdd=fmt.slice(5);
  if(HOLIDAY_NAMES[mmdd]) return HOLIDAY_NAMES[mmdd];
  // Pasqua o Pasquetta
  const e=easterDate(date.getFullYear());
  const eStr=e.toISOString().split("T")[0];
  if(fmt===eStr) return "Pasqua";
  return "Pasquetta";
}

function isWeekend(date){ const d=date.getDay(); return d===0||d===6; }

/* ── Atoms ── */
const Avt=({initials,color,size=34,ring=false})=>(
  <div style={{width:size,height:size,borderRadius:"50%",background:`${color}18`,
    border:`1.5px solid ${ring?color:color+"44"}`,display:"flex",alignItems:"center",
    justifyContent:"center",fontSize:size*.29,fontWeight:600,color,flexShrink:0,
    boxShadow:ring?`0 0 0 2px #0f1117,0 0 0 4px ${color}44`:"none"}}>
    {initials}
  </div>
);

const Pill=({status,location})=>{
  const s=STATUS[status]||STATUS.assente;
  if(status==="assente") return <span style={{color:"#3a3f55",fontSize:12}}>—</span>;
  return(
    <span style={{display:"inline-flex",alignItems:"center",gap:5,background:s.bg,
      border:`1px solid ${s.color}33`,color:s.color,fontSize:11,fontWeight:500,
      padding:"3px 9px",borderRadius:20,whiteSpace:"nowrap"}}>
      <span style={{width:5,height:5,borderRadius:"50%",background:s.color,flexShrink:0}}/>
      {s.short}{location?` · ${location}`:""}
    </span>
  );
};

const Btn=({children,onClick,variant="ghost",style={}})=>{
  const base={padding:"8px 16px",borderRadius:9,border:"1px solid #2a2f45",background:"transparent",
    color:"#9ca3af",fontSize:13,cursor:"pointer",transition:"all .15s",display:"inline-flex",
    alignItems:"center",gap:7,...style};
  const vars={
    ghost:{},
    primary:{background:"#1e3a5f",borderColor:"#2563eb44",color:"#60a5fa",fontWeight:500},
    danger:{borderColor:"#ef444444",color:"#f87171"},
    warning:{background:"rgba(251,191,36,.08)",borderColor:"#fbbf2444",color:"#fbbf24"},
  };
  return(
    <button onClick={onClick}
      style={{...base,...vars[variant]}}
      onMouseEnter={e=>{e.currentTarget.style.opacity=".8";}}
      onMouseLeave={e=>{e.currentTarget.style.opacity="1";}}>
      {children}
    </button>
  );
};

const Card=({children,style={}})=>(
  <div style={{background:"#161a27",border:"1px solid #1e2235",borderRadius:14,...style}}>
    {children}
  </div>
);

/* ── LOGIN ── */
function Login(){
  const [email,setEmail]=useState("");
  const [pass,setPass]=useState("");
  const [err,setErr]=useState("");
  const [loading,setLoading]=useState(false);

  const submit=async()=>{
    setErr("");setLoading(true);
    const {error}=await supabase.auth.signInWithPassword({email:email.trim(),password:pass});
    if(error){setErr("Credenziali non valide");setLoading(false);}
    // Se ok, l'onAuthStateChange in App carica la sessione e monta l'app
  };

  const inp={width:"100%",background:"#1a1d2b",border:"1px solid #2a2f45",borderRadius:10,
    padding:"11px 14px",color:"#e8eaf0",fontSize:14,outline:"none",transition:"border-color .2s"};

  return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",
      background:"#0d1019",padding:20,position:"relative",overflow:"hidden"}}>
      {/* bg glow */}
      <div style={{position:"absolute",top:"-30%",left:"-20%",width:"60vw",height:"60vw",
        borderRadius:"50%",background:"radial-gradient(circle,#162040 0%,transparent 65%)",pointerEvents:"none"}}/>
      <div style={{position:"absolute",bottom:"-20%",right:"-10%",width:"45vw",height:"45vw",
        borderRadius:"50%",background:"radial-gradient(circle,#151e35 0%,transparent 65%)",pointerEvents:"none"}}/>

      <div className="fade-up" style={{width:"100%",maxWidth:400,position:"relative",zIndex:1}}>
        {/* Logo */}
        <div style={{textAlign:"center",marginBottom:36}}>
          <div style={{display:"inline-flex",alignItems:"center",justifyContent:"center",
            width:54,height:54,background:"#161a27",borderRadius:15,marginBottom:14,
            border:"1px solid #2a3050",boxShadow:"0 0 40px #2563eb22"}}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
          </div>
          <h1 style={{fontSize:22,fontWeight:600,letterSpacing:"-0.5px",color:"#e8eaf0"}}>Calendario Presenze</h1>
          <p style={{fontSize:13,color:"#4a5068",marginTop:5}}>Accedi al tuo account aziendale</p>
        </div>

        <Card style={{padding:"28px 28px"}}>
          <div style={{marginBottom:16}}>
            <label style={{display:"block",fontSize:11,fontWeight:600,color:"#4a5068",
              textTransform:"uppercase",letterSpacing:"0.9px",marginBottom:6}}>Email aziendale</label>
            <input style={inp} type="email" value={email} placeholder="nome@azienda.it"
              onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}
              onFocus={e=>e.target.style.borderColor="#60a5fa"}
              onBlur={e=>e.target.style.borderColor="#2a2f45"}/>
          </div>
          <div style={{marginBottom:20}}>
            <label style={{display:"block",fontSize:11,fontWeight:600,color:"#4a5068",
              textTransform:"uppercase",letterSpacing:"0.9px",marginBottom:6}}>Password</label>
            <input style={inp} type="password" value={pass} placeholder="••••••••"
              onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}
              onFocus={e=>e.target.style.borderColor="#60a5fa"}
              onBlur={e=>e.target.style.borderColor="#2a2f45"}/>
          </div>
          {err&&(
            <div className="fade-in" style={{marginBottom:16,padding:"10px 12px",
              background:"rgba(127,29,29,.2)",border:"1px solid #ef444433",
              borderRadius:8,fontSize:13,color:"#f87171"}}>
              {err}
            </div>
          )}
          <button onClick={submit} disabled={loading}
            style={{width:"100%",padding:"12px",borderRadius:10,border:"none",
              background:loading?"#1e2235":"linear-gradient(135deg,#1d4ed8,#3b82f6)",
              color:"#fff",fontSize:14,fontWeight:600,cursor:loading?"not-allowed":"pointer",
              opacity:loading?.65:1,transition:"opacity .2s"}}>
            {loading?"Accesso…":"Accedi →"}
          </button>
          <div style={{marginTop:16,padding:"12px",background:"#1a1d2b",borderRadius:8,
            fontSize:12,color:"#4a5068",lineHeight:1.6}}>
            Usa le credenziali fornite dal tuo amministratore.
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ── MAIN APP ── */
export default function App(){
  const [users,setUsers]    = useState([]);
  const [groups,setGroups]  = useState([]);
  const [pres,setPres]      = useState({});
  const [session,setSession]= useState(null);
  const [booting,setBooting]= useState(true);
  const [view,setView]      = useState("calendar");
  const [weekDate,setWeek]  = useState(new Date());
  const [modal,setModal]    = useState(null);
  const [notifOpen,setNotif]= useState(false);
  const [toast,setToast]    = useState(null);

  const showToast=(msg,type="info")=>{ setToast({msg,type}); setTimeout(()=>setToast(null),3000); };

  // Carica tutti i dati condivisi da Supabase
  const loadData=async()=>{
    try{
      const [u,g,a]=await Promise.all([fetchProfiles(),fetchGroups(),fetchAttendance()]);
      setUsers(u); setGroups(g); setPres(a);
    }catch(e){
      console.error(e);
      showToast("Errore nel caricamento dati","error");
    }
  };

  // Sessione: controlla all'avvio e resta in ascolto di login/logout
  useEffect(()=>{
    let active=true;
    supabase.auth.getSession().then(async({data})=>{
      if(!active) return;
      const uid=data.session?.user?.id||null;
      if(uid){ await loadData(); setSession({id:uid}); }
      setBooting(false);
    });
    const {data:sub}=supabase.auth.onAuthStateChange(async(_event,sess)=>{
      const uid=sess?.user?.id||null;
      if(uid){ await loadData(); setSession({id:uid}); }
      else{ setSession(null); setUsers([]); setGroups([]); setPres({}); }
    });
    return ()=>{active=false; sub.subscription.unsubscribe();};
  },[]);

  const me = session ? users.find(u=>u.id===session.id) : null;
  const isAdmin = me?.role==="admin";
  const weekDays = getWeekDays(weekDate);
  const holidays = getItalianHolidays(weekDate.getFullYear());

  const isNonWorking=(date)=>isWeekend(date)||holidays.has(fmtDate(date));
  const getSt=(uid,date)=>pres[fmtKey(uid,date)]||(isNonWorking(date)?{status:"assente"}:{status:"presente"});
  const setSt=(uid,date,status,location="")=>{
    const key=fmtKey(uid,date);
    setPres(p=>({...p,[key]:{status,location}}));               // aggiornamento ottimistico
    const dateStr=(date instanceof Date?date.toISOString():date).split("T")[0];
    upsertAttendance(uid,dateStr,status,location).catch(e=>{
      console.error(e); showToast("Errore nel salvataggio","error");
    });
  };

  const isOut=s=>["ferie","trasferta","permesso"].includes(s);

  const getCritical=(gid)=>{
    const gu=users.filter(u=>u.group===gid);
    if(!gu.length) return [];
    return weekDays.filter(day=>!isNonWorking(day)&&gu.every(u=>isOut(getSt(u.id,day).status)));
  };

  const allCritical=groups.flatMap(g=>getCritical(g.id).map(day=>({group:g,day})));

  const sendAlert=(group)=>{
    const days=getCritical(group.id);
    if(!days.length){showToast(`Nessun giorno critico per ${group.name}`,"info");return;}
    const subj=encodeURIComponent(`[Attenzione] ${group.name} — Nessuno in ufficio`);
    const body=encodeURIComponent(`Gentile Responsabile,\n\nSi segnala che per il gruppo "${group.name}" nei seguenti giorni nessun membro risulta in ufficio:\n\n${days.map(d=>`  • ${itLongDay(d)} ${itDate(d)}`).join("\n")}\n\nCordiali saluti,\nSistema Presenze`);
    window.open(`mailto:${group.managerEmail}?subject=${subj}&body=${body}`);
    showToast("Client mail aperto","success");
  };

  if(booting) return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",
      background:"#0d1019",color:"#4a5068",fontSize:14}}>Caricamento…</div>
  );
  if(!session || !me) return <Login/>;

  /* NAV */
  const NAV=[
    {id:"calendar",label:"Calendario",icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>},
    {id:"monthly",label:"Riepilogo mensile",icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="7" y1="15" x2="17" y2="15"/><line x1="7" y1="19" x2="13" y2="19"/></svg>},
    {id:"team",label:"Il mio team",icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>},
    ...(isAdmin?[{id:"admin",label:"Amministrazione",icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>}]:[]),
  ];

  /* SIDEBAR */
  const Sidebar=()=>(
    <div style={{width:220,background:"#0d1019",borderRight:"1px solid #161a27",
      display:"flex",flexDirection:"column",height:"100vh",position:"sticky",top:0,flexShrink:0}}>
      <div style={{padding:"22px 18px 18px",borderBottom:"1px solid #161a27"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:34,height:34,background:"#161a27",borderRadius:9,display:"flex",
            alignItems:"center",justifyContent:"center",border:"1px solid #2a3050"}}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
          </div>
          <div>
            <div style={{fontSize:14,fontWeight:600,letterSpacing:"-0.3px"}}>Presenze</div>
            <div style={{fontSize:10,color:"#4a5068",marginTop:1}}>v2.0</div>
          </div>
        </div>
      </div>

      <nav style={{flex:1,padding:"14px 10px",display:"flex",flexDirection:"column",gap:2}}>
        {NAV.map(item=>{
          const active=view===item.id;
          return(
            <button key={item.id} onClick={()=>setView(item.id)} style={{
              display:"flex",alignItems:"center",gap:9,padding:"9px 12px",borderRadius:9,
              background:active?"#1e2a40":"transparent",border:"none",
              color:active?"#60a5fa":"#6b7280",fontSize:13,fontWeight:active?500:400,
              cursor:"pointer",textAlign:"left",width:"100%",transition:"all .15s",
            }}
              onMouseEnter={e=>{if(!active){e.currentTarget.style.background="#141824";e.currentTarget.style.color="#9ca3af";}}}
              onMouseLeave={e=>{if(!active){e.currentTarget.style.background="transparent";e.currentTarget.style.color="#6b7280";}}}
            >
              <span style={{color:active?"#60a5fa":"#4a5068",flexShrink:0}}>{item.icon}</span>
              {item.label}
              {item.id==="calendar"&&allCritical.length>0&&(
                <span style={{marginLeft:"auto",minWidth:18,height:18,borderRadius:9,
                  background:"#fbbf24",color:"#0f1117",fontSize:10,fontWeight:700,
                  display:"flex",alignItems:"center",justifyContent:"center",padding:"0 5px"}}>
                  {allCritical.length}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div style={{padding:"12px 10px",borderTop:"1px solid #161a27"}}>
        <div style={{display:"flex",alignItems:"center",gap:9,padding:"10px 12px",
          background:"#141824",borderRadius:10,border:"1px solid #1e2235"}}>
          <Avt initials={me.avatar} color={me.color} size={30} ring/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:500,color:"#d1d5db",
              whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{me.name}</div>
            <div style={{fontSize:10,color:"#4a5068"}}>{isAdmin?"Amministratore":"Utente"}</div>
          </div>
          <button onClick={()=>supabase.auth.signOut()} title="Esci"
            style={{background:"none",border:"none",color:"#4a5068",padding:4,cursor:"pointer",borderRadius:6,transition:"color .15s"}}
            onMouseEnter={e=>e.currentTarget.style.color="#ef4444"}
            onMouseLeave={e=>e.currentTarget.style.color="#4a5068"}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );

  /* TOP BAR */
  const TopBar=({title,sub})=>(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
      padding:"18px 26px",borderBottom:"1px solid #161a27",background:"#0f1117",
      position:"sticky",top:0,zIndex:10}}>
      <div>
        <h2 style={{fontSize:17,fontWeight:600,letterSpacing:"-0.3px"}}>{title}</h2>
        {sub&&<p style={{fontSize:12,color:"#4a5068",marginTop:2}}>{sub}</p>}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        {allCritical.length>0&&(
          <button onClick={()=>setNotif(p=>!p)}
            style={{position:"relative",background:"rgba(251,191,36,.08)",border:"1px solid #fbbf2444",
              borderRadius:9,padding:"7px 12px",color:"#fbbf24",display:"flex",alignItems:"center",gap:7,
              fontSize:13,cursor:"pointer"}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/>
            </svg>
            <span style={{fontSize:11,background:"#fbbf24",color:"#0f1117",borderRadius:10,
              padding:"1px 6px",fontWeight:700}}>{allCritical.length}</span>
          </button>
        )}
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 12px",
          background:"#141824",borderRadius:10,border:"1px solid #1e2235"}}>
          <Avt initials={me.avatar} color={me.color} size={26}/>
          <span style={{fontSize:13,fontWeight:500,color:"#d1d5db"}}>{me.name.split(" ")[0]}</span>
        </div>
      </div>
    </div>
  );

  /* CALENDAR VIEW */
  const CalendarView=()=>{
    const todaySt=getSt(me.id,new Date());
    const todayInfo=STATUS[todaySt.status]||STATUS.assente;
    return(
      <div className="fade-up" style={{padding:"22px 26px",flex:1}}>
        {/* Summary bar */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:14,marginBottom:24}}>
          {/* My card */}
          <Card style={{padding:"16px 18px",gridColumn:"span 1",border:`1px solid ${todayInfo.color}33`}}>
            <div style={{fontSize:10,fontWeight:600,color:"#4a5068",textTransform:"uppercase",letterSpacing:"1px",marginBottom:10}}>Il tuo stato oggi</div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <div style={{width:40,height:40,borderRadius:11,background:todayInfo.bg,
                border:`1px solid ${todayInfo.color}44`,display:"flex",alignItems:"center",
                justifyContent:"center",fontSize:18}}>
                {todaySt.status==="presente"?"🏢":todaySt.status==="smartworking"?"💻":todaySt.status==="ferie"?"☀️":todaySt.status==="trasferta"?"✈️":todaySt.status==="permesso"?"⏰":"—"}
              </div>
              <div>
                <div style={{fontSize:14,fontWeight:600,color:todayInfo.color}}>{todayInfo.label}</div>
                {todaySt.location&&<div style={{fontSize:11,color:"#6b7280",marginTop:1}}>{todaySt.location}</div>}
              </div>
            </div>
            <button onClick={()=>setModal({uid:me.id,date:new Date(),cur:todaySt})}
              style={{width:"100%",padding:"7px",background:"transparent",
                border:"1px solid #2a2f45",borderRadius:8,color:"#6b7280",fontSize:12,cursor:"pointer",transition:"all .15s"}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor="#60a5fa";e.currentTarget.style.color="#60a5fa";}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor="#2a2f45";e.currentTarget.style.color="#6b7280";}}>
              Modifica stato
            </button>
          </Card>
          {[
            {label:"In ufficio",  val:users.filter(u=>getSt(u.id,new Date()).status==="presente").length,     color:"#34d399"},
            {label:"In remote",   val:users.filter(u=>getSt(u.id,new Date()).status==="smartworking").length, color:"#60a5fa"},
            {label:"Fuori ufficio",val:users.filter(u=>isOut(getSt(u.id,new Date()).status)).length,          color:"#fbbf24"},
          ].map(s=>(
            <Card key={s.label} style={{padding:"16px 18px"}}>
              <div style={{fontSize:10,fontWeight:600,color:"#4a5068",textTransform:"uppercase",letterSpacing:"1px",marginBottom:8}}>{s.label}</div>
              <div style={{fontSize:30,fontWeight:600,color:s.color,letterSpacing:"-1.5px",lineHeight:1}}>{s.val}</div>
              <div style={{fontSize:11,color:"#3a3f55",marginTop:4}}>su {users.length} persone</div>
            </Card>
          ))}
        </div>

        {/* Week nav */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {[["←","prevWeek"],["Oggi","today"],["→","nextWeek"]].map(([lbl,action])=>(
              <button key={action}
                onClick={()=>{
                  if(action==="today") setWeek(new Date());
                  else if(action==="prevWeek") setWeek(d=>{const n=new Date(d);n.setDate(n.getDate()-7);return n;});
                  else setWeek(d=>{const n=new Date(d);n.setDate(n.getDate()+7);return n;});
                }}
                style={{padding:"7px 13px",background:"#141824",border:"1px solid #1e2235",borderRadius:8,
                  color:"#9ca3af",fontSize:13,cursor:"pointer",transition:"all .15s"}}
                onMouseEnter={e=>e.currentTarget.style.borderColor="#3a3f55"}
                onMouseLeave={e=>e.currentTarget.style.borderColor="#1e2235"}>
                {lbl}
              </button>
            ))}
          </div>
          <span style={{fontSize:13,fontWeight:500,color:"#9ca3af"}}>
            {weekDays[0].toLocaleDateString("it-IT",{day:"numeric",month:"long"})} – {weekDays[6].toLocaleDateString("it-IT",{day:"numeric",month:"long",year:"numeric"})}
          </span>
        </div>

        {/* Table */}
        <Card>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",minWidth:760}}>
              <thead>
                <tr style={{borderBottom:"1px solid #1e2235"}}>
                  <th style={{width:178,padding:"14px 18px",textAlign:"left",fontSize:11,
                    fontWeight:600,color:"#4a5068",textTransform:"uppercase",letterSpacing:"0.8px"}}>Persona</th>
                  {weekDays.map(day=>{
                    const nonWork=isNonWorking(day);
                    const holiday=getHolidayName(day,holidays);
                    const weekend=isWeekend(day);
                    const todayBg=isToday(day)?"rgba(37,99,235,.06)":nonWork?"rgba(255,255,255,.015)":"transparent";
                    return(
                      <th key={day} style={{padding:"10px 4px",textAlign:"center",
                        background:todayBg,minWidth:72,
                        borderLeft:weekend&&day.getDay()===6?"1px solid #1e2235":"none"}}>
                        <div style={{fontSize:10,fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase",
                          color:isToday(day)?"#60a5fa":nonWork?"#3a3f55":"#4a5068"}}>{itShortDay(day)}</div>
                        <div style={{fontSize:16,fontWeight:isToday(day)?700:400,marginTop:3,
                          color:isToday(day)?"#60a5fa":weekend?"#4a5068":nonWork?"#4a5068":"#9ca3af"}}>{day.getDate()}</div>
                        {isToday(day)&&<div style={{width:4,height:4,borderRadius:"50%",background:"#60a5fa",margin:"4px auto 0"}}/>}
                        {holiday&&!isToday(day)&&(
                          <div style={{fontSize:8,color:"#f472b6",marginTop:2,fontWeight:600,
                            textTransform:"uppercase",letterSpacing:"0.3px",lineHeight:1.2,
                            maxWidth:64,margin:"3px auto 0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                            title={holiday}>🎉</div>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {groups.map(group=>{
                  const gUsers=users.filter(u=>u.group===group.id);
                  const crit=getCritical(group.id);
                  return[
                    <tr key={`gh-${group.id}`}>
                      <td colSpan={8} style={{padding:"10px 18px 5px",background:"#0f1219"}}>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          <span style={{fontSize:10,fontWeight:700,color:"#4a5068",
                            textTransform:"uppercase",letterSpacing:"1.2px"}}>{group.name}</span>
                          {crit.length>0&&(
                            <button onClick={()=>sendAlert(group)}
                              style={{display:"flex",alignItems:"center",gap:5,padding:"2px 10px",
                                background:"rgba(251,191,36,.06)",border:"1px solid #fbbf2433",
                                borderRadius:20,color:"#fbbf24",fontSize:10,cursor:"pointer"}}>
                              ⚠ {crit.length} {crit.length>1?"giorni critici":"giorno critico"} — Segnala
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>,
                    ...gUsers.map((user)=>{
                      const isMe=user.id===me.id;
                      return(
                        <tr key={user.id} className="row-hover"
                          style={{borderBottom:"1px solid #13161e",background:isMe?"rgba(37,99,235,.03)":"transparent"}}>
                          <td style={{padding:"9px 18px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:9}}>
                              <Avt initials={user.avatar} color={user.color} size={30} ring={isMe}/>
                              <div>
                                <div style={{fontSize:13,fontWeight:isMe?600:400,
                                  color:isMe?"#e8eaf0":"#9ca3af"}}>{user.name}</div>
                                {isMe&&<div style={{fontSize:10,color:"#4a5068"}}>tu</div>}
                              </div>
                            </div>
                          </td>
                          {weekDays.map(day=>{
                            const nonWork=isNonWorking(day);
                            const holiday=getHolidayName(day,holidays);
                            const weekend=isWeekend(day);
                            const s=getSt(user.id,day);
                            const hasCustom=!!pres[fmtKey(user.id,day)];
                            const info=STATUS[s.status]||STATUS.assente;
                            const canEdit=isMe||isAdmin;
                            // bg for the cell column
                            const colBg=isToday(day)?"rgba(37,99,235,.04)":nonWork?"rgba(255,255,255,.012)":"transparent";
                            const borderL=weekend&&day.getDay()===6?"1px solid #1e2235":"none";
                            return(
                              <td key={day} style={{padding:"4px 3px",textAlign:"center",
                                background:colBg,borderLeft:borderL}}>
                                <div onClick={()=>canEdit&&setModal({uid:user.id,date:day,cur:s})}
                                  title={holiday?`${holiday}${s.status!=="assente"?" · "+info.label:""}`:undefined}
                                  style={{display:"inline-flex",flexDirection:"column",alignItems:"center",
                                    gap:2,padding:"5px 5px",borderRadius:8,minWidth:60,
                                    background:hasCustom&&s.status!=="assente"?info.bg:nonWork&&!hasCustom?"rgba(255,255,255,.02)":"transparent",
                                    border:hasCustom&&s.status!=="assente"?`1px solid ${info.color}22`:nonWork?"1px solid #1e222b":"1px solid transparent",
                                    cursor:canEdit?"pointer":"default",transition:"border-color .15s",
                                    opacity:nonWork&&!hasCustom?.6:1,
                                  }}
                                  onMouseEnter={e=>canEdit&&(e.currentTarget.style.borderColor=hasCustom&&s.status!=="assente"?info.color+"55":"#3a3f55")}
                                  onMouseLeave={e=>(e.currentTarget.style.borderColor=hasCustom&&s.status!=="assente"?info.color+"22":nonWork?"#1e222b":"transparent")}
                                >
                                  {hasCustom&&s.status!=="assente"&&<span style={{width:5,height:5,borderRadius:"50%",background:info.dot}}/>}
                                  <span style={{fontSize:9,fontWeight:500,lineHeight:1.2,
                                    color:hasCustom&&s.status!=="assente"?info.color:nonWork?"#2a2f45":"#34d399"}}>
                                    {hasCustom?( s.status!=="assente"?info.short:"Uff." )
                                      :nonWork?"—":"Uff."}
                                  </span>
                                  {holiday&&!hasCustom&&<span style={{fontSize:8,color:"#f472b6",lineHeight:1}}>🎉</span>}
                                  {hasCustom&&s.location&&<span style={{fontSize:8,color:info.color,opacity:.7,
                                    maxWidth:54,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.location}</span>}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })
                  ];
                })}
              </tbody>
            </table>
          </div>
          <div style={{padding:"11px 18px",borderTop:"1px solid #1a1d2b",display:"flex",flexWrap:"wrap",gap:14,alignItems:"center"}}>
            {Object.entries(STATUS).filter(([k])=>k!=="assente").map(([k,s])=>(
              <div key={k} style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{width:5,height:5,borderRadius:"50%",background:s.dot}}/>
                <span style={{fontSize:11,color:"#4a5068"}}>{s.label}</span>
              </div>
            ))}
            <div style={{display:"flex",alignItems:"center",gap:5,marginLeft:8,paddingLeft:12,borderLeft:"1px solid #1e2235"}}>
              <span style={{fontSize:11,color:"#f472b6"}}>🎉</span>
              <span style={{fontSize:11,color:"#4a5068"}}>Festivo</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{width:12,height:12,borderRadius:3,background:"rgba(255,255,255,.025)",border:"1px solid #1e222b",display:"inline-block"}}/>
              <span style={{fontSize:11,color:"#4a5068"}}>Weekend / Festivo</span>
            </div>
          </div>
        </Card>
      </div>
    );
  };

  /* TEAM VIEW */
  const TeamView=()=>{
    const myGroup=groups.find(g=>g.id===me.group);
    const gUsers=users.filter(u=>u.group===me.group);
    const today=new Date();
    return(
      <div className="fade-up" style={{padding:"22px 26px"}}>
        <Card style={{padding:"16px 20px",marginBottom:20,display:"flex",
          alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{fontSize:10,fontWeight:600,color:"#4a5068",textTransform:"uppercase",letterSpacing:"1px",marginBottom:4}}>
              {myGroup?.name||"Gruppo"}
            </div>
            <div style={{fontSize:13,color:"#6b7280"}}>Responsabile: <span style={{color:"#9ca3af"}}>{myGroup?.managerEmail||"—"}</span></div>
          </div>
          <button onClick={()=>sendAlert(myGroup)}
            style={{display:"flex",alignItems:"center",gap:8,padding:"9px 16px",
              background:"transparent",border:"1px solid #2a2f45",borderRadius:9,
              color:"#9ca3af",fontSize:13,cursor:"pointer",transition:"all .15s"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor="#60a5fa";e.currentTarget.style.color="#60a5fa";}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor="#2a2f45";e.currentTarget.style.color="#9ca3af";}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
            </svg>
            Segnala al responsabile
          </button>
        </Card>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:14}}>
          {gUsers.map(user=>{
            const s=getSt(user.id,today);
            const info=STATUS[s.status]||STATUS.assente;
            const isMe=user.id===me.id;
            return(
              <Card key={user.id} style={{padding:"18px",border:isMe?"1px solid rgba(37,99,235,.3)":"1px solid #1e2235"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
                  <Avt initials={user.avatar} color={user.color} size={40} ring={isMe}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:14,fontWeight:600,color:"#e8eaf0",display:"flex",alignItems:"center",gap:6}}>
                      {user.name}
                      {isMe&&<span style={{fontSize:10,background:"rgba(37,99,235,.2)",color:"#60a5fa",
                        padding:"1px 7px",borderRadius:10}}>tu</span>}
                    </div>
                    <div style={{fontSize:11,color:"#4a5068",marginTop:1,
                      whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{user.email}</div>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:7,padding:"9px 11px",
                  background:s.status!=="assente"?info.bg:"#141824",borderRadius:9,
                  border:`1px solid ${s.status!=="assente"?info.color+"33":"#1e2235"}`}}>
                  <span style={{width:6,height:6,borderRadius:"50%",background:info.dot,flexShrink:0}}/>
                  <span style={{fontSize:13,fontWeight:500,color:s.status!=="assente"?info.color:"#3a3f55"}}>
                    {info.label}
                  </span>
                  {s.location&&<span style={{fontSize:11,color:info.color,opacity:.7}}>· {s.location}</span>}
                </div>
                {isMe&&(
                  <button onClick={()=>setModal({uid:me.id,date:today,cur:s})}
                    style={{marginTop:10,width:"100%",padding:"7px",background:"transparent",
                      border:"1px solid #2a2f45",borderRadius:8,color:"#6b7280",fontSize:12,
                      cursor:"pointer",transition:"all .15s"}}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor="#60a5fa";e.currentTarget.style.color="#60a5fa";}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor="#2a2f45";e.currentTarget.style.color="#6b7280";}}>
                    Modifica stato oggi
                  </button>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    );
  };

  /* ADMIN VIEW */
  const AdminView=()=>{
    const [nu,setNu]=useState({name:"",email:"",password:"1234",group:groups[0]?.id||"",role:"user"});
    const [ng,setNg]=useState({name:"",managerEmail:""});
    const inp={width:"100%",background:"#1a1d2b",border:"1px solid #2a2f45",borderRadius:9,
      padding:"10px 12px",color:"#e8eaf0",fontSize:13,outline:"none",transition:"border-color .2s"};
    const lbl={display:"block",fontSize:10,fontWeight:600,color:"#4a5068",
      textTransform:"uppercase",letterSpacing:"0.9px",marginBottom:5};
    const addUser=async()=>{
      if(!nu.name.trim()||!nu.email.trim()) return;
      try{
        const created=await adminCreateUser({
          name:nu.name, email:nu.email, password:nu.password, group:nu.group, role:nu.role,
        });
        setUsers(p=>[...p,created]);
        setNu({name:"",email:"",password:"1234",group:groups[0]?.id||"",role:"user"});
        showToast("Utente aggiunto","success");
      }catch(e){
        console.error(e);
        showToast(e.message||"Errore nella creazione utente","error");
      }
    };
    const addGroup=async()=>{
      if(!ng.name.trim()||!ng.managerEmail.trim()) return;
      try{
        const created=await createGroup({name:ng.name.trim(),managerEmail:ng.managerEmail.trim()});
        setGroups(p=>[...p,created]);
        setNg({name:"",managerEmail:""});
        showToast("Gruppo creato","success");
      }catch(e){
        console.error(e);
        showToast("Errore nella creazione gruppo","error");
      }
    };
    return(
      <div className="fade-up" style={{padding:"22px 26px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:18,marginBottom:22}}>
          <Card style={{padding:"20px"}}>
            <div style={{fontWeight:600,fontSize:14,color:"#d1d5db",marginBottom:16}}>Nuovo gruppo</div>
            <div style={{display:"flex",flexDirection:"column",gap:11}}>
              <div><label style={lbl}>Nome</label>
                <input style={inp} placeholder="Team Gamma" value={ng.name} onChange={e=>setNg(p=>({...p,name:e.target.value}))}
                  onFocus={e=>e.target.style.borderColor="#60a5fa"} onBlur={e=>e.target.style.borderColor="#2a2f45"}/>
              </div>
              <div><label style={lbl}>Email responsabile</label>
                <input style={inp} placeholder="manager@azienda.it" value={ng.managerEmail} onChange={e=>setNg(p=>({...p,managerEmail:e.target.value}))}
                  onFocus={e=>e.target.style.borderColor="#60a5fa"} onBlur={e=>e.target.style.borderColor="#2a2f45"}/>
              </div>
              <button onClick={addGroup} style={{padding:"10px",background:"rgba(37,99,235,.15)",
                border:"1px solid rgba(37,99,235,.3)",borderRadius:9,color:"#60a5fa",fontSize:13,fontWeight:500,cursor:"pointer"}}>
                + Crea gruppo
              </button>
            </div>
          </Card>
          <Card style={{padding:"20px"}}>
            <div style={{fontWeight:600,fontSize:14,color:"#d1d5db",marginBottom:16}}>Nuovo utente</div>
            <div style={{display:"flex",flexDirection:"column",gap:11}}>
              <div><label style={lbl}>Nome completo</label>
                <input style={inp} placeholder="Nome Cognome" value={nu.name} onChange={e=>setNu(p=>({...p,name:e.target.value}))}
                  onFocus={e=>e.target.style.borderColor="#60a5fa"} onBlur={e=>e.target.style.borderColor="#2a2f45"}/>
              </div>
              <div><label style={lbl}>Email</label>
                <input style={inp} placeholder="nome@azienda.it" value={nu.email} onChange={e=>setNu(p=>({...p,email:e.target.value}))}
                  onFocus={e=>e.target.style.borderColor="#60a5fa"} onBlur={e=>e.target.style.borderColor="#2a2f45"}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div><label style={lbl}>Password</label>
                  <input style={inp} placeholder="••••" value={nu.password} onChange={e=>setNu(p=>({...p,password:e.target.value}))}/>
                </div>
                <div><label style={lbl}>Ruolo</label>
                  <select style={{...inp,cursor:"pointer"}} value={nu.role} onChange={e=>setNu(p=>({...p,role:e.target.value}))}>
                    <option value="user">Utente</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              </div>
              <div><label style={lbl}>Gruppo</label>
                <select style={{...inp,cursor:"pointer"}} value={nu.group} onChange={e=>setNu(p=>({...p,group:e.target.value}))}>
                  {groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
              <button onClick={addUser} style={{padding:"10px",background:"rgba(37,99,235,.15)",
                border:"1px solid rgba(37,99,235,.3)",borderRadius:9,color:"#60a5fa",fontSize:13,fontWeight:500,cursor:"pointer"}}>
                + Aggiungi utente
              </button>
            </div>
          </Card>
        </div>

        {/* Groups */}
        <Card style={{marginBottom:18}}>
          <div style={{padding:"14px 18px",borderBottom:"1px solid #1a1d2b",fontSize:13,fontWeight:600,color:"#d1d5db"}}>
            Gruppi · {groups.length}
          </div>
          {groups.map((g,i)=>{
            const crit=getCritical(g.id);
            return(
              <div key={g.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                padding:"12px 18px",borderBottom:i<groups.length-1?"1px solid #13161e":"none",flexWrap:"wrap",gap:10}}>
                <div>
                  <div style={{fontSize:13,fontWeight:500,color:"#d1d5db"}}>{g.name}</div>
                  <div style={{fontSize:11,color:"#4a5068"}}>{g.managerEmail} · {users.filter(u=>u.group===g.id).length} membri</div>
                </div>
                <div style={{display:"flex",gap:7,alignItems:"center"}}>
                  {crit.length>0&&<span style={{padding:"3px 10px",background:"rgba(251,191,36,.08)",
                    border:"1px solid #fbbf2433",borderRadius:20,color:"#fbbf24",fontSize:11}}>⚠ {crit.length} critici</span>}
                  <button onClick={()=>sendAlert(g)} style={{padding:"6px 12px",background:"transparent",
                    border:"1px solid #2a2f45",borderRadius:8,color:"#6b7280",fontSize:12,cursor:"pointer"}}>
                    ✉ Segnala
                  </button>
                  <button onClick={async()=>{
                      try{ await deleteGroup(g.id); setGroups(p=>p.filter(x=>x.id!==g.id)); }
                      catch(e){ console.error(e); showToast("Errore eliminazione gruppo","error"); }
                    }}
                    style={{padding:"6px 10px",background:"transparent",border:"1px solid #2a2f45",
                      borderRadius:8,color:"#6b7280",fontSize:12,cursor:"pointer"}}>✕</button>
                </div>
              </div>
            );
          })}
        </Card>

        {/* Users */}
        <Card>
          <div style={{padding:"14px 18px",borderBottom:"1px solid #1a1d2b",fontSize:13,fontWeight:600,color:"#d1d5db"}}>
            Utenti · {users.length}
          </div>
          {users.map((u,i)=>{
            const g=groups.find(x=>x.id===u.group);
            const s=getSt(u.id,new Date());
            return(
              <div key={u.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                padding:"11px 18px",borderBottom:i<users.length-1?"1px solid #13161e":"none",gap:12,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <Avt initials={u.avatar} color={u.color} size={32}/>
                  <div>
                    <div style={{fontSize:13,fontWeight:500,color:"#d1d5db",display:"flex",alignItems:"center",gap:6}}>
                      {u.name}
                      {u.role==="admin"&&<span style={{fontSize:10,background:"rgba(37,99,235,.15)",
                        color:"#60a5fa",padding:"1px 6px",borderRadius:8}}>admin</span>}
                    </div>
                    <div style={{fontSize:11,color:"#4a5068"}}>{u.email} · {g?.name||"—"}</div>
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <Pill status={s.status} location={s.location}/>
                  {u.id!==me.id&&(
                    <button onClick={async()=>{
                        try{ await deleteProfile(u.id); setUsers(p=>p.filter(x=>x.id!==u.id)); }
                        catch(e){ console.error(e); showToast("Errore eliminazione utente","error"); }
                      }}
                      style={{padding:"5px 9px",background:"transparent",border:"1px solid #2a2f45",
                        borderRadius:7,color:"#6b7280",fontSize:12,cursor:"pointer"}}>✕</button>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      </div>
    );
  };

  /* STATUS MODAL */
  const StatusModal=()=>{
    if(!modal) return null;
    const [step,setStep]=useState("pick");
    const [pending,setPending]=useState(null);
    const [loc,setLoc]=useState(modal.cur?.location||"");
    // parse existing time range if editing permesso
    const existingNote=modal.cur?.location||"";
    const existMatch=existingNote.match(/(\d{2}:\d{2})\s*[–-]\s*(\d{2}:\d{2})/);
    const [timeFrom,setTimeFrom]=useState(existMatch?existMatch[1]:"09:00");
    const [timeTo,setTimeTo]=useState(existMatch?existMatch[2]:"13:00");
    const [timeErr,setTimeErr]=useState("");
    const user=users.find(u=>u.id===modal.uid);

    const timeInp={
      background:"#1a1d2b",border:"1px solid #2a2f45",borderRadius:10,
      padding:"11px 14px",color:"#e8eaf0",fontSize:16,fontWeight:500,
      outline:"none",width:"100%",textAlign:"center",
      colorScheme:"dark",transition:"border-color .2s",
    };

    const pick=(k)=>{
      if(k==="trasferta"){setPending(k);setStep("location");}
      else if(k==="permesso"){setPending(k);setTimeErr("");setStep("timerange");}
      else{setSt(modal.uid,modal.date,k);setModal(null);}
    };
    const confirmLocation=()=>{setSt(modal.uid,modal.date,pending,loc);setModal(null);};
    const confirmTime=()=>{
      if(!timeFrom||!timeTo){setTimeErr("Inserisci entrambi gli orari");return;}
      if(timeFrom>=timeTo){setTimeErr("L'orario di fine deve essere successivo all'inizio");return;}
      setSt(modal.uid,modal.date,"permesso",`${timeFrom} – ${timeTo}`);
      setModal(null);
    };

    const s_perm=STATUS.permesso;

    return(
      <div className="fade-in" style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",
        display:"flex",alignItems:"center",justifyContent:"center",zIndex:100,backdropFilter:"blur(6px)"}}
        onClick={()=>setModal(null)}>
        <div className="fade-up" style={{background:"#161a27",border:"1px solid #2a2f45",
          borderRadius:18,padding:"22px",width:330,boxSizing:"border-box",boxShadow:"0 24px 80px #00000099"}}
          onClick={e=>e.stopPropagation()}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <Avt initials={user?.avatar} color={user?.color} size={36} ring/>
              <div>
                <div style={{fontSize:14,fontWeight:600}}>{user?.name}</div>
                <div style={{fontSize:11,color:"#4a5068"}}>{itLongDay(modal.date)}, {itDate(modal.date)}</div>
              </div>
            </div>
            <button onClick={()=>setModal(null)}
              style={{background:"none",border:"none",color:"#4a5068",padding:4,cursor:"pointer",fontSize:18,lineHeight:1}}>×</button>
          </div>

          {step==="pick"&&(
            <div style={{display:"flex",flexDirection:"column",gap:7}}>
              {Object.entries(STATUS).filter(([k])=>k!=="assente").map(([k,s])=>{
                const active=modal.cur?.status===k;
                const needsNote=k==="trasferta"||k==="permesso";
                return(
                  <button key={k} onClick={()=>pick(k)} style={{
                    display:"flex",alignItems:"center",gap:11,padding:"11px 14px",borderRadius:10,
                    border:`1px solid ${active?s.color+"55":"#2a2f45"}`,
                    background:active?s.bg:"transparent",
                    color:active?s.color:"#9ca3af",fontSize:13,fontWeight:active?500:400,
                    textAlign:"left",cursor:"pointer",transition:"all .15s",
                  }}
                    onMouseEnter={e=>{if(!active){e.currentTarget.style.borderColor="#3a3f55";e.currentTarget.style.color="#e8eaf0";}}}
                    onMouseLeave={e=>{if(!active){e.currentTarget.style.borderColor="#2a2f45";e.currentTarget.style.color="#9ca3af";}}}
                  >
                    <span style={{width:7,height:7,borderRadius:"50%",background:s.dot,flexShrink:0}}/>
                    <span style={{flex:1}}>{s.label}</span>
                    {active&&<span style={{fontSize:12,color:s.color}}>✓</span>}
                    {needsNote&&!active&&<span style={{fontSize:10,color:"#4a5068",background:"#1a1d2b",
                      padding:"2px 7px",borderRadius:8,border:"1px solid #2a2f45"}}>
                      {k==="trasferta"?"📍 luogo":"🕐 orario"}
                    </span>}
                  </button>
                );
              })}
              {modal.cur?.status!=="assente"&&(
                <button onClick={()=>{setSt(modal.uid,modal.date,"presente");setModal(null);}}
                  style={{marginTop:4,padding:"9px",background:"transparent",border:"1px solid #2a2f45",
                    borderRadius:10,color:"#4a5068",fontSize:13,cursor:"pointer"}}>
                  Ripristina a "In ufficio"
                </button>
              )}
            </div>
          )}

          {step==="location"&&(
            <div>
              <div style={{fontSize:13,color:"#9ca3af",marginBottom:11}}>Inserisci la destinazione della trasferta:</div>
              <input autoFocus value={loc} onChange={e=>setLoc(e.target.value)}
                placeholder="Es. Roma, Monaco, Parigi…"
                onKeyDown={e=>e.key==="Enter"&&confirmLocation()}
                style={{width:"100%",background:"#1a1d2b",border:"1px solid #a78bfa66",
                  borderRadius:10,padding:"11px 14px",color:"#e8eaf0",fontSize:14,
                  outline:"none",marginBottom:12}}/>
              <div style={{display:"flex",gap:9}}>
                <button onClick={()=>setStep("pick")}
                  style={{flex:1,padding:"9px",background:"transparent",border:"1px solid #2a2f45",
                    borderRadius:9,color:"#6b7280",fontSize:13,cursor:"pointer"}}>← Indietro</button>
                <button onClick={confirmLocation}
                  style={{flex:2,padding:"9px",background:"rgba(167,139,250,.15)",
                    border:"1px solid rgba(167,139,250,.3)",borderRadius:9,color:"#a78bfa",
                    fontSize:13,fontWeight:500,cursor:"pointer"}}>Conferma</button>
              </div>
            </div>
          )}

          {step==="timerange"&&(
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16,
                padding:"10px 12px",background:s_perm.bg,borderRadius:10,
                border:`1px solid ${s_perm.color}33`}}>
                <span style={{fontSize:16}}>🕐</span>
                <div>
                  <div style={{fontSize:13,fontWeight:500,color:s_perm.color}}>Orario del permesso</div>
                  <div style={{fontSize:11,color:"#6b7280",marginTop:1}}>Inserisci la fascia oraria</div>
                </div>
              </div>

              <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",alignItems:"center",gap:10,marginBottom:16}}>
                <div>
                  <div style={{fontSize:10,fontWeight:600,color:"#4a5068",textTransform:"uppercase",
                    letterSpacing:"0.9px",marginBottom:6}}>Dalle</div>
                  <input type="time" value={timeFrom} onChange={e=>{setTimeFrom(e.target.value);setTimeErr("");}}
                    style={{...timeInp,border:`1px solid ${timeErr?"#ef444466":"#2a2f45"}`}}
                    onFocus={e=>e.target.style.borderColor="#f472b666"}
                    onBlur={e=>e.target.style.borderColor=timeErr?"#ef444466":"#2a2f45"}/>
                </div>
                <div style={{fontSize:18,color:"#3a3f55",marginTop:20,textAlign:"center"}}>–</div>
                <div>
                  <div style={{fontSize:10,fontWeight:600,color:"#4a5068",textTransform:"uppercase",
                    letterSpacing:"0.9px",marginBottom:6}}>Alle</div>
                  <input type="time" value={timeTo} onChange={e=>{setTimeTo(e.target.value);setTimeErr("");}}
                    style={{...timeInp,border:`1px solid ${timeErr?"#ef444466":"#2a2f45"}`}}
                    onFocus={e=>e.target.style.borderColor="#f472b666"}
                    onBlur={e=>e.target.style.borderColor=timeErr?"#ef444466":"#2a2f45"}/>
                </div>
              </div>

              {/* Quick presets */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:10,fontWeight:600,color:"#4a5068",textTransform:"uppercase",
                  letterSpacing:"0.9px",marginBottom:7}}>Preset rapidi</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {[["Mattina","08:00","13:00"],["Pomeriggio","14:00","18:00"],["Uscita ant.","15:00","18:00"],["Entrata pos.","09:00","10:00"]].map(([label,f,t])=>(
                    <button key={label} onClick={()=>{setTimeFrom(f);setTimeTo(t);setTimeErr("");}}
                      style={{padding:"4px 10px",background:timeFrom===f&&timeTo===t?"rgba(244,114,182,.15)":"#1a1d2b",
                        border:`1px solid ${timeFrom===f&&timeTo===t?"#f472b644":"#2a2f45"}`,
                        borderRadius:8,color:timeFrom===f&&timeTo===t?"#f472b6":"#6b7280",
                        fontSize:11,cursor:"pointer",transition:"all .15s"}}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {timeErr&&(
                <div className="fade-in" style={{marginBottom:12,padding:"8px 11px",
                  background:"rgba(127,29,29,.2)",border:"1px solid #ef444433",
                  borderRadius:8,fontSize:12,color:"#f87171"}}>
                  {timeErr}
                </div>
              )}

              {timeFrom&&timeTo&&timeFrom<timeTo&&(
                <div className="fade-in" style={{marginBottom:12,padding:"8px 12px",
                  background:"rgba(244,114,182,.06)",border:"1px solid #f472b622",
                  borderRadius:8,fontSize:12,color:"#f472b6",display:"flex",alignItems:"center",gap:7}}>
                  <span style={{width:5,height:5,borderRadius:"50%",background:"#f472b6",flexShrink:0}}/>
                  Permesso dalle <strong>{timeFrom}</strong> alle <strong>{timeTo}</strong>
                </div>
              )}

              <div style={{display:"flex",gap:9}}>
                <button onClick={()=>setStep("pick")}
                  style={{flex:1,padding:"9px",background:"transparent",border:"1px solid #2a2f45",
                    borderRadius:9,color:"#6b7280",fontSize:13,cursor:"pointer"}}>← Indietro</button>
                <button onClick={confirmTime}
                  style={{flex:2,padding:"9px",background:"rgba(244,114,182,.15)",
                    border:"1px solid rgba(244,114,182,.3)",borderRadius:9,color:"#f472b6",
                    fontSize:13,fontWeight:500,cursor:"pointer"}}>Conferma permesso</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  /* MONTHLY VIEW */
  const MonthlyView=()=>{
    const now=new Date();
    const [monthDate,setMonthDate]=useState(new Date(now.getFullYear(),now.getMonth(),1));
    const [filterGroup,setFilterGroup]=useState("all");
    const [filterUser,setFilterUser]=useState("all");

    const year=monthDate.getFullYear();
    const month=monthDate.getMonth();
    const monthName=monthDate.toLocaleDateString("it-IT",{month:"long",year:"numeric"}).replace(/^\w/,c=>c.toUpperCase());
    const mHolidays=getItalianHolidays(year);

    // All days in the month (including weekends)
    const monthDays=[];
    const d=new Date(year,month,1);
    while(d.getMonth()===month){
      monthDays.push(new Date(d));
      d.setDate(d.getDate()+1);
    }
    // Only working days for counters
    const workingDays=monthDays.filter(day=>!isWeekend(day)&&!mHolidays.has(fmtDate(day)));

    const filteredUsers=users.filter(u=>{
      if(filterGroup!=="all"&&u.group!==filterGroup) return false;
      if(filterUser!=="all"&&u.id!==filterUser) return false;
      return true;
    });

    // Count statuses per user — only on working days for business stats
    const countFor=(uid,status)=>workingDays.filter(day=>getSt(uid,day).status===status).length;
    const totalFerie=(uid)=>countFor(uid,"ferie");

    // How many weekdays total across all months in the year (for ferie budget display)
    const yearWeekdays=(y)=>{
      let cnt=0;
      const dd=new Date(y,0,1);
      while(dd.getFullYear()===y){const wd=dd.getDay();if(wd!==0&&wd!==6)cnt++;dd.setDate(dd.getDate()+1);}
      return cnt;
    };
    const annualFerie=(uid)=>{
      let cnt=0;
      for(let m=0;m<12;m++){
        const dd=new Date(year,m,1);
        while(dd.getMonth()===m){
          const wd=dd.getDay();
          if(wd!==0&&wd!==6&&getSt(uid,dd).status==="ferie") cnt++;
          dd.setDate(dd.getDate()+1);
        }
      }
      return cnt;
    };

    const cellColor=(status)=>{
      const s=STATUS[status]||STATUS.assente;
      return {bg:s.status!=="assente"?s.bg:"transparent",dot:s.dot,color:s.color,label:s.short};
    };

    const selStyle={background:"#1a1d2b",border:"1px solid #2a2f45",borderRadius:9,
      padding:"7px 12px",color:"#e8eaf0",fontSize:13,outline:"none",cursor:"pointer"};

    const exportExcel=()=>{
      const XLSX=window.XLSX;
      if(!XLSX){showToast("Libreria non ancora caricata, riprova tra un secondo","error");return;}
      try{
        const wb=XLSX.utils.book_new();

        /* ── Sheet 1: Dettaglio giornaliero ── */
        const dayHeaders=["Persona","Gruppo",...monthDays.map(d=>
          `${itShortDay(d)} ${d.getDate()}/${String(d.getMonth()+1).padStart(2,"0")}`
        ),"TOT Ferie","TOT SW","TOT Trasferte","TOT Permessi"];

        const dayRows=filteredUsers.map(u=>{
          const grp=groups.find(g=>g.id===u.group)?.name||"—";
          const cells=monthDays.map(day=>{
            const s=getSt(u.id,day);
            if(s.status==="assente"||s.status==="presente") return STATUS[s.status]?.short||"Ufficio";
            return s.location?`${STATUS[s.status].short} (${s.location})`:STATUS[s.status].short;
          });
          return[
            u.name, grp,
            ...cells,
            countFor(u.id,"ferie"),
            countFor(u.id,"smartworking"),
            countFor(u.id,"trasferta"),
            countFor(u.id,"permesso"),
          ];
        });

        const ws1=XLSX.utils.aoa_to_sheet([dayHeaders,...dayRows]);

        // Column widths
        ws1["!cols"]=[{wch:20},{wch:14},...monthDays.map(()=>({wch:12})),{wch:10},{wch:10},{wch:12},{wch:11}];

        // Style header row (bold via cell metadata — basic approach)
        const range=XLSX.utils.decode_range(ws1["!ref"]);
        for(let c=range.s.c;c<=range.e.c;c++){
          const addr=XLSX.utils.encode_cell({r:0,c});
          if(!ws1[addr]) continue;
          ws1[addr].s={font:{bold:true},fill:{fgColor:{rgb:"1E2235"}},alignment:{horizontal:"center"}};
        }

        XLSX.utils.book_append_sheet(wb,ws1,"Dettaglio "+monthName);

        /* ── Sheet 2: Riepilogo contatori ── */
        const sumHeaders=["Persona","Gruppo","Ferie (mese)","Ferie (anno)","Smart Working","Trasferte","Permessi","Gg Ufficio"];
        const sumRows=filteredUsers.map(u=>{
          const grp=groups.find(g=>g.id===u.group)?.name||"—";
          return[
            u.name,
            grp,
            countFor(u.id,"ferie"),
            annualFerie(u.id),
            countFor(u.id,"smartworking"),
            countFor(u.id,"trasferta"),
            countFor(u.id,"permesso"),
            countFor(u.id,"presente"),
          ];
        });
        // Totals row
        const tot=["TOTALE","—",
          filteredUsers.reduce((a,u)=>a+countFor(u.id,"ferie"),0),
          filteredUsers.reduce((a,u)=>a+annualFerie(u.id),0),
          filteredUsers.reduce((a,u)=>a+countFor(u.id,"smartworking"),0),
          filteredUsers.reduce((a,u)=>a+countFor(u.id,"trasferta"),0),
          filteredUsers.reduce((a,u)=>a+countFor(u.id,"permesso"),0),
          filteredUsers.reduce((a,u)=>a+countFor(u.id,"presente"),0),
        ];

        const ws2=XLSX.utils.aoa_to_sheet([sumHeaders,...sumRows,tot]);
        ws2["!cols"]=[{wch:20},{wch:14},{wch:14},{wch:14},{wch:14},{wch:12},{wch:12},{wch:12}];

        XLSX.utils.book_append_sheet(wb,ws2,"Riepilogo");

        /* ── Sheet 3: Dettaglio permessi con orari ── */
        const permHeaders=["Persona","Gruppo","Data","Giorno","Orario permesso"];
        const permRows=[];
        filteredUsers.forEach(u=>{
          const grp=groups.find(g=>g.id===u.group)?.name||"—";
          monthDays.forEach(day=>{
            const s=getSt(u.id,day);
            if(s.status==="permesso"){
              permRows.push([
                u.name, grp,
                `${day.getDate()}/${String(day.getMonth()+1).padStart(2,"0")}/${day.getFullYear()}`,
                itLongDay(day),
                s.location||"—",
              ]);
            }
          });
        });

        if(permRows.length>0){
          const ws3=XLSX.utils.aoa_to_sheet([permHeaders,...permRows]);
          ws3["!cols"]=[{wch:20},{wch:14},{wch:12},{wch:14},{wch:18}];
          XLSX.utils.book_append_sheet(wb,ws3,"Permessi");
        }

        /* ── Sheet 4: Dettaglio trasferte ── */
        const trHeaders=["Persona","Gruppo","Data","Giorno","Destinazione"];
        const trRows=[];
        filteredUsers.forEach(u=>{
          const grp=groups.find(g=>g.id===u.group)?.name||"—";
          monthDays.forEach(day=>{
            const s=getSt(u.id,day);
            if(s.status==="trasferta"){
              trRows.push([
                u.name, grp,
                `${day.getDate()}/${String(day.getMonth()+1).padStart(2,"0")}/${day.getFullYear()}`,
                itLongDay(day),
                s.location||"—",
              ]);
            }
          });
        });

        if(trRows.length>0){
          const ws4=XLSX.utils.aoa_to_sheet([trHeaders,...trRows]);
          ws4["!cols"]=[{wch:20},{wch:14},{wch:12},{wch:14},{wch:22}];
          XLSX.utils.book_append_sheet(wb,ws4,"Trasferte");
        }

        const filename=`Presenze_${monthName.replace(/\s/g,"_")}_${filterGroup!=="all"?groups.find(g=>g.id===filterGroup)?.name+"_":""}.xlsx`;
        XLSX.writeFile(wb,filename);
        showToast("Excel esportato con successo","success");
      }catch(e){
        console.error(e);
        showToast("Errore durante l'esportazione","error");
      }
    };

    return(
      <div className="fade-up" style={{padding:"22px 26px"}}>
        {/* Controls */}
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:22,flexWrap:"wrap"}}>
          <button onClick={()=>setMonthDate(d=>{const n=new Date(d);n.setMonth(n.getMonth()-1);return n;})}
            style={{padding:"7px 13px",background:"#141824",border:"1px solid #1e2235",borderRadius:8,color:"#9ca3af",fontSize:13,cursor:"pointer"}}
            onMouseEnter={e=>e.currentTarget.style.borderColor="#3a3f55"}
            onMouseLeave={e=>e.currentTarget.style.borderColor="#1e2235"}>←</button>
          <span style={{fontSize:15,fontWeight:600,color:"#d1d5db",minWidth:180,textAlign:"center"}}>{monthName}</span>
          <button onClick={()=>setMonthDate(d=>{const n=new Date(d);n.setMonth(n.getMonth()+1);return n;})}
            style={{padding:"7px 13px",background:"#141824",border:"1px solid #1e2235",borderRadius:8,color:"#9ca3af",fontSize:13,cursor:"pointer"}}
            onMouseEnter={e=>e.currentTarget.style.borderColor="#3a3f55"}
            onMouseLeave={e=>e.currentTarget.style.borderColor="#1e2235"}>→</button>
          <button onClick={()=>setMonthDate(new Date(now.getFullYear(),now.getMonth(),1))}
            style={{padding:"7px 13px",background:"#141824",border:"1px solid #1e2235",borderRadius:8,color:"#9ca3af",fontSize:13,cursor:"pointer"}}>Oggi</button>
          <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <select style={selStyle} value={filterGroup} onChange={e=>{setFilterGroup(e.target.value);setFilterUser("all");}}>
              <option value="all">Tutti i gruppi</option>
              {groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <select style={selStyle} value={filterUser} onChange={e=>setFilterUser(e.target.value)}>
              <option value="all">Tutte le persone</option>
              {(filterGroup==="all"?users:users.filter(u=>u.group===filterGroup)).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button onClick={exportExcel}
              style={{display:"flex",alignItems:"center",gap:7,padding:"7px 14px",
                background:"rgba(52,211,153,.08)",border:"1px solid rgba(52,211,153,.3)",
                borderRadius:9,color:"#34d399",fontSize:13,fontWeight:500,cursor:"pointer",
                transition:"all .15s",whiteSpace:"nowrap"}}
              onMouseEnter={e=>{e.currentTarget.style.background="rgba(52,211,153,.15)";}}
              onMouseLeave={e=>{e.currentTarget.style.background="rgba(52,211,153,.08)";}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Esporta Excel
            </button>
          </div>
        </div>

        {/* Ferie counter cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12,marginBottom:22}}>
          {filteredUsers.map(u=>{
            const mFerie=totalFerie(u.id);
            const yFerie=annualFerie(u.id);
            const mPerm=countFor(u.id,"permesso");
            const mTrasf=countFor(u.id,"trasferta");
            return(
              <Card key={u.id} style={{padding:"14px 16px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                  <Avt initials={u.avatar} color={u.color} size={28}/>
                  <div style={{fontSize:12,fontWeight:600,color:"#d1d5db",flex:1,minWidth:0,
                    whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{u.name}</div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  <div style={{background:"rgba(251,191,36,.07)",border:"1px solid rgba(251,191,36,.2)",
                    borderRadius:9,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontSize:20,fontWeight:700,color:"#fbbf24",lineHeight:1}}>{mFerie}</div>
                    <div style={{fontSize:10,color:"#92614a",marginTop:3}}>Ferie mese</div>
                  </div>
                  <div style={{background:"rgba(251,191,36,.04)",border:"1px solid rgba(251,191,36,.12)",
                    borderRadius:9,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontSize:20,fontWeight:700,color:"#d99a1a",lineHeight:1}}>{yFerie}</div>
                    <div style={{fontSize:10,color:"#6b5a3a",marginTop:3}}>Ferie anno</div>
                  </div>
                  <div style={{background:"rgba(244,114,182,.06)",border:"1px solid rgba(244,114,182,.15)",
                    borderRadius:9,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontSize:20,fontWeight:700,color:"#f472b6",lineHeight:1}}>{mPerm}</div>
                    <div style={{fontSize:10,color:"#7a4060",marginTop:3}}>Permessi</div>
                  </div>
                  <div style={{background:"rgba(167,139,250,.06)",border:"1px solid rgba(167,139,250,.15)",
                    borderRadius:9,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontSize:20,fontWeight:700,color:"#a78bfa",lineHeight:1}}>{mTrasf}</div>
                    <div style={{fontSize:10,color:"#5a4a80",marginTop:3}}>Trasferte</div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>

        {/* Monthly grid table */}
        <Card>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",minWidth:Math.max(500,monthDays.length*30+200)}}>
              <thead>
                <tr style={{borderBottom:"1px solid #1e2235"}}>
                  <th style={{width:170,padding:"12px 16px",textAlign:"left",fontSize:11,
                    fontWeight:600,color:"#4a5068",textTransform:"uppercase",letterSpacing:"0.8px",
                    position:"sticky",left:0,background:"#161a27",zIndex:2}}>
                    Persona
                  </th>
                  {monthDays.map(day=>{
                    const nonWork=isWeekend(day)||mHolidays.has(fmtDate(day));
                    const hName=getHolidayName(day,mHolidays);
                    const weekend=isWeekend(day);
                    return(
                      <th key={day} title={hName||undefined}
                        style={{padding:"6px 1px",textAlign:"center",minWidth:28,
                          background:isToday(day)?"rgba(37,99,235,.08)":nonWork?"rgba(255,255,255,.015)":"transparent",
                          borderLeft:weekend&&day.getDay()===6?"1px solid #1e2235":"none"}}>
                        <div style={{fontSize:8,fontWeight:600,letterSpacing:"0.4px",textTransform:"uppercase",
                          color:isToday(day)?"#60a5fa":nonWork?"#2e3350":"#3a3f55"}}>
                          {itShortDay(day).slice(0,1)}
                        </div>
                        <div style={{fontSize:11,fontWeight:isToday(day)?700:400,marginTop:1,
                          color:isToday(day)?"#60a5fa":nonWork?"#3a3f55":"#6b7280"}}>{day.getDate()}</div>
                        {hName&&<div style={{fontSize:7,marginTop:1}}>🎉</div>}
                      </th>
                    );
                  })}
                  <th style={{padding:"12px 10px",textAlign:"center",fontSize:11,fontWeight:600,
                    color:"#4a5068",textTransform:"uppercase",letterSpacing:"0.8px",
                    whiteSpace:"nowrap",minWidth:90}}>
                    Ferie mese
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((user)=>{
                  const isMe=user.id===me.id;
                  const mFerie=totalFerie(user.id);
                  return(
                    <tr key={user.id} className="row-hover"
                      style={{borderBottom:"1px solid #13161e",background:isMe?"rgba(37,99,235,.02)":"transparent"}}>
                      <td style={{padding:"8px 16px",position:"sticky",left:0,
                        background:isMe?"#12172b":"#161a27",zIndex:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <Avt initials={user.avatar} color={user.color} size={26} ring={isMe}/>
                          <div style={{fontSize:12,fontWeight:isMe?600:400,
                            color:isMe?"#e8eaf0":"#9ca3af",whiteSpace:"nowrap",
                            overflow:"hidden",textOverflow:"ellipsis",maxWidth:100}}>{user.name}</div>
                        </div>
                      </td>
                      {monthDays.map(day=>{
                        const nonWork=isWeekend(day)||mHolidays.has(fmtDate(day));
                        const hName=getHolidayName(day,mHolidays);
                        const weekend=isWeekend(day);
                        const s=getSt(user.id,day);
                        const hasCustom=!!pres[fmtKey(user.id,day)];
                        const info=STATUS[s.status]||STATUS.assente;
                        const colBg=isToday(day)?"rgba(37,99,235,.05)":nonWork?"rgba(255,255,255,.01)":"transparent";
                        return(
                          <td key={day} style={{padding:"2px 1px",textAlign:"center",
                            background:colBg,borderLeft:weekend&&day.getDay()===6?"1px solid #1e2235":"none"}}>
                            {hasCustom&&s.status!=="assente"?(
                              <div title={`${info.label}${s.location?" · "+s.location:""}`}
                                onClick={()=>(isMe||isAdmin)&&setModal({uid:user.id,date:day,cur:s})}
                                style={{width:26,height:26,borderRadius:6,background:info.bg,
                                  border:`1px solid ${info.color}44`,display:"inline-flex",
                                  alignItems:"center",justifyContent:"center",
                                  cursor:(isMe||isAdmin)?"pointer":"default"}}>
                                <span style={{width:6,height:6,borderRadius:"50%",background:info.dot}}/>
                              </div>
                            ):nonWork?(
                              <div title={hName||undefined}
                                style={{width:26,height:26,display:"inline-flex",borderRadius:6,
                                  alignItems:"center",justifyContent:"center",
                                  background:hName?"rgba(244,114,182,.06)":"transparent",
                                  border:hName?"1px solid rgba(244,114,182,.15)":"none"}}>
                                <span style={{fontSize:hName?8:9,color:hName?"#f472b6":"#2a2f45"}}>{hName?"🎉":"·"}</span>
                              </div>
                            ):(
                              <div title="Presente (default)"
                                onClick={()=>(isMe||isAdmin)&&setModal({uid:user.id,date:day,cur:s})}
                                style={{width:26,height:26,display:"inline-flex",borderRadius:6,
                                  alignItems:"center",justifyContent:"center",
                                  cursor:(isMe||isAdmin)?"pointer":"default"}}>
                                <span style={{width:4,height:4,borderRadius:"50%",background:"#34d39944"}}/>
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td style={{padding:"8px 10px",textAlign:"center"}}>
                        {mFerie>0?(
                          <span style={{display:"inline-flex",alignItems:"center",gap:5,
                            background:"rgba(251,191,36,.1)",border:"1px solid rgba(251,191,36,.25)",
                            color:"#fbbf24",fontSize:12,fontWeight:700,padding:"3px 10px",borderRadius:20}}>
                            ☀ {mFerie}g
                          </span>
                        ):(
                          <span style={{fontSize:12,color:"#2a2f45"}}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Legend */}
          <div style={{padding:"10px 16px",borderTop:"1px solid #1a1d2b",display:"flex",flexWrap:"wrap",gap:14,alignItems:"center"}}>
            {Object.entries(STATUS).filter(([k])=>k!=="assente").map(([k,s])=>(
              <div key={k} style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{width:5,height:5,borderRadius:"50%",background:s.dot}}/>
                <span style={{fontSize:11,color:"#4a5068"}}>{s.label}</span>
              </div>
            ))}
            <span style={{fontSize:11,color:"#3a3f55",marginLeft:"auto"}}>Passa il mouse sulle celle per vedere i dettagli</span>
          </div>
        </Card>
      </div>
    );
  };

  /* NOTIF PANEL */
  const NotifPanel=()=>(
    <div className="fade-in" style={{position:"fixed",inset:0,zIndex:50}} onClick={()=>setNotif(false)}>
      <div className="fade-up" style={{position:"absolute",top:68,right:22,width:310,
        background:"#161a27",border:"1px solid #2a2f45",borderRadius:14,
        padding:"16px 18px",boxShadow:"0 20px 60px #00000099"}}
        onClick={e=>e.stopPropagation()}>
        <div style={{fontWeight:600,fontSize:13,color:"#d1d5db",marginBottom:12,display:"flex",alignItems:"center",gap:7}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Criticità settimana
        </div>
        {allCritical.length===0
          ? <div style={{fontSize:13,color:"#4a5068",padding:"8px 0"}}>Nessuna criticità</div>
          : allCritical.map(({group,day},i)=>(
            <div key={i} style={{padding:"10px 12px",background:"rgba(251,191,36,.05)",
              border:"1px solid #fbbf2422",borderRadius:10,marginBottom:8}}>
              <div style={{fontSize:13,fontWeight:600,color:"#fbbf24"}}>{group.name}</div>
              <div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>{itLongDay(day)} {itDate(day)}</div>
              <button onClick={()=>{sendAlert(group);setNotif(false);}}
                style={{marginTop:8,width:"100%",padding:"6px",background:"transparent",
                  border:"1px solid #fbbf2444",borderRadius:7,color:"#fbbf24",fontSize:12,cursor:"pointer"}}>
                ✉ Segnala responsabile
              </button>
            </div>
          ))
        }
      </div>
    </div>
  );

  /* TOAST */
  const Toast=()=>{
    if(!toast) return null;
    const c=toast.type==="success"?"#34d399":toast.type==="error"?"#f87171":"#60a5fa";
    return(
      <div className="fade-up" style={{position:"fixed",bottom:24,right:24,zIndex:200,
        background:"#161a27",border:`1px solid ${c}44`,borderRadius:12,
        padding:"12px 18px",fontSize:13,color:c,
        boxShadow:"0 8px 30px #00000088",display:"flex",alignItems:"center",gap:9}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:c,flexShrink:0}}/>
        {toast.msg}
      </div>
    );
  };

  const myGroup=groups.find(g=>g.id===me.group);
  return(
    <div style={{display:"flex",minHeight:"100vh",background:"#0f1117"}}>
      <Sidebar/>
      <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,overflowX:"hidden"}}>
        <TopBar
          title={view==="calendar"?"Calendario Presenze":view==="monthly"?"Riepilogo Mensile":view==="team"?"Il Mio Team":"Amministrazione"}
          sub={view==="calendar"
            ?`${weekDays[0].toLocaleDateString("it-IT",{day:"numeric",month:"long"})} – ${weekDays[6].toLocaleDateString("it-IT",{day:"numeric",month:"long",year:"numeric"})}`
            :view==="team"?myGroup?.name
            :view==="monthly"?"Presenze, assenze e contatori ferie per persona"
            :undefined}
        />
        <div style={{flex:1,overflowY:"auto"}}>
          {view==="calendar"&&<CalendarView/>}
          {view==="monthly"&&<MonthlyView/>}
          {view==="team"&&<TeamView/>}
          {view==="admin"&&isAdmin&&<AdminView/>}
        </div>
      </div>
      <StatusModal/>
      {notifOpen&&<NotifPanel/>}
      <Toast/>
    </div>
  );
}
