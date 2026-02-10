import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 10)));
  const items = await prisma.recognition.findMany({
    orderBy: { detectedAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  const mood = String(body?.mood ?? "").trim();
  const detectedAtRaw = body?.detectedAt ? new Date(body.detectedAt) : new Date();

  if (!name || !mood) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const detectedAt = Number.isNaN(detectedAtRaw.getTime()) ? new Date() : detectedAtRaw;
  const item = await prisma.recognition.create({
    data: { name, mood, detectedAt },
  });

  return NextResponse.json({ item });
}
