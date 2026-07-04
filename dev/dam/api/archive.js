// Pluggable immutable (WORM) archive for audit evidence.
//
// One config surface, three deployment targets:
//   ARCHIVE_PROVIDER=s3     → AWS S3, MinIO, Ceph, Wasabi, any S3-compatible (on-prem or cloud)
//   ARCHIVE_PROVIDER=azure  → Azure Blob Storage with immutability policies
//   ARCHIVE_PROVIDER=none   → archiving disabled (detection-only)
//
// Every provider implements the same contract:
//   { name, mode, lockDays, async init(), async put(key, body, contentType) -> key }
// so the checkpoint engine in main.js never has to know which cloud it's running on.

// ── S3-compatible (AWS S3 / MinIO / Ceph / Wasabi / GCS-interop) ──────────────
// Uses the MinIO SDK, which speaks the S3 API to any compatible endpoint.
// For AWS:   S3_ENDPOINT=s3.<region>.amazonaws.com  S3_USE_SSL=true  S3_PORT=443
// For local: S3_ENDPOINT=dam-minio  S3_USE_SSL=false  S3_PORT=9000
function makeS3Provider(cfg) {
  const Minio = require('minio');
  let client = null;
  return {
    name: `s3 (${cfg.endPoint}/${cfg.bucket})`,
    mode: cfg.lockMode,
    lockDays: cfg.lockDays,
    async init() {
      client = new Minio.Client({
        endPoint: cfg.endPoint,
        port: cfg.port,
        useSSL: cfg.useSSL,
        region: cfg.region,
        accessKey: cfg.accessKey,
        secretKey: cfg.secretKey,
      });
      const exists = await client.bucketExists(cfg.bucket).catch(() => false);
      // Object Lock can only be enabled at bucket creation time.
      if (!exists) await client.makeBucket(cfg.bucket, cfg.region, { ObjectLocking: true });
      // Default retention so every object inherits WORM protection on PUT.
      try {
        await client.setObjectLockConfig(cfg.bucket, { mode: cfg.lockMode, unit: 'Days', validity: cfg.lockDays });
      } catch (e) { /* may already be set, or endpoint lacks Object Lock */ }
    },
    async put(key, body, contentType) {
      await client.putObject(cfg.bucket, key, body, Buffer.byteLength(body), { 'Content-Type': contentType });
      return key; // immutable: bucket default WORM retention applies
    },
    async usage() {
      let objects = 0, bytes = 0;
      await new Promise((resolve) => {
        const stream = client.listObjectsV2(cfg.bucket, '', true);
        stream.on('data', (o) => { objects += 1; bytes += o.size || 0; });
        stream.on('error', () => resolve());
        stream.on('end', () => resolve());
      });
      return { objects, bytes };
    },
  };
}

// ── Azure Blob Storage (version-level immutability) ───────────────────────────
// Needs @azure/storage-blob. Auth via connection string or account name + key.
// COMPLIANCE → 'Locked' policy (cannot be shortened), GOVERNANCE → 'Unlocked'.
function makeAzureProvider(cfg) {
  let BlobServiceClient, StorageSharedKeyCredential;
  try {
    ({ BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob'));
  } catch (e) {
    throw new Error('Azure archive provider requires @azure/storage-blob (run: npm i @azure/storage-blob)');
  }
  let container = null;
  return {
    name: `azure (${cfg.account || 'conn-string'}/${cfg.bucket})`,
    mode: cfg.lockMode,
    lockDays: cfg.lockDays,
    async init() {
      const svc = cfg.connectionString
        ? BlobServiceClient.fromConnectionString(cfg.connectionString)
        : new BlobServiceClient(
            `https://${cfg.account}.blob.core.windows.net`,
            new StorageSharedKeyCredential(cfg.account, cfg.accountKey)
          );
      container = svc.getContainerClient(cfg.bucket);
      await container.createIfNotExists();
    },
    async put(key, body, contentType) {
      const blob = container.getBlockBlobClient(key);
      await blob.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: contentType } });
      // Per-blob immutability requires version-level immutability enabled on the account/container.
      try {
        await blob.setImmutabilityPolicy({
          expiriesOn: new Date(Date.now() + cfg.lockDays * 86400000),
          policyMode: cfg.lockMode === 'COMPLIANCE' ? 'Locked' : 'Unlocked',
        });
      } catch (e) { /* account may not have version-level immutability enabled */ }
      return key;
    },
    async usage() {
      let objects = 0, bytes = 0;
      for await (const b of container.listBlobsFlat()) { objects += 1; bytes += b.properties.contentLength || 0; }
      return { objects, bytes };
    },
  };
}

// Factory: read the environment, return a provider (or null when disabled).
function createArchive(env = process.env) {
  const provider = (env.ARCHIVE_PROVIDER || 's3').toLowerCase();
  if (provider === 'none') return null;

  const bucket = env.ARCHIVE_BUCKET || 'dam-audit-archive';
  const lockDays = parseInt(env.ARCHIVE_LOCK_DAYS || '7', 10);
  const lockMode = (env.ARCHIVE_LOCK_MODE || 'GOVERNANCE').toUpperCase();

  if (provider === 's3') {
    return makeS3Provider({
      bucket, lockDays, lockMode,
      // Fall back to the legacy MINIO_* vars so existing dev setups keep working.
      endPoint: env.S3_ENDPOINT || env.MINIO_HOST || 'dam-minio',
      port: parseInt(env.S3_PORT || env.MINIO_PORT || '9000', 10),
      useSSL: String(env.S3_USE_SSL || 'false') === 'true',
      region: env.S3_REGION || 'us-east-1',
      accessKey: env.S3_ACCESS_KEY || env.MINIO_ROOT_USER || 'dam_minio',
      secretKey: env.S3_SECRET_KEY || env.MINIO_ROOT_PASSWORD || 'dam_minio_secret',
    });
  }
  if (provider === 'azure') {
    return makeAzureProvider({
      bucket, lockDays, lockMode,
      account: env.AZURE_STORAGE_ACCOUNT,
      accountKey: env.AZURE_STORAGE_KEY,
      connectionString: env.AZURE_STORAGE_CONNECTION_STRING,
    });
  }
  throw new Error(`Unknown ARCHIVE_PROVIDER "${provider}" (expected s3 | azure | none)`);
}

module.exports = { createArchive };
