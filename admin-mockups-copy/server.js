// Tiny dependency-free static server for the TooVix DAM Admin mockups.
// Run: node server.js   →   http://localhost:8092/
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = __dirname, PORT = 8092;
const TYPES = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml', '.json':'application/json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {'content-type':'text/html'}); return res.end('<h1>404</h1><a href="/">home</a>'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('TooVix DAM mockups → http://localhost:' + PORT + '/'));
