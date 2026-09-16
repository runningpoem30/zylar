import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { s3Client, dynamoDb } from "../lib/s3-utils.js"
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { spawn, execSync } from "child_process";

// ─── Configuration ───
const JOB_STATUS_TABLE = process.env.JOB_STATUS_TABLE || "zylar-job-status";
const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL || "https://d3qk5a8a9f1q78.cloudfront.net";

// ─── DynamoDB Status Updates ───
async function updateJobStatus(
    jobId: string,
    status: string,
    stage: string,
    progress: number,
    extra: Record<string, any> = {}
) {
    if (!jobId) return;

    try {
        const expressionParts = [
            "#s = :status",
            "stage = :stage",
            "progress = :progress",
            "updatedAt = :now"
        ];
        const attrValues: Record<string, any> = {
            ":status": status,
            ":stage": stage,
            ":progress": progress,
            ":now": new Date().toISOString()
        };
        const attrNames: Record<string, string> = { "#s": "status" };

        // Add any extra fields (e.g., cloudfrontUrl, error)
        for (const [key, value] of Object.entries(extra)) {
            if (key === "error") {
                expressionParts.push("#err = :error");
                attrNames["#err"] = "error";
                attrValues[":error"] = value;
            } else {
                expressionParts.push(`${key} = :${key}`);
                attrValues[`:${key}`] = value;
            }
        }

        await dynamoDb.send(new UpdateCommand({
            TableName: JOB_STATUS_TABLE,
            Key: { jobId },
            UpdateExpression: `SET ${expressionParts.join(", ")}`,
            ExpressionAttributeNames: attrNames,
            ExpressionAttributeValues: attrValues
        }));

        console.log(`[Worker] Status → ${status} | ${stage} | ${progress}%`);
    } catch (err) {
        console.warn(`[Worker] Failed to update status for ${jobId}:`, err);
    }
}


async function downloadFromS3(bucket: string, key: string, destination: string) {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3Client.send(command)

    const stream = response.Body as Readable;
    return new Promise((resolve, reject) => {
        const fileWriter = fs.createWriteStream(destination);
        stream.pipe(fileWriter);
        fileWriter.on('finish', resolve);
        fileWriter.on('error', reject);
    })

}



async function transcodingRawS3Video(inputPath: string, outputDir: string) {
    // Detect audio track
    let hasAudio = false;
    try {
        const probe = execSync(`ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "${inputPath}"`).toString();
        hasAudio = probe.trim().length > 0;
    } catch (e) {
        hasAudio = false;
    }

    return new Promise((resolve, reject) => {
        const args = [
            '-i', inputPath,
            '-filter_complex',
            '[0:v]split=5[v1][v2][v3][v4][v5];' +
            '[v1]scale=1920:1080:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2[v1out];' +
            '[v2]scale=1280:720:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2[v2out];' +
            '[v3]scale=854:480:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2[v3out];' +
            '[v4]scale=640:360:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2[v4out];' +
            '[v5]scale=426:240:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2[v5out]',

            '-map', '[v1out]', '-c:v:0', 'libx264', '-b:v:0', '5000k', '-maxrate:v:0', '5350k', '-bufsize:v:0', '7500k',
            '-map', '[v2out]', '-c:v:1', 'libx264', '-b:v:1', '2800k', '-maxrate:v:1', '2996k', '-bufsize:v:1', '4200k',
            '-map', '[v3out]', '-c:v:2', 'libx264', '-b:v:2', '1400k', '-maxrate:v:2', '1498k', '-bufsize:v:2', '2100k',
            '-map', '[v4out]', '-c:v:3', 'libx264', '-b:v:3', '1000k', '-maxrate:v:3', '1070k', '-bufsize:v:3', '1500k',
            '-map', '[v5out]', '-c:v:4', 'libx264', '-b:v:4', '600k', '-maxrate:v:4', '642k', '-bufsize:v:4', '900k',
        ];

        if (hasAudio) {
            args.push(
                '-map', '0:a', '-c:a:0', 'aac', '-b:a:0', '128k',
                '-map', '0:a', '-c:a:1', 'aac', '-b:a:1', '128k',
                '-map', '0:a', '-c:a:2', 'aac', '-b:a:2', '128k',
                '-map', '0:a', '-c:a:3', 'aac', '-b:a:3', '128k',
                '-map', '0:a', '-c:a:4', 'aac', '-b:a:4', '128k'
            );
        }

        args.push(
            '-f', 'hls',
            '-hls_time', '10',
            '-hls_playlist_type', 'vod',
            '-hls_flags', 'independent_segments',
            '-master_pl_name', 'master.m3u8'
        );

        if (hasAudio) {
            args.push('-var_stream_map', 'v:0,a:0 v:1,a:1 v:2,a:2 v:3,a:3 v:4,a:4');
        } else {
            args.push('-var_stream_map', 'v:0 v:1 v:2 v:3 v:4');
        }

        args.push(
            '-hls_segment_filename', `${outputDir}/v%v/segment_%03d.ts`,
            `${outputDir}/v%v/index.m3u8`
        );

        const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' }); // <--- See FFmpeg logs in CloudWatch

        ffmpeg.on('close', (code) => {
            if (code === 0) resolve(null);
            else reject(`ffmpeg failed with code ${code}`)
        })
    })
}


async function uploadFolderToS3(localDirPath: string, s3Bucket: string, s3Prefix: string) {
    const items = fs.readdirSync(localDirPath);

    for (const item of items) {
        const localPath = path.join(localDirPath, item);
        const s3Key = path.join(s3Prefix, item);

        if (fs.statSync(localPath).isDirectory()) {

            await uploadFolderToS3(localPath, s3Bucket, s3Key);
        } else {

            const fileStream = fs.createReadStream(localPath);
            await s3Client.send(new PutObjectCommand({
                Bucket: s3Bucket,
                Key: s3Key,
                Body: fileStream,

                ContentType: s3Key.endsWith('.m3u8') ? 'application/x-mpegURL' : 'video/MP2T'
            }));
        }
    }
}


async function run() {
    const BUCKET = process.env.S3_BUCKET!;
    const KEY = process.env.S3_KEY!;
    const DEST_BUCKET = process.env.DEST_BUCKET!;
    const JOB_ID = process.env.JOB_ID || "";

    const inputPath = '/tmp/input_video.mp4';
    const outputDir = '/tmp/output';

    try {
        // Create output directory and variant subdirectories for HLS segments
        fs.mkdirSync(outputDir, { recursive: true });
        for (let i = 0; i < 5; i++) {
            fs.mkdirSync(`${outputDir}/v${i}`, { recursive: true });
        }

        // ── Stage 1: Download ──
        await updateJobStatus(JOB_ID, "PROCESSING", "Downloading video from S3", 10);
        console.log("Stage 1: Downloading...");
        await downloadFromS3(BUCKET, KEY, inputPath);

        // ── Stage 2: Transcode ──
        await updateJobStatus(JOB_ID, "PROCESSING", "Transcoding — FFmpeg encoding 5 variants", 30);
        console.log("Stage 2: Transcoding...");
        await transcodingRawS3Video(inputPath, outputDir);

        // ── Stage 3: Upload ──
        await updateJobStatus(JOB_ID, "PROCESSING", "Uploading HLS segments to S3", 75);
        console.log("Stage 3: Uploading to new bucket...");

        const folderName = path.parse(KEY).name;
        await uploadFolderToS3(outputDir, DEST_BUCKET, `processed/${folderName}`);

        // ── Stage 4: Complete ──
        const cloudfrontUrl = `${CLOUDFRONT_URL}/processed/${folderName}/master.m3u8`;
        await updateJobStatus(JOB_ID, "COMPLETED", "Transcoding complete", 100, {
            cloudfrontUrl
        });

        console.log("SUCCESS: Video is now live!");
        console.log(`CloudFront URL: ${cloudfrontUrl}`);

    } catch (err) {
        console.error("FAILED:", err);

        // ── Update status to FAILED ──
        await updateJobStatus(JOB_ID, "FAILED", "Transcoding failed", 0, {
            error: String(err)
        });

        process.exit(1);
    }
}

run();
