export function setBounded(map, key, value, max) {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value)
  return value
}
