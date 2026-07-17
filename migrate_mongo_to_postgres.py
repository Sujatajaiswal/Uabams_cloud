import asyncio
import os
import json
from datetime import datetime
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
import asyncpg

load_dotenv(override=True)

MONGO_URL = os.getenv("MONGODB_URL", "mongodb://localhost:27017")
DATABASE_NAME = os.getenv("DATABASE_NAME", "uabams")
PG_URL = os.getenv("DATABASE_URL", "postgresql://postgres:sujata123@localhost:5432/uabams_db")

FIELD_MAP = {
    "gatewayId": "gateway_id",
    "trainId": "train_id",
    "lastHeartbeat": "last_heartbeat",
    "lastHandshake": "last_handshake",
    "apiKey": "secret_key",
    "createdAt": "created_at",
    "adxlState": "adxl_state",
    "adxlUptime": "adxl_uptime",
    "adxlFaults": "adxl_faults",
    "adxlFwVersion": "adxl_fw_version",
    "adxlCalVersion": "adxl_cal_version",
    "encoderState": "encoder_state",
    "encoderUptime": "encoder_uptime",
    "encoderFaults": "encoder_faults",
    "encoderFwVersion": "encoder_fw_version",
    "encoderCalVersion": "encoder_cal_version",
    "updatedAt": "updated_at",
    "scaleX": "scale_x",
    "scaleY": "scale_y",
    "scaleZ": "scale_z",
    "offsetX": "offset_x",
    "offsetY": "offset_y",
    "offsetZ": "offset_z",
    "trainNo": "train_no",
    "trainName": "train_name",
    "alertType": "alert_type",
    "positionMm": "position_mm",
    "receivedAt": "received_at",
    "sessionName": "session_name",
    "archiveSha256": "archive_sha256",
    "gpsValid": "gps_valid",
    "windowStartMm": "window_start_mm",
    "timestampMs": "timestamp_ms",
    "faultCode": "fault_code",
    "description": "description",
    "errorMessage": "error_message",
    "ipAddress": "ip_address",
    "sessionId": "session_id",
    "totalSize": "total_size",
    "fileId": "file_id",
    "chunkIndex": "chunk_index",
    "chunkData": "chunk_data",
    "peakAxis": "peak_axis",
    "peakValueG": "peak_value_g",
    "speedKmph": "speed_kmph",
    "sessionStatus": "session_status",
    "archivedAt": "archived_at",
}

TABLE_COLUMNS = {
    "gateways": ["gateway_id", "train_id", "last_heartbeat", "status"],
    "gateway_auth": ["gateway_id", "secret_key", "created_at"],
    "gateway_status": [
        "gateway_id", "adxl_state", "adxl_uptime", "adxl_faults", "adxl_fw_version", "adxl_cal_version",
        "encoder_state", "encoder_uptime", "encoder_faults", "encoder_fw_version", "encoder_cal_version", "updated_at",
        "train_id", "online", "last_heartbeat", "last_handshake"
    ],
    "calibrations": [
        "gateway_id", "scale_x", "scale_y", "scale_z", "offset_x", "offset_y", "offset_z", "updated_at"
    ],
    "calibration_versions": [
        "gateway_id", "version", "scale_x", "scale_y", "scale_z", "offset_x", "offset_y", "offset_z", "created_at"
    ],
    "alert_events": [
        "train_no", "gateway_id", "alert_type", "latitude", "longitude", "position_mm", "created_at",
        "session_name", "archive_sha256", "source", "peak_axis", "peak_value_g", "speed_kmph", "alert", "session_status", "archived_at"
    ],
    "archives": ["gateway_id", "sha256", "received_at", "train_id"],
    "rms_records": [
        "train_id", "gateway_id", "session_name", "archive_sha256", "latitude", "longitude", "gps_valid",
        "bearing", "speed", "position_mm", "axes", "created_at"
    ],
    "peak_records": [
        "train_id", "gateway_id", "archive_sha256", "window_start_mm", "axes", "created_at",
        "position_mm", "speed_kmph", "latitude", "longitude"
    ],
    "fault_records": ["train_id", "gateway_id", "archive_sha256", "timestamp_ms", "fault_code", "description", "created_at"],
    "sessions": ["train_no", "session_name", "status", "created_at"],
    "reset_events": ["train_no", "reason", "created_at"],
    "activity_logs": ["username", "page", "action", "error_message", "ip_address", "latitude", "longitude", "created_at"],
    "handshake_sessions": ["session_id", "created_at"],
    "time_domain_files": ["filename", "sha256", "total_size", "created_at"],
    "time_domain_chunks": ["file_id", "chunk_index", "chunk_data", "created_at"],
    "trains": ["train_no", "train_name", "created_at"]
}

async def migrate_collection(mongo_db, pg_pool, col_name):
    print(f"Migrating collection: {col_name}...")
    cursor = mongo_db[col_name].find({})
    docs = await cursor.to_list(length=1000000)
    if not docs:
        print(f"No records found for: {col_name}.")
        return

    columns = TABLE_COLUMNS[col_name]
    placeholders = [f"${i+1}" for i in range(len(columns))]
    sql = f"INSERT INTO {col_name} ({', '.join(columns)}) VALUES ({', '.join(placeholders)}) ON CONFLICT DO NOTHING"
    
    batch_size = 500
    async with pg_pool.acquire() as conn:
        for i in range(0, len(docs), batch_size):
            chunk = docs[i : i + batch_size]
            row_batches = []
            for doc in chunk:
                row_vals = []
                for col in columns:
                    mongo_key = None
                    for k, v in FIELD_MAP.items():
                        if v == col:
                            mongo_key = k
                            break
                    if mongo_key is None:
                        mongo_key = col
                    
                    val = doc.get(mongo_key)
                    if val is None and col == "gateway_id":
                        val = doc.get("gatewayId")
                    if val is None and col == "session_id":
                        val = doc.get("sessionId")
                    if val is None and col == "train_no":
                        val = doc.get("trainNo")
                        
                    if isinstance(val, (dict, list)):
                        val = json.dumps(val)
                    row_vals.append(val)
                row_batches.append(row_vals)
                
            try:
                async with conn.transaction():
                    await conn.executemany(sql, row_batches)
            except Exception:
                # Fallback to row-by-row insert on batch failure (e.g. foreign key constraint violation)
                for row_vals in row_batches:
                    try:
                        async with conn.transaction():
                            await conn.execute(sql, *row_vals)
                    except Exception as inner_e:
                        pass
                
    print(f"Completed migration for: {col_name} ({len(docs)} records).")

async def main():
    pg_pool = await asyncpg.create_pool(PG_URL)
    async with pg_pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS trains (
                train_no VARCHAR(50) PRIMARY KEY,
                train_name VARCHAR(255) NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS session_name VARCHAR(100);
            ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS archive_sha256 VARCHAR(64);
            ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS source VARCHAR(50);
            ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS peak_axis VARCHAR(10);
            ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS peak_value_g DOUBLE PRECISION;
            ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS speed_kmph DOUBLE PRECISION;
            ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS alert VARCHAR(20);
            ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS session_status VARCHAR(50) DEFAULT 'active';
            ALTER TABLE alert_events ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;
            ALTER TABLE archives ADD COLUMN IF NOT EXISTS train_id VARCHAR(50);
            ALTER TABLE gateway_status ADD COLUMN IF NOT EXISTS train_id VARCHAR(50);
            ALTER TABLE gateway_status ADD COLUMN IF NOT EXISTS online BOOLEAN DEFAULT FALSE;
            ALTER TABLE gateway_status ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMP WITH TIME ZONE;
            ALTER TABLE gateway_status ADD COLUMN IF NOT EXISTS last_handshake TIMESTAMP WITH TIME ZONE;
            ALTER TABLE peak_records ADD COLUMN IF NOT EXISTS position_mm INTEGER;
            ALTER TABLE peak_records ADD COLUMN IF NOT EXISTS speed_kmph DOUBLE PRECISION;
            ALTER TABLE peak_records ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
            ALTER TABLE peak_records ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
        """)
        # Clear alert_events, archives, gateway_status, and peak_records so they are re-migrated cleanly with the new columns populated
        await conn.execute("TRUNCATE TABLE alert_events, archives, gateway_status, peak_records RESTART IDENTITY;")

    mongo_client = AsyncIOMotorClient(MONGO_URL)
    mongo_db = mongo_client[DATABASE_NAME]
    
    collections = [
        "gateways",
        "gateway_auth",
        "gateway_status",
        "calibrations",
        "calibration_versions",
        "trains",
        "alert_events",
        "archives",
        "rms_records",
        "peak_records",
        "fault_records",
        "sessions",
        "reset_events",
        "activity_logs",
        "handshake_sessions",
        "time_domain_files"
    ]
    
    for col in collections:
        await migrate_collection(mongo_db, pg_pool, col)
        
    print("Migrating collection: time_domain_chunks...")
    cursor = mongo_db.time_domain_chunks.find({})
    chunks = await cursor.to_list(length=100000)
    if chunks:
        async with pg_pool.acquire() as conn:
            files = await conn.fetch("SELECT id, filename FROM time_domain_files")
            mongo_files = await mongo_db.time_domain_files.find({}).to_list(length=100000)
            mongo_file_map = {str(f["_id"]): f["filename"] for f in mongo_files}
            pg_file_map = {f["filename"]: f["id"] for f in files}
            
            batch = []
            sql = "INSERT INTO time_domain_chunks (file_id, chunk_index, chunk_data, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING"
            for chunk in chunks:
                mongo_file_id = str(chunk.get("fileId", ""))
                filename = mongo_file_map.get(mongo_file_id)
                pg_file_id = pg_file_map.get(filename) if filename else None
                if pg_file_id:
                    batch.append((pg_file_id, chunk.get("chunkIndex"), chunk.get("chunkData"), chunk.get("createdAt")))
            if batch:
                await conn.executemany(sql, batch)
        print(f"Completed migration for: time_domain_chunks ({len(chunks)} records).")

    print("Data migration from MongoDB to PostgreSQL finished successfully!")

if __name__ == "__main__":
    asyncio.run(main())
