# RentAI — Инструкция по запуску

## Стек (всё бесплатно)
- **Gemini API** — AI анализ + поиск арендаторов + письма
- **Яндекс Карты** — что находится рядом с объектом
- **Gmail API** — отправка писем с твоей почты
- **Render.com** — хостинг в интернете

---

## Шаг 1 — Получи ключи

### Gemini API (бесплатно, 1500 запросов/день)
1. Зайди на https://aistudio.google.com/app/apikey
2. Нажми **Create API Key**
3. Скопируй ключ → это `GEMINI_API_KEY`

### Яндекс Карты JS API (бесплатно)
1. Зайди на https://developer.tech.yandex.ru
2. Войди через Яндекс аккаунт
3. Нажми **Подключить API** → выбери **JavaScript API и HTTP Геокодер**
4. Заполни форму, создай ключ
5. Скопируй ключ → это `YANDEX_MAPS_KEY`
6. ⚠️ В настройках ключа добавь свой домен в «Разрешённые домены»

### Google OAuth для Gmail
1. Зайди на https://console.cloud.google.com
2. Создай проект (или выбери существующий)
3. **APIs & Services** → **Library** → найди **Gmail API** → нажми **Enable**
4. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Application type: **Web application**
6. Authorized redirect URIs — добавь ОБА:
   - `http://localhost:3000/auth/google/callback`
   - `https://ТВОЙсайт.onrender.com/auth/google/callback`
7. Скопируй **Client ID** и **Client Secret**
8. Также: **OAuth consent screen** → добавь свой email в Test users

---

## Шаг 2 — Локальный запуск

1. Установи **Node.js** с https://nodejs.org (версия 18+)
2. Скопируй `.env.example` в `.env`:
   ```
   cp .env.example .env
   ```
3. Открой `.env` и вставь свои ключи
4. Установи зависимости:
   ```
   npm install
   ```
5. Запусти:
   ```
   npm start
   ```
6. Открой http://localhost:3000

---

## Шаг 3 — Выложи в интернет на Render.com (бесплатно)

1. Зарегистрируйся на https://render.com
2. Создай аккаунт на https://github.com и загрузи папку rentai2 как репозиторий
3. В Render: **New** → **Web Service** → подключи GitHub репозиторий
4. Настройки:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Node version:** 18
5. **Environment** → добавь все переменные из .env
6. Нажми **Deploy**
7. Скопируй URL вида `https://rentai-xxxx.onrender.com`
8. Добавь этот URL в Google OAuth redirect URIs (шаг 1.3)
9. Добавь этот URL в разрешённые домены Яндекс Карт

---

## Структура файлов
```
rentai2/
├── server.js        — backend (Node.js)
├── package.json     — зависимости
├── .env.example     — шаблон ключей
├── .env             — твои ключи (не публикуй!)
├── data/
│   └── db.json      — база данных (создаётся автоматически)
└── public/
    ├── index.html   — весь фронтенд
    └── uploads/     — фото объектов
```

---

## ⚠️ Важно
- Файл `.env` — никогда не загружай на GitHub! Добавь в `.gitignore`
- API ключи — только в `.env`, никогда в коде или в чатах
- На Render переменные окружения вводятся в разделе Environment (не в коде)
