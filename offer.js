// The Offer: one second after the first Sequence ends, a card asks for first
// name and email in exchange for the Discount Code. Closed, it leaves the Offer
// Badge, which reopens it (or shows the code once the email is in). It waits
// while the user records a video or reviews it. If sending fails the code
// shows anyway and the Lead is resent on the next visit. The phone remembers a
// Lead, so a returning one gets the badge with the code and no Offer.
(() => {
  const CODE = 'NOMAD15'
  const PERCENT = 15  // placeholder until the real discount is confirmed
  const STORE_URL = 'https://nomadhub.ar/'  // placeholder until the store exists
  const STORAGE_KEY = 'nomadhub-lead'
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

  const load = () => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) } catch (e) { return null }
  }
  const save = (v) => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)) } catch (e) { /* private mode */ }
  }
  const send = (data) => fetch('/api/lead', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(data),
  }).then(r => r.status).catch(() => 0)

  let lead = load()
  // Answered for good (stored, or rejected as invalid): stop resending.
  const settle = (status) => {
    if (status === 200 || status === 400) {
      lead.pending = false
      save(lead)
    }
  }
  if (lead?.pending) {
    send({name: lead.name, email: lead.email, consent: true, website: '', elapsedMs: 1e9}).then(settle)
  }

  const init = () => {
    const $ = id => document.getElementById(id)
    const card = $('offer'), form = $('offer-form'), done = $('offer-done'), badge = $('offer-badge')
    const name = $('offer-name'), email = $('offer-email'), consent = $('offer-consent')
    const honeypot = $('offer-website'), submit = $('offer-submit'), copy = $('offer-copy')

    $('offer-title').textContent = `¿Te gustó? ${PERCENT}% off en tu próximo café`
    submit.textContent = `Quiero mi ${PERCENT}%`
    $('offer-code').textContent = CODE
    $('offer-store').href = STORE_URL

    let busy = false  // recording, or reviewing the video
    let due = false
    let openedAt = 0

    const showBadge = () => {
      badge.textContent = lead ? `Tu código: ${CODE}` : `${PERCENT}% OFF`
      badge.hidden = false
    }
    const open = () => {
      form.hidden = !!lead
      done.hidden = !lead
      if (lead) $('offer-thanks').textContent = `¡Listo, ${lead.name}!`
      badge.hidden = true
      card.classList.add('open')
      openedAt = Date.now()
    }
    const close = () => {
      card.classList.remove('open')
      showBadge()
    }
    const maybeOpen = () => {
      if (!due || busy) return
      due = false
      open()
    }

    window.addEventListener('sequence-end', ({detail}) => {
      if (detail.loop !== 1 || lead) return
      setTimeout(() => { due = true; maybeOpen() }, 1000)
    })
    window.addEventListener('experience-start', () => { if (lead) showBadge() })
    window.addEventListener('mediarecorder-recordstart', () => { busy = true })
    for (const ev of ['mediarecorder-previewclosed', 'mediarecorder-recorderror']) {
      window.addEventListener(ev, () => { busy = false; maybeOpen() })
    }

    const valid = () => name.value.trim() && EMAIL.test(email.value.trim()) && consent.checked
    for (const el of [name, email, consent]) el.addEventListener('input', () => { submit.disabled = !valid() })
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      if (!valid()) return
      lead = {name: name.value.trim(), email: email.value.trim(), pending: true}
      save(lead)
      send({name: lead.name, email: lead.email, consent: true, website: honeypot.value,
        elapsedMs: Date.now() - openedAt}).then(settle)
      open()  // the code shows whether or not the send got through
    })
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(CODE).then(() => {
        copy.textContent = '¡Copiado!'
        setTimeout(() => { copy.textContent = 'Copiar' }, 1500)
      })
    })
    $('offer-close').addEventListener('click', close)
    badge.addEventListener('click', open)
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init()
})()
