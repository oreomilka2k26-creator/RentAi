require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const fetch   = require('node-fetch');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── DB (простой JSON файл) ──────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'db.json');
function readDB()  { const dir=path.join(__dirname,'data'); if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true}); return fs.existsSync(DB_PATH)?JSON.parse(fs.readFileSync(DB_PATH,'utf8')):{properties:[],emails:[]}; }
function writeDB(d){ const dir=path.join(__dirname,'data'); if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(DB_PATH,JSON.stringify(d,null,2)); }

// ── Загрузка фото ───────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req,file,cb) => {
    const dir = path.join(__dirname,'public','uploads');
    fs.mkdirSync(dir,{recursive:true});
    cb(null,dir);
  },
  filename: (req,file,cb) => cb(null, Date.now()+path.extname(file.originalname))
});
const upload = multer({storage, limits:{fileSize:15*1024*1024}});

// ── Google OAuth ────────────────────────────────────────────
const REDIRECT = process.env.NODE_ENV==='production'
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/auth/google/callback`
  : `http://localhost:${PORT}/auth/google/callback`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT
);

// ── Middleware ──────────────────────────────────────────────
app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,'public')));
app.use(session({
  secret: process.env.SESSION_SECRET||'rentai',
  resave:false, saveUninitialized:false,
  cookie:{maxAge:7*24*60*60*1000}
}));

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════
app.get('/auth/google', (req,res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type:'offline',
    prompt:'consent',
    scope:[
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ]
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req,res) => {
  try {
    const {tokens} = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    const o2 = google.oauth2({version:'v2',auth:oauth2Client});
    const {data} = await o2.userinfo.get();
    req.session.user   = {email:data.email, name:data.name, picture:data.picture};
    req.session.tokens = tokens;
    res.redirect('/');
  } catch(e){ console.error(e); res.redirect('/?error=auth'); }
});

app.get('/auth/logout', (req,res)=>{ req.session.destroy(); res.redirect('/'); });
app.get('/api/me', (req,res)=>res.json(req.session.user||null));

// API ключ Яндекс карт — отдаём фронту безопасно
app.get('/api/config', (req,res)=>res.json({yandexKey: process.env.YANDEX_MAPS_KEY||''}));

// ══════════════════════════════════════════════════════════════
// PROPERTIES
// ══════════════════════════════════════════════════════════════
app.get('/api/properties', (req,res)=>res.json(readDB().properties));

app.post('/api/properties', upload.array('photos',20), (req,res)=>{
  const db    = readDB();
  const photos= (req.files||[]).map(f=>'/uploads/'+f.filename);
  const prop  = {
    id: Date.now().toString(),
    address:  req.body.address,
    area:     parseFloat(req.body.area),
    price:    parseFloat(req.body.price),
    type:     req.body.type,
    floor:    req.body.floor||'1',
    ceiling:  req.body.ceiling||'',
    entrance: req.body.entrance||'',
    features: req.body.features||'',
    photos,
    status:'active',
    createdAt: new Date().toISOString(),
    nearby:[], goodCategories:[], badCategories:[],
    tenants:[], excludedTenants:[],
    emailsSent:0
  };
  db.properties.push(prop);
  writeDB(db);
  res.json(prop);
});

app.delete('/api/properties/:id', (req,res)=>{
  const db = readDB();
  db.properties = db.properties.filter(p=>p.id!==req.params.id);
  writeDB(db);
  res.json({ok:true});
});

// ══════════════════════════════════════════════════════════════
// ЯНДЕКС КАРТЫ — что рядом (через Геокодер + Organizations API)
// ══════════════════════════════════════════════════════════════
app.post('/api/nearby', async (req,res)=>{
  const {address} = req.body;
  try {
    // 1. Геокодируем адрес → координаты
    const geoUrl = `https://geocode-maps.yandex.ru/1.x/?apikey=${process.env.YANDEX_MAPS_KEY}&geocode=${encodeURIComponent(address)}&format=json&results=1`;
    const geoRes  = await fetch(geoUrl);
    const geoData = await geoRes.json();
    const pos     = geoData.response.GeoObjectCollection.featureMember[0]?.GeoObject?.Point?.pos;
    if(!pos) return res.json({nearby:[], coords:null});

    const [lon,lat] = pos.split(' ').map(Number);

    // 2. Ищем организации рядом через Яндекс Places API
    const cats = ['кафе','аптека','магазин','фитнес','банк','клиника','салон красоты','супермаркет','ресторан','офис'];
    const nearbyAll = [];

    for(const cat of cats){
      const url = `https://search-maps.yandex.ru/v1/?apikey=${process.env.YANDEX_MAPS_KEY}&text=${encodeURIComponent(cat)}&ll=${lon},${lat}&spn=0.005,0.005&type=biz&lang=ru_RU&results=3`;
      try {
        const r = await fetch(url);
        const d = await r.json();
        (d.features||[]).forEach(f=>{
          const coords = f.geometry?.coordinates;
          const name   = f.properties?.name;
          const cats2  = f.properties?.Categories?.[0]?.name||cat;
          if(name && coords){
            const dist = Math.round(getDistance(lat,lon,coords[1],coords[0]));
            if(dist<=600 && !nearbyAll.find(x=>x.name===name)){
              nearbyAll.push({name, type:cats2, distance:dist+'м', distNum:dist});
            }
          }
        });
      } catch(e){ /* продолжаем */ }
    }

    nearbyAll.sort((a,b)=>a.distNum-b.distNum);
    res.json({nearby: nearbyAll.slice(0,15), coords:{lat,lon}});
  } catch(e){
    console.error(e);
    res.json({nearby:[], coords:null, error:e.message});
  }
});

function getDistance(lat1,lon1,lat2,lon2){
  const R=6371000, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// ══════════════════════════════════════════════════════════════
// GEMINI — анализ + поиск арендаторов + письма
// ══════════════════════════════════════════════════════════════
async function callGemini(prompt){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res  = await fetch(url,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      contents:[{parts:[{text:prompt}]}],
      generationConfig:{temperature:0.3, maxOutputTokens:3000}
    })
  });
  const data = await res.json();
  if(data.error) throw new Error(data.error.message);
  return data.candidates[0].content.parts[0].text;
}

// Анализ окружения через Gemini
app.post('/api/analyze', async (req,res)=>{
  const {propertyId, nearby, area, type, price, address} = req.body;
  try {
    const nearbyText = nearby.map(n=>`${n.name} (${n.type}, ${n.distance})`).join(', ');
    const prompt = `Ты эксперт по коммерческой недвижимости.

Помещение: ${address}, ${area} м², ${type}, ${price} руб/мес.
Рядом в радиусе 600 м: ${nearbyText||'данных нет'}.

Проанализируй окружение и определи:
1. Какие из соседей являются конкурентами для потенциальных арендаторов
2. Какие категории бизнеса идеально подойдут для этого помещения
3. Какие категории НЕ стоит рассматривать (конкурируют с соседями)

Ответь ТОЛЬКО валидным JSON без markdown блоков:
{
  "nearby": [
    {"name":"название","type":"тип","distance":"расстояние","isCompetitor":true,"competitorFor":"для какого типа бизнеса конкурент, или null"}
  ],
  "goodCategories": ["фастфуд","фитнес","детские товары"],
  "badCategories": ["аптека","кофейня"],
  "summary": "2 предложения — вывод и рекомендация"
}`;

    const text   = await callGemini(prompt);
    const clean  = text.replace(/```json|```/g,'').trim();
    const result = JSON.parse(clean);

    if(propertyId){
      const db   = readDB();
      const prop = db.properties.find(p=>p.id===propertyId);
      if(prop){
        prop.nearby          = result.nearby||[];
        prop.goodCategories  = result.goodCategories||[];
        prop.badCategories   = result.badCategories||[];
        prop.analyzeSummary  = result.summary||'';
        prop.coords          = req.body.coords||null;
      }
      writeDB(db);
    }
    res.json(result);
  } catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

// Поиск арендаторов через Gemini
app.post('/api/find-tenants', async (req,res)=>{
  const {propertyId} = req.body;
  const db   = readDB();
  const prop = db.properties.find(p=>p.id===propertyId);
  if(!prop) return res.status(404).json({error:'Объект не найден'});

  try {
    const prompt = `Ты эксперт по коммерческой недвижимости России.

Нужно найти потенциальных арендаторов для помещения:
- Адрес: ${prop.address}
- Площадь: ${prop.area} м²
- Тип: ${prop.type}
- Цена: ${prop.price.toLocaleString()} руб/мес
- Этаж: ${prop.floor}
- Подходящие категории: ${(prop.goodCategories||[]).join(', ')||'любые'}
- ИСКЛЮЧИТЬ (конкурируют с соседями): ${(prop.badCategories||[]).join(', ')||'нет ограничений'}

Назови 6-8 реальных российских компаний или сетей, которые:
1. Активно открывают новые точки
2. Ищут помещения площадью ${prop.area} м² (±30%)
3. НЕ конкурируют с соседями
4. Подходят по типу помещения

Также укажи 2-3 компании которых нужно исключить (конкурируют с соседями).

Ответь ТОЛЬКО валидным JSON без markdown:
{
  "tenants": [
    {
      "name": "Додо Пицца",
      "type": "Пиццерия",
      "isChain": true,
      "areaMin": 80,
      "areaMax": 150,
      "email": "franchise@dodopizza.ru",
      "website": "dodopizza.ru",
      "matchScore": 92,
      "matchReason": "Активно открывают франшизы, нет конкурентов рядом"
    }
  ],
  "excluded": [
    {"name": "Название", "reason": "Причина исключения"}
  ]
}`;

    const text   = await callGemini(prompt);
    const clean  = text.replace(/```json|```/g,'').trim();
    const result = JSON.parse(clean);

    prop.tenants         = result.tenants||[];
    prop.excludedTenants = result.excluded||[];
    writeDB(db);
    res.json(result);
  } catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

// Генерация письма через Gemini
app.post('/api/generate-email', async (req,res)=>{
  const {propertyId, tenantName, tenantType} = req.body;
  const db   = readDB();
  const prop = db.properties.find(p=>p.id===propertyId);
  if(!prop) return res.status(404).json({error:'Объект не найден'});

  try {
    const noCompetitors = (prop.badCategories||[]).filter(c=>!c.toLowerCase().includes((tenantType||'').toLowerCase().split(' ')[0]));
    const nearbyGood    = (prop.nearby||[]).filter(n=>!n.isCompetitor).slice(0,3).map(n=>n.name).join(', ');

    const prompt = `Напиши деловое письмо-предложение об аренде коммерческого помещения.

Получатель: компания "${tenantName}" (${tenantType})
Помещение:
- Адрес: ${prop.address}
- Площадь: ${prop.area} м²
- Тип: ${prop.type}
- Цена: ${prop.price.toLocaleString()} руб/мес
- Этаж: ${prop.floor}${prop.ceiling ? ', потолки '+prop.ceiling+' м' : ''}${prop.entrance ? ', вход: '+prop.entrance : ''}
- Особенности: ${prop.features||'нет'}
- Рядом нет прямых конкурентов в сфере "${tenantType}" — это преимущество!
- Инфраструктура рядом: ${nearbyGood||'развитая'}

Требования к письму:
- Деловой но живой тон, не шаблонный
- Конкретные цифры и факты
- Подчеркни отсутствие конкурентов в их сегменте
- В конце — приглашение на осмотр и контакт
- Длина: 150-200 слов

Ответь ТОЛЬКО валидным JSON без markdown:
{"subject":"тема письма","body":"полный текст письма"}`;

    const text   = await callGemini(prompt);
    const clean  = text.replace(/```json|```/g,'').trim();
    res.json(JSON.parse(clean));
  } catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════════════
// GMAIL — отправка
// ══════════════════════════════════════════════════════════════
app.post('/api/send-email', async (req,res)=>{
  if(!req.session.tokens) return res.status(401).json({error:'Не авторизован в Gmail'});
  const {to, subject, body, propertyId} = req.body;
  try {
    oauth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({version:'v1', auth:oauth2Client});
    const msg = [
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64','',
      Buffer.from(body).toString('base64')
    ].join('\n');
    const raw = Buffer.from(msg).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    await gmail.users.messages.send({userId:'me', requestBody:{raw}});

    const db = readDB();
    if(propertyId){
      const p = db.properties.find(x=>x.id===propertyId);
      if(p) p.emailsSent=(p.emailsSent||0)+1;
    }
    db.emails = db.emails||[];
    db.emails.push({id:Date.now().toString(), propertyId, to, subject, body, sentAt:new Date().toISOString()});
    writeDB(db);
    res.json({ok:true});
  } catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

app.get('/api/emails', (req,res)=>res.json((readDB().emails||[])));

// ── Главная ─────────────────────────────────────────────────
app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, ()=>{
  console.log(`\n✅  RentAI: http://localhost:${PORT}`);
  console.log(`📧  Gmail OAuth: http://localhost:${PORT}/auth/google\n`);
});
