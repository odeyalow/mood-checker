import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { studentIdFromName } from "@/lib/students";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseLimit(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 50);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim().toLowerCase();
  const limit = parseLimit(searchParams.get("limit"), 10);

  const grouped = await prisma.recognition.groupBy({
    by: ["name"],
    _count: { _all: true },
    _max: { detectedAt: true },
    orderBy: { _max: { detectedAt: "desc" } },
  });

  const items = grouped
    .filter((row) => !q || row.name.toLowerCase().includes(q))
    .slice(0, limit)
    .map((row) => ({
      id: studentIdFromName(row.name),
      name: row.name,
      totalRecognitions: row._count._all,
      lastDetectedAt: row._max.detectedAt?.toISOString() ?? null,
    }));

  return NextResponse.json({ items });
}
