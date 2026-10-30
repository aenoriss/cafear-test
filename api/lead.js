// POST /api/lead {name, email, consent, website, elapsedMs}
// Adds a Lead to the Brevo list; Brevo's automation on that list sends the
// Welcome Email, so a contact already on the list doesn't get a second one.
// Anti-bot (basic): `website` is a honeypot field people never see, and the
// form must have been open a few seconds. Without BREVO_API_KEY (local tests)
// it only logs the Lead.
const API = 'https://api.brevo.com/v3'
const LIST_NAME = 'Nomad Hub — AR bolsa'
const FOLDER_NAME = 'Experiencias'
const SOURCE = 'bolsa-ar'
const MIN_ELAPSED_MS = 2500
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const brevo = async (path, {method = 'GET', body} = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: {'api-key': process.env.BREVO_API_KEY, accept: 'application/json', 'content-type': 'application/json'},
    body: body && JSON.stringify(body),
  })
  const text = await res.text()
  return {status: res.status, data: text ? JSON.parse(text) : null}
}

// Found or created once per function instance.
let listIdPromise = null
const ensureSetup = () => listIdPromise ??= (async () => {
  for (const [name, type] of [['ORIGEN', 'text'], ['CONSENTIMIENTO', 'date']]) {
    const r = await brevo(`/contacts/attributes/normal/${name}`, {method: 'POST', body: {type}})
    if (r.status >= 300 && r.status !== 400) throw new Error(`attribute ${name}: ${r.status}`)  // 400: exists
  }
  const lists = await brevo('/contacts/lists?limit=50&offset=0')
  const found = lists.data?.lists?.find(l => l.name === LIST_NAME)
  if (found) return found.id
  const folders = await brevo('/contacts/folders?limit=50&offset=0')
  let folderId = folders.data?.folders?.find(f => f.name === FOLDER_NAME)?.id
  if (!folderId) folderId = (await brevo('/contacts/folders', {method: 'POST', body: {name: FOLDER_NAME}})).data.id
  const created = await brevo('/contacts/lists', {method: 'POST', body: {name: LIST_NAME, folderId}})
  if (!created.data?.id) throw new Error(`create list: ${created.status}`)
  return created.data.id
})().catch((e) => { listIdPromise = null; throw e })

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ok: false})
  const {name = '', email = '', consent, website, elapsedMs} = req.body || {}
  const cleanName = String(name).trim().slice(0, 60)
  const cleanEmail = String(email).trim().toLowerCase()

  // Bots: answer as if it worked, store nothing.
  if (website || !(Number(elapsedMs) >= MIN_ELAPSED_MS)) return res.status(200).json({ok: true})
  if (!cleanName || cleanEmail.length > 254 || !EMAIL.test(cleanEmail) || consent !== true) {
    return res.status(400).json({ok: false, error: 'invalid'})
  }

  if (!process.env.BREVO_API_KEY) {
    console.log(`[lead] test mode, not stored: ${cleanName} <${cleanEmail}>`)
    return res.status(200).json({ok: true, test: true})
  }

  try {
    const listId = await ensureSetup()
    const existing = await brevo(`/contacts/${encodeURIComponent(cleanEmail)}`)
    const isNew = existing.status === 404 || !existing.data?.listIds?.includes(listId)
    const saved = await brevo('/contacts', {
      method: 'POST',
      body: {
        email: cleanEmail,
        updateEnabled: true,
        listIds: [listId],
        attributes: {
          NOMBRE: cleanName,
          ORIGEN: SOURCE,
          // First consent kept; a repeat sign-up doesn't move it.
          ...(isNew ? {CONSENTIMIENTO: new Date().toISOString().slice(0, 10)} : {}),
        },
      },
    })
    if (saved.status >= 300) throw new Error(`save contact: ${saved.status} ${JSON.stringify(saved.data)}`)
    return res.status(200).json({ok: true, isNew})
  } catch (e) {
    console.error('[lead]', e.message)
    return res.status(502).json({ok: false})
  }
}
