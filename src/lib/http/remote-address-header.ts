import type { IncomingMessage } from 'node:http';

export const TESSERA_REMOTE_ADDRESS_HEADER = 'x-tessera-remote-address';

export function attachRemoteAddressHeader(request: IncomingMessage): void {
  request.headers[TESSERA_REMOTE_ADDRESS_HEADER] = request.socket.remoteAddress ?? 'unknown';
}
