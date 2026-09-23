"""Pure, reusable inference code for the mushroom classifier service."""

from __future__ import annotations

import hashlib
import json
import os
import time
import unicodedata
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image, UnidentifiedImageError
from torchvision import models, transforms

BASE_DIR = Path(__file__).resolve().parent
ALLOWED_FORMATS = {"JPEG": ("jpeg", "image/jpeg"), "PNG": ("png", "image/png"), "WEBP": ("webp", "image/webp")}
POISONOUS_CONFIDENCE_THRESHOLD = 0.60
NON_POISONOUS_CONFIDENCE_THRESHOLD = 0.80

class ClassifierError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 500):
        super().__init__(message)
        self.code, self.status_code = code, status_code

def _asset_path(env_name: str, default_name: str) -> Path:
    value = os.getenv(env_name)
    path = Path(value) if value else BASE_DIR / default_name
    return path if path.is_absolute() else (BASE_DIR / path).resolve()

def _normalize(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.strip().lower())
    return "".join(char for char in decomposed if not unicodedata.combining(char))

def _first(item: dict[str, Any], keys: set[str]) -> Any:
    for key, value in item.items():
        if _normalize(key).replace(" ", "_").replace("-", "_") in keys:
            return value
    return None

def _as_bool(value: Any) -> bool | None:
    if isinstance(value, bool): return value
    if isinstance(value, (int, float)): return bool(value) if value in (0, 1) else None
    if isinstance(value, str):
        normal = _normalize(value)
        if normal in {"true", "1", "yes", "co", "doc", "poisonous", "toxic"}: return True
        if normal in {"false", "0", "no", "khong", "safe", "non-toxic", "nontoxic"}: return False
    return None

def _load_catalog(path: Path) -> list[dict[str, Any]]:
    try: raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error: raise ClassifierError("CATALOG_INVALID", f"Không thể đọc danh mục nấm: {error}") from error
    if not isinstance(raw, list) or not raw: raise ClassifierError("CATALOG_INVALID", "Danh mục nấm phải là một mảng không rỗng.")
    output = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict): raise ClassifierError("CATALOG_INVALID", f"Mục danh mục {index} không hợp lệ.")
        name = _first(item, {"ten_nam", "name", "mushroom_name", "label"})
        scientific = _first(item, {"ten_khoa_hoc", "scientific_name", "scientificname", "latin_name"})
        poisonous = _as_bool(_first(item, {"co_doc", "is_poisonous", "poisonous", "toxic"}))
        if not isinstance(name, str) or not isinstance(scientific, str) or poisonous is None: raise ClassifierError("CATALOG_INVALID", f"Mục danh mục {index} thiếu dữ liệu bắt buộc.")
        output.append({"name": name.strip(), "scientificName": scientific.strip(), "isPoisonous": poisonous})
    return output

def _load_labels(path: Path) -> list[str]:
    try: lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error: raise ClassifierError("LABELS_MISSING", f"Không thể đọc labels: {error}") from error
    labels = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"): continue
        for separator in (",", ":", "\t"):
            if separator in line:
                first, rest = line.split(separator, 1)
                line = rest.strip() if first.strip().isdigit() and rest.strip() else line
                break
        labels.append(line)
    if not labels: raise ClassifierError("LABELS_INVALID", "Labels rỗng hoặc không hợp lệ.")
    return labels

def _state_dict(checkpoint: Any) -> dict[str, Any]:
    if isinstance(checkpoint, dict):
        for key in ("model_state_dict", "state_dict"):
            if isinstance(checkpoint.get(key), dict): return checkpoint[key]
        if checkpoint and all(isinstance(key, str) for key in checkpoint) and all(isinstance(value, torch.Tensor) for value in checkpoint.values()): return checkpoint
    raise ClassifierError("MODEL_INVALID", "Checkpoint không chứa state_dict hợp lệ.")

@dataclass
class ClassifierEngine:
    model: nn.Module
    labels: list[str]
    catalog: list[dict[str, Any]]
    device: torch.device
    transform: Any

    @classmethod
    def load(cls) -> "ClassifierEngine":
        model_path, labels_path, catalog_path = _asset_path("MODEL_PATH", "nammushroom_efficientnet_b0.pth"), _asset_path("LABELS_PATH", "labels.txt"), _asset_path("MUSHROOM_CATALOG_PATH", "mushroom.json")
        if not model_path.is_file(): raise ClassifierError("MODEL_MISSING", f"Không tìm thấy model: {model_path}")
        requested = os.getenv("CLASSIFIER_DEVICE", "auto").lower()
        if requested not in {"auto", "cpu", "cuda"}: raise ClassifierError("DEVICE_INVALID", "CLASSIFIER_DEVICE phải là auto, cpu hoặc cuda.")
        if requested == "cuda" and not torch.cuda.is_available(): raise ClassifierError("CUDA_UNAVAILABLE", "CUDA được yêu cầu nhưng không khả dụng.")
        device = torch.device("cuda" if requested != "cpu" and torch.cuda.is_available() else "cpu")
        labels, catalog = _load_labels(labels_path), _load_catalog(catalog_path)
        if len(labels) != len(catalog): raise ClassifierError("MODEL_METADATA_MISMATCH", "Số labels không khớp danh mục nấm.")
        try:
            state = _state_dict(torch.load(model_path, map_location=device, weights_only=True))
            class_count = int(state["classifier.1.weight"].shape[0])
            if class_count != len(labels): raise ClassifierError("MODEL_METADATA_MISMATCH", "Số class của model không khớp labels.")
            model = models.efficientnet_b0(weights=None)
            model.classifier[1] = nn.Linear(model.classifier[1].in_features, class_count)
            model.load_state_dict(state)
            model.to(device).eval()
        except ClassifierError: raise
        except Exception as error: raise ClassifierError("MODEL_INVALID", f"Không thể nạp model: {error}") from error
        return cls(model, labels, catalog, device, transforms.Compose([transforms.Resize(256), transforms.CenterCrop(224), transforms.ToTensor(), transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])]))

    def classify(self, image_bytes: bytes) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            with Image.open(BytesIO(image_bytes)) as source:
                source.load(); detected = source.format or ""
                if detected not in ALLOWED_FORMATS: raise ClassifierError("IMAGE_UNSUPPORTED", "Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP.", 422)
                image = source.convert("RGB")
        except ClassifierError: raise
        except (UnidentifiedImageError, OSError) as error: raise ClassifierError("IMAGE_INVALID", "Tệp ảnh bị hỏng hoặc không phải ảnh hợp lệ.", 422) from error
        try:
            tensor = self.transform(image).unsqueeze(0).to(self.device)
            with torch.no_grad(): probabilities = F.softmax(self.model(tensor)[0], dim=0); confidence, index = torch.max(probabilities, 0)
        except Exception as error: raise ClassifierError("INFERENCE_FAILED", "Không thể thực hiện phân loại ảnh.") from error
        index_value, confidence_value = index.item(), float(confidence.item())
        item = self.catalog[index_value]; poisonous = item["isPoisonous"]
        threshold = POISONOUS_CONFIDENCE_THRESHOLD if poisonous else NON_POISONOUS_CONFIDENCE_THRESHOLD
        accepted = confidence_value >= threshold
        return {"name": item["name"] if accepted else "unknown", "scientificName": item["scientificName"], "rawPrediction": self.labels[index_value], "accepted": accepted, "edibility": "POISONOUS" if accepted and poisonous else "NON_POISONOUS" if accepted else "UNKNOWN", "confidence": confidence_value, "confidenceThreshold": threshold, "isPoisonous": poisonous, "image": {"format": ALLOWED_FORMATS[detected][0], "mimeType": ALLOWED_FORMATS[detected][1], "sizeBytes": len(image_bytes), "sha256": hashlib.sha256(image_bytes).hexdigest()}, "inferenceTimeMs": round((time.perf_counter() - started) * 1000, 2)}
