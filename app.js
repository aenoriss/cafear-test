// Places a miniature cage on the table in front of the bag, below the QR.
//
//   up      = world +Y (SLAM world is gravity-aligned), not the QR normal, so a
//             leaning bag doesn't tilt the cage
//   heading = QR normal projected onto the horizontal plane
//   floor   = 8th Wall's SLAM ground plane (y = 0)
//   scale   = QR's tracked size / its printed size, so config lengths are real cm
//
// Placement settings (cage size, gap, offset, rotation, QR size) come from
// config.json via config.js, and are edited in editor.html.
//
// URL flags:
//   ?edit     sliders over the live AR, to judge the size against the real bag
//   ?debug    tracking readout and the QR outline
//   ?floor=0  use qrHeightCm instead of 8th Wall's floor
//   ?desktop  laptop webcam: no landing page, no SLAM, cage stands on the QR

const params = new URLSearchParams(location.search)
const DESKTOP = params.has('desktop')
const DEBUG = params.has('debug')
const EDIT = params.has('edit')
const USE_FLOOR = !DESKTOP && params.get('floor') !== '0'
const KEEP_TRACKING = params.has('track')
const ANIM_DELAY_MS = (Number.isFinite(parseFloat(params.get('animDelay')))
  ? parseFloat(params.get('animDelay')) : 3) * 1000
// Phones are DPR 2-3. Rendering at that density starved QR detection on a 4x
// CPU-throttled sim (never found in 2 of 3 runs, vs 2.3 s at DPR 1). ?dpr= overrides.
const MAX_PIXEL_RATIO = parseFloat(params.get('dpr')) || 1.5
const LOCK_AFTER_UPDATES = 45  // accepted QR poses before locking (~1.5 s)

const CFG = {...CafeConfig.DEFAULTS}
const cfgReady = CafeConfig.load().then(c => Object.assign(CFG, c))

const TARGET_NAME = 'qr-cafear'
const SMOOTHING = 0.25

let targetData = null
const enableQr = on => XR8.XrController.configure({imageTargetData: on ? [targetData] : []})

fetch('image-targets/qr-cafear.json')
  .then(r => r.json())
  .then((target) => {
    targetData = target
    const configure = () => enableQr(true)
    window.XR8 ? configure() : window.addEventListener('xrloaded', configure)
  })

AFRAME.registerComponent('env-map', {
  schema: {src: {type: 'string'}},
  init() {
    const {THREE} = AFRAME
    new THREE.TextureLoader().load(this.data.src, (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping
      tex.colorSpace = THREE.SRGBColorSpace
      this.el.object3D.environment = tex
    })
  },
})

// On the gltf-model entity: measure the model (its units are whatever the
// modeler exported), stand its base on the table, and loop its animations.
AFRAME.registerComponent('cage-model', {
  init() {
    this.el.addEventListener('model-loaded', () => {
      const model = this.el.getObject3D('mesh')
      const m = CafeConfig.measureModel(AFRAME.THREE, model)
      model.position.y -= m.baseY
      this.mixer = CafeConfig.animate(AFRAME.THREE, model, model.animations)
      console.log(`[app] model ${m.height.toFixed(3)} tall, ${model.animations.length} clip(s)`)
      // Placement depends on the measured size.
      this.el.parentEl.components['qr-table-anchor'].place()
    })
  },
  // The first seconds after placement are the busiest (QR detection, locking,
  // first render of the model), so the animation waits ?animDelay= s (default 3).
  tick(time, dt) {
    if (!this.mixer || !this.el.object3D.parent.visible) return
    if (this.shownAt === undefined) this.shownAt = time
    if (time - this.shownAt < ANIM_DELAY_MS) return
    if (!this.started) {
      this.started = true
      console.log(`[app] animation started, ${((time - this.shownAt) / 1000).toFixed(1)} s after the cage appeared`)
    }
    this.mixer.update(dt / 1000)
  },
})

AFRAME.registerComponent('pixel-ratio-cap', {
  init() {
    const apply = () => {
      const r = this.el.renderer
      const want = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
      if (r && r.getPixelRatio() !== want) {
        r.setPixelRatio(want)
        this.el.resize()
      }
    }
    // A-Frame and 8th Wall both (re)size the canvas; re-apply after each.
    this.el.addEventListener('loaded', apply)
    this.el.addEventListener('realityready', apply)
    window.addEventListener('resize', () => setTimeout(apply, 0))
  },
})

AFRAME.registerComponent('qr-table-anchor', {
  init() {
    const {THREE} = AFRAME
    this.up = new THREE.Vector3(0, 1, 0)
    this.normal = new THREE.Vector3()
    this.tmpQuat = new THREE.Quaternion()
    this.goalPos = new THREE.Vector3()
    this.goalQuat = new THREE.Quaternion()
    this.goalScale = 1
    this.placed = false
    this.avgSide = 0
    this.rejected = 0
    this.last = null  // last accepted QR frame, to re-place when settings change
    this.accepted = 0
    this.locked = false
    this.hud = document.getElementById('hud')

    // Detection needs the QR to fill ≥ ~25% of the frame width (measured in sim/).
    this.banner = document.getElementById('offscreen-text')
    this.banner.textContent = 'Acercá el celular al QR'
    this.banner.style.display = 'block'

    this.el.object3D.visible = false
    const onImage = ({detail}) => {
      if (detail.name === TARGET_NAME) this.updateGoal(detail)
    }
    this.el.sceneEl.addEventListener('xrimagefound', onImage)
    this.el.sceneEl.addEventListener('xrimageupdated', onImage)

    // If SLAM loses the world, the cage's anchor can't be trusted: switch QR
    // recognition back on and re-place it from the next scan.
    this.el.sceneEl.addEventListener('xrtrackingstatus', ({detail}) => {
      if (!this.locked || detail.status === 'NORMAL') return
      this.locked = false
      this.accepted = 0
      enableQr(true)
      console.log(`[app] tracking ${detail.status} (${detail.reason}); QR recognition back on`)
    })

    cfgReady.then(() => {
      this.place()
      if (EDIT) {
        const box = document.getElementById('edit-panel')
        box.style.display = 'block'
        CafeConfig.panel(box, CFG, () => this.place(),
          ['cageCm', 'gapCm', 'xCm', 'rotDeg', 'qrCm'])
        const copy = document.createElement('button')
        copy.textContent = 'Copiar ajustes'
        copy.addEventListener('click', () => {
          const text = JSON.stringify(CFG)
          navigator.clipboard?.writeText(text).catch(() => {})
          copy.textContent = 'Copiado'
          setTimeout(() => { copy.textContent = 'Copiar ajustes' }, 1500)
        })
        box.appendChild(copy)
      }
    })
  },

  updateGoal(d) {
    if (this.locked) return
    const {THREE} = AFRAME
    const q = new THREE.Quaternion(d.rotation.x, d.rotation.y, d.rotation.z, d.rotation.w)
    const center = new THREE.Vector3(d.position.x, d.position.y, d.position.z)

    // The 3:4 crop spans the QR's full side along its long axis.
    const qrSideWorld = d.scale * Math.max(d.scaledWidth || 1, d.scaledHeight || 1)

    // Single bad frames happen (the simulator logged one at 1000x the true
    // size). Skip a size far off the running average, unless it persists.
    const ratio = this.avgSide ? qrSideWorld / this.avgSide : 1
    if (ratio > 1.5 || ratio < 0.67) {
      if (++this.rejected < 15) return
      this.avgSide = qrSideWorld  // it persisted, so it's real
    } else {
      this.avgSide = this.avgSide ? this.avgSide + (qrSideWorld - this.avgSide) * 0.2 : qrSideWorld
    }
    this.rejected = 0

    // Without SLAM the world isn't gravity-aligned (the engine treats the camera
    // as looking down), so on desktop "up" is the webcam's up instead.
    if (DESKTOP) {
      this.up.set(0, 1, 0).applyQuaternion(this.el.sceneEl.camera.getWorldQuaternion(this.tmpQuat))
    }

    // Normal projected onto the plane perpendicular to up.
    this.normal.set(0, 0, 1).applyQuaternion(q)
    this.normal.addScaledVector(this.up, -this.normal.dot(this.up))
    if (this.normal.lengthSq() < 1e-4) return  // QR lying flat: no heading
    this.normal.normalize()

    this.last = {center, q, qrSideWorld, d}
    this.place()

    // Once placement has settled, SLAM alone holds the cage in place, so stop
    // the engine searching for the QR in every frame (?track keeps it on).
    // Not when SLAM started badly (implausible floor): its scale is then off
    // too, and a cage held by SLAM alone slides as the phone moves.
    if (!KEEP_TRACKING && !DESKTOP && !(USE_FLOOR && this.floorOk === false) &&
        ++this.accepted === LOCK_AFTER_UPDATES) {
      enableQr(false)
      this.locked = true
      console.log('[app] cage locked; QR recognition off')
    }
  },

  // Recomputes the goal pose from the last QR frame and the current settings.
  place() {
    if (!this.last) return
    const {center, q, qrSideWorld, d} = this.last
    const k = qrSideWorld / (CFG.qrCm / 100)
    // 8th Wall's SLAM keeps a ground plane at y = 0; on a tabletop that is the
    // table. But it is guessed from what the camera saw at start: started close
    // to the bag (only its front in view) it put the QR 1.4 cm above the "floor"
    // instead of 10 (sim, 2 of 2 runs). So trust it only when it agrees with the
    // bag's configured QR height within 50-150%; otherwise use that height.
    const qrAboveFloor = center.y / k * 100
    const floorOk = USE_FLOOR &&
      qrAboveFloor > CFG.qrHeightCm * 0.5 && qrAboveFloor < CFG.qrHeightCm * 1.5
    if (floorOk !== this.floorOk) {
      this.floorOk = floorOk
      console.log(`[app] QR ${qrAboveFloor.toFixed(1)} cm above 8th Wall floor: ` +
        (floorOk ? 'using that floor' : `implausible, using qrHeightCm ${CFG.qrHeightCm}`))
    }
    const pose = CafeConfig.placeCage(AFRAME.THREE, {
      center, normal: this.normal, up: this.up, k, floorY: floorOk ? 0 : null,
    }, CFG, {onQr: DESKTOP})
    this.goalPos.copy(pose.position)
    this.goalQuat.copy(pose.quaternion)
    this.goalScale = pose.scale

    if (!this.placed) {
      const o = this.el.object3D
      o.position.copy(this.goalPos)
      o.quaternion.copy(this.goalQuat)
      o.scale.setScalar(0.001)
      o.visible = true
      this.placed = true
      this.banner.textContent = 'Alejate para ver la jaula'
    }

    if (DEBUG) {
      const {THREE} = AFRAME
      const marker = document.getElementById('qr-marker')
      marker.object3D.position.copy(center)
      marker.object3D.quaternion.copy(q)
      marker.object3D.scale.setScalar(qrSideWorld)
      marker.object3D.visible = true
      // The last line is live, in tick(): after locking there are no QR updates.
      this.hudBase =
        `scale ${d.scale.toFixed(3)}  sw ${(d.scaledWidth || 0).toFixed(3)}  ` +
        `sh ${(d.scaledHeight || 0).toFixed(3)}\nk ${k.toFixed(3)}  ` +
        `tilt ${(Math.asin(Math.min(1, Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(q).y))) * 57.3).toFixed(1)}°\n` +
        `QR above 8th Wall floor: ${qrAboveFloor.toFixed(1)} cm` +
        ` (${floorOk ? 'cage on floor' : `using ${CFG.qrHeightCm} cm`})`
    }
  },

  tick(time, dt) {
    // The debug readout is rewritten twice a second, not every frame: per-frame
    // DOM writes stopped QR detection in the sim (?debug at DPR 1, 3 of 3 runs).
    const hudDue = DEBUG && time - (this.hudAt || 0) > 500
    if (DEBUG) {
      // Smoothed over ~1 s, so it can be read on the phone.
      this.frameMs = this.frameMs ? this.frameMs + (dt - this.frameMs) * 0.05 : dt
      if (hudDue) {
        this.hudAt = time
        const pr = this.el.sceneEl.renderer.getPixelRatio()
        this.perfLine = `${(1000 / this.frameMs).toFixed(0)} fps (${this.frameMs.toFixed(0)} ms)` +
          ` · DPR ${pr}${DESKTOP ? ' · no SLAM' : ''}`
        if (!this.placed) this.hud.textContent = this.perfLine
      }
    }
    if (!this.placed) return
    const o = this.el.object3D
    o.position.lerp(this.goalPos, SMOOTHING)
    o.quaternion.slerp(this.goalQuat, SMOOTHING)
    o.scale.setScalar(AFRAME.THREE.MathUtils.lerp(o.scale.x, this.goalScale, SMOOTHING * 0.5))
    if (hudDue) {
      const ndc = this.goalPos.clone().project(this.el.sceneEl.camera)
      this.hud.textContent = `${this.perfLine}\n${this.hudBase}\n` +
        `cage on screen: ${Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1 ? 'yes' : 'NO'}` +
        ` (ndc ${ndc.x.toFixed(2)}, ${ndc.y.toFixed(2)})` +
        `\nQR recognition: ${this.locked ? 'off (cage locked)' : 'on'}`
    }
    this.updateOffscreenHint()
  },

  // The QR is scanned from ~20 cm, where the cage on the table below can be out
  // of frame. Point at it until the user steps back far enough to see it.
  updateOffscreenHint() {
    const hint = document.getElementById('offscreen')
    const p = this.goalPos.clone()
    p.y += CafeConfig.CAGE_MODEL.height / 2 * this.goalScale  // mid-height of the cage
    p.project(this.el.sceneEl.camera)
    let {x, y} = p
    if (p.z > 1) { x = -x; y = -y }  // behind the camera
    const onScreen = p.z < 1 && Math.abs(x) < 0.9 && Math.abs(y) < 0.9
    hint.style.display = onScreen ? 'none' : 'block'
    this.banner.style.display = hint.style.display
    if (onScreen) return
    const m = Math.max(Math.abs(x), Math.abs(y))
    const ex = x / m * 0.8
    const ey = y / m * 0.8
    hint.style.left = `${(ex + 1) * 50}%`
    hint.style.top = `${(1 - ey) * 50}%`
    hint.querySelector('.arrow').style.transform = `rotate(${Math.atan2(-y, x)}rad)`
  },
})
