// 地理计算：距离、电子围栏、片区归属
const R = 6371.0088;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function pointInPolygon(lat, lng, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 距离系数：越近越高，最低保留 0.05 防止为 0 */
export function distanceFactor(distanceKm, maxRadiusKm, minFactor = 0.05) {
  if (distanceKm == null) return minFactor;
  if (distanceKm >= maxRadiusKm) return minFactor;
  const f = 1 - distanceKm / maxRadiusKm;
  return Math.max(minFactor, Number(f.toFixed(4)));
}

export function maskPhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

export function maskIdCard(id) {
  if (!id) return "";
  return String(id).replace(/^(\d{4})\d+(\w{4})$/, "$1**********$2");
}

export function maskAddress(addr) {
  if (!addr) return "";
  const s = String(addr);
  return s.length > 10 ? s.slice(0, 8) + "***" : s;
}