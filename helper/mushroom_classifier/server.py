"""Standalone internal HTTP service for the Node/Bull mushroom classifier."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Annotated

import uvicorn
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

from inference import ClassifierEngine, ClassifierError

MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024


def _token_is_valid(value: str | None) -> bool:
    expected = os.getenv("CLASSIFIER_SERVICE_TOKEN")
    return not expected or value == expected


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = ClassifierEngine.load()
    app.state.semaphore = asyncio.Semaphore(max(1, int(os.getenv("CLASSIFIER_MAX_CONCURRENCY", "1"))))
    yield


app = FastAPI(title="Mushroom Classifier Inference Service", version="1.0.0", lifespan=lifespan)


@app.exception_handler(ClassifierError)
async def classifier_error_handler(_: Request, error: ClassifierError):
    return JSONResponse(status_code=error.status_code, content={"error": {"code": error.code, "message": str(error)}})


@app.get("/health")
async def health(request: Request):
    engine = request.app.state.engine
    return {"status": "ready", "device": str(engine.device), "classCount": len(engine.labels)}


@app.post("/v1/classify")
async def classify(
    request: Request,
    image: Annotated[UploadFile, File(...)],
    requestId: Annotated[str, Form(...)],
    x_classifier_token: Annotated[str | None, Header()] = None,
):
    if not _token_is_valid(x_classifier_token):
        raise HTTPException(status_code=401, detail="Internal classifier token không hợp lệ.")
    if not requestId or len(requestId) > 100:
        raise HTTPException(status_code=422, detail="requestId không hợp lệ.")
    if image.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=422, detail="Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP.")
    chunks, total = [], 0
    while chunk := await image.read(1024 * 1024):
        total += len(chunk)
        if total > MAX_IMAGE_SIZE_BYTES:
            raise HTTPException(status_code=422, detail="Ảnh không được vượt quá 5 MB.")
        chunks.append(chunk)
    await image.close()
    if not chunks:
        raise HTTPException(status_code=422, detail="Ảnh rỗng.")
    async with request.app.state.semaphore:
        result = await asyncio.to_thread(request.app.state.engine.classify, b"".join(chunks))
    return {"requestId": requestId, "result": result, "model": {"architecture": "efficientnet_b0", "classCount": len(request.app.state.engine.labels)}}


if __name__ == "__main__":
    uvicorn.run(app, host=os.getenv("CLASSIFIER_HOST", "127.0.0.1"), port=int(os.getenv("CLASSIFIER_PORT", "8001")))
