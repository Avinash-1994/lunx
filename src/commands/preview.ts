import http from 'http'
import fs from 'fs'
import path from 'path'
import { anyHost, resolveBindHost } from '../utils/host.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.txt':  'text/plain',
  '.xml':  'application/xml',
  '.wasm': 'application/wasm',
  '.map':  'application/json',
}

export interface PreviewOptions {
  port?: number
  host?: string
  base?: string
  outDir?: string
  https?: boolean
  open?: boolean
}

function getMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

async function openUrl(url: string): Promise<void> {
  const platform = process.platform
  let cmd: string
  let args: string[]

  if (platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else if (platform === 'win32') {
    cmd = 'cmd'
    args = ['/c', 'start', '""', url]
  } else {
    cmd = 'xdg-open'
    args = [url]
  }

  try {
    const { spawn } = await import('child_process')
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.unref()
  } catch (error) {
    console.warn(`Could not open browser automatically: ${(error as Error).message}`)
  }
}

function serveFile(
  filePath: string,
  res: http.ServerResponse,
  statusCode = 200
): void {
  try {
    const stat = fs.statSync(filePath)
    const mime = getMime(filePath)
    const content = fs.readFileSync(filePath)

    res.writeHead(statusCode, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': filePath.endsWith('.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(content)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
  }
}

export async function preview(options: PreviewOptions = {}): Promise<void> {
  const {
    port = 4173,
    host = 'localhost',
    base = '/',
    outDir = 'build_output',
    open = false,
  } = options

  const distDir = path.resolve(process.cwd(), outDir)

  // Guard: dist must exist
  if (!fs.existsSync(distDir)) {
    console.error(`\n  ❌ No "${outDir}" folder found.`)
    console.error(`  Run \`lunx build\` first.\n`)
    process.exit(1)
  }

  const indexHtml = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexHtml)) {
    console.error(`\n  ❌ No index.html in "${outDir}".`)
    console.error(`  Make sure your build produced an index.html.\n`)
    process.exit(1)
  }

  const requestHandler = (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void => {
    const rawUrl = req.url ?? '/'
    // Strip base prefix
    const urlPath = rawUrl.startsWith(base)
      ? rawUrl.slice(base.length) || '/'
      : rawUrl

    // Decode URI safely
    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(urlPath)
    } catch {
      res.writeHead(400)
      res.end('Bad request')
      return
    }

    // Remove query string
    const cleanPath = decodedPath.split('?')[0]

    // Security: prevent path traversal
    const resolved = path.resolve(distDir, '.' + cleanPath)
    if (!resolved.startsWith(distDir)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    // Try the exact path
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      serveFile(resolved, res)
      return
    }

    // Try with .html appended
    const withHtml = resolved + '.html'
    if (fs.existsSync(withHtml)) {
      serveFile(withHtml, res)
      return
    }

    // Try index.html inside directory
    const indexInDir = path.join(resolved, 'index.html')
    if (fs.existsSync(indexInDir)) {
      serveFile(indexInDir, res)
      return
    }

    // SPA fallback — serve root index.html for all non-asset 404s
    const ext = path.extname(cleanPath)
    if (!ext || ext === '.html') {
      serveFile(indexHtml, res, 200)
    } else {
      // True asset 404 (image/font/js that doesn't exist)
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
    }
  }

  const server = http.createServer(requestHandler)

  // `localhost` resolves to ::1 first on Windows and modern Linux, so binding
  // it literally leaves 127.0.0.1 refused — the same split that made the dev
  // server's HMR socket hang. Bind dual-stack (or IPv4 where IPv6 is off).
  const bindHost = host === 'localhost' ? await anyHost() : await resolveBindHost(host)

  await new Promise<void>((resolve, reject) => {
    server.listen(port, bindHost, () => resolve())
    server.once('error', reject)
  })

  const url = `http://${host}:${port}${base}`

  console.log(`\n  ⚡ lunx preview\n`)
  console.log(`  ➜  Local:   \x1b[36m${url}\x1b[0m`)
  console.log(`  ➜  Network: \x1b[36mhttp://0.0.0.0:${port}${base}\x1b[0m`)
  console.log(`\n  Serving \x1b[2m${outDir}/\x1b[0m — press Ctrl+C to stop\n`)

  if (open) {
    await openUrl(url)
  }

  // Keep alive
  process.on('SIGINT', () => {
    server.close()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    server.close()
    process.exit(0)
  })
}
