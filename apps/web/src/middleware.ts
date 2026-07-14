import { NextRequest, NextResponse } from "next/server";

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  if (!req.cookies.get("rhino_anon")) {
    res.cookies.set("rhino_anon", crypto.randomUUID(), {
      maxAge: 60 * 60 * 24 * 365, sameSite: "lax", path: "/",
    });
  }
  return res;
}
