// Serves the site locally and lets editor.html save config.json.
//
// Usage: node tools/editor-server.mjs [port]   then open http://localhost:8790/editor.html
// Saving only writes the file; publishing is a normal commit + push.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2]) || 8790
const configPath = path.join(root, 'config.json')
const KEYS = Object.keys(JSON.parse(fs.readFileSync(configPath, 'utf8')))

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')

  if (req.method === 'POST' && url.pathname === '/api/config') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body)
        const clean = {}
        for (const k of KEYS) {
          if (!Number.isFinite(cfg[k])) throw new Error(`bad ${k}`)
          clean[k] = cfg[k]
        }
        fs.writeFileSync(configPath, `${JSON.stringify(clean, null, 2)}\n`)
        console.log('saved config.json', JSON.stringify(clean))
        res.writeHead(200).end('ok')
      } catch (e) {
        res.writeHead(400).end(String(e.message))
      }
    })
    return
  }

  const rel = decodeURIComponent(url.pathname)
  const file = path.join(root, rel.endsWith('/') ? `${rel}index.html` : rel)
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => {
  console.log(`editor: http://localhost:${port}/editor.html`)
})
