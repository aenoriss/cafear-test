// POST /api/lead {name, email, consent, website, elapsedMs}
// Adds a Lead to the Brevo list and, if they weren't on it yet, sends the
// Welcome Email (a Brevo template, created here the first time and editable in
// Brevo's panel after that; an existing one is never overwritten).
// Anti-bot (basic): `website` is a honeypot field people never see, and the
// form must have been open a few seconds. Without BREVO_API_KEY (local tests)
// it only logs the Lead.
const API = 'https://api.brevo.com/v3'
const LIST_NAME = 'Nomad Hub — AR bolsa'
const FOLDER_NAME = 'Experiencias'
const SOURCE = 'bolsa-ar'
const MIN_ELAPSED_MS = 2500
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// The Welcome Email's first version; keep CODE, PERCENT and STORE_URL in step
// with offer.js. The sender is Brevo's sender id (not an address: this repo is
// public); id 1 is the account's first verified sender.
const TEMPLATE_NAME = 'Nomad Hub — Bienvenida AR bolsa'
const SENDER_ID = Number(process.env.BREVO_SENDER_ID || 1)
const CODE = 'NOMAD15'
const PERCENT = 15
const STORE_URL = 'https://nomadhub.ar/'
const WELCOME_HTML = `<!doctype html><html lang="es"><body style="margin:0;background:#f4f5f7">
<div style="max-width:480px;margin:0 auto;padding:28px 20px;font:16px/1.5 Arial,sans-serif;color:#1d1e20">
<div style="background:#fff;border-radius:16px;padding:28px 24px">
<p style="margin:0 0 14px">Hola {{ params.nombre }},</p>
<p style="margin:0 0 18px">Gracias por escanear la bolsa de Nomad Hub. Acá tenés tu código:</p>
<p style="margin:0 0 18px;text-align:center"><span style="display:inline-block;padding:10px 22px;border:2px dashed #2ee6a6;border-radius:10px;background:#e9fbf5;font:700 24px monospace;letter-spacing:2px;color:#0b2b21">${CODE}</span></p>
<p style="margin:0 0 20px">Te da un ${PERCENT}% off en tu próxima compra en nuestra tienda online. Copialo y pegalo al pagar.</p>
<p style="margin:0 0 22px;text-align:center"><a href="${STORE_URL}" style="display:inline-block;padding:12px 26px;border-radius:10px;background:#2ee6a6;color:#0b2b21;font-weight:bold;text-decoration:none">Ir a la tienda</a></p>
<p style="margin:0">Fuel for nomads,<br>El equipo de Nomad Hub</p>
</div>
<p style="margin:14px 8px 0;font-size:12px;color:#6b6e80;text-align:center">Recibís este email porque dejaste tus datos en la experiencia de realidad aumentada de Nomad Hub.</p>
</div></body></html>`

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

let templateIdPromise = null
const ensureTemplate = () => templateIdPromise ??= (async () => {
  const all = await brevo('/smtp/templates?limit=100&offset=0')
  const found = all.data?.templates?.find(t => t.name === TEMPLATE_NAME)
  if (found) return found.id
  const created = await brevo('/smtp/templates', {
    method: 'POST',
    body: {
      templateName: TEMPLATE_NAME,
      subject: `Tu ${PERCENT}% off en Nomad Hub, {{ params.nombre }}`,
      sender: {id: SENDER_ID},
      htmlContent: WELCOME_HTML,
      isActive: true,
    },
  })
  if (!created.data?.id) throw new Error(`create template: ${created.status} ${JSON.stringify(created.data)}`)
  return created.data.id
})().catch((e) => { templateIdPromise = null; throw e })

// A failed Welcome Email doesn't fail the Lead: the code is already on screen.
const sendWelcome = async (email, name) => {
  try {
    const templateId = await ensureTemplate()
    const r = await brevo('/smtp/email', {
      method: 'POST',
      body: {templateId, to: [{email, name}], params: {nombre: name}},
    })
    if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.data)}`)
    return true
  } catch (e) {
    console.error('[lead] welcome email:', e.message)
    return false
  }
}

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
    const welcomed = isNew ? await sendWelcome(cleanEmail, cleanName) : false
    return res.status(200).json({ok: true, isNew, welcomed})
  } catch (e) {
    console.error('[lead]', e.message)
    return res.status(502).json({ok: false})
  }
}
