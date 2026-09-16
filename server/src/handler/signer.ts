import { s3Client, dynamoDb } from "../lib/s3-utils.js";
import { PutObjectCommand, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import crypto from "crypto";

// ─── Rate Limiting (Token Bucket via DynamoDB) ───
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE || "zylar-rate-limits";
const MAX_REQUESTS = 5;          // 5 uploads per window
const WINDOW_SECONDS = 60;       // 1-minute sliding window

async function checkRateLimit(sourceIp: string): Promise<{ allowed: boolean; retryAfter?: number }> {
    const now = Math.floor(Date.now() / 1000);

    try {
        const result = await dynamoDb.send(new GetCommand({
            TableName: RATE_LIMIT_TABLE,
            Key: { pk: `IP#${sourceIp}` }
        }));

        const item = result.Item;

        if (!item || (now - item.windowStart) >= WINDOW_SECONDS) {
            // No record or window expired — reset the bucket
            await dynamoDb.send(new PutCommand({
                TableName: RATE_LIMIT_TABLE,
                Item: {
                    pk: `IP#${sourceIp}`,
                    requestCount: 1,
                    windowStart: now,
                    ttl: now + WINDOW_SECONDS * 2   // Auto-cleanup via DynamoDB TTL
                }
            }));
            return { allowed: true };
        }

        if (item.requestCount >= MAX_REQUESTS) {
            const retryAfter = WINDOW_SECONDS - (now - item.windowStart);
            return { allowed: false, retryAfter };
        }

        // Increment counter
        await dynamoDb.send(new UpdateCommand({
            TableName: RATE_LIMIT_TABLE,
            Key: { pk: `IP#${sourceIp}` },
            UpdateExpression: "SET requestCount = requestCount + :inc",
            ExpressionAttributeValues: { ":inc": 1 }
        }));

        return { allowed: true };
    } catch (err) {
        // If rate limit check fails, allow the request (fail-open)
        console.warn("Rate limit check failed, allowing request:", err);
        return { allowed: true };
    }
}

// ─── Job Status Initialization (DynamoDB) ───
const JOB_STATUS_TABLE = process.env.JOB_STATUS_TABLE || "zylar-job-status";

async function createJobEntry(jobId: string, fileName: string, s3Key: string): Promise<void> {
    await dynamoDb.send(new PutCommand({
        TableName: JOB_STATUS_TABLE,
        Item: {
            jobId,
            status: "PENDING",
            stage: "Upload pending",
            progress: 0,
            fileName,
            s3Key,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + 86400 * 7  // 7-day TTL
        }
    }));
}

// ─── Main Handler ───
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token"
    };

    // Robust check for HTTP Method (Works for REST and HTTP APIs)
    const method = event.httpMethod || (event as any).requestContext?.http?.method;

    if (method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ""
        };
    }

    try {
        // ── Rate Limiting ──
        const sourceIp = event.requestContext?.identity?.sourceIp
            || (event as any).requestContext?.http?.sourceIp
            || "unknown";

        const rateCheck = await checkRateLimit(sourceIp);
        if (!rateCheck.allowed) {
            return {
                statusCode: 429,
                headers: {
                    ...headers,
                    "Retry-After": String(rateCheck.retryAfter || 60)
                },
                body: JSON.stringify({
                    error: "Rate limit exceeded. Too many upload requests.",
                    retryAfter: rateCheck.retryAfter
                })
            };
        }

        // ── Presigned URL Generation ──
        const body = event.body ? JSON.parse(event.body) : {};
        const { fileName, contentType } = body;

        if (!fileName) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "fileName is required" })
            };
        }

        const jobId = crypto.randomUUID();
        const key = `video-uploads/${Date.now()}-${fileName}`;

        const input: PutObjectCommandInput = {
            Bucket: process.env.S3_BUCKET || process.env.BUCKET,
            Key: key,
            ContentType: contentType
        };

        const command = new PutObjectCommand(input);
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

        // ── Create initial job status entry in DynamoDB ──
        await createJobEntry(jobId, fileName, key);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                uploadUrl: url,
                key: key,
                jobId: jobId
            })
        };

    } catch (e) {
        console.error(`Error generating URL: ${e}`);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: "Could not generate upload URL" })
        };
    }
};
