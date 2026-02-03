import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyAuthToken } from "@/lib/auth";

export async function GET() {
  const cookieStore = await cookies();
  const token = cookieStore.get("mc_auth")?.value;
  if (!token) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  try {
    const payload = await verifyAuthToken(token);
    const login =
      typeof payload.login === "string" ? payload.login : undefined;
    return NextResponse.json({
      user: {
        id: payload.sub,
        login,
      },
    });
  } catch {
    return NextResponse.json({ user: null }, { status: 401 });
  }
}
