/**
 * S+L Explorer — Trimble PDF Proxy Server v4.0.0
 */

const https = require('https');
const http  = require('http');

const PORT           = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://schokitom.github.io';

const server = http.createServer((req, res) => {

  // CORS-Header immer als erstes setzen
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Token');
  res.setHeader('Access-Control-Max-Age',       '86400');

  // OPTIONS Preflight — sofort antworten
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Manuelles URL-Parsing (robuster bei langen URLs)
  const reqUrl   = req.url || '/';
  const qIdx     = reqUrl.indexOf('?');
  const pathname = qIdx >= 0 ? reqUrl.slice(0, qIdx) : reqUrl;
  const query    = qIdx >= 0 ? reqUrl.slice(qIdx + 1) : '';

  function getParam(name) {
    for (const part of query.split('&')) {
      const idx = part.indexOf('=');
      if (idx > 0 && part.slice(0, idx) === name) {
        return decodeURIComponent(part.slice(idx + 1).replace(/\+/g, ' '));
      }
    }
    return null;
  }

  // Health check
  if (pathname === '/' || pathname === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      service: 'S+L Explorer Proxy',
      version: '4.0.0',
      allowed_origin: ALLOWED_ORIGIN
    }));
    return;
  }

  // Proxy
  if (pathname === '/proxy') {
    const targetUrl = getParam('url');
    const token     = req.headers['x-token'] || getParam('token') || null;

    if (!targetUrl) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
      return;
    }

    if (!targetUrl.includes('connect.trimble.com')) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Only Trimble Connect URLs allowed' }));
      return;
    }

    if (!token) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing token' }));
      return;
    }

    const fullUrl = targetUrl.startsWith('//') ? 'https:' + targetUrl : targetUrl;
    console.log('[Proxy] ->', fullUrl.substring(0, 80));

    const trimbleReq = https.get(fullUrl, {
      headers: { 'Authorization': 'Bearer ' + token, 'User-Agent': 'SL-Explorer-Proxy/4.0' }
    }, function(trimbleRes) {
      console.log('[Proxy] Trimble status:', trimbleRes.statusCode);

      if (trimbleRes.statusCode === 301 || trimbleRes.statusCode === 302) {
        const location = trimbleRes.headers['location'];
        if (!location) { res.statusCode = 502; res.end('No location'); return; }
        console.log('[Proxy] Redirect ->', location.substring(0, 80));

        https.get(location, function(s3Res) {
          console.log('[Proxy] S3 status:', s3Res.statusCode);
          res.statusCode = s3Res.statusCode;
          res.setHeader('Content-Type',  s3Res.headers['content-type'] || 'application/pdf');
          res.setHeader('Cache-Control', 'private, max-age=300');
          if (s3Res.headers['content-length']) res.setHeader('Content-Length', s3Res.headers['content-length']);
          s3Res.pipe(res);
        }).on('error', function(e) {
          res.statusCode = 502; res.end('S3 error: ' + e.message);
        });
        return;
      }

      res.statusCode = trimbleRes.statusCode;
      res.setHeader('Content-Type',  trimbleRes.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=300');
      if (trimbleRes.headers['content-length']) res.setHeader('Content-Length', trimbleRes.headers['content-length']);
      trimbleRes.pipe(res);
    });

    trimbleReq.on('error', function(e) {
      console.error('[Proxy] Error:', e.message);
      if (!res.headersSent) { res.statusCode = 502; res.end(JSON.stringify({ error: e.message })); }
    });

    trimbleReq.setTimeout(30000, function() {
      trimbleReq.destroy();
      if (!res.headersSent) { res.statusCode = 504; res.end('Timeout'); }
    });

    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Not found', path: pathname }));
});

server.listen(PORT, function() {
  console.log('S+L Explorer Proxy v4.0.0 auf Port ' + PORT);
  console.log('Allowed origin: ' + ALLOWED_ORIGIN);
});
