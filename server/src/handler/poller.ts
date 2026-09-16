import { RunTaskCommand, ListTasksCommand, type RunTaskCommandInput } from "@aws-sdk/client-ecs";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ecsClient, dynamoDb } from "../lib/s3-utils.js";

// ─── Configuration ───
const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || "10");
const JOB_STATUS_TABLE = process.env.JOB_STATUS_TABLE || "zylar-job-status";
const CLUSTER = process.env.CLUSTER || "zylar-cluster-final";
const TASK_DEFINITION = process.env.TASK_DEFINITION || "latest-task-definition";
const SUBNETS = process.env.SUBNETS?.split(',') || [];
const SECURITY_GROUPS = process.env.SECURITY_GROUPS?.split(',') || [];

/**
 * Poller Lambda — Consumes from the Job Queue SQS with concurrency control.
 * 
 * Before launching a new ECS Fargate task, it checks the current number of
 * running tasks in the cluster. If at capacity, the message is NOT deleted
 * from SQS (by throwing an error), so it will reappear after the visibility
 * timeout for retry.
 * 
 * This Lambda should have `reservedConcurrency: 10` set in its configuration
 * for an additional layer of protection against task explosion.
 * 
 * Flow: Job Queue SQS → THIS LAMBDA → ECS Fargate
 */
export const handler = async (event: any) => {
    for (const record of event.Records) {
        const job = JSON.parse(record.body);
        const { jobId, s3Bucket, s3Key, destBucket } = job;

        console.log(`[Poller] Processing job ${jobId}: s3://${s3Bucket}/${s3Key}`);

        try {
            // ── Check current Fargate task count ──
            const runningTasks = await ecsClient.send(new ListTasksCommand({
                cluster: CLUSTER,
                desiredStatus: "RUNNING"
            }));

            const currentCount = runningTasks.taskArns?.length || 0;
            console.log(`[Poller] Current running tasks: ${currentCount}/${MAX_CONCURRENT_TASKS}`);

            if (currentCount >= MAX_CONCURRENT_TASKS) {
                console.log(`[Poller] At capacity. Job ${jobId} will be retried after visibility timeout.`);
                // Throw to prevent SQS from deleting the message — it will retry
                throw new Error(`CAPACITY_FULL: ${currentCount}/${MAX_CONCURRENT_TASKS} tasks running`);
            }

            // ── Launch ECS Fargate Task ──
            const input: RunTaskCommandInput = {
                cluster: CLUSTER,
                taskDefinition: TASK_DEFINITION,
                launchType: "FARGATE",
                networkConfiguration: {
                    awsvpcConfiguration: {
                        subnets: SUBNETS,
                        securityGroups: SECURITY_GROUPS,
                        assignPublicIp: "ENABLED",
                    },
                },
                overrides: {
                    containerOverrides: [
                        {
                            name: "zylar-transcoder",
                            environment: [
                                { name: "S3_BUCKET", value: s3Bucket },
                                { name: "S3_KEY", value: s3Key },
                                { name: "DEST_BUCKET", value: destBucket },
                                { name: "JOB_ID", value: jobId },
                                { name: "JOB_STATUS_TABLE", value: JOB_STATUS_TABLE },
                            ],
                        },
                    ],
                },
            };

            const command = new RunTaskCommand(input);
            const result = await ecsClient.send(command);

            const taskArn = result.tasks?.[0]?.taskArn || "unknown";
            console.log(`[Poller] Launched Fargate task: ${taskArn} for job ${jobId}`);

            // ── Update job status to PROCESSING ──
            await dynamoDb.send(new UpdateCommand({
                TableName: JOB_STATUS_TABLE,
                Key: { jobId },
                UpdateExpression: "SET #s = :status, stage = :stage, taskArn = :taskArn, updatedAt = :now",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: {
                    ":status": "PROCESSING",
                    ":stage": "Container launching",
                    ":taskArn": taskArn,
                    ":now": new Date().toISOString()
                }
            }));

        } catch (err: any) {
            if (err.message?.startsWith("CAPACITY_FULL")) {
                throw err;  // Re-throw capacity errors for SQS retry
            }

            console.error(`[Poller] Failed to launch task for job ${jobId}:`, err);

            // Update status to FAILED
            await dynamoDb.send(new UpdateCommand({
                TableName: JOB_STATUS_TABLE,
                Key: { jobId },
                UpdateExpression: "SET #s = :status, stage = :stage, #err = :error, updatedAt = :now",
                ExpressionAttributeNames: { "#s": "status", "#err": "error" },
                ExpressionAttributeValues: {
                    ":status": "FAILED",
                    ":stage": "Failed to launch container",
                    ":error": err.message || "Unknown error",
                    ":now": new Date().toISOString()
                }
            }));

            throw err;  // Let it go to DLQ after max retries
        }
    }
};
