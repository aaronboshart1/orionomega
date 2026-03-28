import { createServer, request as httpRequest } from 'http';
import { connect as netConnect } from 'net';
import { parse } from 'url';
import next from 'next';

const dev = process.env.NODE_ENV !== 'production';

function parseArgs() {
  const args = process.argv.slice(2);
  let host = null;
  let port = null;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-H' || args[i] === '--hostname') && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if ((args[i] === '-p' || args[i] === '--port') && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { host, port };
}

function normalizeHosts(raw) {
  if (!raw) return ['0.0.0.0'];
  const addrs = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set(addrs.length > 0 ? addrs : ['0.0.0.0'])];
}

const cliArgs = parseArgs();
const hosts = normalizeHosts(cliArgs.host || process.env.HOST || '0.0.0.0');
const port = cliArgs.port || parseInt(process.env.PORT || '5000', 10);
const gatewayHost = process.env.GATEWAY_HOST || 'localhost';
const gatewayPort = parseInt(process.env.GATEWAY_PORT || '8000', 10);

const app = next({ dev, port, hostname: '0.0.0.0' });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const nextUpgradeHandler = app.getUpgradeHandler();

  function stripGatewayPrefix(rawUrl) {
    const prefix = '/api/gateway';
    try {
      const parsed = new URL(rawUrl, 'http://localhost');
      if (!parsed.pathname.startsWith(prefix)) return rawUrl;
      const stripped = parsed.pathname.slice(prefix.length);
      const path = stripped.startsWith('/') ? stripped : '/' + stripped;
      return path + parsed.search + parsed.hash;
    } catch {
      const idx = rawUrl.indexOf(prefix);
      if (idx === -1) return rawUrl;
      const stripped = rawUrl.slice(idx + prefix.length);
      return stripped.startsWith('/') ? stripped : '/' + stripped;
    }
  }

  function createHandler(req, res) {
    const parsedUrl = parse(req.url, true);
    if (parsedUrl.pathname.startsWith('/api/gateway/')) {
      const targetPath = stripGatewayPrefix(req.url);
      console.log(`[proxy] ${req.method} ${req.url} -> ${gatewayHost}:${gatewayPort}${targetPath}`);
      const proxyReq = httpRequest(
        {
          hostname: gatewayHost,
          port: gatewayPort,
          path: targetPath,
          method: req.method,
          headers: { ...req.headers, host: `${gatewayHost}:${gatewayPort}` },
        },
        (proxyRes) => {
          console.log(`[proxy] ${req.method} ${req.url} <- ${proxyRes.statusCode}`);
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
        },
      );
      proxyReq.on('error', (err) => {
        console.error(`[proxy] HTTP error for ${req.url}:`, err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Gateway unavailable');
        }
      });
      req.pipe(proxyReq, { end: true });
    } else {
      handle(req, res, parsedUrl);
    }
  }

  function createUpgradeHandler(req, socket, head) {
    const parsedUrl = parse(req.url, true);
    if (parsedUrl.pathname === '/api/gateway/ws') {
      const targetPath = stripGatewayPrefix(req.url);
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
  }

  const allServers = [];

  for (const host of hosts) {
    const server = createServer(createHandler);
    server.on('upgrade', createUpgradeHandler);
    server.on('error', (err) => {
      console.error(`[server] Error on ${host}:${port}:`, err.message);
    });
    server.listen(port, host, () => {
      console.log(`> Ready on http://${host}:${port}`);
    });
    allServers.push(server);
  }

  console.log(`> Gateway proxy: ${gatewayHost}:${gatewayPort}`);

  process.on('SIGTERM', () => {
    for (const srv of allServers) srv.close();
    process.exit(0);
  });
});
