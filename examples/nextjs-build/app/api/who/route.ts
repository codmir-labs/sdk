// A route handler the app did not wrap with withCodmirTracing: it has no request scope. `npm run send-check` calls it
// twice at once (?who=carol, ?who=dave) and checks that each error carries only its own user, then once with no `who`,
// which sets no user and so must carry none.
import * as Codmir from '@codmir/sdk/nextjs';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const who = new URL(request.url).searchParams.get('who');
  if (who) Codmir.setUser({ id: who });
  await new Promise((resolve) => setTimeout(resolve, 150));
  Codmir.captureException(new Error(`codmir send-check: who ${who ?? 'nobody'}`));
  return Response.json({ who });
}
