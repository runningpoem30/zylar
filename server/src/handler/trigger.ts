import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { sqsClient, dynamoDb } from "../lib/s3-utils.js";

// ─── Configuration ───
const JOB_QUEUE_URL = process.env.JOB_QUEUE_URL || "";
const JOB_STATUS_TABLE = process.env.JOB_STATUS_TABLE || "zylar-job-status";

/**
 * Trigger Lambda — Invoked by the S3 Event Queue (SQS).
 * 
 * Instead of directly calling ECS RunTask (which has no concurrency control),
 * this Lambda enriches the message with metadata and forwards it to a
 * dedicated Job Queue. A separate Poller Lambda consumes from this queue
 * with concurrency limits to launch ECS Fargate tasks safely.
 * 
 * Flow: S3 → Event SQS → THIS LAMBDA → Job Queue SQS → Poller Lambda → ECS
 */
export const handler = async (event: any) => {
    try {
        for (const sqsRecord of event.Records) {
            const s3Event = JSON.parse(sqsRecord.body);

            const bucket = s3Event.Records[0].s3.bucket.name;
            const key = decodeURIComponent(
                s3Event.Records[0].s3.object.key.replace(/\+/g, ' ')
            );
            const fileSize = s3Event.Records[0].s3.object.size || 0;

            console.log(`[Trigger] Queuing transcode job for: s3://${bucket}/${key}`);

            // Extract jobId from the key pattern: video-uploads/{timestamp}-{fileName}
            // The jobId was stored in DynamoDB by the signer with the s3Key
            const jobId = sqsRecord.messageAttributes?.jobId?.stringValue || `job-${Date.now()}`;

            // ── Send to Job Queue for controlled processing ──
            await sqsClient.send(new SendMessageCommand({
                QueueUrl: JOB_QUEUE_URL,
                MessageBody: JSON.stringify({
                    jobId,
                    s3Bucket: bucket,
                    s3Key: key,
                    fileSize,
                    submittedAt: new Date().toISOString(),
                    destBucket: process.env.DEST_BUCKET || "zylar.space.destbucket"
                }),
                MessageAttributes: {
                    jobId: {
                        DataType: "String",
                        StringValue: jobId
                    }
                },
                // Deduplication: prevent the same video from being queued twice
                MessageGroupId: key.replace(/[^a-zA-Z0-9-_]/g, "_"),
            }));

            // ── Update job status to QUEUED ──
            try {
                await dynamoDb.send(new UpdateCommand({
                    TableName: JOB_STATUS_TABLE,
                    Key: { jobId },
                    UpdateExpression: "SET #s = :status, stage = :stage, updatedAt = :now",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: {
                        ":status": "QUEUED",
                        ":stage": "Waiting in job queue",
                        ":now": new Date().toISOString()
                    }
                }));
            } catch (statusErr) {
                console.warn("[Trigger] Failed to update job status, continuing:", statusErr);
            }

            console.log(`[Trigger] Job ${jobId} queued successfully`);
        }
    } catch (e) {
        console.error("[Trigger] Error:", e);
        throw e;  // Throw to let SQS retry via visibility timeout
    }
};
