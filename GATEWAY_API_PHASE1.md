# UABAMS Backend Authentication Spec

Base URL local: `http://127.0.0.1:8000`
Base URL deployed: `https://your-render-service.onrender.com`

The gateway is outbound-only. The FastAPI backend is the passive receiver. Do not implement a raw TCP handshake; HTTP over TCP already handles that.

## Required Headers

Every gateway request to the protected endpoints must include:

```text
X-Gateway-Id: GW_UABAMS_BOGIE_01
X-Train-Id: 019456
X-Api-Key: shared-secret-key
```

For train `019456`, use these prototype credentials:

```text
Gateway 1:
X-Gateway-Id: GW_UABAMS_BOGIE_01
X-Train-Id: 019456
X-Api-Key: <GW1_API_KEY_FROM_ENV>

Gateway 2:
X-Gateway-Id: GW_UABAMS_BOGIE_02
X-Train-Id: 019456
X-Api-Key: <GW2_API_KEY_FROM_ENV>
```

Keep these keys private. Share them with the gateway developer offline only.

## Protected Endpoints

These endpoints require the headers above:

```text
PUT  /api/v1/archive
POST /api/v1/alert
GET  /api/v1/calibration/{gatewayId}
```

On auth failure:

```text
401 = missing headers
403 = wrong gateway ID or API key
```

## 1. Upload Archive

`PUT /api/v1/archive`

Headers:

```text
Content-Type: application/zip
X-Gateway-Id: GW_UABAMS_BOGIE_01
X-Train-Id: 019456
X-Api-Key: <secret>
X-Sha256: <optional sha256 of zip body>
```

The backend calculates SHA-256. If `X-Sha256` is present and does not match, the API returns `400`.

Success response:

```json
{
  "status": "success",
  "sha256": "calculated_hash",
  "sizeBytes": 12345
}
```

MongoDB collection: `archives`

## 2. Send Alert

`POST /api/v1/alert`

Request:

```json
{
  "latitude": 12.9,
  "longitude": 77.5,
  "peakValueG": 90
}
```

Backend threshold logic:

```text
peakValueG > 80 = RED
peakValueG > 50 = YELLOW
else            = GREEN
```

MongoDB collection: `alert_events`

## 3. Fetch Calibration

`GET /api/v1/calibration/GW_UABAMS_BOGIE_01`

Request headers must contain the same gateway ID as the path.

Success response:

```json
{
  "gatewayId": "GW_UABAMS_BOGIE_01",
  "version": 1,
  "adxl_left": {"x": 1.0, "y": 1.0, "z": 1.0},
  "adxl_right": {"x": 1.0, "y": 1.0, "z": 1.0},
  "bogie": {},
  "encoder": {}
}
```

MongoDB collection: `calibration_versions`

## What Gateway Developer Should Do

1. Add the three headers to existing HTTP requests.
2. Send archives with `PUT /api/v1/archive`.
3. Send alerts with `POST /api/v1/alert`.
4. Fetch calibration after boot using `GET /api/v1/calibration/{gatewayId}`.
5. Treat HTTP `2xx` as success. Treat `401`, `403`, `400`, `500` as failure.

