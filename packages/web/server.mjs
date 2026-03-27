import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import httpProxy from 'http-proxy';

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '5000', 10);
const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:8000';

const app = next({ dev, port });
const handle = app.getRequestHandler();

const proxy = httpProxy.createProxyServer({
  target: gatewayUrl,
  ws: true,
  changeOrigin: true,
});

proxy.on('error', (err) => {
  console.error('[proxy] Error:', err.message);
});

app.prepare().then(() => {
  const nextUpgradeHandler = app.getUpgradeHandler();

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    if (parsedUrl.pathname.startsWith('/api/gateway/')) {
      req.url = req.url.replace('/api/gateway', '');
      proxy.web(req, res);
    } else {
      handle(req, res, parsedUrl);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const parsedUrl = parse(req.url, true);
    if (parsedUrl.pathname === '/api/gateway/ws') {
      req.url = req.url.replace('/api/gateway', '');
      proxy.ws(req, socket, head);
    } else {
      nextUpgradeHandler(req, socket, head);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`> Ready on http://0.0.0.0:${port}`);
    console.log(`> Gateway proxy: ${gatewayUrl}`);
  });
});
