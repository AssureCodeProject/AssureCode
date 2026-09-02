"""S3ArtifactStore fallback behaviour.

The store used to divert to local disk on every S3 failure, unconditionally.
Across replicas that is silent data loss: the write lands on one pod's
ephemeral filesystem, the caller is handed a URL and told it succeeded, and a
later read routed elsewhere reports the object does not exist.

These tests pin both halves — that development still gets the convenience
fallback, and that production refuses it.
"""

from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from app.ports.artifact_store import (
    ArtifactStoreUnavailable,
    LocalFileArtifactStore,
    S3ArtifactStore,
)


def make_store(tmp_path, *, allow_fallback: bool) -> S3ArtifactStore:
    """A store pointed at an endpoint nothing is listening on.

    `_ensure_client` therefore fails, which is the same code path as a
    misconfigured bucket or a network partition in production.
    """
    return S3ArtifactStore(
        endpoint_url="http://127.0.0.1:1",  # nothing listens here
        bucket="assurecode-test",
        fallback_dir=str(tmp_path),
        max_retries=1,
        allow_local_fallback=allow_fallback,
        # Without these the suite takes ~150s: botocore's defaults are a 60s
        # connect timeout with its own retries layered on top.
        connect_timeout=0.05,
        read_timeout=0.05,
    )


class TestFallbackAllowed:
    """Development posture: unreachable S3 quietly uses local disk."""

    def test_upload_writes_to_local_disk(self, tmp_path):
        store = make_store(tmp_path, allow_fallback=True)
        url = store.upload("contracts/AC-1/tests.js", "console.log(1)")

        assert url.startswith("file://")
        assert (tmp_path / "contracts" / "AC-1" / "tests.js").read_text(
            encoding="utf-8"
        ) == "console.log(1)"

    def test_download_reads_back_what_upload_wrote(self, tmp_path):
        store = make_store(tmp_path, allow_fallback=True)
        store.upload("k", "payload")

        assert store.download("k") == "payload"

    def test_missing_key_is_none_not_an_error(self, tmp_path):
        store = make_store(tmp_path, allow_fallback=True)

        assert store.download("never-written") is None


class TestFallbackRefused:
    """Production posture: unreachable S3 raises instead of losing the write."""

    def test_upload_raises(self, tmp_path):
        store = make_store(tmp_path, allow_fallback=False)

        with pytest.raises(ArtifactStoreUnavailable):
            store.upload("contracts/AC-1/tests.js", "console.log(1)")

    def test_upload_leaves_nothing_on_disk(self, tmp_path):
        """The whole point: no silent write to a filesystem nobody will read."""
        store = make_store(tmp_path, allow_fallback=False)

        with pytest.raises(ArtifactStoreUnavailable):
            store.upload("contracts/AC-1/tests.js", "console.log(1)")

        assert list(tmp_path.rglob("*")) == []

    def test_download_raises_rather_than_answering_none(self, tmp_path):
        """
        A None here would be indistinguishable from "no such object", so a
        caller would treat a transient outage as a definitive absence.
        """
        store = make_store(tmp_path, allow_fallback=False)

        with pytest.raises(ArtifactStoreUnavailable):
            store.download("k")

    def test_error_names_the_bucket_and_the_escape_hatch(self, tmp_path):
        store = make_store(tmp_path, allow_fallback=False)

        with pytest.raises(ArtifactStoreUnavailable) as excinfo:
            store.upload("k", "v")

        message = str(excinfo.value)
        assert "assurecode-test" in message
        assert "ALLOW_LOCAL_ARTIFACT_FALLBACK" in message


class TestMissingBucketSelfHeals:
    """LocalStack starts every restart with no buckets (no PERSISTENCE set),
    and nothing re-runs docker-compose's one-shot bucket-creation step when
    only the localstack container itself bounces -- every previously stored
    test bundle then silently vanishes with it. _ensure_client() should
    recreate the bucket on a confirmed 404/NoSuchBucket rather than treating
    it the same as an unreachable endpoint.
    """

    def _not_found_error(self) -> ClientError:
        return ClientError(
            {"Error": {"Code": "404", "Message": "Not Found"}}, "HeadBucket"
        )

    def test_recreates_bucket_on_404_and_succeeds(self, tmp_path):
        store = S3ArtifactStore(
            endpoint_url="http://127.0.0.1:1",
            bucket="assurecode-test",
            fallback_dir=str(tmp_path),
            allow_local_fallback=False,
        )
        fake_client = MagicMock()
        fake_client.head_bucket.side_effect = self._not_found_error()

        with patch("boto3.client", return_value=fake_client):
            url = store.upload("contracts/AC-1/tests.js", "console.log(1)")

        fake_client.create_bucket.assert_called_once_with(Bucket="assurecode-test")
        fake_client.put_object.assert_called_once()
        assert url == "s3://assurecode-test/contracts/AC-1/tests.js"

    def test_other_client_errors_still_refuse(self, tmp_path):
        """A 403 (bad credentials) is not the recoverable case -- must not
        attempt to create a bucket it may have no permission to see."""
        store = S3ArtifactStore(
            endpoint_url="http://127.0.0.1:1",
            bucket="assurecode-test",
            fallback_dir=str(tmp_path),
            allow_local_fallback=False,
        )
        fake_client = MagicMock()
        fake_client.head_bucket.side_effect = ClientError(
            {"Error": {"Code": "403", "Message": "Forbidden"}}, "HeadBucket"
        )

        with patch("boto3.client", return_value=fake_client):
            with pytest.raises(ArtifactStoreUnavailable):
                store.upload("k", "v")

        fake_client.create_bucket.assert_not_called()


class TestSettingsDefault:
    """The default must follow the environment, not a hardcoded constant."""

    def test_production_refuses_by_default(self):
        from app.settings import Settings

        assert Settings(NODE_ENV="production").allow_local_artifact_fallback is False

    def test_development_allows_by_default(self):
        from app.settings import Settings

        assert Settings(NODE_ENV="dev").allow_local_artifact_fallback is True

    def test_explicit_override_wins_in_production(self):
        from app.settings import Settings

        settings = Settings(NODE_ENV="production", ALLOW_LOCAL_ARTIFACT_FALLBACK=True)
        assert settings.allow_local_artifact_fallback is True


class TestLocalFileStoreDirectly:
    def test_exists_tracks_uploads(self, tmp_path):
        store = LocalFileArtifactStore(str(tmp_path))

        assert store.exists("a/b.txt") is False
        store.upload("a/b.txt", "x")
        assert store.exists("a/b.txt") is True
