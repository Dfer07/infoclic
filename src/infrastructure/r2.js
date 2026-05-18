import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

export function createR2Client({ endpoint, accessKeyId, secretAccessKey }) {
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export async function listIncomingCsv(client, { bucket, prefix }) {
  const res = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
  );
  return (res.Contents ?? [])
    .map((o) => o.Key)
    .filter((k) => k && k !== prefix && k.endsWith('.csv'));
}

export async function downloadCsv(client, { bucket, key }) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function moveObject(client, { bucket, sourceKey, destKey }) {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(sourceKey)}`,
      Key: destKey,
    }),
  );
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }));
}

export async function uploadObject(client, { bucket, key, body, contentType }) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}
