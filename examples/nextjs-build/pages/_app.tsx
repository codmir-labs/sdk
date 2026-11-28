// The Pages Router's _app runs in the browser and on the server. It starts the SDK in the browser only: a keyless init on
// the server would replace the client instrumentation.ts started there.
import type { AppProps } from 'next/app';
import * as Codmir from '@codmir/sdk/nextjs';

if (typeof window !== 'undefined') Codmir.init({ clientKey: process.env.NEXT_PUBLIC_CODMIR_CLIENT_KEY });

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
