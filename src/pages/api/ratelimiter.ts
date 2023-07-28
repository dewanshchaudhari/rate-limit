// Next.js API route support: https://nextjs.org/docs/api-routes/introduction
import type { NextApiRequest, NextApiResponse } from "next";
import Redis from "ioredis";
import { createHash } from "crypto";
if (!process.env.UPSTASH_REDIS_URI) throw new Error("Redis URI Not found");
const redis = new Redis(process.env.UPSTASH_REDIS_URI);
type Data = {
  ip: string;
  limit: number;
  remaining: number;
};
type Err = {
  message: string;
  penalty: number;
  reset: string;
};

const MAX_REQUESTS = Number(process.env.MAX_REQUESTS) ?? 15;
const DELAY = Number(process.env.DELAY) ?? 60;
const checkRatelimit = async (ip: string) => {
  const rateLimitKey = createHash("sha256").update(ip).digest("base64");
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const queueLength = await redis.zcount(
    rateLimitKey,
    currentTimestamp - 60,
    currentTimestamp
  );
  if (queueLength < MAX_REQUESTS) {
    await redis.zadd(rateLimitKey, currentTimestamp, currentTimestamp);
    return {
      limit: MAX_REQUESTS,
      remaining: MAX_REQUESTS - queueLength,
      reset: currentTimestamp,
    };
  }
  const largestScoreElement = await redis.zrevrange(rateLimitKey, 0, 0);
  if (
    largestScoreElement.length &&
    Number(largestScoreElement[0]) >= currentTimestamp
  ) {
    return {
      limit: MAX_REQUESTS,
      remaining: 0,
      reset: Number(largestScoreElement[0]),
    };
  }
  const penaltyTimestamp = Number(largestScoreElement[0]) + DELAY;
  await redis.zadd(rateLimitKey, penaltyTimestamp, penaltyTimestamp);
  return {
    limit: MAX_REQUESTS,
    remaining: 0,
    reset: penaltyTimestamp,
  };
};
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data | Err>
) {
  const ip = (req.headers["x-real-ip"] || req.socket.remoteAddress!) as string;
  const rateLimitReached = await checkRatelimit(ip);
  if (!rateLimitReached.remaining) {
    res
      .status(429)
      .setHeader("x-ratelimit-limit", rateLimitReached.limit)
      .setHeader("x-ratelimit-remaining", rateLimitReached.remaining)
      .setHeader("x-ratelimit-reset", rateLimitReached.reset)
      .json({
        ip,
        message: "Too Many Requests",
        penalty: DELAY,
        reset: new Date(rateLimitReached.reset * 1000).toTimeString(),
      });
  } else
    res
      .status(200)
      .setHeader("x-ratelimit-limit", rateLimitReached.limit)
      .setHeader("x-ratelimit-remaining", rateLimitReached.remaining)
      .setHeader("x-ratelimit-reset", rateLimitReached.reset)
      .json({
        ip,
        limit: rateLimitReached.limit,
        remaining: rateLimitReached.remaining - 1,
      });
}
