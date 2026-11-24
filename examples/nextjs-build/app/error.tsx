'use client';

import * as Codmir from '@codmir/sdk/nextjs';
import { useEffect } from 'react';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Codmir.captureException(error);
  }, [error]);

  return <button onClick={() => reset()}>Try again</button>;
}
