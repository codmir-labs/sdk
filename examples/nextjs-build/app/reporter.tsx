'use client';

// A client component: Next.js bundles this file, and @codmir/sdk/nextjs with it, for the browser.
import * as Codmir from '@codmir/sdk/nextjs';
import { useEffect } from 'react';

export function Reporter() {
  useEffect(() => {
    Codmir.init({ clientKey: process.env.NEXT_PUBLIC_CODMIR_CLIENT_KEY });
  }, []);

  return <button onClick={() => Codmir.captureMessage('clicked')}>Report</button>;
}
