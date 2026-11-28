// The Pages Router twin of app/api/who/route.ts: an API route the app did not wrap with withCodmirTracing, so it has no
// request scope. `npm run send-check` calls it like the route handler: two at once (?who=carol, ?who=dave), then two with
// no `who`, which set no user and so must carry none.
import type { NextApiRequest, NextApiResponse } from 'next';
import * as Codmir from '@codmir/sdk/nextjs';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const who = typeof req.query.who === 'string' ? req.query.who : null;
  if (who) Codmir.setUser({ id: who });
  await new Promise((resolve) => setTimeout(resolve, 150));
  Codmir.captureException(new Error(`codmir send-check: pages who ${who ?? 'nobody'}`));
  res.status(200).json({ who });
}
