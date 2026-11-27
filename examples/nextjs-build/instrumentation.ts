// Imported at the top, as the README shows: Next.js builds this file for Node.js and, because of middleware.ts, for Edge.
import * as Codmir from '@codmir/sdk/nextjs';

export function register() {
  // CODMIR_DSN is the README's `dsn`: where events go. `npm run send-check` points it at a stub server.
  Codmir.init({ clientKey: process.env.CODMIR_CLIENT_KEY, dsn: process.env.CODMIR_DSN, environment: process.env.NODE_ENV });
}

export const onRequestError = Codmir.captureRouterError;
