from datetime import UTC, datetime, timedelta
from hashlib import sha256
from hmac import compare_digest
from math import isfinite
from pathlib import Path
from secrets import token_hex
from typing import Annotated, Any
from urllib.parse import parse_qs

import json
import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from bson import ObjectId
from fastapi import Body, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from app.database import db, settings
from app.middleware.auth import GatewayAuthMiddleware
from app.models import (
    AlertRequest,
    AuthRequest,
    ActivityLogRequest,
    CalibrationUpdateRequest,
    HandshakeRequest,
    HeartbeatRequest,
    ResetSessionRequest,
    TargetedResetRequest,
    HandshakeHelloRequest,
    HandshakeHelloResponse,
    HandshakeVerifyRequest,
    HandshakeVerifyResponse,
    GatewayConnectionRequest,
    GatewayConnectionResponse,
)
from app.parsers.archive import parse_archive_zip, peak_records_to_alert_events, AXIS_NAMES

app = FastAPI(
    title="UABAMS Cloud API",
    version="0.2.0",
)
app.mount("/static", StaticFiles(directory="app/static"), name="static")

SPATIAL_RETENTION_DAYS = 30
TIME_DOMAIN_RETENTION_DAYS = 7
SPATIAL_RETENTION_SECONDS = SPATIAL_RETENTION_DAYS * 24 * 60 * 60
RAW_TIME_DOMAIN_CHUNK_BYTES = 8 * 1024 * 1024
OPERATOR_COOKIE_NAME = "uabams_operator_session"
OPERATOR_SESSION_HOURS = 12


def client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.client.host if request.client else ""


def utc_now() -> datetime:
    return datetime.now(UTC)


def serialize(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.isoformat()
    if isinstance(value, list):
        return [serialize(item) for item in value]
    if isinstance(value, dict):
        return {key: serialize(item) for key, item in value.items()}
    return value


def _positive_factor(value: Any, default: float = 1.0) -> float:
    try:
        factor = float(value)
    except (TypeError, ValueError):
        return default
    return factor if isfinite(factor) and factor > 0 else default


def apply_wheel_compensation(
    rms_records: list[dict[str, Any]],
    peak_records: list[dict[str, Any]],
    calibration: dict[str, Any] | None,
) -> dict[str, Any]:
    calibration = calibration or {}
    left_factor = _positive_factor(calibration.get("leftWheelFactor"))
    right_factor = _positive_factor(calibration.get("rightWheelFactor"))
    combined_factor = (left_factor + right_factor) / 2.0

    def compensate_position(record: dict[str, Any], field: str) -> None:
        value = record.get(field)
        if value is None:
            return
        raw_field = f"raw{field[0].upper()}{field[1:]}"
        record[raw_field] = value
        record[field] = int(round(float(value) * combined_factor))

    def compensate_speed(record: dict[str, Any]) -> None:
        value = record.get("speedKmph")
        if value is None:
            return
        record["rawSpeedKmph"] = value
        record["speedKmph"] = round(float(value) * combined_factor, 2)

    for record in rms_records:
        compensate_position(record, "positionMm")
        compensate_speed(record)
        record["wheelCompensationFactor"] = round(combined_factor, 6)

    for record in peak_records:
        compensate_position(record, "windowStartMm")
        compensate_position(record, "windowEndMm")
        compensate_position(record, "positionMm")
        compensate_speed(record)
        for axis in record.get("axes", {}).values():
            compensate_position(axis, "peakPositionMm")
        record["wheelCompensationFactor"] = round(combined_factor, 6)

    return {
        "leftWheelFactor": left_factor,
        "rightWheelFactor": right_factor,
        "combinedFactor": round(combined_factor, 6),
        "calibrationVersion": calibration.get("version"),
        "applied": abs(combined_factor - 1.0) > 1e-9,
    }


async def store_time_domain_files(
    raw_files: list[dict[str, Any]],
    gateway_id: str,
    train_id: str,
    session_name: str,
    archive_sha256: str,
    created_at: datetime,
) -> list[dict[str, Any]]:
    await db.time_domain_chunks.delete_many(
        {"archiveSha256": archive_sha256, "gatewayId": gateway_id}
    )
    await db.time_domain_files.delete_many(
        {"archiveSha256": archive_sha256, "gatewayId": gateway_id}
    )

    expires_at = created_at + timedelta(days=TIME_DOMAIN_RETENTION_DAYS)
    stored_files: list[dict[str, Any]] = []
    chunk_documents: list[dict[str, Any]] = []

    for raw_file in raw_files:
        payload = bytes(raw_file.get("data", b""))
        file_id = ObjectId()
        chunks = [
            payload[offset : offset + RAW_TIME_DOMAIN_CHUNK_BYTES]
            for offset in range(0, len(payload), RAW_TIME_DOMAIN_CHUNK_BYTES)
        ]
        file_document = {
            "_id": file_id,
            "gatewayId": gateway_id,
            "trainId": train_id,
            "sessionName": session_name,
            "archiveSha256": archive_sha256,
            "path": raw_file.get("path"),
            "sizeBytes": len(payload),
            "sha256": sha256(payload).hexdigest(),
            "chunkCount": len(chunks),
            "createdAt": created_at,
            "expiresAt": expires_at,
        }
        await db.time_domain_files.insert_one(file_document)
        for index, chunk in enumerate(chunks):
            chunk_documents.append(
                {
                    "fileId": file_id,
                    "gatewayId": gateway_id,
                    "trainId": train_id,
                    "archiveSha256": archive_sha256,
                    "chunkIndex": index,
                    "data": chunk,
                    "createdAt": created_at,
                    "expiresAt": expires_at,
                }
            )
        stored_files.append(
            {
                "fileId": str(file_id),
                "path": file_document["path"],
                "sizeBytes": file_document["sizeBytes"],
                "sha256": file_document["sha256"],
                "chunkCount": file_document["chunkCount"],
                "expiresAt": expires_at,
            }
        )

    if chunk_documents:
        await db.time_domain_chunks.insert_many(chunk_documents)
    return stored_files


def create_operator_session(username: str) -> str:
    now = utc_now()
    payload = {
        "sub": username,
        "role": "operator",
        "iat": now,
        "exp": now + timedelta(hours=OPERATOR_SESSION_HOURS),
    }
    return jwt.encode(payload, settings["jwt_secret"], algorithm=settings["jwt_algorithm"])


def operator_session_payload(request: Request) -> dict[str, Any] | None:
    token = request.cookies.get(OPERATOR_COOKIE_NAME)
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings["jwt_secret"], algorithms=[settings["jwt_algorithm"]])
    except jwt.PyJWTError:
        return None
    if payload.get("role") != "operator":
        return None
    if payload.get("sub") != settings["operator_username"]:
        return None
    return payload


def is_operator_authenticated(request: Request) -> bool:
    return operator_session_payload(request) is not None


def operator_username(request: Request) -> str | None:
    payload = operator_session_payload(request)
    return payload.get("sub") if payload else None


class ActivityLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.startswith(("/static", "/docs", "/openapi.json", "/api/v1/logs")):
            return response
        username = operator_username(request)
        if username:
            await db.activity_logs.insert_one({
                "username": username,
                "page": path,
                "action": f"{request.method} {path}",
                "statusCode": response.status_code,
                "ipAddress": client_ip(request),
                "userAgent": request.headers.get("user-agent", ""),
                "createdAt": utc_now(),
            })
        return response


app.add_middleware(ActivityLogMiddleware)
app.add_middleware(GatewayAuthMiddleware)


def render_login_page(error: str = "") -> HTMLResponse:
    error_html = f'<div class="alert alert-error">{error}</div>' if error else ""
    html = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>UABAMS Login</title>
  <link rel="stylesheet" href="/static/styles.css?v=20260701-login-auth">
</head>
<body class="login-body">
  <div class="login-page">
    <div class="login-container">
      <div class="top-logo-container">
        <img src="/static/railman-logo.png" class="railman-logo" alt="RailMan Logo">
      </div>
      <div class="login-form-container">
        {error_html}
        <form method="post" action="/login">
          <div class="input-group">
            <span class="input-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
            </span>
            <input name="username" type="text" autocomplete="username" placeholder="Username or Email" required autofocus>
          </div>
          <div class="input-group">
            <span class="input-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            </span>
            <input id="password" name="password" type="password" autocomplete="current-password" placeholder="••••••••" required>
            <button type="button" class="password-toggle" id="toggle-password">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" id="eye-icon">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </button>
          </div>
          <button class="login-btn" type="submit">Login</button>
        </form>
      </div>
    </div>
    <div class="footer-branding">
      <img src="/static/apna-logo.png" class="apna-logo" alt="Apna Logo">
      <div class="footer-links">&copy; 2026 Privacy Policy | Copyright Policy</div>
    </div>
  </div>

  <script>
    const togglePassword = document.querySelector('#toggle-password');
    const password = document.querySelector('#password');
    
    togglePassword.addEventListener('click', function () {
      const type = password.getAttribute('type') === 'password' ? 'text' : 'password';
      password.setAttribute('type', type);
      
      if (type === 'password') {
        this.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" id="eye-icon">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>
        `;
      } else {
        this.innerHTML = `
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" id="eye-icon">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
          </svg>
        `;
      }
    });
  </script>
</body>
</html>""".replace("{error_html}", error_html)
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


def create_gateway_token(gateway_id: str, train_id: str | None = None) -> str:
    payload = {
        "sub": gateway_id,
        "trainId": train_id,
        "iat": utc_now(),
        "exp": utc_now() + timedelta(hours=12),
    }
    return jwt.encode(payload, settings["jwt_secret"], algorithm=settings["jwt_algorithm"])


def verify_gateway_token(token: str, gateway_id: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings["jwt_secret"], algorithms=[settings["jwt_algorithm"]])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc

    if payload.get("sub") != gateway_id:
        raise HTTPException(status_code=401, detail="Token does not belong to this gateway")
    return payload


@app.on_event("startup")
async def startup() -> None:
    await db.gateways.create_index("gatewayId", unique=True)
    await db.gateways.create_index("trainId")
    await db.gateway_auth.create_index("gatewayId", unique=True)
    await db.gateway_status.create_index("gatewayId", unique=True)
    await db.calibrations.create_index("gatewayId", unique=True)
    await db.calibration_versions.create_index([("gateway_id", 1), ("version", -1)])
    await db.alert_events.create_index([("trainNo", 1), ("createdAt", -1)])
    await db.archives.create_index([("gatewayId", 1), ("receivedAt", -1)])
    await db.archives.create_index([("gatewayId", 1), ("sha256", 1)])
    await db.rms_records.create_index([("trainId", 1), ("gatewayId", 1), ("positionMm", 1)])
    await db.rms_records.create_index([("archiveSha256", 1)])
    await db.rms_records.create_index([("gpsValid", 1), ("latitude", 1), ("longitude", 1)])
    await db.peak_records.create_index([("trainId", 1), ("gatewayId", 1), ("windowStartMm", 1)])
    await db.peak_records.create_index([("archiveSha256", 1)])
    await db.fault_records.create_index([("trainId", 1), ("gatewayId", 1), ("timestampMs", 1)])
    await db.fault_records.create_index([("archiveSha256", 1)])
    await db.rms_records.create_index(
        "createdAt", expireAfterSeconds=SPATIAL_RETENTION_SECONDS, name="ttl_rms_30_days"
    )
    await db.peak_records.create_index(
        "createdAt", expireAfterSeconds=SPATIAL_RETENTION_SECONDS, name="ttl_peak_30_days"
    )
    await db.alert_events.create_index(
        "createdAt", expireAfterSeconds=SPATIAL_RETENTION_SECONDS, name="ttl_alerts_30_days"
    )
    await db.fault_records.create_index(
        "createdAt", expireAfterSeconds=SPATIAL_RETENTION_SECONDS, name="ttl_faults_30_days"
    )
    await db.archives.create_index(
        "receivedAt", expireAfterSeconds=SPATIAL_RETENTION_SECONDS, name="ttl_archives_30_days"
    )
    await db.time_domain_files.create_index(
        "expiresAt", expireAfterSeconds=0, name="ttl_time_domain_files_7_days"
    )
    await db.time_domain_files.create_index(
        [("gatewayId", 1), ("sessionName", 1), ("path", 1)]
    )
    await db.time_domain_chunks.create_index(
        "expiresAt", expireAfterSeconds=0, name="ttl_time_domain_chunks_7_days"
    )
    await db.time_domain_chunks.create_index([("fileId", 1), ("chunkIndex", 1)], unique=True)
    await db.sessions.create_index([("trainNo", 1), ("status", 1)])
    await db.reset_events.create_index([("trainNo", 1), ("createdAt", -1)])
    await db.activity_logs.create_index([("username", 1), ("createdAt", -1)])
    await db.activity_logs.create_index([("page", 1), ("createdAt", -1)])
    await db.handshake_sessions.create_index("sessionId", unique=True)
    await db.handshake_sessions.create_index("createdAt", expireAfterSeconds=300)


@app.get("/")
async def root():
    return {"message": "UABAMS Cloud Running", "dashboard": "/dashboard", "login": "/login", "docs": "/docs"}


@app.get("/login")
async def login_page(request: Request):
    if is_operator_authenticated(request):
        return RedirectResponse("/dashboard", status_code=303)
    return render_login_page()


@app.post("/login")
async def login_submit(request: Request):
    body = (await request.body()).decode("utf-8")
    form = parse_qs(body, keep_blank_values=True)
    username = form.get("username", [""])[0]
    password = form.get("password", [""])[0]
    username_ok = compare_digest(username, settings["operator_username"])
    password_ok = compare_digest(password, settings["operator_password"])
    if not (username_ok and password_ok):
        return render_login_page("Invalid username or password")

    response = RedirectResponse("/dashboard", status_code=303)
    response.set_cookie(
        OPERATOR_COOKIE_NAME,
        create_operator_session(username),
        max_age=OPERATOR_SESSION_HOURS * 60 * 60,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
    )
    return response


@app.get("/logout")
async def logout():
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(OPERATOR_COOKIE_NAME)
    return response


@app.get("/dashboard")
async def dashboard_page(request: Request):
    if not is_operator_authenticated(request):
        return RedirectResponse("/login", status_code=303)
    return FileResponse(Path("app/static/index.html"), headers={"Cache-Control": "no-store"})


@app.post("/api/v1/logs")
async def create_activity_log(data: ActivityLogRequest, request: Request):
    username = operator_username(request)
    if not username:
        raise HTTPException(status_code=401, detail="Login required")
    document = {
        "username": username,
        "page": data.page,
        "action": data.action,
        "message": data.message,
        "errorMessage": data.errorMessage,
        "latitude": data.latitude,
        "longitude": data.longitude,
        "ipAddress": client_ip(request),
        "userAgent": request.headers.get("user-agent", ""),
        "createdAt": utc_now(),
    }
    await db.activity_logs.insert_one(document)
    return {"status": "success", "log": serialize(document)}


@app.get("/api/v1/logs")
async def list_activity_logs(request: Request, username: str | None = None, page: str | None = None, limit: int = 100):
    if not is_operator_authenticated(request):
        raise HTTPException(status_code=401, detail="Login required")
    query: dict[str, Any] = {}
    if username:
        query["username"] = username
    if page:
        query["page"] = page
    capped_limit = min(max(limit, 1), 500)
    logs = await db.activity_logs.find(query).sort("createdAt", -1).limit(capped_limit).to_list(length=capped_limit)
    return {"logs": serialize(logs)}


@app.post("/api/v1/handshake")
async def handshake(data: HandshakeRequest):
    now = utc_now()
    api_key = token_hex(16)

    await db.gateways.update_one(
        {"gatewayId": data.gatewayId},
        {
            "$set": {
                "gatewayId": data.gatewayId,
                "trainId": data.trainId,
                "gatewaySerial": data.gatewaySerial,
                "firmwareVersion": data.firmwareVersion,
                "status": "active",
                "lastSeen": now,
                "updatedAt": now,
            },
            "$setOnInsert": {"createdAt": now},
        },
        upsert=True,
    )

    auth_doc = await db.gateway_auth.find_one({"gatewayId": data.gatewayId})
    is_new_gateway = auth_doc is None
    if auth_doc:
        api_key = auth_doc["apiKey"]

    await db.gateway_auth.update_one(
        {"gatewayId": data.gatewayId},
        {
            "$setOnInsert": {
                "gatewayId": data.gatewayId,
                "apiKey": api_key,
                "createdAt": now,
            },
            "$set": {"lastHandshake": now},
        },
        upsert=True,
    )

    await db.trains.update_one(
        {"trainNo": data.trainId},
        {
            "$set": {"trainNo": data.trainId, "status": "running", "updatedAt": now},
            "$addToSet": {"gateways": data.gatewayId},
            "$setOnInsert": {"trainName": "", "createdAt": now},
        },
        upsert=True,
    )

    await db.gateway_status.update_one(
        {"gatewayId": data.gatewayId},
        {
            "$set": {
                "gatewayId": data.gatewayId,
                "trainId": data.trainId,
                "online": True,
                "lastHandshake": now,
                "lastHeartbeat": now,
            }
        },
        upsert=True,
    )

    return {
        "status": "success",
        "message": "Gateway registered",
        "gatewayId": data.gatewayId,
        "apiKey": api_key,
        "isNewGateway": is_new_gateway,
    }


@app.post("/api/v1/handshake/hello", response_model=HandshakeHelloResponse)
async def handshake_hello(data: HandshakeHelloRequest):
    gateway = await db.gateways.find_one({"gatewayId": data.gatewayId})
    if not gateway:
        raise HTTPException(status_code=404, detail="Gateway not registered")

    # 1. Generate server ephemeral key pair
    server_private_key = ec.generate_private_key(ec.SECP256R1())
    server_public_key = server_private_key.public_key()

    # 2. Serialize keys to hex
    server_pub_bytes = server_public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint
    )
    server_pub_hex = server_pub_bytes.hex()

    server_priv_bytes = server_private_key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    )
    server_priv_hex = server_priv_bytes.hex()

    # 3. Create challenge nonce & session ID
    nonce = token_hex(16)
    session_id = token_hex(16)

    # 4. Save session state in MongoDB
    await db.handshake_sessions.insert_one({
        "sessionId": session_id,
        "gatewayId": data.gatewayId,
        "serverPrivateKeyHex": server_priv_hex,
        "clientPublicKeyHex": data.clientPublicKey,
        "nonce": nonce,
        "verified": False,
        "createdAt": utc_now(),
    })

    return HandshakeHelloResponse(
        serverPublicKey=server_pub_hex,
        nonce=nonce,
        sessionId=session_id
    )


@app.post("/api/v1/handshake/verify", response_model=HandshakeVerifyResponse)
async def handshake_verify(data: HandshakeVerifyRequest):
    session = await db.handshake_sessions.find_one({"sessionId": data.sessionId})
    if not session:
        raise HTTPException(status_code=404, detail="Handshake session not found or expired")

    try:
        # 1. Load keys
        server_private_key = serialization.load_der_private_key(
            bytes.fromhex(session["serverPrivateKeyHex"]),
            password=None
        )
        client_public_key = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(),
            bytes.fromhex(session["clientPublicKeyHex"])
        )

        # 2. Compute Diffie-Hellman Shared Secret
        shared_key = server_private_key.exchange(ec.ECDH(), client_public_key)

        # 3. Derive symmetric key via HKDF
        session_key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=b"uabams-handshake-session-key",
        ).derive(shared_key)

        # 4. Compute expected HMAC
        import hmac as python_hmac
        expected_hmac = python_hmac.new(
            session_key,
            session["nonce"].encode("utf-8"),
            digestmod=sha256
        ).hexdigest()

        # 5. Compare signatures using timing-safe compare_digest
        if not compare_digest(data.clientHmac.lower(), expected_hmac.lower()):
            raise HTTPException(status_code=401, detail="HMAC verification failed")

        # 6. Save derived session key & verify session
        await db.handshake_sessions.update_one(
            {"_id": session["_id"]},
            {"$set": {
                "verified": True,
                "sessionKeyHex": session_key.hex(),
                "verifiedAt": utc_now()
            }}
        )

        return HandshakeVerifyResponse(
            status="verified",
            message="Handshake verified successfully",
            sessionToken=data.sessionId
        )

    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid public key: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Handshake error: {exc}")


@app.post("/api/v1/authenticate")
async def authenticate(data: AuthRequest):
    gateway_auth = await db.gateway_auth.find_one({"gatewayId": data.gatewayId})

    if not gateway_auth:
        return {"status": "failed", "message": "Gateway not found"}

    if gateway_auth["apiKey"] != data.apiKey:
        return {"status": "failed", "message": "Invalid API Key"}

    gateway = await db.gateways.find_one({"gatewayId": data.gatewayId})
    token = create_gateway_token(data.gatewayId, gateway.get("trainId") if gateway else None)

    await db.gateway_auth.update_one(
        {"gatewayId": data.gatewayId},
        {"$set": {"lastAuthenticated": utc_now()}},
    )

    return {"status": "authenticated", "token": token}


@app.post("/api/v1/gateway/demo-connect", response_model=GatewayConnectionResponse)
async def gateway_demo_connect(data: GatewayConnectionRequest):
    # Find matching gateway document by serialNo (or gatewayId as fallback)
    gateway = await db.gateways.find_one({
        "$or": [
            {"gatewaySerial": data.serialNo},
            {"gatewayId": data.serialNo}
        ]
    })
    
    if not gateway:
        return GatewayConnectionResponse(
            status="denied",
            message=f"Access denied: Serial number or Gateway ID '{data.serialNo}' is not registered in the cloud database.",
            gatewayId=None,
            trainId=None
        )
        
    # Check if the gateway is active
    if gateway.get("status") != "active":
        return GatewayConnectionResponse(
            status="denied",
            message=f"Access denied: Gateway '{gateway.get('gatewayId')}' is registered but its current status is '{gateway.get('status')}' (must be 'active').",
            gatewayId=gateway.get("gatewayId"),
            trainId=gateway.get("trainId")
        )
        
    return GatewayConnectionResponse(
        status="approved",
        message=f"Gateway connectivity approved! Gateway '{gateway.get('gatewayId')}' is registered and active.",
        gatewayId=gateway.get("gatewayId"),
        trainId=gateway.get("trainId")
    )



@app.post("/api/v1/heartbeat")
async def heartbeat(data: HeartbeatRequest):
    verify_gateway_token(data.token, data.gatewayId)
    now = utc_now()
    gateway = await db.gateways.find_one({"gatewayId": data.gatewayId})

    if not gateway:
        return {"status": "failed", "message": "Gateway not registered"}

    await db.gateways.update_one(
        {"gatewayId": data.gatewayId},
        {"$set": {"lastSeen": now, "status": "active"}},
    )
    await db.gateway_status.update_one(
        {"gatewayId": data.gatewayId},
        {
            "$set": {
                "gatewayId": data.gatewayId,
                "trainId": gateway.get("trainId"),
                "online": True,
                "lastHeartbeat": now,
            }
        },
        upsert=True,
    )
    await db.trains.update_one(
        {"trainNo": gateway.get("trainId")},
        {"$set": {"status": "running", "updatedAt": now}},
    )

    return {"status": "success", "message": "Heartbeat updated", "lastHeartbeat": now}



def require_gateway_path_match(request: Request, gateway_id: str) -> None:
    authenticated_gateway = getattr(request.state, "gateway_id", None)
    if authenticated_gateway != gateway_id:
        raise HTTPException(
            status_code=403,
            detail="API key does not belong to requested gateway",
        )


async def resolve_train_id(gateway_id: str, *candidates: str | None) -> str:
    for candidate in candidates:
        if candidate:
            return str(candidate).strip()

    gateway = await db.gateways.find_one({"gatewayId": gateway_id})
    if gateway and gateway.get("trainId"):
        return str(gateway["trainId"])

    status = await db.gateway_status.find_one({"gatewayId": gateway_id})
    if status and status.get("trainId"):
        return str(status["trainId"])

    return "019456"


def location_box(latitude: float, longitude: float, radius_meters: float) -> dict[str, dict[str, float]]:
    radius_degrees = max(radius_meters, 1.0) / 111_320
    return {
        "latitude": {"$gte": latitude - radius_degrees, "$lte": latitude + radius_degrees},
        "longitude": {"$gte": longitude - radius_degrees, "$lte": longitude + radius_degrees},
    }
@app.put("/api/v1/archive")
async def upload_archive(
    request: Request,
    archive_body: Annotated[bytes, Body(media_type="application/octet-stream")],
    x_api_key: Annotated[str | None, Header(alias="X-Api-Key")] = None,
    x_sha256: Annotated[str | None, Header(alias="X-Sha256")] = None,
    x_session_id: Annotated[str | None, Header(alias="X-Session-Id")] = None,
    x_session_iv: Annotated[str | None, Header(alias="X-Session-Iv")] = None,
):
    gateway_id = request.state.gateway_id
    expected_sha256 = x_sha256 or request.headers.get("X-Archive-Sha256")
    actual_sha256 = sha256(archive_body).hexdigest()

    if expected_sha256 and expected_sha256.lower() != actual_sha256:
        raise HTTPException(status_code=400, detail="SHA-256 mismatch")

    body = archive_body
    if x_session_id:
        if not hasattr(request.state, "session_key"):
            raise HTTPException(status_code=401, detail="Session key not found in request state")
        if not x_session_iv:
            raise HTTPException(status_code=400, detail="Missing X-Session-Iv header for encrypted payload")
        try:
            aesgcm = AESGCM(request.state.session_key)
            body = aesgcm.decrypt(bytes.fromhex(x_session_iv), archive_body, None)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Failed to decrypt payload: {exc}")

    try:
        parsed = parse_archive_zip(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    now = utc_now()
    metadata = parsed.metadata or {}
    session_name = (
        metadata.get("sessionName")
        or metadata.get("sessionId")
        or request.headers.get("X-Session-Name")
        or f"{gateway_id}-{int(now.timestamp())}"
    )
    train_id = await resolve_train_id(
        gateway_id,
        metadata.get("trainId"),
        metadata.get("trainNo"),
        request.state.train_id,
    )
    session_status = metadata.get("sessionStatus", "unknown")
    warnings = list(parsed.warnings)

    if metadata.get("gatewayId") and metadata.get("gatewayId") != gateway_id:
        warnings.append("Metadata gatewayId does not match API key gateway")
    if metadata.get("trainId") and metadata.get("trainId") != train_id:
        warnings.append("Metadata trainId does not match resolved train")

    calibration = await db.calibration_versions.find_one(
        {"gateway_id": gateway_id},
        sort=[("version", -1)],
    )
    wheel_compensation = apply_wheel_compensation(
        parsed.rms_records,
        parsed.peak_records,
        calibration,
    )

    common = {
        "gatewayId": gateway_id,
        "trainId": train_id,
        "sessionName": session_name,
        "archiveSha256": actual_sha256,
        "createdAt": now,
    }

    await db.rms_records.delete_many({"archiveSha256": actual_sha256, "gatewayId": gateway_id})
    await db.peak_records.delete_many({"archiveSha256": actual_sha256, "gatewayId": gateway_id})
    await db.fault_records.delete_many({"archiveSha256": actual_sha256, "gatewayId": gateway_id})
    await db.alert_events.delete_many({"archiveSha256": actual_sha256, "gatewayId": gateway_id, "source": "peak_50m.bin"})

    rms_records = [{**record, **common} for record in parsed.rms_records]
    peak_records = [{**record, **common} for record in parsed.peak_records]
    fault_records = [{**record, **common} for record in parsed.fault_records]
    peak_alerts = peak_records_to_alert_events(
        parsed.peak_records,
        gateway_id,
        train_id,
        session_name,
        actual_sha256,
        now,
    )

    if rms_records:
        await db.rms_records.insert_many(rms_records)
    if peak_records:
        await db.peak_records.insert_many(peak_records)
    if fault_records:
        await db.fault_records.insert_many(fault_records)
    if peak_alerts:
        await db.alert_events.insert_many(peak_alerts)

    stored_raw_files = await store_time_domain_files(
        parsed.raw_files,
        gateway_id,
        train_id,
        session_name,
        actual_sha256,
        now,
    )

    document = {
        "gatewayId": gateway_id,
        "trainId": train_id,
        "contentType": request.headers.get("content-type", "application/zip"),
        "sizeBytes": len(body),
        "sha256": actual_sha256,
        "sessionName": session_name,
        "sessionStatus": session_status,
        "metadata": metadata,
        "filesInZip": parsed.files,
        "rawFiles": stored_raw_files,
        "rmsIntervalValidation": parsed.rms_validation,
        "wheelCompensation": wheel_compensation,
        "spatialRetentionDays": SPATIAL_RETENTION_DAYS,
        "timeDomainRetentionDays": TIME_DOMAIN_RETENTION_DAYS,
        "rmsRecordCount": len(rms_records),
        "peakRecordCount": len(peak_records),
        "faultRecordCount": len(fault_records),
        "peakAlertCount": len(peak_alerts),
        "parseWarnings": warnings,
        "receivedAt": now,
        "status": "processed_with_warnings" if warnings else "processed",
    }

    existing = await db.archives.find_one({"gatewayId": gateway_id, "sha256": actual_sha256})
    if existing:
        await db.archives.update_one({"_id": existing["_id"]}, {"$set": document})
        document["_id"] = existing["_id"]
    else:
        result = await db.archives.insert_one(document)
        document["_id"] = result.inserted_id

    await mark_gateway_online(gateway_id, train_id, now)

    return {
        "status": "success",
        "sha256": actual_sha256,
        "sizeBytes": len(body),
        "sessionName": session_name,
        "rmsRecords": len(rms_records),
        "peakRecords": len(peak_records),
        "faultRecords": len(fault_records),
        "peakAlerts": len(peak_alerts),
        "rmsIntervalValidation": parsed.rms_validation,
        "wheelCompensation": wheel_compensation,
        "rawTimeDomainFiles": len(stored_raw_files),
        "retention": {
            "spatialAndAlertsDays": SPATIAL_RETENTION_DAYS,
            "timeDomainDays": TIME_DOMAIN_RETENTION_DAYS,
        },
        "warnings": warnings,
    }

@app.post("/api/v1/alert")
async def create_alert(
    request: Request,
    x_api_key: Annotated[str | None, Header(alias="X-Api-Key")] = None,
    x_session_id: Annotated[str | None, Header(alias="X-Session-Id")] = None,
    x_session_iv: Annotated[str | None, Header(alias="X-Session-Iv")] = None,
):
    gateway_id = request.state.gateway_id
    raw_body = await request.body()
    
    if x_session_id:
        if not hasattr(request.state, "session_key"):
            raise HTTPException(status_code=401, detail="Session key not found in request state")
        if not x_session_iv:
            raise HTTPException(status_code=400, detail="Missing X-Session-Iv header for encrypted payload")
        try:
            aesgcm = AESGCM(request.state.session_key)
            decrypted_body = aesgcm.decrypt(bytes.fromhex(x_session_iv), raw_body, None)
            alert_json = json.loads(decrypted_body.decode("utf-8"))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Failed to decrypt payload: {exc}")
    else:
        try:
            alert_json = json.loads(raw_body.decode("utf-8"))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON payload: {exc}")

    from pydantic import ValidationError
    try:
        data = AlertRequest(**alert_json)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors())

    if data.gatewayId and data.gatewayId != gateway_id:
        raise HTTPException(status_code=403, detail="Session or API key does not belong to supplied gateway")
    train_no = await resolve_train_id(gateway_id, data.trainNo, request.state.train_id)

    if data.peakValueG > 80:
        color = "RED"
    elif data.peakValueG > 50:
        color = "YELLOW"
    else:
        color = "GREEN"

    now = utc_now()
    document = {
        "gatewayId": gateway_id,
        "trainNo": train_no,
        "latitude": data.latitude,
        "longitude": data.longitude,
        "peakValueG": data.peakValueG,
        "alert": color,
        "createdAt": now,
    }
    await db.alert_events.insert_one(document)
    await mark_gateway_online(gateway_id, train_no, now)
    return {"status": "success", "alert": color, "event": serialize(document)}


@app.get("/api/v1/calibration/{gateway_id}")
async def get_calibration(
    gateway_id: str,
    request: Request,
    x_api_key: Annotated[str, Header(alias="X-Api-Key")],
):
    require_gateway_path_match(request, gateway_id)

    calibration = await db.calibration_versions.find_one(
        {"gateway_id": gateway_id},
        sort=[("version", -1)],
    )
    if calibration:
        return {
            "gatewayId": gateway_id,
            "version": calibration.get("version"),
            "leftWheelFactor": calibration.get("leftWheelFactor", 1.0),
            "rightWheelFactor": calibration.get("rightWheelFactor", 1.0),
            "adxl_left": calibration.get("adxl_left", {}),
            "adxl_right": calibration.get("adxl_right", {}),
            "bogie": calibration.get("bogie", {}),
            "encoder": calibration.get("encoder", {}),
        }

    return {
        "gatewayId": gateway_id,
        "version": 1,
        "leftWheelFactor": 1.0,
        "rightWheelFactor": 1.0,
        "adxl_left": {"x": 1.0, "y": 1.0, "z": 1.0},
        "adxl_right": {"x": 1.0, "y": 1.0, "z": 1.0},
        "bogie": {},
        "encoder": {},
    }


@app.post("/api/v1/calibration/{gateway_id}")
async def save_calibration(
    gateway_id: str,
    data: CalibrationUpdateRequest,
    request: Request,
    x_api_key: Annotated[str, Header(alias="X-Api-Key")],
):
    require_gateway_path_match(request, gateway_id)

    gateway = await db.gateways.find_one({"gatewayId": gateway_id})
    if not gateway:
        raise HTTPException(status_code=404, detail="Gateway not registered")

    existing = await db.calibration_versions.find_one(
        {"gateway_id": gateway_id},
        sort=[("version", -1)],
    )
    version = int(existing.get("version", 0)) + 1 if existing else 1
    document = {
        "gateway_id": gateway_id,
        "trainId": gateway.get("trainId"),
        "version": version,
        "adxl_left": data.adxlLeft.model_dump(),
        "adxl_right": data.adxlRight.model_dump(),
        "bogie": data.bogie,
        "encoder": data.encoder,
        "leftWheelFactor": data.leftWheelFactor,
        "rightWheelFactor": data.rightWheelFactor,
        "updatedAt": utc_now(),
    }

    await db.calibration_versions.insert_one(document)
    return {"status": "success", "message": "Calibration saved", "calibration": serialize(document)}


@app.get("/api/v1/trains")
async def list_trains():
    trains_cursor = db.trains.find({}, {"_id": 0, "trainNo": 1})
    trains = await trains_cursor.to_list(length=1000)
    return sorted(list(set([t["trainNo"] for t in trains if t.get("trainNo")])))


@app.get("/api/v1/trains/{train_no}/dashboard")
async def train_dashboard(train_no: str):
    train = await db.trains.find_one({"trainNo": train_no})
    if not train:
        raise HTTPException(status_code=404, detail="Train not found")

    expected_gateways = ["GW_UABAMS_BOGIE_01", "GW_UABAMS_BOGIE_02"]
    gateway_ids = list(dict.fromkeys([*expected_gateways, *train.get("gateways", [])]))
    statuses = await db.gateway_status.find({"gatewayId": {"$in": gateway_ids}}).to_list(length=20)
    status_by_id = {item.get("gatewayId"): item for item in statuses}
    gateway_cards = []
    for gateway_id in gateway_ids:
        card = status_by_id.get(gateway_id)
        if card:
            gateway_cards.append(card)
        else:
            gateway_cards.append({
                "gatewayId": gateway_id,
                "trainId": train_no,
                "online": False,
                "lastHeartbeat": None,
            })

    alerts = await db.alert_events.find({"trainNo": train_no, "sessionStatus": {"$ne": "archived"}}).sort("createdAt", -1).limit(30).to_list(length=30)
    archives = await db.archives.find({"trainId": train_no}).sort("receivedAt", -1).limit(20).to_list(length=20)
    active_session = await db.sessions.find_one({"trainNo": train_no, "status": "active"}, sort=[("createdAt", -1)])

    return {
        "train": serialize(train),
        "gateways": serialize(gateway_cards),
        "lastAlerts": serialize(alerts),
        "archives": serialize(archives),
        "activeSession": serialize(active_session) if active_session else None,
    }



@app.get("/api/v1/trains/{train_no}/gateways/{gateway_id}/details")
async def gateway_details(train_no: str, gateway_id: str):
    gateway = await db.gateway_status.find_one({"gatewayId": gateway_id})
    archive_count = await db.archives.count_documents({"trainId": train_no, "gatewayId": gateway_id})
    alert_count = await db.alert_events.count_documents({"trainNo": train_no, "gatewayId": gateway_id, "sessionStatus": {"$ne": "archived"}})
    critical_count = await db.alert_events.count_documents({"trainNo": train_no, "gatewayId": gateway_id, "alert": "RED", "sessionStatus": {"$ne": "archived"}})
    rms_count = await db.rms_records.count_documents({"trainId": train_no, "gatewayId": gateway_id})
    peak_count = await db.peak_records.count_documents({"trainId": train_no, "gatewayId": gateway_id})
    fault_count = await db.fault_records.count_documents({"trainId": train_no, "gatewayId": gateway_id})
    latest_alert = await db.alert_events.find_one(
        {"trainNo": train_no, "gatewayId": gateway_id, "sessionStatus": {"$ne": "archived"}},
        sort=[("createdAt", -1)],
    )
    latest_archive = await db.archives.find_one(
        {"trainId": train_no, "gatewayId": gateway_id},
        sort=[("receivedAt", -1)],
    )
    latest_rms = await db.rms_records.find_one(
        {"trainId": train_no, "gatewayId": gateway_id},
        sort=[("createdAt", -1), ("positionMm", -1)],
    )
    alerts = await db.alert_events.find(
        {"trainNo": train_no, "gatewayId": gateway_id, "sessionStatus": {"$ne": "archived"}}
    ).sort("createdAt", -1).limit(20).to_list(length=20)
    archives = await db.archives.find({"trainId": train_no, "gatewayId": gateway_id}).sort("receivedAt", -1).limit(10).to_list(length=10)
    faults = await db.fault_records.find({"trainId": train_no, "gatewayId": gateway_id}).sort("createdAt", -1).limit(20).to_list(length=20)

    return {
        "trainNo": train_no,
        "gatewayId": gateway_id,
        "status": serialize(gateway) if gateway else {"gatewayId": gateway_id, "trainId": train_no, "online": False},
        "summary": {
            "archives": archive_count,
            "alerts": alert_count,
            "criticalAlerts": critical_count,
            "rmsRecords": rms_count,
            "peakRecords": peak_count,
            "faultRecords": fault_count,
            "latestPeakG": latest_alert.get("peakValueG") if latest_alert else latest_rms.get("maxG") if latest_rms else None,
            "latestAlert": latest_alert.get("alert") if latest_alert else latest_rms.get("color") if latest_rms else None,
            "latestLocation": {
                "latitude": latest_alert.get("latitude") if latest_alert else latest_rms.get("latitude") if latest_rms else None,
                "longitude": latest_alert.get("longitude") if latest_alert else latest_rms.get("longitude") if latest_rms else None,
            },
            "latestArchive": serialize(latest_archive) if latest_archive else None,
        },
        "alerts": serialize(alerts),
        "archives": serialize(archives),
        "faults": serialize(faults),
    }
@app.get("/api/v1/trains/{train_no}/archives")
async def train_archives(train_no: str):
    archives = await db.archives.find({"trainId": train_no}).sort("receivedAt", -1).limit(50).to_list(length=50)
    return {"trainNo": train_no, "archives": serialize(archives)}


@app.get("/api/v1/trains/{train_no}/position")
async def train_position(train_no: str, gateway_id: str | None = None):
    query: dict[str, Any] = {
        "trainId": train_no,
        "gpsValid": True,
        "latitude": {"$nin": [None, 0]},
        "longitude": {"$nin": [None, 0]},
    }
    if gateway_id:
        query["gatewayId"] = gateway_id

    latest = await db.rms_records.find_one(query, sort=[("createdAt", -1), ("positionMm", -1)])
    if not latest:
        return {"trainNo": train_no, "gatewayId": gateway_id, "position": None}

    previous_query = dict(query)
    previous_query["gatewayId"] = latest.get("gatewayId")
    previous_query["positionMm"] = {"$lt": latest.get("positionMm", 0)}
    previous = await db.rms_records.find_one(previous_query, sort=[("positionMm", -1)])
    bearing = None
    if previous:
        from math import atan2, cos, degrees, radians, sin
        lat1 = radians(float(previous.get("latitude", 0)))
        lat2 = radians(float(latest.get("latitude", 0)))
        delta_lon = radians(float(latest.get("longitude", 0)) - float(previous.get("longitude", 0)))
        y = sin(delta_lon) * cos(lat2)
        x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(delta_lon)
        bearing = round((degrees(atan2(y, x)) + 360) % 360, 2)

    return {
        "trainNo": train_no,
        "gatewayId": latest.get("gatewayId"),
        "position": {
            "latitude": latest.get("latitude"),
            "longitude": latest.get("longitude"),
            "positionMm": latest.get("positionMm"),
            "speedKmph": latest.get("speedKmph"),
            "bearing": bearing,
            "createdAt": serialize(latest.get("createdAt")),
        },
    }


@app.get("/api/v1/map/alerts")
async def map_alerts(train_id: str):
    # Find the latest session for this train from rms_records to identify the current active trip
    latest_record = await db.rms_records.find_one({"trainId": train_id}, sort=[("createdAt", -1)])
    
    query = {"trainNo": train_id, "sessionStatus": {"$ne": "archived"}}
    if latest_record and latest_record.get("sessionName"):
        query["sessionName"] = latest_record["sessionName"]
        
    alerts = await db.alert_events.find(query).sort("createdAt", -1).limit(200).to_list(length=200)
    return [
        {
            "train_id": item.get("trainNo"),
            "gateway_id": item.get("gatewayId"),
            "lat": item.get("latitude"),
            "lon": item.get("longitude"),
            "color": item.get("alert", "GREEN"),
            "peak_g": item.get("peakValueG"),
            "created_at": serialize(item.get("createdAt")),
        }
        for item in alerts
    ]


@app.get("/api/v1/map/rms")
async def map_rms(train_id: str, gateway_id: str | None = None):
    query: dict[str, Any] = {
        "trainId": train_id,
        "gpsValid": True,
        "latitude": {"$nin": [None, 0]},
        "longitude": {"$nin": [None, 0]},
    }
    if gateway_id:
        query["gatewayId"] = gateway_id

    # Return recent valid GPS records for each gateway.  This keeps the route
    # visible even if the latest archive for one gateway has no valid GPS data.
    recent_records = await db.rms_records.find(
        query,
        {
            "trainId": 1,
            "gatewayId": 1,
            "sessionName": 1,
            "latitude": 1,
            "longitude": 1,
            "color": 1,
            "maxG": 1,
            "positionMm": 1,
            "masterCount": 1,
            "createdAt": 1,
            "archiveSha256": 1,
        },
    ).sort([("createdAt", -1), ("gatewayId", 1), ("positionMm", -1)]).limit(5000).to_list(length=5000)

    records_by_gateway: dict[str, list[dict[str, Any]]] = {}
    for item in recent_records:
        gateway = item.get("gatewayId") or "unknown"
        records_by_gateway.setdefault(gateway, []).append(item)

    records: list[dict[str, Any]] = []
    for gateway_records in records_by_gateway.values():
        if not gateway_records:
            continue
        # Filter by the latest active session name (with archive SHA fallback if session is missing)
        latest_session = gateway_records[0].get("sessionName")
        if latest_session:
            filtered = [r for r in gateway_records if r.get("sessionName") == latest_session]
        else:
            latest_archive = gateway_records[0].get("archiveSha256")
            filtered = [r for r in gateway_records if r.get("archiveSha256") == latest_archive]
            
        # Sort chronologically by creation time so the route is drawn in movement order
        filtered.sort(key=lambda x: x.get("createdAt") or 0)
        records.extend(filtered)

    return [
        {
            "train_id": item.get("trainId"),
            "gateway_id": item.get("gatewayId"),
            "session": item.get("sessionName"),
            "lat": item.get("latitude"),
            "lon": item.get("longitude"),
            "color": item.get("color", "GREEN"),
            "peak_g": item.get("maxG", 0),
            "position_mm": item.get("positionMm"),
            "master_count": item.get("masterCount"),
            "created_at": serialize(item.get("createdAt")),
        }
        for item in records
    ]

@app.post("/api/v1/data/reset")
async def reset_bad_data(
    data: TargetedResetRequest,
    x_admin_key: Annotated[str | None, Header(alias="X-Admin-Key")] = None,
):
    if not x_admin_key:
        raise HTTPException(status_code=401, detail="Missing admin reset key")
    if not settings.get("admin_reset_key") or x_admin_key != settings["admin_reset_key"]:
        raise HTTPException(status_code=403, detail="Invalid admin reset key")
    if not data.startTime and not data.endTime and (data.latitude is None or data.longitude is None):
        raise HTTPException(status_code=400, detail="Provide a time range or location for targeted cleanup")

    now = utc_now()

    def add_common(query: dict[str, Any], train_field: str, time_field: str) -> dict[str, Any]:
        query[train_field] = data.trainNo
        if data.gatewayId:
            query["gatewayId"] = data.gatewayId
        if data.startTime or data.endTime:
            query[time_field] = {}
            if data.startTime:
                query[time_field]["$gte"] = data.startTime
            if data.endTime:
                query[time_field]["$lte"] = data.endTime
        return query

    location_filter = {}
    if data.latitude is not None and data.longitude is not None:
        location_filter = location_box(data.latitude, data.longitude, data.radiusMeters)

    alert_query = add_common({}, "trainNo", "createdAt")
    rms_query = add_common({}, "trainId", "createdAt")
    peak_query = add_common({}, "trainId", "createdAt")
    fault_query = add_common({}, "trainId", "createdAt")
    archive_query = add_common({}, "trainId", "receivedAt")
    time_domain_file_query = add_common({}, "trainId", "createdAt")
    time_domain_chunk_query = add_common({}, "trainId", "createdAt")

    if location_filter:
        alert_query.update(location_filter)
        rms_query.update(location_filter)
        peak_query.update(location_filter)
        if not (data.startTime or data.endTime):
            fault_query = {"_id": {"$exists": False}}
            archive_query = {"_id": {"$exists": False}}
            time_domain_file_query = {"_id": {"$exists": False}}
            time_domain_chunk_query = {"_id": {"$exists": False}}

    deleted_alerts = await db.alert_events.delete_many(alert_query)
    deleted_rms = await db.rms_records.delete_many(rms_query)
    deleted_peak = await db.peak_records.delete_many(peak_query)
    deleted_faults = await db.fault_records.delete_many(fault_query)
    deleted_archives = await db.archives.delete_many(archive_query)
    deleted_time_domain_files = await db.time_domain_files.delete_many(time_domain_file_query)
    deleted_time_domain_chunks = await db.time_domain_chunks.delete_many(time_domain_chunk_query)

    cleanup = {
        "trainNo": data.trainNo,
        "gatewayId": data.gatewayId,
        "startTime": data.startTime,
        "endTime": data.endTime,
        "latitude": data.latitude,
        "longitude": data.longitude,
        "radiusMeters": data.radiusMeters,
        "reason": data.reason,
        "deleted": {
            "alerts": deleted_alerts.deleted_count,
            "rmsRecords": deleted_rms.deleted_count,
            "peakRecords": deleted_peak.deleted_count,
            "faultRecords": deleted_faults.deleted_count,
            "archives": deleted_archives.deleted_count,
            "timeDomainFiles": deleted_time_domain_files.deleted_count,
            "timeDomainChunks": deleted_time_domain_chunks.deleted_count,
        },
        "createdAt": now,
    }
    await db.reset_events.insert_one(cleanup)
    return {"status": "success", "message": "Targeted data removed", "cleanup": serialize(cleanup)}
@app.post("/api/v1/sessions/reset")
async def reset_session(
    data: ResetSessionRequest,
    x_admin_key: Annotated[str | None, Header(alias="X-Admin-Key")] = None,
):
    if not x_admin_key:
        raise HTTPException(status_code=401, detail="Missing admin reset key")
    if not settings.get("admin_reset_key") or x_admin_key != settings["admin_reset_key"]:
        raise HTTPException(status_code=403, detail="Invalid admin reset key")

    now = utc_now()
    await db.sessions.update_many(
        {"trainNo": data.trainNo, "status": "active"},
        {"$set": {"status": "closed", "closedAt": now}},
    )

    session_id = f"{data.trainNo}-{int(now.timestamp())}"
    session = {
        "sessionId": session_id,
        "trainNo": data.trainNo,
        "status": "active",
        "dataCounter": 0,
        "alertsResetAt": now,
        "createdAt": now,
    }
    await db.sessions.insert_one(session)
    await db.alert_events.update_many(
        {"trainNo": data.trainNo, "sessionStatus": {"$ne": "archived"}},
        {"$set": {"sessionStatus": "archived", "archivedAt": now}},
    )

    return {"status": "success", "message": "New session started", "session": serialize(session)}


async def mark_gateway_online(gateway_id: str, train_id: str, now: datetime) -> None:
    await db.gateways.update_one(
        {"gatewayId": gateway_id},
        {
            "$set": {
                "gatewayId": gateway_id,
                "trainId": train_id,
                "status": "active",
                "lastSeen": now,
                "updatedAt": now,
            },
            "$setOnInsert": {"createdAt": now},
        },
        upsert=True,
    )
    await db.trains.update_one(
        {"trainNo": train_id},
        {
            "$set": {"trainNo": train_id, "status": "running", "updatedAt": now},
            "$addToSet": {"gateways": gateway_id},
            "$setOnInsert": {"trainName": "", "createdAt": now},
        },
        upsert=True,
    )
    await db.gateway_status.update_one(
        {"gatewayId": gateway_id},
        {
            "$set": {
                "gatewayId": gateway_id,
                "trainId": train_id,
                "online": True,
                "lastHeartbeat": now,
            }
        },
        upsert=True,
    )


# =====================================================================
# REPORTING MODULES & ALARM LOG APIS
# =====================================================================
from pydantic import BaseModel
from fastapi.responses import Response
from bson import ObjectId

class RepeatedAlarmRequest(BaseModel):
    fromDate: str
    toDate: str

class AlarmLogRequest(BaseModel):
    rid: str | None = None
    fromDate: str
    toDate: str
    alarmType: str
    feedbackStatus: str | None = None

class FeedbackUpdateRequest(BaseModel):
    enrouteDiagnosis: str
    enrouteAction: str
    depotDiagnosis: str

def parse_local_datetime(date_str: str) -> datetime:
    try:
        if "T" in date_str:
            parts = date_str.split("T")
            date_part = parts[0]
            time_part = parts[1]
            if len(time_part) == 5:
                time_part += ":00"
            return datetime.fromisoformat(f"{date_part}T{time_part}")
        return datetime.fromisoformat(date_str)
    except Exception:
        return datetime.utcnow()


@app.post("/api/reports/repeated-alarm/load")
async def load_repeated_alarm_report(data: RepeatedAlarmRequest, request: Request):
    if not is_operator_authenticated(request):
        raise HTTPException(status_code=401, detail="Login required")
        
    from_dt = parse_local_datetime(data.fromDate)
    to_dt = parse_local_datetime(data.toDate)
    
    pipeline = [
        {"$match": {"createdAt": {"$gte": from_dt, "$lte": to_dt}}},
        {"$sort": {"createdAt": -1}},
        {
            "$group": {
                "_id": "$trainNo",
                "count": {"$sum": 1},
                "latitude": {"$first": "$latitude"},
                "longitude": {"$first": "$longitude"}
            }
        },
        {"$sort": {"count": -1}}
    ]
    results = await db.alert_events.aggregate(pipeline).to_list(length=1000)
    
    rows = []
    for r in results:
        train_no = r.get("_id")
        if train_no:
            lat = r.get("latitude")
            lon = r.get("longitude")
            loc_str = f"{lat:.4f}, {lon:.4f}" if (lat is not None and lon is not None) else "-"
            rows.append({
                "rid": train_no,
                "count": r.get("count", 0),
                "location": loc_str
            })
            
    return {
        "totalRollingStocks": len(rows),
        "rows": rows
    }


@app.post("/api/reports/repeated-alarm/export/csv")
async def export_repeated_alarm_csv(data: RepeatedAlarmRequest, request: Request):
    if not is_operator_authenticated(request):
        raise HTTPException(status_code=401, detail="Login required")
        
    res = await load_repeated_alarm_report(data, request)
    rows = res["rows"]
    
    csv_lines = ["RID,Count,Location"]
    for r in rows:
        csv_lines.append(f"{r['rid']},{r['count']},{r['location']}")
            
    content = "\n".join(csv_lines)
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=RepeatedAlarms.csv"}
    )


@app.post("/api/reports/repeated-alarm/export/excel")
async def export_repeated_alarm_excel(data: RepeatedAlarmRequest, request: Request):
    if not is_operator_authenticated(request):
        raise HTTPException(status_code=401, detail="Login required")
        
    res = await load_repeated_alarm_report(data, request)
    rows = res["rows"]
    
    xml_parts = [
        '<?xml version="1.0"?>',
        '<?mso-application progid="Excel.Sheet"?>',
        '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
        ' xmlns:o="urn:schemas-microsoft-com:office:origin"',
        ' xmlns:x="urn:schemas-microsoft-com:office:excel"',
        ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"',
        ' xmlns:html="http://www.w3.org/TR/REC-html40">',
        ' <Worksheet ss:Name="RepeatedAlarms">',
        '  <Table>',
        '   <Row>',
        '    <Cell><Data ss:Type="String">RID</Data></Cell>',
        '    <Cell><Data ss:Type="String">Count</Data></Cell>',
        '    <Cell><Data ss:Type="String">Location</Data></Cell>',
        '   </Row>'
    ]
    for r in rows:
        xml_parts.append(
            f'   <Row>\n'
            f'    <Cell><Data ss:Type="String">{r["rid"]}</Data></Cell>\n'
            f'    <Cell><Data ss:Type="Number">{r["count"]}</Data></Cell>\n'
            f'    <Cell><Data ss:Type="String">{r["location"]}</Data></Cell>\n'
            f'   </Row>'
        )
    xml_parts.extend([
        '  </Table>',
        ' </Worksheet>',
        '</Workbook>'
    ])
    content = "\n".join(xml_parts)
    return Response(
        content=content,
        media_type="application/vnd.ms-excel",
        headers={"Content-Disposition": "attachment; filename=RepeatedAlarms.xls"}
    )


@app.post("/api/reports/alarm-log/load")
async def load_alarm_log_report(data: AlarmLogRequest, request: Request):
    if not is_operator_authenticated(request):
        raise HTTPException(status_code=401, detail="Login required")
        
    from_dt = parse_local_datetime(data.fromDate)
    to_dt = parse_local_datetime(data.toDate)
    
    query = {
        "createdAt": {"$gte": from_dt, "$lte": to_dt}
    }
    
    rid = data.rid.strip() if data.rid else ""
    if rid and rid.upper() != "ALL":
        query["trainNo"] = rid
        
    if data.alarmType == "Critical":
        query["alert"] = "RED"
    elif data.alarmType == "Maintenance":
        query["alert"] = "YELLOW"
    elif data.alarmType == "Normal":
        query["alert"] = "GREEN"
        
    alerts = await db.alert_events.find(query).sort("createdAt", -1).to_list(length=2000)
    
    rows = []
    total_records = len(alerts)
    critical_count = 0
    maintenance_count = 0
    normal_count = 0
    
    for alert_doc in alerts:
        col_alert = alert_doc.get("alert", "GREEN")
        if col_alert == "RED":
            critical_count += 1
        elif col_alert == "YELLOW":
            maintenance_count += 1
        else:
            normal_count += 1
            
        dt = alert_doc.get("createdAt")
        date_str = dt.strftime("%d-%m-%Y") if dt else "-"
        time_str = dt.strftime("%H:%M:%S") if dt else "-"
        
        lat = alert_doc.get("latitude")
        lon = alert_doc.get("longitude")
        loc_str = f"{lat:.4f}, {lon:.4f}" if (lat is not None and lon is not None) else "-"
        
        rows.append({
            "id": str(alert_doc.get("_id") or ""),
            "alarmDate": date_str,
            "alarmTime": time_str,
            "machineName": alert_doc.get("gatewayId") or "-",
            "train": alert_doc.get("trainNo") or "-",
            "location": loc_str,
            "alertColor": col_alert
        })
        
    summary = {
        "totalAlarmCount": total_records,
        "criticalAlarmCount": critical_count,
        "maintenanceAlarmCount": maintenance_count,
        "normalAlarmCount": normal_count
    }
    
    return {
        "summary": summary,
        "rows": rows,
        "recordsTruncated": False
    }


@app.post("/api/reports/alarm-log/export/csv")
async def export_alarm_log_csv(data: AlarmLogRequest, request: Request):
    if not is_operator_authenticated(request):
        raise HTTPException(status_code=401, detail="Login required")
        
    res = await load_alarm_log_report(data, request)
    rows = res["rows"]
    
    headers = ["Date", "Time", "Machine", "Train", "Location"]
    csv_lines = [",".join(headers)]
    
    for r in rows:
        line = [
            r["alarmDate"], r["alarmTime"], r["machineName"], r["train"], r["location"]
        ]
        csv_lines.append(",".join(line))
        
    content = "\n".join(csv_lines)
    return Response(
        content=content,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=AlarmLog.csv"}
    )


@app.post("/api/reports/alarm-log/export/excel")
async def export_alarm_log_excel(data: AlarmLogRequest, request: Request):
    if not is_operator_authenticated(request):
        raise HTTPException(status_code=401, detail="Login required")
        
    res = await load_alarm_log_report(data, request)
    rows = res["rows"]
    
    headers = ["Date", "Time", "Machine", "Train", "Location"]
    
    xml_parts = [
        '<?xml version="1.0"?>',
        '<?mso-application progid="Excel.Sheet"?>',
        '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
        ' xmlns:o="urn:schemas-microsoft-com:office:origin"',
        ' xmlns:x="urn:schemas-microsoft-com:office:excel"',
        ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"',
        ' xmlns:html="http://www.w3.org/TR/REC-html40">',
        ' <Worksheet ss:Name="AlarmLog">',
        '  <Table>',
        '   <Row>'
    ]
    for h in headers:
        xml_parts.append(f'    <Cell><Data ss:Type="String">{h}</Data></Cell>')
    xml_parts.append('   </Row>')
    
    for r in rows:
        xml_parts.append(
            f'   <Row>\n'
            f'    <Cell><Data ss:Type="String">{r["alarmDate"]}</Data></Cell>\n'
            f'    <Cell><Data ss:Type="String">{r["alarmTime"]}</Data></Cell>\n'
            f'    <Cell><Data ss:Type="String">{r["machineName"]}</Data></Cell>\n'
            f'    <Cell><Data ss:Type="String">{r["train"]}</Data></Cell>\n'
            f'    <Cell><Data ss:Type="String">{r["location"]}</Data></Cell>\n'
            f'   </Row>'
        )
        
    xml_parts.extend([
        '  </Table>',
        ' </Worksheet>',
        '</Workbook>'
    ])
    
    content = "\n".join(xml_parts)
    return Response(
        content=content,
        media_type="application/vnd.ms-excel",
        headers={"Content-Disposition": "attachment; filename=AlarmLog.xls"}
    )


@app.post("/api/reports/alerts/{alert_id}/feedback")
async def update_alert_feedback(alert_id: str, data: FeedbackUpdateRequest, request: Request):
    if not is_operator_authenticated(request):
        raise HTTPException(status_code=401, detail="Login required")
        
    try:
        obj_id = ObjectId(alert_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Alert ID format")
        
    res = await db.alert_events.update_one(
        {"_id": obj_id},
        {
            "$set": {
                "feedbackStatus": "updated",
                "enrouteDiagnosis": data.enrouteDiagnosis,
                "enrouteAction": data.enrouteAction,
                "depotDiagnosis": data.depotDiagnosis
            }
        }
    )
    return {"status": "success", "message": "Feedback updated successfully"}


class GraphDataRequest(BaseModel):
    rid: str
    fromDate: str
    toDate: str
    metric: str  # "Peak" or "RMS"


@app.post("/api/reports/graph/load")
async def load_graph_report(data: GraphDataRequest, request: Request):
    if not is_operator_authenticated(request):
        raise HTTPException(status_code=401, detail="Login required")
        
    from_dt = parse_local_datetime(data.fromDate)
    to_dt = parse_local_datetime(data.toDate)
    
    query = {
        "trainId": data.rid,
        "createdAt": {"$gte": from_dt, "$lte": to_dt}
    }
    
    points = []
    if data.metric == "RMS":
        records = await db.rms_records.find(query).sort("positionMm", 1).to_list(length=1000)
        for r in records:
            dt = r.get("createdAt")
            timestamp_str = dt.strftime("%d-%m-%Y %H:%M:%S") if dt else "-"
            pos_mm = r.get("positionMm") or 0
            pos_km = round(pos_mm / 1000000.0, 4)
            
            axes_data = {}
            for axis_name in AXIS_NAMES:
                axes_data[axis_name] = r.get(f"{axis_name}_g") or 0.0
                
            points.append({
                "timestamp": timestamp_str,
                "speed": r.get("speedKmph") or 0.0,
                "positionKm": pos_km,
                "latitude": r.get("latitude"),
                "longitude": r.get("longitude"),
                "axes": axes_data
            })
    else:
        records = await db.peak_records.find(query).sort("positionMm", 1).to_list(length=1000)
        for r in records:
            dt = r.get("createdAt")
            timestamp_str = dt.strftime("%d-%m-%Y %H:%M:%S") if dt else "-"
            pos_mm = r.get("positionMm") or 0
            pos_km = round(pos_mm / 1000000.0, 4)
            
            axes_data = {}
            axes_dict = r.get("axes", {})
            for axis_name in AXIS_NAMES:
                axis_obj = axes_dict.get(axis_name) or {}
                axes_data[axis_name] = axis_obj.get("peakValueG") or 0.0
                
            points.append({
                "timestamp": timestamp_str,
                "speed": r.get("speedKmph") or 0.0,
                "positionKm": pos_km,
                "latitude": r.get("latitude"),
                "longitude": r.get("longitude"),
                "axes": axes_data
            })
            
    # Resolve metadata for the selected train
    rolling_stock_type = "C"
    train_type = "Goods"
    if points and data.rid:
        # Check if train name implies passenger
        if "LH" in data.rid.upper() or "EXP" in data.rid.upper():
            train_type = "Passenger LHB"
            rolling_stock_type = "LHB"
            
    return {
        "rollingStockId": data.rid,
        "trainType": train_type,
        "rollingStockType": rolling_stock_type,
        "points": points
    }


