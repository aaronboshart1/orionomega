import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:18790/ws?client=tui');
ws.on('open', () => {
  console.log('Connected!');
  ws.send(JSON.stringify({ id: '1', type: 'chat', content: 'hello' }));
});
ws.on('message', (data) => console.log('Received:', data.toString()));
ws.on('error', (err) => console.error('Error:', err));
ws.on('close', (code, reason) => console.log('Closed:', code, reason.toString()));
setTimeout(() => ws.close(), 5000);
