import type { Response } from "express";

const clients = new Set<Response>();

export function addSseClient(res: Response): void {
  clients.add(res);
}

export function removeSseClient(res: Response): void {
  clients.delete(res);
}

export function broadcastSse(data: object): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}
