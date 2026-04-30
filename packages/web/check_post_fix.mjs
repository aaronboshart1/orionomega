import { createServer } from 'http';
import next from 'next';
import { parse } from 'url';
process.env.ORIONOMEGA_CUSTOM_SERVER = '1';

const app = next({ dev: true, port: 5095 });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((req, res) => handle(req, res, parse(req.url, true)));
const myHandler = (req, socket) => { console.log('upgrade fired; listenerCount=', server.listenerCount('upgrade')); socket.destroy(); };
server.on('upgrade', myHandler);
server.listen(5095, '127.0.0.1', async () => {
  console.log('after listen: upgrade listeners =', server.listenerCount('upgrade'));
  const http = await import('http');
  http.get('http://127.0.0.1:5095/', (res) => { res.resume(); res.on('end', async () => {
    console.log('after first GET: upgrade listeners =', server.listenerCount('upgrade'));
    const net = await import('net');
    const sock = net.connect(5095, '127.0.0.1', () => {
      sock.write('GET /api/gateway/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    setTimeout(() => process.exit(0), 1500);
  }); });
});
