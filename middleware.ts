import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const protectedSections = new Set(["dashboard", "students"]);

async function isValidToken(token: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set");
  }
  const secretKey = new TextEncoder().encode(secret);
  await jwtVerify(token, secretKey, { algorithms: ["HS256"] });
  return true;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  const segments = pathname.split("/").filter(Boolean);
  const locale = segments[0];
  const section = segments[1];

  if (!section || !protectedSections.has(section)) {
    return NextResponse.next();
  }

  const token = request.cookies.get("mc_auth")?.value;
  if (!token) {
    const url = request.nextUrl.clone();
    url.pathname = `/${locale || "ru"}/login`;
    return NextResponse.redirect(url);
  }

  try {
    await isValidToken(token);
    return NextResponse.next();
  } catch {
    const url = request.nextUrl.clone();
    url.pathname = `/${locale || "ru"}/login`;
    return NextResponse.redirect(url);
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
