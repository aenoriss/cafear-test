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
    deviceScaleFactor: 1,
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

  const url = new URL(query, base).toString()
  lines.push(`${stamp()} open ${url}`)
  await page.goto(url, {waitUntil: 'load'})

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
