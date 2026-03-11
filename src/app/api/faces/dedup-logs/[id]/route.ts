import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const logId = decodeURIComponent(id || "").trim();
    if (!logId) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const item = await prisma.faceDedupLog.findUnique({
      where: { id: logId },
    });
    if (!item) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    return NextResponse.json({
      item: {
        ...item,
        createdAt: item.createdAt.toISOString(),
      },
    });
  } catch (error) {
    console.error("[api/faces/dedup-logs/[id]] GET failed", error);
    return NextResponse.json({ error: "dedup_log_unavailable" }, { status: 500 });
  }
}

