import { DataSource } from "typeorm";

const R = 6371.0088;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function pointInPolygon(lat: number, lng: number, polygon: number[][]): boolean {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function maskPhone(phone?: string | null): string {
  if (!phone) return "";
  return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

/** 5.5 片区判定：先做电子围栏（点在多边形），退化为「中心点 + 半径」 */
export async function resolveRegion(ds: DataSource, lat: number, lng: number): Promise<any | null> {
  const regions = await ds.query("SELECT * FROM `regions`");
  for (const r of regions) {
    if (!r.polygon) continue;
    try {
      const poly = typeof r.polygon === "string" ? JSON.parse(r.polygon) : r.polygon;
      if (pointInPolygon(lat, lng, poly)) return r;
    } catch {
      /* ignore */
    }
  }
  let best: any = null;
  let bestD = Infinity;
  for (const r of regions) {
    const d = haversineKm(lat, lng, Number(r.center_lat), Number(r.center_lng));
    if (d <= Number(r.radius_km) && d < bestD) {
      best = r;
      bestD = d;
    }
  }
  return best;
}