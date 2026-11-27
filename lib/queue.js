export function settleForce(queue, qid, { status, interrupting, wasPaused }) {
  if (status === 202) queue.items = queue.items.filter((entry) => entry.qid !== qid)
  if (interrupting) queue.paused = wasPaused
}
