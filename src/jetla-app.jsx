import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";

// Leaflet'in varsayılan pin ikonu Vite ile bozuk yüklenebiliyor, manuel düzeltiyoruz
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// Renkli pin ikonu üretir (durum bazlı renklendirme için)
function coloredIcon(color){
  return new L.DivIcon({
    html: `<div style="background:${color};width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2.5px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,.35);"></div>`,
    className: "",
    iconSize: [26,26],
    iconAnchor: [13,26],
    popupAnchor: [0,-26],
  });
}

// Adresten enlem/boylam bulur (OpenStreetMap Nominatim, ücretsiz, API key gerekmez).
// Antalya odaklı arama yapar ki "Kadıköy" gibi genel isimler yanlış şehre gitmesin.
async function geocodeAddress(address){
  if(!address) return null;
  try{
    const q = encodeURIComponent(address+", Antalya, Türkiye");
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`);
    const data = await res.json();
    if(data && data[0]) return {lat:+data[0].lat, lng:+data[0].lon};
  }catch(e){ console.error("Geocoding hatası:",e); }
  return null;
}

const supabase = createClient(
  "https://ofswgysmjvzmubjselod.supabase.co",
  "sb_publishable_q-wiWoqRkVYpJDGRuMBAdA_UQnJ26dU"
);

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#f2f2f7;font-family:'Inter',sans-serif;color:#1c1c1e;}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes notifIn{from{opacity:0;transform:translateX(110%)}to{opacity:1;transform:none}}
::-webkit-scrollbar{width:0;height:0;}
`;

const BOLGE = ["Hepsi","Merkez","Sanayi","Kuzey","Güney"];
const FILTER_OPTIONS = ["Geç Kalan","Hepsi","Oluşturuldu","Onaylandı","Manuel Atama Bekliyor","Otomatik Atama Bekliyor","Atama Onayı Bekliyor","Atandı","Teslimat Aşamasında","Teslim Edildi","İade","İptal","Vaat Paket"];
const PAY_COLORS = {"Nakit":"#e53935","Kredi Kartı":"#4caf50","Metropol":"#8e24aa","Sodexo":"#fb8c00","Multinet":"#00acc1","Online":"#1e88e5","Diğer":"#6d4c41","Yemek Kartı":"#f9a825","Edenred":"#d81b60","Belirtilmedi":"#8e8e93"};
// Kapıda: kurye teslimat anında tahsil eder. Ön Ödeme: sipariş öncesi online/dijital tahsil edilir.
const PAY_GROUPS = {
  "Kapıda":    ["Nakit","Kredi Kartı","Metropol","Sodexo","Multinet"],
  "Ön Ödeme":  ["Online","Diğer","Sodexo","Multinet","Yemek Kartı","Edenred"],
};
const PAY_TYPES_FLAT = [...new Set([...PAY_GROUPS["Kapıda"], ...PAY_GROUPS["Ön Ödeme"]])];
const STATUS_COLORS = {"Oluşturuldu":"#1e88e5","Onaylandı":"#fb8c00","Manuel Atama Bekliyor":"#f9a825","Otomatik Atama Bekliyor":"#fb8c00","Atama Onayı Bekliyor":"#8e24aa","Atandı":"#f9a825","Teslimat Aşamasında":"#1e88e5","Teslim Edildi":"#4caf50","İade":"#ff7043","İptal":"#9e9e9e","Geç Kalan":"#e53935"};

function genId(){ return Math.random().toString(36).slice(2,7).toUpperCase(); }

// Bir kuryenin üzerindeki aktif (henüz teslim edilmemiş) paket sayısını hesaplar
function activeLoadOf(courierId, packages){
  return packages.filter(p=>p.courierId===courierId && p.status!=="Teslim Edildi" && p.status!=="İptal").length;
}

// Bir kuryenin maksimum paket limitini döner: kurye özel limiti varsa o, yoksa genel ayar
function maxPkgsOf(courierId, settings){
  const special = settings.courierMaxPkgs?.[courierId];
  return special!=null ? special : (settings.maxPkgs||10);
}

// Öncelikli kurye + limit kontrolü + en az yüklü kurye mantığıyla en uygun kuryeyi seçer.
// restId verilirse önce o işletmenin öncelikli kuryesine bakar (limiti doluysa atlar).
// Genel atama modu "manual" ise hiç otomatik seçim yapmaz (null döner, admin manuel atar).
// Hiç uygun kurye yoksa null döner (limit dolu demektir).
function pickCourierForAssignment(db, restId){
  const s = db.settings||{};
  if(s.assignMode==="manual") return null;
  const active = db.couriers.filter(c=>c.status==="active");
  const withRoom = active.filter(c=>activeLoadOf(c.id,db.packages) < maxPkgsOf(c.id,s));
  if(withRoom.length===0) return null;

  // Öncelikli kurye, limiti müsaitse önce o
  if(restId){
    const priority = withRoom.find(c=>c.priorityRestId===restId);
    if(priority) return priority;
  }
  // Aksi halde en az yüklü (en boş) kurye
  return [...withRoom].sort((a,b)=>activeLoadOf(a.id,db.packages)-activeLoadOf(b.id,db.packages))[0];
}
const nowTime = () => new Date().toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit"});
const todayStr = () => new Date().toLocaleDateString("tr-TR");

const INIT = {
  users:{
    admin: {id:"admin",role:"admin",name:"Admin",pw:"admin123"},
    rest01:{id:"rest01",role:"restaurant",name:"BURGER HOUSE",pw:"rest123"},
    rest02:{id:"rest02",role:"restaurant",name:"PIZZA PALACE",pw:"rest456"},
    k01:{id:"k01",role:"courier",name:"İzzet Kartal",pw:"kur123"},
    k02:{id:"k02",role:"courier",name:"Mehmet Oral",pw:"kur456"},
  },
  couriers:[
    {id:"k01",name:"İzzet Kartal",status:"active",km:12.4,earnings:185,bonus:50,packages:6,phone:"0532 111 11 11",balance:0,priorityRestId:null,region:"Merkez"},
    {id:"k02",name:"Mehmet Oral",status:"break",km:7.1,earnings:90,bonus:0,packages:3,phone:"0533 222 22 22",balance:0,priorityRestId:null,region:null},
    {id:"k03",name:"Ali Demir",status:"off",km:0,earnings:0,bonus:0,packages:0,phone:"0534 333 33 33",balance:0,priorityRestId:null,region:null},
  ],
  restaurants:[
    {id:"rest01",name:"BURGER HOUSE",balance:450,totalPackages:12,contact:"0532 111 22 33",address:"Muratpaşa, Şarampol Cad. No:42, Antalya",region:"Merkez",lat:36.8865,lng:30.7056},
    {id:"rest02",name:"PIZZA PALACE",balance:0,totalPackages:7,contact:"0533 444 55 66",address:"Konyaaltı, Atatürk Blv. No:18, Antalya",region:null,lat:36.8721,lng:30.6499},
    {id:"rest03",name:"BARIŞ CAFE",balance:200,totalPackages:5,contact:"0534 555 66 77",address:"Kepez, 1185 Sokak No:14, Antalya",region:null,lat:36.9354,lng:30.6832},
  ],
  packages:[
    {id:"32862",restaurant:"BURGER HOUSE",restId:"rest01",courier:"İzzet Kartal",courierId:"k01",status:"Teslim Edildi",time:"22:39",day:"",address:"Kadıköy Merkez",fee:35,paymentType:"Nakit",leftColor:"#4caf50"},
    {id:"32861",restaurant:"PIZZA PALACE",restId:"rest02",courier:"Mehmet Oral",courierId:"k02",status:"Teslimat Aşamasında",time:"22:10",day:"",address:"Beşiktaş",fee:40,paymentType:"Online",leftColor:"#4caf50"},
    {id:"18743",restaurant:"BARIŞ CAFE",restId:"rest03",courier:"İzzet Kartal",courierId:"k01",status:"Atandı",time:"21:55",day:"",address:"Şişli Merkez",fee:35,paymentType:"Kredi Kartı",leftColor:"#4caf50"},
    {id:"32860",restaurant:"BURGER HOUSE",restId:"rest01",courier:"",courierId:"",status:"Otomatik Atama Bekliyor",time:"21:54",day:"",address:"Üsküdar",fee:35,paymentType:"Nakit",leftColor:"#111"},
    {id:"18742",restaurant:"PIZZA PALACE",restId:"rest02",courier:"Mehmet Oral",courierId:"k02",status:"Teslim Edildi",time:"21:47",day:"",address:"Levent",fee:40,paymentType:"Kredi Kartı",leftColor:"#4caf50"},
    {id:"32855",restaurant:"BURGER HOUSE",restId:"rest01",courier:"İzzet Kartal",courierId:"k01",status:"Teslim Edildi",time:"21:20",day:"Çar",address:"Kartal",fee:35,paymentType:"Online",leftColor:"#4caf50"},
  ],
  transactions:[],
  balanceRequests:[],
  signupRequests:[],
  settings:{packageFee:35,courierEarn:25,kmInterval:1,kmFee:2.5,minFee:20,maxPkgs:10,assignRadius:3,assignMode:"auto",courierFees:{},restFees:{},regions:[{id:"r1",name:"Merkez",startKm:0,pkgFee:35,firstKmFee:5,nextKmFee:3,minFee:20}]},
};

function useToast(){
  const [toasts,setToasts]=useState([]);
  const toast=useCallback((msg,type="info")=>{
    const id=Date.now();
    setToasts(t=>[...t,{id,msg,type}]);
    setTimeout(()=>setToasts(t=>t.filter(x=>x.id!==id)),3000);
  },[]);
  return {toasts,toast};
}
function Toasts({toasts}){
  const c={success:"#4caf50",error:"#e53935",info:"#1e88e5",warning:"#f9a825"};
  return(
    <div style={{position:"fixed",top:16,right:16,zIndex:9999,display:"flex",flexDirection:"column",gap:8}}>
      {toasts.map(t=>(
        <div key={t.id} style={{background:"#fff",borderLeft:"4px solid "+(c[t.type]||"#1e88e5"),borderRadius:10,padding:"10px 16px",fontSize:11,color:"#1c1c1e",boxShadow:"0 4px 16px rgba(0,0,0,.14)",animation:"notifIn .25s ease",minWidth:220}}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

export default function App(){
  const [user,setUser]=useState(null);
  const [db,setDb]=useState(null); // null = henüz yüklenmedi
  const [loadError,setLoadError]=useState(false);
  const {toasts,toast}=useToast();
  const savingRef = useRef(false); // kendi yazdığımız güncellemeyi realtime'dan geri almamak için

  // İlk yükleme: Supabase'den mevcut veriyi çek
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      const {data,error} = await supabase.from("jetla_state").select("data").eq("id","main").single();
      if(cancelled) return;
      if(error||!data){ setLoadError(true); setDb(INIT); return; }
      setDb(Object.keys(data.data||{}).length ? data.data : INIT);
    })();
    return ()=>{cancelled=true;};
  },[]);

  // Gerçek zamanlı senkronizasyon: başka bir cihaz veri değiştirirse anında yansıt
  useEffect(()=>{
    const channel = supabase
      .channel("jetla_state_changes")
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"jetla_state",filter:"id=eq.main"},payload=>{
        if(savingRef.current){ savingRef.current=false; return; } // kendi yazdığımızı yoksay
        setDb(payload.new.data);
      })
      .subscribe();
    return ()=>{ supabase.removeChannel(channel); };
  },[]);

  const save = useCallback(async d=>{
    setDb(d); // ekranı hemen güncelle
    savingRef.current = true;
    const {error} = await supabase.from("jetla_state").update({data:d,updated_at:new Date().toISOString()}).eq("id","main");
    if(error){ console.error("Supabase kayıt hatası:",error); savingRef.current=false; }
  },[]);

  const wrap=el=>(
    <div style={{maxWidth:430,margin:"0 auto",minHeight:"100vh",background:"#fff",display:"flex",flexDirection:"column",overflowX:"hidden"}}>
      <style>{CSS}</style><Toasts toasts={toasts}/>{el}
    </div>
  );

  if(db===null){
    return wrap(
      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12,padding:24}}>
        <div style={{width:36,height:36,border:"3px solid #f2f2f7",borderTopColor:"#e53935",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
        <p style={{color:"#8e8e93",fontSize:13}}>Yükleniyor...</p>
        {loadError&&<p style={{color:"#e53935",fontSize:12,textAlign:"center",maxWidth:280}}>Bağlantı kurulamadı, varsayılan veriyle devam ediliyor. İnternet bağlantınızı kontrol edin.</p>}
      </div>
    );
  }

  if(!user)              return wrap(<LoginScreen db={db} setUser={setUser} toast={toast} save={save}/>);
  if(user.role==="admin")      return wrap(<AdminApp      user={user} db={db} save={save} setUser={setUser} toast={toast}/>);
  if(user.role==="restaurant") return wrap(<RestApp       user={user} db={db} save={save} setUser={setUser} toast={toast}/>);
  if(user.role==="courier")    return wrap(<CourierApp    user={user} db={db} save={save} setUser={setUser} toast={toast}/>);
  return wrap(<LoginScreen db={db} setUser={setUser} toast={toast} save={save}/>);
}

function LoginScreen({db,setUser,toast,save}){
  const [mode,setMode]=useState("login"); // login | signup
  const [signupRole,setSignupRole]=useState("restaurant"); // restaurant | courier
  const [u,setU]=useState("");const [pw,setPw]=useState("");const [err,setErr]=useState(false);
  const [sf,setSf]=useState({id:"",name:"",phone:"",pw:"",address:"",plate:"",tc:"",taxNo:"",taxOffice:"",contractAccepted:false});
  const [signupDone,setSignupDone]=useState(false);
  const [showContract,setShowContract]=useState(false);

  const go=()=>{
    const found=Object.values(db.users).find(x=>x.id===u&&x.pw===pw);
    if(found){setUser(found);toast("Hoş geldiniz, "+found.name+"!","success");}
    else{setErr(true);setTimeout(()=>setErr(false),2000);}
  };

  const submitSignup=()=>{
    if(!sf.id||!sf.name||!sf.pw) return;
    if(signupRole==="courier"&&!sf.tc){ toast("T.C. Kimlik No zorunludur","error"); return; }
    if(signupRole==="restaurant"&&(!sf.taxNo||!sf.taxOffice)){ toast("Vergi No ve Vergi Dairesi zorunludur","error"); return; }
    if(!sf.contractAccepted) return;
    if(db.users[sf.id]){ toast("Bu kullanıcı adı zaten alınmış","error"); return; }
    const req={
      id:genId(),userId:sf.id,role:signupRole,name:sf.name,phone:sf.phone,pw:sf.pw,
      address:signupRole==="restaurant"?sf.address:"",
      plate:signupRole==="courier"?sf.plate:"",
      tc:signupRole==="courier"?sf.tc:"",
      taxNo:signupRole==="restaurant"?sf.taxNo:"",
      taxOffice:signupRole==="restaurant"?sf.taxOffice:"",
      contractAccepted:sf.contractAccepted,
      status:"bekliyor",time:nowTime(),date:todayStr(),
    };
    save({...db,signupRequests:[...(db.signupRequests||[]),req]});
    setSignupDone(true);
    setSf({id:"",name:"",phone:"",pw:"",address:"",plate:"",tc:"",taxNo:"",taxOffice:"",contractAccepted:false});
  };

  if(mode==="signup"){
    if(signupDone){
      return(
        <div style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",alignItems:"center",padding:28,background:"#f2f2f7"}}>
          <p style={{fontSize:48,marginBottom:16}}>✅</p>
          <p style={{fontWeight:700,fontSize:16,marginBottom:8,textAlign:"center"}}>Başvurunuz alındı!</p>
          <p style={{color:"#8e8e93",fontSize:12,textAlign:"center",marginBottom:24,maxWidth:280}}>Admin onayından sonra giriş bilgilerinizle sisteme erişebilirsiniz.</p>
          <button onClick={()=>{setMode("login");setSignupDone(false);}} style={{padding:"12px 32px",background:"#e53935",color:"#fff",border:"none",borderRadius:12,fontSize:13,fontWeight:700,cursor:"pointer"}}>Giriş Ekranına Dön</button>
        </div>
      );
    }
    return(
      <div style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",padding:28,background:"#f2f2f7"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:10,background:"#e53935",borderRadius:14,padding:"12px 28px",marginBottom:10}}>
            <span style={{fontSize:18}}>⚡</span>
            <span style={{fontSize:18,fontWeight:900,color:"#fff",letterSpacing:2}}>JETLA</span>
          </div>
          <p style={{color:"#8e8e93",fontSize:11,letterSpacing:1}}>YENİ HESAP BAŞVURUSU</p>
        </div>
        <div style={{background:"#fff",borderRadius:12,padding:18,boxShadow:"0 2px 12px rgba(0,0,0,.06)"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
            {[["restaurant","🏪 İşletme"],["courier","🛵 Kurye"]].map(([r,l])=>(
              <button key={r} onClick={()=>{setSignupRole(r);setSf(f=>({...f,contractAccepted:false}));}} style={{padding:"10px",borderRadius:9,border:"1.5px solid "+(signupRole===r?"#e53935":"#e5e5ea"),background:signupRole===r?"#e53935":"#fff",color:signupRole===r?"#fff":"#636366",fontSize:12,fontWeight:700,cursor:"pointer"}}>{l}</button>
            ))}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <div>
              <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>{signupRole==="restaurant"?"İşletme Adı":"Ad Soyad"}</p>
              <input value={sf.name} onChange={e=>setSf(f=>({...f,name:e.target.value}))} placeholder={signupRole==="restaurant"?"Burger House":"Ahmet Yılmaz"} style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:12,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
            </div>
            <div>
              <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>Kullanıcı Adı</p>
              <input value={sf.id} onChange={e=>setSf(f=>({...f,id:e.target.value.trim()}))} placeholder="kullanici_adi" style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:12,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
            </div>
            <div>
              <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>Telefon</p>
              <input value={sf.phone} onChange={e=>setSf(f=>({...f,phone:e.target.value}))} placeholder="0532..." style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:12,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
            </div>
            {signupRole==="restaurant"&&(
              <>
                <div>
                  <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>İşletme Adresi</p>
                  <input value={sf.address} onChange={e=>setSf(f=>({...f,address:e.target.value}))} placeholder="Mahalle, cadde, no, şehir" style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:12,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
                </div>
                <div>
                  <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>Vergi Numarası <span style={{color:"#e53935"}}>*</span></p>
                  <input type="number" value={sf.taxNo} onChange={e=>setSf(f=>({...f,taxNo:e.target.value}))} placeholder="1234567890" maxLength={10} style={{width:"100%",padding:"9px 12px",border:"1.5px solid "+(sf.taxNo?"#4caf50":"#e5e5ea"),borderRadius:9,fontSize:12,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
                </div>
                <div>
                  <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>Vergi Dairesi <span style={{color:"#e53935"}}>*</span></p>
                  <input value={sf.taxOffice} onChange={e=>setSf(f=>({...f,taxOffice:e.target.value}))} placeholder="Antalya Vergi Dairesi" style={{width:"100%",padding:"9px 12px",border:"1.5px solid "+(sf.taxOffice?"#4caf50":"#e5e5ea"),borderRadius:9,fontSize:12,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
                </div>
              </>
            )}
            {signupRole==="courier"&&(
              <>
                <div>
                  <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>T.C. Kimlik Numarası <span style={{color:"#e53935"}}>*</span></p>
                  <input type="number" value={sf.tc} onChange={e=>setSf(f=>({...f,tc:e.target.value}))} placeholder="12345678901" maxLength={11} style={{width:"100%",padding:"9px 12px",border:"1.5px solid "+(sf.tc.length===11?"#4caf50":"#e5e5ea"),borderRadius:9,fontSize:12,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
                  {sf.tc&&sf.tc.length!==11&&<p style={{fontSize:10,color:"#e53935",marginTop:3}}>T.C. Kimlik No 11 haneli olmalıdır</p>}
                </div>
                <div>
                  <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>Motor Plakası</p>
                  <input value={sf.plate} onChange={e=>setSf(f=>({...f,plate:e.target.value.toUpperCase()}))} placeholder="34 ABC 123" style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:12,outline:"none",background:"#f9f9f9",color:"#1c1c1e",textTransform:"uppercase"}}/>
                </div>
              </>
            )}
            <div>
              <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>Şifre</p>
              <input type="password" value={sf.pw} onChange={e=>setSf(f=>({...f,pw:e.target.value}))} placeholder="••••••" style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:12,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
            </div>
            <label style={{display:"flex",alignItems:"flex-start",gap:8,padding:"10px 12px",background:sf.contractAccepted?"#e9f9ee":"#f9f9f9",borderRadius:9,border:"1.5px solid "+(sf.contractAccepted?"#4caf50":"#e5e5ea"),cursor:"pointer"}}>
              <input type="checkbox" checked={sf.contractAccepted} onChange={e=>setSf(f=>({...f,contractAccepted:e.target.checked}))} style={{marginTop:2,width:16,height:16,flexShrink:0,accentColor:"#4caf50"}}/>
              <span style={{fontSize:12,color:"#1c1c1e",lineHeight:1.4}}>
                <button type="button" onClick={e=>{e.preventDefault();setShowContract(true);}} style={{background:"none",border:"none",padding:0,color:"#1e88e5",fontWeight:700,fontSize:12,cursor:"pointer",textDecoration:"underline"}}>{signupRole==="courier"?"Kurye Hizmet Sözleşmesi":"Üye İşyeri Sözleşmesi"}</button>'ni okudum, onaylıyorum.
              </span>
            </label>
            <button onClick={submitSignup}
              disabled={!sf.id||!sf.name||!sf.pw||!sf.contractAccepted||(signupRole==="courier"&&sf.tc.length!==11)||(signupRole==="restaurant"&&(!sf.taxNo||!sf.taxOffice))}
              style={{padding:"12px",background:sf.id&&sf.name&&sf.pw&&sf.contractAccepted&&(signupRole!=="courier"||sf.tc.length===11)&&(signupRole!=="restaurant"||(sf.taxNo&&sf.taxOffice))?"#e53935":"#e5e5ea",color:sf.id&&sf.name&&sf.pw&&sf.contractAccepted&&(signupRole!=="courier"||sf.tc.length===11)&&(signupRole!=="restaurant"||(sf.taxNo&&sf.taxOffice))?"#fff":"#8e8e93",border:"none",borderRadius:12,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:4}}>
              Başvuruyu Gönder
            </button>
          </div>
          <button onClick={()=>setMode("login")} style={{width:"100%",padding:"10px",background:"transparent",color:"#636366",border:"none",fontSize:12,cursor:"pointer",marginTop:10}}>← Giriş ekranına dön</button>
        </div>
        {showContract&&(
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:1000,display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={()=>setShowContract(false)}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:"18px 18px 0 0",width:"100%",maxWidth:430,maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
              <div style={{padding:"16px 18px",borderBottom:"1px solid #e5e5ea",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
                <p style={{fontWeight:700,fontSize:15}}>📄 {signupRole==="courier"?"Kurye Hizmet Sözleşmesi":"Üye İşyeri Sözleşmesi"}</p>
                <button onClick={()=>setShowContract(false)} style={{background:"#f2f2f7",border:"none",borderRadius:8,padding:"6px 12px",fontSize:13,fontWeight:700,color:"#636366",cursor:"pointer"}}>✕</button>
              </div>
              <div style={{padding:"16px 18px",overflowY:"auto",flex:1}}>
              {signupRole==="courier"?(<>
                <p style={{fontWeight:700,fontSize:11,color:"#8e8e93",textAlign:"center",marginBottom:14,letterSpacing:.5}}>KURYE HİZMET SÖZLEŞMESİ</p>

                <div style={{marginBottom:14}}>
                  <p style={{fontWeight:700,fontSize:13,color:"#1c1c1e",marginBottom:4}}>1. Taraflar</p>
                  <p style={{fontSize:12,color:"#636366",lineHeight:1.6,marginBottom:8}}>İşbu Hizmet Sözleşmesi ("Sözleşme") bir tarafta JETLA GLOBAL LOJİSTİK SANAYİ VE TİC. LTD. ŞTİ. ("Hizmet Alan" / "JETLA") ile diğer tarafta, serbest meslek erbabı, aşağıda bilgileri bulunan ("Esnaf Kurye" / "Kurye") arasında akdedilmiştir.</p>
                  <div style={{background:"#f9f9f9",borderRadius:8,padding:"10px 12px",fontSize:11,color:"#1c1c1e",lineHeight:2}}>
                    <p>Adı Soyadı: <strong>{sf.name||"—"}</strong></p>
                    <p>Telefon No: <strong>{sf.phone||"—"}</strong></p>
                    <p>T.C. Kimlik No / Vergi Kimlik No: ……</p>
                    <p>İkamet Adresi: ……</p>
                  </div>
                </div>

                <div style={{marginBottom:14}}>
                  <p style={{fontWeight:700,fontSize:13,color:"#1c1c1e",marginBottom:4}}>2. Tanımlamalar</p>
                  <p style={{fontSize:12,color:"#636366",lineHeight:1.6}}>
                    <strong>JETLA Uygulaması:</strong> Siparişlerin oluşturulduğu, yönlendirildiği, teslimat ve tahsilat kayıtlarının tutulduğu yazılım. <strong>Ürün(ler):</strong> Uygulama üzerinden satışa sunulan mal/hizmetler. <strong>Müşteri(ler):</strong> Sipariş veren kişiler. <strong>İşletme/İşyeri:</strong> Ürünü satışa sunan restoran/işletmeler. <strong>Sipariş:</strong> Kurye'ye yönlendirilen teslimat talebi. <strong>Kurye Hizmeti:</strong> Siparişin teslim alınıp Müşteri'ye ulaştırılması. <strong>Tahsilat:</strong> Bedelin teslimat sırasında alınıp sisteme işlenmesi. <strong>Emanet Tahsilat:</strong> Alınan bedellerin Kurye geliri sayılmaksızın İşletme/JETLA adına geçici muhafazası. <strong>Vardiya:</strong> JETLA tarafından duyurulan çalışma planı ve zaman aralığı.
                  </p>
                </div>

                {[
                  ["3. Sözleşmenin Konusu, Niteliği ve Sorumluluk",
                    "3.1 Sözleşme'nin konusu; Kurye tarafından Kurye Hizmeti sunulması ve teslimat sırasında Tahsilat'a aracılık edilmesi; karşılığında Hizmet Alan'ın ödeme yapması ile tarafların hak ve yükümlülüklerinin belirlenmesidir.\n\n3.2 Kurye, vergisel ve sosyal güvenlik yükümlülüklerinden bizzat sorumludur. Hizmet Alan bu belgeleri talep edebilir.\n\n3.3 İşbu Sözleşme ile taraflar arasında işçi-işveren ilişkisi tesis edilmemekte olup, Kurye bağımsız hizmet sağlayıcı olarak hizmet vermektedir.\n\n3.4 Ürünlerin mülkiyeti, ayıp, iade-değişim, garanti, vergi ve müşteriye karşı satıştan doğan sorumluluklar İşletme'ye aittir. Kurye satıcı değildir; yalnızca taşıma ve Tahsilat'a aracılık eder.\n\n3.5 Kurye'nin sorumluluğu yalnızca kendi kusurundan kaynaklanan doğrudan zararlarla sınırlı olup, ilgili teslimatın kurye hizmet bedelini aşamaz.\n\n3.6 Kurye, trafik kurallarına aykırı kullanım nedeniyle oluşan para cezasını kendisi öder; bu ceza Hizmet Alan'a yükletilemez.\n\n3.7 Sözleşme, Kurye'nin üçüncü kişilerle çalışmasına genel bir sınırlama getirmez; ancak vardiya/operasyon hükümleri saklıdır."],
                  ["4. Tarafların Hak ve Yükümlülükleri",
                    "4.1 Kurye; Kurye Hizmeti'ni gerçekleştirecek yeterli bilgi/tecrübeye sahip olduğunu, geçerli ehliyet ve belgelere sahip olduğunu (değişiklik halinde JETLA'yı bilgilendireceğini), Müşteri ve İşletmelerle saygılı/profesyonel iletişim kuracağını kabul eder.\n\n4.2 Kurye, Sipariş'i Uygulama üzerindeki rota ve talimatlara uygun teslim eder; teslimat ve Tahsilat tamamlandığında Uygulama üzerinden bildirir.\n\n4.3 Kurye, mevzuata, trafik kurallarına, JETLA Hizmet Standartları'na ve Ek-1 Güvenlik Kuralları'na uygun davranır.\n\n4.4 Kurye, zorunlu tutulan eğitim/bilgilendirmelere makul ölçüde katılır.\n\n4.5–4.6 Kurye, JETLA sistemiyle uyumlu bir mobil cihaz kullanır ve teslimat süresince GPS/konum ayarını açık tutar. Kasıtlı kapatma halinde uyarı, geçici kısıt ve tekrarında fesih uygulanabilir.\n\n4.7 Kurye, iletişim kanallarında JETLA, İşletme, Müşteri ve diğer kuryeler hakkında itibar zedeleyici paylaşımda bulunmaz; ihlalde kademeli yaptırım (uyarı–askı–fesih) uygulanabilir.\n\n4.8 Kurye, duyurulan vardiya saatlerine uyar; operasyonel gereklilikler sebebiyle vardiyanın makul sürelerle değişebileceğini kabul eder. Bu hüküm sabit çalışma saati garantisi vermez, işçi-işveren ilişkisi oluşturmaz.\n\n4.9 Kurye, öğrendiği iş/meslek sırlarını ve müşteri/işletme bilgilerini gizli tutar; JETLA izni olmaksızın operasyon içi bilgi/görüntü paylaşamaz."],
                  ["5. Tahsilata Aracılık, Nakit Taşıma, Teminat ve Avans",
                    "5.1 POS/kartlı tahsilatta oluşabilecek komisyon, itiraz ve gecikmeler İşletme sorumluluğundadır; POS'un elektronik arızasından Kurye sorumlu değildir.\n\n5.2 Kurye, İşletmelere ait nakit bedelleri geçici olarak taşır. Bu kapsamda 5.000 TL veya JETLA'nın belirlediği tutar emanet/teminat olarak geçici alıkonulabilir.\n\n5.3 Teminat bedeli, yükümlülüklerin eksiksiz yerine getirilmesi halinde sözleşme sonunda en geç 15 gün içinde veya bir sonraki ödeme döneminde iade edilir.\n\n5.4 Nakdin eksik/geç/hiç teslim edilmemesi halinde JETLA, teminattan ve doğmuş hak edişlerden tek taraflı mahsup yapabilir.\n\n5.5 JETLA'nın verdiği bedeller avans niteliğindedir ve hak ediş aşamasında otomatik mahsup edilir."],
                  ["6. Ödeme ve Kurye Hizmet Bedeli Hesaplama",
                    "6.1 Kurye'nin sabit bir ücreti bulunmamaktadır; hizmet karşılığı ücrete hak kazanır.\n\n6.2 Hak ediş; paket başı ücret, mesafe (km) ücreti ve varsa ek hizmet bedelleri esas alınarak sistem üzerinden hesaplanır.\n\n6.3 JETLA, tarifeleri operasyonel ihtiyaca göre değiştirebilir; değişiklikler Uygulama/e-posta/SMS/WhatsApp ile bildirilir.\n\n6.4 Ödeme periyodu başlangıçta 15 günde bir olup JETLA tarafından değiştirilebilir.\n\n6.5 Kurye hak edişine ilişkin faturayı JETLA'ya tebliğ eder; ödemeler mahsup/avans düşümü sonrası banka hesabına yapılır."],
                  ["7. Sözleşme Süresi ve Fesih",
                    "7.1 Sözleşme imza tarihinden itibaren 1 yıl yürürlükte kalır; taraflardan biri en az 15 gün önce yazılı bildirimde bulunmadıkça aynı süre ile uzar.\n\n7.2 Taraflar, 15 gün önceden yazılı bildirimle, sebep göstermeksizin ve tazminatsız Sözleşme'yi sona erdirebilir.\n\n7.3 JETLA; ağır güvenlik ihlali, kasti zarar, emanet tahsilatın zimmete geçirilmesi, gizlilik/KVKK ihlali veya mevzuata aykırılık hallerinde Sözleşme'yi derhal feshedebilir.\n\n7.4 Kurye, JETLA aracılığıyla çalıştığı işletmelerle JETLA'yı devre dışı bırakarak doğrudan ticari ilişki kurmamayı kabul eder. Bu hüküm Kurye'nin diğer platformlarda çalışmasını engellemez."],
                  ["8. Mücbir Sebep",
                    "Deprem, yangın, sel gibi doğal afetler; savaş, salgın hastalık, idari kararlar, grev/lokavt, toplumsal olaylar, trafik/hava koşulları ve teknik arızalar gibi öngörülemeyen sebeplerin varlığında, etkilenen yükümlülüklerden taraflar sorumlu tutulamaz."],
                  ["9. Diğer Hükümler",
                    "9.1 Uyuşmazlıkların çözüm yeri Antalya (Merkez) Mahkemeleri ve İcra Müdürlükleri'dir.\n\n9.2 Bildirimler sözleşmede belirtilen adreslere yapılır; adres değişikliği yazılı bildirilmedikçe eski adrese yapılan bildirim geçerlidir.\n\n9.3 Kurye, JETLA izni olmaksızın Sözleşme'den doğan hak/yükümlülüklerini üçüncü kişilere devredemez.\n\n9.4 Sözleşme, JETLA tarafından güncellenebilir; bildirimi takiben makul sürede yazılı itiraz edilmemesi halinde güncelleme kabul edilmiş sayılır.\n\n9.5 Kurye, çalışma esnasında çekilen fotoğraf/videoların JETLA web sitesi ve sosyal medyasında tanıtım amacıyla kullanılmasına izin verir; bu kullanım kişilik haklarını zedeleyici olamaz."],
                ].map(([h,t])=>(
                  <div key={h} style={{marginBottom:14}}>
                    <p style={{fontWeight:700,fontSize:13,color:"#1c1c1e",marginBottom:4}}>{h}</p>
                    {t.split("\n\n").map((para,i)=>(
                      <p key={i} style={{fontSize:12,color:"#636366",lineHeight:1.6,marginBottom:i<t.split("\n\n").length-1?8:0}}>{para}</p>
                    ))}
                  </div>
                ))}

                <div style={{height:1,background:"#e5e5ea",margin:"16px 0"}}/>

                <div style={{marginBottom:14}}>
                  <p style={{fontWeight:700,fontSize:13,color:"#1c1c1e",marginBottom:8}}>Ek-1 — Güvenliğe İlişkin Temel Kurallar</p>
                  {[
                    "Hız sınırlarına uyulmalı; şehir hız limitlerinin üzerine çıkılmamalıdır.",
                    "Trafik ışıklarına uyulmalı; kırmızı ışıkta geçilmemelidir.",
                    "Yaya yürüyüş yollarına, bisiklet yollarına ve kaldırımlara çıkılmamalıdır.",
                    "Ters yöne girilmemelidir.",
                    "Kasksız motor kullanılmamalı; kask tam takılmalıdır.",
                    "Otokurye, araç kullanırken emniyet kemeri takmalıdır.",
                    "Yaya şeridine yaklaşırken yavaşlanmalı, yaya şeridine park edilmemelidir.",
                    "Çene altı kask bandı kilitlenmelidir.",
                    "Acil durumlar haricinde emniyet şeridine girilmemelidir.",
                    "Refüj aralarından geçilmemelidir.",
                    "Sürüş sırasında sigara içilmemeli, yiyecek/içecek tüketilmemelidir.",
                    "Araç kullanırken telefonla konuşulmamalı, dikkat dağıtıcı cihaz kullanılmamalıdır.",
                    "Motora birden fazla kişi binmemelidir.",
                    "Tehlikeli sürüş davranışlarından (makas, tek teker vb.) kaçınılmalıdır.",
                    "Ürünler güvenli şekilde taşınmalıdır.",
                    "Park ederken trafiği engelleyecek şekilde park edilmemelidir.",
                    "Ekipmanlar teslimat sırasında kullanılmalıdır.",
                    "İşletme içinde ve teslimat noktalarında rahatsızlık verecek davranışlardan kaçınılmalıdır.",
                  ].map((rule,i)=>(
                    <p key={i} style={{fontSize:11,color:"#636366",lineHeight:1.7,marginBottom:3}}>{i+1}. {rule}</p>
                  ))}
                </div>

                <div style={{background:"#fff8e1",borderRadius:10,padding:"12px 14px",marginTop:8}}>
                  <p style={{fontSize:11,color:"#8e6d00",lineHeight:1.6}}>
                    📎 <strong>Ek-2 Teslim Edilen Ekipman Formu</strong> ve teminat/IBAN bilgileri, hesabınız onaylandıktan sonra JETLA operasyon ekibi tarafından sizinle ayrıca paylaşılacaktır.
                  </p>
                </div>
              </>):(<>
                <p style={{fontWeight:700,fontSize:11,color:"#8e8e93",textAlign:"center",marginBottom:14,letterSpacing:.5}}>ÜYE İŞYERİ SÖZLEŞMESİ</p>

                <div style={{marginBottom:14}}>
                  <p style={{fontWeight:700,fontSize:13,color:"#1c1c1e",marginBottom:4}}>1. Taraflar</p>
                  <p style={{fontSize:12,color:"#636366",lineHeight:1.6,marginBottom:8}}>İş bu sözleşme bir tarafta Varsak Aktoprak Mahallesi 1185 Sokak No:14 D:2 Kepez/Antalya adresinde, Antalya Vergi Dairesi'ne kayıtlı 0701181648 vergi numaralı JETLA GLOBAL LOJİSTİK E-TİCARET SAN. VE TİC. LTD. ŞTİ. ("JETLA") ile diğer tarafta aşağıda bilgileri bulunan işletme ("Üye İşyeri") arasında akdedilmiştir.</p>
                  <div style={{background:"#f9f9f9",borderRadius:8,padding:"10px 12px",fontSize:11,color:"#1c1c1e",lineHeight:2}}>
                    <p>Ticari Yetkili Adı Soyadı: <strong>{sf.name||"—"}</strong></p>
                    <p>Ticari İşletmenin Adı: ……</p>
                    <p>Telefon No: <strong>{sf.phone||"—"}</strong></p>
                    <p>Üye İşyerinin Adresi: <strong>{sf.address||"—"}</strong></p>
                    <p>T.C. Kimlik No / Vergi Kimlik No: ……</p>
                  </div>
                </div>

                <div style={{marginBottom:14}}>
                  <p style={{fontWeight:700,fontSize:13,color:"#1c1c1e",marginBottom:4}}>2. Tanımlar</p>
                  <p style={{fontSize:12,color:"#636366",lineHeight:1.6}}>
                    <strong>JETLA Sistemi:</strong> JETLA'nın mobil uygulamaları ve diğer dijital kanalları aracılığıyla erişilebilen, kurye/esnaf kurye listeleme ve iş verme hizmeti sunan sistemler. <strong>Üye İşyeri:</strong> JETLA üzerinden göndermek istediği ürünlerin JETLA veya anlaşmalı 3. kişiler tarafından ulaştırılmasını talep eden gerçek/tüzel kişi. <strong>Kullanıcı:</strong> Üye İşyeri'nin gönderisinin ulaştırıldığı gerçek/tüzel kişi. <strong>Kurye Hizmeti Ücreti:</strong> Gönderinin boyutu, mesafesi vb. ölçüler çerçevesinde Üye İşyeri'nin JETLA'ya ödeyeceği bedel.
                  </p>
                </div>

                {[
                  ["3. Sözleşmenin Konusu",
                    "İşbu Sözleşme'nin konusu; JETLA Sistemi'nin işleyişi ile ilgili koşulların ve tarafların karşılıklı hak ve yükümlülüklerinin belirlenmesi, Sözleşme'nin tatbik ve tefsirinden doğacak uyuşmazlıkların çözüm yollarının gösterilmesidir."],
                  ["4. JETLA'nın Hak ve Yükümlülükleri",
                    "4.1 JETLA, Üye İşyeri'ne ilişkin ürün ve sipariş bilgilerinin, bildirilen içeriğe uygun şekilde Sistem'de yer almasını sağlamakla yükümlüdür.\n\n4.2 Kullanıcı'dan kaynaklanan hatalardan (siparişi kabul etmeme, adreste bulunmama vb.) JETLA sorumlu değildir; bu durumlarda ödenen kurye hizmeti iade edilmez.\n\n4.3 JETLA, Sistem kullanımıyla oluşan veri ve istatistiklerin fikri mülkiyet haklarına sahiptir; gizli bilgi açıklamadan rapor düzenleyebilir ve iş ortaklarıyla paylaşabilir (Gizlilik maddesine aykırılık teşkil etmez).\n\n4.4 JETLA, Üye İşyeri'nin logo ve marka bilgilerini reklam amaçlı kullanabilir."],
                  ["5. Üye İşyeri'nin Hak ve Yükümlülükleri",
                    "5.1 Üye İşyeri, ilettiği ürün bilgilerinin (boyut, nitelik, ağırlık vb.) doğru olduğunu kabul ve taahhüt eder; gönderim bölgeleri, promosyon ve ürün durumu bilgilerinin güncelliğinden kendisi sorumludur.\n\n5.2 Üye İşyeri, Sistem'de talep almayı açıp kapatma hakkına sahiptir; talepleri kapatması veya bakiye yüklememesi halinde kendisine kurye gelmeyeceğini bilir.\n\n5.3 Sistem, JETLA'nın güncellemesi veya Üye İşyeri'nin sistemi aksatıcı davranışları nedeniyle geçici/tamamen kapatılabilir; bu durumda tazminat talep edilemez.\n\n5.4 Üye İşyeri, Kullanıcı'nın talep ettiği ürünü doğru ve notlara uygun hazırlamakla yükümlüdür; bu kapsamda kuryenin sorumluluğu yoktur.\n\n5.5 Üye İşyeri, gönderiyi Sistem'e ilettikten sonra 5-60 dakika içinde JETLA kurye hizmeti sağlayacaktır; teknik/personel kaynaklı gecikmelerde tazminat talep edilemez. Bu süre JETLA tarafından değiştirilebilir.\n\n5.6 Siparişin geç/hatalı/eksik gitmesi veya Kullanıcı şikayeti halinde Üye İşyeri, eksikliği derhal gidermek, gerekirse ücret iadesi veya ilave ürün vermekle yükümlüdür.\n\n5.7 Üye İşyeri, gönderdiği ürünlerin mevzuata uygun olduğunu taahhüt eder; aykırılık bildirildiğinde derhal iade/değişim yapar ve doğacak zararları tazmin eder.\n\n5.8 Üye İşyeri, JETLA Sistemi üzerinden alkollü içecek, tütün mamulü veya kanuna aykırı ürün taşınmasını talep etmeyeceğini kabul eder; aykırılık halinde doğacak zararlardan sorumludur.\n\n5.9 Kullanıcı bilgileri, sipariş iletimi amacıyla JETLA ile paylaşılır; bu bilgiler JETLA tarafından reklam/pazarlama amaçlı kullanılabilir (Gizlilik maddesine aykırılık teşkil etmez).\n\n5.10 Üye İşyeri, gönderdiği ürünlerle ilgili gerekli her türlü izin, onay ve ruhsatı bulundurmakla yükümlüdür; aksi halde doğacak idari/hukuki/cezai sorumluluk kendisine aittir.\n\n5.11 Üye İşyeri, JETLA'nın temin edeceği üyelik çıkartmasını (sticker) dışarıdan görülebilecek bir yere yapıştırmayı ve sözleşme süresince muhafaza etmeyi taahhüt eder.\n\n5.12 Üye İşyeri, JETLA'yı kötüleyici veya olumsuz intiba oluşturacak davranışlardan kaçınır.\n\n5.13 Üye İşyeri, işletmesinin girişine ticari markasını/logosunu yansıtan kendi tabelasını asmayı ve sözleşme süresince muhafaza etmeyi taahhüt eder; ilgili vergi ve masraflar kendisine aittir.\n\n5.14 Kullanıcı şikayetleri veya JETLA/ilgili kurumlarca iletilen ihbarlar üzerine yapılacak denetimlerde sözleşmeye aykırılık, usulsüzlük, sahtecilik veya yanıltıcı satış tespiti halinde JETLA, Üye İşyeri'nin sayfasını geçici olarak erişime kapatabilir.\n\n5.15 Üye İşyeri'nin temel sorumluluğu, ürünü tam/eksiksiz/hasarsız şekilde taşımaya uygun olarak hazırlamak ve JETLA saha elemanına zamanında teslim etmektir; aksi halde doğacak zararlardan münhasıran Üye İşyeri sorumludur.\n\n5.16 Üye İşyeri, JETLA'dan bağımsız kendi ticari işletmesidir; aralarında sadece kurye hizmeti ilişkisi vardır, gönderilen ürünlerden doğan zararlardan münhasıran Üye İşyeri sorumludur.\n\n5.17 Sipariş tahsilatı için verilen POS cihazının sorumluluğu Üye İşyeri'ndedir; cihazın JETLA kaynaklı arızasında bakım/tamir/değişim JETLA tarafından yapılır.\n\n5.18 Üye İşyeri ile JETLA arasında işveren-işçi veya asıl-alt işveren ilişkisi kurulmamıştır; Üye İşyeri çalışanlarına ilişkin tüm yükümlülükler Üye İşyeri'ne aittir.\n\n5.19 Üye İşyeri, KVKK'ya aykırı veri işlemeden münhasıran sorumludur; aykırılık halinde JETLA'nın sözleşmeyi tazminatsız ve derhal feshetme hakkı saklıdır.\n\n5.20 Üye İşyeri, göndermek istediği ürünü öncelikle JETLA aracılığıyla taşıtmayı talep edecektir; belirtilen süreler geçtikten sonra taşımayı kendisi veya 3. kişilere yaptırabilir."],
                  ["6. Kurye Hizmeti ve Ödeme Yöntemi",
                    "6.1 Üye İşyeri, göndermek istediği ürün/sipariş bilgileriyle Sistem üzerinden Kurye Hizmeti talep edecektir.\n\n6.2 Hizmet talebi için Sistem'de kayıtlı bir hesap gerekir; bu hesap sözleşme akdinden 3 iş günü içinde tanımlanır, kullanıcı adı/şifre e-posta veya WhatsApp ile iletilir.\n\n6.3 Kurye Hizmeti güncel bedeli JETLA tarafından tek taraflı belirlenir; bedel gönderi mesafesine göre değişir.\n\n6.4 Hizmetten faydalanmak için hesapta yeterli bakiye bulunmalıdır; bakiye yetersizse hesap eksi bakiye gösterebilir.\n\n6.5 Bakiye iadesi talep edilirse, değerlendirme sonrası 45 gün içinde banka hesabına gönderilir; kullanım sıklığı ve lokasyon istihdamı gözetilerek talep reddedilebilir.\n\n6.6 Ürünler JETLA saha elemanı veya anlaşmalı 3. kişiler tarafından Kullanıcı'ya ulaştırılır.\n\n6.7 Kullanıcı veya Üye İşyeri kaynaklı hatalardan JETLA sorumlu değildir; bu durumlarda ödenen ücret iade edilmez.\n\n6.8 Kurye Hizmeti tahsilat sistemi bir bankacılık/mevduat işlemi olmayıp, JETLA'nın belirlediği şart ve koşullarla işleyen elektronik bir tahsilat yöntemidir."],
                  ["7. Mali Hükümler",
                    "7.1 Üye İşyeri, JETLA tarafından belirlenen Kurye Hizmeti bedelini Türk Lirası üzerinden ödemeyi kabul eder.\n\n7.2 Güncel hizmet bedeli, Üye İşyeri kullanıcı sayfası duyurular bölümünden iletilir.\n\n7.3 JETLA, ekonomik gelişmeler ve operasyonel maliyetler sebebiyle bedelleri bilgilendirme yaparak artırabilir.\n\n7.4 Üye İşyeri, JETLA'nın e-arşiv faturalarının belirlediği e-posta adresine gönderilmesini kabul eder; e-posta değişikliğini JETLA'ya bildirmekle yükümlüdür.\n\n7.5 Mali yükümlülüklerin geç/eksik/hiç yerine getirilmemesi halinde JETLA, Üye İşyeri sayfasını kapatabilir; 15 gün içinde yükümlülük yerine getirilmezse sözleşme derhal feshedilebilir."],
                  ["8. Uyuşmazlıkların Çözümü",
                    "Taraflar, uyuşmazlıkları öncelikle kendi aralarında sulhen çözmeye gayret eder. Sulhen çözülemeyen uyuşmazlıklarda Türk Hukuku uygulanır; Ankara (Merkez) Mahkemeleri ve İcra Müdürlükleri münhasıran yetkilidir."],
                  ["9. Gizlilik",
                    "9.1 Taraflar, sözleşme süresince ve sonrasında edindikleri ticari sır ve özel nitelikli bilgileri üçüncü kişilere açıklamayacaklarını kabul eder.\n\n9.2 Yasal zorunluluk halinde açıklama yapılabilir; mümkün olduğunca diğer taraf ile önceden görüş alışverişi yapılır.\n\n9.3 İhlal halinde ihlal eden taraf, diğer tarafın zararını tazmin eder; fesih ve tazminat talep hakkı saklıdır.\n\n9.4 JETLA, Sistem kullanımıyla oluşan verilerin fikri haklarına sahiptir; bu madde sözleşme sona erse dahi yürürlükte kalır."],
                  ["10. Sözleşmenin Feshi",
                    "10.1 Taraflar, diğer tarafın sözleşmeyi ihlali halinde derhal fesih hakkına sahiptir; ihlalden doğan zararların tazminini talep edebilir.\n\n10.2 Taraflar, herhangi bir zamanda gerekçe göstermeksizin 30 gün önceden bildirmek kaydıyla sözleşmeyi feshedebilir; bu halde tazminat talep edilemez."],
                  ["11. Tebligat Adresi",
                    "Taraflar, sözleşmede yazılı adreslerin tebligat adresi olduğunu kabul eder. Adres değişikliği noter, iadeli taahhütlü mektup, kayıtlı e-posta veya Sistem üzerinden bildirilmedikçe sözleşmede belirtilen adrese yapılan tebligatlar geçerli sayılır."],
                  ["12. Sözleşmenin Bütünlüğü",
                    "Sözleşme, imza tarihinde yürürlüğe girer ve taraflar arasındaki önceki tüm anlaşmaların yerine geçer. Herhangi bir hükmün geçersiz olması, diğer hükümlerin geçerliliğini etkilemez."],
                ].map(([h,t])=>(
                  <div key={h} style={{marginBottom:14}}>
                    <p style={{fontWeight:700,fontSize:13,color:"#1c1c1e",marginBottom:4}}>{h}</p>
                    {t.split("\n\n").map((para,i)=>(
                      <p key={i} style={{fontSize:12,color:"#636366",lineHeight:1.6,marginBottom:i<t.split("\n\n").length-1?8:0}}>{para}</p>
                    ))}
                  </div>
                ))}

                <div style={{background:"#fff8e1",borderRadius:10,padding:"12px 14px",marginTop:8}}>
                  <p style={{fontSize:11,color:"#8e6d00",lineHeight:1.6}}>
                    📎 Kurye Hizmeti bakiye yükleme, e-arşiv fatura adresi ve IBAN bilgileri, hesabınız onaylandıktan sonra JETLA operasyon ekibi tarafından sizinle ayrıca paylaşılacaktır.
                  </p>
                </div>
              </>)}
              </div>
              <div style={{padding:"14px 18px",borderTop:"1px solid #e5e5ea",flexShrink:0}}>
                <button onClick={()=>{setSf(f=>({...f,contractAccepted:true}));setShowContract(false);}} style={{width:"100%",padding:"13px",background:"#4caf50",color:"#fff",border:"none",borderRadius:12,fontSize:14,fontWeight:700,cursor:"pointer"}}>
                  ✅ Okudum, Onaylıyorum
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",padding:28,background:"#f2f2f7"}}>
      <div style={{textAlign:"center",marginBottom:32}}>
        <div style={{display:"inline-flex",alignItems:"center",gap:10,background:"#e53935",borderRadius:14,padding:"12px 28px",marginBottom:10}}>
          <span style={{fontSize:11}}>⚡</span>
          <span style={{fontSize:11,fontWeight:900,color:"#fff",letterSpacing:2}}>JETLA</span>
        </div>
        <p style={{color:"#8e8e93",fontSize:11,letterSpacing:1}}>KURYE YÖNETİM SİSTEMİ</p>
      </div>
      <div style={{background:"#fff",borderRadius:12,padding:18,boxShadow:"0 2px 12px rgba(0,0,0,.06)"}}>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <div>
            <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,marginBottom:5,textTransform:"uppercase"}}>Kullanıcı Adı</p>
            <input value={u} onChange={e=>setU(e.target.value)} placeholder="kullanici_adi" onKeyDown={e=>e.key==="Enter"&&go()} style={{width:"100%",padding:"8px 12px",border:"1.5px solid #e5e5ea",borderRadius:10,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
          </div>
          <div>
            <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,marginBottom:5,textTransform:"uppercase"}}>Şifre</p>
            <input type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••" onKeyDown={e=>e.key==="Enter"&&go()} style={{width:"100%",padding:"8px 12px",border:"1.5px solid #e5e5ea",borderRadius:10,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
          </div>
          {err&&<p style={{color:"#e53935",fontSize:11,textAlign:"center"}}>Hatalı giriş.</p>}
          <button onClick={go} style={{padding:"13px",background:"#e53935",color:"#fff",border:"none",borderRadius:12,fontSize:11,fontWeight:700,cursor:"pointer"}}>Giriş Yap</button>
          <button onClick={()=>setMode("signup")} style={{padding:"11px",background:"#fff",color:"#e53935",border:"1.5px solid #e53935",borderRadius:12,fontSize:12,fontWeight:700,cursor:"pointer"}}>📝 Hesabım Yok — Üye Ol</button>
        </div>
      </div>
    </div>
  );
}

function TopBar({bolge,setBolge,filter,setFilter,onMapClick}){
  const [showB,setShowB]=useState(false);const [showF,setShowF]=useState(false);
  const bRef=useRef(null);const fRef=useRef(null);
  useEffect(()=>{
    const h=e=>{if(bRef.current&&!bRef.current.contains(e.target))setShowB(false);if(fRef.current&&!fRef.current.contains(e.target))setShowF(false);};
    document.addEventListener("mousedown",h);return()=>document.removeEventListener("mousedown",h);
  },[]);
  return(
    <div style={{background:"#fff",borderBottom:"1px solid #e5e5ea",padding:"7px 11px",position:"sticky",top:0,zIndex:100}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
        <div ref={bRef} style={{position:"relative"}}>
          <button onClick={()=>{setShowB(v=>!v);setShowF(false);}} style={{display:"flex",flexDirection:"column",background:"#fff",border:"1.5px solid #c7c7cc",borderRadius:10,padding:"5px 12px 5px 10px",minWidth:110,cursor:"pointer"}}>
            <span style={{fontSize:11,color:"#8e8e93",fontWeight:600}}>Bölge</span>
            <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:11,fontWeight:600,color:"#1c1c1e"}}>{bolge}</span><span style={{color:"#e53935",fontSize:11,marginLeft:"auto"}}>▼</span></div>
          </button>
          {showB&&(
            <div style={{position:"absolute",top:"110%",left:0,background:"#fff",borderRadius:12,minWidth:140,boxShadow:"0 8px 32px rgba(0,0,0,.15)",zIndex:300,overflow:"hidden",border:"1px solid #e5e5ea"}}>
              {BOLGE.map((b,i)=>(
                <button key={b} onClick={()=>{setBolge(b);setShowB(false);}} style={{display:"block",width:"100%",textAlign:"left",padding:"9px 12px",background:b===bolge?"#f2f2f7":"#fff",border:"none",borderBottom:i<BOLGE.length-1?"1px solid #f2f2f7":"none",fontSize:11,color:"#1c1c1e",cursor:"pointer"}}>{b}</button>
              ))}
            </div>
          )}
        </div>
        <div style={{display:"flex",gap:12,alignItems:"center"}}>
          <button style={{background:"none",border:"none",color:"#e53935",fontSize:11,cursor:"pointer",lineHeight:1}}>🔍</button>
          <button onClick={onMapClick} style={{background:"none",border:"none",color:"#e53935",fontSize:11,cursor:"pointer",lineHeight:1}}>🗺️</button>
          <button style={{background:"none",border:"none",color:"#e53935",fontSize:11,cursor:"pointer",lineHeight:1}}>↗</button>
          <div ref={fRef} style={{position:"relative"}}>
            <button onClick={()=>{setShowF(v=>!v);setShowB(false);}} style={{background:"none",border:"none",color:"#e53935",fontSize:11,cursor:"pointer",lineHeight:1}}>☰</button>
            {showF&&(
              <div style={{position:"absolute",top:"110%",right:0,background:"#fff",borderRadius:14,minWidth:240,boxShadow:"0 12px 40px rgba(0,0,0,.18)",zIndex:300,maxHeight:420,overflowY:"auto",border:"1px solid #e5e5ea"}}>
                {FILTER_OPTIONS.map((f,i)=>(
                  <button key={f} onClick={()=>{setFilter(f);setShowF(false);}} style={{display:"block",width:"100%",textAlign:"left",padding:"12px 20px",background:f===filter?"#f2f2f7":"#fff",border:"none",borderBottom:i<FILTER_OPTIONS.length-1?"1px solid #f2f2f7":"none",fontSize:11,color:"#1c1c1e",cursor:"pointer"}}>{f}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BottomNav({tabs,active,setActive}){
  return(
    <div style={{display:"flex",background:"#fff",borderTop:"1px solid #e5e5ea",padding:"4px 0 6px",position:"sticky",bottom:0,zIndex:100,flexShrink:0}}>
      {tabs.map(t=>{
        const on=active===t.id;
        return(
          <button key={t.id} onClick={()=>setActive(t.id)} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2,padding:"5px 0",border:"none",background:"transparent",cursor:"pointer",color:on?"#e53935":"#8e8e93"}}>
            {(t.id==="tasks"||t.id==="order"||t.id==="packages")
              ?<div style={{width:28,height:28,borderRadius:7,background:on?"#e53935":"#c7c7cc",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11}}>📦</div>
              :<span style={{fontSize:11}}>{t.icon}</span>}
            <span style={{fontSize:11,fontWeight:600,color:on?"#e53935":"#8e8e93"}}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function PkgRow({pkg,onAction,couriers,allPackages,settings}){
  const [open,setOpen]=useState(false);
  const isUp=pkg.restaurant===pkg.restaurant.toUpperCase();
  return(
    <div>
      <button onClick={()=>setOpen(v=>!v)} style={{display:"flex",alignItems:"stretch",width:"100%",background:"#fff",border:"none",borderBottom:"1px solid #e5e5ea",textAlign:"left",padding:0,cursor:"pointer"}}>
        <div style={{width:4,background:STATUS_COLORS[pkg.status]||"#8e8e93",flexShrink:0,borderRadius:"2px 0 0 2px"}}/>
        <div style={{flex:1,padding:"6px 8px"}}>
          <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:3}}>
            <div style={{width:12,height:9,background:"#1e88e5",borderRadius:2,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><span style={{fontSize:7,color:"#fff"}}>🏪</span></div>
            <span style={{fontSize:11,fontWeight:700,color:isUp?"#1e88e5":"#1c1c1e",lineHeight:1.2}}>{pkg.restaurant}</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:4}}><span style={{fontSize:11,color:"#8e8e93"}}>🔄</span><span style={{fontSize:11,color:"#8e8e93"}}>{pkg.courier||" "}</span></div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",justifyContent:"center",padding:"6px 5px 6px 0",gap:1,flexShrink:0}}>
          <span style={{fontSize:11,color:"#e53935",fontWeight:700}}>{pkg.day?pkg.day+" | "+pkg.time:"#"+pkg.id}</span>
          {!pkg.day&&<span style={{fontSize:11,color:"#8e8e93"}}>{pkg.time}</span>}
          <span style={{color:"#1e88e5",fontSize:11,lineHeight:1,marginTop:1}}>⌄</span>
        </div>
      </button>
      {open&&(
        <div style={{background:"#fafafa",borderBottom:"1px solid #e5e5ea",padding:"12px 14px 14px 30px"}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
            {[["Adres",pkg.address||"—"],["Ödeme",pkg.paymentType||"—"],["Ücret","₺"+(pkg.fee||35)],["Durum",pkg.status]].map(([l,v])=>(
              <div key={l}><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{l}</p><p style={{fontSize:11,color:"#1c1c1e"}}>{v}</p></div>
            ))}
          </div>
          {onAction&&(
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {!pkg.courierId&&couriers&&(
                <select onChange={e=>e.target.value&&onAction(pkg.id,"assign",e.target.value)} style={{padding:"7px 10px",border:"1.5px solid #e5e5ea",borderRadius:8,fontSize:11,background:"#fff",color:"#1c1c1e",outline:"none"}}>
                  <option value="">Kurye ata...</option>
                  {[...couriers.filter(c=>c.status==="active")].sort((a,b)=>{
                    const aP=a.priorityRestId===pkg.restId, bP=b.priorityRestId===pkg.restId;
                    return aP===bP?0:aP?-1:1;
                  }).map(c=>{
                    const load = allPackages ? activeLoadOf(c.id,allPackages) : null;
                    const max = settings ? maxPkgsOf(c.id,settings) : null;
                    const isFull = load!=null && max!=null && load>=max;
                    return(
                      <option key={c.id} value={c.id}>
                        {c.priorityRestId===pkg.restId?"⭐ ":""}{c.name}{load!=null?" ("+load+"/"+max+")":""}{isFull?" 🔴 DOLU":""}
                      </option>
                    );
                  })}
                </select>
              )}
              {["Atandı","Teslimat Aşamasında","Teslim Edildi"].map(s=>(
                <button key={s} onClick={()=>onAction(pkg.id,"status",s)} style={{padding:"6px 12px",borderRadius:7,border:"1.5px solid "+(pkg.status===s?STATUS_COLORS[s]||"#8e8e93":"#e5e5ea"),background:pkg.status===s?STATUS_COLORS[s]||"#8e8e93":"#fff",color:pkg.status===s?"#fff":"#636366",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                  {s==="Atandı"?"Ata":s==="Teslimat Aşamasında"?"Yolda":"✅ Teslim"}
                </button>
              ))}
              {pkg.status!=="İptal"&&pkg.status!=="Teslim Edildi"&&(
                <button onClick={()=>onAction(pkg.id,"status","İptal")} style={{padding:"6px 12px",borderRadius:7,border:"1.5px solid #e5e5ea",background:"#fff",color:"#9e9e9e",fontSize:11,fontWeight:700,cursor:"pointer"}}>İptal</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BizLocationModal({rest,onClose}){
  const mapsUrl = "https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(rest.address||rest.name);
  return(
    <div style={{position:"fixed",inset:0,background:"#fff",zIndex:600,display:"flex",flexDirection:"column",maxWidth:430,margin:"0 auto"}}>
      <div style={{background:"#fff",padding:"12px 16px",borderBottom:"1px solid #e5e5ea",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
        <p style={{fontWeight:700,fontSize:13}}>🏪 {rest.name}</p>
        <button onClick={onClose} style={{background:"#f2f2f7",border:"none",borderRadius:8,padding:"6px 14px",fontSize:11,fontWeight:700,color:"#636366",cursor:"pointer"}}>✕ Kapat</button>
      </div>
      <div style={{position:"relative",flex:1,background:"#e8f0e8",overflow:"hidden",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <svg width="100%" height="100%" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice" style={{position:"absolute",inset:0}}>
          <rect width="400" height="400" fill="#e8f0e8"/>
          {[0,1,2,3,4,5,6,7].map(i=>(
            <g key={i}>
              <line x1={i*50} y1="0" x2={i*50} y2="400" stroke="rgba(255,255,255,.35)" strokeWidth="1"/>
              <line x1="0" y1={i*50} x2="400" y2={i*50} stroke="rgba(255,255,255,.35)" strokeWidth="1"/>
            </g>
          ))}
          <path d="M 0,200 Q 150,180 250,210 Q 320,230 400,190" fill="none" stroke="#fff" strokeWidth="14" strokeLinecap="round" opacity=".85"/>
        </svg>
        <div style={{position:"relative",zIndex:2,display:"flex",flexDirection:"column",alignItems:"center"}}>
          <div style={{width:54,height:54,borderRadius:"50% 50% 50% 0",background:"#e53935",transform:"rotate(-45deg)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 12px rgba(0,0,0,.25)",marginBottom:18}}>
            <span style={{transform:"rotate(45deg)",fontSize:22}}>🏪</span>
          </div>
          <div style={{background:"#fff",borderRadius:10,padding:"10px 16px",boxShadow:"0 2px 8px rgba(0,0,0,.12)",maxWidth:260,textAlign:"center"}}>
            <p style={{fontWeight:700,fontSize:13,color:"#1c1c1e"}}>{rest.name}</p>
            <p style={{fontSize:11,color:"#8e8e93",marginTop:3}}>{rest.address||"Adres tanımlı değil"}</p>
          </div>
        </div>
      </div>
      <div style={{padding:"12px 14px",borderTop:"1px solid #e5e5ea",flexShrink:0}}>
        <a href={mapsUrl} target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,width:"100%",padding:"13px",background:"#1e88e5",color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700,textDecoration:"none"}}>
          🧭 Google Haritalar'da Yol Tarifi Al
        </a>
      </div>
    </div>
  );
}

function MapModal({db,onClose,title}){
  const [sel,setSel]=useState(null);
  const sc={active:"#4caf50",break:"#f9a825",off:"#9e9e9e"};
  const withCoords = db.couriers.filter(c=>c.lat && c.lng);
  const mapCenter = withCoords[0] ? [withCoords[0].lat,withCoords[0].lng] : [36.8969, 30.7133]; // Antalya varsayılan

  return(
    <div style={{position:"fixed",inset:0,background:"#fff",zIndex:500,display:"flex",flexDirection:"column",maxWidth:430,margin:"0 auto"}}>
      <div style={{background:"#fff",padding:"9px 12px",borderBottom:"1px solid #e5e5ea",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
        <p style={{fontWeight:700,fontSize:11}}>🗺️ {title||"Canlı Harita"}</p>
        <button onClick={onClose} style={{background:"#f2f2f7",border:"none",borderRadius:8,padding:"6px 14px",fontSize:11,fontWeight:700,color:"#636366",cursor:"pointer"}}>✕ Kapat</button>
      </div>
      <div style={{position:"relative",flex:1,background:"#e8f0e8",overflow:"hidden"}}>
        {withCoords.length>0 ? (
          <MapContainer center={mapCenter} zoom={12} style={{height:"100%",width:"100%"}} scrollWheelZoom={true}>
            <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
            {withCoords.map(c=>(
              <Marker key={c.id} position={[c.lat,c.lng]} icon={coloredIcon(sc[c.status]||"#9e9e9e")} eventHandlers={{click:()=>setSel(sel?.id===c.id?null:c)}}>
                <Popup>
                  <strong>🛵 {c.name}</strong><br/>
                  <span style={{color:sc[c.status]}}>{c.status==="active"?"Aktif":c.status==="break"?"Mola":"Kapalı"}</span><br/>
                  {c.km}km · ₺{c.earnings}
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        ) : (
          <div style={{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8}}>
            <p style={{fontSize:13,color:"#8e8e93",fontWeight:600}}>📍 Henüz konum verisi yok</p>
            <p style={{fontSize:11,color:"#aeaeb2",textAlign:"center",maxWidth:240}}>Kurye "Aktif" durumuna geçtiğinde konumu otomatik olarak burada görünecek.</p>
          </div>
        )}
        <div style={{position:"absolute",top:10,left:10,background:"rgba(255,255,255,.92)",borderRadius:8,padding:"5px 12px",display:"flex",alignItems:"center",gap:6,zIndex:1000}}>
          <span style={{width:7,height:7,borderRadius:"50%",background:"#4caf50",display:"inline-block",animation:"pulse 1.5s infinite"}}/>
          <span style={{fontSize:11,fontWeight:700,color:"#4caf50"}}>CANLI</span>
        </div>
      </div>
      <div style={{background:"#fff",borderTop:"1px solid #e5e5ea",padding:"7px 11px",flexShrink:0}}>
        <div style={{display:"flex",gap:8,overflowX:"auto"}}>
          {db.couriers.map(c=>{
            const bg={active:"#e9f9ee",break:"#fff8e1",off:"#f2f2f7"}[c.status]||"#f2f2f7";
            const tc={active:"#4caf50",break:"#f9a825",off:"#9e9e9e"}[c.status]||"#9e9e9e";
            return(
              <div key={c.id} onClick={()=>setSel(sel?.id===c.id?null:c)} style={{flexShrink:0,background:bg,borderRadius:10,padding:"8px 12px",cursor:"pointer",border:"1.5px solid "+(sel?.id===c.id?tc:"transparent"),minWidth:100}}>
                <p style={{fontWeight:700,fontSize:11}}>{c.name.split(" ")[0]}</p>
                <p style={{fontSize:11,color:tc,fontWeight:600,marginTop:1}}>{c.status==="active"?"Aktif":c.status==="break"?"Mola":"Kapalı"}</p>
                <p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>{c.km}km·₺{c.earnings}{!c.lat&&" · 📍—"}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══ ADMIN ════════════════════════════════════════════════════════
function AdminApp({user,db,save,setUser,toast}){
  const [tab,setTab]=useState("packages");
  const [filter,setFilter]=useState("Hepsi");
  const [bolge,setBolge]=useState("Hepsi");
  const [showMap,setShowMap]=useState(false);
  const pendingBal=(db.balanceRequests||[]).filter(r=>r.status==="bekliyor").length;
  const pendingSignup=(db.signupRequests||[]).filter(r=>r.status==="bekliyor").length;
  const tabs=[
    {id:"packages",label:"Paket",   icon:"📦"},
    {id:"couriers",label:"Kuryeler",icon:"🛵",badge:pendingSignup>0?pendingSignup:0},
    {id:"business",label:"İşletme", icon:"🏪",badge:pendingBal+((db.signupRequests||[]).filter(r=>r.status==="bekliyor"&&r.role==="restaurant").length)},
    {id:"profile", label:"Profil",  icon:"👤"},
  ];
  const act=(pkgId,type,value)=>{
    if(type==="status"){save({...db,packages:db.packages.map(p=>p.id===pkgId?{...p,status:value}:p)});toast("#"+pkgId+" → "+value,"success");}
    else if(type==="assign"){const c=db.couriers.find(c=>c.id===value);save({...db,packages:db.packages.map(p=>p.id===pkgId?{...p,courierId:value,courier:c?.name||"",status:"Atandı"}:p)});toast("Atandı: "+c?.name,"success");}
  };
  const shown=db.packages.filter(p=>{if(filter==="Hepsi")return true;if(filter==="Geç Kalan")return p.status==="Oluşturuldu"||p.status==="Manuel Atama Bekliyor";return p.status===filter;});
  return(
    <div style={{display:"flex",flexDirection:"column",flex:1,minHeight:"100vh"}}>
      {showMap&&<MapModal db={db} onClose={()=>setShowMap(false)} title="Admin Harita"/>}
      {tab==="packages"&&<><TopBar bolge={bolge} setBolge={setBolge} filter={filter} setFilter={setFilter} onMapClick={()=>setShowMap(true)}/><div style={{flex:1,overflowY:"auto",background:"#fff"}}>{shown.length===0?<p style={{textAlign:"center",padding:"48px 20px",color:"#8e8e93"}}>Paket bulunamadı</p>:shown.map(p=><PkgRow key={p.id} pkg={p} onAction={act} couriers={db.couriers} allPackages={db.packages} settings={db.settings}/>)}</div></>}
      {tab==="couriers"&&<AdminCouriers db={db} save={save} toast={toast}/>}
      {tab==="business"&&<AdminBusiness db={db} save={save} toast={toast}/>}
      {tab==="profile"&&<AdminSettings user={user} db={db} save={save} setUser={setUser} toast={toast}/>}
      <BottomNav tabs={tabs} active={tab} setActive={setTab}/>
    </div>
  );
}

function AdminCouriers({db,save,toast}){
  const [showAdd,setShowAdd]=useState(false);
  const [form,setForm]=useState({id:"",name:"",phone:"",pw:""});
  const statusMap={active:{bg:"#e9f9ee",col:"#4caf50",lbl:"Aktif"},break:{bg:"#fff8e1",col:"#f9a825",lbl:"Mola"},off:{bg:"#f2f2f7",col:"#8e8e93",lbl:"Kapalı"}};
  const add=()=>{if(!form.id||!form.name)return;save({...db,users:{...db.users,[form.id]:{id:form.id,role:"courier",name:form.name,pw:form.pw||"1234"}},couriers:[...db.couriers,{id:form.id,name:form.name,status:"off",km:0,earnings:0,bonus:0,packages:0,phone:form.phone,balance:0,priorityRestId:null,region:null}]});toast(form.name+" eklendi","success");setForm({id:"",name:"",phone:"",pw:""});setShowAdd(false);};
  const setStatus=(id,s)=>save({...db,couriers:db.couriers.map(c=>c.id===id?{...c,status:s}:c)});
  const setPriority=(id,restId)=>{
    save({...db,couriers:db.couriers.map(c=>c.id===id?{...c,priorityRestId:restId||null}:c)});
    const rest = db.restaurants.find(r=>r.id===restId);
    toast(restId?("Öncelik tanımlandı: "+(rest?.name||restId)):"Öncelik kaldırıldı","success");
  };
  const setRegion=(id,region)=>{
    save({...db,couriers:db.couriers.map(c=>c.id===id?{...c,region:region||null}:c)});
    toast(region?("Bölge tanımlandı: "+region):"Bölge kaldırıldı","success");
  };
  const remove=id=>{const u={...db.users};delete u[id];save({...db,users:u,couriers:db.couriers.filter(c=>c.id!==id)});toast("Silindi","info");};
  const pendingSignups = (db.signupRequests||[]).filter(r=>r.status==="bekliyor"&&r.role==="courier");
  const approveSignup = req => {
    if(db.users[req.userId]){ toast("Bu kullanıcı adı artık alınmış","error"); return; }
    const newCourier = {id:req.userId,name:req.name,status:"off",km:0,earnings:0,bonus:0,packages:0,phone:req.phone,balance:0,priorityRestId:null,region:null,plate:req.plate||"",tc:req.tc||""};
    save({
      ...db,
      users:{...db.users,[req.userId]:{id:req.userId,role:"courier",name:req.name,pw:req.pw}},
      couriers:[...db.couriers,newCourier],
      signupRequests:(db.signupRequests||[]).map(r=>r.id===req.id?{...r,status:"onaylandı"}:r),
    });
    toast(req.name+" onaylandı ve eklendi","success");
  };
  const rejectSignup = req => {
    save({...db,signupRequests:(db.signupRequests||[]).map(r=>r.id===req.id?{...r,status:"reddedildi"}:r)});
    toast("Başvuru reddedildi","info");
  };
  return(
    <div style={{flex:1,overflowY:"auto",background:"#f2f2f7"}}>
      <div style={{background:"#fff",padding:"9px 12px",borderBottom:"1px solid #e5e5ea",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:10}}>
        <p style={{fontWeight:700,fontSize:14}}>🛵 Kuryeler</p>
        <button onClick={()=>setShowAdd(v=>!v)} style={{background:"#e53935",color:"#fff",border:"none",borderRadius:9,padding:"7px 16px",fontSize:11,fontWeight:700,cursor:"pointer"}}>+ Ekle</button>
      </div>
      {pendingSignups.length>0&&(
        <div style={{padding:"12px 12px 0"}}>
          <p style={{fontWeight:700,fontSize:11,color:"#f9a825",marginBottom:8,textTransform:"uppercase",letterSpacing:.4}}>🔔 Bekleyen Kurye Başvuruları ({pendingSignups.length})</p>
          {pendingSignups.map(req=>(
            <div key={req.id} style={{background:"#fff",borderRadius:12,padding:"12px 14px",marginBottom:8,borderLeft:"3px solid #f9a825",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div>
                  <p style={{fontWeight:700,fontSize:13}}>{req.name}</p>
                  <p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>{req.userId} · {req.phone||"—"} · {req.date} {req.time}</p>
                  {req.tc&&<p style={{fontSize:11,color:"#636366",fontWeight:600,marginTop:3}}>🪪 T.C.: {req.tc}</p>}
                  {req.plate&&<p style={{fontSize:11,color:"#1e88e5",fontWeight:700,marginTop:3}}>🏍️ Plaka: {req.plate}</p>}
                  <p style={{fontSize:11,fontWeight:700,marginTop:3,color:req.contractAccepted?"#4caf50":"#e53935"}}>{req.contractAccepted?"✅ Sözleşme onaylandı":"⚠️ Sözleşme onaylanmadı"}</p>
                </div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>approveSignup(req)} style={{flex:1,padding:"8px",background:"#4caf50",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>✅ Onayla</button>
                <button onClick={()=>rejectSignup(req)} style={{padding:"8px 16px",background:"#fdecea",color:"#e53935",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>❌ Reddet</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showAdd&&<div style={{margin:12,background:"#fff",borderRadius:12,padding:16,borderLeft:"3px solid #e53935",boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
        <p style={{fontWeight:700,marginBottom:12,fontSize:11}}>Yeni Kurye</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
          {[["id","Kullanıcı Adı","k04"],["name","Ad Soyad","Ad Soyad"],["phone","Tel","0532..."],["pw","Şifre","1234"]].map(([k,l,ph])=>(
            <div key={k}><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>{l}</p><input value={form[k]} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))} placeholder={ph} style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/></div>
          ))}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={add} style={{padding:"9px 20px",background:"#e53935",color:"#fff",border:"none",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer"}}>Kaydet</button>
          <button onClick={()=>setShowAdd(false)} style={{padding:"9px 20px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:9,fontSize:11,cursor:"pointer"}}>İptal</button>
        </div>
      </div>}
      <div style={{padding:"8px 12px",display:"flex",flexDirection:"column",gap:10}}>
        {db.couriers.map(c=>{
          const sm=statusMap[c.status]||statusMap.off;
          const priorityRest = c.priorityRestId ? db.restaurants.find(r=>r.id===c.priorityRestId) : null;
          return(
            <div key={c.id} style={{background:"#fff",borderRadius:12,padding:"10px 12px",boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                <div><p style={{fontWeight:700,fontSize:11}}>{c.name}</p><p style={{fontSize:11,color:"#8e8e93",marginTop:2}}>{c.id} · {c.phone||"—"}{c.plate?" · 🏍️ "+c.plate:""}</p></div>
                <span style={{background:sm.bg,color:sm.col,borderRadius:8,padding:"3px 10px",fontSize:11,fontWeight:700}}>{sm.lbl}</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:10}}>
                {[["📦",c.packages,"Paket"],["🛣️",c.km+"km","KM"],["💰","₺"+c.earnings,"Kazanç"]].map(([ic,v,l])=>(
                  <div key={l} style={{background:"#f2f2f7",borderRadius:9,padding:"8px 6px",textAlign:"center"}}><p style={{fontSize:11,fontWeight:700}}>{v}</p><p style={{fontSize:11,color:"#8e8e93",marginTop:2}}>{l}</p></div>
                ))}
              </div>

              {/* Çalışma bölgesi seçici */}
              <div style={{background:c.region?"#e0f7fa":"#f9f9f9",borderRadius:9,padding:"8px 10px",marginBottom:8,border:c.region?"1px solid #00acc1":"1px solid transparent"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                  <span style={{fontSize:12}}>📍</span>
                  <p style={{fontSize:11,fontWeight:700,color:c.region?"#00acc1":"#636366"}}>Çalışma Bölgesi</p>
                </div>
                <select value={c.region||""} onChange={e=>setRegion(c.id,e.target.value)}
                  style={{width:"100%",padding:"7px 9px",border:"1.5px solid "+(c.region?"#00acc1":"#e5e5ea"),borderRadius:8,fontSize:11,outline:"none",background:"#fff",color:"#1c1c1e",fontWeight:c.region?700:500}}>
                  <option value="">— Bölge atanmadı (tüm bölgeler) —</option>
                  {BOLGE.filter(b=>b!=="Hepsi").map(b=><option key={b} value={b}>{b}</option>)}
                </select>
                {c.region&&<p style={{fontSize:10,color:"#8e8e93",marginTop:4}}>Kurye {c.region} bölgesinde çalışıyor.</p>}
              </div>

              {/* Öncelikli mağaza seçici */}
              <div style={{background:priorityRest?"#fff8e1":"#f9f9f9",borderRadius:9,padding:"8px 10px",marginBottom:10,border:priorityRest?"1px solid #f9a825":"1px solid transparent"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                  <span style={{fontSize:12}}>⭐</span>
                  <p style={{fontSize:11,fontWeight:700,color:priorityRest?"#f9a825":"#636366"}}>Öncelikli Mağaza</p>
                </div>
                <select value={c.priorityRestId||""} onChange={e=>setPriority(c.id,e.target.value)}
                  style={{width:"100%",padding:"7px 9px",border:"1.5px solid "+(priorityRest?"#f9a825":"#e5e5ea"),borderRadius:8,fontSize:11,outline:"none",background:"#fff",color:"#1c1c1e",fontWeight:priorityRest?700:500}}>
                  <option value="">— Öncelik yok (genel sıraya gir) —</option>
                  {db.restaurants.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                {priorityRest&&<p style={{fontSize:10,color:"#8e8e93",marginTop:4}}>Bu mağazadan gelen paketler, kurye aktifse önce buna atanır.</p>}
              </div>

              <div style={{display:"flex",gap:6}}>
                {[["Aktif","active","#4caf50"],["Mola","break","#f9a825"],["Kapat","off","#8e8e93"]].map(([lbl,val,col])=>(
                  <button key={val} onClick={()=>setStatus(c.id,val)} style={{flex:1,padding:"7px 0",borderRadius:8,fontSize:11,fontWeight:700,background:c.status===val?col:"#f2f2f7",color:c.status===val?"#fff":"#636366",border:"none",cursor:"pointer"}}>{lbl}</button>
                ))}
                <button onClick={()=>remove(c.id)} style={{padding:"7px 12px",borderRadius:8,border:"none",background:"#fdecea",color:"#e53935",fontSize:11,cursor:"pointer"}}>🗑️</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AdminBusiness({db,save,toast}){
  const [showAdd,setShowAdd]=useState(false);
  const [form,setForm]=useState({id:"",name:"",phone:"",pw:"",address:"",region:""});
  const addRest=async()=>{
    if(!form.id||!form.name)return;
    const coords = await geocodeAddress(form.address);
    save({...db,users:{...db.users,[form.id]:{id:form.id,role:"restaurant",name:form.name,pw:form.pw||"1234"}},restaurants:[...db.restaurants,{id:form.id,name:form.name,balance:0,totalPackages:0,contact:form.phone,address:form.address,region:form.region||null,lat:coords?.lat??null,lng:coords?.lng??null}]});
    toast(form.name+" eklendi"+(coords?"":" (konum bulunamadı, harita gösteremeyebilir)"),coords?"success":"warning");
    setForm({id:"",name:"",phone:"",pw:"",address:"",region:""});
    setShowAdd(false);
  };
  const setRegion=(id,region)=>{
    save({...db,restaurants:db.restaurants.map(r=>r.id===id?{...r,region:region||null}:r)});
    toast(region?("Bölge tanımlandı: "+region):"Bölge kaldırıldı","success");
  };
  const pendingSignups = (db.signupRequests||[]).filter(r=>r.status==="bekliyor"&&r.role==="restaurant");
  const approveSignup = async req => {
    if(db.users[req.userId]){ toast("Bu kullanıcı adı artık alınmış","error"); return; }
    const coords = await geocodeAddress(req.address);
    const newRest = {id:req.userId,name:req.name,balance:0,totalPackages:0,contact:req.phone,address:req.address,taxNo:req.taxNo||"",taxOffice:req.taxOffice||"",region:null,lat:coords?.lat??null,lng:coords?.lng??null};
    save({
      ...db,
      users:{...db.users,[req.userId]:{id:req.userId,role:"restaurant",name:req.name,pw:req.pw}},
      restaurants:[...db.restaurants,newRest],
      signupRequests:(db.signupRequests||[]).map(r=>r.id===req.id?{...r,status:"onaylandı"}:r),
    });
    toast(req.name+" onaylandı ve eklendi","success");
  };
  const rejectSignup = req => {
    save({...db,signupRequests:(db.signupRequests||[]).map(r=>r.id===req.id?{...r,status:"reddedildi"}:r)});
    toast("Başvuru reddedildi","info");
  };
  return(
    <div style={{flex:1,overflowY:"auto",background:"#f2f2f7"}}>
      <div style={{background:"#fff",padding:"9px 12px",borderBottom:"1px solid #e5e5ea",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:10}}>
        <p style={{fontWeight:700,fontSize:14}}>🏪 İşletmeler</p>
        <button onClick={()=>setShowAdd(v=>!v)} style={{background:"#e53935",color:"#fff",border:"none",borderRadius:9,padding:"7px 16px",fontSize:11,fontWeight:700,cursor:"pointer"}}>+ Ekle</button>
      </div>
      {pendingSignups.length>0&&(
        <div style={{padding:"12px 12px 0"}}>
          <p style={{fontWeight:700,fontSize:11,color:"#f9a825",marginBottom:8,textTransform:"uppercase",letterSpacing:.4}}>🔔 Bekleyen Başvurular ({pendingSignups.length})</p>
          {pendingSignups.map(req=>(
            <div key={req.id} style={{background:"#fff",borderRadius:12,padding:"12px 14px",marginBottom:8,borderLeft:"3px solid #f9a825",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
              <div style={{marginBottom:8}}>
                <p style={{fontWeight:700,fontSize:13}}>{req.name}</p>
                <p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>{req.userId} · {req.phone||"—"}</p>
                {req.address&&<p style={{fontSize:11,color:"#8e8e93",marginTop:2}}>📍 {req.address}</p>}
                {req.taxNo&&<p style={{fontSize:11,color:"#636366",fontWeight:600,marginTop:2}}>🏛️ Vergi No: {req.taxNo} · {req.taxOffice||"—"}</p>}
                <p style={{fontSize:11,fontWeight:700,marginTop:3,color:req.contractAccepted?"#4caf50":"#e53935"}}>{req.contractAccepted?"✅ Sözleşme onaylandı":"⚠️ Sözleşme onaylanmadı"}</p>
                <p style={{fontSize:10,color:"#aeaeb2",marginTop:2}}>{req.date} {req.time}</p>
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>approveSignup(req)} style={{flex:1,padding:"8px",background:"#4caf50",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>✅ Onayla</button>
                <button onClick={()=>rejectSignup(req)} style={{padding:"8px 16px",background:"#fdecea",color:"#e53935",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>❌ Reddet</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showAdd&&<div style={{margin:12,background:"#fff",borderRadius:12,padding:16,borderLeft:"3px solid #e53935",boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
        <p style={{fontWeight:700,marginBottom:12,fontSize:11}}>Yeni İşletme</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
          {[["id","ID","rest04"],["name","İsim","..."],["phone","Tel","0532..."],["pw","Şifre","1234"]].map(([k,l,ph])=>(
            <div key={k}><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>{l}</p><input value={form[k]} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))} placeholder={ph} style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/></div>
          ))}
        </div>
        <div style={{marginBottom:12}}>
          <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>İşletme Adresi</p>
          <input value={form.address} onChange={e=>setForm(f=>({...f,address:e.target.value}))} placeholder="Mahalle, cadde, no, şehir" style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
          <p style={{fontSize:10,color:"#aeaeb2",marginTop:3}}>Kurye bu adrese Google Haritalar üzerinden gidebilir</p>
        </div>
        <div style={{marginBottom:12}}>
          <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,marginBottom:4,textTransform:"uppercase"}}>Bölge</p>
          <select value={form.region} onChange={e=>setForm(f=>({...f,region:e.target.value}))}
            style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}>
            <option value="">— Bölge seçilmedi —</option>
            {BOLGE.filter(b=>b!=="Hepsi").map(b=><option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={addRest} style={{padding:"9px 20px",background:"#e53935",color:"#fff",border:"none",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer"}}>Kaydet</button>
          <button onClick={()=>setShowAdd(false)} style={{padding:"9px 20px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:9,fontSize:11,cursor:"pointer"}}>İptal</button>
        </div>
      </div>}
      <div style={{padding:"12px",display:"flex",flexDirection:"column",gap:8}}>
        {db.restaurants.map(r=>(
          <div key={r.id} style={{background:"#fff",borderRadius:12,padding:"9px 12px",boxShadow:"0 1px 3px rgba(0,0,0,.06)",borderLeft:"3px solid "+(r.balance===0?"#e53935":r.balance<100?"#f9a825":"#4caf50")}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div><p style={{fontWeight:700,fontSize:11}}>{r.name}</p><p style={{fontSize:11,color:"#8e8e93",marginTop:2}}>{r.totalPackages} paket · {r.contact||"—"}</p>{r.taxNo&&<p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>🏛️ {r.taxNo} · {r.taxOffice||"—"}</p>}</div>
              <div style={{textAlign:"right"}}><p style={{fontWeight:800,fontSize:11,color:r.balance===0?"#e53935":r.balance<100?"#f9a825":"#4caf50"}}>₺{r.balance}</p><p style={{fontSize:11,fontWeight:700,color:r.balance===0?"#e53935":r.balance<100?"#f9a825":"#4caf50"}}>{r.balance===0?"Bakiye Yok":r.balance<100?"Düşük":"Aktif"}</p></div>
            </div>
            <div style={{background:r.region?"#e0f7fa":"#f9f9f9",borderRadius:9,padding:"8px 10px",border:r.region?"1px solid #00acc1":"1px solid transparent"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
                <span style={{fontSize:12}}>📍</span>
                <p style={{fontSize:11,fontWeight:700,color:r.region?"#00acc1":"#636366"}}>Bölge</p>
              </div>
              <select value={r.region||""} onChange={e=>setRegion(r.id,e.target.value)}
                style={{width:"100%",padding:"7px 9px",border:"1.5px solid "+(r.region?"#00acc1":"#e5e5ea"),borderRadius:8,fontSize:11,outline:"none",background:"#fff",color:"#1c1c1e",fontWeight:r.region?700:500}}>
                <option value="">— Bölge atanmadı —</option>
                {BOLGE.filter(b=>b!=="Hepsi").map(b=><option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminBusinessFinance({db,save,toast}){
  const [loadId,setLoadId]=useState("");const [loadAmt,setLoadAmt]=useState("");
  const pending=(db.balanceRequests||[]).filter(r=>r.status==="bekliyor");
  const loadBal=(rid,amt,reqId)=>{const a=parseFloat(amt||loadAmt);const id=rid||loadId;if(!id||isNaN(a)||a<=0)return;const rest=db.restaurants.find(r=>r.id===id);const updR=db.restaurants.map(r=>r.id===id?{...r,balance:r.balance+a}:r);const tx={id:genId(),restId:id,restName:rest?.name,amount:a,time:nowTime(),date:todayStr()};const updReqs=reqId?(db.balanceRequests||[]).map(r=>r.id===reqId?{...r,status:"onaylandı"}:r):(db.balanceRequests||[]);save({...db,restaurants:updR,transactions:[...(db.transactions||[]),tx],balanceRequests:updReqs});toast("₺"+a+" yüklendi → "+rest?.name,"success");setLoadAmt("");setLoadId("");};
  const reject=reqId=>{save({...db,balanceRequests:(db.balanceRequests||[]).map(r=>r.id===reqId?{...r,status:"reddedildi"}:r)});toast("Reddedildi","info");};
  const txs=[...(db.transactions||[])].reverse();
  return(
    <div style={{padding:12,display:"flex",flexDirection:"column",gap:10}}>
      {pending.length>0&&<div>
        <p style={{fontWeight:700,fontSize:11,color:"#f9a825",marginBottom:8,textTransform:"uppercase"}}>🔔 Bekleyen ({pending.length})</p>
        {pending.map(req=>(
          <div key={req.id} style={{background:"#fff",borderRadius:12,padding:"8px 12px",marginBottom:8,borderLeft:"3px solid #f9a825",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div><p style={{fontWeight:700,fontSize:11}}>{req.restName}</p><p style={{fontSize:11,color:"#8e8e93"}}>{req.date} {req.time}</p></div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <p style={{fontWeight:800,fontSize:11,color:"#f9a825"}}>₺{req.amount}</p>
                <button onClick={()=>loadBal(req.restId,req.amount,req.id)} style={{padding:"7px 12px",background:"#4caf50",color:"#fff",border:"none",borderRadius:8,fontSize:11,fontWeight:700,cursor:"pointer"}}>✅ Onayla</button>
                <button onClick={()=>reject(req.id)} style={{padding:"7px 10px",background:"#fdecea",color:"#e53935",border:"none",borderRadius:8,fontSize:11,cursor:"pointer"}}>❌</button>
              </div>
            </div>
          </div>
        ))}
      </div>}
      <div style={{background:"#fff",borderRadius:12,padding:14,boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
        <p style={{fontWeight:700,fontSize:11,marginBottom:10}}>Bakiye Yükle</p>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <select value={loadId} onChange={e=>setLoadId(e.target.value)} style={{flex:2,padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}>
            <option value="">İşletme seçin...</option>
            {db.restaurants.map(r=><option key={r.id} value={r.id}>{r.name} — ₺{r.balance}</option>)}
          </select>
          <input type="number" value={loadAmt} onChange={e=>setLoadAmt(e.target.value)} placeholder="₺ Tutar" style={{flex:1,padding:"9px 10px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
        </div>
        <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
          {[100,250,500,1000].map(p=><button key={p} onClick={()=>setLoadAmt(String(p))} style={{padding:"6px 12px",borderRadius:7,border:"1.5px solid "+(loadAmt===String(p)?"#e53935":"#e5e5ea"),background:loadAmt===String(p)?"#e53935":"#fff",color:loadAmt===String(p)?"#fff":"#636366",fontSize:11,fontWeight:700,cursor:"pointer"}}>₺{p}</button>)}
        </div>
        <button onClick={()=>loadBal()} disabled={!loadId||!loadAmt} style={{width:"100%",padding:"10px",background:loadId&&loadAmt?"#e53935":"#e5e5ea",color:loadId&&loadAmt?"#fff":"#8e8e93",border:"none",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer"}}>Yükle</button>
      </div>
      <div style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
        <div style={{padding:"7px 11px",borderBottom:"1px solid #f2f2f7"}}><p style={{fontWeight:700,fontSize:11}}>Cari Hesaplar</p></div>
        {db.restaurants.map(r=>(
          <div key={r.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 11px",borderBottom:"1px solid #f2f2f7"}}>
            <div><p style={{fontWeight:600,fontSize:11}}>{r.name}</p><p style={{fontSize:11,color:"#8e8e93"}}>{r.totalPackages} paket</p></div>
            <p style={{fontWeight:800,fontSize:11,color:r.balance===0?"#e53935":r.balance<100?"#f9a825":"#4caf50"}}>₺{r.balance}</p>
          </div>
        ))}
      </div>
      {txs.length>0&&<div style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
        <div style={{padding:"7px 11px",borderBottom:"1px solid #f2f2f7"}}><p style={{fontWeight:700,fontSize:11}}>İşlem Geçmişi</p></div>
        {txs.slice(0,8).map(t=>(
          <div key={t.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 11px",borderBottom:"1px solid #f2f2f7"}}>
            <div><p style={{fontWeight:600,fontSize:11}}>{t.restName}</p><p style={{fontSize:11,color:"#8e8e93"}}>{t.date} {t.time}</p></div>
            <p style={{fontWeight:700,fontSize:11,color:"#4caf50"}}>+₺{t.amount}</p>
          </div>
        ))}
      </div>}
    </div>
  );
}

function AdminCourierFinanceView({db,save,toast}){
  const s = db.settings||{};
  const [selId,setSelId] = useState(null);
  const [txType,setTxType] = useState("add");
  const [amount,setAmount] = useState("");
  const [note,setNote] = useState("");
  const [feeForm,setFeeForm] = useState(null);
  const [showRecon,setShowRecon] = useState(false);
  const [reconFrom,setReconFrom] = useState("");
  const [reconTo,setReconTo] = useState("");

  const getBal = c => c.balance||0;

  const applyTx = (courierId) => {
    const amt = parseFloat(amount);
    if(!courierId||isNaN(amt)||amt<=0) return;
    const courier = db.couriers.find(c=>c.id===courierId);
    const curBal = getBal(courier);
    const newBal = txType==="add" ? curBal+amt : curBal-amt;
    const labels = {add:"Bakiye Yükleme",sub:"Bakiye Kesinti",avans:"Avans"};
    const tx = {id:genId(),courierId,courierName:courier.name,type:labels[txType],amount:txType==="add"?+amt:-amt,note,time:nowTime(),date:todayStr()};
    const updCouriers = db.couriers.map(c=>c.id===courierId?{...c,balance:newBal}:c);
    save({...db,couriers:updCouriers,courierTransactions:[...(db.courierTransactions||[]),tx]});
    toast(courier.name+" → "+labels[txType]+" ₺"+amt,"success");
    setAmount("");setNote("");setSelId(null);
  };

  const openFeeForm = c => {
    const cf = s.courierFees?.[c.id];
    setFeeForm({packageFee:cf?.packageFee??s.courierEarn??25,kmInterval:cf?.kmInterval??s.kmInterval??1,kmFee:cf?.kmFee??s.kmFee??2.5});
  };
  const saveFee = courierId => {
    save({...db,settings:{...s,courierFees:{...(s.courierFees||{}),[courierId]:feeForm}}});
    toast("Özel ücret kaydedildi","success");
    setFeeForm(null);
  };
  const clearFee = courierId => {
    const cf = {...(s.courierFees||{})};
    delete cf[courierId];
    save({...db,settings:{...s,courierFees:cf}});
    toast("Genel ayara döndürüldü","info");
    setFeeForm(null);
  };

  // Kurye özel maks. paket limiti
  const [maxPkgsEdit,setMaxPkgsEdit] = useState(null); // {courierId, value}
  const saveMaxPkgs = () => {
    if(!maxPkgsEdit) return;
    save({...db,settings:{...s,courierMaxPkgs:{...(s.courierMaxPkgs||{}),[maxPkgsEdit.courierId]:maxPkgsEdit.value}}});
    toast("Maks. paket limiti kaydedildi","success");
    setMaxPkgsEdit(null);
  };
  const clearMaxPkgs = courierId => {
    const cm = {...(s.courierMaxPkgs||{})};
    delete cm[courierId];
    save({...db,settings:{...s,courierMaxPkgs:cm}});
    toast("Genel limite döndürüldü","info");
    setMaxPkgsEdit(null);
  };

  // Tarih aralığı parse: t.date "DD.MM.YYYY" formatında (todayStr()), from/to input'lar "YYYY-MM-DD" formatında gelir
  const parseDate = d => {
    if(!d) return null;
    const [day,month,year] = d.split(".").map(Number);
    return new Date(year,month-1,day);
  };
  const inRange = (txDate,from,to) => {
    const d = parseDate(txDate);
    if(!d) return false;
    if(from){ const f=new Date(from+"T00:00:00"); if(d<f) return false; }
    if(to){ const t=new Date(to+"T23:59:59"); if(d>t) return false; }
    return true;
  };

  const openRecon = c => {
    setShowRecon(c.id);
    setReconFrom("");setReconTo("");
  };

  const confirmReconciliation = (courierId) => {
    const courier = db.couriers.find(c=>c.id===courierId);
    const txsInRange = (db.courierTransactions||[]).filter(t=>t.courierId===courierId&&inRange(t.date,reconFrom,reconTo));
    const total = txsInRange.reduce((sum,t)=>sum+t.amount,0);
    const recon = {
      id:genId(), courierId, courierName:courier.name,
      from:reconFrom, to:reconTo,
      txCount:txsInRange.length, total,
      confirmedAt:nowTime(), confirmedDate:todayStr(),
    };
    save({...db, reconciliations:[...(db.reconciliations||[]),recon]});
    toast(courier.name+" için mutabakat kaydedildi","success");
    setShowRecon(false);
  };

  const TX = [
    {id:"add",  label:"+ Bakiye Ekle", color:"#4caf50",bg:"#e9f9ee"},
    {id:"sub",  label:"− Bakiye Kes",  color:"#e53935",bg:"#fdecea"},
    {id:"avans",label:"💸 Avans",       color:"#f9a825",bg:"#fff8e1"},
  ];

  return(
    <div style={{padding:12,display:"flex",flexDirection:"column",gap:10}}>
      {/* Özet */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
        {[
          ["Toplam Bakiye","₺"+db.couriers.reduce((s,c)=>s+(c.balance||0),0).toFixed(2),"#4caf50"],
          ["Toplam Avans","₺"+Math.abs(db.couriers.filter(c=>(c.balance||0)<0).reduce((s,c)=>s+(c.balance||0),0)).toFixed(2),"#f9a825"],
          ["Aktif Kurye",db.couriers.filter(c=>c.status==="active").length,"#1e88e5"],
        ].map(([l,v,col])=>(
          <div key={l} style={{background:"#fff",borderRadius:10,padding:"10px 8px",textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
            <p style={{fontSize:16,fontWeight:800,color:col,lineHeight:1}}>{v}</p>
            <p style={{fontSize:11,color:"#8e8e93",marginTop:3,fontWeight:600}}>{l}</p>
          </div>
        ))}
      </div>

      {/* Kurye kartları */}
      {db.couriers.map(c=>{
        const bal = getBal(c);
        const isOpen = selId===c.id;
        const sCol = {active:"#4caf50",break:"#f9a825",off:"#9e9e9e"}[c.status]||"#9e9e9e";
        const txs = [...(db.courierTransactions||[])].filter(t=>t.courierId===c.id).reverse().slice(0,6);
        const selTX = TX.find(t=>t.id===txType)||TX[0];
        const cf = s.courierFees?.[c.id];
        const pkgFee = cf?.packageFee??s.courierEarn??25;
        const kmFee = cf?.kmFee??s.kmFee??2.5;
        const kmInt = cf?.kmInterval??s.kmInterval??1;
        const isEditingFee = isOpen && feeForm!==null;
        const maxPkgs = s.courierMaxPkgs?.[c.id] ?? s.maxPkgs ?? 10;
        const hasCustomMax = s.courierMaxPkgs?.[c.id]!=null;
        const currentLoad = activeLoadOf(c.id, db.packages);
        const isEditingMaxPkgs = isOpen && maxPkgsEdit?.courierId===c.id;

        return(
          <div key={c.id} style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
            <button onClick={()=>{setSelId(isOpen?null:c.id);setFeeForm(null);}} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 14px",width:"100%",border:"none",borderBottom:isOpen?"1px solid #f2f2f7":"none",background:"transparent",cursor:"pointer",textAlign:"left"}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:9,height:9,borderRadius:"50%",background:sCol,flexShrink:0}}/>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <p style={{fontWeight:700,fontSize:13,color:"#1c1c1e"}}>{c.name}</p>
                    {cf&&<span style={{fontSize:10,fontWeight:700,color:"#e53935",background:"#fdecea",borderRadius:6,padding:"1px 6px"}}>ÖZEL</span>}
                  </div>
                  <p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>{c.packages||0} paket · ₺{c.earnings||0} kazanç</p>
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{textAlign:"right"}}>
                  <p style={{fontWeight:800,fontSize:16,color:bal>=0?"#4caf50":"#e53935"}}>₺{bal.toFixed(2)}</p>
                  <p style={{fontSize:11,color:bal>=0?"#4caf50":"#e53935",fontWeight:700}}>{bal>0?"Bakiye":bal<0?"Borçlu":"Sıfır"}</p>
                </div>
                <span style={{color:"#c7c7cc",fontSize:13}}>{isOpen?"⌃":"⌄"}</span>
              </div>
            </button>

            {isOpen&&(
              <div style={{background:"#fafafa"}}>

                {/* Özel ücret bölümü */}
                <div style={{padding:"12px 14px",borderBottom:"1px solid #f2f2f7"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <p style={{fontSize:12,fontWeight:700,color:"#1c1c1e"}}>💰 Kurye Özel Ücret</p>
                    {!isEditingFee&&(
                      <div style={{display:"flex",gap:6}}>
                        {cf&&<button onClick={()=>clearFee(c.id)} style={{padding:"4px 9px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:6,fontSize:10,fontWeight:700,cursor:"pointer"}}>Sıfırla</button>}
                        <button onClick={()=>openFeeForm(c)} style={{padding:"4px 10px",background:"#1e88e5",color:"#fff",border:"none",borderRadius:6,fontSize:10,fontWeight:700,cursor:"pointer"}}>Düzenle</button>
                      </div>
                    )}
                  </div>

                  {!isEditingFee ? (
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
                      {[["Paket","₺"+pkgFee,"#4caf50"],["KM","₺"+kmFee,"#1e88e5"],["Kaç KM","Her "+kmInt+"km","#f9a825"]].map(([l,v,col])=>(
                        <div key={l} style={{background:"#fff",borderRadius:8,padding:"7px 4px",textAlign:"center",border:"1px solid #f2f2f7"}}>
                          <p style={{fontSize:13,fontWeight:800,color:col}}>{v}</p>
                          <p style={{fontSize:10,color:"#8e8e93",marginTop:2}}>{l}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:10}}>
                        <div>
                          <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:3}}>Paket Ücreti (₺)</p>
                          <input type="number" step="0.5" value={feeForm.packageFee} onChange={e=>setFeeForm(f=>({...f,packageFee:+e.target.value}))}
                            style={{width:"100%",padding:"7px 9px",border:"1.5px solid #e5e5ea",borderRadius:7,fontSize:12,outline:"none",background:"#fff",color:"#1c1c1e",fontWeight:600}}/>
                        </div>
                        <div>
                          <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:3}}>Kaç KM'de Bir</p>
                          <input type="number" step="0.5" value={feeForm.kmInterval} onChange={e=>setFeeForm(f=>({...f,kmInterval:+e.target.value}))}
                            style={{width:"100%",padding:"7px 9px",border:"1.5px solid #e5e5ea",borderRadius:7,fontSize:12,outline:"none",background:"#fff",color:"#1c1c1e",fontWeight:600}}/>
                        </div>
                        <div>
                          <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:3}}>KM Ücreti (₺)</p>
                          <input type="number" step="0.5" value={feeForm.kmFee} onChange={e=>setFeeForm(f=>({...f,kmFee:+e.target.value}))}
                            style={{width:"100%",padding:"7px 9px",border:"1.5px solid #e5e5ea",borderRadius:7,fontSize:12,outline:"none",background:"#fff",color:"#1c1c1e",fontWeight:600}}/>
                        </div>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={()=>saveFee(c.id)} style={{flex:1,padding:"8px",background:"#1e88e5",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>Kaydet</button>
                        <button onClick={()=>setFeeForm(null)} style={{padding:"8px 14px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:8,fontSize:12,cursor:"pointer"}}>İptal</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Maks. Paket Limiti */}
                <div style={{padding:"12px 14px",borderBottom:"1px solid #f2f2f7"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <p style={{fontSize:12,fontWeight:700,color:"#1c1c1e"}}>📦 Maks. Paket Limiti</p>
                    {!isEditingMaxPkgs&&(
                      <div style={{display:"flex",gap:6}}>
                        {hasCustomMax&&<button onClick={()=>clearMaxPkgs(c.id)} style={{padding:"4px 9px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:6,fontSize:10,fontWeight:700,cursor:"pointer"}}>Sıfırla</button>}
                        <button onClick={()=>setMaxPkgsEdit({courierId:c.id,value:maxPkgs})} style={{padding:"4px 10px",background:"#1e88e5",color:"#fff",border:"none",borderRadius:6,fontSize:10,fontWeight:700,cursor:"pointer"}}>Düzenle</button>
                      </div>
                    )}
                  </div>

                  {!isEditingMaxPkgs ? (
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{flex:1,background:"#fff",borderRadius:8,padding:"9px",textAlign:"center",border:"1px solid #f2f2f7"}}>
                        <p style={{fontSize:15,fontWeight:800,color:"#1c1c1e"}}>{currentLoad} / {maxPkgs}</p>
                        <p style={{fontSize:10,color:"#8e8e93",marginTop:2}}>{hasCustomMax?"Özel limit":"Genel limit"} — şu an aktif paket</p>
                      </div>
                      {currentLoad>=maxPkgs&&<span style={{fontSize:11,fontWeight:700,color:"#e53935",background:"#fdecea",padding:"5px 9px",borderRadius:7}}>DOLU</span>}
                    </div>
                  ) : (
                    <div>
                      <div style={{marginBottom:10}}>
                        <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:3}}>Aynı Anda Taşıyabileceği Maks. Paket</p>
                        <input type="number" min="1" step="1" value={maxPkgsEdit.value} onChange={e=>setMaxPkgsEdit(m=>({...m,value:+e.target.value}))}
                          style={{width:"100%",padding:"7px 9px",border:"1.5px solid #e5e5ea",borderRadius:7,fontSize:12,outline:"none",background:"#fff",color:"#1c1c1e",fontWeight:600}}/>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={saveMaxPkgs} style={{flex:1,padding:"8px",background:"#1e88e5",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>Kaydet</button>
                        <button onClick={()=>setMaxPkgsEdit(null)} style={{padding:"8px 14px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:8,fontSize:12,cursor:"pointer"}}>İptal</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Bakiye/Avans işlemleri */}
                <div style={{padding:"12px 14px"}}>
                  {/* İşlem tipi */}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:10}}>
                    {TX.map(t=>(
                      <button key={t.id} onClick={()=>setTxType(t.id)} style={{padding:"8px 4px",borderRadius:9,border:"1.5px solid "+(txType===t.id?t.color:"#e5e5ea"),background:txType===t.id?t.bg:"#fff",color:txType===t.id?t.color:"#8e8e93",fontSize:11,fontWeight:700,cursor:"pointer",transition:"all .15s"}}>
                        {t.label}
                      </button>
                    ))}
                  </div>

                  {/* Preset tutarlar */}
                  <div style={{display:"flex",gap:5,marginBottom:8,flexWrap:"wrap"}}>
                    {[50,100,200,500].map(p=>(
                      <button key={p} onClick={()=>setAmount(String(p))} style={{padding:"5px 12px",borderRadius:7,border:"1.5px solid "+(amount===String(p)?selTX.color:"#e5e5ea"),background:amount===String(p)?selTX.bg:"#fff",color:amount===String(p)?selTX.color:"#636366",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                        ₺{p}
                      </button>
                    ))}
                  </div>

                  {/* Tutar + not */}
                  <div style={{display:"flex",gap:8,marginBottom:8}}>
                    <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="₺ Tutar"
                      style={{flex:1,padding:"9px 11px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:13,outline:"none",background:"#fff",color:"#1c1c1e"}}/>
                    <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Not..."
                      style={{flex:2,padding:"9px 11px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:13,outline:"none",background:"#fff",color:"#1c1c1e"}}/>
                  </div>

                  {/* Önizleme */}
                  {amount&&parseFloat(amount)>0&&(
                    <div style={{background:selTX.bg,borderRadius:8,padding:"8px 11px",marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:12,color:"#636366"}}>Mevcut: <strong>₺{bal.toFixed(2)}</strong></span>
                      <span style={{fontSize:13,fontWeight:800,color:selTX.color}}>
                        → ₺{(txType==="add"?bal+parseFloat(amount):bal-parseFloat(amount)).toFixed(2)}
                      </span>
                    </div>
                  )}

                  <button onClick={()=>applyTx(c.id)} disabled={!amount||parseFloat(amount||0)<=0}
                    style={{width:"100%",padding:"10px",background:amount&&parseFloat(amount||0)>0?selTX.color:"#e5e5ea",color:amount&&parseFloat(amount||0)>0?"#fff":"#8e8e93",border:"none",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer"}}>
                    {selTX.label} Uygula
                  </button>
                </div>

                {/* Mutabakat */}
                <div style={{borderTop:"1px solid #f2f2f7",padding:"12px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:showRecon===c.id?10:0}}>
                    <p style={{fontSize:12,fontWeight:700,color:"#1c1c1e"}}>📋 Dönemsel Mutabakat</p>
                    <button onClick={()=>showRecon===c.id?setShowRecon(false):openRecon(c)} style={{padding:"5px 12px",background:showRecon===c.id?"#f2f2f7":"#1e88e5",color:showRecon===c.id?"#636366":"#fff",border:"none",borderRadius:7,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                      {showRecon===c.id?"Kapat":"+ Yeni Mutabakat"}
                    </button>
                  </div>

                  {showRecon===c.id&&(()=>{
                    const txsInRange = (db.courierTransactions||[]).filter(t=>t.courierId===c.id&&inRange(t.date,reconFrom,reconTo));
                    const total = txsInRange.reduce((sum,t)=>sum+t.amount,0);
                    return(
                      <div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                          <div>
                            <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:3}}>Başlangıç</p>
                            <input type="date" value={reconFrom} onChange={e=>setReconFrom(e.target.value)}
                              style={{width:"100%",padding:"7px 9px",border:"1.5px solid #e5e5ea",borderRadius:7,fontSize:12,outline:"none",background:"#fff",color:"#1c1c1e"}}/>
                          </div>
                          <div>
                            <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:3}}>Bitiş</p>
                            <input type="date" value={reconTo} onChange={e=>setReconTo(e.target.value)}
                              style={{width:"100%",padding:"7px 9px",border:"1.5px solid #e5e5ea",borderRadius:7,fontSize:12,outline:"none",background:"#fff",color:"#1c1c1e"}}/>
                          </div>
                        </div>

                        {(reconFrom||reconTo)&&(
                          <div style={{background:"#fff",borderRadius:8,border:"1px solid #e5e5ea",marginBottom:10,overflow:"hidden"}}>
                            {txsInRange.length===0?(
                              <p style={{fontSize:11,color:"#8e8e93",textAlign:"center",padding:"14px"}}>Bu aralıkta işlem bulunamadı</p>
                            ):(
                              <>
                                {txsInRange.map(t=>(
                                  <div key={t.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 11px",borderBottom:"1px solid #f2f2f7"}}>
                                    <div><p style={{fontSize:11,fontWeight:600}}>{t.type}</p><p style={{fontSize:10,color:"#8e8e93"}}>{t.date} {t.time}</p></div>
                                    <p style={{fontWeight:700,fontSize:12,color:t.amount>=0?"#4caf50":"#e53935"}}>{t.amount>=0?"+":""}₺{Math.abs(t.amount).toFixed(2)}</p>
                                  </div>
                                ))}
                                <div style={{display:"flex",justifyContent:"space-between",padding:"9px 11px",background:"#f9f9f9"}}>
                                  <span style={{fontWeight:700,fontSize:12}}>TOPLAM ({txsInRange.length} işlem)</span>
                                  <span style={{fontWeight:800,fontSize:13,color:total>=0?"#4caf50":"#e53935"}}>{total>=0?"+":""}₺{Math.abs(total).toFixed(2)}</span>
                                </div>
                              </>
                            )}
                          </div>
                        )}

                        <button onClick={()=>confirmReconciliation(c.id)} disabled={txsInRange.length===0}
                          style={{width:"100%",padding:"10px",background:txsInRange.length>0?"#4caf50":"#e5e5ea",color:txsInRange.length>0?"#fff":"#8e8e93",border:"none",borderRadius:9,fontSize:12,fontWeight:700,cursor:"pointer"}}>
                          ✅ Mutabık Kaldık ve Kaydet
                        </button>
                      </div>
                    );
                  })()}

                  {/* Geçmiş mutabakatlar */}
                  {(()=>{
                    const history = [...(db.reconciliations||[])].filter(r=>r.courierId===c.id).reverse();
                    if(history.length===0) return null;
                    return(
                      <div style={{marginTop:showRecon===c.id?12:0}}>
                        <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,marginBottom:6,textTransform:"uppercase",letterSpacing:.3}}>Geçmiş Mutabakatlar</p>
                        {history.slice(0,5).map(r=>(
                          <div key={r.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 11px",background:"#e9f9ee",borderRadius:8,marginBottom:6}}>
                            <div>
                              <p style={{fontSize:11,fontWeight:700,color:"#1c1c1e"}}>✅ {r.from||"…"} → {r.to||"…"}</p>
                              <p style={{fontSize:10,color:"#8e8e93",marginTop:1}}>{r.txCount} işlem · Onay: {r.confirmedDate} {r.confirmedAt}</p>
                            </div>
                            <p style={{fontWeight:800,fontSize:13,color:r.total>=0?"#4caf50":"#e53935"}}>{r.total>=0?"+":""}₺{Math.abs(r.total).toFixed(2)}</p>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                {/* İşlem geçmişi */}
                {txs.length>0&&(
                  <div style={{borderTop:"1px solid #f2f2f7"}}>
                    <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,padding:"8px 14px 4px",textTransform:"uppercase",letterSpacing:.3}}>Son İşlemler</p>
                    {txs.map(t=>(
                      <div key={t.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 14px",borderBottom:"1px solid #f2f2f7"}}>
                        <div>
                          <p style={{fontSize:12,fontWeight:600,color:"#1c1c1e"}}>{t.type}</p>
                          <p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>{t.date} {t.time}{t.note?" · "+t.note:""}</p>
                        </div>
                        <p style={{fontWeight:700,fontSize:14,color:t.amount>=0?"#4caf50":"#e53935"}}>
                          {t.amount>=0?"+":""}₺{Math.abs(t.amount).toFixed(2)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TierTable({label,tiers,onChange,color}){
  return(
    <div style={{marginTop:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <p style={{fontSize:11,fontWeight:700,color}}>{label}</p>
        <button onClick={()=>onChange([...tiers,{pkgMin:0,bonus:0}])}
          style={{padding:"3px 10px",background:color,color:"#fff",border:"none",borderRadius:6,fontSize:11,fontWeight:700,cursor:"pointer"}}>+ Barem</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:4,marginBottom:4}}>
        {["Min Paket","Bonus (₺)",""].map(h=>(
          <p key={h} style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",textAlign:"center"}}>{h}</p>
        ))}
      </div>
      {tiers.map((t,i)=>(
        <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:4,marginBottom:4,alignItems:"center"}}>
          <input type="number" value={t.pkgMin} onChange={e=>onChange(tiers.map((x,j)=>j===i?{...x,pkgMin:+e.target.value}:x))}
            style={{padding:"6px 8px",border:"1.5px solid #e5e5ea",borderRadius:7,fontSize:12,outline:"none",background:"#fff",color:"#1c1c1e",textAlign:"center",fontWeight:600}}/>
          <input type="number" value={t.bonus} onChange={e=>onChange(tiers.map((x,j)=>j===i?{...x,bonus:+e.target.value}:x))}
            style={{padding:"6px 8px",border:"1.5px solid "+color,borderRadius:7,fontSize:12,outline:"none",background:"#fff",color,textAlign:"center",fontWeight:700}}/>
          <button onClick={()=>onChange(tiers.filter((_,j)=>j!==i))}
            style={{padding:"6px 8px",background:"#fdecea",color:"#e53935",border:"none",borderRadius:7,fontSize:12,cursor:"pointer",fontWeight:700}}>✕</button>
        </div>
      ))}
      {tiers.length===0&&<p style={{fontSize:11,color:"#aeaeb2",textAlign:"center",padding:"8px 0"}}>Barem yok — + ile ekle</p>}
    </div>
  );
}

function RegionFieldGrid({data,onChange,onTierChange,groups}){
  return(
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {groups.map(g=>(
        <div key={g.title} style={{background:"#f9f9f9",borderRadius:10,padding:"10px 12px"}}>
          <p style={{fontSize:11,fontWeight:700,color:"#636366",marginBottom:8}}>{g.title}</p>
          {g.isTiered ? (
            <div>
              <TierTable label="📅 Günlük Baremler" tiers={data.dailyTiers||[]} onChange={v=>onTierChange("dailyTiers",v)} color="#f9a825"/>
              <div style={{height:1,background:"#e5e5ea",margin:"12px 0"}}/>
              <TierTable label="📆 Haftalık Baremler" tiers={data.weeklyTiers||[]} onChange={v=>onTierChange("weeklyTiers",v)} color="#8e24aa"/>
            </div>
          ) : (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {g.fields.map(f=>(
                <div key={f.k}>
                  <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{f.l}</p>
                  <input type="number" step={f.step} value={data[f.k]||""} onChange={e=>onChange(f.k,+e.target.value)}
                    style={{width:"100%",padding:"7px 9px",border:"1.5px solid #e5e5ea",borderRadius:8,fontSize:12,outline:"none",background:"#fff",color:"#1c1c1e",fontWeight:600}}/>
                  <p style={{fontSize:10,color:"#c7c7cc",marginTop:2}}>{f.tip}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AdminRegionFinance({db,save,toast}){
  const emptyR = {
    name:"",startKm:0,pkgFee:35,kmInterval:1,kmFee:2.5,minFee:20,
    dailyTiers:[
      {pkgMin:10,bonus:20},
      {pkgMin:20,bonus:50},
      {pkgMin:30,bonus:100},
    ],
    weeklyTiers:[
      {pkgMin:50, bonus:100},
      {pkgMin:100,bonus:250},
      {pkgMin:150,bonus:500},
    ],
  };
  const [regions,setRegions] = useState(()=>db.settings?.regions||[{id:"r1",name:"Merkez",...emptyR,pkgFee:35}]);
  const [showAdd,setShowAdd] = useState(false);
  const [newR,setNewR] = useState({...emptyR});
  const [editId,setEditId] = useState(null);

  const saveAll = r => {setRegions(r);save({...db,settings:{...(db.settings||{}),regions:r}});toast("Kaydedildi","success");};
  const upd = (id,k,v) => setRegions(rs=>rs.map(r=>r.id===id?{...r,[k]:isNaN(+v)?v:+v}:r));
  const addR = () => {if(!newR.name)return;saveAll([...regions,{...newR,id:"r"+genId()}]);setShowAdd(false);setNewR({...emptyR});};
  const del = id => saveAll(regions.filter(r=>r.id!==id));

  // Örnek hesap: startKm + kmInterval kullanarak
  const calcEx = (r,km) => {
    if(km<=(r.startKm||0)) return r.minFee;
    const dist = km-(r.startKm||0);
    const intervals = r.kmInterval>0 ? Math.floor(dist/r.kmInterval) : 0;
    return Math.max(r.minFee, r.pkgFee + intervals*(r.kmFee||0));
  };

  // Alan grupları — istenen yapıya göre
  const GROUPS = [
    {
      title:"📦 Paket & KM Ücreti",
      fields:[
        {k:"pkgFee",     l:"Paket Ücreti (₺)",   tip:"Her paket için alınan temel ücret", step:1},
        {k:"startKm",    l:"Başlangıç KM",         tip:"KM ücretinin başladığı mesafe",    step:0.5},
        {k:"kmInterval", l:"Kaç KM'de Bir",        tip:"Her X km'de bir ücret eklenir",    step:0.5},
        {k:"kmFee",      l:"KM Ücreti (₺)",        tip:"Her aralık için eklenen ücret",    step:0.5},
        {k:"minFee",     l:"Min. Ücret (₺)",       tip:"En az bu kadar alınır",            step:1},
      ],
    },
  ];

  const FieldGrid = (props) => <RegionFieldGrid {...props} groups={GROUPS}/>;


  return(
    <div style={{padding:12,display:"flex",flexDirection:"column",gap:10}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <p style={{fontSize:12,color:"#8e8e93",fontWeight:700}}>Bölge bazlı fiyatlandırma</p>
        <button onClick={()=>setShowAdd(v=>!v)} style={{padding:"6px 14px",background:"#e53935",color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:"pointer"}}>+ Ekle</button>
      </div>

      {/* Yeni bölge ekle */}
      {showAdd&&(
        <div style={{background:"#fff",borderRadius:12,padding:14,borderLeft:"3px solid #e53935",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
          <p style={{fontWeight:700,fontSize:13,marginBottom:10}}>Yeni Bölge</p>
          <div style={{marginBottom:10}}>
            <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:4}}>Bölge Adı</p>
            <input value={newR.name} onChange={e=>setNewR(r=>({...r,name:e.target.value}))} placeholder="Örn: Kuzey"
              style={{width:"100%",padding:"9px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:13,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
          </div>
          <FieldGrid data={newR} onChange={(k,v)=>setNewR(r=>({...r,[k]:v}))} onTierChange={(k,v)=>setNewR(r=>({...r,[k]:v}))}/>
          <div style={{display:"flex",gap:8,marginTop:12}}>
            <button onClick={addR} style={{flex:1,padding:"10px",background:"#e53935",color:"#fff",border:"none",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer"}}>Kaydet</button>
            <button onClick={()=>setShowAdd(false)} style={{padding:"10px 16px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:9,fontSize:13,cursor:"pointer"}}>İptal</button>
          </div>
        </div>
      )}

      {/* Bölge kartları */}
      {regions.map(r=>{
        const isEdit = editId===r.id;
        const ex5  = calcEx(r,5).toFixed(1);
        const ex10 = calcEx(r,10).toFixed(1);
        return(
          <div key={r.id} style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
            {/* Başlık */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",background:"#fafafa",borderBottom:"1px solid #f2f2f7"}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:"#e53935"}}/>
                <p style={{fontWeight:700,fontSize:13}}>{r.name}</p>
                <span style={{fontSize:11,color:"#8e8e93"}}>· {r.startKm}km'den, her {r.kmInterval}km ₺{r.kmFee}</span>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={()=>setEditId(isEdit?null:r.id)} style={{padding:"5px 10px",background:isEdit?"#f2f2f7":"#1e88e5",color:isEdit?"#636366":"#fff",border:"none",borderRadius:7,fontSize:11,fontWeight:700,cursor:"pointer"}}>{isEdit?"Kapat":"Düzenle"}</button>
                <button onClick={()=>del(r.id)} style={{padding:"5px 10px",background:"#fdecea",color:"#e53935",border:"none",borderRadius:7,fontSize:11,fontWeight:700,cursor:"pointer"}}>Sil</button>
              </div>
            </div>

            {/* Özet strip */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",borderBottom:isEdit?"1px solid #f2f2f7":"none"}}>
              {[
                ["Paket","₺"+r.pkgFee,"#e53935"],
                ["5km","₺"+ex5,"#4caf50"],
                ["10km","₺"+ex10,"#1e88e5"],
              ].map(([l,v,c],i)=>(
                <div key={l} style={{padding:"8px 4px",textAlign:"center",borderRight:i<2?"1px solid #f2f2f7":"none"}}>
                  <p style={{fontSize:13,fontWeight:800,color:c,lineHeight:1}}>{v}</p>
                  <p style={{fontSize:10,color:"#8e8e93",marginTop:2}}>{l}</p>
                </div>
              ))}
            </div>

            {/* Düzenleme alanları */}
            {isEdit&&(
              <div style={{padding:"12px 14px"}}>
                <FieldGrid data={r} onChange={(k,v)=>upd(r.id,k,v)} onTierChange={(k,v)=>upd(r.id,k,v)}/>
                {/* Canlı hesap */}
                <div style={{marginTop:10,background:"#f9f9f9",borderRadius:8,padding:"9px 12px",fontSize:12,color:"#636366"}}>
                  <p style={{marginBottom:3}}>📊 Örnek hesap ({r.name}):</p>
                  <p>5km → Paket ₺{r.pkgFee} + {r.kmInterval>0?Math.floor((5-r.startKm)/r.kmInterval):0} aralık × ₺{r.kmFee} = <strong style={{color:"#4caf50"}}>₺{ex5}</strong></p>
                  <p>10km → Paket ₺{r.pkgFee} + {r.kmInterval>0?Math.floor((10-r.startKm)/r.kmInterval):0} aralık × ₺{r.kmFee} = <strong style={{color:"#1e88e5"}}>₺{ex10}</strong></p>
                </div>
                <button onClick={()=>saveAll(regions)} style={{width:"100%",padding:"10px",background:"#e53935",color:"#fff",border:"none",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:10}}>
                  💾 Kaydet
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AdminPackageReports({db}){
  const [bolgeFilter,setBolgeFilter] = useState("Hepsi");
  const [periodMode,setPeriodMode] = useState("daily"); // daily | weekly | monthly
  const [showBolgeMenu,setShowBolgeMenu] = useState(false);
  const [openDay,setOpenDay] = useState(null);
  const [showTotal,setShowTotal] = useState(false);

  const [totalFrom,setTotalFrom] = useState("");
  const [totalTo,setTotalTo] = useState("");
  const [showDatePicker,setShowDatePicker] = useState(false);

  // "YYYY-MM-DD" -> "25.06" kompakt gösterim
  const fmtCompactDate = iso => {
    if(!iso) return "…";
    const [y,m,d] = iso.split("-");
    return d+"."+m;
  };

  // Kuryenin bölgesi üzerinden paketin bölgesini bul (paketlerde doğrudan region alanı yok)
  const courierRegion = cid => db.couriers.find(c=>c.id===cid)?.region || null;

  const filteredPkgs = db.packages.filter(p=>{
    if(bolgeFilter==="Hepsi") return true;
    return courierRegion(p.courierId)===bolgeFilter;
  });

  // deliveredAt'i olan paketler günlük/haftalık/aylık kartlara dağılır; olmayanlar "tarihsiz" sayılır
  const dated = filteredPkgs.filter(p=>p.deliveredAt);
  const undated = filteredPkgs.filter(p=>!p.deliveredAt);

  const dayKey = iso => { const d=new Date(iso); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
  const weekKey = iso => { const d=new Date(iso); const start=new Date(d); start.setDate(d.getDate()-((d.getDay()+6)%7)); return dayKey(start.toISOString()); };
  const monthKey = iso => { const d=new Date(iso); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"); };

  const keyFn = periodMode==="daily" ? dayKey : periodMode==="weekly" ? weekKey : monthKey;

  const groups = {};
  dated.forEach(p=>{
    const k = keyFn(p.deliveredAt);
    if(!groups[k]) groups[k]=[];
    groups[k].push(p);
  });
  const sortedKeys = Object.keys(groups).sort((a,b)=>b.localeCompare(a));

  const fmtLabel = (key) => {
    if(periodMode==="monthly"){
      const [y,m] = key.split("-");
      return new Date(+y,+m-1,1).toLocaleDateString("tr-TR",{month:"long",year:"numeric"});
    }
    const start = new Date(key);
    const end = new Date(start);
    end.setDate(start.getDate()+(periodMode==="weekly"?7:1));
    const fmt = d => d.toLocaleDateString("tr-TR",{day:"numeric",month:"long"});
    return periodMode==="daily" ? fmt(start)+" 00:00" : fmt(start)+" → "+fmt(end);
  };

  // Bir dönem key'inden (YYYY-MM-DD veya YYYY-MM) courierTransactions'ı filtrelemek için from/to (YYYY-MM-DD) üretir
  const keyToRange = (key) => {
    if(periodMode==="monthly"){
      const [y,m] = key.split("-");
      const start = new Date(+y,+m-1,1);
      const end = new Date(+y,+m,0); // ayın son günü
      const iso = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
      return {from:iso(start),to:iso(end)};
    }
    const start = new Date(key);
    const end = new Date(start);
    end.setDate(start.getDate()+(periodMode==="weekly"?6:0));
    const iso = d => d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
    return {from:iso(start),to:iso(end)};
  };

  const summarize = (pkgs, courierNetPay=null) => {
    const total = pkgs.reduce((s,p)=>s+(p.fee||0),0);
    const byStatus = {};
    pkgs.forEach(p=>{ byStatus[p.status]=(byStatus[p.status]||0)+1; });
    const byPay = {};
    pkgs.forEach(p=>{ const k=p.paymentType||"Belirtilmedi"; if(!byPay[k]) byPay[k]={count:0,total:0}; byPay[k].count++; byPay[k].total+=(p.fee||0); });
    const courierPay = courierNetPay!==null ? courierNetPay : 0;
    const profit = total - courierPay;
    return {count:pkgs.length,total,byStatus,byPay,courierPay,profit};
  };

  // Tarih parse: courierTransactions.date "DD.MM.YYYY" (Türkçe todayStr()), from/to input'lar "YYYY-MM-DD"
  const parseTrDate = d => {
    if(!d) return null;
    const [day,month,year] = d.split(".").map(Number);
    return new Date(year,month-1,day);
  };
  const inRange = (txDate,from,to) => {
    const d = parseTrDate(txDate);
    if(!d) return false;
    if(from){ const f=new Date(from+"T00:00:00"); if(d<f) return false; }
    if(to){ const t=new Date(to+"T23:59:59"); if(d>t) return false; }
    return true;
  };
  // Seçilen tarih aralığında kuryelere yapılan NET ödeme (Yükleme + Avans − Kesinti)
  const netCourierPayInRange = (from,to) => {
    return (db.courierTransactions||[]).filter(t=>inRange(t.date,from,to)).reduce((s,t)=>s+t.amount,0);
  };

  const ReportDetail = ({pkgs,courierNetPay,onClose,title}) => {
    const sum = summarize(pkgs, courierNetPay);
    const delivered = pkgs.filter(p=>p.status==="Teslim Edildi");
    const deliveredTotal = delivered.reduce((s,p)=>s+(p.fee||0),0);

    // Kapıda / Ön Ödeme gruplarına göre teslim edilen paketleri kır
    const groupBreak = groupName => {
      const types = PAY_GROUPS[groupName];
      const items = types.map(t=>{
        const pkgsOfType = delivered.filter(p=>p.paymentType===t);
        return {type:t, count:pkgsOfType.length, total:pkgsOfType.reduce((s,p)=>s+(p.fee||0),0)};
      }).filter(i=>i.count>0);
      const count = items.reduce((s,i)=>s+i.count,0);
      const total = items.reduce((s,i)=>s+i.total,0);
      return {items,count,total};
    };
    const kapida = groupBreak("Kapıda");
    const onOdeme = groupBreak("Ön Ödeme");

    // Diğer durumlar (Teslim Edildi hariç), her biri kendi kutusunda katlanır listede
    const otherStatuses = Object.entries(sum.byStatus).filter(([s])=>s!=="Teslim Edildi");
    const [openStatus,setOpenStatus] = useState(null);

    return(
      <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.5)",zIndex:1000,display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={onClose}>
        <div onClick={e=>e.stopPropagation()} style={{background:"#fff",borderRadius:"18px 18px 0 0",width:"100%",maxWidth:430,maxHeight:"88vh",display:"flex",flexDirection:"column"}}>
          <div style={{display:"flex",justifyContent:"center",padding:"10px 0 4px",flexShrink:0}}>
            <div style={{width:44,height:4,borderRadius:2,background:"#e53935"}}/>
          </div>
          <div style={{padding:"4px 18px 14px",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
            <div style={{width:34,height:34,borderRadius:"50%",background:"#eef0fb",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>👤</div>
            <p style={{fontWeight:800,fontSize:16,color:"#1a2b8c"}}>{title}</p>
            <button onClick={onClose} style={{marginLeft:"auto",background:"#f2f2f7",border:"none",borderRadius:8,padding:"6px 12px",fontSize:13,fontWeight:700,color:"#636366",cursor:"pointer"}}>✕</button>
          </div>

          <div style={{padding:"0 16px 18px",overflowY:"auto",flex:1}}>
            {/* Üst özet: 3 kart */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
              <div style={{background:"#fdecea",borderRadius:12,padding:"12px 8px",textAlign:"center"}}>
                <p style={{fontSize:11,color:"#8e8e93",fontWeight:600,marginBottom:4}}>İşletme Maliyeti</p>
                <p style={{fontSize:16,fontWeight:800,color:"#e53935"}}>{sum.total.toLocaleString("tr-TR")}₺</p>
              </div>
              <div style={{background:"#e9f9ee",borderRadius:12,padding:"12px 8px",textAlign:"center"}}>
                <p style={{fontSize:11,color:"#8e8e93",fontWeight:600,marginBottom:4}}>Kurye Kazancı</p>
                <p style={{fontSize:16,fontWeight:800,color:"#4caf50"}}>{sum.courierPay.toLocaleString("tr-TR")}₺</p>
              </div>
              <div style={{background:sum.profit>=0?"#e9f9ee":"#fdecea",borderRadius:12,padding:"12px 8px",textAlign:"center",border:"1.5px solid "+(sum.profit>=0?"#4caf50":"#e53935")}}>
                <p style={{fontSize:11,color:"#8e8e93",fontWeight:600,marginBottom:4}}>Tahmini Kâr</p>
                <p style={{fontSize:16,fontWeight:800,color:sum.profit>=0?"#4caf50":"#e53935"}}>{sum.profit.toLocaleString("tr-TR")}₺</p>
              </div>
            </div>
            {courierNetPay!==null&&(
              <p style={{fontSize:10,color:"#aeaeb2",lineHeight:1.5,marginBottom:14,textAlign:"center"}}>
                Kurye kazancı, bu dönemde kuryelere yapılan net bakiye hareketlerinden (Yükleme + Avans − Kesinti) hesaplanır; belirli bir pakete birebir bağlı değildir.
              </p>
            )}

            {/* Teslim Edilen Tahsilat */}
            <div style={{border:"1.5px solid #1a2b8c",borderRadius:14,marginBottom:14,overflow:"hidden"}}>
              <div style={{padding:"12px 14px",display:"flex",alignItems:"center",gap:8,borderBottom:"1px solid #eef0fb"}}>
                <span style={{fontSize:16}}>🏷️</span>
                <p style={{fontWeight:700,fontSize:14,color:"#1a2b8c"}}>Teslim Edilen Tahsilat</p>
              </div>
              <div style={{padding:"4px 14px 10px"}}>
                {kapida.items.map(item=>(
                  <div key={item.type} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid #f2f2f7"}}>
                    <span style={{fontSize:12.5,color:"#1c1c1e"}}>Kapıda {item.type} ({item.count})</span>
                    <span style={{fontWeight:700,fontSize:12.5,color:"#1a2b8c"}}>{item.total.toLocaleString("tr-TR")}₺</span>
                  </div>
                ))}
                {onOdeme.items.map(item=>(
                  <div key={item.type} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid #f2f2f7"}}>
                    <span style={{fontSize:12.5,color:"#1c1c1e"}}>Ön Ödeme {item.type} ({item.count})</span>
                    <span style={{fontWeight:700,fontSize:12.5,color:"#1a2b8c"}}>{item.total.toLocaleString("tr-TR")}₺</span>
                  </div>
                ))}
                {kapida.items.length===0&&onOdeme.items.length===0&&(
                  <p style={{fontSize:12,color:"#8e8e93",textAlign:"center",padding:"10px 0"}}>Teslim edilen paket yok</p>
                )}
                <div style={{display:"flex",justifyContent:"space-between",padding:"9px 0 2px"}}>
                  <span style={{fontSize:13,fontWeight:700,color:"#636366"}}>Toplam:</span>
                  <span style={{fontWeight:800,fontSize:14,color:"#1a2b8c"}}>{deliveredTotal.toLocaleString("tr-TR")}₺</span>
                </div>
              </div>
            </div>

            {/* Teslim Edildi — Kapıda/Ön Ödeme kırılımlı */}
            <div style={{border:"1.5px solid #4caf50",borderRadius:14,marginBottom:14,overflow:"hidden"}}>
              <div style={{padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid #eef7ee"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:16}}>✅</span>
                  <p style={{fontWeight:700,fontSize:14,color:"#2e7d32"}}>Teslim Edildi</p>
                </div>
                <span style={{fontSize:12,fontWeight:700,color:"#4caf50"}}>{delivered.length} paket</span>
              </div>
              <div style={{padding:"8px 14px 12px"}}>
                <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0 8px"}}>
                  <span style={{fontSize:12,color:"#8e8e93"}}>Toplam</span>
                  <span style={{fontWeight:800,fontSize:14,color:"#2e7d32"}}>{deliveredTotal.toLocaleString("tr-TR")}₺</span>
                </div>

                {kapida.count>0&&(
                  <div style={{marginBottom:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid #f2f2f7"}}>
                      <span style={{fontSize:12.5,fontWeight:700,color:"#fb8c00",display:"flex",alignItems:"center",gap:5}}>✋ Kapıda ({kapida.count})</span>
                      <span style={{fontWeight:700,fontSize:12.5,color:"#fb8c00"}}>{kapida.total.toLocaleString("tr-TR")}₺</span>
                    </div>
                    {kapida.items.map(item=>(
                      <div key={item.type} style={{display:"flex",justifyContent:"space-between",padding:"5px 0 5px 18px"}}>
                        <span style={{fontSize:12,color:"#636366"}}>· {item.type} ({item.count})</span>
                        <span style={{fontSize:12,fontWeight:600,color:"#1c1c1e"}}>{item.total.toLocaleString("tr-TR")}₺</span>
                      </div>
                    ))}
                  </div>
                )}

                {onOdeme.count>0&&(
                  <div>
                    <div style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:"1px solid #f2f2f7"}}>
                      <span style={{fontSize:12.5,fontWeight:700,color:"#1e88e5",display:"flex",alignItems:"center",gap:5}}>💳 Ön Ödeme ({onOdeme.count})</span>
                      <span style={{fontWeight:700,fontSize:12.5,color:"#1e88e5"}}>{onOdeme.total.toLocaleString("tr-TR")}₺</span>
                    </div>
                    {onOdeme.items.map(item=>(
                      <div key={item.type} style={{display:"flex",justifyContent:"space-between",padding:"5px 0 5px 18px"}}>
                        <span style={{fontSize:12,color:"#636366"}}>· {item.type} ({item.count})</span>
                        <span style={{fontSize:12,fontWeight:600,color:"#1c1c1e"}}>{item.total.toLocaleString("tr-TR")}₺</span>
                      </div>
                    ))}
                  </div>
                )}

                {delivered.length===0&&<p style={{fontSize:12,color:"#8e8e93",textAlign:"center",padding:"6px 0"}}>Teslim edilen paket yok</p>}
              </div>
            </div>

            {/* Diğer durumlar — katlanır satırlar */}
            {otherStatuses.length>0&&(
              <div style={{border:"1px solid #e5e5ea",borderRadius:14,overflow:"hidden"}}>
                {otherStatuses.map(([status,count],i)=>{
                  const pkgsOfStatus = pkgs.filter(p=>p.status===status);
                  const totalOfStatus = pkgsOfStatus.reduce((s,p)=>s+(p.fee||0),0);
                  const isOpen = openStatus===status;
                  return(
                    <div key={status} style={{borderBottom:i<otherStatuses.length-1?"1px solid #f2f2f7":"none"}}>
                      <button onClick={()=>setOpenStatus(isOpen?null:status)} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"13px 14px",border:"none",background:"transparent",cursor:"pointer"}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{width:9,height:9,borderRadius:"50%",background:STATUS_COLORS[status]||"#8e8e93",display:"inline-block"}}/>
                          <span style={{fontSize:13,fontWeight:600,color:"#1c1c1e"}}>{status}</span>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          <span style={{fontSize:12,color:"#8e8e93"}}>{count}</span>
                          <span style={{fontWeight:700,fontSize:13,color:"#1c1c1e"}}>{totalOfStatus.toLocaleString("tr-TR")}₺</span>
                          <span style={{color:"#8e8e93",fontSize:12,transform:isOpen?"rotate(180deg)":"none",display:"inline-block"}}>⌄</span>
                        </div>
                      </button>
                      {isOpen&&(
                        <div style={{padding:"0 14px 12px"}}>
                          {pkgsOfStatus.slice(0,20).map(p=>(
                            <div key={p.id} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",fontSize:11.5,color:"#636366"}}>
                              <span>#{p.id} · {p.restaurant}</span>
                              <span style={{fontWeight:600,color:"#1c1c1e"}}>₺{p.fee}</span>
                            </div>
                          ))}
                          {pkgsOfStatus.length>20&&<p style={{fontSize:11,color:"#aeaeb2",marginTop:4}}>+{pkgsOfStatus.length-20} daha...</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:"#f2f2f7"}}>
      <div style={{background:"#fff",padding:"12px 14px",borderBottom:"1px solid #e5e5ea",flexShrink:0}}>
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          <button onClick={()=>setShowBolgeMenu(v=>!v)} style={{flex:1,padding:"10px 12px",background:"#f9f9f9",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:12,fontWeight:700,color:"#1c1c1e",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>📍 {bolgeFilter}</span><span style={{color:"#8e8e93"}}>⌄</span>
          </button>
          <button onClick={()=>{setShowTotal(v=>!v);setTotalFrom("");setTotalTo("");}} style={{padding:"10px 18px",background:showTotal?"#f2f2f7":"#e53935",color:showTotal?"#636366":"#fff",border:"none",borderRadius:9,fontSize:12,fontWeight:700,cursor:"pointer"}}>
            {showTotal?"Kapat":"Toplam Rapor"}
          </button>
        </div>
        {showBolgeMenu&&(
          <div style={{background:"#fff",border:"1px solid #e5e5ea",borderRadius:10,marginBottom:10,boxShadow:"0 2px 10px rgba(0,0,0,.08)",overflow:"hidden"}}>
            {BOLGE.map(b=>(
              <button key={b} onClick={()=>{setBolgeFilter(b);setShowBolgeMenu(false);}} style={{width:"100%",textAlign:"left",padding:"11px 14px",border:"none",background:bolgeFilter===b?"#f2f2f7":"#fff",fontSize:13,fontWeight:bolgeFilter===b?700:500,color:"#1c1c1e",cursor:"pointer",borderBottom:"1px solid #f2f2f7"}}>
                {b}
              </button>
            ))}
          </div>
        )}
        {showTotal&&(
          <div style={{marginBottom:10}}>
            <button onClick={()=>setShowDatePicker(v=>!v)} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 14px",background:"#fff",border:"1.5px solid #e5e5ea",borderRadius:10,cursor:"pointer"}}>
              <span style={{fontSize:13,fontWeight:700,color:"#1c1c1e"}}>
                {totalFrom||totalTo ? fmtCompactDate(totalFrom)+"-"+fmtCompactDate(totalTo) : "Tüm Zamanlar"}
              </span>
              <span style={{color:"#e53935",fontSize:14,transform:showDatePicker?"rotate(90deg)":"none",display:"inline-block",transition:"transform .15s"}}>›</span>
            </button>
            {showDatePicker&&(
              <div style={{background:"#fdecea",borderRadius:10,padding:"10px 12px",marginTop:8}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                  <div>
                    <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:3}}>Başlangıç</p>
                    <input type="date" value={totalFrom} onChange={e=>setTotalFrom(e.target.value)}
                      style={{width:"100%",padding:"7px 9px",border:"1.5px solid #e5e5ea",borderRadius:7,fontSize:12,outline:"none",background:"#fff",color:"#1c1c1e"}}/>
                  </div>
                  <div>
                    <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,marginBottom:3}}>Bitiş</p>
                    <input type="date" value={totalTo} onChange={e=>setTotalTo(e.target.value)}
                      style={{width:"100%",padding:"7px 9px",border:"1.5px solid #e5e5ea",borderRadius:7,fontSize:12,outline:"none",background:"#fff",color:"#1c1c1e"}}/>
                  </div>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <p style={{fontSize:10,color:"#8e6d00"}}>Boş bırakılırsa sınırsız kabul edilir.</p>
                  {(totalFrom||totalTo)&&<button onClick={()=>{setTotalFrom("");setTotalTo("");}} style={{fontSize:10,color:"#e53935",fontWeight:700,background:"none",border:"none",cursor:"pointer"}}>Temizle</button>}
                </div>
              </div>
            )}
          </div>
        )}
        <div style={{display:"flex",gap:6}}>
          {[["daily","Günlük"],["weekly","Haftalık"],["monthly","Aylık"]].map(([id,l])=>(
            <button key={id} onClick={()=>setPeriodMode(id)} style={{flex:1,padding:"8px 0",borderRadius:8,border:"1.5px solid "+(periodMode===id?"#e53935":"#e5e5ea"),background:periodMode===id?"#fdecea":"#fff",color:periodMode===id?"#e53935":"#8e8e93",fontSize:12,fontWeight:700,cursor:"pointer"}}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div style={{flex:1,overflowY:"auto"}}>
        {undated.length>0&&(
          <div style={{padding:"12px 14px 0"}}>
            <p style={{fontSize:11,color:"#8e8e93",lineHeight:1.5,background:"#fff8e1",borderRadius:8,padding:"8px 11px"}}>
              ⚠️ {undated.length} paketin teslim tarihi kaydı yok (eski/demo veri), bu paketler günlük listeye dağılmıyor ama Toplam Rapor'a dahil.
            </p>
          </div>
        )}
        {sortedKeys.length===0?(
          <p style={{textAlign:"center",padding:"48px 20px",color:"#8e8e93"}}>Bu bölge için tarihli teslimat kaydı yok</p>
        ):(
          <div style={{background:"#fff",marginTop:12}}>
            {sortedKeys.map(key=>{
              const pkgs = groups[key];
              const sum = summarize(pkgs);
              return(
                <button key={key} onClick={()=>setOpenDay(key)} style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 16px",border:"none",borderBottom:"1px solid #f2f2f7",background:"transparent",cursor:"pointer",textAlign:"left"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:16}}>📅</span>
                    <div>
                      <p style={{fontSize:13,fontWeight:700,color:"#1c1c1e"}}>{fmtLabel(key)}</p>
                      <p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>{sum.count} paket · ₺{sum.total}</p>
                    </div>
                  </div>
                  <span style={{color:"#e53935",fontSize:15}}>›</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {openDay&&(()=>{
        const {from,to} = keyToRange(openDay);
        return <ReportDetail pkgs={groups[openDay]} courierNetPay={netCourierPayInRange(from,to)} onClose={()=>setOpenDay(null)} title={fmtLabel(openDay)}/>;
      })()}
      {showTotal&&(()=>{
        const rangedPkgs = dated.filter(p=>{
          const d = new Date(p.deliveredAt);
          if(totalFrom){ const f=new Date(totalFrom+"T00:00:00"); if(d<f) return false; }
          if(totalTo){ const t=new Date(totalTo+"T23:59:59"); if(d>t) return false; }
          return true;
        }).concat(totalFrom||totalTo ? [] : undated); // tarih seçilmemişse tarihsiz paketleri de dahil et
        const rangeLabel = totalFrom||totalTo ? (totalFrom||"…")+" → "+(totalTo||"…") : "Tüm Zamanlar";
        return <ReportDetail pkgs={rangedPkgs} courierNetPay={netCourierPayInRange(totalFrom,totalTo)} onClose={()=>setShowTotal(false)} title={"Toplam Rapor"+(bolgeFilter!=="Hepsi"?" — "+bolgeFilter:"")+" ("+rangeLabel+")"}/>;
      })()}
    </div>
  );
}

function AdminSettings({user,db,save,setUser,toast}){
  const [section,setSection] = useState(null); // null = hub görünümü
  const pendingBal = (db.balanceRequests||[]).filter(r=>r.status==="bekliyor").length;

  const GROUPS = [
    {
      title:"Finans", icon:"📊",
      items:[
        {id:"region_finance",   l:"Bölge Finansları", icon:"🗺️"},
        {id:"courier_finance",  l:"Kurye Finansları",  icon:"🛵"},
        {id:"business_finance", l:"İşletme Finansları",icon:"🏪", badge:pendingBal},
      ],
    },
    {
      title:"Cariler ve Bakiye", icon:"💳",
      items:[
        {id:"courier_cari", l:"Kurye Carileri", icon:"📋"},
        {id:"balance_load", l:"Bakiye Yükle",   icon:"💰", badge:pendingBal},
      ],
    },
    {
      title:"Raporlar", icon:"📈",
      items:[
        {id:"package_reports", l:"Paket Raporları", icon:"📊"},
      ],
    },
    {
      title:"Genel", icon:"⚙️",
      items:[
        {id:"general", l:"Genel Ayarlar", icon:"⚙️"},
      ],
    },
  ];

  const DETAIL = {
    region_finance:   {title:"Bölge Finansları",   comp:<AdminRegionFinance db={db} save={save} toast={toast}/>},
    courier_finance:  {title:"Kurye Finansları",   comp:<AdminCourierFinanceView db={db} save={save} toast={toast}/>},
    business_finance: {title:"İşletme Finansları", comp:<AdminBusinessFinance db={db} save={save} toast={toast}/>},
    courier_cari:     {title:"Kurye Carileri",     comp:<ProfileCourierCari db={db}/>},
    balance_load:     {title:"Bakiye Yükle",       comp:<ProfileBalanceLoad db={db} save={save} toast={toast}/>},
    package_reports:  {title:"Paket Raporları",    comp:<AdminPackageReports db={db}/>},
    general:          {title:"Genel Ayarlar",      comp:<ProfileGeneral db={db} save={save} setUser={setUser} setSection={setSection}/>},
  };

  // Detay sayfası görünümü
  if(section && DETAIL[section]){
    return(
      <div style={{flex:1,display:"flex",flexDirection:"column",background:"#f2f2f7"}}>
        <div style={{background:"#1a2b4c",padding:"12px 14px",display:"flex",alignItems:"center",gap:10,position:"sticky",top:0,zIndex:10,flexShrink:0}}>
          <button onClick={()=>setSection(null)} style={{background:"rgba(255,255,255,.15)",border:"none",borderRadius:8,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:16,cursor:"pointer"}}>‹</button>
          <p style={{color:"#fff",fontWeight:700,fontSize:15}}>{DETAIL[section].title}</p>
        </div>
        <div style={{flex:1,overflowY:"auto"}}>
          {DETAIL[section].comp}
        </div>
      </div>
    );
  }

  // Hub (ana liste) görünümü
  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:"#f2f2f7"}}>
      <div style={{background:"#fff",padding:"12px 16px",borderBottom:"1px solid #e5e5ea",position:"sticky",top:0,zIndex:10,flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:34,height:34,borderRadius:10,background:"#fdecea",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>⚙️</div>
          <div><p style={{fontWeight:700,fontSize:14,color:"#1c1c1e"}}>{user?.name||"Admin"}</p><p style={{fontSize:11,color:"#8e8e93"}}>Yönetici</p></div>
        </div>
        <button onClick={()=>setUser(null)} style={{padding:"7px 14px",background:"#fdecea",color:"#e53935",border:"none",borderRadius:9,fontSize:12,fontWeight:700,cursor:"pointer"}}>
          ↩ Çıkış
        </button>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:"12px 12px 24px"}}>
        {GROUPS.map(group=>(
          <div key={group.title} style={{marginBottom:14,borderRadius:12,overflow:"hidden",boxShadow:"0 1px 4px rgba(0,0,0,.08)"}}>
            <div style={{background:"#1a2b4c",padding:"12px 16px",display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:15}}>{group.icon}</span>
              <p style={{color:"#fff",fontWeight:700,fontSize:14}}>{group.title}</p>
            </div>
            <div style={{background:"#fff"}}>
              {group.items.map((item,i)=>(
                <button key={item.id} onClick={()=>setSection(item.id)} style={{
                  width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",
                  padding:"14px 16px",border:"none",background:"transparent",cursor:"pointer",textAlign:"left",
                  borderBottom:i<group.items.length-1?"1px solid #f2f2f7":"none",
                }}>
                  <span style={{display:"flex",alignItems:"center",gap:10}}>
                    <span style={{fontSize:15}}>{item.icon}</span>
                    <span style={{fontSize:13,fontWeight:600,color:"#1c1c1e"}}>{item.l}</span>
                  </span>
                  <span style={{display:"flex",alignItems:"center",gap:8}}>
                    {item.badge>0&&<span style={{background:"#e53935",color:"#fff",borderRadius:10,fontSize:10,fontWeight:800,padding:"2px 7px"}}>{item.badge}</span>}
                    <span style={{color:"#e53935",fontSize:15}}>›</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfileBalanceLoad({db,save,toast}){
  const [loadId,setLoadId]=useState("");const [loadAmt,setLoadAmt]=useState("");
  const pending=(db.balanceRequests||[]).filter(r=>r.status==="bekliyor");
  const loadBal=(rid,amt,reqId)=>{const a=parseFloat(amt||loadAmt);const id=rid||loadId;if(!id||isNaN(a)||a<=0)return;const rest=db.restaurants.find(r=>r.id===id);const updR=db.restaurants.map(r=>r.id===id?{...r,balance:r.balance+a}:r);const tx={id:genId(),restId:id,restName:rest?.name,amount:a,time:nowTime(),date:todayStr()};const updReqs=reqId?(db.balanceRequests||[]).map(r=>r.id===reqId?{...r,status:"onaylandı"}:r):(db.balanceRequests||[]);save({...db,restaurants:updR,transactions:[...(db.transactions||[]),tx],balanceRequests:updReqs});toast("₺"+a+" yüklendi","success");setLoadAmt("");setLoadId("");};
  const reject=reqId=>{save({...db,balanceRequests:(db.balanceRequests||[]).map(r=>r.id===reqId?{...r,status:"reddedildi"}:r)});toast("Reddedildi","info");};
  return(
    <div style={{padding:12,display:"flex",flexDirection:"column",gap:10}}>
      {pending.length>0&&<div>
        <p style={{fontWeight:700,fontSize:11,color:"#f9a825",marginBottom:8,textTransform:"uppercase"}}>🔔 Bekleyen Talepler ({pending.length})</p>
        {pending.map(req=>(
          <div key={req.id} style={{background:"#fff",borderRadius:12,padding:"8px 12px",marginBottom:8,borderLeft:"3px solid #f9a825",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div><p style={{fontWeight:700,fontSize:11}}>{req.restName}</p><p style={{fontSize:11,color:"#8e8e93"}}>{req.date} {req.time}</p></div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <p style={{fontWeight:800,fontSize:11,color:"#f9a825"}}>₺{req.amount}</p>
                <button onClick={()=>loadBal(req.restId,req.amount,req.id)} style={{padding:"7px 14px",background:"#4caf50",color:"#fff",border:"none",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer"}}>✅ Onayla</button>
                <button onClick={()=>reject(req.id)} style={{padding:"7px 10px",background:"#fdecea",color:"#e53935",border:"none",borderRadius:9,fontSize:11,cursor:"pointer"}}>❌</button>
              </div>
            </div>
          </div>
        ))}
      </div>}
      <div style={{background:"#fff",borderRadius:12,padding:14,boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
        <p style={{fontWeight:700,fontSize:11,marginBottom:10}}>💳 Manuel Bakiye Yükle</p>
        <select value={loadId} onChange={e=>setLoadId(e.target.value)} style={{width:"100%",padding:"10px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e",marginBottom:8}}>
          <option value="">İşletme seçin...</option>
          {db.restaurants.map(r=><option key={r.id} value={r.id}>{r.name} — ₺{r.balance}</option>)}
        </select>
        <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
          {[50,100,250,500,1000].map(p=><button key={p} onClick={()=>setLoadAmt(String(p))} style={{padding:"7px 14px",borderRadius:8,border:"1.5px solid "+(loadAmt===String(p)?"#e53935":"#e5e5ea"),background:loadAmt===String(p)?"#e53935":"#fff",color:loadAmt===String(p)?"#fff":"#636366",fontSize:11,fontWeight:700,cursor:"pointer"}}>₺{p}</button>)}
        </div>
        <input type="number" value={loadAmt} onChange={e=>setLoadAmt(e.target.value)} placeholder="Özel tutar..." style={{width:"100%",padding:"10px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e",marginBottom:10}}/>
        <button onClick={()=>loadBal()} disabled={!loadId||!loadAmt||parseFloat(loadAmt||0)<=0} style={{width:"100%",padding:"12px",background:loadId&&loadAmt&&parseFloat(loadAmt||0)>0?"#e53935":"#e5e5ea",color:loadId&&loadAmt&&parseFloat(loadAmt||0)>0?"#fff":"#8e8e93",border:"none",borderRadius:10,fontSize:11,fontWeight:700,cursor:"pointer"}}>Bakiye Yükle</button>
      </div>
      <div style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
        <div style={{padding:"7px 11px",borderBottom:"1px solid #f2f2f7"}}><p style={{fontWeight:700,fontSize:11}}>Tüm Bakiyeler</p></div>
        {db.restaurants.map(r=>(
          <div key={r.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 11px",borderBottom:"1px solid #f2f2f7"}}>
            <div><p style={{fontWeight:600,fontSize:11}}>{r.name}</p><p style={{fontSize:11,color:"#8e8e93"}}>{r.totalPackages} paket</p></div>
            <p style={{fontWeight:800,fontSize:11,color:r.balance===0?"#e53935":r.balance<100?"#f9a825":"#4caf50"}}>₺{r.balance}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfileCourierCari({db}){
  const [selId,setSelId]=useState(null);
  const s=db.settings||{};
  return(
    <div style={{padding:12,display:"flex",flexDirection:"column",gap:10}}>
      <div style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
        <div style={{padding:"7px 11px",borderBottom:"1px solid #f2f2f7"}}><p style={{fontWeight:700,fontSize:11}}>Kurye Cari</p></div>
        {db.couriers.map(c=>{
          const cf=s.courierFees?.[c.id];
          const pkgFee=cf?.packageFee??s.courierEarn??25;
          const kmFee=cf?.kmFee??s.kmFee??2.5;
          const kmInt=cf?.kmInterval??s.kmInterval??1;
          const kmEarn=kmInt>0?Math.floor((c.km||0)/kmInt)*kmFee:0;
          const total=(c.earnings||0)+(c.bonus||0);
          const isOpen=selId===c.id;
          const sCol={active:"#4caf50",break:"#f9a825",off:"#9e9e9e"}[c.status]||"#9e9e9e";
          return(
            <div key={c.id}>
              <button onClick={()=>setSelId(isOpen?null:c.id)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",borderBottom:"1px solid #f2f2f7",width:"100%",border:"none",borderBottom:"1px solid #f2f2f7",background:"transparent",cursor:"pointer",textAlign:"left"}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:sCol}}/>
                  <div><p style={{fontWeight:700,fontSize:11,color:"#1c1c1e"}}>{c.name}</p><p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>{c.packages||0} paket · {c.km||0}km</p></div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}><p style={{fontWeight:800,fontSize:11,color:"#4caf50"}}>₺{total}</p><span style={{color:"#c7c7cc",fontSize:11}}>{isOpen?"⌃":"⌄"}</span></div>
              </button>
              {isOpen&&(
                <div style={{background:"#fafafa",borderBottom:"1px solid #f2f2f7",padding:"8px 12px"}}>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:10}}>
                    {[["Paket Başı","₺"+pkgFee,"#e53935"],["KM Modeli","₺"+kmFee+"/"+kmInt+"km","#1e88e5"],["Paket Kazanç","₺"+(c.earnings||0),"#4caf50"],["KM Kazancı","₺"+kmEarn.toFixed(1),"#4caf50"],["Bonus","₺"+(c.bonus||0),"#f9a825"],["TOPLAM","₺"+total,"#e53935"]].map(([l,v,col])=>(
                      <div key={l} style={{background:"#fff",borderRadius:9,padding:"8px",border:"1px solid #f2f2f7"}}><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{l}</p><p style={{fontSize:11,fontWeight:800,color:col}}>{v}</p></div>
                    ))}
                  </div>
                  <div style={{background:"#e9f9ee",borderRadius:8,padding:"8px 12px",fontSize:11,color:"#4caf50",fontWeight:600}}>
                    {c.packages||0} paket × ₺{pkgFee} + KM kazancı ₺{kmEarn.toFixed(1)} + bonus ₺{c.bonus||0} = <strong>₺{total}</strong>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProfileGeneral({db,save,setUser,setSection}){
  const s = db.settings||{};
  const [f,setF] = useState({...s});
  const set = k=>e=>setF(x=>({...x,[k]:+e.target.value}));
  const setMode = mode => setF(x=>({...x,assignMode:mode}));

  const [dailyTiers,setDailyTiers] = useState(s.dailyBonusTiers||[{pkgMin:10,bonus:20},{pkgMin:20,bonus:50},{pkgMin:30,bonus:100}]);
  const [weeklyTiers,setWeeklyTiers] = useState(s.weeklyBonusTiers||[{pkgMin:50,bonus:100},{pkgMin:100,bonus:250},{pkgMin:150,bonus:500}]);

  const saveAll = () => {
    save({...db,settings:{...s,...f,dailyBonusTiers:dailyTiers,weeklyBonusTiers:weeklyTiers}});
  };

  return(
    <div style={{padding:12,display:"flex",flexDirection:"column",gap:12}}>

      {/* Atama Modu */}
      <div style={{background:"#fff",borderRadius:12,padding:14,boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
        <p style={{fontWeight:700,fontSize:13,marginBottom:4}}>🎯 Paket Atama Modu</p>
        <p style={{fontSize:11,color:"#8e8e93",marginBottom:10}}>İşletme "Kurye Çağır" dediğinde sistem nasıl davransın? Bu ayar tüm işletmeler için geçerlidir, işletme kendi ekranından değiştiremez.</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          {[["auto","🤖 Otomatik","En uygun kuryeye sistem otomatik atar"],["manual","✋ Manuel","Admin panelden elle atanmayı bekler"]].map(([id,l,desc])=>(
            <button key={id} onClick={()=>setMode(id)} style={{padding:"12px 10px",borderRadius:10,border:"1.5px solid "+((f.assignMode||"auto")===id?"#e53935":"#e5e5ea"),background:(f.assignMode||"auto")===id?"#fdecea":"#fff",cursor:"pointer",textAlign:"left"}}>
              <p style={{fontSize:12,fontWeight:700,color:(f.assignMode||"auto")===id?"#e53935":"#1c1c1e",marginBottom:3}}>{l}</p>
              <p style={{fontSize:10,color:"#8e8e93",lineHeight:1.4}}>{desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Genel ücretler */}
      <div style={{background:"#fff",borderRadius:12,padding:14,boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
        <p style={{fontWeight:700,fontSize:13,marginBottom:12}}>⚙️ Genel Ayarlar</p>
        {[{k:"packageFee",l:"Paket Ücreti (₺)",tip:"İşletmeden alınan"},{k:"courierEarn",l:"Kurye Kazancı (₺)",tip:"Teslimat başı"},{k:"kmInterval",l:"Her Kaç KM",tip:"KM aralığı"},{k:"kmFee",l:"KM Ücreti (₺)",tip:"Aralık başı"},{k:"assignRadius",l:"Arama Yarıçapı (km)",tip:"Kurye atama mesafesi"},{k:"maxPkgs",l:"Genel Maks. Paket Limiti",tip:"Bir kuryenin aynı anda taşıyabileceği paket sayısı (özel limiti olmayan kuryeler için)"}].map(field=>(
          <div key={field.k} style={{marginBottom:10}}>
            <p style={{fontSize:10,color:"#8e8e93",fontWeight:600,marginBottom:3,textTransform:"uppercase"}}>{field.l}</p>
            <input type="number" step="0.5" value={f[field.k]||""} onChange={set(field.k)} style={{width:"100%",padding:"9px 11px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:12,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
            <p style={{fontSize:10,color:"#aeaeb2",marginTop:2}}>{field.tip}</p>
          </div>
        ))}
      </div>

      {/* Bonus baremleri */}
      <div style={{background:"#fff",borderRadius:12,padding:14,boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
        <p style={{fontWeight:700,fontSize:13,marginBottom:4}}>🎯 Genel Performans Bonusları</p>
        <p style={{fontSize:11,color:"#8e8e93",marginBottom:10}}>Bölge bazlı özel bonus tanımlanmamışsa bu baremler kullanılır.</p>
        <TierTable label="📅 Günlük Baremler" tiers={dailyTiers} onChange={setDailyTiers} color="#f9a825"/>
        <div style={{height:1,background:"#e5e5ea",margin:"12px 0"}}/>
        <TierTable label="📆 Haftalık Baremler" tiers={weeklyTiers} onChange={setWeeklyTiers} color="#8e24aa"/>
      </div>

      {/* Kaydet */}
      <button onClick={saveAll} style={{width:"100%",padding:"12px",background:"#e53935",color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer"}}>💾 Tümünü Kaydet</button>

      {/* Veritabanı sıfırlama */}
      <div style={{background:"#fff",borderRadius:12,padding:14,boxShadow:"0 1px 3px rgba(0,0,0,.06)",border:"1px solid #fdecea"}}>
        <p style={{fontWeight:700,fontSize:13,color:"#e53935",marginBottom:4}}>⚠️ Veritabanını Sıfırla</p>
        <p style={{fontSize:11,color:"#8e8e93",marginBottom:10,lineHeight:1.5}}>Tüm paketler, başvurular, işlemler ve kayıtlı veriler silinir. Varsayılan demo veriye döner. Bu işlem geri alınamaz.</p>
        <button onClick={()=>{
          if(window.confirm("Tüm veriler silinecek ve sistem başa dönecek. Emin misiniz?")){
            save(INIT);
          }
        }} style={{width:"100%",padding:"11px",background:"#fdecea",color:"#e53935",border:"1.5px solid #e53935",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer"}}>
          🗑️ Tüm Verileri Sil ve Sıfırla
        </button>
      </div>
    </div>
  );
}
function RestApp({user,db,save,setUser,toast}){
  const [tab,setTab]=useState("order");
  const [filter,setFilter]=useState("Hepsi");
  const [bolge,setBolge]=useState("Hepsi");
  const [calling,setCalling]=useState(false);
  const restData=db.restaurants.find(r=>r.id===user.id)||{balance:0,totalPackages:0,name:user.name};
  const myPkgs=db.packages.filter(p=>p.restId===user.id);
  const FEE=db.settings?.packageFee||35;
  const callCourier=async(opts={})=>{
    if(restData.balance<FEE||calling)return;
    setCalling(true);
    await new Promise(r=>setTimeout(r,700));
    const deliveryCoords = await geocodeAddress(opts.address);
    const isManualMode = (db.settings?.assignMode)==="manual";
    // Öncelikli kurye + limit kontrolü + en az yüklü kurye mantığıyla en uygun kuryeyi seç
    const courier = pickCourierForAssignment(db, user.id);
    if(!courier && !isManualMode){toast("Şu an müsait kurye yok (tüm kuryeler kapasite dolu veya çevrimdışı)","warning");setCalling(false);return;}
    if(!courier && isManualMode){
      // Manuel atama modu: paket kuryesiz oluşturulur, admin'in ataması beklenir
      const pkg={id:genId(),restaurant:restData.name,restId:user.id,courier:"",courierId:null,status:"Manuel Atama Bekliyor",time:nowTime(),day:"",address:opts.address||"(Adres girilmedi)",lat:deliveryCoords?.lat??null,lng:deliveryCoords?.lng??null,paymentType:opts.pay||"Belirtilmedi",fee:FEE,leftColor:"#f9a825"};
      const updR=db.restaurants.map(r=>r.id===user.id?{...r,balance:r.balance-FEE,totalPackages:r.totalPackages+1}:r);
      save({...db,packages:[...db.packages,pkg],restaurants:updR});
      toast("📋 Paket oluşturuldu, admin ataması bekleniyor","info");
      setCalling(false);
      return;
    }
    const isPriority = courier.priorityRestId===user.id;
    const pkg={id:genId(),restaurant:restData.name,restId:user.id,courier:courier.name,courierId:courier.id,status:"Atandı",time:nowTime(),day:"",address:opts.address||"(Adres girilmedi)",lat:deliveryCoords?.lat??null,lng:deliveryCoords?.lng??null,paymentType:opts.pay||"Belirtilmedi",fee:FEE,leftColor:"#4caf50"};
    const updR=db.restaurants.map(r=>r.id===user.id?{...r,balance:r.balance-FEE,totalPackages:r.totalPackages+1}:r);
    save({...db,packages:[...db.packages,pkg],restaurants:updR});
    toast("✅ "+courier.name+(isPriority?" (öncelikli) ":" ")+"yola çıkıyor!","success");
    setCalling(false);
  };
  const tabs=[{id:"order",label:"Kurye",icon:"🛵"},{id:"packages",label:"Paketler",icon:"📦"},{id:"map",label:"Harita",icon:"🗺️"},{id:"profile",label:"Profil",icon:"👤"}];
  const shown=myPkgs.filter(p=>filter==="Hepsi"||p.status===filter);
  return(
    <div style={{display:"flex",flexDirection:"column",flex:1,minHeight:"100vh"}}>
      {tab==="order"&&<RestOrderScreen restData={restData} db={db} callCourier={callCourier} calling={calling} FEE={FEE}/>}
      {tab==="packages"&&<><TopBar bolge={bolge} setBolge={setBolge} filter={filter} setFilter={setFilter} onMapClick={()=>setTab("map")}/><div style={{flex:1,overflowY:"auto",background:"#fff"}}>{shown.length===0?<p style={{textAlign:"center",padding:"48px 20px",color:"#8e8e93"}}>Paket yok</p>:shown.map(p=><PkgRow key={p.id} pkg={p}/>)}</div></>}
      {tab==="map"&&<RestMapScreen db={db} myPkgs={myPkgs} restData={restData} callCourier={callCourier} calling={calling} FEE={FEE}/>}
      {tab==="profile"&&<RestProfileScreen user={user} setUser={setUser} restData={restData} myPkgs={myPkgs} db={db} save={save} toast={toast} callCourier={callCourier} calling={calling} FEE={FEE}/>}
      <BottomNav tabs={tabs} active={tab} setActive={setTab}/>
    </div>
  );
}

function RestIntegrations({db,save,user,restData,callCourier,calling,FEE,toast}){
  const [sub,setSub]=useState("overview");
  const integKey=user.id+"_integrations";
  const [cfg,setCfg]=useState(()=>{
    try{const s=localStorage.getItem(integKey);return s?JSON.parse(s):{
      migros:{active:false,apiKey:"",storeId:"",autoDispatch:true,lastSync:null,orders:[]},
      yemeksepeti:{active:false,apiKey:"",restaurantId:"",autoDispatch:true,lastSync:null,orders:[]},
      trendyol:{active:false,apiKey:"",supplierId:"",secretKey:"",autoDispatch:true,lastSync:null,orders:[]},
      getir:{active:false,apiKey:"",restaurantId:"",autoDispatch:true,lastSync:null,orders:[]},
      yemekte:{active:false,apiKey:"",restaurantId:"",autoDispatch:true,lastSync:null,orders:[]},
      sepettakip:{active:false,apiKey:"",storeId:"",autoDispatch:true,lastSync:null,orders:[]},
      yemekpos:{active:false,apiKey:"",terminalId:"",autoDispatch:true,lastSync:null,orders:[]},
      desenpos:{active:false,apiKey:"",branchId:"",autoDispatch:true,lastSync:null,orders:[]},
    };}catch{return {
      migros:{active:false,apiKey:"",storeId:"",autoDispatch:true,lastSync:null,orders:[]},
      yemeksepeti:{active:false,apiKey:"",restaurantId:"",autoDispatch:true,lastSync:null,orders:[]},
      trendyol:{active:false,apiKey:"",supplierId:"",secretKey:"",autoDispatch:true,lastSync:null,orders:[]},
      getir:{active:false,apiKey:"",restaurantId:"",autoDispatch:true,lastSync:null,orders:[]},
      yemekte:{active:false,apiKey:"",restaurantId:"",autoDispatch:true,lastSync:null,orders:[]},
      sepettakip:{active:false,apiKey:"",storeId:"",autoDispatch:true,lastSync:null,orders:[]},
      yemekpos:{active:false,apiKey:"",terminalId:"",autoDispatch:true,lastSync:null,orders:[]},
      desenpos:{active:false,apiKey:"",branchId:"",autoDispatch:true,lastSync:null,orders:[]},
    };}
  });
  const [syncing,setSyncing]=useState({});
  const [importing,setImporting]=useState(null);

  const saveCfg=newCfg=>{setCfg(newCfg);try{localStorage.setItem(integKey,JSON.stringify(newCfg));}catch{}};
  const updPlatform=(platform,key,val)=>saveCfg({...cfg,[platform]:{...cfg[platform],[key]:val}});

  // Simüle edilmiş sipariş çekme
  const syncOrders=async platform=>{
    const p=cfg[platform];
    if(!p.apiKey){toast("API Key giriniz","warning");return;}
    setSyncing(s=>({...s,[platform]:true}));
    await new Promise(r=>setTimeout(r,1800));
    const SAMPLE={
      migros:[
        {id:"MG"+genId(),platform:"migros",address:"Bağcılar Mahallesi No:14",payType:"Online",amount:89.90,items:"1x Süt, 2x Yoğurt, 1x Ekmek",time:nowTime()},
        {id:"MG"+genId(),platform:"migros",address:"Esenler Cad. 45/3",payType:"Online",amount:145.50,items:"3x Meyve Suyu, 1x Peynir",time:nowTime()},
      ],
      yemeksepeti:[
        {id:"YS"+genId(),platform:"yemeksepeti",address:"Kadıköy Merkez 12/A",payType:"Online",amount:67.00,items:"1x Burger Menü, 1x Kola",time:nowTime()},
        {id:"YS"+genId(),platform:"yemeksepeti",address:"Üsküdar İstiklal Sk. 8",payType:"Nakit",amount:112.00,items:"2x Pizza, 1x Salata",time:nowTime()},
        {id:"YS"+genId(),platform:"yemeksepeti",address:"Beşiktaş Barbaros Blv.",payType:"Kredi Kartı",amount:54.50,items:"1x Lahmacun Seti",time:nowTime()},
      ],
      trendyol:[
        {id:"TY"+genId(),platform:"trendyol",address:"Şişli Halaskargazi 77",payType:"Online",amount:199.00,items:"Hızlı Teslimat #TY-48291",time:nowTime()},
        {id:"TY"+genId(),platform:"trendyol",address:"Levent Nispetiye Cad.",payType:"Online",amount:89.99,items:"Hızlı Teslimat #TY-48292",time:nowTime()},
      ],
      getir:[
        {id:"GT"+genId(),platform:"getir",address:"Kadıköy Moda Cad. 34",payType:"Online",amount:78.50,items:"1x Tavuk Döner, 1x Ayran",time:nowTime()},
        {id:"GT"+genId(),platform:"getir",address:"Beşiktaş Çarşı Sk. 12",payType:"Nakit",amount:134.00,items:"2x Köfte Ekmek, 1x Patates",time:nowTime()},
        {id:"GT"+genId(),platform:"getir",address:"Üsküdar Bağlarbaşı 7/A",payType:"Online",amount:56.90,items:"1x Lahmacun, 1x İçecek",time:nowTime()},
      ],
      yemekte:[
        {id:"YM"+genId(),platform:"yemekte",address:"Ataşehir Mimar Sinan Blv.",payType:"Kredi Kartı",amount:92.00,items:"1x Pide Menü, 1x Çorba",time:nowTime()},
        {id:"YM"+genId(),platform:"yemekte",address:"Maltepe Bağlarbaşı Cad. 5",payType:"Online",amount:165.50,items:"3x Izgara Tavuk, 2x Pilav",time:nowTime()},
      ],
      sepettakip:[
        {id:"ST"+genId(),platform:"sepettakip",address:"Bağcılar Yıldızlar Sk. 3",payType:"Nakit",amount:45.00,items:"1x Döner Dürüm",time:nowTime()},
        {id:"ST"+genId(),platform:"sepettakip",address:"Esenler Fatih Cad. 88",payType:"Kredi Kartı",amount:118.00,items:"2x Izgara Köfte Menü",time:nowTime()},
        {id:"ST"+genId(),platform:"sepettakip",address:"Güngören Merkez 14/B",payType:"Online",amount:67.50,items:"1x Tavuk Şiş, 1x Ayran",time:nowTime()},
      ],
      yemekpos:[
        {id:"YP"+genId(),platform:"yemekpos",address:"Bahçelievler Adnan Kahveci",payType:"Kredi Kartı",amount:87.00,items:"POS Sipariş #YP-1042",time:nowTime()},
        {id:"YP"+genId(),platform:"yemekpos",address:"Küçükçekmece Merkez 5",payType:"Nakit",amount:54.00,items:"POS Sipariş #YP-1043",time:nowTime()},
      ],
      desenpos:[
        {id:"DP"+genId(),platform:"desenpos",address:"Sultangazi İsmetpaşa Cad.",payType:"Online",amount:132.00,items:"DesenPOS #DP-8821",time:nowTime()},
        {id:"DP"+genId(),platform:"desenpos",address:"Gaziosmanpaşa Merkez 22",payType:"Kredi Kartı",amount:76.50,items:"DesenPOS #DP-8822",time:nowTime()},
        {id:"DP"+genId(),platform:"desenpos",address:"Eyüpsultan Rami Cad. 9",payType:"Nakit",amount:49.00,items:"DesenPOS #DP-8823",time:nowTime()},
      ],
    };
    const newOrders=SAMPLE[platform]||[];
    saveCfg({...cfg,[platform]:{...cfg[platform],orders:newOrders,lastSync:nowTime(),active:true}});
    setSyncing(s=>({...s,[platform]:false}));
    toast(platform+" siparişleri çekildi: "+newOrders.length+" sipariş","success");
  };

  // Siparişi JETLA'ya aktar → kurye çağır
  const importOrder=async(platform,order)=>{
    if(restData.balance<FEE){toast("Yetersiz bakiye","error");return;}
    setImporting(order.id);
    await new Promise(r=>setTimeout(r,800));
    const deliveryCoords = await geocodeAddress(order.address);
    // Öncelikli kurye + limit kontrolü + en az yüklü kurye mantığıyla en uygun kuryeyi seç
    const isManualMode = (db.settings?.assignMode)==="manual";
    const courier = pickCourierForAssignment(db, user.id);
    if(!courier && !isManualMode){toast("Şu an müsait kurye yok (tüm kuryeler kapasite dolu veya çevrimdışı)","warning");setImporting(null);return;}
    if(!courier && isManualMode){
      const pkg={id:genId(),restaurant:restData.name,restId:user.id,courier:"",courierId:null,status:"Manuel Atama Bekliyor",time:nowTime(),day:"",address:order.address,lat:deliveryCoords?.lat??null,lng:deliveryCoords?.lng??null,paymentType:order.payType,fee:FEE,leftColor:"#f9a825",platform:order.platform,platformOrderId:order.id,amount:order.amount};
      const updR=db.restaurants.map(r=>r.id===user.id?{...r,balance:r.balance-FEE,totalPackages:r.totalPackages+1}:r);
      save({...db,packages:[...db.packages,pkg],restaurants:updR});
      const updOrders=cfg[platform].orders.filter(o=>o.id!==order.id);
      saveCfg({...cfg,[platform]:{...cfg[platform],orders:updOrders}});
      toast("📋 "+order.address+" → admin ataması bekleniyor","info");
      setImporting(null);
      return;
    }
    const isPriority = courier.priorityRestId===user.id;
    const pkg={id:genId(),restaurant:restData.name,restId:user.id,courier:courier.name,courierId:courier.id,status:"Atandı",time:nowTime(),day:"",address:order.address,lat:deliveryCoords?.lat??null,lng:deliveryCoords?.lng??null,paymentType:order.payType,fee:FEE,leftColor:"#4caf50",platform:order.platform,platformOrderId:order.id,amount:order.amount};
    const updR=db.restaurants.map(r=>r.id===user.id?{...r,balance:r.balance-FEE,totalPackages:r.totalPackages+1}:r);
    save({...db,packages:[...db.packages,pkg],restaurants:updR});
    // Siparişi listeden çıkar
    const updOrders=cfg[platform].orders.filter(o=>o.id!==order.id);
    saveCfg({...cfg,[platform]:{...cfg[platform],orders:updOrders}});
    toast("✅ "+courier.name+(isPriority?" (öncelikli)":"")+" → "+order.address,"success");
    setImporting(null);
  };

  const importAll=async platform=>{
    const orders=cfg[platform].orders;
    if(!orders.length)return;
    for(const order of orders) await importOrder(platform,order);
  };

  const PLATFORMS={
    migros:{
      name:"Migros Sanal Market",
      logo:"🟠",
      color:"#FF6000",
      bg:"#fff5ee",
      border:"#FF6000",
      desc:"Migros Sanal Market API entegrasyonu",
      fields:[{k:"apiKey",l:"API Key",ph:"mgr_live_xxxxx"},{k:"storeId",l:"Mağaza ID",ph:"12345"}],
    },
    yemeksepeti:{
      name:"Yemeksepeti",
      logo:"🔴",
      color:"#FA0050",
      bg:"#fff0f4",
      border:"#FA0050",
      desc:"Yemeksepeti Restaurant API entegrasyonu",
      fields:[{k:"apiKey",l:"API Key",ph:"ys_api_xxxxx"},{k:"restaurantId",l:"Restoran ID",ph:"R-12345"}],
    },
    trendyol:{
      name:"Trendyol Yemek",
      logo:"🟡",
      color:"#F27A1A",
      bg:"#fffbf0",
      border:"#F27A1A",
      desc:"Trendyol Go Market & Yemek entegrasyonu",
      fields:[{k:"apiKey",l:"API Key",ph:"ty_api_xxxxx"},{k:"supplierId",l:"Tedarikçi ID",ph:"12345"},{k:"secretKey",l:"Secret Key",ph:"ty_secret_xxxxx"}],
    },
    getir:{
      name:"Getir",
      logo:"🟣",
      color:"#5D3EBC",
      bg:"#f5f0ff",
      border:"#5D3EBC",
      desc:"Getir sipariş entegrasyonu",
      fields:[{k:"apiKey",l:"API Key",ph:"getir_api_xxxxx"},{k:"restaurantId",l:"Restoran ID",ph:"GT-12345"}],
    },
    yemekte:{
      name:"Yemekte",
      logo:"🟤",
      color:"#C0392B",
      bg:"#fff5f5",
      border:"#C0392B",
      desc:"Yemekte.com sipariş entegrasyonu",
      fields:[{k:"apiKey",l:"API Key",ph:"ym_api_xxxxx"},{k:"restaurantId",l:"Restoran ID",ph:"YM-12345"}],
      webhookNote:"Webhook URL'nizi Yemekte paneline tanımlayın.",
    },
    sepettakip:{
      name:"SepetTakip",
      logo:"🛒",
      color:"#2980B9",
      bg:"#edf6ff",
      border:"#2980B9",
      desc:"SepetTakip POS webhook entegrasyonu",
      fields:[{k:"apiKey",l:"API Key",ph:"st_api_xxxxx"},{k:"storeId",l:"Mağaza ID",ph:"ST-12345"}],
      webhookNote:"SepetTakip panelinizden Webhook → JETLA URL'sini tanımlayın.",
      isPos:true,
    },
    yemekpos:{
      name:"YemekPos",
      logo:"🖨️",
      color:"#8E44AD",
      bg:"#f8f0ff",
      border:"#8E44AD",
      desc:"YemekPos POS sistemi entegrasyonu",
      fields:[{k:"apiKey",l:"API Key",ph:"yp_api_xxxxx"},{k:"terminalId",l:"Terminal ID",ph:"YP-T-001"}],
      webhookNote:"YemekPos → Ayarlar → Entegrasyon menüsünden JETLA webhook URL'sini girin.",
      isPos:true,
    },
    desenpos:{
      name:"DesenPos",
      logo:"💻",
      color:"#16A085",
      bg:"#edfaf5",
      border:"#16A085",
      desc:"DesenPos POS sistemi entegrasyonu",
      fields:[{k:"apiKey",l:"API Key",ph:"dp_api_xxxxx"},{k:"branchId",l:"Şube ID",ph:"DP-S-001"}],
      webhookNote:"DesenPos → Sistem → Dış Entegrasyonlar menüsünden JETLA webhook URL'sini tanımlayın.",
      isPos:true,
    },
  };

  const totalPending=Object.values(cfg).reduce((s,p)=>s+(p.orders?.length||0),0);
  const activeCount=Object.values(cfg).filter(p=>p.active).length;

  return(
    <div style={{flex:1,overflowY:"auto",background:"#f2f2f7"}}>
      {/* Başlık */}
      <div style={{background:"#fff",padding:"9px 13px 0",borderBottom:"1px solid #e5e5ea",position:"sticky",top:0,zIndex:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <p style={{fontWeight:700,fontSize:11}}>🔗 Platform Entegrasyonları</p>
          {totalPending>0&&<span style={{background:"#e53935",color:"#fff",borderRadius:10,fontSize:11,fontWeight:800,padding:"3px 10px"}}>{totalPending} yeni sipariş</span>}
        </div>
        <div style={{display:"flex",gap:0,overflowX:"auto"}}>
          {[{id:"overview",l:"Genel"},{id:"migros",l:"Migros"},{id:"yemeksepeti",l:"Yemeksepeti"},{id:"trendyol",l:"Trendyol"},{id:"getir",l:"Getir"},{id:"yemekte",l:"Yemekte"},{id:"sepettakip",l:"SepetTakip"},{id:"yemekpos",l:"YemekPos"},{id:"desenpos",l:"DesenPos"}].map(s=>(
            <button key={s.id} onClick={()=>setSub(s.id)} style={{flexShrink:0,padding:"9px 14px",border:"none",background:"transparent",fontSize:11,fontWeight:600,cursor:"pointer",color:sub===s.id?"#e53935":"#8e8e93",borderBottom:sub===s.id?"2.5px solid #e53935":"2.5px solid transparent",transition:"all .15s",display:"flex",alignItems:"center",gap:4}}>
              {s.id!=="overview"&&<span style={{fontSize:11}}>{PLATFORMS[s.id]?.logo}</span>}
              {s.l}
              {s.id!=="overview"&&cfg[s.id]?.orders?.length>0&&<span style={{background:"#e53935",color:"#fff",borderRadius:10,fontSize:11,fontWeight:800,padding:"1px 5px"}}>{cfg[s.id].orders.length}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* GENEL BAKIŞ */}
      {sub==="overview"&&(
        <div style={{padding:12,display:"flex",flexDirection:"column",gap:10}}>
          {/* Özet istatistik */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
            {[["Bağlı Platform",activeCount+"/3","#4caf50"],["Bekleyen Sipariş",totalPending,"#e53935"],["Bakiye","₺"+restData.balance,restData.balance>0?"#4caf50":"#e53935"]].map(([l,v,c])=>(
              <div key={l} style={{background:"#fff",borderRadius:12,padding:"12px 10px",textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
                <p style={{fontSize:11,fontWeight:800,color:c,lineHeight:1}}>{v}</p>
                <p style={{fontSize:11,color:"#8e8e93",marginTop:4,fontWeight:600}}>{l}</p>
              </div>
            ))}
          </div>

          {/* Platform kartları */}
          {Object.entries(PLATFORMS).map(([key,pl])=>{
            const p=cfg[key];
            const pending=p.orders?.length||0;
            return(
              <div key={key} style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.05)",borderLeft:"3px solid "+(p.active?pl.color:"#e5e5ea")}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:40,height:40,borderRadius:10,background:pl.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,border:"1px solid "+pl.border+"33"}}>{pl.logo}</div>
                    <div>
                      <p style={{fontWeight:700,fontSize:11}}>{pl.name}</p>
                      <p style={{fontSize:11,color:p.active?"#4caf50":"#9e9e9e",marginTop:1,fontWeight:600}}>{p.active?"● Bağlı":"○ Bağlı Değil"}{p.lastSync?" · Son: "+p.lastSync:""}</p>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    {pending>0&&<span style={{background:"#fdecea",color:"#e53935",borderRadius:8,fontSize:11,fontWeight:800,padding:"3px 10px"}}>{pending} sipariş</span>}
                    <button onClick={()=>setSub(key)} style={{padding:"7px 14px",background:p.active?pl.color:"#f2f2f7",color:p.active?"#fff":"#636366",border:"none",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                      {p.active?"Yönet":"Bağla"}
                    </button>
                  </div>
                </div>
                {pending>0&&(
                  <div style={{padding:"0 14px 12px",display:"flex",gap:8}}>
                    <button onClick={()=>importAll(key)} disabled={calling||restData.balance<FEE} style={{flex:1,padding:"8px",background:pl.color,color:"#fff",border:"none",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer",opacity:restData.balance<FEE?.5:1}}>
                      🚀 Tümünü JETLA'ya Aktar ({pending})
                    </button>
                    <button onClick={()=>setSub(key)} style={{padding:"8px 14px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:9,fontSize:11,fontWeight:600,cursor:"pointer"}}>İncele</button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Bilgi notu */}
          <div style={{background:"#fff",borderRadius:12,padding:"10px 12px",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
            <p style={{fontWeight:700,fontSize:11,marginBottom:8}}>ℹ️ Entegrasyon Nasıl Çalışır?</p>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {["1. İlgili platformun API bilgilerini girin","2. \"Siparişleri Çek\" ile yeni siparişleri getirin","3. Siparişleri tek tek veya toplu JETLA'ya aktarın","4. Otomatik kurye ataması gerçekleşir"].map(s=>(
                <p key={s} style={{fontSize:11,color:"#636366"}}>{s}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* PLATFORM DETAY SAYFASI */}
      {sub!=="overview"&&PLATFORMS[sub]&&(()=>{
        const key=sub;
        const pl=PLATFORMS[key];
        const p=cfg[key];
        return(
          <div style={{padding:12,display:"flex",flexDirection:"column",gap:10}}>
            {/* Platform başlık kartı */}
            <div style={{background:"#fff",borderRadius:10,padding:"11px",boxShadow:"0 1px 3px rgba(0,0,0,.05)",borderTop:"3px solid "+pl.color}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
                <div style={{width:48,height:48,borderRadius:12,background:pl.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,border:"1.5px solid "+pl.color+"44"}}>{pl.logo}</div>
                <div>
                  <p style={{fontWeight:800,fontSize:11,color:"#1c1c1e"}}>{pl.name}</p>
                  <p style={{fontSize:11,color:"#8e8e93",marginTop:2}}>{pl.desc}</p>
                </div>
                <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:11,fontWeight:700,color:p.active?"#4caf50":"#9e9e9e"}}>{p.active?"● Bağlı":"○ Bağlı Değil"}</span>
                </div>
              </div>

              {/* POS sistemleri için webhook bilgi kartı */}
              {pl.isPos&&(
                <div style={{background:"#fff8e1",borderRadius:12,padding:"10px 12px",boxShadow:"0 1px 3px rgba(0,0,0,.05)",border:"1.5px solid #f9a825",marginBottom:0}}>
                  <p style={{fontWeight:700,fontSize:11,color:"#f9a825",marginBottom:8}}>⚡ Webhook Entegrasyonu</p>
                  <p style={{fontSize:11,color:"#636366",marginBottom:10,lineHeight:1.6}}>{pl.webhookNote}</p>
                  <div style={{background:"#fff",borderRadius:8,padding:"10px 12px",border:"1px solid #e5e5ea"}}>
                    <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:4}}>JETLA Webhook URL (Simülasyon)</p>
                    <p style={{fontSize:11,fontFamily:"monospace",color:"#1c1c1e",wordBreak:"break-all"}}>https://api.jetla.app/webhook/{key}</p>
                  </div>
                  <div style={{marginTop:10,background:"#fff",borderRadius:8,padding:"10px 12px",border:"1px solid #e5e5ea"}}>
                    <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:6}}>Entegrasyon Adımları</p>
                    {[
                      "1. API Key ve Terminal/Şube ID bilgilerini girin",
                      "2. Yukarıdaki Webhook URL'ini POS sisteminize tanımlayın",
                      "3. \"Bağlantıyı Test Et\" ile simülasyonu çalıştırın",
                      "4. Gerçek siparişler otomatik JETLA'ya düşer",
                    ].map(s=><p key={s} style={{fontSize:11,color:"#636366",marginBottom:3}}>{s}</p>)}
                  </div>
                </div>
              )}

              {/* API Ayarları */}
              <p style={{fontWeight:700,fontSize:11,marginBottom:10,color:"#1c1c1e"}}>API Ayarları</p>
              {pl.fields.map(f=>(
                <div key={f.k} style={{marginBottom:10}}>
                  <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:4}}>{f.l}</p>
                  <input
                    type={f.k.toLowerCase().includes("secret")||f.k.toLowerCase().includes("key")?"password":"text"}
                    value={p[f.k]||""}
                    onChange={e=>updPlatform(key,f.k,e.target.value)}
                    placeholder={f.ph}
                    style={{width:"100%",padding:"10px 12px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}
                  />
                </div>
              ))}

              {/* Otomatik aktarım toggle */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 12px",background:"#f9f9f9",borderRadius:9,marginBottom:12}}>
                <div>
                  <p style={{fontWeight:600,fontSize:11}}>Otomatik Kurye Ata</p>
                  <p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>Sipariş aktarılınca kurye otomatik atanır</p>
                </div>
                <button onClick={()=>updPlatform(key,"autoDispatch",!p.autoDispatch)} style={{width:44,height:26,borderRadius:13,background:p.autoDispatch?pl.color:"#d1d1d6",border:"none",cursor:"pointer",position:"relative",transition:"background .2s"}}>
                  <div style={{position:"absolute",top:3,left:p.autoDispatch?20:3,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.3)"}}/>
                </button>
              </div>

              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>syncOrders(key)} disabled={syncing[key]} style={{flex:1,padding:"11px",background:syncing[key]?"#e5e5ea":pl.color,color:syncing[key]?"#8e8e93":"#fff",border:"none",borderRadius:10,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                  {syncing[key]?"⏳ Çekiliyor...":"🔄 Siparişleri Çek"}
                </button>
                {p.lastSync&&<button onClick={()=>updPlatform(key,"active",false)} style={{padding:"8px 11px",background:"#fdecea",color:"#e53935",border:"none",borderRadius:10,fontSize:11,fontWeight:700,cursor:"pointer"}}>Bağlantıyı Kes</button>}
              </div>
              {p.lastSync&&<p style={{fontSize:11,color:"#8e8e93",marginTop:6,textAlign:"center"}}>Son senkronizasyon: {p.lastSync}</p>}
            </div>

            {/* Bekleyen siparişler */}
            {p.orders?.length>0&&(
              <div style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
                <div style={{padding:"8px 12px",borderBottom:"1px solid #f2f2f7",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <p style={{fontWeight:700,fontSize:11}}>Bekleyen Siparişler ({p.orders.length})</p>
                  <button onClick={()=>importAll(key)} disabled={restData.balance<FEE} style={{padding:"7px 14px",background:pl.color,color:"#fff",border:"none",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer",opacity:restData.balance<FEE?.5:1}}>
                    🚀 Tümünü Aktar
                  </button>
                </div>
                {restData.balance<FEE&&<div style={{padding:"7px 11px",background:"#fff8e1",borderBottom:"1px solid #f2f2f7"}}><p style={{fontSize:11,color:"#f9a825",fontWeight:600}}>⚠️ Bakiye yetersiz — her aktarım ₺{FEE} düşülür</p></div>}
                {p.orders.map(order=>(
                  <div key={order.id} style={{padding:"8px 12px",borderBottom:"1px solid #f2f2f7"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                          <span style={{fontSize:11,fontFamily:"monospace",color:pl.color,fontWeight:800,background:pl.bg,borderRadius:5,padding:"2px 7px"}}>{order.id}</span>
                          <span style={{fontSize:11,color:PAY_COLORS[order.payType]||"#8e8e93",fontWeight:700}}>{order.payType}</span>
                        </div>
                        <p style={{fontSize:11,fontWeight:600,color:"#1c1c1e",marginBottom:2}}>📍 {order.address}</p>
                        <p style={{fontSize:11,color:"#8e8e93"}}>{order.items}</p>
                      </div>
                      <div style={{textAlign:"right",marginLeft:10,flexShrink:0}}>
                        <p style={{fontWeight:800,fontSize:11,color:"#4caf50"}}>₺{order.amount}</p>
                        <p style={{fontSize:11,color:"#8e8e93",marginTop:2}}>{order.time}</p>
                      </div>
                    </div>
                    <button onClick={()=>importOrder(key,order)} disabled={importing===order.id||restData.balance<FEE} style={{width:"100%",padding:"9px",background:importing===order.id?"#e5e5ea":restData.balance>=FEE?"#1c1c1e":"#e5e5ea",color:importing===order.id||restData.balance<FEE?"#8e8e93":"#fff",border:"none",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                      {importing===order.id?"⏳ Aktarılıyor...":"🛵 Kurye Çağır (₺"+FEE+" düşülür)"}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {p.orders?.length===0&&p.lastSync&&(
              <div style={{background:"#fff",borderRadius:12,padding:"32px 16px",textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
                <p style={{fontSize:11,marginBottom:10}}>✅</p>
                <p style={{fontWeight:700,fontSize:11,color:"#4caf50"}}>Tüm siparişler aktarıldı!</p>
                <p style={{fontSize:11,color:"#8e8e93",marginTop:6}}>Yeni siparişler için tekrar çekin</p>
              </div>
            )}

            {!p.lastSync&&(
              <div style={{background:"#fff",borderRadius:12,padding:"28px 16px",textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
                <p style={{fontSize:30,marginBottom:10}}>{pl.logo}</p>
                <p style={{fontWeight:700,fontSize:11,color:"#1c1c1e",marginBottom:6}}>Henüz bağlanmadı</p>
                <p style={{fontSize:11,color:"#8e8e93"}}>API bilgilerini girin ve "Siparişleri Çek" butonuna tıklayın</p>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

function RestOrderScreen({restData,db,callCourier,calling,FEE}){
  const [addr,setAddr]=useState("");const [pay,setPay]=useState("");
  const avail=db.couriers.filter(c=>c.status==="active");
  const canCall=restData.balance>=FEE;
  const go=async()=>{await callCourier({address:addr,pay});setAddr("");setPay("");};
  return(
    <div style={{flex:1,overflowY:"auto",background:"#f2f2f7"}}>
      <div style={{background:"#fff",padding:"9px 12px",borderBottom:"1px solid #e5e5ea",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0}}>
        <p style={{fontWeight:700,fontSize:11}}>Kurye Çağır</p>
        <div style={{background:restData.balance>0?"#e9f9ee":"#fdecea",borderRadius:9,padding:"5px 12px",border:"1px solid "+(restData.balance>0?"#4caf50":"#e53935")}}>
          <span style={{fontWeight:800,fontSize:11,color:restData.balance>0?"#4caf50":"#e53935"}}>₺{restData.balance}</span>
        </div>
      </div>
      {!canCall&&<div style={{margin:"12px 12px 0",background:"#fdecea",borderRadius:10,padding:"9px 12px"}}><p style={{color:"#e53935",fontWeight:600,fontSize:11}}>🚫 Yetersiz bakiye — min. ₺{FEE}</p></div>}
      <div style={{padding:12}}>
        <div style={{background:"#fff",borderRadius:12,padding:20,boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,marginBottom:5,textTransform:"uppercase"}}>Teslimat Adresi</p><input value={addr} onChange={e=>setAddr(e.target.value)} placeholder="Mahalle, cadde, no..." style={{width:"100%",padding:"8px 11px",border:"1.5px solid #e5e5ea",borderRadius:10,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/></div>
            <div><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,marginBottom:5,textTransform:"uppercase"}}>Ödeme Tipi</p>
              <select value={pay} onChange={e=>setPay(e.target.value)} style={{width:"100%",padding:"8px 11px",border:"1.5px solid #e5e5ea",borderRadius:10,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}>
                <option value="">Seçin (opsiyonel)</option>
                {Object.entries(PAY_GROUPS).map(([group,types])=>(
                  <optgroup key={group} label={group}>
                    {types.map(t=><option key={t} value={t}>{t}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div style={{background:"#f2f2f7",borderRadius:10,padding:"8px 11px"}}><p style={{fontSize:11,color:"#8e8e93",marginBottom:4}}>Düşülecek</p><p style={{fontWeight:800,fontSize:11,color:"#e53935"}}>₺{FEE}</p></div>
              <div style={{background:"#f2f2f7",borderRadius:10,padding:"8px 11px"}}><p style={{fontSize:11,color:"#8e8e93",marginBottom:4}}>Kalan</p><p style={{fontWeight:800,fontSize:11,color:restData.balance-FEE>=0?"#4caf50":"#e53935"}}>₺{restData.balance-FEE}</p></div>
            </div>
            {avail.length===0&&<p style={{color:"#f9a825",fontSize:11}}>⚠️ Şu an aktif kurye yok.</p>}
            <button onClick={go} disabled={!canCall||calling||avail.length===0} style={{padding:"14px",background:canCall&&avail.length>0?"#e53935":"#e5e5ea",color:canCall&&avail.length>0?"#fff":"#8e8e93",border:"none",borderRadius:12,fontSize:11,fontWeight:700,cursor:"pointer"}}>
              {calling?"Aranıyor...":"🛵 Kurye Çağır"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RestMapScreen({db,myPkgs,restData,callCourier,calling,FEE}){
  const [selPin,setSelPin]=useState(null);
  const activePkgs=myPkgs.filter(p=>p.status==="Atandı"||p.status==="Onaylandı"||p.status==="Teslimat Aşamasında");
  const waitPkgs=myPkgs.filter(p=>p.status==="Oluşturuldu");
  const donePkgs=myPkgs.filter(p=>p.status==="Teslim Edildi");
  const canCall=restData.balance>=FEE;

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:"#f2f2f7"}}>
      <div style={{background:"#fff",padding:"9px 12px",borderBottom:"1px solid #e5e5ea",flexShrink:0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <p style={{fontWeight:700,fontSize:13}}>🗺️ Canlı Takip</p>
          <div style={{display:"flex",alignItems:"center",gap:6,background:"#e9f9ee",borderRadius:8,padding:"4px 10px"}}><span style={{width:7,height:7,borderRadius:"50%",background:"#4caf50",display:"inline-block",animation:"pulse 1.5s infinite"}}/><span style={{fontSize:11,fontWeight:700,color:"#4caf50"}}>CANLI</span></div>
        </div>
        <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
          {[["Yolda",activePkgs.length,"#1e88e5"],["Bekliyor",waitPkgs.length,"#f9a825"],["Teslim",donePkgs.length,"#4caf50"]].map(([l,v,c])=>(
            <span key={l} style={{fontSize:11,color:c,fontWeight:700}}>{l}: {v}</span>
          ))}
          <div style={{marginLeft:"auto",background:restData.balance>0?"#e9f9ee":"#fdecea",borderRadius:7,padding:"3px 10px"}}><span style={{fontSize:11,fontWeight:700,color:restData.balance>0?"#4caf50":"#e53935"}}>₺{restData.balance}</span></div>
        </div>
      </div>

      <div style={{position:"relative",height:300,flexShrink:0,background:"#e8f0e8",overflow:"hidden"}}>
        {restData.lat && restData.lng ? (
          <MapContainer center={[restData.lat,restData.lng]} zoom={14} style={{height:"100%",width:"100%"}} scrollWheelZoom={false}>
            <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
            <Marker position={[restData.lat,restData.lng]} icon={coloredIcon("#e53935")}>
              <Popup>🏪 {restData.name} (Sizin işletmeniz)</Popup>
            </Marker>
            {activePkgs.filter(p=>p.lat&&p.lng).map(p=>(
              <Marker key={p.id} position={[p.lat,p.lng]} icon={coloredIcon(STATUS_COLORS[p.status]||"#8e8e93")} eventHandlers={{click:()=>setSelPin(p.id)}}>
                <Popup>
                  <strong>#{p.id}</strong><br/>
                  {p.courier||"—"}<br/>
                  <span style={{color:STATUS_COLORS[p.status]}}>{p.status}</span>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        ) : (
          <div style={{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8}}>
            <p style={{fontSize:13,color:"#8e8e93",fontWeight:600}}>📍 İşletme konumu bulunamadı</p>
            <p style={{fontSize:11,color:"#aeaeb2",textAlign:"center",maxWidth:220}}>Admin panelinden adresinizi güncelleyerek haritada görünmenizi sağlayabilirsiniz.</p>
          </div>
        )}
        <div style={{position:"absolute",top:10,left:10,background:"rgba(255,255,255,.92)",borderRadius:8,padding:"5px 12px",display:"flex",alignItems:"center",gap:6,zIndex:1000}}><span style={{width:7,height:7,borderRadius:"50%",background:"#4caf50",display:"inline-block",animation:"pulse 1.5s infinite"}}/><span style={{fontSize:11,fontWeight:700,color:"#4caf50"}}>CANLI TAKİP</span></div>
        <div style={{position:"absolute",bottom:10,right:10,background:"rgba(255,255,255,.92)",borderRadius:9,padding:"8px 12px",fontSize:11,zIndex:1000}}>
          {[["#f9a825","Atandı"],["#fb8c00","Onaylandı"],["#1e88e5","Teslim Alındı"],["#4caf50","Teslim Edildi"]].map(([c,l])=>(
            <div key={l} style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
              <span style={{width:9,height:9,borderRadius:"50%",background:c,display:"inline-block"}}/>
              <span style={{color:"#636366"}}>{l}</span>
            </div>
          ))}
        </div>
      </div>

      <button onClick={callCourier} disabled={!canCall||calling} style={{margin:"10px 12px 0",padding:"13px",background:canCall?"#e53935":"#e5e5ea",color:canCall?"#fff":"#8e8e93",border:"none",borderRadius:12,fontSize:13,fontWeight:700,cursor:"pointer",flexShrink:0}}>
        {calling?"Aranıyor...":canCall?"🛵 Kurye Çağır (₺"+FEE+" düşülür)":"🚫 Yetersiz Bakiye"}
      </button>

      <div style={{flex:1,overflowY:"auto",padding:"10px 12px 12px",display:"flex",flexDirection:"column",gap:8}}>
        {activePkgs.length>0&&<>
          <p style={{fontSize:11,color:"#1e88e5",fontWeight:700,textTransform:"uppercase"}}>🛵 Yolda ({activePkgs.length})</p>
          {activePkgs.map(p=>{
            const isSel=selPin===p.id;
            const col = STATUS_COLORS[p.status]||"#8e8e93";
            return(
              <div key={p.id} onClick={()=>setSelPin(isSel?null:p.id)} style={{background:"#fff",borderRadius:12,padding:"8px 12px",boxShadow:"0 1px 3px rgba(0,0,0,.06)",border:"1.5px solid "+(isSel?col:"transparent"),cursor:"pointer"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                  <div><span style={{fontSize:11,fontFamily:"monospace",color:"#e53935",fontWeight:700}}>#{p.id}</span><p style={{fontSize:11,color:"#636366",marginTop:3}}>📍 {p.address||"—"}</p></div>
                  <div style={{textAlign:"right"}}><p style={{fontSize:11,color:"#8e8e93"}}>{p.time}</p><p style={{fontWeight:700,fontSize:11,color:"#4caf50",marginTop:2}}>₺{p.fee}</p></div>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:8,borderTop:"1px solid #f2f2f7"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{width:7,height:7,borderRadius:"50%",background:col,display:"inline-block",animation:"pulse 1.5s infinite"}}/><span style={{fontSize:11,fontWeight:600,color:"#1c1c1e"}}>{p.courier||"—"}</span></div>
                  <div style={{background:col+"22",borderRadius:7,padding:"4px 10px"}}><span style={{fontSize:11,fontWeight:700,color:col}}>{p.status}</span></div>
                </div>
              </div>
            );
          })}
        </>}
        {donePkgs.length>0&&<>
          <p style={{fontSize:11,color:"#4caf50",fontWeight:700,textTransform:"uppercase",marginTop:4}}>✅ Teslim ({donePkgs.length})</p>
          {donePkgs.map(p=>(
            <div key={p.id} style={{background:"#fff",borderRadius:10,padding:"7px 11px",boxShadow:"0 1px 3px rgba(0,0,0,.04)",opacity:.8}}>
              <div style={{display:"flex",justifyContent:"space-between"}}><div><span style={{fontSize:11,fontFamily:"monospace",color:"#4caf50",fontWeight:700}}>#{p.id}</span><p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>🛵 {p.courier} · {p.time}</p></div><span style={{fontWeight:700,fontSize:11,color:"#4caf50"}}>₺{p.fee}</span></div>
            </div>
          ))}
        </>}
        {myPkgs.length===0&&<div style={{textAlign:"center",padding:"32px 20px",color:"#8e8e93"}}><p style={{fontSize:24,marginBottom:10}}>📦</p><p>Henüz paket yok</p></div>}
      </div>
    </div>
  );
}

function RestBalanceScreen({restData,db,save,user,toast}){
  const [amount,setAmount]=useState("");const [note,setNote]=useState("");const [sent,setSent]=useState(false);
  const myReqs=(db.balanceRequests||[]).filter(r=>r.restId===user.id).reverse();
  const send=()=>{const amt=parseFloat(amount);if(isNaN(amt)||amt<=0)return;const req={id:genId(),restId:user.id,restName:restData.name||user.name,amount:amt,note,time:nowTime(),date:todayStr(),status:"bekliyor"};save({...db,balanceRequests:[...(db.balanceRequests||[]),req]});toast("Talep gönderildi!","success");setAmount("");setNote("");setSent(true);setTimeout(()=>setSent(false),4000);};
  return(
    <div style={{flex:1,overflowY:"auto",background:"#f2f2f7"}}>
      <div style={{background:"#fff",padding:"9px 12px",borderBottom:"1px solid #e5e5ea",position:"sticky",top:0}}><p style={{fontWeight:700,fontSize:11}}>Bakiye</p></div>
      <div style={{padding:12,display:"flex",flexDirection:"column",gap:12}}>
        <div style={{background:"#fff",borderRadius:10,padding:"11px 13px",textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
          <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:8}}>Mevcut Bakiye</p>
          <p style={{fontSize:42,fontWeight:900,color:restData.balance>100?"#4caf50":restData.balance>0?"#f9a825":"#e53935",lineHeight:1}}>₺{restData.balance}</p>
          {restData.balance<100&&<p style={{color:restData.balance===0?"#e53935":"#f9a825",fontSize:11,marginTop:12,fontWeight:600}}>{restData.balance===0?"Bakiye tükendi.":"Bakiye düşük!"}</p>}
        </div>
        <div style={{background:"#fff",borderRadius:12,padding:16,boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
          <p style={{fontWeight:700,fontSize:11,marginBottom:14}}>Bakiye Talebi</p>
          {sent&&<div style={{background:"#e9f9ee",borderRadius:9,padding:"7px 11px",marginBottom:12,fontSize:11,color:"#4caf50",fontWeight:600}}>✅ Talep gönderildi!</div>}
          <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
            {[100,250,500,1000].map(p=><button key={p} onClick={()=>setAmount(String(p))} style={{padding:"8px 16px",borderRadius:9,border:"1.5px solid "+(amount===String(p)?"#e53935":"#e5e5ea"),background:amount===String(p)?"#e53935":"#fff",color:amount===String(p)?"#fff":"#636366",fontSize:11,fontWeight:700,cursor:"pointer"}}>₺{p}</button>)}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <input type="number" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="Özel tutar" style={{padding:"8px 11px",border:"1.5px solid #e5e5ea",borderRadius:10,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
            <input value={note} onChange={e=>setNote(e.target.value)} placeholder="Not (opsiyonel)" style={{padding:"8px 11px",border:"1.5px solid #e5e5ea",borderRadius:10,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/>
            <button onClick={send} disabled={!amount||parseFloat(amount||0)<=0} style={{padding:"13px",background:amount&&parseFloat(amount||0)>0?"#e53935":"#e5e5ea",color:amount&&parseFloat(amount||0)>0?"#fff":"#8e8e93",border:"none",borderRadius:12,fontSize:11,fontWeight:700,cursor:"pointer"}}>💳 Talep Gönder</button>
          </div>
        </div>
        {myReqs.length>0&&<div style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.06)"}}>
          <div style={{padding:"8px 11px",borderBottom:"1px solid #f2f2f7"}}><p style={{fontWeight:700,fontSize:11}}>Talep Geçmişi</p></div>
          {myReqs.slice(0,5).map(r=>(
            <div key={r.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 11px",borderBottom:"1px solid #f2f2f7"}}>
              <div><p style={{fontWeight:600,fontSize:11}}>₺{r.amount}</p><p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>{r.date} {r.time}{r.note?" · "+r.note:""}</p></div>
              <span style={{fontSize:11,fontWeight:700,padding:"3px 8px",borderRadius:6,background:r.status==="onaylandı"?"#e9f9ee":r.status==="reddedildi"?"#fdecea":"#fff8e1",color:r.status==="onaylandı"?"#4caf50":r.status==="reddedildi"?"#e53935":"#f9a825"}}>{r.status==="onaylandı"?"Onaylandı":r.status==="reddedildi"?"Reddedildi":"Bekliyor"}</span>
            </div>
          ))}
        </div>}
      </div>
    </div>
  );
}

function RestProfileScreen({user,setUser,restData,myPkgs,db,save,toast,callCourier,calling,FEE}){
  const [section,setSection]=useState("cari");
  const totalFee=myPkgs.reduce((s,p)=>s+(p.fee||0),0);
  const delivered=myPkgs.filter(p=>p.status==="Teslim Edildi").length;
  const payGroups=PAY_TYPES_FLAT.map(pt=>({type:pt,count:myPkgs.filter(p=>p.paymentType===pt).length,total:myPkgs.filter(p=>p.paymentType===pt).reduce((s,p)=>s+(p.fee||0),0),color:PAY_COLORS[pt]})).filter(g=>g.count>0);
  const [period,setPeriod]=useState("daily");const [dFrom,setDFrom]=useState("");const [dTo,setDTo]=useState("");
  return(
    <div style={{flex:1,overflowY:"auto",background:"#f2f2f7"}}>
      <div style={{background:"#fff",padding:"9px 13px 0",borderBottom:"1px solid #e5e5ea",position:"sticky",top:0,zIndex:10}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
          <div style={{width:40,height:40,borderRadius:12,background:"#fdecea",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11}}>🏪</div>
          <div><p style={{fontWeight:700,fontSize:11}}>{restData?.name||user.name}</p><p style={{fontSize:11,color:"#8e8e93"}}>İşletme Hesabı</p></div>
        </div>
        <div style={{display:"flex",gap:0,overflowX:"auto"}}>
          {[{id:"cari",l:"Cari Hesap",icon:"📋"},{id:"report",l:"Raporlar",icon:"📊"},{id:"balance",l:"Bakiye",icon:"💳"},{id:"integrations",l:"Entegre",icon:"🔗"}].map(s=>(
            <button key={s.id} onClick={()=>setSection(s.id)} style={{flexShrink:0,padding:"9px 12px",border:"none",background:"transparent",fontSize:11,fontWeight:600,cursor:"pointer",color:section===s.id?"#e53935":"#8e8e93",borderBottom:section===s.id?"2.5px solid #e53935":"2.5px solid transparent"}}>
              {s.icon} {s.l}
            </button>
          ))}
        </div>
      </div>
      {section==="cari"&&(
        <div style={{padding:12,display:"flex",flexDirection:"column",gap:10}}>
          <div style={{background:"#fff",borderRadius:12,padding:16,boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
              <div><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:4}}>Bakiye</p><p style={{fontSize:11,fontWeight:900,color:restData?.balance>100?"#4caf50":restData?.balance>0?"#f9a825":"#e53935",lineHeight:1}}>₺{restData?.balance||0}</p></div>
              <div style={{textAlign:"right"}}><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:4}}>Günlük Harcama</p><p style={{fontSize:23,fontWeight:800,color:"#e53935",lineHeight:1}}>₺{totalFee}</p></div>
            </div>
            <div style={{height:1,background:"#f2f2f7",marginBottom:12}}/>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
              {[["Toplam",myPkgs.length,"#1e88e5"],["Teslim",delivered,"#4caf50"],["Devam",myPkgs.length-delivered,"#f9a825"]].map(([l,v,c])=>(
                <div key={l} style={{background:"#f9f9f9",borderRadius:9,padding:"9px 6px",textAlign:"center"}}><p style={{fontSize:11,fontWeight:800,color:c,lineHeight:1}}>{v}</p><p style={{fontSize:11,color:"#8e8e93",marginTop:3,fontWeight:600}}>{l}</p></div>
              ))}
            </div>
          </div>
          {payGroups.length>0&&<div style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
            <div style={{padding:"7px 11px",borderBottom:"1px solid #f2f2f7"}}><p style={{fontWeight:700,fontSize:11}}>Tahsilat Dağılımı</p></div>
            <div style={{display:"flex",height:7,margin:"10px 14px 0"}}>
              {payGroups.map(g=><div key={g.type} style={{flex:g.count,background:g.color,borderRadius:4,marginRight:2}}/>)}
            </div>
            {payGroups.map(g=>(
              <div key={g.type} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 11px",borderBottom:"1px solid #f2f2f7"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:9,height:9,borderRadius:"50%",background:g.color,display:"inline-block"}}/><span style={{fontSize:11,fontWeight:600}}>{g.type}</span></div>
                <div style={{display:"flex",gap:14,alignItems:"center"}}><span style={{fontSize:11,color:"#8e8e93"}}>{g.count} paket</span><span style={{fontWeight:700,fontSize:11,color:g.color}}>₺{g.total}</span></div>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"space-between",padding:"7px 11px"}}><span style={{fontWeight:700,fontSize:11}}>TOPLAM</span><span style={{fontWeight:800,fontSize:11,color:"#e53935"}}>₺{totalFee}</span></div>
          </div>}
          <button onClick={()=>setUser(null)} style={{width:"100%",padding:"13px",background:"#fff",color:"#e53935",border:"none",borderRadius:12,fontSize:11,fontWeight:700,boxShadow:"0 1px 3px rgba(0,0,0,.06)",cursor:"pointer"}}>↩ Çıkış Yap</button>
        </div>
      )}
      {section==="report"&&(
        <div style={{padding:12,display:"flex",flexDirection:"column",gap:10}}>
          <div style={{background:"#fff",borderRadius:12,padding:10,boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4}}>
              {[["daily","Günlük"],["weekly","Haftalık"],["monthly","Aylık"],["range","Tarih"]].map(([id,l])=>(
                <button key={id} onClick={()=>setPeriod(id)} style={{padding:"8px 4px",borderRadius:8,border:"none",fontSize:11,fontWeight:700,cursor:"pointer",background:period===id?"#e53935":"#f2f2f7",color:period===id?"#fff":"#636366"}}>{l}</button>
              ))}
            </div>
            {period==="range"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:10}}>
              <div><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:4}}>Başlangıç</p><input type="date" value={dFrom} onChange={e=>setDFrom(e.target.value)} style={{width:"100%",padding:"6px 8px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/></div>
              <div><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:4}}>Bitiş</p><input type="date" value={dTo} onChange={e=>setDTo(e.target.value)} style={{width:"100%",padding:"6px 8px",border:"1.5px solid #e5e5ea",borderRadius:9,fontSize:11,outline:"none",background:"#f9f9f9",color:"#1c1c1e"}}/></div>
            </div>}
            <p style={{fontSize:11,color:"#8e8e93",marginTop:8,textAlign:"center"}}>{period==="daily"?todayStr():period==="weekly"?"Son 7 gün":period==="monthly"?new Date().toLocaleDateString("tr-TR",{month:"long",year:"numeric"}):dFrom&&dTo?dFrom+" – "+dTo:"Tarih seçin"}</p>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8}}>
            {[["Toplam Paket",myPkgs.length,"#1e88e5"],["Teslim Edildi",delivered,"#4caf50"],["Devam Eden",myPkgs.length-delivered,"#f9a825"],["Harcama","₺"+totalFee,"#e53935"]].map(([l,v,c])=>(
              <div key={l} style={{background:"#fff",borderRadius:10,padding:"8px 12px",boxShadow:"0 1px 3px rgba(0,0,0,.05)",borderLeft:"3px solid "+c}}><p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:4}}>{l}</p><p style={{fontSize:11,fontWeight:800,color:c,lineHeight:1}}>{v}</p></div>
            ))}
          </div>
          {payGroups.length>0&&<div style={{background:"#fff",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
            <div style={{padding:"7px 11px",borderBottom:"1px solid #f2f2f7"}}><p style={{fontWeight:700,fontSize:11}}>💳 Ödeme Türleri</p></div>
            <div style={{display:"flex",height:7,margin:"10px 14px 2px"}}>
              {payGroups.map(g=><div key={g.type} style={{flex:g.count,background:g.color,borderRadius:4,marginRight:2}}/>)}
            </div>
            {payGroups.map(g=>(
              <div key={g.type} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 11px",borderBottom:"1px solid #f2f2f7"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{width:9,height:9,borderRadius:"50%",background:g.color,display:"inline-block"}}/><span style={{fontSize:11,fontWeight:600}}>{g.type}</span></div>
                <div style={{display:"flex",gap:14}}><span style={{fontSize:11,color:"#8e8e93"}}>{g.count} paket</span><span style={{fontWeight:700,fontSize:11,color:g.color}}>₺{g.total}</span></div>
              </div>
            ))}
            <div style={{display:"flex",justifyContent:"space-between",padding:"7px 11px",background:"#fafafa"}}><span style={{fontWeight:800,fontSize:11}}>TOPLAM</span><span style={{fontWeight:800,fontSize:11,color:"#e53935"}}>₺{totalFee}</span></div>
          </div>}
        </div>
      )}
      {section==="balance"&&(
        <RestBalanceScreen restData={restData} db={db} save={save} user={user} toast={toast} embedded/>
      )}
      {section==="integrations"&&(
        <RestIntegrations db={db} save={save} user={user} restData={restData} callCourier={callCourier} calling={calling} FEE={FEE} toast={toast} embedded/>
      )}
    </div>
  );
}

// ═══ KURYE ════════════════════════════════════════════════════════
function CourierMapScreen({db,user,myPkgs,onOpenBiz,onOpenTask,updPkg}){
  const [selPin,setSelPin] = useState(null);
  const activeTasks = myPkgs.filter(p=>p.status==="Atandı"||p.status==="Onaylandı"||p.status==="Teslimat Aşamasında");
  const pendingTasks = activeTasks;
  const cData = db.couriers.find(c=>c.id===user.id);

  // Gerçek koordinatı olan işletmeler ve teslimat noktaları (koordinatı olmayanlar haritada gösterilemez)
  const restsWithTasks = db.restaurants.filter(r=>activeTasks.some(p=>p.restId===r.id) && r.lat && r.lng);
  const tasksWithCoords = activeTasks.filter(p=>p.lat && p.lng);

  // Haritanın merkezi: kurye konumu varsa o, yoksa ilk işletme, yoksa Antalya
  const mapCenter = cData?.lat && cData?.lng
    ? [cData.lat, cData.lng]
    : restsWithTasks[0] ? [restsWithTasks[0].lat, restsWithTasks[0].lng]
    : [36.8969, 30.7133]; // Antalya merkez, hiç konum yoksa varsayılan

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:"#f2f2f7",position:"relative"}}>
      {/* Bildirim kutucukları — sağ üst köşe */}
      <div style={{position:"absolute",top:14,right:14,zIndex:60,display:"flex",flexDirection:"column",gap:8,alignItems:"flex-end"}}>
        {(()=>{
          const newTasks = pendingTasks.filter(p=>p.status==="Atandı");
          if(newTasks.length===0) return null;
          return(
            <button onClick={()=>onOpenTask(newTasks[0].id)} style={{
              background:"#8e24aa",color:"#fff",border:"none",borderRadius:12,
              padding:"8px 14px",display:"flex",alignItems:"center",gap:6,
              boxShadow:"0 4px 14px rgba(142,36,170,.4)",cursor:"pointer",
              animation:"pulse 2s infinite",
            }}>
              <span style={{fontSize:15}}>📦</span>
              <span style={{fontSize:12,fontWeight:800}}>{newTasks.length} Yeni</span>
            </button>
          );
        })()}
        {(()=>{
          const inProgress = pendingTasks.filter(p=>p.status==="Onaylandı"||p.status==="Teslimat Aşamasında");
          if(inProgress.length===0) return null;
          // Bu kutucuk en geride kalan (en az ilerlemiş) işlem durumuna göre renklenir
          const order = {"Onaylandı":0,"Teslimat Aşamasında":1};
          const leastAdvanced = [...inProgress].sort((a,b)=>(order[a.status]??0)-(order[b.status]??0))[0];
          const badgeColor = STATUS_COLORS[leastAdvanced.status]||"#fb8c00";
          return(
            <button onClick={()=>onOpenTask(leastAdvanced.id)} style={{
              background:badgeColor,color:"#fff",border:"none",borderRadius:12,
              padding:"8px 14px",display:"flex",alignItems:"center",gap:6,
              boxShadow:"0 4px 14px "+badgeColor+"66",cursor:"pointer",
            }}>
              <span style={{fontSize:15}}>🛵</span>
              <span style={{fontSize:12,fontWeight:800}}>{inProgress.length} Devam</span>
            </button>
          );
        })()}
      </div>

      {/* Harita alanı */}
      <div style={{position:"relative",flex:1,background:"#e8f0e8",overflow:"hidden"}}>
        <MapContainer center={mapCenter} zoom={13} style={{height:"100%",width:"100%"}} scrollWheelZoom={true}>
          <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>

          {/* Kuryenin kendi konumu */}
          {cData?.lat && cData?.lng && (
            <Marker position={[cData.lat,cData.lng]} icon={coloredIcon("#1e88e5")}>
              <Popup>🛵 Siz buradasınız</Popup>
            </Marker>
          )}

          {/* İşletme — toplama noktaları (paketi olanlar) */}
          {restsWithTasks.map(r=>{
            const restTasks = activeTasks.filter(p=>p.restId===r.id);
            const dominant = restTasks.some(p=>p.status==="Teslimat Aşamasında") ? "Teslimat Aşamasında"
                            : restTasks.some(p=>p.status==="Onaylandı") ? "Onaylandı"
                            : "Atandı";
            const pinColor = STATUS_COLORS[dominant]||"#e53935";
            return(
              <Marker key={r.id} position={[r.lat,r.lng]} icon={coloredIcon(pinColor)} eventHandlers={{click:()=>setSelPin({type:"rest",id:r.id})}}>
                <Popup>
                  <strong>🏪 {r.name}</strong><br/>
                  {restTasks.length} paket bekliyor
                </Popup>
              </Marker>
            );
          })}

          {/* Teslimat noktaları — müşteri adresleri */}
          {tasksWithCoords.map(pkg=>{
            const pinColor = STATUS_COLORS[pkg.status]||"#8e24aa";
            return(
              <Marker key={pkg.id} position={[pkg.lat,pkg.lng]} icon={coloredIcon(pinColor)} eventHandlers={{click:()=>setSelPin({type:"task",id:pkg.id})}}>
                <Popup>
                  <strong>#{pkg.id}</strong><br/>
                  {pkg.address}<br/>
                  <span style={{color:pinColor}}>{pkg.status}</span>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>

        {pendingTasks.length===0&&(
          <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",background:"rgba(255,255,255,.95)",borderRadius:12,padding:"16px 22px",boxShadow:"0 2px 10px rgba(0,0,0,.1)",zIndex:1000,textAlign:"center"}}>
            <p style={{fontSize:13,color:"#8e8e93",fontWeight:600}}>Şu an aktif göreviniz yok</p>
            <p style={{fontSize:11,color:"#aeaeb2",marginTop:3}}>Yeni paket atandığında burada görünecek</p>
          </div>
        )}

        <div style={{position:"absolute",top:12,left:12,background:"rgba(255,255,255,.92)",borderRadius:8,padding:"5px 12px",display:"flex",alignItems:"center",gap:6,zIndex:1000}}>
          <span style={{width:7,height:7,borderRadius:"50%",background:"#4caf50",display:"inline-block",animation:"pulse 1.5s infinite"}}/>
          <span style={{fontSize:11,fontWeight:700,color:"#4caf50"}}>CANLI</span>
        </div>
        <div style={{position:"absolute",bottom:10,right:10,background:"rgba(255,255,255,.92)",borderRadius:9,padding:"8px 12px",fontSize:11,zIndex:1000}}>
          {[["#f9a825","Atandı"],["#fb8c00","Onaylandı"],["#1e88e5","Teslim Alındı"]].map(([c,l])=>(
            <div key={l} style={{display:"flex",alignItems:"center",gap:5,marginBottom:2}}>
              <span style={{width:9,height:9,borderRadius:"50%",background:c,display:"inline-block"}}/>
              <span style={{color:"#636366"}}>{l}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Seçili pin için alt eylem paneli */}
      {selPin&&selPin.type==="rest"&&(()=>{
        const rest = db.restaurants.find(r=>r.id===selPin.id);
        if(!rest) return null;
        return(
          <div style={{background:"#fff",borderTop:"1px solid #e5e5ea",padding:"12px 14px",flexShrink:0}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div>
                <p style={{fontWeight:700,fontSize:13}}>🏪 {rest.name}</p>
                <p style={{fontSize:11,color:"#8e8e93",marginTop:2}}>{rest.address||"Adres tanımlı değil"}</p>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              {rest.address&&(
                <a href={"https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(rest.address)} target="_blank" rel="noopener noreferrer"
                  style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"10px",background:"#1e88e5",color:"#fff",borderRadius:9,fontSize:12,fontWeight:700,textDecoration:"none"}}>
                  🧭 Yol Tarifi Al
                </a>
              )}
              <button onClick={()=>onOpenBiz(rest)} style={{flex:1,padding:"10px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:9,fontSize:12,fontWeight:700,cursor:"pointer"}}>
                🗺️ Haritada Gör
              </button>
            </div>
          </div>
        );
      })()}
      {selPin&&selPin.type==="task"&&(()=>{
        const pkg = activeTasks.find(p=>p.id===selPin.id);
        if(!pkg) return null;
        const rest = db.restaurants.find(r=>r.id===pkg.restId);
        return(
          <div style={{background:"#fff",borderTop:"1px solid #e5e5ea",padding:"12px 14px",flexShrink:0}}>
            <div style={{marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3}}>
                <span style={{fontSize:10,fontFamily:"monospace",color:"#e53935",fontWeight:800}}>#{pkg.id}</span>
                <span style={{fontSize:11,fontWeight:700,color:PAY_COLORS[pkg.paymentType]||"#8e8e93"}}>{pkg.paymentType||"Belirtilmedi"}</span>
              </div>
              <p style={{fontWeight:700,fontSize:13}}>📍 {pkg.address||"—"}</p>
              <p style={{fontSize:11,color:"#8e8e93",marginTop:2}}>🏪 {pkg.restaurant}</p>
            </div>
            <div style={{display:"flex",gap:8}}>
              <a href={"https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(pkg.address||"")} target="_blank" rel="noopener noreferrer"
                style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,padding:"10px",background:STATUS_COLORS[pkg.status]||"#8e24aa",color:"#fff",borderRadius:9,fontSize:12,fontWeight:700,textDecoration:"none"}}>
                🧭 Yol Tarifi
              </a>
              <button onClick={()=>onOpenTask(pkg.id)} style={{flex:1,padding:"10px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:9,fontSize:12,fontWeight:700,cursor:"pointer"}}>
                📦 Detay
              </button>
            </div>
            <div style={{marginTop:8}}>
              {pkg.status==="Atandı"&&(
                <button onClick={()=>updPkg(pkg.id,"status","Onaylandı")} style={{width:"100%",padding:"11px",background:"#fb8c00",color:"#fff",border:"none",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer"}}>
                  👍 Onayla
                </button>
              )}
              {pkg.status==="Onaylandı"&&(
                <button onClick={()=>updPkg(pkg.id,"status","Teslimat Aşamasında")} style={{width:"100%",padding:"11px",background:"#1e88e5",color:"#fff",border:"none",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer"}}>
                  📦 Teslim Aldım
                </button>
              )}
              {pkg.status==="Teslimat Aşamasında"&&(
                <button onClick={()=>{updPkg(pkg.id,"status","Teslim Edildi");setSelPin(null);}} style={{width:"100%",padding:"11px",background:"#4caf50",color:"#fff",border:"none",borderRadius:9,fontSize:13,fontWeight:700,cursor:"pointer"}}>
                  ✅ Teslim Ettim!
                </button>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function CourierApp({user,db,save,setUser,toast}){
  const [tab,setTab]=useState("map");
  const [filter,setFilter]=useState("Hepsi");
  const [bolge,setBolge]=useState("Hepsi");
  const [openTaskId,setOpenTaskId]=useState(null);
  const [showBizMap,setShowBizMap]=useState(null);
  const cData=db.couriers.find(c=>c.id===user.id)||{status:"off",km:0,earnings:0,bonus:0,packages:0};
  const myPkgs=db.packages.filter(p=>p.courierId===user.id);
  const pending=myPkgs.filter(p=>p.status!=="Teslim Edildi"&&p.status!=="İptal");
  const setStatus=s=>{save({...db,couriers:db.couriers.map(c=>c.id===user.id?{...c,status:s}:c)});toast({active:"Aktif",break:"Mola",off:"Çevrimdışı"}[s]||s,"info");};

  // Kurye "Aktif" durumdayken tarayıcının GPS'inden gerçek konumunu al ve düzenli güncelle
  const dbRef = useRef(db);
  useEffect(()=>{ dbRef.current = db; },[db]);
  useEffect(()=>{
    if(cData.status!=="active" || !navigator.geolocation) return;
    const updateLocation = () => {
      navigator.geolocation.getCurrentPosition(
        pos => {
          const {latitude,longitude} = pos.coords;
          const latest = dbRef.current;
          save({...latest, couriers: latest.couriers.map(c=>c.id===user.id?{...c,lat:latitude,lng:longitude}:c)});
        },
        err => console.warn("Konum alınamadı:", err.message),
        {enableHighAccuracy:true, timeout:8000}
      );
    };
    updateLocation(); // hemen bir kez al
    const interval = setInterval(updateLocation, 30000); // sonra 30 saniyede bir güncelle
    return ()=>clearInterval(interval);
  },[cData.status, user.id]);

  // Yeni atanan paketleri tespit et — hangi sekmede olursa olsun bildirim göster
  const knownAssignedIds = useRef(null);
  const assignedNow = myPkgs.filter(p=>p.status==="Atandı"||p.status==="Teslimat Aşamasında");
  useEffect(()=>{
    const currentIds = new Set(assignedNow.map(p=>p.id));
    if(knownAssignedIds.current!==null){
      assignedNow.forEach(p=>{
        if(!knownAssignedIds.current.has(p.id)){
          toast("📦 Yeni paket: "+p.restaurant+" → "+(p.address||"adres yok"),"info");
        }
      });
    }
    knownAssignedIds.current = currentIds;
  },[assignedNow.map(p=>p.id).join(",")]);

  // Barem kontrolü: ilgili periyot için tetiklenmemiş en yüksek bareme ulaşıldıysa bonus uygula
  const checkAndApplyBonus = (db_,courierId) => {
    const s = db_.settings||{};
    const now = new Date();
    const dayKey = now.toISOString().slice(0,10);
    const startOfDay = new Date(now.getFullYear(),now.getMonth(),now.getDate());
    const startOfWeek = new Date(startOfDay); startOfWeek.setDate(startOfDay.getDate()-((startOfDay.getDay()+6)%7));
    const weekKey = startOfWeek.toISOString().slice(0,10);

    const given = db_.bonusGiven||{};
    let updDb = db_;

    const applyPeriod = (period,tiers,periodKey) => {
      if(!tiers||!tiers.length) return;
      const count = db_.packages.filter(p=>{
        if(p.courierId!==courierId||p.status!=="Teslim Edildi"||!p.deliveredAt) return false;
        const d = new Date(p.deliveredAt);
        return period==="daily" ? d>=startOfDay : d>=startOfWeek;
      }).length;
      const eligible = [...tiers].filter(t=>count>=t.pkgMin).sort((a,b)=>b.pkgMin-a.pkgMin)[0];
      if(!eligible) return;
      const givenKey = courierId+"_"+period+"_"+periodKey;
      if(given[givenKey]===eligible.pkgMin) return; // bu barem zaten verildi
      // Yeni veya daha yüksek barem — fark olarak verilen tutarı uygula
      const prevTier = given[givenKey] ? tiers.find(t=>t.pkgMin===given[givenKey]) : null;
      const diff = eligible.bonus - (prevTier?.bonus||0);
      if(diff<=0) return;
      updDb = {
        ...updDb,
        couriers: updDb.couriers.map(c=>c.id===courierId?{...c,bonus:(c.bonus||0)+diff}:c),
        bonusGiven: {...(updDb.bonusGiven||{}),[givenKey]:eligible.pkgMin},
      };
      toast("🎯 "+(period==="daily"?"Günlük":"Haftalık")+" bonus: +₺"+diff+" ("+eligible.pkgMin+" paket)","success");
    };

    applyPeriod("daily", s.dailyBonusTiers, dayKey);
    applyPeriod("weekly", s.weeklyBonusTiers, weekKey);
    return updDb;
  };

  const updPkg=(id,type,value)=>{
    if(type==="status"){
      let updC=db.couriers;
      let updDb = db;
      if(value==="Teslim Edildi"){
        const earn=db.settings?.courierEarn||25;
        updC=db.couriers.map(c=>c.id===user.id?{...c,earnings:c.earnings+earn,packages:c.packages+1}:c);
        updDb = {...db,packages:db.packages.map(p=>p.id===id?{...p,status:value,deliveredAt:new Date().toISOString()}:p),couriers:updC};
        updDb = checkAndApplyBonus(updDb,user.id);
        save(updDb);
        toast("+₺"+earn+" kazandınız!","success");
        return;
      }
      save({...db,packages:db.packages.map(p=>p.id===id?{...p,status:value}:p),couriers:updC});
    }
  };
  const tabs=[{id:"map",label:"Harita",icon:"🗺️"},{id:"tasks",label:"Paket",icon:"📦"},{id:"profile",label:"Profil",icon:"👤"}];
  const scMap={active:{border:"#4caf50",bg:"#e9f9ee",text:"#4caf50",lbl:"AKTİF"},break:{border:"#f9a825",bg:"#fff8e1",text:"#f9a825",lbl:"MOLADA"},off:{border:"#e5e5ea",bg:"#f2f2f7",text:"#8e8e93",lbl:"KAPALI"}};
  const sc=scMap[cData.status]||scMap.off;
  return(
    <div style={{display:"flex",flexDirection:"column",flex:1,minHeight:"100vh"}}>
      {showBizMap&&<BizLocationModal rest={showBizMap} onClose={()=>setShowBizMap(null)}/>}
      <div style={{background:sc.bg,borderBottom:"2px solid "+sc.border,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:50,flexShrink:0}}>
        <div><p style={{fontWeight:800,fontSize:11,color:sc.text}}>{sc.lbl}</p><p style={{fontSize:11,color:"#8e8e93",marginTop:1}}>{cData.km}km · ₺{cData.earnings}</p></div>
        <div style={{display:"flex",gap:6}}>
          {[["✅","active"],["☕","break"],["⛔","off"]].map(([ic,val])=>(
            <button key={val} onClick={()=>setStatus(val)} style={{padding:"7px 12px",borderRadius:9,border:"1.5px solid "+(cData.status===val?sc.border:"#e5e5ea"),background:cData.status===val?sc.bg:"#fff",color:cData.status===val?sc.text:"#636366",fontSize:11,fontWeight:700,cursor:"pointer"}}>{ic}</button>
          ))}
        </div>
      </div>
      {tab==="map"&&(
        <CourierMapScreen
          db={db}
          user={user}
          myPkgs={myPkgs}
          onOpenBiz={rest=>setShowBizMap(rest)}
          onOpenTask={pkgId=>{setTab("tasks");setOpenTaskId(pkgId);}}
          updPkg={updPkg}
        />
      )}
      {tab==="tasks"&&(
        <div style={{flex:1,overflowY:"auto",background:"#f2f2f7"}}>
          <div style={{padding:"10px 12px",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
            {[["📦",myPkgs.length,"Paket","#e53935"],["⏳",pending.length,"Devam","#f9a825"],["✅",myPkgs.filter(p=>p.status==="Teslim Edildi").length,"Teslim","#4caf50"],["🛣️",cData.km+"km","KM","#1c1c1e"]].map(([ic,v,l,c])=>(
              <div key={l} style={{background:"#fff",borderRadius:10,padding:"10px 6px",textAlign:"center",boxShadow:"0 1px 2px rgba(0,0,0,.04)"}}><p style={{fontSize:11,fontWeight:800,color:c,lineHeight:1}}>{v}</p><p style={{fontSize:11,color:"#8e8e93",marginTop:3,fontWeight:600}}>{l}</p></div>
            ))}
          </div>
          {pending.length===0
            ?<div style={{padding:"48px 20px",textAlign:"center"}}><p style={{fontSize:30,marginBottom:12}}>☕</p><p style={{color:"#8e8e93",fontSize:11}}>Bekleyen görev yok</p></div>
            :<div style={{background:"#fff"}}>
              {pending.map(p=>{
                const rest = db.restaurants.find(r=>r.id===p.restId);
                const isOpen = openTaskId===p.id;
                return(
                <div key={p.id} style={{borderBottom:"1px solid #e5e5ea"}}>
                  <button onClick={()=>setOpenTaskId(isOpen?null:p.id)} style={{display:"flex",alignItems:"stretch",padding:0,width:"100%",border:"none",background:"transparent",cursor:"pointer",textAlign:"left"}}>
                    <div style={{width:4,background:STATUS_COLORS[p.status]||"#8e8e93",flexShrink:0,borderRadius:"2px 0 0 2px"}}/>
                    <div style={{flex:1,padding:"10px 12px"}}>
                      <p style={{fontWeight:700,fontSize:11,color:"#1c1c1e",marginBottom:3}}>🏪 {p.restaurant}</p>
                      <p style={{fontSize:11,color:"#8e8e93"}}>📍 {p.address}</p>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",justifyContent:"center",padding:"10px 8px 10px 0",gap:1,flexShrink:0}}>
                      <span style={{fontSize:11,color:"#e53935",fontWeight:700}}>#{p.id}</span>
                      <span style={{fontSize:11,color:"#8e8e93"}}>{p.time}</span>
                      <span style={{color:"#1e88e5",fontSize:13,marginTop:2}}>{isOpen?"⌃":"⌄"}</span>
                    </div>
                  </button>

                  {isOpen&&(
                    <div style={{padding:"0 12px 12px 16px",background:"#fafafa"}}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10,paddingTop:10}}>
                        <div>
                          <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>Müşteri Adresi</p>
                          <p style={{fontSize:12,color:"#1c1c1e",fontWeight:600}}>📍 {p.address||"—"}</p>
                        </div>
                        <div>
                          <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>Ödeme Tipi</p>
                          <p style={{fontSize:12,fontWeight:700,color:PAY_COLORS[p.paymentType]||"#8e8e93"}}>{p.paymentType||"Belirtilmedi"}</p>
                        </div>
                      </div>

                      {/* İşletme konumu */}
                      <div style={{background:"#fff",borderRadius:9,padding:"9px 11px",marginBottom:10,border:"1px solid #e5e5ea",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{flex:1}}>
                          <p style={{fontSize:10,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>İşletme Adresi</p>
                          <p style={{fontSize:12,color:"#1c1c1e",fontWeight:600}}>{rest?.address||"Adres tanımlı değil"}</p>
                        </div>
                        {rest?.address&&(
                          <a href={"https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(rest.address)} target="_blank" rel="noopener noreferrer"
                            style={{display:"flex",alignItems:"center",justifyContent:"center",width:36,height:36,borderRadius:9,background:"#e3f2fd",color:"#1e88e5",fontSize:18,flexShrink:0,marginLeft:8,textDecoration:"none"}}>
                            📍
                          </a>
                        )}
                      </div>

                      <div style={{display:"flex",gap:8}}>
                        {p.status==="Atandı"&&<button onClick={()=>updPkg(p.id,"status","Onaylandı")} style={{flex:1,padding:"10px",background:"#fff",color:"#fb8c00",border:"1.5px solid #fb8c00",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer"}}>👍 Onayla</button>}
                        {p.status==="Onaylandı"&&<button onClick={()=>updPkg(p.id,"status","Teslimat Aşamasında")} style={{flex:1,padding:"10px",background:"#fff",color:"#1e88e5",border:"1.5px solid #1e88e5",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer"}}>📦 Teslim Aldım</button>}
                        {p.status==="Teslimat Aşamasında"&&<button onClick={()=>updPkg(p.id,"status","Teslim Edildi")} style={{flex:1,padding:"10px",background:"#4caf50",color:"#fff",border:"none",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer"}}>✅ Teslim Ettim!</button>}
                        {rest?.address&&(
                          <button onClick={()=>setShowBizMap(rest)} style={{padding:"10px 14px",background:"#f2f2f7",color:"#636366",border:"none",borderRadius:9,fontSize:11,fontWeight:700,cursor:"pointer"}}>🗺️ Haritada Gör</button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );})}
            </div>
          }
        </div>
      )}
      {tab==="profile"&&(
        <CourierProfile
          user={user} cData={cData} myPkgs={myPkgs} settings={db.settings||{}}
          filter={filter} setFilter={setFilter} bolge={bolge} setBolge={setBolge}
          updPkg={updPkg} setUser={setUser}
        />
      )}
      <BottomNav tabs={tabs} active={tab} setActive={setTab}/>
    </div>
  );
}

function CourierProfile({user,cData,myPkgs,settings,filter,setFilter,bolge,setBolge,updPkg,setUser}){
  const [section,setSection] = useState("general");
  const shown = myPkgs.filter(p=>filter==="Hepsi"||p.status===filter);

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",background:"#f2f2f7"}}>
      <div style={{background:"#fff",padding:"9px 13px 0",borderBottom:"1px solid #e5e5ea",position:"sticky",top:0,zIndex:10,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
          <div style={{width:36,height:36,borderRadius:10,background:"#fdecea",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🛵</div>
          <div><p style={{fontWeight:700,fontSize:13,color:"#1c1c1e"}}>{user.name}</p><p style={{fontSize:11,color:"#8e8e93"}}>Kurye</p></div>
        </div>
        <div style={{display:"flex",gap:0}}>
          {[{id:"general",l:"Genel",icon:"👤"},{id:"earnings",l:"Kazanç",icon:"💰"},{id:"history",l:"Geçmiş",icon:"📋"}].map(s=>(
            <button key={s.id} onClick={()=>setSection(s.id)} style={{flex:1,padding:"9px 0",border:"none",background:"transparent",fontSize:11,fontWeight:600,cursor:"pointer",color:section===s.id?"#e53935":"#8e8e93",borderBottom:section===s.id?"2.5px solid #e53935":"2.5px solid transparent"}}>
              {s.icon} {s.l}
            </button>
          ))}
        </div>
      </div>

      {section==="general"&&(
        <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32}}>
          <div style={{fontSize:64,marginBottom:16}}>🛵</div>
          <p style={{fontWeight:700,fontSize:13,marginBottom:4}}>{user.name}</p>
          <p style={{color:"#8e8e93",marginBottom:32}}>Kurye</p>
          <button onClick={()=>setUser(null)} style={{padding:"13px 40px",background:"#e53935",color:"#fff",border:"none",borderRadius:12,fontSize:13,fontWeight:700,cursor:"pointer"}}>↩ Çıkış Yap</button>
        </div>
      )}

      {section==="earnings"&&<CourierEarnings cData={cData} myPkgs={myPkgs} settings={settings}/>}

      {section==="history"&&(
        <>
          <TopBar bolge={bolge} setBolge={setBolge} filter={filter} setFilter={setFilter} onMapClick={()=>{}}/>
          <div style={{flex:1,overflowY:"auto",background:"#fff"}}>
            {shown.length===0?<p style={{textAlign:"center",padding:"48px 20px",color:"#8e8e93"}}>Paket yok</p>
            :shown.map(p=><PkgRow key={p.id} pkg={p} onAction={p.status!=="Teslim Edildi"&&p.status!=="İptal"?updPkg:null}/>)}
          </div>
        </>
      )}
    </div>
  );
}

function CourierEarnings({cData,myPkgs,settings}){
  const delivered=myPkgs.filter(p=>p.status==="Teslim Edildi").length;
  const total=(cData.earnings||0)+(cData.bonus||0);
  const si=settings.kmInterval||1;const sf=settings.kmFee||2.5;
  const kmEarn=si>0?Math.floor((cData.km||0)/si)*sf:0;
  return(
    <div style={{flex:1,overflowY:"auto",background:"#f2f2f7"}}>
      <div style={{background:"#fff",padding:"14px 13px",textAlign:"center",borderBottom:"1px solid #e5e5ea"}}>
        <p style={{fontSize:11,color:"#8e8e93",fontWeight:700,textTransform:"uppercase",marginBottom:8}}>Bugünkü Kazanç</p>
        <p style={{fontSize:42,fontWeight:900,color:"#4caf50",lineHeight:1}}>₺{total}</p>
        <div style={{display:"flex",justifyContent:"center",gap:28,marginTop:16,paddingTop:16,borderTop:"1px solid #f2f2f7"}}>
          {[["PAKET","₺"+(cData.earnings||0),"#1c1c1e"],["KM","₺"+kmEarn.toFixed(0),"#1e88e5"],["BONUS","₺"+(cData.bonus||0),"#f9a825"]].map(([l,v,c])=>(
            <div key={l} style={{textAlign:"center"}}><p style={{fontSize:11,color:"#8e8e93",marginBottom:4,fontWeight:700}}>{l}</p><p style={{fontWeight:800,fontSize:11,color:c}}>{v}</p></div>
          ))}
        </div>
      </div>
      <div style={{padding:12,display:"flex",flexDirection:"column",gap:12}}>
        <div style={{background:"#fff",borderRadius:12,padding:"8px 12px",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
          <p style={{fontSize:11,color:"#636366"}}>🛣️ {cData.km||0}km · Her {si}km → ₺{sf} · <strong style={{color:"#4caf50"}}>₺{kmEarn.toFixed(2)}</strong> KM kazancı</p>
        </div>
        <div style={{background:"#fff",borderRadius:12,padding:"10px 12px",boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
          <p style={{fontWeight:700,fontSize:11,marginBottom:14}}>🎯 Teslimat Bonusları</p>
          {[5,10,15].map(n=>{
            const bonus=n===5?20:n===10?50:100;const reached=delivered>=n;
            return(
              <div key={n} style={{marginBottom:16}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                  <span style={{fontSize:11,color:reached?"#4caf50":"#1c1c1e",fontWeight:600}}>{reached?"✅":"🎯"} {n} Teslimat</span>
                  <span style={{fontWeight:700,color:reached?"#4caf50":"#f9a825"}}>+₺{bonus}</span>
                </div>
                <div style={{height:7,background:"#f2f2f7",borderRadius:4,overflow:"hidden"}}>
                  <div style={{height:"100%",width:Math.min(100,delivered/n*100)+"%",background:reached?"#4caf50":"#e53935",borderRadius:4,transition:"width .4s"}}/>
                </div>
                <p style={{fontSize:11,color:"#8e8e93",marginTop:4}}>{delivered}/{n}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
