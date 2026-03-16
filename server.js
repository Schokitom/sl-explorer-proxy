/**
 * S+L Explorer — Trimble PDF Proxy Server
 * Läuft auf Render.com (kostenlos).
 * Empfängt Anfragen von der Extension, holt PDFs von Trimble mit Auth-Header,
 * und leitet sie mit korrekten CORS-Headern weiter.
 */

const https = require('https');
const http  = require('http');
const url   = require('url');

const PORT         = process.env.PORT || 3000;
// Nur Anfragen von dieser Origin erlauben (deine GitHub Pages URL)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://schokitom.github.io';

// ── CORS-Header für alle Responses ──────────────────────────────────────────
function setCors(res, origin) {
  const allow = (origin === ALLOWED_ORIGIN) ? origin : '';
  res.setHeader('Access-Control-Allow-Origin',  allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Token');
  res.setHeader('Access-Control-Max-Age',       '86400');
}

// ── Hauptserver ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const origin = req.headers['origin'] || '';
  setCors(res, origin);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Nur GET erlaubt
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Nur Anfragen von erlaubter Origin
  if (origin && origin !== ALLOWED_ORIGIN) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }

  const parsed = url.parse(req.url, true);

  // ── Route: GET /proxy?url=<trimble-url>&token=<bearer-token> ────────────
  if (parsed.pathname === '/proxy') {
    const targetUrl  = parsed.query.url;
    const token      = req.headers['x-token']           // preferred: X-Token header
      || parsed.query.token                              // fallback: query param
      || null;
    const authHeader = token
      ? `Bearer ${token}`
      : (req.headers['authorization'] || '');

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
      return;
    }

    // Normalize URL — ensure https:// prefix
    const normalizedUrl = targetUrl.startsWith('//')
      ? 'https:' + targetUrl
      : targetUrl;

    // Only allow Trimble Connect URLs (security)
    if (!normalizedUrl.startsWith('https://') ||
        !normalizedUrl.includes('connect.trimble.com')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only Trimble Connect URLs allowed', got: normalizedUrl.substring(0, 60) }));
      return;
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing token' }));
      return;
    }

    console.log(`[Proxy] → ${normalizedUrl.substring(0, 80)}...`);

    // Anfrage an Trimble weiterleiten
    const trimbleReq = https.get(normalizedUrl, {
      headers: {
        'Authorization': authHeader,
        'User-Agent':    'SL-Explorer-Proxy/1.0'
      }
    }, (trimbleRes) => {
      console.log(`[Proxy] ← Status: ${trimbleRes.statusCode}, Type: ${trimbleRes.headers['content-type']}`);

      // Redirect folgen (Trimble /download gibt 302 → S3)
      if (trimbleRes.statusCode === 302 || trimbleRes.statusCode === 301) {
        const redirectUrl = trimbleRes.headers['location'];
        if (!redirectUrl) {
          res.writeHead(502);
          res.end('No redirect location');
          return;
        }
        console.log(`[Proxy] ↪ Redirect → ${redirectUrl.substring(0, 80)}...`);

        // S3 pre-signed URL abrufen (kein Auth-Header nötig)
        https.get(redirectUrl, (s3Res) => {
          console.log(`[Proxy] S3 Status: ${s3Res.statusCode}`);
          res.writeHead(s3Res.statusCode, {
            'Content-Type':  s3Res.headers['content-type'] || 'application/pdf',
            'Content-Length': s3Res.headers['content-length'] || '',
            'Cache-Control': 'private, max-age=300',
          });
          s3Res.pipe(res);
        }).on('error', (e) => {
          console.error('[Proxy] S3 Fehler:', e.message);
          res.writeHead(502);
          res.end('S3 fetch error: ' + e.message);
        });
        return;
      }

      // Direkte Antwort (z.B. Thumbnail)
      res.writeHead(trimbleRes.statusCode, {
        'Content-Type':  trimbleRes.headers['content-type'] || 'application/octet-stream',
        'Content-Length': trimbleRes.headers['content-length'] || '',
        'Cache-Control': 'private, max-age=300',
      });
      trimbleRes.pipe(res);
    });

    trimbleReq.on('error', (e) => {
      console.error('[Proxy] Trimble Fehler:', e.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream error: ' + e.message }));
      }
    });

    // Timeout nach 30s
    trimbleReq.setTimeout(30000, () => {
      trimbleReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end('Gateway timeout');
      }
    });

    return;
  }

  // ── Route: GET / — Health check ─────────────────────────────────────────
  if (parsed.pathname === '/' || parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'S+L Explorer Proxy',
      version: '2.0.0',
      routes: ['/health', '/proxy?url=<trimble-url>&token=<bearer>'],
      allowed_origin: ALLOWED_ORIGIN
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`✅ S+L Explorer Proxy läuft auf Port ${PORT}`);
  console.log(`   Erlaubte Origin: ${ALLOWED_ORIGIN}`);
});
