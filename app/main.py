from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from secrets import token_hex
from typing import Annotated, Any

import jwt
from bson import ObjectId
from fastapi import Body, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.database import db, settings
from app.middleware.auth import GatewayAuthMiddleware
from app.models import (
    AlertRequest,
    AuthRequest,
    CalibrationUpdateRequest,
    HandshakeRequest,
    HeartbeatRequest,
    ResetSessionRequest,
)

app = FastAPI(
    title="UABAMS Cloud API",
    version="0.2.0",
)
app.add_middleware(GatewayAuthMiddleware)
app.mount("/static", StaticFiles(directory="app/static"), name="static")


def utc_now() -> datetime:
    return datetime.now(UTC)


def serialize(value: Any) -> Any:
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [serialize(item) for item in value]
    if isinstance(value, dict):
        return {key: serialize(item) for key, item in value.items()}
    return value


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
    await db.sessions.create_index([("trainNo", 1), ("status", 1)])


@app.get("/")
async def root():
    return {"message": "UABAMS Cloud Running", "dashboard": "/dashboard", "docs": "/docs"}


@app.get("/dashboard")
async def dashboard_page():
    return FileResponse(Path("app/static/index.html"))


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


@app.put("/api/v1/archive")
async def upload_archive(
    request: Request,
    archive_body: Annotated[bytes, Body(media_type="application/zip")],
    x_gateway_id: Annotated[str, Header(alias="X-Gateway-Id")],
    x_train_id: Annotated[str, Header(alias="X-Train-Id")],
    x_api_key: Annotated[str, Header(alias="X-Api-Key")],
    x_sha256: Annotated[str | None, Header(alias="X-Sha256")] = None,
):
    gateway_id = request.state.gateway_id
    train_id = request.state.train_id
    body = archive_body
    expected_sha256 = x_sha256 or request.headers.get("X-Archive-Sha256")
    actual_sha256 = sha256(body).hexdigest()

    if expected_sha256 and expected_sha256.lower() != actual_sha256:
        raise HTTPException(status_code=400, detail="SHA-256 mismatch")

    now = utc_now()
    document = {
        "gatewayId": gateway_id,
        "trainId": train_id,
        "contentType": request.headers.get("content-type", "application/zip"),
        "sizeBytes": len(body),
        "sha256": actual_sha256,
        "receivedAt": now,
        "status": "received",
    }

    await db.archives.insert_one(document)
    await mark_gateway_online(gateway_id, train_id, now)

    return {"status": "success", "sha256": actual_sha256, "sizeBytes": len(body)}


@app.post("/api/v1/alert")
async def create_alert(
    data: AlertRequest,
    request: Request,
    x_gateway_id: Annotated[str, Header(alias="X-Gateway-Id")],
    x_train_id: Annotated[str, Header(alias="X-Train-Id")],
    x_api_key: Annotated[str, Header(alias="X-Api-Key")],
):
    gateway_id = data.gatewayId or request.state.gateway_id
    train_no = data.trainNo or request.state.train_id

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
    x_gateway_id: Annotated[str, Header(alias="X-Gateway-Id")],
    x_train_id: Annotated[str, Header(alias="X-Train-Id")],
    x_api_key: Annotated[str, Header(alias="X-Api-Key")],
):
    if gateway_id != request.state.gateway_id:
        raise HTTPException(status_code=403, detail="Gateway header does not match calibration path")

    calibration = await db.calibration_versions.find_one(
        {"gateway_id": gateway_id},
        sort=[("version", -1)],
    )
    if calibration:
        return {
            "gatewayId": gateway_id,
            "version": calibration.get("version"),
            "adxl_left": calibration.get("adxl_left", {}),
            "adxl_right": calibration.get("adxl_right", {}),
            "bogie": calibration.get("bogie", {}),
            "encoder": calibration.get("encoder", {}),
        }

    return {
        "gatewayId": gateway_id,
        "version": 1,
        "adxl_left": {"x": 1.0, "y": 1.0, "z": 1.0},
        "adxl_right": {"x": 1.0, "y": 1.0, "z": 1.0},
        "bogie": {},
        "encoder": {},
    }


@app.post("/api/v1/calibration/{gateway_id}")
async def save_calibration(
    gateway_id: str,
    data: CalibrationUpdateRequest,
    x_gateway_id: Annotated[str, Header(alias="X-Gateway-Id")],
    x_train_id: Annotated[str, Header(alias="X-Train-Id")],
    x_api_key: Annotated[str, Header(alias="X-Api-Key")],
):
    if gateway_id != x_gateway_id:
        raise HTTPException(status_code=403, detail="Gateway header does not match calibration path")

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


@app.get("/api/v1/trains/{train_no}/archives")
async def train_archives(train_no: str):
    archives = await db.archives.find({"trainId": train_no}).sort("receivedAt", -1).limit(50).to_list(length=50)
    return {"trainNo": train_no, "archives": serialize(archives)}


@app.get("/api/v1/map/alerts")
async def map_alerts(train_id: str):
    alerts = await db.alert_events.find({"trainNo": train_id, "sessionStatus": {"$ne": "archived"}}).sort("createdAt", -1).limit(200).to_list(length=200)
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
async def map_rms(train_id: str):
    alerts = await db.alert_events.find({"trainNo": train_id, "sessionStatus": {"$ne": "archived"}}).sort("createdAt", -1).limit(200).to_list(length=200)
    return [
        {
            "train_id": item.get("trainNo"),
            "gateway_id": item.get("gatewayId"),
            "lat": item.get("latitude"),
            "lon": item.get("longitude"),
            "color": item.get("alert", "GREEN"),
            "peak_g": item.get("peakValueG"),
            "speed_kmph": item.get("speedKmph"),
            "position_mm": item.get("positionMm"),
            "created_at": serialize(item.get("createdAt")),
        }
        for item in alerts
    ]
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










