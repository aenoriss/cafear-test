// Places the cage on the (estimated) table beside the bag, from the QR's pose.
//
// The table is never detected. It is inferred:
//   up      = world +Y (SLAM world is gravity-aligned), not the QR normal, so a
//             leaning bag doesn't tilt the cage
//   heading = QR normal projected onto the horizontal plane
//   scale   = QR's tracked size / its printed size, so the model stays 1:1 in metres
//
// Tunable from the URL, all in cm: ?qr=6&h=10&x=22
//   qr  printed side of the QR, quiet zone included
//   h   height of the QR's centre above the table
//   x   sideways offset from QR centre to cage centre (+ = viewer's right)

const params = new URLSearchParams(location.search)
const cm = (key, fallback) => {
  const v = parseFloat(params.get(key))
  return (Number.isFinite(v) ? v : fallback) / 100
}
const QR_SIDE_M = cm('qr', 6)
const QR_HEIGHT_M = cm('h', 10)
const SIDE_OFFSET_M = cm('x', 22)
const DEBUG = params.has('debug')

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
    this.goalPos = new THREE.Vector3()
    this.goalQuat = new THREE.Quaternion()
    this.goalScale = 1
    this.placed = false
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
    const k = qrSideWorld / QR_SIDE_M

    this.normal.set(0, 0, 1).applyQuaternion(q)
    this.normal.y = 0
    if (this.normal.lengthSq() < 1e-4) return  // QR lying flat: no heading
    this.normal.normalize()
    this.right.crossVectors(this.normal, this.up).negate()  // (-n) x up

    this.goalPos.copy(center)
      .addScaledVector(this.right, SIDE_OFFSET_M * k)
    this.goalPos.y -= QR_HEIGHT_M * k

    // Door is on the model's +X; turn it towards the viewer.
    const yaw = Math.atan2(-this.normal.z, this.normal.x)
    this.goalQuat.setFromAxisAngle(this.up, yaw)
    this.goalScale = k

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

  // The QR is scanned from ~20 cm, where a cage 22 cm to the side is out of
  // frame. Point at it until the user steps back far enough to see it.
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
