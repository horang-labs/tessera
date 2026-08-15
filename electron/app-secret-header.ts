import fs from 'fs/promises';
import { session } from 'electron';

export async function registerAppSecretHeader(port: number): Promise<string> {
  const { APP_SECRET_HEADER, APP_SECRET_PATH } = await import('../src/lib/auth/app-secret');
  const secret = (await fs.readFile(APP_SECRET_PATH, 'utf8')).trim();
  const urls = [
    `http://localhost:${port}/*`,
    `http://127.0.0.1:${port}/*`,
    `ws://localhost:${port}/*`,
    `ws://127.0.0.1:${port}/*`,
  ];

  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls },
    (details, callback) => {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          [APP_SECRET_HEADER]: secret,
        },
      });
    },
  );

  return secret;
}
