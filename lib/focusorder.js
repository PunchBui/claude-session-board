// The new Focus order after the sidebar is reordered. Only sessions that are already in
// Focus are kept, in the requested order; any the request left out keep their place at the end.
export function reorderFocus(current, requested) {
  const known = new Set(current)
  const ordered = [...new Set(Array.isArray(requested) ? requested : [])].filter((id) => known.has(id))
  const placed = new Set(ordered)
  return [...ordered, ...current.filter((id) => !placed.has(id))]
}
