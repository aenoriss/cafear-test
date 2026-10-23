// Desktop simulator for the WebAR page.
//
// Serves the site on localhost, opens it in Chrome emulating an Android phone,
// feeds a .y4m file as the camera, fakes a phone held still (device motion), and
// records every 8th Wall event plus periodic screenshots.
//
// Usage: node run.mjs [--feed out/feed.y4m] [--query "?debug"] [--seconds 25]
//                     [--remote https://...]   test the deployed site instead
//                     [--headed]               show the browser window
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const siteRoot = path.resolve(here, '..')
const outDir = path.join(here, 'out')

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i < 0 ? fallback : argv[i + 1]
}
const feed = path.resolve(here, opt('feed', 'out/feed.y4m'))
const query = opt('query', '?debug')
const seconds = Number(opt('seconds', 25))
const remote = opt('remote', null)
const headed = argv.includes('--headed')

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary',
}

const serve = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = path.join(siteRoot, rel.endsWith('/') ? `${rel}index.html` : rel)
    if (!file.startsWith(siteRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream'})
    fs.createReadStream(file).pipe(res)
  })
  server.listen(0, '127.0.0.1', () => resolve(server))
})

// Runs in the page before any of its scripts.
const initScript = () => {
  const EVENTS = [
    'xrloaded', 'realityready', 'realityerror', 'camerastatuschange',
    'xrimageloading', 'xrimagescanning', 'xrimagefound', 'xrimagelost',
    'xrtrackingstatus',
  ]
  const log = (name, detail) => {
    let s
    try { s = JSON.stringify(detail) } catch { s = String(detail) }
    console.log(`[sim] ${name} ${s && s.length > 400 ? `${s.slice(0, 400)}…` : s}`)
  }
  for (const name of EVENTS) {
    window.addEventListener(name, e => log(name, e.detail), true)
    document.addEventListener(name, e => log(name, e.detail), true)
  }
  let updates = 0
  document.addEventListener('xrimageupdated', (e) => {
    if (updates++ % 30 === 0) log('xrimageupdated#' + updates, e.detail)
  }, true)

  // The fake webcam has no facing mode, so a rear-camera request would fail.
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = (c) => {
    console.log(`[sim] getUserMedia ${JSON.stringify(c)}`)
    if (c && typeof c.video === 'object') delete c.video.facingMode
    return gum(c)
  }

  // A phone held upright and still: gravity along device +Y.
  setInterval(() => {
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      acceleration: {x: 0, y: 0, z: 0},
      accelerationIncludingGravity: {x: 0, y: 9.81, z: 0},
      rotationRate: {alpha: 0, beta: 0, gamma: 0},
      interval: 16,
    }))
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
      alpha: 0, beta: 90, gamma: 0, absolute: false,
    }))
  }, 16)
}

const main = async () => {
  fs.mkdirSync(outDir, {recursive: true})
  if (!fs.existsSync(feed)) throw new Error(`no feed at ${feed}; run make_feed.py first`)

  let server = null
  let base = remote
  if (!base) {
    server = await serve()
    base = `http://127.0.0.1:${server.address().port}/`
  }

  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: !headed,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${feed}`,
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
    viewport: {width: 412, height: 549},  // 3:4, same as the feed, so nothing is cropped
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'accelerometer', 'gyroscope', 'magnetometer'],
  })
  await context.addInitScript(initScript)
  const page = await context.newPage()

  const lines = []
  const t0 = Date.now()
  const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`
  page.on('console', m => lines.push(`${stamp()} ${m.type().padEnd(7)} ${m.text()}`))
  page.on('pageerror', e => lines.push(`${stamp()} PAGEERR ${e.message}`))
  page.on('requestfailed', r => lines.push(`${stamp()} REQFAIL ${r.url()} ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    if (r.status() >= 400) lines.push(`${stamp()} HTTP${r.status()} ${r.url()}`)
  })

  const url = new URL(query, base).toString()
  lines.push(`${stamp()} open ${url}`)
  await page.goto(url, {waitUntil: 'load'})

  for (let s = 0; s < seconds; s += 5) {
    await page.waitForTimeout(5000)
    await page.screenshot({path: path.join(outDir, `shot_${String(s + 5).padStart(2, '0')}s.png`)})
  }

  const state = await page.evaluate(() => {
    const anchor = document.querySelector('[qr-table-anchor]')
    const o = anchor?.object3D
    return {
      xr8: !!window.XR8,
      hud: document.getElementById('hud')?.textContent,
      cageVisible: o?.visible,
      cagePos: o && [o.position.x, o.position.y, o.position.z].map(v => +v.toFixed(3)),
      cageScale: o && +o.scale.x.toFixed(3),
      bodyText: document.body.innerText.slice(0, 300),
    }
  })
  lines.push(`${stamp()} STATE ${JSON.stringify(state)}`)

  fs.writeFileSync(path.join(outDir, 'console.log'), lines.join('\n'))
  const counts = {}
  for (const l of lines) {
    const m = l.match(/\[sim\] (\w+)/)
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1
  }
  console.log('events:', JSON.stringify(counts))
  console.log('state:', JSON.stringify(state))
  console.log(`log + screenshots in ${outDir}`)

  await browser.close()
  server?.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
