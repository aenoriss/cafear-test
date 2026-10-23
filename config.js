// Cage placement shared by the AR page (index.html) and the editor (editor.html),
// so the editor's preview and the AR can't disagree.
//
// Settings come from config.json; URL params with the same keys override them
// (e.g. ?cageCm=5). All lengths are real-world cm.
window.CafeConfig = (() => {
  const FIELDS = [
    {key: 'cageCm', label: 'Altura de la jaula', min: 2, max: 36, step: 0.5, unit: 'cm'},
    {key: 'gapCm', label: 'Separación del frente', min: -5, max: 20, step: 0.5, unit: 'cm'},
    {key: 'xCm', label: 'Desplazamiento lateral', min: -20, max: 20, step: 0.5, unit: 'cm'},
    {key: 'rotDeg', label: 'Rotación', min: -180, max: 180, step: 5, unit: '°'},
    {key: 'qrCm', label: 'QR impreso (lado)', min: 2, max: 20, step: 0.5, unit: 'cm'},
    {key: 'qrHeightCm', label: 'Centro del QR sobre la mesa', min: 2, max: 40, step: 0.5, unit: 'cm'},
    {key: 'bagWCm', label: 'Bolsa: ancho', min: 5, max: 40, step: 0.5, unit: 'cm', preview: true},
    {key: 'bagHCm', label: 'Bolsa: alto', min: 5, max: 50, step: 0.5, unit: 'cm', preview: true},
    {key: 'bagDCm', label: 'Bolsa: profundidad', min: 2, max: 20, step: 0.5, unit: 'cm', preview: true},
  ]
  const DEFAULTS = {
    cageCm: 7, gapCm: 1, xCm: 0, rotDeg: 0, qrCm: 6, qrHeightCm: 10,
    bagWCm: 16, bagHCm: 24, bagDCm: 8,
  }
  // jaula.glb's bounds, in metres.
  const CAGE_MODEL = {height: 0.364, radius: 0.12}

  const load = async () => {
    let file = {}
    try {
      file = await (await fetch('config.json', {cache: 'no-store'})).json()
    } catch (e) {
      console.warn('config.json not loaded, using defaults', e)
    }
    const cfg = {...DEFAULTS, ...file}
    const params = new URLSearchParams(location.search)
    for (const key of Object.keys(DEFAULTS)) {
      const v = parseFloat(params.get(key))
      if (Number.isFinite(v)) cfg[key] = v
    }
    return cfg
  }

  // Where the cage goes, given the QR's frame in some world:
  //   center  QR centre; normal: horizontal unit vector out of the QR;
  //   up      unit vector; k: world units per metre;
  //   floorY  world y of the table, or null to use cfg.qrHeightCm instead.
  // onQr stands the cage on the QR itself (desktop webcam preview).
  const placeCage = (THREE, {center, normal, up, k, floorY = null}, cfg, {onQr = false} = {}) => {
    const s = cfg.cageCm / 100 / CAGE_MODEL.height
    const radius = CAGE_MODEL.radius * s
    const right = new THREE.Vector3().crossVectors(normal, up).negate()  // (-n) x up
    const out = onQr ? 0 : radius + cfg.gapCm / 100
    const drop = onQr ? cfg.qrCm / 200 : cfg.qrHeightCm / 100
    const position = center.clone()
      .addScaledVector(right, cfg.xCm / 100 * k)
      .addScaledVector(normal, out * k)
      .addScaledVector(up, -drop * k)
    if (floorY !== null) position.y = floorY

    // Model +Y along up and +X (the door) towards the viewer, then the user's turn.
    const forward = new THREE.Vector3().crossVectors(normal, up)
    const quaternion = new THREE.Quaternion()
      .setFromRotationMatrix(new THREE.Matrix4().makeBasis(normal, up, forward))
      .multiply(new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), cfg.rotDeg * Math.PI / 180))
    return {position, quaternion, scale: s * k}
  }

  const PANEL_CSS = `
    .cfg-panel { font: 13px/1.3 system-ui, sans-serif; color: #eee; }
    .cfg-row { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; margin: 0 0 10px; }
    .cfg-row label { opacity: .85; }
    .cfg-row output { font-variant-numeric: tabular-nums; text-align: right; }
    .cfg-row input { grid-column: 1 / -1; width: 100%; accent-color: #2ee6a6; }
    .cfg-group { margin: 14px 0 6px; font-size: 11px; letter-spacing: .08em;
      text-transform: uppercase; opacity: .6; }
  `

  // Sliders for `keys` (default: all). Calls onChange(cfg) on every move.
  const panel = (container, cfg, onChange, keys = FIELDS.map(f => f.key)) => {
    if (!document.getElementById('cfg-panel-css')) {
      const style = document.createElement('style')
      style.id = 'cfg-panel-css'
      style.textContent = PANEL_CSS
      document.head.appendChild(style)
    }
    container.classList.add('cfg-panel')
    const inputs = {}
    let group = null
    for (const f of FIELDS.filter(f => keys.includes(f.key))) {
      const g = f.preview ? 'Bolsa (solo vista previa)' : f.key.startsWith('qr') ? 'QR' : 'Jaula'
      if (g !== group) {
        group = g
        const h = document.createElement('div')
        h.className = 'cfg-group'
        h.textContent = g
        container.appendChild(h)
      }
      const row = document.createElement('div')
      row.className = 'cfg-row'
      row.innerHTML = `<label for="cfg-${f.key}">${f.label}</label><output></output>
        <input id="cfg-${f.key}" type="range" min="${f.min}" max="${f.max}" step="${f.step}">`
      const input = row.querySelector('input')
      const out = row.querySelector('output')
      const show = () => { out.textContent = `${cfg[f.key]} ${f.unit}` }
      input.value = cfg[f.key]
      show()
      input.addEventListener('input', () => {
        cfg[f.key] = parseFloat(input.value)
        show()
        onChange(cfg)
      })
      inputs[f.key] = {input, show}
      container.appendChild(row)
    }
    // Lets the caller push new values (e.g. after Reset).
    return () => {
      for (const [key, {input, show}] of Object.entries(inputs)) {
        input.value = cfg[key]
        show()
      }
    }
  }

  return {FIELDS, DEFAULTS, CAGE_MODEL, load, placeCage, panel}
})()
