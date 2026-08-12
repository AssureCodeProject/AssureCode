"""Routes under /generate-tests — LLM-powered test generation (task 1.6).

POST /generate-tests → contract requirements → LLM generates Jest/Cypress
tests → upload to S3 → return URL.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from app.deps import get_artifact_store, get_llm_client
from app.ports.artifact_store import ArtifactStore
from app.ports.llm_client import LlmClient, LlmUnavailableError

router = APIRouter(prefix="/generate-tests", tags=["test-gen"])

# An LLM asked for "only code" still wraps it in a markdown fence and often adds
# a trailing note. Storing that verbatim produced bundles that begin with
# ```javascript — not loadable JavaScript, so the CI sandbox had nothing runnable
# even once it was given a work directory. Every bundle written before this fix
# has that defect; regenerate them rather than trusting what is on disk.
_FENCED_BLOCK = re.compile(
    r"```[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n(?P<body>.*?)(?:\r?\n)?```",
    re.DOTALL,
)

# `it(` as a bare substring also matches submit(, init(, wait(, exit(, and await
# it(. The boundary and the optional modifier keep the count to real test cases.
_TEST_CASE = re.compile(r"(?<![A-Za-z0-9_$.])(?:it|test)(?:\.(?:only|each|skip|todo|concurrent))?\s*\(")


def strip_code_fences(text: str) -> str:
    """The code inside the first markdown fence, or `text` when there is none.

    Concatenates every fenced block rather than taking only the first: a model
    that splits its answer across two fences would otherwise lose half its
    tests silently, which is exactly the failure this function exists to stop.
    """
    blocks = [m.group("body") for m in _FENCED_BLOCK.finditer(text)]
    if not blocks:
        return text.strip()
    return "\n\n".join(b.strip() for b in blocks).strip()


def count_test_cases(code: str) -> int:
    """Number of `it(...)` / `test(...)` cases declared in `code`."""
    return len(_TEST_CASE.findall(code))

PROMPT_TEMPLATE = """\
You are a senior QA engineer. Generate Jest tests (CommonJS, require syntax)
for a freelance contract with the following requirements:

Title: {title}
Requirements:
{requirements}

Output ONLY valid Jest JavaScript code wrapped in a describe block.
Include at least 3 test cases covering:
  1. Happy path / basic functionality
  2. Edge case / empty input handling
  3. Error scenario

Use @jest/globals imports (describe, it, expect).
Contract ID reference: {contract_id}
"""


class GenerateTestsRequest(BaseModel):
    contract_id: str = Field(..., min_length=1, max_length=128)
    title: str = Field(..., min_length=1, max_length=512)
    requirements: str = Field(..., min_length=1, max_length=50_000)
    framework: str = Field(default="jest", pattern="^(jest|cypress)$")


class GenerateTestsResponse(BaseModel):
    contract_id: str
    s3_key: str
    s3_url: str
    framework: str
    test_count: int
    generated_at: str


@router.post("", response_model=GenerateTestsResponse)
def generate_tests(
    req: GenerateTestsRequest,
    llm: LlmClient = Depends(get_llm_client),
    store: ArtifactStore = Depends(get_artifact_store),
) -> GenerateTestsResponse:
    prompt = PROMPT_TEMPLATE.format(
        title=req.title,
        requirements=req.requirements,
        contract_id=req.contract_id,
    )

    try:
        raw = llm.generate(prompt, max_tokens=2048)
    except LlmUnavailableError as err:
        raise HTTPException(
            status_code=503,
            detail=err.message,
            headers={"Retry-After": str(err.retry_after)},
        ) from err

    # Store the code, not the model's presentation of it. See strip_code_fences.
    test_code = strip_code_fences(raw)
    test_count = count_test_cases(test_code)

    if not test_code.strip():
        raise HTTPException(
            status_code=502,
            detail=(
                "The model returned no test code for this contract. Refusing to store an "
                "empty bundle: the CI sandbox would read it as zero tests, which the "
                "settlement oracle must not mistake for a passing run."
            ),
        )

    s3_key = f"contracts/{req.contract_id}/generated-tests/{req.framework}/tests.js"
    s3_url = store.upload(s3_key, test_code, content_type="text/javascript")

    return GenerateTestsResponse(
        contract_id=req.contract_id,
        s3_key=s3_key,
        s3_url=s3_url,
        framework=req.framework,
        test_count=test_count,
        generated_at=__import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
    )


@router.get("/{contract_id}", response_class=Response)
def fetch_generated_tests(
    contract_id: str,
    framework: str = "jest",
    store: ArtifactStore = Depends(get_artifact_store),
) -> Response:
    """The stored test bundle for a contract, as plain JavaScript.

    The CI worker is a Node process and cannot read this service's artifact
    store directly — the store may be S3, LocalStack, or a local fallback
    directory, and which one is a deployment concern the worker should not have
    to know. Serving the bytes over HTTP keeps that knowledge on this side of
    the boundary, so the sandbox can materialise a runnable work directory from
    whichever backend actually holds the bundle.
    """
    if framework not in ("jest", "cypress"):
        raise HTTPException(status_code=422, detail="framework must be 'jest' or 'cypress'")

    key = f"contracts/{contract_id}/generated-tests/{framework}/tests.js"
    body = store.download(key)
    if body is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No {framework} test bundle has been generated for {contract_id}. "
                "Call POST /generate-tests first."
            ),
        )
    return Response(content=body, media_type="text/javascript")
