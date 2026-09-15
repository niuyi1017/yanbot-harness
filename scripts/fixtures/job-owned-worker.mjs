import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
const [file, authorization] = process.argv.slice(2);
const timer = setTimeout(() => process.exit(0), 30000);
const server = createServer((request, response) => {
  if (request.headers.authorization !== authorization) {
    response.writeHead(403).end();
    return;
  }
  response.end('owned');
  if (request.method === 'POST') {
    clearTimeout(timer);
    server.close();
  }
});
server.listen(0, '127.0.0.1', async () => {
  await writeFile(file, JSON.stringify({ pid: process.pid, port: server.address().port }), { mode: 0o600 });
});
