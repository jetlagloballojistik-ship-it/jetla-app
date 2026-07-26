"""
JETLA Kurye Yönetim Sistemi — Yemek Platform Entegrasyon Engine (Integration Hub)
=============================================================================
Bu servis; Yemeksepeti, Trendyol Yemek, GetirYemek ve Migros Yemek'ten gelen canlı
webhook/API çağrılarını karşılar, müşteri adresini harita koordinatına dönüştürür,
gerçek sürüş KM mesafesini hesaplar, restoran cüzdanından ön yüklemeli bakiyeyi düşer
ve paketi otomatik olarak en yakın kuryeye atar.
"""

import os
import math
import requests
from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Request, Header
from pydantic import BaseModel
from supabase import create_client, Client

app = FastAPI(title="JETLA Integration Hub Gateway", version="2.0.0")

# Supabase Bağlantısı
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://ofswgysmjvzmubjselod.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_ANON_KEY", "sb_publishable_q-wiWoqRkVYpJDGRuMBAdA_UQnJ26dU")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# OpenStreetMap OSRM Gerçek Sürüş Rotası KM Hesabı
OSRM_URL = os.getenv("OSRM_ROUTING_URL", "https://router.project-osrm.org/route/v1/driving")


def get_driving_distance_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Restoran ve Müşteri koordinatları arasındaki GERÇEK kurye sürüş mesafesini (KM) döndürür."""
    try:
        url = f"{OSRM_URL}/{lng1},{lat1};{lng2},{lat2}?overview=false"
        res = requests.get(url, timeout=5)
        if res.status_code == 200:
            data = res.json()
            if data.get("routes") and len(data["routes"]) > 0:
                distance_meters = data["routes"][0]["distance"]
                return round(distance_meters / 1000.0, 2)
    except Exception as e:
        print(f"OSRM Rota hesabı hatası: {e}")
    
    # Fallback: Haversine formülü (Kuş uçuşu * 1.25 ortalama yol katsayısı)
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return round(R * c * 1.25, 2)


def geocode_address_turkey(address: str, city: str = "Antalya") -> Optional[Dict[str, float]]:
    """Adresten enlem/boylam bulur (Nominatim Geocoding API)."""
    try:
        query = f"{address}, {city}, Türkiye"
        url = f"https://nominatim.openstreetmap.org/search?format=json&limit=1&q={requests.utils.quote(query)}"
        res = requests.get(url, headers={"User-Agent": "JETLA-Courier-Platform/2.0"}, timeout=5)
        if res.status_code == 200:
            data = res.json()
            if data and len(data) > 0:
                return {"lat": float(data[0]["lat"]), "lng": float(data[0]["lon"])}
    except Exception as e:
        print(f"Geocoding hatası: {e}")
    return None


def calculate_package_pricing(rest_id: str, km: float) -> Dict[str, float]:
    """
    İşletmeden düşecek toplam ücreti ve kurye hakedişini hesaplar.
    Formül: Paket Ücreti + (KM * KM Ücreti)
    """
    pkg_fee = 35.0
    km_fee = 2.5
    km_interval = 1.0
    min_fee = 20.0
    
    # Eğer özel ayar varsa yükle
    intervals = math.floor(km / km_interval) if km_interval > 0 else 0
    total_fee = max(min_fee, pkg_fee + (intervals * km_fee))
    courier_earn = 25.0 + (intervals * 2.0)
    
    return {"total_fee": round(total_fee, 2), "courier_fee": round(courier_earn, 2)}


def auto_assign_courier(rest_id: str) -> Optional[Dict[str, Any]]:
    """En yakın ve uygun (kapasitesi dolmamış) kuryeyi seçer."""
    try:
        res = supabase.table("couriers").select("*").eq("status", "active").execute()
        active_couriers = res.data or []
        if not active_couriers:
            return None
        
        # Öncelikli kurye kontrolü
        priority = [c for c in active_couriers if c.get("priority_rest_id") == rest_id]
        if priority:
            return priority[0]
            
        # En az yüklü kuryeyi seç
        active_couriers.sort(key=lambda c: c.get("packages_count", 0))
        return active_couriers[0]
    except Exception as e:
        print(f"Kurye atama hatası: {e}")
        return None


# Webhook Modelleri
class WebhookOrder(BaseModel):
    store_id: str
    order_id: str
    customer_name: str
    customer_phone: Optional[str] = ""
    address: str
    payment_type: str  # Nakit, Kredi Kartı, Online
    amount: float
    items_summary: Optional[str] = ""


@app.get("/")
def health_check():
    return {"status": "ok", "service": "JETLA Integration Hub Gateway", "version": "2.0.0"}


@app.post("/webhook/yemeksepeti")
async def webhook_yemeksepeti(order: WebhookOrder):
    return process_incoming_platform_order("Yemeksepeti", order)


@app.post("/webhook/trendyol")
async def webhook_trendyol(order: WebhookOrder):
    return process_incoming_platform_order("Trendyol", order)


@app.post("/webhook/getir")
async def webhook_getir(order: WebhookOrder):
    return process_incoming_platform_order("Getir", order)


@app.post("/webhook/migros")
async def webhook_migros(order: WebhookOrder):
    return process_incoming_platform_order("Migros", order)


def process_incoming_platform_order(platform_name: str, order: WebhookOrder):
    # 1. Restoranı bul
    rest_res = supabase.table("restaurants").select("*").eq("id", order.store_id).execute()
    if not rest_res.data:
        raise HTTPException(status_code=404, detail=f"İşletme ({order.store_id}) bulunamadı.")
    
    rest = rest_res.data[0]
    rest_id = rest["id"]
    rest_balance = float(rest.get("balance", 0))
    rest_lat = rest.get("lat") or 36.8865
    rest_lng = rest.get("lng") or 30.7056

    # 2. Adresi Geocode Et
    coords = geocode_address_turkey(order.address)
    delivery_lat = coords["lat"] if coords else rest_lat + 0.01
    delivery_lng = coords["lng"] if coords else rest_lng + 0.01

    # 3. Gerçek Rota KM ve Fiyat Hesabı
    km = get_driving_distance_km(rest_lat, rest_lng, delivery_lat, delivery_lng)
    pricing = calculate_package_pricing(rest_id, km)
    total_fee = pricing["total_fee"]
    courier_fee = pricing["courier_fee"]

    # 4. Bakiye Kontrolü & Ön Yüklemeli Cüzdan Düşüşü
    if rest_balance < total_fee:
        raise HTTPException(status_code=400, detail=f"Yetersiz Bakiye. Gerekli: {total_fee} ₺, Mevcut: {rest_balance} ₺")

    # 5. Otomatik Kurye Atama
    assigned_courier = auto_assign_courier(rest_id)
    courier_id = assigned_courier["id"] if assigned_courier else None
    courier_name = assigned_courier["name"] if assigned_courier else ""
    status = "Atandı" if assigned_courier else "Otomatik Atama Bekliyor"

    import uuid
    pkg_id = str(uuid.uuid4())[:8].upper()

    # 6. Paket Kaydı Ekle
    pkg_data = {
        "id": pkg_id,
        "rest_id": rest_id,
        "restaurant_name": rest["name"],
        "courier_id": courier_id,
        "courier_name": courier_name,
        "status": status,
        "address": order.address,
        "lat": delivery_lat,
        "lng": delivery_lng,
        "km_distance": km,
        "payment_type": order.payment_type,
        "fee": total_fee,
        "courier_fee": courier_fee,
        "platform": platform_name,
        "platform_order_id": order.order_id,
        "amount": order.amount
    }
    supabase.table("packages").insert(pkg_data).execute()

    # 7. Restoran Cüzdanından Bakiye Düşüşü Yap
    new_balance = rest_balance - total_fee
    supabase.table("restaurants").update({
        "balance": new_balance,
        "total_packages": rest.get("total_packages", 0) + 1
    }).eq("id", rest_id).execute()

    # 8. Kurye Yükünü Güncelle
    if courier_id:
        supabase.table("couriers").update({
            "packages_count": assigned_courier.get("packages_count", 0) + 1
        }).eq("id", courier_id).execute()

    return {
        "success": True,
        "package_id": pkg_id,
        "platform": platform_name,
        "order_id": order.order_id,
        "km_distance": km,
        "total_fee_deducted": total_fee,
        "remaining_balance": new_balance,
        "assigned_courier": courier_name or "Atama Bekliyor"
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)
