"""Artifact store port: upload/download test bundles to/from S3 (LocalStack).

Two adapters:
  - S3ArtifactStore: real boto3 upload/download
  - InMemoryArtifactStore: dict-backed for tests/offline
"""
from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

logger = logging.getLogger(__name__)


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
        with open(file_path, encoding="utf-8") as f:
            return f.read()

    def exists(self, key: str) -> bool:
        import os
        file_path = os.path.join(self._fallback_dir, key)
        return os.path.exists(file_path)


class ArtifactStoreUnavailable(RuntimeError):
    """S3 could not be reached and local fallback is not permitted."""


class S3ArtifactStore:
    """Live adapter — uploads to S3 via boto3.

    Connects lazily. On missing boto3 or an unreachable S3 after exponential
    backoff, behaviour depends on ``allow_local_fallback``.

    ── Why the fallback is not unconditional ────────────────────────────
    Every failure path here used to silently divert to LocalFileArtifactStore.
    On one developer machine that is a convenience. Across a Deployment with
    two or more replicas it is data loss with no error attached: the artifact
    lands on whichever pod happened to serve the request, on a filesystem that
    is wiped when the pod restarts, and a later read routed to a different
    replica reports the object simply does not exist. Nothing logs a problem,
    because from the store's point of view nothing failed.

    So the fallback is now opt-in. Development keeps it (that is what makes
    the stack runnable without LocalStack); production must set
    ALLOW_LOCAL_ARTIFACT_FALLBACK explicitly to get the old behaviour, and
    otherwise gets a loud ArtifactStoreUnavailable instead of a quiet
    write-to-nowhere.
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
        allow_local_fallback: bool = True,
        connect_timeout: float = 5.0,
        read_timeout: float = 15.0,
    ) -> None:
        self._endpoint_url = endpoint_url
        self._bucket = bucket
        self._region = region
        self._access_key = access_key
        self._secret_key = secret_key
        self._max_retries = max_retries
        self._allow_local_fallback = allow_local_fallback
        self._connect_timeout = connect_timeout
        self._read_timeout = read_timeout
        self._client = None
        self._fallback = LocalFileArtifactStore(fallback_dir)

    def _refuse_fallback(self, operation: str, key: str) -> ArtifactStoreUnavailable:
        return ArtifactStoreUnavailable(
            f"S3 {operation} failed for '{key}' against bucket "
            f"'{self._bucket}' at {self._endpoint_url}, and local disk fallback "
            "is disabled. Writing to a pod's ephemeral filesystem would lose the "
            "artifact silently. Fix the S3 configuration, or set "
            "ALLOW_LOCAL_ARTIFACT_FALLBACK=true to accept that risk."
        )

    def _ensure_client(self) -> bool:
        if self._client is not None:
            return True
        try:  # pragma: no cover — boto3 + LocalStack only
            import boto3
            from botocore.config import Config
            from botocore.exceptions import ClientError

            # Explicit timeouts. boto3 defaults to a 60s connect and 60s read
            # with its own internal retries on top, so an S3 endpoint that
            # black-holes packets would stall a request-handling thread for
            # minutes while the caller waits. This store already implements
            # its own bounded retry loop in upload(), so botocore's is turned
            # down to one attempt rather than compounding with it.
            client = boto3.client(
                "s3",
                endpoint_url=self._endpoint_url,
                region_name=self._region,
                aws_access_key_id=self._access_key,
                aws_secret_access_key=self._secret_key,
                config=Config(
                    connect_timeout=self._connect_timeout,
                    read_timeout=self._read_timeout,
                    retries={"max_attempts": 1, "mode": "standard"},
                ),
            )
            try:
                client.head_bucket(Bucket=self._bucket)
            except ClientError as err:
                error_code = err.response.get("Error", {}).get("Code")
                if error_code not in ("404", "NoSuchBucket"):
                    raise
                # LocalStack starts every container restart with no buckets
                # (PERSISTENCE is not enabled) and nothing re-runs compose's
                # one-shot bucket-creation step when only the localstack
                # container itself bounces -- every previously-generated
                # hidden-test bundle then silently vanishes with it, and the
                # next fetch looked like a dead S3 endpoint rather than an
                # empty one. Recreating it here is safe and idempotent: a
                # bucket that already exists is a no-op, and a production
                # caller without CreateBucket permission fails exactly as it
                # did before this branch existed.
                logger.warning(
                    "artifact_store: bucket %r missing at %s, recreating",
                    self._bucket,
                    self._endpoint_url,
                )
                client.create_bucket(Bucket=self._bucket)
            self._client = client
            return True
        except Exception as err:
            logger.error(
                "artifact_store: could not reach S3 at %s for bucket %r: %s",
                self._endpoint_url,
                self._bucket,
                err,
            )
            self._client = None
            return False

    def upload(self, key: str, body: str, content_type: str = "text/plain") -> str:
        import time

        if not self._ensure_client():
            if not self._allow_local_fallback:
                raise self._refuse_fallback("connect", key)
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

        # Upload is the operation where a silent fallback actually destroys
        # data: the caller is told the artifact was stored and gets a URL back.
        if not self._allow_local_fallback:
            raise self._refuse_fallback("upload", key)
        return self._fallback.upload(key, body, content_type)

    def download(self, key: str) -> str | None:
        if not self._ensure_client():
            if not self._allow_local_fallback:
                raise self._refuse_fallback("connect", key)
            return self._fallback.download(key)
        try:  # pragma: no cover — live S3 only
            resp = self._client.get_object(Bucket=self._bucket, Key=key)
            return resp["Body"].read().decode("utf-8")
        except Exception:
            if not self._allow_local_fallback:
                # Distinct from "the object does not exist", which is a
                # legitimate None. Reading through to local disk would answer
                # None for an object that is present in S3 but temporarily
                # unreachable, and the caller cannot tell those apart.
                raise self._refuse_fallback("download", key) from None
            return self._fallback.download(key)

    def exists(self, key: str) -> bool:
        if not self._ensure_client():
            if not self._allow_local_fallback:
                raise self._refuse_fallback("connect", key)
            return self._fallback.exists(key)
        try:  # pragma: no cover — live S3 only
            self._client.head_object(Bucket=self._bucket, Key=key)
            return True
        except Exception:
            return False

