// The Pages Router's _app runs in the browser and on the server.
import type { AppProps } from 'next/app';
import * as Codmir from '@codmir/sdk/nextjs';

Codmir.init({ clientKey: process.env.NEXT_PUBLIC_CODMIR_CLIENT_KEY });

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
