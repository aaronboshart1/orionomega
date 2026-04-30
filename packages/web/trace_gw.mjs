import { createServer } from 'http';
import { connect as netConnect, createServer as netCreateServer } from 'net';
import next from 'next';
import { parse } from 'url';
import crypto from 'crypto';

let gwBuf = Buffer.alloc(0);
const fakeGw = netCreateServer((sock) => {
  sock.on('data', (d) => { gwBuf = Buffer.concat([gwBuf, d]); });
  setTimeout(() => {
    const wsKey = (gwBuf.toString('utf8').match(/Sec-WebSocket-Key: ([^\r\n]+)/i) || [])[1];
    if (wsKey) {
      const accept = crypto.createHash('sha1').update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      sock.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ' + accept + '\r\n\r\n');
    }
    setTimeout(() => sock.end(), 500);
  }, 100);
});
fakeGw.listen(8089, '127.0.0.1', async () => {
  const app = next({ dev: true, port: 5097 });
  await app.prepare();
  const handle = app.getRequestHandler();
  const nextUpgradeHandler = app.getUpgradeHandler();
  const server = createServer((req, res) => handle(req, res, parse(req.url, true)));
  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = parse(req.url, true);
    if (parsedUrl.pathname === '/api/gateway/ws') {
      console.log('PROXY upgrade fires; head.length=', head.length, 'head as text:', JSON.stringify(head.slice(0,200).toString('utf8')));
      const proxySocket = netConnect({ host: '127.0.0.1', port: 8089 }, () => {
        proxySocket.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1:8089\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + req.headers['sec-websocket-key'] + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
        if (head.length) proxySocket.write(head);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });
    } else nextUpgradeHandler(req, socket, head);
  });
  server.listen(5097, '127.0.0.1', () => {
    const c = netConnect(5097, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      c.write('GET /api/gateway/ws?client=web&session=default HTTP/1.1\r\nHost: 127.0.0.1:5097\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    setTimeout(() => {
      console.log('\n=== TOTAL bytes gateway received ===');
      console.log('len:', gwBuf.length);
      console.log(gwBuf.toString('utf8'));
      console.log('=== END ===');
      process.exit(0);
    }, 1500);
  });
});
