// With a middleware, Next.js also builds instrumentation.ts for the Edge runtime.
import { NextResponse } from 'next/server';

export function middleware() {
  return NextResponse.next();
}
