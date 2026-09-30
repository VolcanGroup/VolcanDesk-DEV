// Servidor estatico minimo (sin dependencias externas) para servir dist/
// bajo PM2. Se usa en vez de "npx serve" para no depender de que el
// servidor tenga salida a internet la primera vez que se ejecuta.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'dist');
const PORT = process.env.FRONTEND_PORT || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(ROOT, urlPath);

  // No dejar salir de dist/ con ../../
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    let isIndexFallback = false;
    if (err || !stats.isFile()) {
      filePath = path.join(ROOT, 'index.html');
      isIndexFallback = true;
    }
    const ext = path.extname(filePath);
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404);
        return res.end('Not found');
      }
      // index.html referencia los archivos de /assets por nombre con hash de
      // contenido (Vite): si el navegador la cachea, sigue apuntando al JS de
      // un build viejo después de un deploy y solo un hard refresh lo nota
      // (reportado en vivo 2026-09-16 — cuenta "Kendy test" no veía datos
      // nuevos hasta Ctrl+Shift+R). index.html (y cualquier ruta sin archivo
      // real, que cae aquí mismo) siempre se revalida; los archivos con hash
      // en /assets sí pueden cachearse "para siempre" porque un contenido
      // distinto siempre tiene un nombre distinto.
      const isIndexHtml = isIndexFallback || path.basename(filePath) === 'index.html';
      const cacheControl = isIndexHtml
        ? 'no-cache'
        : 'public, max-age=31536000, immutable';
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
      res.end(data);
    });
  });
}).listen(PORT, () => {
  console.log(`Frontend (dist/) sirviendo en puerto ${PORT}`);
});
