from __future__ import annotations

import json
import struct
import zipfile
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any


RMS_RECORD_SIZE = 66
RMS_FORMAT = "<Qidd?BIIIIIIIII"

PEAK_RECORD_SIZE = 302
PEAK_HEADER_FORMAT = "<iifB?"
PEAK_AXIS_FORMAT = "<IiQdd"
PEAK_AXIS_SIZE = 32

FAULT_RECORD_SIZE = 75
FAULT_FORMAT = "<QBBB64s"

SENTINEL_U32 = 0xFFFFFFFF
AXIS_NAMES = ("al_x", "al_y", "al_z", "ar_x", "ar_y", "ar_z", "bg_x", "bg_y", "bg_z")

FAULT_CODE_NAMES = {
    0x00: "FAULT_NONE",
    0x10: "FAULT_NODE_TIMEOUT",
    0x11: "FAULT_CRC_ERROR",
    0x20: "FAULT_SD_CARD_MISSING",
    0x21: "FAULT_SD_CARD_FULL",
    0x22: "FAULT_STORAGE_WRITE",
    0x30: "FAULT_GPS_LOST",
    0x40: "FAULT_UPLOAD_FAILED",
    0x50: "FAULT_CONFIG_INVALID",
    0x60: "FAULT_SEGMENT_INVALID",
    0x61: "FAULT_COUNT_JUMP",
    0x62: "FAULT_ALL_VIBRATION_MISSING",
}


@dataclass
class ParsedArchive:
    metadata: dict[str, Any] = field(default_factory=dict)
    files: list[str] = field(default_factory=list)
    rms_records: list[dict[str, Any]] = field(default_factory=list)
    peak_records: list[dict[str, Any]] = field(default_factory=list)
    fault_records: list[dict[str, Any]] = field(default_factory=list)
    raw_file_manifest: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def parse_archive_zip(body: bytes) -> ParsedArchive:
    try:
        with zipfile.ZipFile(BytesIO(body)) as archive:
            result = ParsedArchive(files=archive.namelist())
            result.metadata = _read_metadata(archive, result.warnings)
            result.raw_file_manifest = _raw_manifest(archive)

            rms_name = _find_member(archive, "rms/rms_25cm.bin")
            if rms_name:
                result.rms_records = parse_rms_bytes(archive.read(rms_name), result.warnings)
            else:
                result.warnings.append("Missing rms/rms_25cm.bin")

            peak_name = _find_member(archive, "peak/peak_50m.bin")
            if peak_name:
                result.peak_records = parse_peak_bytes(archive.read(peak_name), result.warnings)
            else:
                result.warnings.append("Missing peak/peak_50m.bin")

            fault_name = _find_member(archive, "faults/faults.bin")
            if fault_name:
                result.fault_records = parse_fault_bytes(archive.read(fault_name), result.warnings)
            else:
                result.warnings.append("Missing faults/faults.bin")

            return result
    except zipfile.BadZipFile as exc:
        raise ValueError("Invalid ZIP file") from exc


def parse_rms_bytes(raw: bytes, warnings: list[str] | None = None) -> list[dict[str, Any]]:
    _warn_on_remainder("rms/rms_25cm.bin", raw, RMS_RECORD_SIZE, warnings)
    records: list[dict[str, Any]] = []
    usable = len(raw) - (len(raw) % RMS_RECORD_SIZE)

    for offset in range(0, usable, RMS_RECORD_SIZE):
        chunk = raw[offset : offset + RMS_RECORD_SIZE]
        unpacked = struct.unpack(RMS_FORMAT, chunk)
        master_count, position_mm, latitude, longitude, gps_valid, valid_mask, *axis_mg = unpacked
        axis_values = {name: _mg_value(value) for name, value in zip(AXIS_NAMES, axis_mg)}
        valid_axis_g = [item["g"] for item in axis_values.values() if item["g"] is not None]
        max_g = max(valid_axis_g, default=0.0)

        record: dict[str, Any] = {
            "recordIndex": offset // RMS_RECORD_SIZE,
            "masterCount": master_count,
            "positionMm": position_mm,
            "latitude": latitude,
            "longitude": longitude,
            "gpsValid": gps_valid,
            "validMask": valid_mask,
            "maxG": round(max_g, 4),
            "maxMg": int(round(max_g * 1000)),
            "color": _color_for_g(max_g),
        }
        for axis_name, value in axis_values.items():
            record[f"{axis_name}_mg"] = value["mg"]
            record[f"{axis_name}_g"] = value["g"]
        records.append(record)

    return records


def parse_peak_bytes(raw: bytes, warnings: list[str] | None = None) -> list[dict[str, Any]]:
    _warn_on_remainder("peak/peak_50m.bin", raw, PEAK_RECORD_SIZE, warnings)
    records: list[dict[str, Any]] = []
    usable = len(raw) - (len(raw) % PEAK_RECORD_SIZE)

    for offset in range(0, usable, PEAK_RECORD_SIZE):
        chunk = raw[offset : offset + PEAK_RECORD_SIZE]
        window_start, window_end, speed_kmph, valid_mask, alert_generated = struct.unpack_from(
            PEAK_HEADER_FORMAT, chunk, 0
        )
        axes: dict[str, Any] = {}

        for index, axis_name in enumerate(AXIS_NAMES):
            base = 14 + index * PEAK_AXIS_SIZE
            peak_mg, peak_position, peak_master_count, peak_lat, peak_lon = struct.unpack_from(
                PEAK_AXIS_FORMAT, chunk, base
            )
            value = _mg_value(peak_mg)
            axes[axis_name] = {
                "peakValueMg": value["mg"],
                "peakValueG": value["g"],
                "peakPositionMm": peak_position,
                "peakMasterCount": peak_master_count,
                "peakLat": peak_lat,
                "peakLon": peak_lon,
            }

        max_axis, max_axis_data = _max_peak_axis(axes)
        max_g = max_axis_data.get("peakValueG") or 0.0
        records.append(
            {
                "recordIndex": offset // PEAK_RECORD_SIZE,
                "windowStartMm": window_start,
                "windowEndMm": window_end,
                "speedKmph": round(speed_kmph, 2),
                "validMask": valid_mask,
                "alertGenerated": alert_generated,
                "axes": axes,
                "maxPeakAxis": max_axis,
                "maxPeakMg": max_axis_data.get("peakValueMg"),
                "maxPeakG": round(max_g, 4),
                "latitude": max_axis_data.get("peakLat"),
                "longitude": max_axis_data.get("peakLon"),
                "positionMm": max_axis_data.get("peakPositionMm"),
                "masterCount": max_axis_data.get("peakMasterCount"),
                "color": _color_for_g(max_g),
            }
        )

    return records


def parse_fault_bytes(raw: bytes, warnings: list[str] | None = None) -> list[dict[str, Any]]:
    _warn_on_remainder("faults/faults.bin", raw, FAULT_RECORD_SIZE, warnings)
    records: list[dict[str, Any]] = []
    usable = len(raw) - (len(raw) % FAULT_RECORD_SIZE)

    for offset in range(0, usable, FAULT_RECORD_SIZE):
        timestamp_ms, fault_code, node_id, severity, description = struct.unpack(
            FAULT_FORMAT, raw[offset : offset + FAULT_RECORD_SIZE]
        )
        records.append(
            {
                "recordIndex": offset // FAULT_RECORD_SIZE,
                "timestampMs": timestamp_ms,
                "faultCode": fault_code,
                "faultName": FAULT_CODE_NAMES.get(fault_code, "FAULT_UNKNOWN"),
                "nodeId": node_id,
                "severity": severity,
                "description": description.split(b"\x00", 1)[0].decode("ascii", errors="replace"),
            }
        )

    return records


def peak_records_to_alert_events(
    peak_records: list[dict[str, Any]],
    gateway_id: str,
    train_id: str,
    session_name: str,
    archive_sha256: str,
    created_at: Any,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for record in peak_records:
        if not record.get("alertGenerated"):
            continue
        latitude = record.get("latitude")
        longitude = record.get("longitude")
        if latitude in (None, 0) or longitude in (None, 0):
            continue
        events.append(
            {
                "gatewayId": gateway_id,
                "trainNo": train_id,
                "sessionName": session_name,
                "archiveSha256": archive_sha256,
                "source": "peak_50m.bin",
                "peakAxis": record.get("maxPeakAxis"),
                "peakValueG": record.get("maxPeakG", 0),
                "positionMm": record.get("positionMm"),
                "speedKmph": record.get("speedKmph"),
                "latitude": latitude,
                "longitude": longitude,
                "alert": record.get("color", "GREEN"),
                "createdAt": created_at,
            }
        )
    return events


def _read_metadata(archive: zipfile.ZipFile, warnings: list[str]) -> dict[str, Any]:
    member = _find_member(archive, "session_metadata.json")
    if not member:
        warnings.append("Missing session_metadata.json")
        return {}

    try:
        return json.loads(archive.read(member).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        warnings.append(f"Invalid session_metadata.json: {exc}")
        return {}


def _raw_manifest(archive: zipfile.ZipFile) -> list[dict[str, Any]]:
    manifest = []
    for info in archive.infolist():
        normalized = _normalize_path(info.filename)
        if normalized.startswith("raw/") and not info.is_dir():
            manifest.append({"path": normalized, "sizeBytes": info.file_size})
    return manifest


def _find_member(archive: zipfile.ZipFile, suffix: str) -> str | None:
    normalized_suffix = _normalize_path(suffix)
    for name in archive.namelist():
        if _normalize_path(name).endswith(normalized_suffix):
            return name
    return None


def _normalize_path(path: str) -> str:
    return path.replace("\\", "/").lstrip("/").lower()


def _warn_on_remainder(name: str, raw: bytes, record_size: int, warnings: list[str] | None) -> None:
    remainder = len(raw) % record_size
    if remainder and warnings is not None:
        warnings.append(f"{name} has {remainder} trailing bytes after {len(raw) // record_size} complete records")


def _mg_value(value: int) -> dict[str, int | float | None]:
    if value == SENTINEL_U32:
        return {"mg": None, "g": None}
    return {"mg": value, "g": round(value / 1000.0, 4)}


def _color_for_g(value: float) -> str:
    if value > 80:
        return "RED"
    if value > 50:
        return "YELLOW"
    return "GREEN"

def _max_peak_axis(axes: dict[str, dict[str, Any]]) -> tuple[str | None, dict[str, Any]]:
    valid_axes = [
        (axis_name, axis_data)
        for axis_name, axis_data in axes.items()
        if axis_data.get("peakValueG") is not None
    ]
    if not valid_axes:
        return None, {}
    return max(valid_axes, key=lambda item: item[1].get("peakValueG") or 0)
