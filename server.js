// Life Saver server: no installs needed, only Node.js 18+.
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=process.env.PORT||3000, DATA=process.env.DATA_FILE||path.join(__dirname,'data.json');
let db={users:{},sessions:{},requests:[],reports:[],codes:null};
try{db=Object.assign(db,JSON.parse(fs.readFileSync(DATA,'utf8')))}catch{}
const rnd=()=>crypto.randomBytes(3).toString('hex').toUpperCase();
if(!db.codes)db.codes={nurse:'NURSE-'+rnd(),hospital:'HOSP-'+rnd(),police:'POLICE-'+rnd()};
const CODES={nurse:process.env.NURSE_CODE||db.codes.nurse,hospital:process.env.HOSPITAL_CODE||db.codes.hospital,police:process.env.POLICE_CODE||db.codes.police};
let saveT;const save=()=>{clearTimeout(saveT);saveT=setTimeout(()=>fs.writeFile(DATA,JSON.stringify(db),()=>{}),300)};
const live={}; // userId -> {lat,lon,t,duty}
const ALERT_M=500, FRESH_MS=60000;
const dist=(a,b,c,d)=>{const k=Math.PI/180,x=(d-b)*k*Math.cos((a+c)/2*k),y=(c-a)*k;return Math.round(6371000*Math.sqrt(x*x+y*y))};
const send=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj))};
const fail=(res,code,msg)=>send(res,code,{error:msg});
const readBody=req=>new Promise((ok,no)=>{let s='';req.on('data',c=>{s+=c;if(s.length>1e5){req.destroy();no()}});req.on('end',()=>{try{ok(JSON.parse(s||'{}'))}catch{ok({})}})});
const hash=(pin,salt)=>crypto.scryptSync(pin,salt,32).toString('hex');
const userOf=req=>{const t=(req.headers.authorization||'').replace('Bearer ','');const id=db.sessions[t];return id&&db.users[id]?db.users[id]:null};
const pub=u=>({id:u.id,role:u.role,name:u.name,org:u.org});
const str=(v,n)=>String(v==null?'':v).trim().slice(0,n);
const num=v=>(typeof v==='number'&&isFinite(v))?v:null;
const tries={};
const onlineAmbs=()=>Object.values(db.users).filter(u=>u.role==='nurse'&&live[u.id]&&live[u.id].duty&&Date.now()-live[u.id].t<FRESH_MS);
const ambInfo=u=>({id:u.id,name:u.name,org:u.org,lat:live[u.id].lat,lon:live[u.id].lon});

const routes={
'POST /api/register':async(req,res)=>{const b=await readBody(req);const role=b.role;
 if(!CODES[role])return fail(res,400,'Choose a valid role.');
 if(str(b.code,40)!==CODES[role])return fail(res,403,'Wrong invite code. Ask your '+role+' organisation for it.');
 const id=str(b.userId,20).toUpperCase();if(!/^[A-Z0-9_-]{3,20}$/.test(id))return fail(res,400,'User ID: 3-20 letters/numbers.');
 if(db.users[id])return fail(res,409,'That User ID is taken.');
 const pin=str(b.pin,8);if(!/^\d{4,8}$/.test(pin))return fail(res,400,'PIN must be 4-8 digits.');
 const name=str(b.name,60),org=str(b.org,60);if(!name||!org)return fail(res,400,'Enter name and organisation.');
 const salt=crypto.randomBytes(8).toString('hex');db.users[id]={id,role,name,org,salt,hash:hash(pin,salt),created:Date.now()};save();send(res,200,{ok:true})},
'POST /api/login':async(req,res)=>{const ip=req.socket.remoteAddress,now=Date.now();const t=tries[ip]=tries[ip]&&now-tries[ip].t<3e5?tries[ip]:{n:0,t:now};
 if(t.n>=10)return fail(res,429,'Too many tries. Wait 5 minutes.');
 const b=await readBody(req);const u=db.users[str(b.userId,20).toUpperCase()];
 if(!u||hash(str(b.pin,8),u.salt)!==u.hash){t.n++;return fail(res,401,'Wrong User ID or PIN.')}
 const tok=crypto.randomBytes(24).toString('hex');db.sessions[tok]=u.id;save();send(res,200,{token:tok,user:pub(u)})},
'POST /api/logout':async(req,res)=>{const t=(req.headers.authorization||'').replace('Bearer ','');const u=userOf(req);delete db.sessions[t];if(u)delete live[u.id];save();send(res,200,{ok:true})},
'POST /api/location':async(req,res)=>{const u=userOf(req);if(!u)return fail(res,401,'Login required.');const b=await readBody(req);
 const lat=num(b.lat),lon=num(b.lon);if(lat===null||lon===null||Math.abs(lat)>90||Math.abs(lon)>180)return fail(res,400,'Bad location.');
 const prev=live[u.id]||{};live[u.id]={lat,lon,t:Date.now(),duty:u.role==='nurse'?(b.duty===undefined?!!prev.duty:!!b.duty):false};send(res,200,{ok:true})},
'POST /api/duty':async(req,res)=>{const u=userOf(req);if(!u||u.role!=='nurse')return fail(res,403,'Ambulance nurse only.');const b=await readBody(req);
 if(b.duty&&!live[u.id])return fail(res,400,'Turn on GPS first.');if(live[u.id])live[u.id].duty=!!b.duty;send(res,200,{ok:true})},
'POST /api/ambulance/call':async(req,res)=>{const b=await readBody(req);const lat=num(b.lat),lon=num(b.lon);
 if(lat===null||lon===null)return fail(res,400,'Your location is needed.');const phone=str(b.phone,20);if(!/^[0-9+ -]{6,20}$/.test(phone))return fail(res,400,'Enter a valid phone number.');
 const busy=new Set(db.requests.filter(r=>['assigned','accepted'].includes(r.status)).map(r=>r.ambId));
 const c=onlineAmbs().map(a=>({a,d:dist(lat,lon,live[a.id].lat,live[a.id].lon),busy:busy.has(a.id)})).sort((x,y)=>(x.busy-y.busy)||(x.d-y.d))[0];
 const r={id:crypto.randomBytes(6).toString('hex'),name:str(b.name,60)||'Caller',phone,note:str(b.note,200),lat,lon,ambId:c?c.a.id:null,status:c?'assigned':'none',created:Date.now()};
 db.requests.push(r);db.requests=db.requests.slice(-500);save();send(res,200,{id:r.id,status:r.status})},
'GET /api/ambulance/status':async(req,res,q)=>{const r=db.requests.find(x=>x.id===q.get('id'));if(!r)return fail(res,404,'Request not found.');
 let amb=null,d=null,eta=null;if(r.ambId&&live[r.ambId]){amb=ambInfo(db.users[r.ambId]);d=dist(r.lat,r.lon,amb.lat,amb.lon);eta=Math.max(1,Math.round(d/500))} // ~30 km/h
 send(res,200,{status:r.status,ambulance:amb,distance:d,etaMin:eta})},
'GET /api/ambulance/requests':async(req,res)=>{const u=userOf(req);if(!u||u.role!=='nurse')return fail(res,403,'Ambulance nurse only.');
 send(res,200,{requests:db.requests.filter(r=>r.ambId===u.id&&['assigned','accepted'].includes(r.status)).map(r=>({id:r.id,name:r.name,phone:r.phone,note:r.note,lat:r.lat,lon:r.lon,status:r.status}))})},
'POST /api/ambulance/update':async(req,res)=>{const u=userOf(req);if(!u||u.role!=='nurse')return fail(res,403,'Ambulance nurse only.');const b=await readBody(req);
 const r=db.requests.find(x=>x.id===b.id&&x.ambId===u.id);if(!r)return fail(res,404,'Not found.');
 if(b.action==='accept')r.status='accepted';else if(b.action==='complete')r.status='done';else return fail(res,400,'Bad action.');save();send(res,200,{ok:true})},
'GET /api/hospitals':async(req,res)=>{const u=userOf(req);if(!u)return fail(res,401,'Login required.');send(res,200,{hospitals:Object.values(db.users).filter(x=>x.role==='hospital').map(x=>({id:x.id,name:x.org}))})},
'POST /api/condition':async(req,res)=>{const u=userOf(req);if(!u||u.role!=='nurse')return fail(res,403,'Only the ambulance nurse can upload.');const b=await readBody(req);
 const h=db.users[str(b.hospitalId,20)];if(!h||h.role!=='hospital')return fail(res,400,'Choose a hospital.');
 const r={id:crypto.randomBytes(5).toString('hex'),hospitalId:h.id,nurseId:u.id,by:u.name+' ('+u.org+')',t:Date.now(),patient:str(b.patient,60),age:str(b.age,3),hr:str(b.hr,4),bp:str(b.bp,10),spo2:str(b.spo2,3),cs:str(b.cs,30),notes:str(b.notes,500)};
 if(!r.patient||!r.notes)return fail(res,400,'Enter patient name and injury/illness.');db.reports.push(r);db.reports=db.reports.slice(-1000);save();send(res,200,{ok:true})},
'GET /api/condition':async(req,res)=>{const u=userOf(req);if(!u||!['nurse','hospital'].includes(u.role))return fail(res,403,'Not allowed.');
 const day=Date.now()-864e5;send(res,200,{reports:db.reports.filter(r=>r.t>day&&(u.role==='hospital'?r.hospitalId===u.id:r.nurseId===u.id)).sort((a,b)=>b.t-a.t).slice(0,50)})},
'GET /api/police/feed':async(req,res)=>{const u=userOf(req);if(!u||u.role!=='police')return fail(res,403,'Registered police officers only.');
 const me=live[u.id]&&Date.now()-live[u.id].t<FRESH_MS?live[u.id]:null;
 const list=onlineAmbs().map(a=>{const l=live[a.id];const d=me?dist(me.lat,me.lon,l.lat,l.lon):null;return{id:a.id,name:a.name,org:a.org,lat:l.lat,lon:l.lon,distance:d,alert:d!==null&&d<=ALERT_M}}).sort((x,y)=>(x.distance??1e9)-(y.distance??1e9));
 send(res,200,{me:!!me,alertMeters:ALERT_M,ambulances:list})}
};
const STATIC=new Set(['index.html','manifest.json','sw.js','icon-192.png','icon-512.png','apple-touch-icon.png','favicon.png']);
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png','.css':'text/css'};
http.createServer(async(req,res)=>{
 try{const url=new URL(req.url,'http://x');const key=req.method+' '+url.pathname;
  if(routes[key])return await routes[key](req,res,url.searchParams);
  if(url.pathname.startsWith('/api/'))return fail(res,404,'Unknown request.');
  const name=path.basename(decodeURIComponent(url.pathname))||'index.html';if(!STATIC.has(name))return fail(res,404,'Not found.');const f=path.join(__dirname,name);
  fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end('Not found')}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(d)});
 }catch(e){fail(res,500,'Server error.')}
}).listen(PORT,()=>{console.log('\nLife Saver server running on port '+PORT);console.log('INVITE CODES (give to registered staff only):');console.log('  Ambulance nurse :',CODES.nurse);console.log('  Hospital        :',CODES.hospital);console.log('  Police          :',CODES.police,'\n')});
