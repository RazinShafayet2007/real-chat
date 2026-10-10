import { NextResponse } from "next/server";
import {
  GetObjectCommand,
  UPLOADS_BUCKET,
  isStorageConfigured,
  s3,
} from "@/lib/s3";

const KEY_RE = /^chat\/[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

/** Serve a private-bucket image back (keys are unguessable). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> }
) {
  if (!isStorageConfigured()) {
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }
  const { key } = await params;
  const objectKey = (key ?? []).join("/");
  if (!KEY_RE.test(objectKey) || objectKey.includes("..")) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  try {
    const res = await s3().send(
      new GetObjectCommand({ Bucket: UPLOADS_BUCKET, Key: objectKey })
    );
    const body = res.Body as
      | { transformToWebStream?: () => ReadableStream }
      | undefined;
    if (!body?.transformToWebStream) {
      return NextResponse.json({ error: "Unreadable." }, { status: 502 });
    }
    return new Response(body.transformToWebStream(), {
      headers: {
        "Content-Type": res.ContentType ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
}
