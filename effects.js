// Effects the GLB can't carry, rebuilt on the loaded model. glTF has no
// view-angle transparency, additive blending, glow or particles, so the
// modeler's Blender looks arrive as plain white emission.
// - Holo* materials (rings, plasma balls and rays, cage lightning): an additive
//   hologram shader, brighter where the surface turns away from the camera.
// - Soft halos on the plasma balls and the lightning, a cheap stand-in for bloom
//   (a full-screen bloom pass is too heavy next to 8th Wall on a phone).
// - Sparks where the capsule body vanishes (storyboard frame 5).
// install() returns {update(seconds)}; call it every frame after the mixer.
window.CafeEffects = (() => {
  const GREEN = '#2ee6a6'

  // Picked by the nearest named ancestor; names as three.js sanitises them.
  const PRESETS = [
    {match: /jaula.?rayos/i, base: 0.45, power: 1.0, intensity: 2.2, flicker: 0.6, halo: 0.3},
    {match: /plasma.?ball/i, base: 0.04, power: 2.5, intensity: 1.8, flicker: 0, halo: 0.55},
    {match: /rayos.?plasma|sweep/i, base: 0.15, power: 1.5, intensity: 1.6, flicker: 0.25, halo: 0},
    {match: /anillos|torus/i, base: 0.3, power: 2.0, intensity: 1.3, flicker: 0, halo: 0},
  ]
  const DEFAULT_PRESET = PRESETS[3]

  const presetFor = (o) => {
    for (let p = o; p; p = p.parent) {
      const hit = PRESETS.find(s => s.match.test(p.name))
      if (hit) return hit
    }
    return DEFAULT_PRESET
  }

  const holoMaterial = (THREE, preset) => new THREE.ShaderMaterial({
    uniforms: {
      uColor: {value: new THREE.Color(GREEN)},
      uBase: {value: preset.base},
      uPower: {value: preset.power},
      uIntensity: {value: preset.intensity},
      uFlicker: {value: preset.flicker},
      uTime: {value: 0},
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalMatrix * normal;
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uBase, uPower, uIntensity, uFlicker, uTime;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vView)));
        float a = uBase + (1.0 - uBase) * pow(1.0 - facing, uPower);
        a *= 1.0 - uFlicker * (0.5 + 0.5 * sin(uTime * 47.0 + 3.0 * sin(uTime * 13.0)));
        gl_FragColor = vec4(uColor * uIntensity, a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  })

  const haloTexture = (THREE) => {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.35, 'rgba(255,255,255,0.35)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
    const tex = new THREE.CanvasTexture(c)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  // Each particle flies out along its own direction, eased, with a little
  // gravity, and fades from white-hot to green. Positions are in the model's
  // units; the point size follows the model's world scale.
  const sparks = (THREE, count) => {
    const dir = new Float32Array(count * 3)
    const seed = new Float32Array(count)
    const v = new THREE.Vector3()
    for (let i = 0; i < count; i++) {
      v.randomDirection().multiplyScalar(0.35 + 0.65 * Math.random())
      v.y = Math.abs(v.y) * 0.8 + 0.1
      v.toArray(dir, i * 3)
      seed[i] = Math.random()
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3))
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uT: {value: -1},
        uLife: {value: 1.3},
        uSpread: {value: 1},
        uSize: {value: 0.05},
        uViewH: {value: 1000},
        uColor: {value: new THREE.Color(GREEN)},
      },
      vertexShader: `
        attribute vec3 aDir;
        attribute float aSeed;
        uniform float uT, uLife, uSpread, uSize, uViewH;
        varying float vFade;
        varying float vHot;
        void main() {
          float life = uLife * (0.55 + 0.45 * aSeed);
          float k = clamp(uT / life, 0.0, 1.0);
          float ease = 1.0 - pow(1.0 - k, 3.0);
          vec3 p = position + aDir * uSpread * (0.1 + ease) - vec3(0.0, 0.4 * uSpread * k * k, 0.0);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float toView = length(modelViewMatrix[0].xyz);
          gl_PointSize = uSize * (0.6 + 0.8 * aSeed) * toView * projectionMatrix[1][1] * 0.5 * uViewH / max(-mv.z, 1e-4);
          vFade = (uT < 0.0 || k >= 1.0) ? 0.0 : 1.0 - k;
          vHot = 1.0 - k;
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vFade;
        varying float vHot;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5 || vFade <= 0.0) discard;
          float a = smoothstep(0.5, 0.0, d) * vFade;
          gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.7 * vHot * vHot), a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(geo, mat)
    points.frustumCulled = false
    const size = new THREE.Vector2()
    points.onBeforeRender = (renderer) => { mat.uniforms.uViewH.value = renderer.getDrawingBufferSize(size).y }
    return points
  }

  const install = (THREE, model, {sparkCount = 220} = {}) => {
    const holo = []
    const halos = []
    const tex = haloTexture(THREE)
    model.traverse((o) => {
      if (!o.isMesh || !/^holo/i.test([].concat(o.material)[0]?.name || '')) return
      const preset = presetFor(o)
      o.material = holoMaterial(THREE, preset)
      holo.push(o.material)
      if (preset.halo) {
        o.geometry.computeBoundingSphere()
        const {center, radius} = o.geometry.boundingSphere
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
          map: tex, color: GREEN, transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending, opacity: preset.halo,
        }))
        s.position.copy(center)
        s.scale.setScalar(radius * 3.2)
        o.add(s)
        halos.push({sprite: s, preset})
      }
    })

    const body = model.getObjectByName('Capsula_Cuerpo')
    const burst = sparks(THREE, sparkCount)
    model.add(burst)
    const box = new THREE.Box3()
    const centre = new THREE.Vector3()
    const scale = new THREE.Vector3()
    let wasVisible = false
    let lastCentre = null
    let lastSpread = 1
    let time = 0
    let since = -1

    return {
      update(dt) {
        time += dt
        for (const m of holo) m.uniforms.uTime.value = time
        for (const {sprite, preset} of halos) {
          sprite.material.opacity = preset.halo *
            (1 - preset.flicker * (0.5 + 0.5 * Math.sin(time * 47 + 3 * Math.sin(time * 13))))
        }
        if (body) {
          body.updateWorldMatrix(true, false)
          const visible = Math.abs(body.matrixWorld.determinant()) > 1e-15
          if (visible) {
            box.setFromObject(body)
            lastCentre = model.worldToLocal(box.getCenter(centre).clone())
            model.getWorldScale(scale)
            lastSpread = Math.max(...box.getSize(centre).toArray()) / scale.x * 1.3
          } else if (wasVisible && lastCentre) {
            burst.position.copy(lastCentre)
            burst.material.uniforms.uSpread.value = lastSpread
            burst.material.uniforms.uSize.value = lastSpread * 0.045
            since = 0
          }
          wasVisible = visible
        }
        if (since >= 0) {
          since += dt
          burst.material.uniforms.uT.value = since
          if (since > burst.material.uniforms.uLife.value) since = -1
        } else {
          burst.material.uniforms.uT.value = -1
        }
      },
    }
  }

  return {install}
})()
