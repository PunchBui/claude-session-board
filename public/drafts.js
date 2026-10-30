const KEY = 'board.drafts'
const MAX_DRAFTS = 60

export class DraftStore extends Map {
  constructor(storage) {
    super()
    this.storage = storage
    try {
      const saved = JSON.parse(storage?.getItem(KEY) ?? '{}')
      for (const [id, text] of Object.entries(saved)) if (typeof text === 'string' && text.trim()) super.set(id, text)
    } catch {}
  }

  persist() {
    const entries = [...this.entries()].filter(([, text]) => text.trim()).slice(-MAX_DRAFTS)
    try {
      this.storage?.setItem(KEY, JSON.stringify(Object.fromEntries(entries)))
    } catch {}
  }

  set(id, text) {
    if (typeof text === 'string' && text.trim()) {
      super.delete(id)
      super.set(id, text)
    } else {
      super.delete(id)
    }
    this.persist()
    return this
  }

  delete(id) {
    const had = super.delete(id)
    this.persist()
    return had
  }

  has(id) {
    return Boolean(super.get(id)?.trim())
  }
}
