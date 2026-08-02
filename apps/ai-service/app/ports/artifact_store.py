"""Artifact store port: upload/download test bundles to/from S3 (LocalStack).

Two adapters:
  - S3ArtifactStore: real boto3 upload/download
  - InMemoryArtifactStore: dict-backed for tests/offline
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class ArtifactStore(Protocol):
    """Upload a string payload to a key; return a presigned URL or s3:// URI."""

    def upload(self, key: str, body: str, content_type: str = "text/plain") -> str:
        """Upload body to key; return a URL (presigned or s3://)."""
        ...

    def download(self, key: str) -> str | None:
        ...

    def exists(self, key: str) -> bool:
        ...


class InMemoryArtifactStore:
    """Process-local dict store for tests."""

    def __init__(self) -> None:
        self._data: dict[str, str] = {}

    def upload(self, key: str, body: str, content_type: str = "text/plain") -> str:
        self._data[key] = body
        return f"in-memory://{key}"

    def download(self, key: str) -> str | None:
        return self._data.get(key)

    def exists(self, key: str) -> bool:
        return key in self._data


class LocalFileArtifactStore:
    """Local disk volume fallback when S3 is unavailable (S3_FALLBACK_DIR)."""

    def __init__(self, fallback_dir: str = "./storage_fallback") -> None:
        import os
        self._fallback_dir = os.path.abspath(fallback_dir)

    def upload(self, key: str, body: str, content_type: str = "text/plain") -> str:
        import os
        file_path = os.path.join(self._fallback_dir, key)
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(body)
        normalized_path = file_path.replace("\\", "/")
        return f"file://{normalized_path}"

    def download(self, key: str) -> str | None:
        import os
        file_path = os.path.join(self._fallback_dir, key)
        if not os.path.exists(file_path):
            return None
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()

    def exists(self, key: str) -> bool:
        import os
        file_path = os.path.join(self._fallback_dir, key)
        return os.path.exists(file_path)


class S3ArtifactStore:
    """Live adapter — uploads to S3 via boto3.

    Connects lazily; falls back to LocalFileArtifactStore on missing boto3
    or S3 unreachable after exponential backoff retries.
    """

    def __init__(
        self,
        endpoint_url: str,
        bucket: str,
        region: str = "us-east-1",
        access_key: str = "test",
        secret_key: str = "test",
        fallback_dir: str = "./storage_fallback",
        max_retries: int = 3,
    ) -> None:
        self._endpoint_url = endpoint_url
        self._bucket = bucket
        self._region = region
        self._access_key = access_key
        self._secret_key = secret_key
        self._max_retries = max_retries
        self._client = None
        self._fallback = LocalFileArtifactStore(fallback_dir)

    def _ensure_client(self) -> bool:
        if self._client is not None:
            return True
        try:  # pragma: no cover — boto3 + LocalStack only
            import boto3

            self._client = boto3.client(
                "s3",
                endpoint_url=self._endpoint_url,
                region_name=self._region,
                aws_access_key_id=self._access_key,
                aws_secret_access_key=self._secret_key,
            )
            self._client.head_bucket(Bucket=self._bucket)
            return True
        except Exception:
            self._client = None
            return False

    def upload(self, key: str, body: str, content_type: str = "text/plain") -> str:
        import time

        if not self._ensure_client():
            return self._fallback.upload(key, body, content_type)

        base_delay = 0.1
        for attempt in range(1, self._max_retries + 1):
            try:  # pragma: no cover — live S3 only
                self._client.put_object(
                    Bucket=self._bucket, Key=key, Body=body.encode("utf-8"), ContentType=content_type
                )
                return f"s3://{self._bucket}/{key}"
            except Exception:
                if attempt == self._max_retries:
                    break
                time.sleep(base_delay * (2 ** (attempt - 1)))

        return self._fallback.upload(key, body, content_type)

    def download(self, key: str) -> str | None:
        if not self._ensure_client():
            return self._fallback.download(key)
        try:  # pragma: no cover — live S3 only
            resp = self._client.get_object(Bucket=self._bucket, Key=key)
            return resp["Body"].read().decode("utf-8")
        except Exception:
            return self._fallback.download(key)

    def exists(self, key: str) -> bool:
        if not self._ensure_client():
            return self._fallback.exists(key)
        try:  # pragma: no cover — live S3 only
            self._client.head_object(Bucket=self._bucket, Key=key)
            return True
        except Exception:
            return False

