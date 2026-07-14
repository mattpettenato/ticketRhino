import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  if (!req.cookies.get("rhino_anon")) {
    res.cookies.set("rhino_anon", crypto.randomUUID(), {
      maxAge: 60 * 60 * 24 * 365, sameSite: "lax", path: "/", secure: true,
    });
  }
  return res;
}

// Skip static assets — they never need an anon cookie and shouldn't pay for middleware.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
