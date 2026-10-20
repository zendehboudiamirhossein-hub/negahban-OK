import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * دریافت قطعه‌ی صوتی از دستگاه (هر ۱۰ ثانیه وقتی ضبط صدا فعال است).
 * هدر: X-Device-Token
 * بدنه: { audio: base64, mimeType?: string, durationSec?: int, at?: number }
 * پاسخ: { ok, saved, total }
 *
 * نگه‌داشتن فقط ۲۰۰ قطعه‌ی آخر هر دستگاه برای جلوگیری از انباشت.
 */
export async function POST(req: NextRequest) {
  const token = req.headers.get("x-device-token");
  if (!token) {
    return NextResponse.json({ error: "توکن دستگاه لازم است" }, { status: 401 });
  }

  const device = await db.device.findUnique({ where: { token } });
  if (!device) {
    return NextResponse.json({ error: "توکن نامعتبر است" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "درخواست نامعتبر" }, { status: 400 });
  }

  const audio = typeof body?.audio === "string" ? body.audio : null;
  if (!audio || audio.length === 0 || audio.length > 2_000_000) {
    return NextResponse.json(
      { error: "فایل صوتی لازم است (حداکثر ۱.۵ مگابایت base64)" },
      { status: 400 }
    );
  }

  const mimeType =
    typeof body?.mimeType === "string" && body.mimeType.length <= 50
      ? body.mimeType
      : "audio/aac";
  const durationSec =
    typeof body?.durationSec === "number" && body.durationSec > 0 && body.durationSec <= 600
      ? Math.round(body.durationSec)
      : 10;
  const atRaw =
    typeof body?.at === "number" && Number.isFinite(body.at as number)
      ? (body.at as number)
      : Date.now();
  const at = new Date(atRaw);

  // فقط وقتی ذخیره کن که ضبط صدا روشن باشد
  if (!device.audioMonitorEnabled) {
    return NextResponse.json({ ok: true, saved: 0, total: 0, reason: "monitor disabled" });
  }

  const buf = Buffer.from(audio, "base64");
  if (buf.byteLength === 0) {
    return NextResponse.json({ error: "فایل صوتی خالی است" }, { status: 400 });
  }

  await db.$transaction(async (tx) => {
    await tx.audioClip.create({
      data: {
        deviceId: device.id,
        audio: buf,
        mimeType,
        durationSec,
        recordedAt: at,
      },
    });

    // نگه‌داشتن فقط ۲۰۰ قطعه‌ی آخر
    const keep = await tx.audioClip.findMany({
      where: { deviceId: device.id },
      orderBy: { recordedAt: "desc" },
      take: 200,
      select: { id: true },
    });
    if (keep.length === 200) {
      await tx.audioClip.deleteMany({
        where: {
          deviceId: device.id,
          id: { notIn: keep.map((a) => a.id) },
        },
      });
    }

    await tx.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    await tx.eventLog.create({
      data: {
        deviceId: device.id,
        type: "AUDIO",
        message: "قطعه‌ی صوتی دریافت شد",
      },
    });
  });

  const total = await db.audioClip.count({ where: { deviceId: device.id } });
  return NextResponse.json({ ok: true, saved: 1, total });
}
