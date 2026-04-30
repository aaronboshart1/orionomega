import { createServer } from 'http';
import { connect as netConnect } from 'net';
import next from 'next';
import { parse } from 'url';
const app = next({ dev: true, port: 5098 });
await app.prepare();
const nextUpgradeHandler = app.getUpgradeHandler();
const handle = app.getRequestHandler();
const server = createServer((req, res) => handle(req, res, parse(req.url, true)));
server.on('upgrade', (req, socket, head) => {
  const parsedUrl = parse(req.url, true);
  console.log('UPGRADE event for:', parsedUrl.pathname, '— upgrade-listener-count:', server.listenerCount('upgrade'));
  const origWrite = socket.write.bind(socket);
  socket.write = function(chunk, ...args) {
    const preview = Buffer.isBuffer(chunk) ? chunk.slice(0,80).toString('utf8') : String(chunk).slice(0,80);
    const stack = new Error().stack.split('\n').slice(2,5).map(s=>s.trim()).join(' | ');
    console.log('  socket.write FROM:', stack);
    console.log('  PREVIEW:', JSON.stringify(preview));
    return origWrite(chunk, ...args);
  };
  if (parsedUrl.pathname === '/api/gateway/ws') {
    const proxySocket = netConnect({ host: '127.0.0.1', port: 8000 }, () => {
      proxySocket.write('GET /ws?client=web&session=default HTTP/1.1\r\nHost: 127.0.0.1:8000\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + req.headers['sec-websocket-key'] + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
      if (head && head.length > 0) proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxySocket.on('error', (e) => { console.log('proxy err:', e.message); socket.destroy(); });
  } else {
    nextUpgradeHandler(req, socket, head);
  }
});
server.listen(5098, '127.0.0.1', async () => {
  console.log('test server listening on 5098');
  const WS = (await import('ws')).default;
  const ws = new WS('ws://127.0.0.1:5098/api/gateway/ws?client=web&session=default');
  ws.on('error', (e) => console.log('CLIENT ERR:', e.message));
  ws.on('close', (c) => { console.log('CLIENT close', c); setTimeout(()=>process.exit(0),200); });
  setTimeout(() => process.exit(0), 4000);
});
