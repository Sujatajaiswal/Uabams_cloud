import json
import logging
from datetime import datetime, UTC
import asyncpg
from bson import ObjectId

logger = logging.getLogger("db_wrapper")

FIELD_MAP = {
    "gatewayId": "gateway_id",
    "trainId": "train_id",
    "lastHeartbeat": "last_heartbeat",
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
}

REV_MAP = {v: k for k, v in FIELD_MAP.items()}

TABLE_COLUMNS = {
    "gateways": ["gateway_id", "train_id", "last_heartbeat", "status"],
    "gateway_auth": ["gateway_id", "secret_key", "created_at"],
    "gateway_status": [
        "gateway_id", "adxl_state", "adxl_uptime", "adxl_faults", "adxl_fw_version", "adxl_cal_version",
        "encoder_state", "encoder_uptime", "encoder_faults", "encoder_fw_version", "encoder_cal_version", "updated_at"
    ],
    "calibrations": [
        "gateway_id", "scale_x", "scale_y", "scale_z", "offset_x", "offset_y", "offset_z", "updated_at"
    ],
    "calibration_versions": [
        "gateway_id", "version", "scale_x", "scale_y", "scale_z", "offset_x", "offset_y", "offset_z", "created_at"
    ],
    "alert_events": ["train_no", "gateway_id", "alert_type", "latitude", "longitude", "position_mm", "created_at"],
    "archives": ["gateway_id", "sha256", "received_at"],
    "rms_records": [
        "train_id", "gateway_id", "session_name", "archive_sha256", "latitude", "longitude", "gps_valid",
        "bearing", "speed", "position_mm", "axes", "created_at"
    ],
    "peak_records": ["train_id", "gateway_id", "archive_sha256", "window_start_mm", "axes", "created_at"],
    "fault_records": ["train_id", "gateway_id", "archive_sha256", "timestamp_ms", "fault_code", "description", "created_at"],
    "sessions": ["train_no", "session_name", "status", "created_at"],
    "reset_events": ["train_no", "reason", "created_at"],
    "activity_logs": ["username", "page", "action", "error_message", "ip_address", "latitude", "longitude", "created_at"],
    "handshake_sessions": ["session_id", "created_at"],
    "time_domain_files": ["filename", "sha256", "total_size", "created_at"],
    "time_domain_chunks": ["file_id", "chunk_index", "chunk_data", "created_at"],
    "trains": ["train_no", "train_name", "created_at"]
}


def translate_filter(table_name, mongo_filter):
    where_clauses = []
    params = {}
    param_idx = 1
    
    for key, value in mongo_filter.items():
        pg_col = FIELD_MAP.get(key, key)
        if key == "_id":
            pg_col = "id"
            if hasattr(value, "__str__"):
                try:
                    value = int(str(value))
                except ValueError:
                    pass
            
        if isinstance(value, dict):
            for op, val in value.items():
                param_name = f"p_{param_idx}"
                param_idx += 1
                
                if op == "$gte":
                    where_clauses.append(f"{pg_col} >= ${param_name}")
                    params[param_name] = val
                elif op == "$lte":
                    where_clauses.append(f"{pg_col} <= ${param_name}")
                    params[param_name] = val
                elif op == "$gt":
                    where_clauses.append(f"{pg_col} > ${param_name}")
                    params[param_name] = val
                elif op == "$lt":
                    where_clauses.append(f"{pg_col} < ${param_name}")
                    params[param_name] = val
                elif op == "$ne":
                    if val is None:
                        where_clauses.append(f"{pg_col} IS NOT NULL")
                    else:
                        where_clauses.append(f"{pg_col} <> ${param_name}")
                        params[param_name] = val
                elif op == "$in":
                    placeholders = []
                    for item in val:
                        item_param = f"p_{param_idx}"
                        param_idx += 1
                        placeholders.append(f"${item_param}")
                        params[item_param] = item
                    where_clauses.append(f"{pg_col} IN ({', '.join(placeholders)})")
        else:
            if value is None:
                where_clauses.append(f"{pg_col} IS NULL")
            else:
                param_name = f"p_{param_idx}"
                param_idx += 1
                where_clauses.append(f"{pg_col} = ${param_name}")
                params[param_name] = value
                
    where_str = " AND ".join(where_clauses) if where_clauses else "TRUE"
    return where_str, params


def replace_named_params(sql_str, params):
    sorted_keys = sorted(params.keys(), key=lambda k: int(k.split("_")[1]))
    arg_list = []
    final_sql = sql_str
    for idx, key in enumerate(sorted_keys):
        placeholder = f"${key}"
        final_sql = final_sql.replace(placeholder, f"${idx + 1}")
        arg_list.append(params[key])
    return final_sql, arg_list


class InsertOneResult:
    def __init__(self, inserted_id):
        self.inserted_id = inserted_id


class InsertManyResult:
    def __init__(self, inserted_ids):
        self.inserted_ids = inserted_ids


class DeleteResult:
    def __init__(self, deleted_count):
        self.deleted_count = deleted_count



class CursorWrapper:
    def __init__(self, collection, filter_dict, projection=None, sort_list=None):
        self.collection = collection
        self.filter_dict = filter_dict
        self.projection = projection
        self.sort_list = sort_list
        self.limit_val = None
        
    def limit(self, limit_val):
        self.limit_val = limit_val
        return self
        
    def sort(self, sort_list_or_key, direction=None):
        if isinstance(sort_list_or_key, str):
            self.sort_list = [(sort_list_or_key, direction or 1)]
        else:
            self.sort_list = sort_list_or_key
        return self
        
    async def to_list(self, length=None):
        return await self.collection.execute_find(self.filter_dict, self.sort_list, self.limit_val or length)


class CollectionWrapper:
    def __init__(self, table_name, pg_pool):
        self.table_name = table_name
        self.pg_pool = pg_pool
        
    def _map_row(self, row):
        if row is None:
            return None
        row_dict = dict(row)
        mapped = {}
        for col, val in row_dict.items():
            if col == "id":
                mapped["_id"] = str(val)
                continue
            if col == "axes" and isinstance(val, str):
                try:
                    val = json.loads(val)
                except Exception:
                    pass
            mapped_key = REV_MAP.get(col, col)
            mapped[mapped_key] = val
        return mapped

    async def find_one(self, filter_dict, projection=None, sort=None):
        where_str, params = translate_filter(self.table_name, filter_dict)
        order_by = ""
        if sort:
            parts = []
            for key, direction in sort:
                pg_col = FIELD_MAP.get(key, key)
                if key == "_id":
                    pg_col = "id"
                dir_str = "DESC" if direction == -1 else "ASC"
                parts.append(f"{pg_col} {dir_str}")
            order_by = f"ORDER BY {', '.join(parts)}"
            
        sql_where, arg_list = replace_named_params(where_str, params)
        sql = f"SELECT * FROM {self.table_name} WHERE {sql_where} {order_by} LIMIT 1"
        
        async with self.pg_pool.acquire() as conn:
            row = await conn.fetchrow(sql, *arg_list)
            
        return self._map_row(row)

    def find(self, filter_dict, projection=None, sort=None):
        return CursorWrapper(self, filter_dict, projection, sort)

    async def execute_find(self, filter_dict, sort_list, limit_val):
        where_str, params = translate_filter(self.table_name, filter_dict)
        order_by = ""
        if sort_list:
            parts = []
            for key, direction in sort_list:
                pg_col = FIELD_MAP.get(key, key)
                if key == "_id":
                    pg_col = "id"
                dir_str = "DESC" if direction == -1 else "ASC"
                parts.append(f"{pg_col} {dir_str}")
            order_by = f"ORDER BY {', '.join(parts)}"
            
        limit_str = f"LIMIT {limit_val}" if limit_val is not None else ""
        sql_where, arg_list = replace_named_params(where_str, params)
        sql = f"SELECT * FROM {self.table_name} WHERE {sql_where} {order_by} {limit_str}"
        
        async with self.pg_pool.acquire() as conn:
            rows = await conn.fetch(sql, *arg_list)
            
        return [self._map_row(row) for row in rows]

    async def insert_one(self, document):
        doc = dict(document)
        insert_data = {}
        for k, v in doc.items():
            if k == "_id":
                continue
            pg_col = FIELD_MAP.get(k, k)
            if pg_col in TABLE_COLUMNS.get(self.table_name, []):
                if isinstance(v, (dict, list)):
                    v = json.dumps(v)
                insert_data[pg_col] = v
                
        pk_col = "id"
        if self.table_name in ["gateways", "gateway_auth", "gateway_status", "calibrations"]:
            pk_col = "gateway_id"
            if "gatewayId" in doc:
                insert_data["gateway_id"] = doc["gatewayId"]
        elif self.table_name == "handshake_sessions":
            pk_col = "session_id"
            if "sessionId" in doc:
                insert_data["session_id"] = doc["sessionId"]
        elif self.table_name == "trains":
            pk_col = "train_no"
            if "trainNo" in doc:
                insert_data["train_no"] = doc["trainNo"]
                
        cols = list(insert_data.keys())
        placeholders = [f"${i+1}" for i in range(len(cols))]
        sql = f"INSERT INTO {self.table_name} ({', '.join(cols)}) VALUES ({', '.join(placeholders)}) RETURNING {pk_col}"
        
        values = [insert_data[c] for c in cols]
        async with self.pg_pool.acquire() as conn:
            res_val = await conn.fetchval(sql, *values)
            
        return InsertOneResult(inserted_id=str(res_val))

    async def insert_many(self, documents):
        if not documents:
            return InsertManyResult([])
            
        inserted_ids = []
        async with self.pg_pool.acquire() as conn:
            async with conn.transaction():
                for doc in documents:
                    d = dict(doc)
                    insert_data = {}
                    for k, v in d.items():
                        if k == "_id":
                            continue
                        pg_col = FIELD_MAP.get(k, k)
                        if pg_col in TABLE_COLUMNS.get(self.table_name, []):
                            if isinstance(v, (dict, list)):
                                v = json.dumps(v)
                            insert_data[pg_col] = v
                            
                    pk_col = "id"
                    if self.table_name in ["gateways", "gateway_auth", "gateway_status", "calibrations"]:
                        pk_col = "gateway_id"
                        if "gatewayId" in d:
                            insert_data["gateway_id"] = d["gatewayId"]
                    elif self.table_name == "handshake_sessions":
                        pk_col = "session_id"
                        if "sessionId" in d:
                            insert_data["session_id"] = d["sessionId"]
                    elif self.table_name == "trains":
                        pk_col = "train_no"
                        if "trainNo" in d:
                            insert_data["train_no"] = d["trainNo"]
                            
                    cols = list(insert_data.keys())
                    placeholders = [f"${i+1}" for i in range(len(cols))]
                    sql = f"INSERT INTO {self.table_name} ({', '.join(cols)}) VALUES ({', '.join(placeholders)}) RETURNING {pk_col}"
                    
                    values = [insert_data[c] for c in cols]
                    res_val = await conn.fetchval(sql, *values)
                    inserted_ids.append(str(res_val))
                    
        return InsertManyResult(inserted_ids)

    async def update_one(self, filter_dict, update_dict, upsert=False):
        set_data = update_dict.get("$set", {})
        if not set_data:
            return
            
        set_fields = {}
        for k, v in set_data.items():
            pg_col = FIELD_MAP.get(k, k)
            if pg_col in TABLE_COLUMNS.get(self.table_name, []):
                if isinstance(v, (dict, list)):
                    v = json.dumps(v)
                set_fields[pg_col] = v
                
        if upsert:
            pk_col = "id"
            if self.table_name in ["gateways", "gateway_auth", "gateway_status", "calibrations"]:
                pk_col = "gateway_id"
            elif self.table_name == "handshake_sessions":
                pk_col = "session_id"
            elif self.table_name == "trains":
                pk_col = "train_no"
                
            insert_data = {}
            for k, v in filter_dict.items():
                col = FIELD_MAP.get(k, k)
                if k == "_id":
                    col = "id"
                if col in TABLE_COLUMNS.get(self.table_name, []):
                    insert_data[col] = v
            for k, v in set_fields.items():
                insert_data[k] = v
                
            cols = list(insert_data.keys())
            placeholders = [f"${i+1}" for i in range(len(cols))]
            
            update_clauses = []
            for col in set_fields.keys():
                if col != pk_col:
                    update_clauses.append(f"{col} = EXCLUDED.{col}")
            update_str = ", ".join(update_clauses) if update_clauses else "NOTHING"
            
            sql = f"""
                INSERT INTO {self.table_name} ({', '.join(cols)})
                VALUES ({', '.join(placeholders)})
                ON CONFLICT ({pk_col})
                DO UPDATE SET {update_str}
            """
            values = [insert_data[c] for c in cols]
            async with self.pg_pool.acquire() as conn:
                await conn.execute(sql, *values)
        else:
            set_clauses = []
            param_idx = 1
            sql_params = {}
            
            for col, val in set_fields.items():
                param_name = f"u_{param_idx}"
                param_idx += 1
                set_clauses.append(f"{col} = ${param_name}")
                sql_params[param_name] = val
                
            where_clauses = []
            for key, value in filter_dict.items():
                pg_col = FIELD_MAP.get(key, key)
                if key == "_id":
                    pg_col = "id"
                    if hasattr(value, "__str__"):
                        try:
                            value = int(str(value))
                        except ValueError:
                            pass
                param_name = f"f_{param_idx}"
                param_idx += 1
                where_clauses.append(f"{pg_col} = ${param_name}")
                sql_params[param_name] = value
                
            where_str = " AND ".join(where_clauses) if where_clauses else "TRUE"
            combined_sql = f"UPDATE {self.table_name} SET {', '.join(set_clauses)} WHERE {where_str}"
            final_sql, final_args = replace_named_params(combined_sql, sql_params)
            
            async with self.pg_pool.acquire() as conn:
                await conn.execute(final_sql, *final_args)

    async def delete_many(self, filter_dict):
        where_str, params = translate_filter(self.table_name, filter_dict)
        sql_where, arg_list = replace_named_params(where_str, params)
        sql = f"DELETE FROM {self.table_name} WHERE {sql_where}"
        async with self.pg_pool.acquire() as conn:
            res_str = await conn.execute(sql, *arg_list)
            
        deleted_count = 0
        if res_str and res_str.startswith("DELETE "):
            try:
                deleted_count = int(res_str.split(" ")[1])
            except Exception:
                pass
        return DeleteResult(deleted_count)

    async def delete_one(self, filter_dict):
        where_str, params = translate_filter(self.table_name, filter_dict)
        sql_where, arg_list = replace_named_params(where_str, params)
        
        pk_col = "id"
        if self.table_name in ["gateways", "gateway_auth", "gateway_status", "calibrations"]:
            pk_col = "gateway_id"
        elif self.table_name == "handshake_sessions":
            pk_col = "session_id"
        elif self.table_name == "trains":
            pk_col = "train_no"
            
        sql = f"DELETE FROM {self.table_name} WHERE {pk_col} IN (SELECT {pk_col} FROM {self.table_name} WHERE {sql_where} LIMIT 1)"
        async with self.pg_pool.acquire() as conn:
            await conn.execute(sql, *arg_list)

    async def create_index(self, *args, **kwargs):
        pass


class DatabaseWrapper:
    def __init__(self, db_type, motor_db=None, pg_pool=None):
        self.db_type = db_type
        self.motor_db = motor_db
        self.pg_pool = pg_pool

    def __getattr__(self, name):
        if self.db_type == "mongodb":
            return getattr(self.motor_db, name)
        else:
            return CollectionWrapper(name, self.pg_pool)
