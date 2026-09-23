const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]);
  const allowed = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js', '/mobile.js': 'mobile.js', '/scoring.js': 'scoring.js' };
  if (!allowed[name]) { res.writeHead(404); return res.end('Not found'); }
  const file = allowed[name];
  res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html');
  fs.createReadStream(path.join(root, file)).pipe(res);
}).listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Portugal 2026: http://localhost:3000'));
