import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoDb } from "../lib/s3-utils.js";

// ─── Configuration ───
const JOB_STATUS_TABLE = process.env.JOB_STATUS_TABLE || "zylar-job-status";

/**
 * DLQ Handler Lambda — Processes messages from the Dead Letter Queue.
 * 
 * When a job message fails processing after maxReceiveCount attempts (e.g., 3),
 * SQS moves it to the DLQ. This handler:
 * 
 *  1. Logs the failure with full context for debugging.
 *  2. Updates the job status to FAILED in DynamoDB.
 *  3. (Optional) Could trigger SNS for email/Slack alerts.
 *  4. (Optional) Could clean up orphaned S3 objects from partial uploads.
 * 
 * DLQ Configuration (on the Job Queue):
 *   - deadLetterTargetArn: arn:aws:sqs:us-east-1:ACCOUNT:zylar-job-dlq
 *   - maxReceiveCount: 3
 */
export const handler = async (event: any) => {
    for (const record of event.Records) {
        let job: any;

        try {
            job = JSON.parse(record.body);
        } catch {
            console.error("[DLQ] Failed to parse message body:", record.body);
            continue;
        }

        const { jobId, s3Bucket, s3Key, submittedAt } = job;

        console.error(`[DLQ] ══════════════════════════════════════════`);
        console.error(`[DLQ] FAILED JOB: ${jobId}`);
        console.error(`[DLQ]   Source: s3://${s3Bucket}/${s3Key}`);
        console.error(`[DLQ]   Submitted: ${submittedAt}`);
        console.error(`[DLQ]   Failed at: ${new Date().toISOString()}`);
        console.error(`[DLQ]   Receive count: ${record.attributes?.ApproximateReceiveCount}`);
        console.error(`[DLQ]   Message ID: ${record.messageId}`);
        console.error(`[DLQ] ══════════════════════════════════════════`);

        // ── Update DynamoDB status to FAILED ──
        if (jobId) {
            try {
                await dynamoDb.send(new UpdateCommand({
                    TableName: JOB_STATUS_TABLE,
                    Key: { jobId },
                    UpdateExpression: "SET #s = :status, stage = :stage, #err = :error, updatedAt = :now",
                    ExpressionAttributeNames: { "#s": "status", "#err": "error" },
                    ExpressionAttributeValues: {
                        ":status": "FAILED",
                        ":stage": "Exceeded max retry attempts",
                        ":error": `Job failed after ${record.attributes?.ApproximateReceiveCount || 'unknown'} attempts. Check CloudWatch logs for details.`,
                        ":now": new Date().toISOString()
                    }
                }));
                console.log(`[DLQ] Updated job ${jobId} status to FAILED in DynamoDB`);
            } catch (err) {
                console.error(`[DLQ] Failed to update DynamoDB for job ${jobId}:`, err);
            }
        }

        // ── Optional: Send SNS notification for alerting ──
        // Uncomment and configure when SNS topic is set up:
        //
        // import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
        // const snsClient = new SNSClient({ region: "us-east-1" });
        // await snsClient.send(new PublishCommand({
        //     TopicArn: process.env.ALERT_TOPIC_ARN,
        //     Subject: `[Zylar] Transcode Job Failed: ${jobId}`,
        //     Message: JSON.stringify({ jobId, s3Bucket, s3Key, submittedAt }, null, 2)
        // }));

        // ── Optional: Clean up orphaned S3 objects ──
        // If a partial transcode left files in the dest bucket, clean them up here.
        // import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
    }

    console.log(`[DLQ] Processed ${event.Records.length} failed job(s)`);
};
