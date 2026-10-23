// Places a miniature cage on the table in front of the bag, below the QR.
//
//   up      = world +Y (SLAM world is gravity-aligned), not the QR normal, so a
//             leaning bag doesn't tilt the cage
//   heading = QR normal projected onto the horizontal plane
//   floor   = 8th Wall's SLAM ground plane (y = 0)
//   scale   = QR's tracked size / its printed size, so sizes below are in metres
//
// Tunable from the URL: ?qr=6&s=0.3&x=0&z=auto
//   qr  printed side of the QR in cm, quiet zone included
//   s   cage size multiplier (1 = the model's real 36 cm)
//   x   sideways offset from QR centre to cage centre, cm (+ = viewer's right)
//   z   distance out from the bag's front to the cage centre, cm
//       (default: cage radius + 1 cm, so it doesn't clip into the bag)
//   h   height of the QR's centre above the table, cm; only used with ?floor=0
//       or ?desktop, where there is no SLAM floor
//
// ?desktop runs on a laptop webcam: no landing page, no SLAM, and by default the
// cage stands on the QR so it fits in a webcam's view.

const params = new URLSearchParams(location.search)
const DESKTOP = params.has('desktop')
const num = (key, fallback) => {
  const v = parseFloat(params.get(key))
  return Number.isFinite(v) ? v : fallback
}
const QR_SIDE_M = num('qr', 6) / 100
const QR_HEIGHT_M = num('h', DESKTOP ? 3 : 10) / 100
const SIDE_OFFSET_M = num('x', 0) / 100
const CAGE_SIZE = num('s', 0.3)
const CAGE_RADIUS_M = 0.12 * CAGE_SIZE  // from the model's bounds
const OUT_OFFSET_M = num('z', DESKTOP ? 0 : (CAGE_RADIUS_M + 0.01) * 100) / 100
const DEBUG = params.has('debug')
// ?floor=0 falls back to the ?h estimate. Desktop has no SLAM, hence no floor.
const USE_FLOOR = !DESKTOP && params.get('floor') !== '0'

const TARGET_NAME = 'qr-cafear'
const SMOOTHING = 0.25

fetch('image-targets/qr-cafear.json')
  .then(r => r.json())
  .then((target) => {
    const configure = () => XR8.XrController.configure({imageTargetData: [target]})
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

AFRAME.registerComponent('qr-table-anchor', {
  init() {
    const {THREE} = AFRAME
    this.up = new THREE.Vector3(0, 1, 0)
    this.normal = new THREE.Vector3()
    this.right = new THREE.Vector3()
    this.forward = new THREE.Vector3()
    this.basis = new THREE.Matrix4()
    this.tmpQuat = new THREE.Quaternion()
    this.goalPos = new THREE.Vector3()
    this.goalQuat = new THREE.Quaternion()
    this.goalScale = 1
    this.placed = false
    this.avgSide = 0
    this.rejected = 0
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
  },

  updateGoal(d) {
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
    const k = qrSideWorld / QR_SIDE_M

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
    this.right.crossVectors(this.normal, this.up).negate()  // (-n) x up

    this.goalPos.copy(center)
      .addScaledVector(this.right, SIDE_OFFSET_M * k)
      .addScaledVector(this.normal, OUT_OFFSET_M * k)
      .addScaledVector(this.up, -QR_HEIGHT_M * k)
    // 8th Wall's SLAM keeps a ground plane at y = 0, recomputed from stable
    // feature points; on a tabletop that is the table. Use it instead of ?h.
    if (USE_FLOOR) this.goalPos.y = 0

    // Model +Y along up, and +X (the door) towards the viewer.
    this.forward.crossVectors(this.normal, this.up)
    this.goalQuat.setFromRotationMatrix(this.basis.makeBasis(this.normal, this.up, this.forward))
    this.goalScale = k * CAGE_SIZE

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
      const marker = document.getElementById('qr-marker')
      marker.object3D.position.copy(center)
      marker.object3D.quaternion.copy(q)
      marker.object3D.scale.setScalar(qrSideWorld)
      marker.object3D.visible = true
      const cam = this.el.sceneEl.camera
      const ndc = this.goalPos.clone().project(cam)
      this.hud.textContent =
        `scale ${d.scale.toFixed(3)}  sw ${(d.scaledWidth || 0).toFixed(3)}  ` +
        `sh ${(d.scaledHeight || 0).toFixed(3)}\nk ${k.toFixed(3)}  ` +
        `tilt ${(Math.asin(Math.min(1, Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(q).y))) * 57.3).toFixed(1)}°\n` +
        `QR above 8th Wall floor: ${(center.y / k * 100).toFixed(1)} cm` +
        ` (${USE_FLOOR ? 'cage on floor' : `using h=${QR_HEIGHT_M * 100}`})\n` +
        `cage on screen: ${Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1 ? 'yes' : 'NO'}` +
        ` (ndc ${ndc.x.toFixed(2)}, ${ndc.y.toFixed(2)})`
    }
  },

  tick() {
    if (!this.placed) return
    const o = this.el.object3D
    o.position.lerp(this.goalPos, SMOOTHING)
    o.quaternion.slerp(this.goalQuat, SMOOTHING)
    o.scale.setScalar(AFRAME.THREE.MathUtils.lerp(o.scale.x, this.goalScale, SMOOTHING * 0.5))
    this.updateOffscreenHint()
  },

  // The QR is scanned from ~20 cm, where the cage on the table below can be out
  // of frame. Point at it until the user steps back far enough to see it.
  updateOffscreenHint() {
    const hint = document.getElementById('offscreen')
    const p = this.goalPos.clone()
    p.y += 0.18 * this.goalScale  // mid-height of the cage
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
