from __future__ import annotations

import argparse
import json
import math
import random
import struct
import time
import urllib.error
import urllib.request
import zipfile
from hashlib import sha256
from io import BytesIO
from pathlib import Path

RMS_FORMAT = "<Qifdd?B9f"
PEAK_HEADER_FORMAT = "<iifB?"
PEAK_AXIS_FORMAT = "<fIQdd"
FAULT_FORMAT = "<QBBB64s"
AXIS_COUNT = 9


def lerp(a: float, b: float, ratio: float) -> float:
    return a + (b - a) * ratio


def route_point(index: int, total: int, upload_index: int) -> tuple[float, float]:
    ratio = min(1.0, (upload_index * total + index) / max((200 * total), 1))
    base_lat = lerp(12.9716, 13.0350, ratio)
    base_lon = lerp(77.5946, 77.6400, ratio)
    return base_lat + math.sin(ratio * 12) * 0.0015, base_lon + math.cos(ratio * 10) * 0.0015


def severity_peak(upload_index: int, record_index: int) -> float:
    if (upload_index + record_index) % 37 == 0:
        return random.uniform(82, 95)
    if (upload_index + record_index) % 13 == 0:
        return random.uniform(52, 70)
    return random.uniform(8, 42)


def build_rms(upload_index: int, records: int) -> bytes:
    chunks = []
    for i in range(records):
        lat, lon = route_point(i, records, upload_index)
        max_g = severity_peak(upload_index, i)
        axes = [random.uniform(0.5, max(1.0, max_g * 0.45)) for _ in range(AXIS_COUNT)]
        axes[random.randrange(AXIS_COUNT)] = max_g
        chunks.append(struct.pack(
            RMS_FORMAT,
            upload_index * 100000 + i,
            upload_index * records * 250 + i * 250,
            random.uniform(72, 105),
            lat,
            lon,
            True,
            0xFF,
            *axes,
        ))
    return b"".join(chunks)


def build_peak(upload_index: int, records: int) -> bytes:
    output = bytearray()
    for i in range(records):
        window_start = upload_index * 50000 + i * 50000
        window_end = window_start + 50000
        max_g = severity_peak(upload_index, i * 3)
        alert_generated = max_g > 80
        output += struct.pack(PEAK_HEADER_FORMAT, window_start, window_end, random.uniform(75, 105), 0xFF, alert_generated)
        for axis in range(AXIS_COUNT):
            peak_g = max_g if axis == 0 else random.uniform(2, max(3, max_g * 0.35))
            lat, lon = route_point(i * 4 + axis, 30, upload_index)
            output += struct.pack(PEAK_AXIS_FORMAT, peak_g, window_start + axis * 500, upload_index * 100000 + i, lat, lon)
    return bytes(output)


def build_fault(upload_index: int) -> bytes:
    if upload_index % 20 != 0:
        return b""
    description = f"SIM fault upload {upload_index}".encode("ascii")[:64].ljust(64, b"\0")
    return struct.pack(FAULT_FORMAT, int(time.time() * 1000), 0x30, 1, 2, description)


def build_zip(args: argparse.Namespace, upload_index: int) -> bytes:
    metadata = {
        "sessionName": f"SIM_{args.train_id}_{upload_index:04d}",
        "trainId": args.train_id,
        "gatewayId": args.gateway_id,
        "sessionStatus": "active",
        "simulated": True,
        "uploadIndex": upload_index,
    }
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("session_metadata.json", json.dumps(metadata, indent=2))
        zf.writestr("rms/rms_25cm.bin", build_rms(upload_index, args.rms_records))
        zf.writestr("peak/peak_50m.bin", build_peak(upload_index, args.peak_records))
        zf.writestr("faults/faults.bin", build_fault(upload_index))
    return buffer.getvalue()


def upload_archive(args: argparse.Namespace, payload: bytes) -> dict:
    req = urllib.request.Request(
        f"{args.base_url.rstrip('/')}/api/v1/archive",
        data=payload,
        method="PUT",
        headers={
            "Content-Type": "application/zip",
            "X-Api-Key": args.api_key,
            "X-Sha256": sha256(payload).hexdigest(),
        },
    )
    with urllib.request.urlopen(req, timeout=args.timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate and upload UABAMS synthetic archive ZIP files.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--gateway-id", default="GW_UABAMS_BOGIE_01")
    parser.add_argument("--train-id", default="019456")
    parser.add_argument("--count", type=int, default=200)
    parser.add_argument("--rms-records", type=int, default=50)
    parser.add_argument("--peak-records", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--save-dir", default="")
    args = parser.parse_args()

    save_dir = Path(args.save_dir) if args.save_dir else None
    if save_dir:
        save_dir.mkdir(parents=True, exist_ok=True)

    success = 0
    for index in range(args.count):
        payload = build_zip(args, index)
        if save_dir:
            (save_dir / f"{args.gateway_id}__{args.train_id}__SIM_{index:04d}.zip").write_bytes(payload)
        try:
            result = upload_archive(args, payload)
            success += 1
            print(f"{index + 1}/{args.count} uploaded: rms={result.get('rmsRecords')} peakAlerts={result.get('peakAlerts')}")
        except urllib.error.HTTPError as exc:
            print(f"{index + 1}/{args.count} failed: HTTP {exc.code} {exc.read().decode('utf-8', errors='replace')}")
        except Exception as exc:
            print(f"{index + 1}/{args.count} failed: {exc}")
    print(f"Completed {success}/{args.count} uploads")


if __name__ == "__main__":
    main()
