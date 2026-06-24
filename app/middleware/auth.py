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


class GatewayAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if request.url.path.startswith(PROTECTED_GATEWAY_PATHS):
            gateway_id = request.headers.get("X-Gateway-Id")
            train_id = request.headers.get("X-Train-Id")
            api_key = request.headers.get("X-Api-Key")

            if not gateway_id or not train_id or not api_key:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Missing gateway authentication headers"},
                )

            expected_key = gateway_keys().get(gateway_id)
            if not expected_key or expected_key != api_key:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Invalid gateway credentials"},
                )

            request.state.gateway_id = gateway_id
            request.state.train_id = train_id

        return await call_next(request)
