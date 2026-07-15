import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

// S3 object-store data operations, factored out of StorageService as free functions of (client,
// bucket). Keys live under the `media/` prefix; callers pass the storage-relative path. The service
// still owns client construction, availability probing, and the key-safety guard.

export async function listS3Files(client: S3Client, bucket: string): Promise<string[]> {
  const files: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'media/',
        ContinuationToken: continuationToken,
      }),
    );

    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key) {
          files.push(obj.Key.replace(/^media\//, ''));
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return files;
}

/** Count + total byte size of the `media/` prefix. ListObjectsV2 already returns each object's Size,
 *  so this reports the real total with no extra API calls beyond the listing. */
export async function getS3CountAndSize(
  client: S3Client,
  bucket: string,
): Promise<{ count: number; sizeBytes: number }> {
  let count = 0;
  let sizeBytes = 0;
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'media/',
        ContinuationToken: continuationToken,
      }),
    );

    for (const obj of response.Contents ?? []) {
      count += 1;
      sizeBytes += obj.Size ?? 0;
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return { count, sizeBytes };
}

export async function getS3File(client: S3Client, bucket: string, filePath: string): Promise<Buffer> {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: `media/${filePath}`,
    }),
  );

  if (!response.Body) throw new Error('Empty response body');

  const chunks: Buffer[] = [];
  const stream = response.Body as Readable;

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as ArrayBuffer));
  }

  return Buffer.concat(chunks);
}

export async function putS3File(client: S3Client, bucket: string, filePath: string, data: Buffer): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `media/${filePath}`,
      Body: data,
    }),
  );
}
