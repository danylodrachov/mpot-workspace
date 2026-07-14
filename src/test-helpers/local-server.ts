import { createServer, Server } from 'node:http';

export interface LocalServerResult {
  server: Server;
  port: number;
}

export async function createLocalServer(html: string): Promise<LocalServerResult> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  return new Promise((resolve, reject) => {
    server.listen(0, 'localhost', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      resolve({ server, port: address.port });
    });

    server.on('error', reject);
  });
}
