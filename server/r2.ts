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

// Object storage client. The bucket and credentials come from the ai-space
// storage contract when the app runs inside an ai-space workspace, and from
// the legacy R2_* variables otherwise:
//
//   BLOB_URL=s3://bucket/prefix/   plus S3_ENDPOINT / S3_REGION /
//   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY, all written by ai-space into
//   ~/.ai-space/data/dot-lib/space.env from the `storage.blobs` declaration
//   in space.yaml (see ai-space docs/storage.md).
//
//   R2_BUCKET + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY and R2_ENDPOINT or
//   R2_ACCOUNT_ID, the pre-ai-space configuration.
//
// Every key this module sees is relative to the store: `books/<id>/meta.json`.
// The prefix from BLOB_URL is added on the way out and stripped on the way in,
// so the rest of the server never knows about it.

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
};

interface StoreConfig {
  bucket: string;
  prefix: string;
  endpoint: string | undefined;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function resolveConfig(): StoreConfig {
  const blobUrl = process.env.BLOB_URL;
  if (blobUrl) {
    const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(blobUrl.trim());
    if (!m) throw new Error(`BLOB_URL must look like s3://bucket/prefix/, got ${blobUrl}`);
    const prefix = m[2] ? m[2].replace(/\/?$/, "/") : "";
    return {
      bucket: m[1],
      prefix,
      endpoint: process.env.S3_ENDPOINT || undefined,
      region: process.env.S3_REGION || "auto",
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    };
  }
  // R2_ENDPOINT overrides the default Cloudflare endpoint — useful for MinIO or
  // another S3-compatible store. When unset, R2_ACCOUNT_ID is required.
  return {
    bucket: required("R2_BUCKET"),
    prefix: "",
    endpoint: process.env.R2_ENDPOINT || `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    region: "auto",
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  };
}

const config = resolveConfig();
export const bucket = config.bucket;
export const prefix = config.prefix;

export const r2 = new S3Client({
  region: config.region,
  ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  },
});

/** Full object key inside the bucket. */
const k = (key: string): string => prefix + key;

export async function putObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string
): Promise<void> {
  await r2.send(
    new PutObjectCommand({ Bucket: bucket, Key: k(key), Body: body, ContentType: contentType })
  );
}

export async function getObjectBuffer(key: string): Promise<Buffer | null> {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: k(key) }));
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
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: k(key), ContentType: contentType })
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
      Key: k(key),
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
      Key: k(key),
      UploadId: uploadId,
      MultipartUpload: { Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber) },
    })
  );
}

export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  await r2.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: k(key), UploadId: uploadId }));
}

export async function deleteObject(key: string): Promise<void> {
  await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: k(key) }));
}

/** List every key under a prefix (paginates past 1000 objects). Keys come back without the store prefix. */
export async function listKeys(under: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await r2.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: k(under), ContinuationToken: token })
    );
    for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key.slice(prefix.length));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
