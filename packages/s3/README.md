# dsh-s3

**English** | [中文](README.zh.md)

S3-compatible object storage browser for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Entry: **S3** in the web sidebar.

## Capabilities

| Surface | Behavior |
|---|---|
| Connections | Bucket, endpoint, region, access keys, path style and optional prefix |
| Objects | Browse, upload, download, preview, rename and delete |
| Sharing | Expiring presigned links |
| Agent | `s3_buckets`, `s3_list`, `s3_stat`, `s3_get`, `s3_put`, `s3_upload`, `s3_download`, `s3_copy`, `s3_presign`, `s3_mkdir`, `s3_delete` |

Supported endpoints include AWS S3, MinIO, Alibaba OSS, Tencent COS, Cloudflare R2 and Backblaze B2. The AWS SDK is bundled.

## Installation

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-s3-<version>.tgz
```

Artifacts: [dsh-toolkit releases](https://github.com/Onenightcarnival/dsh-toolkit/releases). The standalone plugin and the toolkit package are mutually exclusive.

## Data and access

| Boundary | Contract |
|---|---|
| Storage | `~/.dsh/dsh-s3.json`, mode `0600` |
| Credentials | Host-only; secret values excluded from browser and agent responses |
| HTTP | Loopback, same-origin marker and GUI session cookie required |
| Scope | Configured prefix applies to browsing and agent tools |
| Deletes | `s3_delete` requires `confirm=true` |

Detailed configuration and development: [Chinese guide](README.zh.md).

## License

MIT
