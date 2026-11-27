// A server component that always throws: `npm run send-check` requests it and waits for the error to reach a stub server.
// Dynamic, so `next build` does not render it (and fail) at build time.
export const dynamic = 'force-dynamic';

export default function Boom() {
  throw new Error('codmir send-check: a server component threw');
}
