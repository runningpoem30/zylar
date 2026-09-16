import { S3Client } from "@aws-sdk/client-s3";
import { ECSClient } from "@aws-sdk/client-ecs";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const region = process.env.AWS_REGION || "us-east-1";

export const s3Client = new S3Client({ region });
export const ecsClient = new ECSClient({ region });
export const sqsClient = new SQSClient({ region });

const ddbClient = new DynamoDBClient({ region });
export const dynamoDb = DynamoDBDocumentClient.from(ddbClient);