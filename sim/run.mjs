// Desktop simulator for the WebAR page.
//
// Serves the site on localhost, opens it in Chrome emulating an Android phone,
// feeds a .y4m file as the camera, fakes a phone held still (device motion), and
// records every 8th Wall event plus periodic screenshots.
//
// Usage: node run.mjs [--feed out/feed.y4m] [--query "?debug"] [--seconds 25]
//                     [--virtual]              camera = virtual phone in a 3D scene
//                                              (virtual-phone.js), with matching IMU
//                     [--shot-every 5]         seconds between screenshots
//                     [--record 20]            at 20 s tap the record button, stop
//                                              5 s later, check the video file
//                     [--remote https://...]   test the deployed site instead
//                     [--headed]               show the browser window
//                     [--profile 16]           at 16 s, profile 10 s of tracking: CPU by
//                                              script, frame times, renderer, textures,
//                                              downloads -> out/profile.json, .cpuprofile
//                     [--dpr 2.625]            device pixel ratio (phones are 2-3)
//                     [--cpu-throttle 4]       slow the CPU down N times
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
const desktop = argv.includes('--desktop')  // laptop + webcam; pair with a --landscape feed
const virtual = argv.includes('--virtual')
const shotEvery = Number(opt('shot-every', 5))
const recordAt = opt('record', null)  // seconds in: tap record, 5 s later tap stop
const profileAt = opt('profile', null)
const dpr = Number(opt('dpr', 1))
const cpuThrottle = Number(opt('cpu-throttle', 1))
const PROFILE_SECONDS = 10

// Self time per script from a CDP CPU profile, in ms.
const summarizeProfile = (profile) => {
  const byId = new Map(profile.nodes.map(n => [n.id, n]))
  const self = new Map()
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i])
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000
    self.set(node, (self.get(node) || 0) + dt)
  }
  const bucket = (cf) => {
    const u = cf.url || ''
    if (!u) return cf.functionName.startsWith('(') ? cf.functionName : '(no url: virtual phone / inline)'
    if (u.includes('three@0.158.0')) return 'three.module.js (virtual phone only)'
    if (u.includes('engine-binary') || /\/xr[-\w]*\.js/.test(u)) return '8th Wall engine (xr.js)'
    if (u.includes('8frame')) return 'A-Frame (8frame)'
    if (u.includes('xrextras')) return 'xrextras'
    if (u.includes('landing-page')) return 'landing-page'
    return u.split('/').pop().split('?')[0]
  }
  const byScript = {}
  const byFn = {}
  let total = 0
  for (const [node, ms] of self) {
    const b = bucket(node.callFrame)
    byScript[b] = (byScript[b] || 0) + ms
    const fn = `${node.callFrame.functionName || '(anonymous)'} @ ${b}:${node.callFrame.lineNumber + 1}`
    byFn[fn] = (byFn[fn] || 0) + ms
    total += ms
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => ({what: k, ms: +v.toFixed(1), pct: +(100 * v / total).toFixed(1)}))
  return {totalMs: +total.toFixed(0), byScript: top(byScript, 15), topFunctions: top(byFn, 20)}
}

// Runs in the page: frame times, renderer stats and a texture inventory.
const measureInPage = async (ms) => {
  const scene = document.querySelector('a-scene')
  const r = scene.renderer
  const dts = []
  let last = performance.now()
  let running = true
  let calls = 0
  let triangles = 0
  const loop = (t) => {
    dts.push(t - last)
    last = t
    calls = Math.max(calls, r.info.render.calls)
    triangles = Math.max(triangles, r.info.render.triangles)
    if (running) requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  await new Promise(res => setTimeout(res, ms))
  running = false
  dts.shift()
  const sorted = [...dts].sort((a, b) => a - b)
  const pct = p => +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(1)

  const textures = new Map()
  scene.object3D.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      for (const [slot, t] of Object.entries(m)) {
        if (!t || !t.isTexture || !t.image) continue
        const img = t.image
        const w = img.width || img.videoWidth || 0
        const h = img.height || img.videoHeight || 0
        const key = t.uuid
        if (!textures.has(key)) {
          // RGBA8 plus a third for mipmaps.
          textures.set(key, {slot, name: t.name || m.name || o.name, w, h, mb: +(w * h * 4 * 4 / 3 / 1e6).toFixed(1)})
        }
      }
    }
  })
  if (scene.object3D.environment) {
    const img = scene.object3D.environment.image
    textures.set('env', {slot: 'environment', name: 'envmap', w: img.width, h: img.height,
      mb: +(img.width * img.height * 4 * 4 / 3 / 1e6).toFixed(1)})
  }
  const size = r.getDrawingBufferSize(new AFRAME.THREE.Vector2())
  return {
    frames: dts.length,
    fps: +(1000 * dts.length / dts.reduce((a, b) => a + b, 0)).toFixed(1),
    frameMs: {p50: pct(0.5), p95: pct(0.95), worst: +sorted[sorted.length - 1].toFixed(1)},
    longFrames: dts.filter(d => d > 50).length,
    renderer: {
      pixelRatio: r.getPixelRatio(), drawingBuffer: [size.x, size.y],
      megapixels: +(size.x * size.y / 1e6).toFixed(2),
      drawCalls: calls, triangles,
      geometries: r.info.memory.geometries, textures: r.info.memory.textures,
    },
    textures: [...textures.values()].sort((a, b) => b.mb - a.mb),
    jsHeapMb: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null,
  }
}

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
const initScript = ({desktop, virtual, headed}) => {
  const EVENTS = [
    'xrloaded', 'realityready', 'realityerror', 'camerastatuschange',
    'xrimageloading', 'xrimagescanning', 'xrimagefound', 'xrimagelost',
    'xrtrackingstatus',
    'mediarecorder-recordstart', 'mediarecorder-recordstop', 'mediarecorder-recorderror',
    'mediarecorder-previewready', 'mediarecorder-previewopened', 'mediarecorder-finalizeprogress',
  ]
  // The recorded file, so the runner can inspect it. On Android/desktop it
  // arrives with previewready; recordcomplete may come later, after export.
  // The recorder dispatches on window, not the document.
  for (const name of ['mediarecorder-previewready', 'mediarecorder-recordcomplete']) {
    window.addEventListener(name, (e) => {
      const b = e.detail && e.detail.videoBlob
      if (b) window.__lastVideo = b
      console.log(`[sim] ${name} blob ${b ? `${b.type} ${b.size} bytes` : 'none'}`)
    })
  }

  // Phones open the OS share sheet (WhatsApp, Instagram...) via navigator.share
  // with the file. The sim saves a copy to out/shared/; headed, it then opens
  // the Windows share sheet too; headless, there is none to open.
  const nativeShare = headed && navigator.share ? navigator.share.bind(navigator) : null
  const nativeCanShare = headed && navigator.canShare ? navigator.canShare.bind(navigator) : null
  navigator.canShare = data => (nativeCanShare ? nativeCanShare(data) : !!(data && data.files && data.files.length))
  navigator.share = async (data) => {
    const files = (data.files || []).map(f => ({name: f.name, type: f.type, size: f.size}))
    console.log(`[sim] navigator.share ${JSON.stringify({files, title: data.title, text: data.text})}`)
    const f = data.files && data.files[0]
    if (f) {
      window.__sharedFile = f
      const bytes = new Uint8Array(await f.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      await window.__simSave(f.name, btoa(bin))
    }
    if (nativeShare) return nativeShare(data)
  }
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

  // A phone held upright and still: gravity along device +Y. Laptops have no IMU,
  // and the virtual phone fires its own events.
  if (!desktop && !virtual) setInterval(() => {
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
  if (!virtual && !fs.existsSync(feed)) throw new Error(`no feed at ${feed}; run make_feed.py first`)

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
      ...(virtual ? [] : [`--use-file-for-fake-video-capture=${feed}`]),
      '--enable-unsafe-swiftshader',
      // A real camera stream may autoplay; the virtual phone's canvas stream may not.
      '--autoplay-policy=no-user-gesture-required',
      '--ignore-gpu-blocklist',
    ],
  })
  const context = await browser.newContext(desktop ? {
    viewport: {width: 640, height: 480},
    permissions: ['camera'],
  } : {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
    viewport: {width: 412, height: 549},  // 3:4, same as the feed, so nothing is cropped
    deviceScaleFactor: dpr,
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'accelerometer', 'gyroscope', 'magnetometer'],
  })
  await context.exposeFunction('__simSave', (name, b64) => {
    const dir = path.join(outDir, 'shared')
    fs.mkdirSync(dir, {recursive: true})
    const file = path.join(dir, path.basename(name))
    fs.writeFileSync(file, Buffer.from(b64, 'base64'))
    console.log(`shared file saved: ${file}`)
  })
  await context.addInitScript(initScript, {desktop, virtual, headed})
  if (virtual) {
    await context.addInitScript({path: path.join(here, 'virtual-phone.js')})
  }
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

  // Closing the headed window ends the session: keep the log, exit cleanly.
  page.on('close', () => {
    lines.push(`${stamp()} window closed`)
    fs.writeFileSync(path.join(outDir, 'console.log'), lines.join('\n'))
    console.log(`window closed; log in ${outDir}`)
    server?.close()
    process.exit(0)
  })

  const downloads = []
  page.on('requestfinished', async (req) => {
    try {
      const s = await req.sizes()
      downloads.push({url: req.url(), kb: Math.round(s.responseBodySize / 1024), at: stamp()})
    } catch {}
  })
  const cdp = await context.newCDPSession(page)
  if (cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', {rate: cpuThrottle})

  const url = new URL(query, base).toString()
  lines.push(`${stamp()} open ${url}`)
  await page.goto(url, {waitUntil: 'load'})

  if (profileAt !== null) {
    await page.waitForTimeout(Number(profileAt) * 1000)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', {interval: 500})
    await cdp.send('Profiler.start')
    const inPage = await page.evaluate(measureInPage, PROFILE_SECONDS * 1000)
    const {profile} = await cdp.send('Profiler.stop')
    fs.writeFileSync(path.join(outDir, 'profile.cpuprofile'), JSON.stringify(profile))
    await page.screenshot({path: path.join(outDir, 'profile_view.png')})

    const when = re => lines.find(l => re.test(l))?.trim().split(/\s+/)[0] || null
    const report = {
      setup: {dpr, cpuThrottle, headed, url},
      timeline: {realityready: when(/\[sim\] realityready/), qrFound: when(/\[sim\] xrimagefound/)},
      ...inPage,
      cpu: summarizeProfile(profile),
      downloads: {
        totalKb: downloads.reduce((a, d) => a + d.kb, 0),
        largest: downloads.sort((a, b) => b.kb - a.kb).slice(0, 12)
          .map(d => ({kb: d.kb, url: d.url.replace(/^https?:\/\/[^/]+/, ''), at: d.at})),
      },
    }
    fs.writeFileSync(path.join(outDir, 'profile.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(outDir, 'console.log'), lines.join('\n'))
    console.log(JSON.stringify(report, null, 2))
    await browser.close()
    server?.close()
    return
  }

  for (let s = shotEvery; s <= seconds; s += shotEvery) {
    await page.waitForTimeout(shotEvery * 1000)
    await page.screenshot({path: path.join(outDir, `shot_${String(s).padStart(2, '0')}s.png`)})
    const hud = await page.evaluate(() => document.getElementById('hud')?.textContent || '')
    lines.push(`${stamp()} HUD ${hud.replace(/\n/g, ' | ')}`)
  }

  if (recordAt !== null) {
    const shot = name => page.screenshot({path: path.join(outDir, `rec_${name}.png`)})
    const button = page.locator('#recorder-button')
    await shot('0_before')
    await button.tap()
    lines.push(`${stamp()} SIM tapped record`)
    await page.waitForTimeout(2500)
    await shot('1_recording')
    await page.waitForTimeout(2500)
    await button.tap()
    lines.push(`${stamp()} SIM tapped stop`)
    await page.waitForTimeout(8000)
    await shot('2_preview')

    // Tap the preview's share button, as a user would to send it to WhatsApp/IG.
    const share = page.locator('#actionButton')
    if (await share.count()) {
      lines.push(`${stamp()} SIM share button: "${(await share.innerText()).trim()}"`)
      await share.tap()
      await page.waitForTimeout(3000)
      await shot('3_after_share')
    } else {
      lines.push(`${stamp()} SIM no #actionButton in preview`)
    }
    const video = await page.evaluate(async () => {
      const b = window.__sharedFile || window.__lastVideo
      if (!b) return null
      const v = document.createElement('video')
      v.muted = true
      v.src = URL.createObjectURL(b)
      await new Promise((res) => {
        v.onloadedmetadata = res
        v.onerror = res
        setTimeout(res, 5000)
      })
      // WebM from MediaRecorder reports Infinity until seeked to the end.
      if (v.duration === Infinity) {
        v.currentTime = 1e9
        await new Promise((res) => { v.ontimeupdate = res; setTimeout(res, 3000) })
      }
      // A frame from the middle of the clip, to see what was actually recorded.
      const duration = v.duration
      v.currentTime = Math.min(duration, 1e3) / 2
      await new Promise((res) => { v.onseeked = res; setTimeout(res, 3000) })
      const c = document.createElement('canvas')
      c.width = v.videoWidth
      c.height = v.videoHeight
      c.getContext('2d').drawImage(v, 0, 0)
      const frame = c.toDataURL('image/png').split(',')[1]
      const bytes = new Uint8Array(await b.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return {type: b.type, size: b.size, duration, w: v.videoWidth, h: v.videoHeight, b64: btoa(bin), frame}
    })
    if (video) {
      const ext = video.type.includes('mp4') ? 'mp4' : 'webm'
      fs.writeFileSync(path.join(outDir, `recording.${ext}`), Buffer.from(video.b64, 'base64'))
      fs.writeFileSync(path.join(outDir, 'rec_frame.png'), Buffer.from(video.frame, 'base64'))
      delete video.b64
      delete video.frame
    }
    lines.push(`${stamp()} VIDEO ${JSON.stringify(video)}`)
    console.log('video:', JSON.stringify(video))
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
      // Any animated door: its rotation, sampled twice to show whether it moves.
      door: (() => {
        const d = document.querySelector('a-scene').object3D.getObjectByName('Puerta')
        return d && d.quaternion.toArray().map(v => +v.toFixed(3))
      })(),
      videos: [...document.querySelectorAll('video')].map(v => ({
        readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, paused: v.paused,
        muted: v.muted, autoplay: v.autoplay, connected: v.isConnected,
      })),
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
