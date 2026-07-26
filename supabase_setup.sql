-- ============================================================================
-- JETLA KURYE YÖNETİM SİSTEMİ — SUPABASE NORMALIZE VERİTABANI ŞEMASI
-- ============================================================================

-- 1. EKLENTİLER (PostGIS harita ve mesafe hesaplamaları için)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- 2. İŞLETMELER (RESTAURANTS) TABLOSU
CREATE TABLE IF NOT EXISTS restaurants (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    contact VARCHAR(50),
    address TEXT,
    tax_no VARCHAR(20),
    tax_office VARCHAR(100),
    balance NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
    total_packages INT DEFAULT 0 NOT NULL,
    region VARCHAR(50),
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 3. KURYELER (COURIERS) TABLOSU
CREATE TABLE IF NOT EXISTS couriers (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(50),
    tc VARCHAR(20),
    plate VARCHAR(20),
    status VARCHAR(20) DEFAULT 'off' CHECK (status IN ('active', 'break', 'off')),
    km NUMERIC(8, 2) DEFAULT 0.00 NOT NULL,
    earnings NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
    bonus NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
    packages_count INT DEFAULT 0 NOT NULL,
    balance NUMERIC(12, 2) DEFAULT 0.00 NOT NULL,
    priority_rest_id VARCHAR(50) REFERENCES restaurants(id) ON DELETE SET NULL,
    region VARCHAR(50),
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 4. PAKETLER (PACKAGES) TABLOSU
CREATE TABLE IF NOT EXISTS packages (
    id VARCHAR(50) PRIMARY KEY,
    rest_id VARCHAR(50) REFERENCES restaurants(id) ON DELETE CASCADE,
    restaurant_name VARCHAR(150) NOT NULL,
    courier_id VARCHAR(50) REFERENCES couriers(id) ON DELETE SET NULL,
    courier_name VARCHAR(150),
    status VARCHAR(50) DEFAULT 'Oluşturuldu' NOT NULL,
    address TEXT NOT NULL,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    km_distance NUMERIC(8, 2) DEFAULT 0.00,
    payment_type VARCHAR(50) DEFAULT 'Nakit',
    fee NUMERIC(10, 2) DEFAULT 35.00 NOT NULL,
    courier_fee NUMERIC(10, 2) DEFAULT 25.00 NOT NULL,
    platform VARCHAR(50) DEFAULT 'Manuel', -- Manuel, Yemeksepeti, Trendyol, Getir, Migros
    platform_order_id VARCHAR(100),
    amount NUMERIC(10, 2) DEFAULT 0.00,
    time VARCHAR(20),
    day VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    delivered_at TIMESTAMP WITH TIME ZONE
);

-- 5. İŞLETME BAKİYE İŞLEMLERİ (TRANSACTIONS)
CREATE TABLE IF NOT EXISTS transactions (
    id VARCHAR(50) PRIMARY KEY,
    rest_id VARCHAR(50) REFERENCES restaurants(id) ON DELETE CASCADE,
    rest_name VARCHAR(150),
    amount NUMERIC(12, 2) NOT NULL,
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 6. KURYE BAKIYE / AVANS İŞLEMLERİ (COURIER TRANSACTIONS)
CREATE TABLE IF NOT EXISTS courier_transactions (
    id VARCHAR(50) PRIMARY KEY,
    courier_id VARCHAR(50) REFERENCES couriers(id) ON DELETE CASCADE,
    courier_name VARCHAR(150),
    type VARCHAR(50) NOT NULL, -- Bakiye Yükleme, Bakiye Kesinti, Avans
    amount NUMERIC(12, 2) NOT NULL,
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- 7. PLATFORM ENTEGRASYONLARI (INTEGRATIONS HUB)
CREATE TABLE IF NOT EXISTS integrations (
    id VARCHAR(50) PRIMARY KEY, -- ex: rest01_yemeksepeti
    rest_id VARCHAR(50) REFERENCES restaurants(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL, -- yemeksepeti, trendyol, getir, migros
    active BOOLEAN DEFAULT false,
    api_key TEXT,
    store_id VARCHAR(100),
    secret_key TEXT,
    auto_dispatch BOOLEAN DEFAULT true,
    last_sync TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    UNIQUE(rest_id, platform)
);

-- 8. KULLANICILAR (USERS) TABLOSU
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(50) PRIMARY KEY,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'restaurant', 'courier')),
    name VARCHAR(150) NOT NULL,
    pw VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- REALTIME ETKİLEŞİMİ (Supabase Realtime Yayınları)
ALTER PUBLICATION supabase_realtime ADD TABLE restaurants, couriers, packages, transactions, courier_transactions, integrations;
