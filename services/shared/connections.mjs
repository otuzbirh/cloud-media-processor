import { Queue } from "bullmq";
import IORedis from "ioredis";
import * as Minio from "minio";
import { config } from "./config.mjs";

export const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
export const queue = new Queue(config.queueName, { connection: redis });
export const storage = new Minio.Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

export async function ensureBuckets() {
  for (const bucket of [config.minio.inputBucket, config.minio.outputBucket]) {
    if (!(await storage.bucketExists(bucket))) {
      try {
        await storage.makeBucket(bucket);
      } catch (error) {
        if (!["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(error.code)) throw error;
      }
    }
  }
}

export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
