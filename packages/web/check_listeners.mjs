import { createServer } from 'http';
import next from 'next';
import { parse } from 'url';

const app = next({ dev: true, port: 5096 });
await app.prepare();
const handle = app.getRequestHandler();
const nextUpgradeHandler = app.getUpgradeHandler();
const server = createServer((req, res) => handle(req, res, parse(req.url, true)));

console.log('BEFORE attaching ours: upgrade listeners =', server.listenerCount('upgrade'));
const myHandler = (req, socket, head) => {
  console.log('  MY HANDLER runs; listenerCount NOW =', server.listenerCount('upgrade'));
  socket.destroy();
};
server.on('upgrade', myHandler);
console.log('AFTER attaching ours: upgrade listeners =', server.listenerCount('upgrade'));

server.listen(5096, '127.0.0.1', async () => {
  console.log('after listen: upgrade listeners =', server.listenerCount('upgrade'));
  // First make an HTTP request to /
  const http = await import('http');
  http.get('http://127.0.0.1:5096/', (res) => { res.resume(); res.on('end', async () => {
    console.log('after first GET: upgrade listeners =', server.listenerCount('upgrade'));
    // Now do an upgrade
    const net = await import('net');
    const sock = net.connect(5096, '127.0.0.1', () => {
      sock.write('GET /api/gateway/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    setTimeout(() => process.exit(0), 1000);
  }); });
});
