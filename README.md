# UABAMS Cloud Prototype

FastAPI backend and browser dashboard for UABAMS gateway communication.

## Local Run

```powershell
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

Open:

```text
Dashboard: http://127.0.0.1:8000/dashboard
Swagger:   http://127.0.0.1:8000/docs
Health:    http://127.0.0.1:8000/
```

## Gateway APIs

```text
PUT  /api/v1/archive
POST /api/v1/alert
GET  /api/v1/calibration/{gatewayId}
GET  /api/v1/map/alerts?train_id=019456
GET  /api/v1/map/rms?train_id=019456
GET  /api/v1/trains/{trainNo}/dashboard
POST /api/v1/sessions/reset
```

Gateway upload, alert, and calibration APIs require:

```text
X-Api-Key
```

Dashboard access requires operator login:

```text
OPERATOR_USERNAME
OPERATOR_PASSWORD
```

Reset requires:

```text
X-Admin-Key
```

## Frontend Screens

- Dashboard with separate GW1/GW2 status boxes
- Dashboard gateway selector to view all gateways or one selected gateway
- Online gateway boxes show green, offline boxes show red
- Calibration split into GW1 and GW2 panels
- Calibration save is blocked until "Destination reached" is selected
- Alert screen uses Leaflet + OpenStreetMap with separate maps for GW1 and GW2
- Archive upload history with parsed RMS/peak/fault counts
- Protected reset session screen
- Admin targeted cleanup by time range and/or location


## Archive Parsing

`PUT /api/v1/archive` now opens the uploaded ZIP and parses:

- `session_metadata.json` for session identity/status
- `rms/rms_25cm.bin` into `rms_records` for the route map
- `peak/peak_50m.bin` into `peak_records`; generated peak alerts are inserted into `alert_events`
- `faults/faults.bin` into `fault_records`

The route maps call `GET /api/v1/map/rms?train_id=019456` and draw colored OpenStreetMap route points from parsed RMS records.

## Spatial Validation, Compensation, and Retention

- RMS records are validated against a fixed 250 mm interval with a +/- 25 mm tolerance. Each record stores `spatialIntervalMm` and `spatialIntervalValid`; the archive stores a validation summary and warning count.
- The latest saved calibration is applied during archive ingestion. The backend uses `(leftWheelFactor + rightWheelFactor) / 2` to compensate distance and speed, while preserving `rawPositionMm` and `rawSpeedKmph`.
- `rms_records`, `peak_records`, `alert_events`, `fault_records`, and archive metadata have MongoDB TTL indexes for 30-day retention.
- Raw `raw/*.bin` time-domain files are stored in `time_domain_files` and `time_domain_chunks` with a 7-day expiry. Files are split into 8 MB chunks to stay below MongoDB document limits.
## Render Deployment

Use `render.yaml`, then add these environment variables in Render:

```text
MONGODB_URL
DATABASE_NAME
GATEWAY_API_KEY_GW01
GATEWAY_API_KEY_GW02
JWT_SECRET
ADMIN_RESET_KEY
OPERATOR_USERNAME
OPERATOR_PASSWORD
```

Do not commit `.env`.
