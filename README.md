# ⚡ JETLA Kurye Yönetim & Entegrasyon Platformu

## 📌 Amaç
**JETLA**, restoranlar ve kuryeler arasında ön yüklemeli bakiye sistemi, milimetrik harita sürüş rotası (KM) hesabı ve **Yemeksepeti, Trendyol Yemek, GetirYemek, Migros Yemek** platformlarıyla tam entegrasyon sağlayan profesyonel bir Lojistik & Kurye Yönetim SaaS platformudur.

## 🛠️ Stack & Altyapı
- **Frontend / PWA:** React, Vite, Leaflet Maps, Geolocation API
- **Backend / Integration Hub:** Python FastAPI, OSRM Route Engine, Geocoding (Nominatim / Google Maps)
- **Veritabanı:** Supabase PostgreSQL + PostGIS (İlişkisel & Normalize Şema)
- **Gerçek Zamanlı İletişim:** Supabase Realtime Pub/Sub WebSockets

## 🚀 Çalışma Şekli & Mimari
1. **İşletme Bakiye & Cüzdan:** Restoranlar sisteme ön yüklemeli bakiye yatırır. Her siparişte:
   $$\text{İşletmeden Düşecek Ücret} = \text{Paket Ücreti} + (\text{Net KM} \times \text{KM Ücreti})$$
2. **Milimetrik KM Hesabı:** Kuş uçuşu yerine OSRM sürüş rotası altyapısıyla gerçek yol mesafesi hesaplanır.
3. **Yemek Platform Entegrasyonları (Integration Hub):** Yemeksepeti / Trendyol / Getir / Migros üzerinden gelen siparişler Webhook aracılığıyla otomatik sisteme akar, adresten koordinat türetilir ve en yakın kuryeye atanır.
4. **Kurye PWA & Navigasyon:** Tek tıkla restorana veya müşteriye Google Maps / Yandex rotası çizer, sesli paket alarmı verir.

## ⚙️ Environment Setup
1. `supabase_setup.sql` scriptini Supabase SQL Editor üzerinde çalıştırarak tabloları oluşturun.
2. `.env.example` dosyasını `.env` olarak kopyalayın ve anahtarları doldurun:
   ```bash
   cp .env.example .env
   ```
3. Bağımlılıkları yükleyin:
   ```bash
   pip install fastapi uvicorn requests pydantic supabase
   ```
4. Integration Hub servisini başlatın:
   ```bash
   python integration_hub.py
   ```
