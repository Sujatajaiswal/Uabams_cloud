import os
from collections.abc import Awaitable, Callable

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response


PROTECTED_GATEWAY_PATHS = (
    "/api/v1/archive",
    "/api/v1/alert",
    "/api/v1/calibration",
)


def gateway_keys() -> dict[str, str | None]:
    return {
        "GW_UABAMS_BOGIE_01": os.getenv("GATEWAY_API_KEY_GW01"),
        "GW_UABAMS_BOGIE_02": os.getenv("GATEWAY_API_KEY_GW02"),
    }


def gateway_id_for_key(api_key: str | None) -> str | None:
    if not api_key:
        return None
    for gateway_id, expected_key in gateway_keys().items():
        if expected_key and expected_key == api_key:
            return gateway_id
    return None


class GatewayAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if request.url.path.startswith(PROTECTED_GATEWAY_PATHS):
            supplied_gateway_id = request.headers.get("X-Gateway-Id")
            train_id = request.headers.get("X-Train-Id")
            api_key = request.headers.get("X-Api-Key")

            if not api_key:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Missing gateway API key"},
                )

            gateway_id = gateway_id_for_key(api_key)
            if not gateway_id:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Invalid gateway API key"},
                )

            if supplied_gateway_id and supplied_gateway_id != gateway_id:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "API key does not belong to supplied gateway"},
                )

            request.state.gateway_id = gateway_id
            request.state.train_id = train_id
            request.state.api_key = api_key

        return await call_next(request)