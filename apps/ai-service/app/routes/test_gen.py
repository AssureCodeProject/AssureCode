"""Routes under /generate-tests — LLM-powered test generation (task 1.6).

POST /generate-tests → contract requirements → LLM generates Jest/Cypress
tests → upload to S3 → return URL.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import get_artifact_store, get_llm_client
from app.ports.artifact_store import ArtifactStore
from app.ports.llm_client import LlmClient, LlmUnavailableError

router = APIRouter(prefix="/generate-tests", tags=["test-gen"])

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
        test_code = llm.generate(prompt, max_tokens=2048)
    except LlmUnavailableError as err:
        raise HTTPException(
            status_code=503,
            detail=err.message,
            headers={"Retry-After": str(err.retry_after)},
        )

    # Count describe/it blocks as a rough test count heuristic.
    test_count = test_code.count("it(") + test_code.count("it.only(")

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
