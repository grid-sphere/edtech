import { S3Client } from "@aws-sdk/client-s3";
import https from "node:https";
import "dotenv/config";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_ACCOUNT_ID) {
    console.error("❌ Missing R2 credentials in .env file");
    process.exit(1);
}

const r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    forcePathStyle: true,
    maxAttempts: 3,
    /*
     * Raise the connection pool from the SDK's default of 50.
     *
     * Every video segment and PDF is streamed from R2 through this client, so
     * one socket is held for as long as a student is being served a file. Fifty
     * is a fine default for an app that makes short API calls; for one where a
     * class of thirty watching video is normal traffic, it is a ceiling that
     * gets hit on an ordinary evening — and hitting it looks like the site
     * hanging, not like an error, because requests queue rather than fail.
     *
     * This is capacity, not the bug: streams that were never closed used to
     * consume the pool permanently. See pipeStream in utils/helpers.js. Both
     * matter — the leak made the ceiling reachable in a few hours, and the
     * ceiling was too low to begin with.
     */
    requestHandler: {
        httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 200 }),
    },
});

console.log(`✅ R2 configured: bucket=${R2_BUCKET_NAME}`);

export { r2Client, R2_BUCKET_NAME };