// Virtual phone for the simulator, injected by run.mjs --virtual before the page loads.
//
// Replaces the camera with a three.js render of a synthetic scene in metres
// (table, wall, bag, the 6 cm QR 10 cm up the bag) seen by a phone camera that
// follows a scripted scan, and fires devicemotion/deviceorientation events
// computed from that same camera path, so 8th Wall's SLAM sees a consistent phone.
// With window.__VPHONE__ = {free: true} (run.mjs --free) you drive it instead.
(() => {
  const CFG = Object.assign({
    qrPath: 'image-targets/qr-cafear_original.png',
    qrSide: 0.06,      // printed QR side, quiet zone included
    qrCenterY: 0.10,   // QR centre above the table
    width: 480,
    height: 640,
    vfov: 62,          // portrait main camera of a typical phone
  }, window.__VPHONE__ || {})

  // Bag: 16 x 24 x 8 cm, standing on the table, front face at z = +4 cm.
  const BAG = {w: 0.16, h: 0.24, d: 0.08}
  const QR_Z = BAG.d / 2 + 0.0005

  // Scripted path: [t (s), camera position, look-at point, label].
  const QR = [0, CFG.qrCenterY, QR_Z]
  const FRAME = [0, 0.07, 0.07]  // bag front and the miniature cage below the QR
  const KEYS = [
    [0, [0.05, 0.28, 0.70], [0, 0.12, 0], 'lejos: el QR es chico'],
    [3, [0.05, 0.28, 0.70], [0, 0.12, 0], 'lejos: el QR es chico'],
    [7, [0.00, 0.12, 0.20], QR, 'acercando'],
    [11, [0.00, 0.12, 0.20], QR, 'escaneando de cerca'],
    [16, [0.06, 0.26, 0.45], FRAME, 'alejándose'],
    [22, [-0.20, 0.24, 0.40], FRAME, 'rodeando'],
    [28, [0.26, 0.22, 0.38], FRAME, 'rodeando'],
    [32, [0.26, 0.22, 0.38], FRAME, 'quieto'],
  ]
  const DURATION = KEYS[KEYS.length - 1][0]
  // Like a user waiting for the "Acercá" banner to go: hold in front of the QR
  // until 8th Wall has found it, then carry on with the path.
  const HOLD_UNTIL_FOUND = 11
  let qrFound = false
  const onFound = () => { qrFound = true }
  window.addEventListener('xrimagefound', onFound, true)
  document.addEventListener('xrimagefound', onFound, true)

  const ease = u => 0.5 - 0.5 * Math.cos(Math.PI * u)
  const lerp3 = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u)

  // Hand shake: a few millimetres and a fraction of a degree, smooth.
  const shake = (t) => {
    const s = (f, p) => Math.sin(2 * Math.PI * f * t + p)
    return {
      pos: [0.002 * s(0.9, 0) + 0.001 * s(2.3, 1), 0.002 * s(1.1, 2) + 0.001 * s(2.9, 3),
        0.0015 * s(0.7, 4)],
      look: [0.003 * s(0.6, 5), 0.003 * s(0.8, 6), 0],
    }
  }

  // t: position along the scripted path; ts: real time, for the hand shake.
  const sample = (t, ts = t) => {
    t = Math.min(Math.max(t, 0), DURATION)
    let i = 0
    while (i < KEYS.length - 2 && KEYS[i + 1][0] <= t) i++
    const [t0, p0, l0, label0] = KEYS[i]
    const [t1, p1, l1] = KEYS[i + 1]
    const u = t1 > t0 ? ease((t - t0) / (t1 - t0)) : 0
    const sh = shake(ts)
    return {
      pos: lerp3(p0, p1, u).map((v, k) => v + sh.pos[k]),
      look: lerp3(l0, l1, u).map((v, k) => v + sh.look[k]),
      label: label0,
    }
  }

  let THREE = null
  let renderer = null
  let scene = null
  let camera = null
  let tStart = null
  let prevQuat = null
  let prevNow = null
  let labelEl = null

  const noiseTexture = (w, h, draw) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    draw(c.getContext('2d'), w, h)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 8
    return tex
  }

  // Seeded RNG so every run sees the same scene.
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

  const buildScene = async () => {
    THREE = await import('https://cdn.jsdelivr.net/npm/three@0.158.0/build/three.module.js')
    const canvas = document.createElement('canvas')
    canvas.width = CFG.width
    canvas.height = CFG.height
    renderer = new THREE.WebGLRenderer({canvas, antialias: true, preserveDrawingBuffer: true})
    renderer.setPixelRatio(1)
    renderer.setSize(CFG.width, CFG.height, false)
    scene = new THREE.Scene()
    scene.background = new THREE.Color(0x6b6660)
    camera = new THREE.PerspectiveCamera(CFG.vfov, CFG.width / CFG.height, 0.01, 20)

    // Table: wood grain plus scattered marks, so SLAM has features to track.
    const tableTex = noiseTexture(2048, 2048, (g, w, h) => {
      g.fillStyle = '#8a6a4a'
      g.fillRect(0, 0, w, h)
      for (let i = 0; i < 900; i++) {
        g.strokeStyle = `rgba(${60 + rnd() * 60},${40 + rnd() * 40},${20 + rnd() * 30},${0.15 + rnd() * 0.3})`
        g.lineWidth = 1 + rnd() * 5
        const y = rnd() * h
        g.beginPath()
        g.moveTo(0, y)
        g.bezierCurveTo(w * 0.3, y + (rnd() - 0.5) * 60, w * 0.7, y + (rnd() - 0.5) * 60, w, y + (rnd() - 0.5) * 40)
        g.stroke()
      }
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = rnd() < 0.5 ? `rgba(30,20,10,${0.3 + rnd() * 0.5})` : `rgba(240,225,200,${0.3 + rnd() * 0.5})`
        g.beginPath()
        g.arc(rnd() * w, rnd() * h, 2 + rnd() * 9, 0, Math.PI * 2)
        g.fill()
      }
    })
    const table = new THREE.Mesh(new THREE.PlaneGeometry(3, 3),
      new THREE.MeshBasicMaterial({map: tableTex}))
    table.rotation.x = -Math.PI / 2
    scene.add(table)

    // Wall behind, with posters.
    const wallTex = noiseTexture(2048, 1024, (g, w, h) => {
      g.fillStyle = '#b9b2a6'
      g.fillRect(0, 0, w, h)
      for (let i = 0; i < 260; i++) {
        g.fillStyle = `hsl(${rnd() * 360},${30 + rnd() * 50}%,${25 + rnd() * 55}%)`
        g.fillRect(rnd() * w, rnd() * h, 10 + rnd() * 140, 10 + rnd() * 140)
      }
    })
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 2),
      new THREE.MeshBasicMaterial({map: wallTex}))
    wall.position.set(0, 1, -0.6)
    scene.add(wall)

    // Bag: matte black with a little printed text, sides slightly lighter.
    const frontTex = noiseTexture(512, 768, (g, w, h) => {
      g.fillStyle = '#141416'
      g.fillRect(0, 0, w, h)
      g.fillStyle = '#e8e8e8'
      g.font = 'bold 64px sans-serif'
      g.fillText('NOMAD', 40, 110)
      g.fillText('HUB', 40, 180)
      g.fillStyle = '#2ee6a6'
      g.font = 'bold 40px sans-serif'
      g.fillText('FUEL FOR NOMADS', 40, h - 60)
    })
    const side = new THREE.MeshBasicMaterial({color: 0x1c1c1f})
    const front = new THREE.MeshBasicMaterial({map: frontTex})
    const bag = new THREE.Mesh(new THREE.BoxGeometry(BAG.w, BAG.h, BAG.d),
      [side, side, new THREE.MeshBasicMaterial({color: 0x232326}), side, front, side])
    bag.position.set(0, BAG.h / 2, 0)
    scene.add(bag)

    const qrTex = await new THREE.TextureLoader().loadAsync(CFG.qrPath)
    qrTex.colorSpace = THREE.SRGBColorSpace
    const qr = new THREE.Mesh(new THREE.PlaneGeometry(CFG.qrSide, CFG.qrSide),
      new THREE.MeshBasicMaterial({map: qrTex}))
    qr.position.set(0, CFG.qrCenterY, QR_Z)
    scene.add(qr)

    return canvas
  }

  const poseAt = (t, ts = t) => {
    const s = sample(t, ts)
    const m = new THREE.Matrix4().lookAt(
      new THREE.Vector3(...s.pos), new THREE.Vector3(...s.look), new THREE.Vector3(0, 1, 0))
    return {pos: new THREE.Vector3(...s.pos), quat: new THREE.Quaternion().setFromRotationMatrix(m), label: s.label}
  }

  // three.js world (Y up, -Z "north") -> W3C earth frame (x east, y north, z up).
  const toEarth = () => new THREE.Matrix4().set(
    1, 0, 0, 0,
    0, 0, -1, 0,
    0, 1, 0, 0,
    0, 0, 0, 1)

  // Free roam (run.mjs --free): keyboard and mouse drive the phone instead of
  // the script. Velocity eases towards the keys' target, so motion stays smooth
  // enough for SLAM, and the IMU events below come from that same motion.
  //   W/S forward/back  A/D left/right  R/F up/down  arrows or drag: look
  //   Shift: faster     Alt: slower     Home: back to the start pose
  // 15 cm in front of the QR: close enough for 8th Wall to detect it.
  const FREE_START = CFG.start || {pos: [0, 0.11, 0.19], yaw: 0, pitch: -0.07}
  const free = CFG.free ? {
    keys: new Set(), drag: null,
    pos: [...FREE_START.pos], yaw: FREE_START.yaw, pitch: FREE_START.pitch,
    vel: [0, 0, 0], prevVel: [0, 0, 0],
  } : null
  if (free) {
    const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyF',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'Home']
    window.addEventListener('keydown', (e) => {
      if (!MOVE_KEYS.includes(e.code)) return
      e.preventDefault()
      if (e.code === 'Home') Object.assign(free, {pos: [...FREE_START.pos], yaw: FREE_START.yaw, pitch: FREE_START.pitch})
      free.keys.add(e.code)
    }, true)
    window.addEventListener('keyup', e => free.keys.delete(e.code), true)
    window.addEventListener('blur', () => free.keys.clear())
    // Pointer events cover both mouse and the emulated touch. A press that
    // doesn't move still reaches the page, so the record button works.
    window.addEventListener('pointerdown', (e) => { free.drag = [e.clientX, e.clientY] }, true)
    window.addEventListener('pointerup', () => { free.drag = null }, true)
    window.addEventListener('pointermove', (e) => {
      if (!free.drag) return
      free.yaw -= (e.clientX - free.drag[0]) * 0.005
      free.pitch -= (e.clientY - free.drag[1]) * 0.005
      free.drag = [e.clientX, e.clientY]
    }, true)
  }

  const stepFree = (dt) => {
    const k = free.keys
    const on = c => (k.has(c) ? 1 : 0)
    const turn = 1.2 * dt  // rad/s with the arrow keys
    free.yaw += (on('ArrowLeft') - on('ArrowRight')) * turn
    free.pitch += (on('ArrowUp') - on('ArrowDown')) * turn
    free.pitch = Math.max(-1.45, Math.min(1.45, free.pitch))

    const speed = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 0.6 : k.has('AltLeft') ? 0.05 : 0.2
    const f = on('KeyW') - on('KeyS')
    const r = on('KeyD') - on('KeyA')
    const u = on('KeyR') - on('KeyF')
    const sy = Math.sin(free.yaw)
    const cy = Math.cos(free.yaw)
    const target = [(-sy * f + cy * r) * speed, u * speed, (-cy * f - sy * r) * speed]
    const ease = 1 - Math.exp(-dt * 6)
    free.prevVel = [...free.vel]
    free.vel = free.vel.map((v, i) => v + (target[i] - v) * ease)
    free.pos = free.pos.map((p, i) => p + free.vel[i] * dt)
    free.pos[1] = Math.max(0.01, free.pos[1])  // not through the table
    return {
      pos: new THREE.Vector3(...free.pos),
      quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(free.pitch, free.yaw, 0, 'YXZ')),
      accel: new THREE.Vector3(...free.vel.map((v, i) => (v - free.prevVel[i]) / dt)),
    }
  }

  let pathT = 0
  const tick = (now) => {
    requestAnimationFrame(tick)
    const t = tStart === null ? 0 : (now - tStart) / 1000
    const dt = prevNow === null ? 1 / 60 : Math.max((now - prevNow) / 1000, 1e-3)
    let pose
    let a
    if (free) {
      pose = stepFree(Math.min(dt, 0.1))
      a = pose.accel
      if (labelEl) {
        const cm = v => (v * 100).toFixed(0)
        labelEl.textContent = `libre · ${cm(free.pos[0])}, ${cm(free.pos[1])}, ${cm(free.pos[2])} cm · ` +
          'WASD mover · R/F subir/bajar · arrastrar o flechas mirar · Shift rápido · Alt lento · Home inicio'
      }
    } else {
      const waiting = pathT >= HOLD_UNTIL_FOUND && !qrFound
      if (tStart !== null && prevNow !== null && !waiting) pathT += (now - prevNow) / 1000
      pose = poseAt(pathT, t)
      if (labelEl) {
        labelEl.textContent = `virtual phone ${t.toFixed(1)}s · ` +
          (waiting ? 'esperando que detecte el QR' : pose.label)
      }
      // Device frame == camera frame (x right, y up, z out of the screen).
      const h = 1 / 120
      const adv = waiting ? 0 : h  // the path is paused while waiting; shake isn't
      a = poseAt(pathT + adv, t + h).pos.add(poseAt(pathT - adv, t - h).pos)
        .addScaledVector(pose.pos, -2)
        .multiplyScalar(1 / (h * h))
    }
    camera.position.copy(pose.pos)
    camera.quaternion.copy(pose.quat)
    renderer.render(scene, camera)

    const inv = pose.quat.clone().invert()
    const accel = a.clone().applyQuaternion(inv)
    const accelG = a.clone().add(new THREE.Vector3(0, 9.81, 0)).applyQuaternion(inv)

    const rate = {alpha: 0, beta: 0, gamma: 0}
    if (prevQuat) {
      const dq = prevQuat.clone().invert().multiply(pose.quat)
      const angle = 2 * Math.acos(Math.min(1, Math.abs(dq.w)))
      const sgn = dq.w < 0 ? -1 : 1
      const sinHalf = Math.sqrt(Math.max(1 - dq.w * dq.w, 1e-12))
      const k = angle / dt * 180 / Math.PI * sgn / sinHalf
      rate.beta = dq.x * k
      rate.gamma = dq.y * k
      rate.alpha = dq.z * k
    }
    prevQuat = pose.quat.clone()
    prevNow = now

    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      acceleration: {x: accel.x, y: accel.y, z: accel.z},
      accelerationIncludingGravity: {x: accelG.x, y: accelG.y, z: accelG.z},
      rotationRate: rate,
      interval: dt * 1000,
    }))
    const e = new THREE.Euler().setFromRotationMatrix(
      toEarth().multiply(new THREE.Matrix4().makeRotationFromQuaternion(pose.quat)), 'ZXY')
    const deg = r => r * 180 / Math.PI
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
      alpha: (deg(e.z) + 360) % 360, beta: deg(e.x), gamma: deg(e.y), absolute: false,
    }))
  }

  const ready = buildScene().then((canvas) => {
    requestAnimationFrame(tick)
    return canvas
  })

  navigator.mediaDevices.getUserMedia = async (constraints) => {
    console.log(`[sim] getUserMedia ${JSON.stringify(constraints)} -> virtual phone`)
    const canvas = await ready
    if (tStart === null) tStart = performance.now()
    return canvas.captureStream(30)
  }

  window.addEventListener('DOMContentLoaded', () => {
    labelEl = document.createElement('div')
    labelEl.style.cssText = 'position:fixed;top:6px;left:6px;right:6px;z-index:99;font:11px monospace;' +
      'color:#ff0;background:rgba(0,0,0,.6);padding:3px 6px;pointer-events:none'
    document.body.appendChild(labelEl)
  })
})()
