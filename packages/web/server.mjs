import { createServer, request as httpRequest } from 'http';
import { connect as netConnect } from 'net';
import { parse } from 'url';
import next from 'next';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '5000', 10);
const gatewayHost = process.env.GATEWAY_HOST || 'localhost';
const gatewayPort = parseInt(process.env.GATEWAY_PORT || '8000', 10);

const app = next({ dev, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const nextUpgradeHandler = app.getUpgradeHandler();

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    if (parsedUrl.pathname.startsWith('/api/gateway/')) {
      const targetPath = req.url.replace('/api/gateway', '');
      const proxyReq = httpRequest(
        {
          hostname: gatewayHost,
          port: gatewayPort,
          path: targetPath,
          method: req.method,
          headers: { ...req.headers, host: `${gatewayHost}:${gatewayPort}` },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
        },
      );
      proxyReq.on('error', (err) => {
        console.error('[proxy] HTTP error:', err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Gateway unavailable');
        }
      });
      req.pipe(proxyReq, { end: true });
    } else {
      handle(req, res, parsedUrl);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = parse(req.url, true);
    if (parsedUrl.pathname === '/api/gateway/ws') {
      const targetPath = req.url.replace('/api/gateway', '');
      const proxySocket = netConnect({ host: gatewayHost, port: gatewayPort }, () => {
        const reqLine = `GET ${targetPath} HTTP/1.1\r\n`;
        const headers = Object.entries({
          ...req.headers,
          host: `${gatewayHost}:${gatewayPort}`,
        })
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        proxySocket.write(reqLine + headers + '\r\n\r\n');
        if (head && head.length > 0) proxySocket.write(head);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      });
      proxySocket.on('error', (err) => {
        console.error('[proxy] WS error:', err.message);
        socket.destroy();
      });
      socket.on('error', (err) => {
        console.error('[proxy] Client socket error:', err.message);
        proxySocket.destroy();
      });
      socket.on('close', () => proxySocket.destroy());
      proxySocket.on('close', () => socket.destroy());
    } else {
      nextUpgradeHandler(req, socket, head);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`> Ready on http://0.0.0.0:${port}`);
    console.log(`> Gateway proxy: ${gatewayHost}:${gatewayPort}`);
  });
});
