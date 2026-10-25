"""How many free-model requests the OpenRouter account has left today."""

import logging

import httpx2 as httpx

log = logging.getLogger(__name__)

KEY_URL = "https://openrouter.ai/api/v1/key"


def free_requests_left(api_key: str, *, transport=None) -> int | None:
    """None when unknown: callers then go ahead."""
    try:
        with httpx.Client(timeout=10, transport=transport) as client:
            r = client.get(KEY_URL, headers={"Authorization": f"Bearer {api_key}"})
        r.raise_for_status()
        return int(r.json()["data"]["free_model_daily_requests"]["remaining"])
    except Exception as e:  # noqa: BLE001
        log.warning("could not read the OpenRouter quota: %s", type(e).__name__)
        return None
