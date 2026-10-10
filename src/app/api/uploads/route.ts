import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  PutObjectCommand,
  UPLOADS_BUCKET,
  isStorageConfigured,
  s3,
} from "@/lib/s3";

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Image upload for chat (Future-works: File & image uploads).
 * Private bucket; files are unlisted (random keys) and served back
 * through /api/files. 503 while Object Storage creds are missing.
 */
export async function POST(request: Request) {
  if (!isStorageConfigured()) {
    return NextResponse.json(
      { error: "Uploads not configured." },
      { status: 503 }
    );
  }
  let file: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("file");
    if (value instanceof File) file = value;
  } catch {
    return NextResponse.json({ error: "Bad upload." }, { status: 400 });
  }
  if (!file || file.size === 0) {
    return NextResponse.json({ error: "No file sent." }, { status: 400 });
  }
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: "Only PNG, JPEG, GIF, WebP images." },
      { status: 400 }
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "Max 5 MB per image." },
      { status: 400 }
    );
  }
  const key = `chat/${randomUUID()}.${EXT_BY_TYPE[file.type] ?? "bin"}`;
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await s3().send(
      new PutObjectCommand({
        Bucket: UPLOADS_BUCKET,
        Key: key,
        Body: bytes,
        ContentType: file.type,
        ContentLength: bytes.length,
      })
    );
  } catch {
    return NextResponse.json(
      { error: "Upload provider unavailable." },
      { status: 502 }
    );
  }
  return NextResponse.json({ url: `/api/files/${key}` });
}
