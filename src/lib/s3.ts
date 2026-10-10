import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export const UPLOADS_BUCKET = "uploads";
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

let client: S3Client | undefined;

export function isStorageConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.AWS_ENDPOINT_URL_S3 &&
      process.env.AWS_REGION
  );
}

export function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: process.env.AWS_REGION,
      endpoint: process.env.AWS_ENDPOINT_URL_S3,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
      },
      forcePathStyle: true,
    });
  }
  return client;
}

export async function testStorage(): Promise<number> {
  const res = await s3().send(
    new ListObjectsV2Command({ Bucket: UPLOADS_BUCKET, MaxKeys: 1 })
  );
  return res.KeyCount ?? 0;
}

export { GetObjectCommand, PutObjectCommand };
