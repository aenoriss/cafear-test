// Usage: node fix_effects.mjs <in.glb> <out.glb>
//
// - Jaula Rayos (cage lightning): its last key leaves it at scale 0.111, and the
//   app holds each clip's last frame, so it never switched off. Adds a key at
//   scale 0 one frame later.
// - Drops both capsule debris groups: 'Jaul Explota' (static, always visible: the
//   white egg) and 'Capsula Explota' (its 56 pieces sit at scale 0 and are never
//   animated, so it never shows). The app draws the explosion as sparks instead.
import {NodeIO} from '@gltf-transform/core'
import {ALL_EXTENSIONS} from '@gltf-transform/extensions'
import {prune} from '@gltf-transform/functions'

const [src, dst] = process.argv.slice(2)
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(src)
const root = doc.getRoot()
const buffer = root.listBuffers()[0]

let lightningOff = null
for (const anim of root.listAnimations()) {
  for (const ch of anim.listChannels()) {
    if (ch.getTargetNode()?.getName() !== 'Jaula Rayos' || ch.getTargetPath() !== 'scale') continue
    const s = ch.getSampler(), tin = s.getInput().getArray(), out = s.getOutput().getArray()
    if (out.slice(-3).every(v => v === 0)) continue
    const t = tin[tin.length - 1] + 1 / 30
    s.setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array([...tin, t])).setBuffer(buffer))
    s.setOutput(doc.createAccessor().setType('VEC3').setArray(new Float32Array([...out, 0, 0, 0])).setBuffer(buffer))
    lightningOff = t
  }
}

const dropped = []
for (const name of ['Jaul Explota', 'Capsula Explota']) {
  const node = root.listNodes().find(n => n.getName() === name)
  if (!node) continue
  const doomed = new Set([node, ...collect(node)])
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) if (doomed.has(ch.getTargetNode())) ch.dispose()
    if (!anim.listChannels().length) anim.dispose()
  }
  for (const n of doomed) n.dispose()
  dropped.push(`${name} (${doomed.size} nodes)`)
}
function collect(n) { return n.listChildren().flatMap(c => [c, ...collect(c)]) }

await doc.transform(prune())
await io.write(dst, doc)
console.log(`lightning: ${lightningOff === null ? 'already ends off (or absent), skipped' : `off at ${lightningOff.toFixed(2)} s`}; ` +
  `dropped ${dropped.join(', ') || 'nothing'}; ` +
  `${root.listAnimations().length} animations, ${root.listMeshes().length} meshes`)
