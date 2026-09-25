// Static relative ES-module import target.
export const now = () => performance.timeOrigin + performance.now();
export function pct(arr, p) {
  if (!arr.length) return null;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
