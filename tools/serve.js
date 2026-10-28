// Dev-only static server for testing (the built viewer itself needs no server).
// usage: node tools/serve.js [port]   then open http://localhost:8123/dist/rhino-viewer.html?model=/samples/x.3dm
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = +process.argv[2] || 8123;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.3dm': 'application/octet-stream' };

http.createServer((req, res) => {
  const p = path.normalize(path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}/`));
