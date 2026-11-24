// Imported at the top, as the README shows: Next.js builds this file for Node.js and, because of middleware.ts, for Edge.
import * as Codmir from '@codmir/sdk/nextjs';

export function register() {
  Codmir.init({ clientKey: process.env.CODMIR_CLIENT_KEY, environment: process.env.NODE_ENV });
}

export const onRequestError = Codmir.captureRouterError;
