import { Router } from 'express';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const router = Router();

// ─── DynamoDB Client ───
const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const dynamoDb = DynamoDBDocumentClient.from(ddbClient);
const JOB_STATUS_TABLE = process.env.JOB_STATUS_TABLE || 'zylar-job-status';

/**
 * GET /api/status/:jobId
 * 
 * Queries DynamoDB for real-time job status.
 * Called by the frontend to poll transcoding progress.
 * 
 * Response shape:
 * {
 *   jobId: string,
 *   status: "PENDING" | "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED",
 *   stage: string,          // Human-readable stage description
 *   progress: number,       // 0-100
 *   cloudfrontUrl?: string,  // Only present when COMPLETED
 *   error?: string,          // Only present when FAILED
 *   createdAt: string,
 *   updatedAt: string
 * }
 */
router.get('/:jobId', async (req: any, res: any) => {
    try {
        const { jobId } = req.params;

        if (!jobId) {
            return res.status(400).json({ error: 'jobId is required' });
        }

        const result = await dynamoDb.send(new GetCommand({
            TableName: JOB_STATUS_TABLE,
            Key: { jobId }
        }));

        if (!result.Item) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const { status, stage, progress, cloudfrontUrl, error, fileName, createdAt, updatedAt } = result.Item;

        return res.json({
            jobId,
            status,
            stage,
            progress: progress || 0,
            cloudfrontUrl: cloudfrontUrl || null,
            error: error || null,
            fileName: fileName || null,
            createdAt,
            updatedAt
        });

    } catch (err) {
        console.error('Status check error:', err);
        return res.status(500).json({ error: 'Failed to fetch job status' });
    }
});

export default router;
