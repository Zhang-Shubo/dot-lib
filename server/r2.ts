import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
};

export const bucket = required("R2_BUCKET");

// R2_ENDPOINT overrides the default Cloudflare endpoint — useful for MinIO or
// another S3-compatible store. When unset, R2_ACCOUNT_ID is required.
const endpoint =
  process.env.R2_ENDPOINT ||
  `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;

export const r2 = new S3Client({
  region: "auto",
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
});

export async function putObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string
): Promise<void> {
  await r2.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
  );
}

export async function getObjectBuffer(key: string): Promise<Buffer | null> {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const stream = res.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

export async function getJson<T>(key: string): Promise<T | null> {
  const buf = await getObjectBuffer(key);
  if (!buf) return null;
  return JSON.parse(buf.toString("utf-8")) as T;
}

export async function putJson(key: string, value: unknown): Promise<void> {
  await putObject(key, JSON.stringify(value), "application/json");
}

// ---- multipart upload ----
//
// Big books can't be pushed in one request: a slow client hits Cloudflare's
// 100s origin timeout, and buffering the whole file would blow the server's
// small heap. Each part is its own short request instead.

export interface UploadedPart {
  PartNumber: number;
  ETag: string;
}

export async function createMultipart(key: string, contentType: string): Promise<string> {
  const res = await r2.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType })
  );
  if (!res.UploadId) throw new Error("R2 did not return an UploadId");
  return res.UploadId;
}

export async function uploadPart(
  key: string,
  uploadId: string,
  partNumber: number,
  body: Buffer | Uint8Array
): Promise<string> {
  const res = await r2.send(
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
    })
  );
  if (!res.ETag) throw new Error("R2 did not return an ETag for the part");
  return res.ETag;
}

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: UploadedPart[]
): Promise<void> {
  await r2.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber) },
    })
  );
}

export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  await r2.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
}

export async function deleteObject(key: string): Promise<void> {
  await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** List every key under a prefix (paginates past 1000 objects). */
export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await r2.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
    );
    for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
