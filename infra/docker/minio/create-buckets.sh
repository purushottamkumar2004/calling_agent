#!/bin/sh
# Creates the recordings bucket in local MinIO. Idempotent; safe to re-run.
set -eu
for i in $(seq 1 30); do
  if aws --endpoint-url "$S3_ENDPOINT" s3api list-buckets >/dev/null 2>&1; then
    break
  fi
  echo "waiting for minio ($i/30)..."
  sleep 2
done

if aws --endpoint-url "$S3_ENDPOINT" s3api head-bucket --bucket "$S3_BUCKET" >/dev/null 2>&1; then
  echo "bucket '$S3_BUCKET' already exists"
else
  aws --endpoint-url "$S3_ENDPOINT" s3api create-bucket --bucket "$S3_BUCKET"
  echo "created bucket '$S3_BUCKET' (private by default)"
fi
