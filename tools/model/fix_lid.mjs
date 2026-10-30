// Usage: node fix_lid.mjs <in.glb> <out.glb>
//
// The laptop lid is parented to a base scaled (0.35, 0.0073, 0.32), and hinges
// about X inside that scaled space: a shear, which TRS can't hold, so the
// exporter wrote rotation 141.8 deg + scale z 40 (a long flat bar).
//
// The lid mesh is modelled in the base's units, so the intended lid is the base's
// scale S0 with a rigid rotation Rx(phi) about its hinge. The exported local matrix
// was S0^-1 Rx(phi) S0, whose depth column has length L = sqrt((r sin phi)^2 + cos^2 phi),
// r = S0z / S0y; solving for phi recovers the hinge angle (about 114 deg, open).
//
// Rebuild: a pivot node with the base's translation and rotation and a uniform
// scale k(t) = base scale / S0 (the base's shrink is proportional), carrying the
// lid with T = S0 * old T, S = S0, R = Rx(phi(t)). No shear anywhere.
import {NodeIO} from '@gltf-transform/core'
import {ALL_EXTENSIONS} from '@gltf-transform/extensions'

const [src, dst] = process.argv.slice(2)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(src)
const root = doc.getRoot()
const byName = n => root.listNodes().find(x => x.getName() === n)
const base = byName('macBook_BottomPart.001')
const lid = byName('macBook_TopPart.001')
const S0 = base?.getScale()
// Skip (copy through) once the modeler applies the base's scale, or renames things.
if (!base || !lid || lid.getParentNode() !== base || Math.max(...S0) / Math.min(...S0) < 1.01) {
  await io.write(dst, doc)
  console.log('laptop lid: no sheared lid under a non-uniformly scaled base, skipped')
  process.exit(0)
}

const r = S0[2] / S0[1]
const phiFromDepth = L => Math.PI - Math.asin(Math.sqrt(Math.min(1, Math.max(0, (L * L - 1) / (r * r - 1)))))
const quatX = phi => [Math.sin(phi / 2), 0, 0, Math.cos(phi / 2)]
const buffer = root.listBuffers()[0]
const accessor = (type, arr) => doc.createAccessor().setType(type).setArray(new Float32Array(arr)).setBuffer(buffer)

const pivot = doc.createNode('macBook_Pivot').setTranslation(base.getTranslation()).setRotation(base.getRotation())
const scene = root.listScenes().find(s => s.listChildren().includes(base))
if (!scene) throw new Error('base is not a scene root node')
scene.addChild(pivot)
base.removeChild(lid)
pivot.addChild(lid)

const t0 = lid.getTranslation()
const phiRest = phiFromDepth(lid.getScale()[2])
lid.setTranslation([S0[0] * t0[0], S0[1] * t0[1], S0[2] * t0[2]]).setScale(S0).setRotation(quatX(phiRest))

let maxSkew = 0
const phis = []
for (const anim of root.listAnimations()) {
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode(), path = ch.getTargetPath(), smp = ch.getSampler()
    if (node === base) {
      if (path === 'scale') {
        const out = smp.getOutput().getArray(), k = []
        for (let i = 0; i < out.length; i += 3) {
          const ks = [out[i] / S0[0], out[i + 1] / S0[1], out[i + 2] / S0[2]]
          const m = (ks[0] + ks[1] + ks[2]) / 3
          maxSkew = Math.max(maxSkew, ...ks.map(v => Math.abs(v - m)))
          k.push(m, m, m)
        }
        const s2 = doc.createAnimationSampler().setInput(smp.getInput()).setOutput(accessor('VEC3', k)).setInterpolation(smp.getInterpolation())
        anim.addSampler(s2).addChannel(doc.createAnimationChannel().setTargetNode(pivot).setTargetPath('scale').setSampler(s2))
      } else {
        anim.addChannel(doc.createAnimationChannel().setTargetNode(pivot).setTargetPath(path).setSampler(smp))
      }
    }
  }
  const lidCh = anim.listChannels().filter(c => c.getTargetNode() === lid)
  const sc = lidCh.find(c => c.getTargetPath() === 'scale'), rot = lidCh.find(c => c.getTargetPath() === 'rotation')
  if (sc && rot) {
    const sIn = sc.getSampler().getInput().getArray(), sOut = sc.getSampler().getOutput().getArray()
    const phiAt = t => {
      let i = 0
      while (i < sIn.length - 1 && sIn[i + 1] < t) i++
      const j = Math.min(i + 1, sIn.length - 1), a = sIn[i], b = sIn[j]
      const u = b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0
      return phiFromDepth(sOut[i * 3 + 2] * (1 - u) + sOut[j * 3 + 2] * u)
    }
    const rIn = rot.getSampler().getInput().getArray(), q = []
    for (const t of rIn) { const p = phiAt(t); phis.push(p); q.push(...quatX(p)) }
    rot.getSampler().setOutput(accessor('VEC4', q))
    const dead = sc.getSampler()
    sc.dispose()
    if (!dead.listParents().some(p => p.propertyType === 'AnimationChannel')) dead.dispose()
  }
}

await io.write(dst, doc)
const deg = v => (v * 180 / Math.PI).toFixed(1)
console.log(`lid hinge rest ${deg(phiRest)} deg, animated ${phis.length ? deg(Math.min(...phis)) + '-' + deg(Math.max(...phis)) : 'none'} deg; base shrink max deviation from uniform ${maxSkew.toFixed(4)}`)
