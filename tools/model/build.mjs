// Turns the modeler's export into the app's model, in one command:
//   fix_lid -> fix_effects -> weld -> simplify (10%) -> resample
//   -> textures 1024 px JPEG, feathers recoloured to the sparrow's browns -> quantize
// Each fix skips itself when the export no longer has the problem.
//
// Usage (in webar/tools/model, once: npm install):
//   node build.mjs "C:\Users\...\Downloads\Prueba Animacion 4.glb" [out.glb]
// out defaults to webar/assets/jaula.glb. Needs python with Pillow on PATH.
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const [src, out = path.resolve(here, '../../assets/jaula.glb')] = process.argv.slice(2)
if (!src) {
  console.error('usage: node build.mjs <export.glb> [out.glb]')
  process.exit(1)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cafear-model-'))
const cli = path.join(here, 'node_modules/@gltf-transform/cli/bin/cli.js')
const run = (cmd, args) => execFileSync(cmd, args, {stdio: 'inherit'})
const node = (...args) => run(process.execPath, args)
let step = 0
const next = () => path.join(tmp, `${++step}.glb`)

let cur = path.resolve(src)
for (const [label, fn] of [
  ['laptop lid', (a, b) => node(path.join(here, 'fix_lid.mjs'), a, b)],
  ['effects', (a, b) => node(path.join(here, 'fix_effects.mjs'), a, b)],
  ['weld', (a, b) => node(cli, 'weld', a, b)],
  ['simplify', (a, b) => node(cli, 'simplify', a, b, '--ratio', '0.1', '--error', '0.005')],
  ['resample', (a, b) => node(cli, 'resample', a, b)],
  // Feathers: baked grey; black -> the sparrow's darkest 10%, white -> its lightest 10%.
  ['textures', (a, b) => run('python', [path.join(here, '../shrink_glb.py'), a, b, '--max', '1024', '--quality', '85',
    '--remap', '^BakedMaterial', '5d3216', 'c58555'])],
  ['quantize', (a, b) => node(cli, 'quantize', a, b)],
]) {
  const dst = next()
  console.log(`\n== ${label}`)
  fn(cur, dst)
  cur = dst
}
fs.copyFileSync(cur, out)
fs.rmSync(tmp, {recursive: true, force: true})
console.log(`\n${(fs.statSync(src).size / 1e6).toFixed(2)} MB -> ${(fs.statSync(out).size / 1e6).toFixed(2)} MB: ${out}`)
