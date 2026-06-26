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
    TargetedResetRequest,
)
from app.parsers.archive import parse_archive_zip, peak_records_to_alert_events

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
    await db.archives.create_index([("gatewayId", 1), ("sha256", 1)])
    await db.rms_records.create_index([("trainId", 1), ("gatewayId", 1), ("positionMm", 1)])
    await db.rms_records.create_index([("archiveSha256", 1)])
    await db.rms_records.create_index([("gpsValid", 1), ("latitude", 1), ("longitude", 1)])
    await db.peak_records.create_index([("trainId", 1), ("gatewayId", 1), ("windowStartMm", 1)])
    await db.peak_records.create_index([("archiveSha256", 1)])
    await db.fault_records.create_index([("trainId", 1), ("gatewayId", 1), ("timestampMs", 1)])
    await db.fault_records.create_index([("archiveSha256", 1)])
    await db.sessions.create_index([("trainNo", 1), ("status", 1)])
    await db.reset_events.create_index([("trainNo", 1), ("createdAt", -1)])


@app.get("/")
async def root():
    return {"message": "UABAMS Cloud Running", "dashboard": "/dashboard", "docs": "/docs"}


@app.get("/dashboard")
async def dashboard_page():
    return FileResponse(Path("app/static/index.html"), headers={"Cache-Control": "no-store"})


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
    archive_body: Annotated[bytes, Body(media_type="application/zip")],
    x_api_key: Annotated[str, Header(alias="X-Api-Key")],
    x_sha256: Annotated[str | None, Header(alias="X-Sha256")] = None,
):
    gateway_id = request.state.gateway_id
    body = archive_body
    expected_sha256 = x_sha256 or request.headers.get("X-Archive-Sha256")
    actual_sha256 = sha256(body).hexdigest()

    if expected_sha256 and expected_sha256.lower() != actual_sha256:
        raise HTTPException(status_code=400, detail="SHA-256 mismatch")

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
        "rawFiles": parsed.raw_file_manifest,
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
        "warnings": warnings,
    }

@app.post("/api/v1/alert")
async def create_alert(
    data: AlertRequest,
    request: Request,
    x_api_key: Annotated[str, Header(alias="X-Api-Key")],
):
    gateway_id = request.state.gateway_id
    if data.gatewayId and data.gatewayId != gateway_id:
        raise HTTPException(status_code=403, detail="API key does not belong to supplied gateway")
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
    if gateway_id != request.state.gateway_id:
        raise HTTPException(status_code=403, detail="API key does not belong to calibration gateway")

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
    request: Request,
    x_api_key: Annotated[str, Header(alias="X-Api-Key")],
):
    if gateway_id != request.state.gateway_id:
        raise HTTPException(status_code=403, detail="API key does not belong to calibration gateway")

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
async def map_rms(train_id: str, gateway_id: str | None = None):
    archive_query: dict[str, Any] = {"trainId": train_id, "rmsRecordCount": {"$gt": 0}}
    if gateway_id:
        archive_query["gatewayId"] = gateway_id

    archives = await db.archives.find(
        archive_query,
        {"gatewayId": 1, "sha256": 1, "receivedAt": 1},
    ).sort("receivedAt", -1).to_list(length=50)

    latest_archive_by_gateway: dict[str, str] = {}
    for archive in archives:
        gateway = archive.get("gatewayId")
        archive_sha = archive.get("sha256") or archive.get("archiveSha256")
        if gateway and archive_sha and gateway not in latest_archive_by_gateway:
            latest_archive_by_gateway[gateway] = archive_sha

    query: dict[str, Any] = {
        "trainId": train_id,
        "gpsValid": True,
        "latitude": {"$nin": [None, 0]},
        "longitude": {"$nin": [None, 0]},
    }
    if latest_archive_by_gateway:
        query["archiveSha256"] = {"$in": list(latest_archive_by_gateway.values())}
    if gateway_id:
        query["gatewayId"] = gateway_id

    records = await db.rms_records.find(
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
    ).sort([("gatewayId", 1), ("positionMm", 1)]).limit(5000).to_list(length=5000)

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

    if location_filter:
        alert_query.update(location_filter)
        rms_query.update(location_filter)
        peak_query.update(location_filter)
        if not (data.startTime or data.endTime):
            fault_query = {"_id": {"$exists": False}}
            archive_query = {"_id": {"$exists": False}}

    deleted_alerts = await db.alert_events.delete_many(alert_query)
    deleted_rms = await db.rms_records.delete_many(rms_query)
    deleted_peak = await db.peak_records.delete_many(peak_query)
    deleted_faults = await db.fault_records.delete_many(fault_query)
    deleted_archives = await db.archives.delete_many(archive_query)

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
