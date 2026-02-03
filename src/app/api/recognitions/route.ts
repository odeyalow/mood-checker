import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(value: string | null) {
  const limit = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(limit) || limit <= 0) return 3;
  return Math.min(limit, 20);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = parseLimit(searchParams.get("limit"));

  const items = await prisma.recognition.findMany({
    orderBy: { detectedAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const mood = typeof body?.mood === "string" ? body.mood.trim() : "";
  const detectedAt =
    typeof body?.detectedAt === "string" ? body.detectedAt : undefined;

  if (!name || !mood) {
    return NextResponse.json(
      { error: "name_and_mood_required" },
      { status: 400 },
    );
  }

  const item = await prisma.recognition.create({
    data: {
      name,
      mood,
      detectedAt: detectedAt ? new Date(detectedAt) : undefined,
    },
  });

  return NextResponse.json({ item }, { status: 201 });
}
